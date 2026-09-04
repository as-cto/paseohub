import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { HubExecutionAgentStreamEventSchema } from "../../hub/protocol.js";
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

  it("assembles a message streamed as deltas", () => {
    // Claude Code sends "I", then "'ll read the docs." — mirroring the last delta alone published
    // a thought missing its first word, seen in production on POS-33.
    const state = createLinearMirrorState();
    planLinearMirrorActivities(message("m1", "I"), state);
    planLinearMirrorActivities(message("m1", "'ll read the docs first."), state);
    assert.deepEqual(flushLinearMirror(state), [
      { type: "thought", body: "I'll read the docs first." },
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
    assert.deepEqual(planLinearMirrorActivities(shellCall("c1", "running"), state), []);
    assert.deepEqual(planLinearMirrorActivities(shellCall("c1", "completed"), state), [
      { type: "action", action: "Ran a command", parameter: "bun run test" },
    ]);
    // A re-emitted completion must not post the same action twice.
    assert.deepEqual(planLinearMirrorActivities(shellCall("c1", "completed"), state), []);
  });

  it("reports a failed tool call as a failed action", () => {
    const state = createLinearMirrorState();
    const [activity] = planLinearMirrorActivities(
      timeline({
        type: "tool_call",
        callId: "c2",
        name: "Bash",
        status: "failed",
        error: "exit status 1",
        detail: { type: "shell", command: "bun run build" },
      }),
      state,
    );
    assert.deepEqual(activity, {
      type: "action",
      action: "Ran a command",
      parameter: "bun run build",
      result: "failed: exit status 1",
    });
  });

  it("publishes nothing for the hub's own tools, which would reopen a closed turn", () => {
    // Linear ends the turn on the `response`; anything published after it starts a new "Working"
    // block that never closes, so the session looks busy while the agent only waits. Seen on
    // SEN-98. The reply body would also be printed twice — the second time badly.
    const state = createLinearMirrorState();
    for (const name of ["mcp__hub__reply", "mcp__hub__finish_execution"]) {
      const planned = planLinearMirrorActivities(
        timeline({
          type: "tool_call",
          callId: `c3-${name}`,
          name,
          status: "completed",
          error: null,
          detail: { type: "unknown", text: "Voici toute ma réponse, en entier, deux fois." },
        }),
        state,
      );
      assert.deepEqual(planned, [], `${name} must publish nothing`);
    }
    assert.equal(state.turnClosed, true, "finish_execution still closes the turn");
  });

  it("summarises a file read without publishing the file", () => {
    const state = createLinearMirrorState();
    const [activity] = planLinearMirrorActivities(
      timeline({
        type: "tool_call",
        callId: "c4",
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "convex/auth.ts", text: "SECRET CONTENT" },
      }),
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
      posted.push(...planLinearMirrorActivities(shellCall(`call-${index}`, "completed"), state));
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

  it("stays quiet once the agent has finished its turn", () => {
    const state = createLinearMirrorState();
    planLinearMirrorActivities(
      timeline({
        type: "tool_call",
        callId: "finish-1",
        name: "mcp__hub__finish_execution",
        status: "completed",
        error: null,
        detail: { type: "unknown" },
      }),
      state,
    );
    // Agents narrate what they just did after finishing; the panel already shows the answer.
    assert.deepEqual(
      planLinearMirrorActivities(message("m5", "Réponse postée dans le fil."), state),
      [],
    );
    assert.deepEqual(flushLinearMirror(state), []);
  });

  it("ignores events that carry nothing to show", () => {
    const state = createLinearMirrorState();
    assert.deepEqual(planLinearMirrorActivities(turn("turn_started"), state), []);
    assert.deepEqual(
      planLinearMirrorActivities(
        HubExecutionAgentStreamEventSchema.parse({
          type: "thread_started",
          sessionId: "session-1",
          provider: "claude",
        }),
        state,
      ),
      [],
    );
    assert.deepEqual(planLinearMirrorActivities(message("m0", " "), state), []);
    assert.deepEqual(flushLinearMirror(state), []);
  });
});

/**
 * Builds a stream event the way the daemon sends it: through the very schema Hub validates with,
 * so a test can never assert on a shape the transport would have rejected.
 */
function timeline(item: Record<string, unknown>) {
  return HubExecutionAgentStreamEventSchema.parse({ type: "timeline", provider: "claude", item });
}

function message(messageId: string, text: string) {
  return timeline({ type: "assistant_message", messageId, text });
}

function shellCall(callId: string, status: string) {
  return timeline({
    type: "tool_call",
    callId,
    name: "Bash",
    status,
    error: null,
    detail: { type: "shell", command: "bun run test" },
  });
}

function turn(type: "turn_started" | "turn_completed") {
  return HubExecutionAgentStreamEventSchema.parse({ type, provider: "claude" });
}
