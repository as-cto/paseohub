import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { linearIssueExecutionKey } from "./linear-issue-serialization.js";
import type { Database, WorkflowStepExecutionInput } from "./types.js";

const now = new Date("2026-09-09T12:00:00Z");
function context(issue = "issue-1", connection = "connection-1") {
  return {
    provider: "linear",
    event: {
      linear: {
        connection_id: connection,
        organization: { id: "linear-org" },
        issue: { id: issue },
      },
    },
  };
}

async function pending(
  database: Database,
  triggerContext = context(),
): Promise<WorkflowStepExecutionInput> {
  const run = (
    await database.createAcceptedTriggerRun({
      organizationId: "org-1",
      projectId: "project-1",
      configurationRevisionId: "revision-1",
      providerEventReceiptId: randomUUID(),
      configuredTriggerName: "linear-session",
      prompt: "Apply feedback",
      inputs: {},
      triggerContext,
      outputContext: {},
      deadlineAt: new Date(now.getTime() + 60_000),
      stepIds: ["work"],
      createdAt: now,
    })
  ).run;
  return {
    triggerRunId: run.id,
    stepId: "work",
    ordinal: 0,
    executionId: randomUUID(),
    execution: {
      organizationId: "org-1",
      projectId: "project-1",
      machineId: null,
      triggerContext,
      outputContext: {},
      configurationRevisionId: "revision-1",
      startedAt: now,
      deadlineAt: run.deadlineAt,
      idleDeadlineAt: new Date(now.getTime() + 30_000),
    },
  };
}

describe("Linear issue execution ownership", () => {
  it("keeps connection and project identities separate while ignoring session/thread changes", () => {
    assert.equal(
      linearIssueExecutionKey("project-1", context()),
      linearIssueExecutionKey("project-1", context()),
    );
    assert.notEqual(
      linearIssueExecutionKey("project-1", context()),
      linearIssueExecutionKey("project-2", context()),
    );
    assert.notEqual(
      linearIssueExecutionKey("project-1", context()),
      linearIssueExecutionKey("project-1", context("issue-1", "another")),
    );
    assert.equal(linearIssueExecutionKey("project-1", { provider: "slack" }), undefined);
  });

  it("atomically queues concurrent sessions on the same issue until the prior daemon stops", async () => {
    const database = createMemoryDatabase();
    const first = await pending(database);
    const second = await pending(database);
    const results = await Promise.all([
      database.createWorkflowStepExecution(first),
      database.createWorkflowStepExecution(second),
    ]);
    assert.equal(results.filter((result) => result.created).length, 1);
    const active = results.find((result) => result.created)!.execution!;
    const waiting = results[0].created ? second : first;
    assert.ok(results.find((result) => result.deferredUntil)?.deferredUntil);
    assert.equal((await database.findPendingAgentExecutions()).length, 1);
    await database.transitionAgentExecution(active.id, "succeeded", { hubAction: "interrupt" });
    assert.ok(
      (await database.createWorkflowStepExecution(waiting)).deferredUntil,
      "database finality does not prove the daemon stopped",
    );
    await database.completeHubAction(active.id, "interrupt");
    assert.equal((await database.createWorkflowStepExecution(waiting)).created, true);
  });

  it("runs unrelated issues concurrently", async () => {
    const database = createMemoryDatabase();
    const first = await pending(database);
    const second = await pending(database, context("issue-2"));
    const results = await Promise.all([
      database.createWorkflowStepExecution(first),
      database.createWorkflowStepExecution(second),
    ]);
    assert.equal(
      results.every((result) => result.created),
      true,
    );
  });
});
