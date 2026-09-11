import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { createDatabase } from "./pg.js";
import { postgresDatabaseRuntime } from "./runtime/index.js";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { LinearIssueSessionBridgeClaim } from "./linear-issue-session-bridges.js";

it("persists a creation attempt through a database restart and atomically binds its native echo", async () => {
  const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  let runtime = await postgresDatabaseRuntime(postgres.getConnectionUri());
  try {
    await runtime.runtime.migrate();
    const projectId = randomUUID();
    await runtime.runtime.query(
      "insert into organization (id,name,slug) values ('org','org','org')",
    );
    await runtime.runtime.query(
      "insert into projects (id,organization_id,name,slug) values ($1,'org','project','project')",
      [projectId],
    );
    let database = createDatabase(runtime.runtime, runtime.locks);
    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: { kind: "test" },
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "issue-session-test",
    });
    await database.activateProjectConfigurationRevision(projectId, revision.id);
    const receipt = await database.persistManualEvent({
      organizationId: "org",
      projectId,
      source: "manual.run",
      deliveryId: randomUUID(),
      receivedAt: new Date(),
      payload: {},
    });
    assert.equal(receipt.status, "accepted");
    if (receipt.status !== "accepted") throw new Error("receipt missing");
    const input: LinearIssueSessionBridgeClaim = {
      organizationId: "org",
      projectId,
      connectionId: "connection",
      linearOrganizationId: "linear-org",
      issueId: "issue",
      eventKey: "delivery",
      appUserId: "app",
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      sourceActorId: "human",
      sourceBody: "Status changed",
      markerUrl: "https://hub.test/#linear-event=exact",
      leaseId: "first",
      leaseExpiresAt: new Date(30_000),
      now: new Date(0),
    };
    const claims = await Promise.all([
      database.claimLinearIssueSessionBridge(input),
      database.claimLinearIssueSessionBridge({ ...input, leaseId: "second" }),
    ]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    const winner = claims.find((claim) => claim.claimed)!;
    assert.equal(
      await database.startLinearIssueSessionBridgeCreation(
        input,
        winner.bridge.leaseId,
        new Date(1),
      ),
      true,
    );
    assert.equal(
      await database.startLinearIssueSessionBridgeCreation(
        input,
        winner.bridge.leaseId,
        new Date(2),
      ),
      false,
    );
    const intake = {
      organizationId: "org",
      projectId,
      connectionId: "connection",
      linearOrganizationId: "linear-org",
      issueId: "intake-issue",
      providerEventReceiptId: receipt.event.providerEventReceiptId,
      source: {
        eventKey: "create-1",
        actorId: "human",
        teamId: "team",
        triageStateId: "triage",
        stateId: "backlog",
        updatedAt: "2026-09-11T10:00:00Z",
      },
      leaseId: "intake-first",
      leaseExpiresAt: new Date(30_000),
      now: new Date(0),
    };
    const intakes = await Promise.all([
      database.claimLinearTriageIntake(intake),
      database.claimLinearTriageIntake({
        ...intake,
        leaseId: "intake-other",
        source: { ...intake.source, eventKey: "create-2" },
      }),
    ]);
    assert.equal(intakes.filter((claim) => claim.claimed).length, 1);
    const intakeWinner = intakes.find((claim) => claim.claimed)!.record;
    assert.equal(
      await database.startLinearTriageIntake(intake, intakeWinner.leaseId, new Date(1)),
      true,
    );
    await database.close();
    runtime = await postgresDatabaseRuntime(postgres.getConnectionUri());
    database = createDatabase(runtime.runtime, runtime.locks);
    const recoveredIntake = await database.claimLinearTriageIntake({
      ...intake,
      leaseId: "intake-after-restart",
      now: new Date(31_000),
      leaseExpiresAt: new Date(61_000),
      source: { ...intake.source, eventKey: "replayed-create" },
    });
    assert.equal(recoveredIntake.record.source.eventKey, intakeWinner.source.eventKey);
    assert.equal(recoveredIntake.record.attemptStartedAt?.getTime(), 1);
    assert.equal(
      await database.startLinearTriageIntake(intake, "intake-after-restart", new Date(32_000)),
      false,
    );
    assert.equal(
      (
        await database.settleLinearTriageIntake(intake, "intake-after-restart", {
          status: "ambiguous",
          reason: "unknown",
        })
      ).status,
      "ambiguous",
    );
    // A late positive ACK from the first worker remains useful after the lease changes.
    assert.equal(
      (
        await database.settleLinearTriageIntake(intake, intakeWinner.leaseId, {
          status: "applied",
          reason: "acknowledged",
        })
      ).status,
      "applied",
    );
    const recovered = await database.claimLinearIssueSessionBridge({
      ...input,
      leaseId: "after-restart",
      now: new Date(31_000),
      leaseExpiresAt: new Date(61_000),
      sourceBody: "should not overwrite",
    });
    assert.equal(recovered.claimed, true);
    assert.equal(recovered.bridge.creationStartedAt?.getTime(), 1);
    assert.equal(recovered.bridge.sourceBody, "Status changed");
    assert.equal(
      await database.startLinearIssueSessionBridgeCreation(
        input,
        "after-restart",
        new Date(32_000),
      ),
      false,
    );
    assert.equal(
      (await database.findLinearIssueSessionBridgeByMarker(input, input.markerUrl))?.eventKey,
      "delivery",
    );
    assert.equal(
      await database.findLinearIssueSessionBridgeByMarker(
        { ...input, appUserId: "other" },
        input.markerUrl,
      ),
      undefined,
    );
    assert.equal(
      (await database.bindLinearIssueSessionBridge(input, "native")).sessionId,
      "native",
    );
    assert.equal(
      (await database.findLinearIssueSessionBridgeBySession(input, "native"))?.sourceBody,
      "Status changed",
    );
    await assert.rejects(database.bindLinearIssueSessionBridge(input, "different"), /conflicting/u);
    // Cascade cleanup remains scoped to the owning project and its receipt.
    await runtime.runtime.query("delete from projects where id=$1", [projectId]);
    assert.equal(await database.findLinearIssueSessionBridge(input), undefined);
    assert.equal(await database.findLinearTriageIntake(intake), undefined);
  } finally {
    await runtime.runtime.close();
    await postgres.stop();
  }
}, 120_000);
