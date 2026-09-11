import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { linearDispatchKey } from "./linear-dispatch.js";
import { linearCommentBridgeKey } from "./linear-comment-bridges.js";
import type { CreateAcceptedTriggerRunInput, LinearCommentBridgeClaim } from "./types.js";

const now = new Date("2026-09-09T12:00:00Z");
function run(
  overrides: Partial<CreateAcceptedTriggerRunInput> = {},
): CreateAcceptedTriggerRunInput {
  return {
    organizationId: "hub-org",
    projectId: "project",
    configurationRevisionId: "revision",
    providerEventReceiptId: randomUUID(),
    configuredTriggerName: "delegated",
    prompt: "Latest human feedback",
    inputs: {},
    triggerContext: {},
    outputContext: { provider: "linear", agentSessionId: "native-session", turnKey: "input-key" },
    deadlineAt: new Date("2099-01-01"),
    stepIds: ["work"],
    ...overrides,
  };
}
function claim(overrides: Partial<LinearCommentBridgeClaim> = {}): LinearCommentBridgeClaim {
  return {
    organizationId: "hub-org",
    projectId: "project",
    connectionId: "connection",
    linearOrganizationId: "linear-org",
    rootCommentId: "root",
    appUserId: "p-agent",
    providerEventReceiptId: randomUUID(),
    sourceCommentId: "latest-child",
    sourceActorId: "ceo",
    sourceBody: "Latest human feedback",
    leaseId: randomUUID(),
    now,
    leaseExpiresAt: new Date(now.getTime() + 30_000),
    ...overrides,
  };
}

describe("Linear native input persistence", () => {
  it("only treats a nonempty native Linear session output as a deduplication key", () => {
    assert.equal(linearDispatchKey(run().outputContext), "input-key");
    for (const context of [
      null,
      {},
      { provider: "slack", agentSessionId: "session", turnKey: "key" },
      { provider: "linear", agentSessionId: "", turnKey: "key" },
      { provider: "linear", agentSessionId: null, turnKey: "key" },
    ]) {
      assert.equal(linearDispatchKey(context), undefined);
    }
  });

  it.each(["comment-first", "native-first", "parallel"])(
    "creates one run and wakeup for %s delivery",
    async (order) => {
      const database = createMemoryDatabase();
      const comment = run();
      const native = run({ configuredTriggerName: "session" });
      const ordered = order === "native-first" ? [native, comment] : [comment, native];
      const results =
        order === "parallel"
          ? await Promise.all(ordered.map((input) => database.createAcceptedTriggerRun(input)))
          : [
              await database.createAcceptedTriggerRun(ordered[0]!),
              await database.createAcceptedTriggerRun(ordered[1]!),
            ];
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(results[0]?.run.id, results[1]?.run.id);
    },
  );

  it("isolates project dispatches and allows an explicit Retry on a new native session", async () => {
    const database = createMemoryDatabase();
    assert.equal((await database.createAcceptedTriggerRun(run())).created, true);
    assert.equal(
      (await database.createAcceptedTriggerRun(run({ projectId: "other-project" }))).created,
      true,
    );
    assert.equal(
      (
        await database.createAcceptedTriggerRun(
          run({
            outputContext: {
              provider: "linear",
              agentSessionId: "retry-session",
              turnKey: "retry-input-key",
            },
          }),
        )
      ).created,
      true,
    );
    assert.equal(
      (
        await database.createAcceptedTriggerRun(
          run({
            outputContext: {
              provider: "slack",
              agentSessionId: "native-session",
              turnKey: "input-key",
            },
          }),
        )
      ).created,
      true,
    );
  });

  it("serializes competing root reservations and preserves the original human input on lease takeover", async () => {
    const database = createMemoryDatabase();
    const first = claim();
    const other = claim({
      sourceCommentId: "older-root",
      sourceActorId: "p-agent",
      sourceBody: "App context",
    });
    const reservations = await Promise.all([
      database.claimLinearCommentBridge(first),
      database.claimLinearCommentBridge(other),
    ]);
    assert.equal(reservations.filter((reservation) => reservation.claimed).length, 1);
    const recovered = await database.claimLinearCommentBridge(
      claim({ now: new Date(now.getTime() + 31_000), sourceBody: "replacement" }),
    );
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.bridge.sourceBody, first.sourceBody);
    assert.equal(recovered.bridge.providerEventReceiptId, first.providerEventReceiptId);
    assert.equal(recovered.bridge.sourceActorId, "ceo");
  });

  it("keeps the bound session stable after restart/replay and separates connection, project and organization keys", async () => {
    const database = createMemoryDatabase();
    const first = claim();
    await database.claimLinearCommentBridge(first);
    await database.bindLinearCommentBridge(first, "session-original");
    assert.equal(
      (await database.bindLinearCommentBridge(first, "late-other-session")).sessionId,
      "session-original",
    );
    assert.equal((await database.claimLinearCommentBridge(claim())).claimed, false);
    for (const alternate of [
      claim({ projectId: "other-project" }),
      claim({ connectionId: "other-connection" }),
      claim({ linearOrganizationId: "other-linear-org" }),
      claim({ organizationId: "other-hub-org" }),
    ]) {
      assert.notEqual(linearCommentBridgeKey(first), linearCommentBridgeKey(alternate));
      assert.equal((await database.claimLinearCommentBridge(alternate)).claimed, true);
    }
  });

  it("claims an external creation attempt only once even after lease takeover", async () => {
    const database = createMemoryDatabase();
    const first = claim();
    await database.claimLinearCommentBridge(first);
    assert.equal(
      await database.startLinearCommentBridgeCreation(first, "not-the-lease", now),
      false,
    );
    assert.equal(await database.startLinearCommentBridgeCreation(first, first.leaseId, now), true);
    const replay = claim({
      now: new Date(now.getTime() + 31_000),
      leaseExpiresAt: new Date(now.getTime() + 61_000),
    });
    const recovered = await database.claimLinearCommentBridge(replay);
    assert.equal(recovered.claimed, true);
    assert.deepEqual(recovered.bridge.creationStartedAt, now);
    assert.equal(
      await database.startLinearCommentBridgeCreation(replay, replay.leaseId, replay.now),
      false,
    );
  });
});
