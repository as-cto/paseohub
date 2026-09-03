import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import {
  deriveAgentExecutionCompletionToken,
  hashAgentExecutionCompletionToken,
} from "../agent-executions/completion-token.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { createDaemonDispatchLifecycle } from "./lifecycle.js";

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

async function liveExecution(keepAlive: boolean) {
  const database = createMemoryDatabase({ organizationIds: ["org-1"] });
  const executionId = randomUUID();
  const token = deriveAgentExecutionCompletionToken("completion-secret", executionId);
  const intent = conversationIntent(keepAlive);
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
    launchIntent: intent,
  });
  const lifecycle = createDaemonDispatchLifecycle({
    database,
    connectionForDaemon: () => undefined,
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

  it("gives each turn its own reply allowance", async () => {
    const { database, executionId, token, lifecycle } = await liveExecution(true);
    for (let turn = 0; turn < 4; turn++) {
      await emitReply(database, executionId);
      await lifecycle.completeAgentExecutionFromCallback({ executionId, token });
      const execution = await database.findAgentExecutionById(executionId);
      // Without the per-turn reset, `max: 3` would be spent over the conversation and the fourth
      // message of a session would find the agent unable to answer.
      assert.deepEqual(execution?.outputEmissions, {});
    }
  });

  it("still completes an execution that does not carry a conversation", async () => {
    const { database, executionId, token, lifecycle } = await liveExecution(false);
    await emitReply(database, executionId);

    const completed = await lifecycle.completeAgentExecutionFromCallback({ executionId, token });

    assert.equal(completed.status, "succeeded");
    assert.deepEqual(await database.findPendingAgentExecutions(), []);
  });
});
