import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { completesAtIdleDeadline } from "../db/idle-completion.js";
import { createDaemonDispatchLifecycle, DaemonPromptDeliveryUncertainError } from "./lifecycle.js";
import {
  currentTurnOutputEmissions,
  missingRequiredOutputs,
} from "../execution-capabilities/required-outputs.js";
import type { DaemonConnection } from "./protocol.js";

function conversationIntent(keepAlive: boolean): LaunchMachineIntent {
  return {
    kind: "launch_machine",
    organizationId: "org-1",
    projectId: "project-1",
    triggerRunId: "trigger-run-1",
    triggerName: "linear-agent-session",
    environmentName: "runner",
    environment: {
      kind: "daemon",
      daemonId: "daemon-1",
      authoredSlug: "runner",
      cwd: "/workspace",
    },
    prompt: "explain the routing",
    agent: { provider: "claude", mode: "default" },
    allowOutputs: [{ type: "linear.reply", max: 3, required: true }],
    autoArchive: true,
    ...(keepAlive ? { keepAliveBetweenTurns: true } : {}),
    triggerContext: { provider: "linear" },
    outputContext: { provider: "linear", agentSessionId: "session-1" },
    configurationRevisionId: "revision-1",
    hubConfig: { environments: [], triggers: [] },
  };
}

async function liveExecution(
  keepAlive: boolean,
  promptExecution?: DaemonConnection["promptExecution"],
  initialTurnKey?: string,
) {
  const database = createMemoryDatabase({ organizationIds: ["org-1"] });
  const executionId = randomUUID();
  const token = deriveAgentExecutionCompletionToken("completion-secret", executionId);
  const intent = conversationIntent(keepAlive);
  if (initialTurnKey !== undefined)
    intent.outputContext = {
      provider: "linear",
      agentSessionId: "session-1",
      turnKey: initialTurnKey,
    };
  await database.insertAgentExecution({
    id: executionId,
    organizationId: "org-1",
    projectId: "project-1",
    machineId: null,
    triggerContext: intent.triggerContext,
    outputContext: intent.outputContext,
    configurationRevisionId: "revision-1",
    completionTokenHash: hashAgentExecutionCompletionToken(token),
    workflowStepRunId: null,
    daemonId: "daemon-1",
    launchIntent: intent,
  });
  const lifecycle = createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: () =>
      promptExecution === undefined
        ? undefined
        : {
            promptExecution,
            createAgent: async () => {
              throw new Error("unexpected create");
            },
            controlExecution: async () => undefined,
            on: () => () => undefined,
          },
    completionTokenSecret: "completion-secret",
  });
  return { database, executionId, token, lifecycle };
}

/** Emits one required reply, the way the reply output does before `finish_execution`. */
async function emitReply(
  database: Awaited<ReturnType<typeof liveExecution>>["database"],
  executionId: string,
): Promise<void> {
  const attempt = await database.beginAgentExecutionOutput(
    executionId,
    "linear.reply",
    3,
    new Date(),
  );
  assert.ok(attempt, "the reply allowance should not be exhausted");
  await database.completeAgentExecutionOutput(executionId, attempt.id, new Date());
}

describe("conversational executions", () => {
  it("does not steer the same input that already started an execution through fallback", async () => {
    const delivered: string[] = [];
    const initialTurnKey = JSON.stringify([
      "connection",
      "linear-org",
      "session-1",
      "activity",
      "first-input",
    ]);
    const fixture = await liveExecution(
      true,
      async (input) => {
        delivered.push(input.prompt);
        return { delivered: true, disposition: null };
      },
      initialTurnKey,
    );
    const prompt = () =>
      fixture.lifecycle.promptAgentExecutions({
        projectId: "project-1",
        inputId: initialTurnKey,
        prompt: "Initial fallback prompt",
        matches: () => true,
      });
    assert.equal((await prompt()).delivered, true);
    assert.deepEqual(delivered, []);
    // Reproduce an initial execution becoming visible only after the historical lookup.
    const lookup = fixture.database.findAgentExecutionInputDelivery.bind(fixture.database);
    fixture.database.findAgentExecutionInputDelivery = async () => undefined;
    assert.equal((await prompt()).delivered, true);
    assert.deepEqual(delivered, []);
    fixture.database.findAgentExecutionInputDelivery = lookup;
    await fixture.database.transitionAgentExecution(fixture.executionId, "succeeded");
    assert.equal((await prompt()).delivered, true);
    assert.deepEqual(delivered, []);
  });
  it("ends the turn without ending the execution, so the agent stays reachable", async () => {
    const { database, executionId, token, lifecycle } = await liveExecution(true);
    await emitReply(database, executionId);

    const afterTurn = await lifecycle.completeAgentExecutionFromCallback({ executionId, token });

    // Still live — `spawning` here only because the test never streamed a first event; what
    // matters is that it is not terminal.
    assert.ok(["spawning", "running"].includes(afterTurn.status), afterTurn.status);
    // The agent is still the one this session talks to: `promptExecution` finds pending
    // executions, and a completed one would not be there.
    const pending = await database.findPendingAgentExecutions();
    assert.deepEqual(
      pending.map((execution) => execution.id),
      [executionId],
    );
  });

  it("gives each input its own reply allowance while retaining lifetime delivery evidence", async () => {
    const { database, executionId, token, lifecycle } = await liveExecution(true);
    for (let turn = 0; turn < 4; turn++) {
      if (turn > 0) await database.beginAgentExecutionTurn(executionId, new Date());
      await emitReply(database, executionId);
      await lifecycle.completeAgentExecutionFromCallback({ executionId, token });
      const execution = await database.findAgentExecutionById(executionId);
      assert.ok(execution);
      assert.deepEqual(execution.outputEmissions, { "linear.reply": turn + 1 });
      assert.deepEqual(currentTurnOutputEmissions(execution), { "linear.reply": 1 });
      assert.equal(Object.keys(execution.outputDeliveryAttempts).length, turn + 1);
    }
  });

  it("ends a finished conversation as a success, not an idle timeout", async () => {
    const { database, executionId, token, lifecycle } = await liveExecution(true);
    await emitReply(database, executionId);
    await lifecycle.completeAgentExecutionFromCallback({ executionId, token });

    const execution = await database.findAgentExecutionById(executionId);
    assert.ok(execution);
    assert.equal(completesAtIdleDeadline(execution), true);
  });

  it("cannot silently complete a second input using the first answer's finish", async () => {
    const fixture = await liveExecution(true, async () => {
      const accepted = await fixture.database.findAgentExecutionById(fixture.executionId);
      assert.ok(accepted);
      assert.equal(
        completesAtIdleDeadline(accepted),
        false,
        "invalidate completion before delivery",
      );
      return { delivered: true, disposition: null };
    });
    const { database, executionId, token, lifecycle } = fixture;
    await emitReply(database, executionId);
    await lifecycle.completeAgentExecutionFromCallback({ executionId, token });
    assert.equal(
      (
        await lifecycle.promptAgentExecutions({
          projectId: "project-1",
          prompt: "Please verify the previous answer",
          matches: () => true,
        })
      ).delivered,
      true,
    );
    const awaitingReply = await database.findAgentExecutionById(executionId);
    assert.ok(awaitingReply);
    assert.deepEqual(awaitingReply.outputEmissions, { "linear.reply": 1 });
    assert.equal(missingRequiredOutputs(awaitingReply).length, 1);
    assert.equal(completesAtIdleDeadline(awaitingReply), false);
    await assert.rejects(
      lifecycle.completeAgentExecutionFromCallback({ executionId, token }),
      /required_outputs_missing/,
    );
    await emitReply(database, executionId);
    await lifecycle.completeAgentExecutionFromCallback({ executionId, token });
    assert.equal(
      completesAtIdleDeadline((await database.findAgentExecutionById(executionId))!),
      true,
    );
  });

  it("a previous turn's in-flight reply and delayed finish cannot satisfy a newer input", async () => {
    const { database, executionId } = await liveExecution(true);
    const old = await database.beginAgentExecutionOutput(
      executionId,
      "linear.reply",
      3,
      new Date(),
    );
    assert.ok(old);
    await database.beginAgentExecutionTurn(executionId, new Date());
    const afterLateReply = await database.completeAgentExecutionOutput(
      executionId,
      old.id,
      new Date(),
    );
    assert.ok(afterLateReply);
    assert.deepEqual(afterLateReply.outputEmissions, { "linear.reply": 1 });
    assert.equal(missingRequiredOutputs(afterLateReply).length, 1);
    const lateFinish = await database.recordAgentExecutionHubAcknowledgement(executionId, {
      kind: "finish_execution",
      status: "completed",
      observedAt: new Date(),
      expectedTurnId: null,
    });
    assert.equal(lateFinish, undefined);
    assert.equal(
      completesAtIdleDeadline((await database.findAgentExecutionById(executionId))!),
      false,
    );
  });

  it("serializes simultaneous prompt handoffs with their durable input boundaries", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const delivered: string[] = [];
    const turns: string[] = [];
    const fixture = await liveExecution(true, async (input) => {
      delivered.push(input.prompt);
      turns.push(
        (await fixture.database.findAgentExecutionById(fixture.executionId))!
          .hubActionAcknowledgements.turn!.id,
      );
      if (input.prompt === "first") {
        notifyStarted();
        await held;
      }
      return { delivered: true, disposition: null };
    });
    const prompt = (text: string) =>
      fixture.lifecycle.promptAgentExecutions({
        projectId: "project-1",
        prompt: text,
        matches: () => true,
      });
    const first = prompt("first");
    await started;
    const second = prompt("second");
    await Promise.resolve();
    assert.deepEqual(delivered, ["first"]);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(delivered, ["first", "second"]);
    assert.notEqual(turns[0], turns[1]);
  });

  it("still completes an execution that does not carry a conversation", async () => {
    const { database, executionId, token, lifecycle } = await liveExecution(false);
    await emitReply(database, executionId);

    const completed = await lifecycle.completeAgentExecutionFromCallback({ executionId, token });

    assert.equal(completed.status, "succeeded");
    assert.deepEqual(await database.findPendingAgentExecutions(), []);
  });

  it("deduplicates an input across concurrent deliveries and a completed execution", async () => {
    const delivered: string[] = [];
    const fixture = await liveExecution(true, async (input) => {
      delivered.push(input.prompt);
      return { delivered: true, disposition: null };
    });
    const prompt = (inputId: string) =>
      fixture.lifecycle.promptAgentExecutions({
        projectId: "project-1",
        prompt: inputId,
        inputId,
        matches: () => true,
      });
    const first = await Promise.all([prompt("activity-1"), prompt("activity-1")]);
    assert.ok(first.every((result) => result.delivered));
    assert.deepEqual(delivered, ["activity-1"]);
    const current = await fixture.database.findAgentExecutionById(fixture.executionId);
    await emitReply(fixture.database, fixture.executionId);
    await fixture.lifecycle.completeAgentExecutionFromCallback({
      executionId: fixture.executionId,
      token: fixture.token,
    });
    assert.equal((await prompt("activity-1")).delivered, true);
    const afterDuplicate = await fixture.database.findAgentExecutionById(fixture.executionId);
    assert.equal(
      afterDuplicate?.hubActionAcknowledgements.turn?.id,
      current?.hubActionAcknowledgements.turn?.id,
    );
    assert.equal(completesAtIdleDeadline(afterDuplicate!), true);
    await prompt("activity-2");
    assert.deepEqual(delivered, ["activity-1", "activity-2"]);
    assert.notEqual(
      (await fixture.database.findAgentExecutionById(fixture.executionId))
        ?.hubActionAcknowledgements.turn?.id,
      current?.hubActionAcknowledgements.turn?.id,
    );
    await fixture.database.transitionAgentExecution(fixture.executionId, "succeeded");
    assert.equal((await prompt("activity-1")).delivered, true);
    assert.deepEqual(delivered, ["activity-1", "activity-2"]);
  });

  it("retains an uncertain input after a lost acknowledgement instead of falling back or resending", async () => {
    let attempts = 0;
    const fixture = await liveExecution(true, async () => {
      attempts++;
      throw new Error("connection lost after daemon accepted input");
    });
    const prompt = () =>
      fixture.lifecycle.promptAgentExecutions({
        projectId: "project-1",
        prompt: "Check the comfort calculation",
        inputId: "activity-lost-ack",
        matches: () => true,
      });
    await assert.rejects(prompt(), DaemonPromptDeliveryUncertainError);
    await assert.rejects(prompt(), DaemonPromptDeliveryUncertainError);
    await fixture.database.transitionAgentExecution(fixture.executionId, "failed");
    await assert.rejects(prompt(), DaemonPromptDeliveryUncertainError);
    assert.equal(attempts, 1);
    const key = createHash("sha256").update("activity-lost-ack").digest("hex");
    assert.deepEqual(await fixture.database.findAgentExecutionInputDelivery("project-1", key), {
      executionId: fixture.executionId,
      status: "pending",
    });
    assert.equal(
      await fixture.database.findAgentExecutionInputDelivery("unrelated-project", key),
      undefined,
    );
  });

  it("hands the stored agent UUID and stable event digest to the daemon", async () => {
    const delivered: Parameters<DaemonConnection["promptExecution"]>[0][] = [];
    const fixture = await liveExecution(true, async (input) => {
      delivered.push(input);
      return { delivered: true, disposition: null };
    });
    const agentId = randomUUID();
    await fixture.database.attachAgentToExecution(fixture.executionId, "daemon-1", agentId);
    const inputId = JSON.stringify([
      "connection",
      "linear-org",
      "session-1",
      "comment",
      "comment-1",
    ]);
    await fixture.lifecycle.promptAgentExecutions({
      projectId: "project-1",
      prompt: "The full comment",
      inputId,
      activeTurnBehavior: "steer",
      matches: () => true,
    });
    assert.deepEqual(delivered, [
      {
        executionId: fixture.executionId,
        agentId,
        messageId: createHash("sha256").update(inputId).digest("hex"),
        prompt: "The full comment",
        activeTurnBehavior: "steer",
      },
    ]);
  });

  it("atomically changes the Linear destination while retaining the original dispatch key", async () => {
    const received: unknown[] = [];
    const fixture = await liveExecution(
      true,
      async () => {
        received.push(
          (await fixture.database.findAgentExecutionById(fixture.executionId))?.outputContext,
        );
        return { delivered: true, disposition: null };
      },
      "initial-dispatch",
    );
    await emitReply(fixture.database, fixture.executionId);
    const incoming = {
      provider: "linear",
      agentSessionId: "session-2",
      issueId: "issue-1",
      turnKey: "followup",
    };
    const send = () =>
      fixture.lifecycle.promptAgentExecutions({
        projectId: "project-1",
        inputId: "followup",
        prompt: "New root comment",
        matches: () => true,
        turnContext: {
          triggerContext: { provider: "linear", target: incoming },
          outputContext: incoming,
        },
      });
    assert.equal((await send()).delivered, true);
    assert.equal((await send()).delivered, true);
    assert.deepEqual(received, [{ ...incoming, turnKey: "initial-dispatch" }]);
    const execution = (await fixture.database.findAgentExecutionById(fixture.executionId))!;
    assert.deepEqual(execution.triggerContext, { provider: "linear", target: incoming });
    assert.equal(missingRequiredOutputs(execution).length, 1);
  });

  it("does not treat a destination change as proof of a lost prompt acknowledgement", async () => {
    let sends = 0;
    const fixture = await liveExecution(
      true,
      async () => {
        sends++;
        throw new Error("lost acknowledgement");
      },
      "initial-dispatch",
    );
    const send = () =>
      fixture.lifecycle.promptAgentExecutions({
        projectId: "project-1",
        inputId: "followup",
        prompt: "New root comment",
        matches: () => true,
        turnContext: {
          triggerContext: { provider: "linear" },
          outputContext: { provider: "linear", agentSessionId: "session-2", turnKey: "followup" },
        },
      });
    await assert.rejects(send(), DaemonPromptDeliveryUncertainError);
    await assert.rejects(send(), DaemonPromptDeliveryUncertainError);
    assert.equal(sends, 1);
  });

  it("ends an opted-in Linear execution on provider failure without automatic resumption", async () => {
    const fixture = await liveExecution(true);
    await fixture.database.beginAgentExecutionTurn(fixture.executionId, new Date(), "failed-turn", {
      triggerContext: { provider: "linear" },
      outputContext: { provider: "linear", publishIssueComment: true, agentSessionId: "session-1" },
    });
    await fixture.lifecycle.handleAgentStreamEvent(
      fixture.executionId,
      {
        type: "turn_failed",
        provider: "codex",
        error: "Provider declined the request",
      },
      new Date(),
    );
    const execution = (await fixture.database.findAgentExecutionById(fixture.executionId))!;
    assert.equal(execution.status, "failed");
    assert.deepEqual(execution.result, { status: "failed", reason: "agent_turn_failed" });
    assert.deepEqual(await fixture.database.findPendingAgentExecutions(), []);
  });

  it("releases the input claim when the daemon explicitly reports no delivery", async () => {
    let attempts = 0;
    const fixture = await liveExecution(true, async () => ({
      delivered: ++attempts > 1,
      disposition: null,
    }));
    const prompt = () =>
      fixture.lifecycle.promptAgentExecutions({
        projectId: "project-1",
        prompt: "Please continue",
        inputId: "activity-not-delivered",
        matches: () => true,
      });
    assert.equal((await prompt()).delivered, false);
    assert.equal((await prompt()).delivered, true);
    assert.equal((await prompt()).delivered, true);
    assert.equal(attempts, 2);
  });
});
