import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createDatabase, createPostgresQueryRuntime } from "./test-utils/runtime.js";
import type { Database, CreateAcceptedTriggerRunInput, LinearCommentBridgeClaim } from "./types.js";

describe("PostgreSQL Linear comment/native dispatch recovery", () => {
  let postgres: StartedPostgreSqlContainer;
  let database: Database;
  let projectId: string;
  let revisionId: string;
  const organizationId = "linear-bridge-org";

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    database = await createDatabase(postgres.getConnectionUri());
    const query = await createPostgresQueryRuntime(postgres.getConnectionUri());
    projectId = randomUUID();
    await query.query("insert into organization (id,name,slug) values ($1,$1,$1)", [
      organizationId,
    ]);
    await query.query(
      "insert into projects (id,organization_id,name,slug) values ($1,$2,'Linear project','linear-project')",
      [projectId, organizationId],
    );
    await query.close();
    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "linear-bridge-config",
    });
    revisionId = revision.id;
    await database.activateProjectConfigurationRevision(projectId, revisionId);
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await postgres?.stop();
  }, 120_000);

  async function input(
    turnKey: string,
    triggerName = "delegated",
  ): Promise<CreateAcceptedTriggerRunInput> {
    const receipt = await database.persistManualEvent({
      organizationId,
      projectId,
      source: "manual.run",
      deliveryId: randomUUID(),
      receivedAt: new Date(),
      payload: {},
    });
    if (receipt.status !== "accepted") throw new Error("receipt must be durable");
    return {
      organizationId,
      projectId,
      configurationRevisionId: revisionId,
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      configuredTriggerName: triggerName,
      prompt: "Latest CEO feedback",
      inputs: {},
      triggerContext: {},
      outputContext: { provider: "linear", agentSessionId: "session-native", turnKey },
      stepIds: ["work"],
      deadlineAt: new Date("2099-01-01"),
    };
  }

  it.each(["comment-first", "native-first", "parallel"])(
    "serializes %s delivery into one durable run and one wakeup",
    async (order) => {
      const key = randomUUID();
      const comment = await input(key);
      const native = await input(key, "native-session");
      const ordered = order === "native-first" ? [native, comment] : [comment, native];
      const results =
        order === "parallel"
          ? await Promise.all(ordered.map((value) => database.createAcceptedTriggerRun(value)))
          : [
              await database.createAcceptedTriggerRun(ordered[0]!),
              await database.createAcceptedTriggerRun(ordered[1]!),
            ];
      assert.equal(results.filter((result) => result.created).length, 1);
      assert.equal(results[0]?.run.id, results[1]?.run.id);
      const query = await createPostgresQueryRuntime(postgres.getConnectionUri());
      const count = await query.query<{ count: string }>(
        "select count(*)::text as count from workflow_wakeups where trigger_run_id=$1",
        [results[0]!.run.id],
      );
      assert.equal(count.rows[0]?.count, "1");
      await query.close();
    },
  );

  it("preserves the original nested input through parallel reservations, expired leases and database reconnection", async () => {
    const accepted = await input(randomUUID());
    const now = new Date();
    const claim: LinearCommentBridgeClaim = {
      organizationId,
      projectId,
      connectionId: "linear-connection",
      linearOrganizationId: "linear-org",
      rootCommentId: "old-root",
      appUserId: "p-agent",
      providerEventReceiptId: accepted.providerEventReceiptId,
      sourceCommentId: "latest-child",
      sourceActorId: "ceo",
      sourceBody: accepted.prompt,
      leaseId: randomUUID(),
      now,
      leaseExpiresAt: new Date(now.getTime() + 30_000),
    };
    const results = await Promise.all([
      database.claimLinearCommentBridge(claim),
      database.claimLinearCommentBridge({
        ...claim,
        leaseId: randomUUID(),
        sourceBody: "wrong old root context",
      }),
    ]);
    assert.equal(results.filter((result) => result.claimed).length, 1);
    const winner = results.find((result) => result.claimed)!.bridge;
    assert.equal(await database.startLinearCommentBridgeCreation(claim, winner.leaseId, now), true);
    const recovered = await database.claimLinearCommentBridge({
      ...claim,
      leaseId: randomUUID(),
      now: new Date(now.getTime() + 31_000),
    });
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.bridge.sourceBody, winner.sourceBody);
    assert.equal(recovered.bridge.sourceCommentId, "latest-child");
    assert.deepEqual(recovered.bridge.creationStartedAt, now);
    assert.equal(
      await database.startLinearCommentBridgeCreation(claim, recovered.bridge.leaseId, now),
      false,
    );
    await database.bindLinearCommentBridge(claim, "native-created-before-ack-lost");
    const restarted = await createDatabase(postgres.getConnectionUri());
    try {
      assert.equal(
        (await restarted.findLinearCommentBridge(claim))?.sessionId,
        "native-created-before-ack-lost",
      );
      assert.equal(
        (
          await restarted.claimLinearCommentBridge({
            ...claim,
            leaseId: randomUUID(),
            now: new Date(now.getTime() + 60_000),
          })
        ).claimed,
        false,
      );
      assert.equal(
        (await restarted.bindLinearCommentBridge(claim, "late-other-session")).sessionId,
        "native-created-before-ack-lost",
      );
    } finally {
      await restarted.close();
    }
  });
});
