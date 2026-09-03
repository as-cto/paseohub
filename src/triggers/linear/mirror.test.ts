import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { HubExecutionAgentStreamEvent } from "../../hub/protocol.js";
import {
  createLinearMirrorState,
  flushLinearMirror,
  planLinearMirrorActivities,
  redact,
  LINEAR_MIRROR_ACTIVITY_LIMIT,
} from "./mirror.js";

describe("Linear session mirror", () => {
  it("coalesces a streamed assistant message into one thought", () => {
    const state = createLinearMirrorState();
    assert.deepEqual(planLinearMirrorActivities(message("m1", "Je regarde"), state), []);
    assert.deepEqual(planLinearMirrorActivities(message("m1", "Je regarde le loader"), state), []);
    assert.deepEqual(planLinearMirrorActivities(turn("turn_completed"), state), [
      { type: "thought", body: "Je regarde le loader" },
    ]);
  });

  it("flushes the pending message when the agent starts a new one", () => {
    const state = createLinearMirrorState();
    planLinearMirrorActivities(message("m1", "D'abord ceci"), state);
    assert.deepEqual(planLinearMirrorActivities(message("m2", "Ensuite cela"), state), [
      { type: "thought", body: "D'abord ceci" },
    ]);
  });

  it("posts a tool call once, on completion, with a readable label", () => {
    const state = createLinearMirrorState();
    assert.deepEqual(planLinearMirrorActivities(toolCall("c1", "running"), state), []);
    assert.deepEqual(planLinearMirrorActivities(toolCall("c1", "completed"), state), [
      { type: "action", action: "Ran a command", parameter: "bun run test" },
    ]);
    // A re-emitted completion must not post the same action twice.
    assert.deepEqual(planLinearMirrorActivities(toolCall("c1", "completed"), state), []);
  });

  it("reports a failed tool call as a failed action", () => {
    const state = createLinearMirrorState();
    const [activity] = planLinearMirrorActivities(
      {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "c2",
          name: "Bash",
          status: "failed",
          error: "exit status 1",
          detail: { type: "shell", command: "bun run build" },
        },
      } as unknown as HubExecutionAgentStreamEvent,
      state,
    );
    assert.deepEqual(activity, {
      type: "action",
      action: "Ran a command",
      parameter: "bun run build",
      result: "failed: exit status 1",
    });
  });

  it("never mirrors the reply body, which Linear is about to render as the response", () => {
    const state = createLinearMirrorState();
    const [activity] = planLinearMirrorActivities(
      {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "c3",
          name: "mcp__hub__reply",
          status: "completed",
          error: null,
          detail: { type: "unknown", text: "Voici toute ma réponse, en entier, deux fois." },
        },
      } as unknown as HubExecutionAgentStreamEvent,
      state,
    );
    assert.deepEqual(activity, {
      type: "action",
      action: "Posted a reply",
      parameter: "to this session",
    });
  });

  it("summarises a file read without publishing the file", () => {
    const state = createLinearMirrorState();
    const [activity] = planLinearMirrorActivities(
      {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "c4",
          name: "Read",
          status: "completed",
          error: null,
          detail: { type: "read", filePath: "convex/auth.ts", text: "SECRET CONTENT" },
        },
      } as unknown as HubExecutionAgentStreamEvent,
      state,
    );
    assert.deepEqual(activity, {
      type: "action",
      action: "Read a file",
      parameter: "convex/auth.ts",
    });
  });

  it("redacts credential-shaped strings", () => {
    assert.equal(
      redact("curl -H 'Authorization: Bearer abcdefghijklmnop' https://x"),
      "curl -H 'Authorization: [redacted]' https://x",
    );
    assert.equal(redact("export BRIDGE_SECRET=hunter2hunter2"), "export [redacted]");
    assert.equal(redact("gh auth --token ghp_0123456789abcdefghij"), "gh auth --token [redacted]");
  });

  it("stops after the per-turn ceiling and says so once", () => {
    const state = createLinearMirrorState();
    const posted: unknown[] = [];
    for (let index = 0; index < LINEAR_MIRROR_ACTIVITY_LIMIT + 20; index++) {
      posted.push(...planLinearMirrorActivities(toolCall(`call-${index}`, "completed"), state));
    }
    assert.equal(posted.length, LINEAR_MIRROR_ACTIVITY_LIMIT);
    assert.deepEqual(posted.at(-1), {
      type: "thought",
      body: `Paseo is still working; this session reached ${LINEAR_MIRROR_ACTIVITY_LIMIT} live updates and will only post its reply from here.`,
    });
    // Exhausted means silent, including for a final flush.
    assert.deepEqual(planLinearMirrorActivities(message("m9", "encore"), state), []);
    assert.deepEqual(flushLinearMirror(state), []);
  });

  it("ignores events that carry nothing to show", () => {
    const state = createLinearMirrorState();
    assert.deepEqual(planLinearMirrorActivities(turn("turn_started"), state), []);
    assert.deepEqual(
      planLinearMirrorActivities(
        {
          type: "thread_started",
          sessionId: "s",
          provider: "claude",
        } as HubExecutionAgentStreamEvent,
        state,
      ),
      [],
    );
    assert.deepEqual(planLinearMirrorActivities(message("m0", " "), state), []);
    assert.deepEqual(flushLinearMirror(state), []);
  });
});

function message(messageId: string, text: string): HubExecutionAgentStreamEvent {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "assistant_message", messageId, text },
  } as unknown as HubExecutionAgentStreamEvent;
}

function toolCall(callId: string, status: string): HubExecutionAgentStreamEvent {
  return {
    type: "timeline",
    provider: "claude",
    item: {
      type: "tool_call",
      callId,
      name: "Bash",
      status,
      error: null,
      detail: { type: "shell", command: "bun run test" },
    },
  } as unknown as HubExecutionAgentStreamEvent;
}

function turn(type: "turn_started" | "turn_completed"): HubExecutionAgentStreamEvent {
  return { type, provider: "claude" } as HubExecutionAgentStreamEvent;
}
