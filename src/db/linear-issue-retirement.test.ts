import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { hasCompletedIdleConversationTurn } from "./idle-completion.js";
import { retireCompletedLinearIssueExecutions } from "./linear-issue-serialization.js";
import type { AgentExecutionRecord, Database } from "./types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";

const startedAt = new Date("2026-09-11T12:00:00Z");
const finishedAt = new Date("2026-09-11T12:00:05Z");
const idleAt = new Date("2026-09-11T12:00:06Z");
const observedAt = new Date("2026-09-11T12:00:10Z");
const idleDeadlineAt = new Date("2026-09-11T12:03:06Z");
const deadlineAt = new Date("2026-09-11T13:00:00Z");

function triggerContext(issue = "issue-1") {
  return {
    provider: "linear",
    event: {
      linear: {
        connection_id: "connection-1",
        organization: { id: "linear-org" },
        issue: { id: issue },
      },
    },
  };
}

async function createRun(database: Database, sessionId: string, issue = "issue-1") {
  return (
    await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: "project-1",
      configurationRevisionId: "revision-1",
      providerEventReceiptId: randomUUID(),
      configuredTriggerName: "linear-session",
      prompt: "Handle this feedback",
      inputs: {},
      triggerContext: triggerContext(issue),
      outputContext: { provider: "linear", agentSessionId: sessionId },
      deadlineAt,
      stepIds: ["work"],
      createdAt: startedAt,
    })
  ).run;
}

async function finishTurn(database: Database, executionId: string, at = finishedAt) {
  const attempt = await database.beginAgentExecutionOutput(executionId, "linear.reply", 3, at);
  assert.ok(attempt);
  await database.completeAgentExecutionOutput(executionId, attempt.id, at);
  await database.recordAgentExecutionHubAcknowledgement(executionId, {
    kind: "finish_execution",
    status: "completed",
    observedAt: at,
  });
  for (const kind of ["terminal", "idle"] as const)
    await database.recordAgentExecutionHubAcknowledgement(executionId, {
      kind,
      observedAt: idleAt,
    });
  await database.setAgentExecutionIdleDeadline(executionId, idleDeadlineAt, idleAt, observedAt);
}

async function fixture() {
  const database = createMemoryDatabase({ now: () => observedAt });
  const previous = await createRun(database, "session-old");
  const intent: LaunchMachineIntent = {
    kind: "launch_machine",
    organizationId: previous.organizationId,
    projectId: previous.projectId,
    triggerRunId: previous.id,
    triggerName: "linear-session",
    environmentName: "runner",
    environment: { kind: "daemon", daemonId: "daemon", authoredSlug: "runner", cwd: "/repo" },
    prompt: previous.prompt,
    agent: { provider: "claude" },
    allowOutputs: [{ type: "linear.reply", required: true }],
    autoArchive: false,
    keepAliveBetweenTurns: true,
    triggerContext: previous.triggerContext,
    outputContext: previous.outputContext,
    configurationRevisionId: "revision-1",
    hubConfig: {},
  };
  const execution = (
    await database.createWorkflowStepExecution({
      triggerRunId: previous.id,
      stepId: "work",
      ordinal: 0,
      executionId: randomUUID(),
      execution: {
        organizationId: previous.organizationId,
        projectId: previous.projectId,
        machineId: null,
        daemonId: "daemon",
        triggerContext: previous.triggerContext,
        outputContext: previous.outputContext,
        configurationRevisionId: "revision-1",
        launchIntent: intent,
        startedAt,
        deadlineAt,
        idleDeadlineAt,
      },
    })
  ).execution;
  assert.ok(execution);
  await database.transitionAgentExecution(execution.id, "running");
  await finishTurn(database, execution.id);
  const waiting = await createRun(database, "session-new");
  const createNext = () =>
    database.createWorkflowStepExecution({
      triggerRunId: waiting.id,
      stepId: "work",
      ordinal: 0,
      executionId: randomUUID(),
      execution: {
        organizationId: waiting.organizationId,
        projectId: waiting.projectId,
        machineId: null,
        daemonId: "daemon",
        triggerContext: waiting.triggerContext,
        outputContext: waiting.outputContext,
        configurationRevisionId: "revision-1",
        startedAt: observedAt,
        deadlineAt,
        idleDeadlineAt,
      },
    });
  return { database, previous, execution, waiting, createNext };
}

describe("completed Linear conversation yielding to another session", () => {
  it("retires the final idle turn immediately but retains issue ownership until the stop ACK", async () => {
    const f = await fixture();
    assert.ok((await f.createNext()).deferredUntil);
    const recoveries = await retireCompletedLinearIssueExecutions(
      f.database,
      f.waiting,
      observedAt,
    );
    assert.deepEqual(recoveries, [
      { triggerRunId: f.previous.id, executionIds: [], completedExecutionIds: [f.execution.id] },
    ]);
    const completed = await f.database.findAgentExecutionById(f.execution.id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.hubAction, "interrupt");
    assert.equal(completed?.hubActionCompletedAt, null);
    assert.equal(completed?.hubActionAcknowledgements.finishExecutionCall?.status, "completed");
    assert.ok((await f.createNext()).deferredUntil, "a requested stop is not a stop ACK");
    await f.database.completeHubAction(f.execution.id, "interrupt");
    assert.equal((await f.createNext()).created, true);
  });

  it("keeps the completed agent for the same native session and leaves other issues alone", async () => {
    const f = await fixture();
    for (const waiting of [
      { ...f.waiting, outputContext: { provider: "linear", agentSessionId: "session-old" } },
      { ...f.waiting, triggerContext: triggerContext("different-issue") },
      { ...f.waiting, projectId: "different-project" },
    ])
      assert.deepEqual(
        await retireCompletedLinearIssueExecutions(f.database, waiting, observedAt),
        [],
      );
    assert.equal((await f.database.findAgentExecutionById(f.execution.id))?.status, "running");
  });

  it("requires finish, terminal, idle and all replies to belong to the completed current turn", async () => {
    const f = await fixture();
    const execution = (await f.database.findAgentExecutionById(f.execution.id))!;
    assert.equal(hasCompletedIdleConversationTurn(execution), true);
    const acknowledgements = execution.hubActionAcknowledgements;
    const invalid: AgentExecutionRecord[] = [
      { ...execution, idleDeadlineAt: null },
      { ...execution, outputEmissions: {} },
      {
        ...execution,
        hubActionAcknowledgements: { ...acknowledgements, finishExecutionCall: null },
      },
      { ...execution, hubActionAcknowledgements: { ...acknowledgements, terminalAt: null } },
      { ...execution, hubActionAcknowledgements: { ...acknowledgements, idleAt: startedAt } },
      {
        ...execution,
        hubActionAcknowledgements: {
          ...acknowledgements,
          turn: { id: "new-turn-without-reply", startedAt: observedAt },
        },
      },
      {
        ...execution,
        hubActionAcknowledgements: {
          ...acknowledgements,
          inputDeliveries: { uncertain: "pending" },
        },
      },
    ];
    for (const value of invalid) assert.equal(hasCompletedIdleConversationTurn(value), false);
    await f.database.beginAgentExecutionOutput(f.execution.id, "linear.reply", 3, observedAt);
    assert.deepEqual(
      await retireCompletedLinearIssueExecutions(f.database, f.waiting, observedAt),
      [],
    );
  });

  it("rechecks after acquiring the prompt lock so a new unanswered turn keeps ownership", async () => {
    const f = await fixture();
    const lock = f.database.withAdvisoryLock.bind(f.database);
    vi.spyOn(f.database, "withAdvisoryLock").mockImplementationOnce(async (key, work) => {
      assert.equal(key, `execution.prompt:${f.execution.id}`);
      await f.database.beginAgentExecutionTurn(f.execution.id, observedAt, "new-human-input");
      return lock(key, work);
    });
    assert.deepEqual(
      await retireCompletedLinearIssueExecutions(f.database, f.waiting, observedAt),
      [],
    );
    assert.equal((await f.database.findAgentExecutionById(f.execution.id))?.status, "running");
  });

  it("refuses stale completion even if a newer turn finishes between the read and transaction", async () => {
    const f = await fixture();
    const complete = f.database.completeWorkflowAgentExecution.bind(f.database);
    vi.spyOn(f.database, "completeWorkflowAgentExecution").mockImplementationOnce(async (input) => {
      await f.database.beginAgentExecutionTurn(f.execution.id, startedAt);
      await finishTurn(f.database, f.execution.id);
      assert.equal(
        hasCompletedIdleConversationTurn(
          (await f.database.findAgentExecutionById(f.execution.id))!,
        ),
        true,
      );
      return complete(input);
    });
    assert.deepEqual(
      await retireCompletedLinearIssueExecutions(f.database, f.waiting, observedAt),
      [],
    );
    assert.equal((await f.database.findAgentExecutionById(f.execution.id))?.status, "running");
  });

  it("retires a single execution once when two sessions race to acquire the issue", async () => {
    const f = await fixture();
    const another = await createRun(f.database, "another-session");
    const results = await Promise.all([
      retireCompletedLinearIssueExecutions(f.database, f.waiting, observedAt),
      retireCompletedLinearIssueExecutions(f.database, another, observedAt),
    ]);
    assert.equal(results.flat().length, 1);
    assert.ok((await f.createNext()).deferredUntil);
  });
});
