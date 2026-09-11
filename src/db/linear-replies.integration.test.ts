import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "./runtime/index.js";
import { createDatabase } from "./pg.js";
import type { ReserveLinearReply } from "./linear-replies.js";

it("persists both publication checkpoints and acknowledges a failed canonical attempt exactly once across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hub-linear-reports-"));
  let bundle = await embeddedDatabaseRuntime(join(root, "database"));
  try {
    await bundle.runtime.migrate();
    let database = createDatabase(bundle.runtime, bundle.locks);
    const projectId = randomUUID();
    await bundle.runtime.query(
      "insert into organization (id,name,slug) values ('report-org','Reports','reports')",
    );
    await bundle.runtime.query(
      "insert into projects (id,organization_id,name,slug) values ($1,'report-org','Reports','reports')",
      [projectId],
    );
    const revision = await database.insertProjectConfigurationRevision({
      projectId,
      sourceKind: "manual",
      sourceEvidence: {},
      normalizedConfiguration: { environments: [], triggers: [] },
      contentHash: "report-config",
    });
    const context = {
      provider: "linear",
      publishIssueComment: true,
      linearOrganizationId: "linear-org",
      issueId: "issue",
      agentSessionId: "native",
    };
    const execution = await database.insertAgentExecution({
      id: randomUUID(),
      organizationId: "report-org",
      projectId,
      machineId: null,
      configurationRevisionId: revision.id,
      triggerContext: {},
      outputContext: context,
    });
    const now = new Date("2026-09-11T12:00:00Z");
    const attempt = await database.beginAgentExecutionOutput(
      execution.id,
      "linear.reply",
      undefined,
      now,
    );
    assert.ok(attempt);
    const input: ReserveLinearReply = {
      id: randomUUID(),
      executionId: execution.id,
      turnKey: "initial",
      attemptId: attempt.id,
      createdAt: now,
      payload: {
        organizationId: execution.organizationId,
        projectId,
        connectionId: "connection",
        applicationId: "app",
        linearOrganizationId: "linear-org",
        issueId: "issue",
        agentSessionId: "native",
        commentId: randomUUID(),
        activityId: randomUUID(),
        body: "Report",
        activity: { content: { type: "response", body: "Report" } },
      },
    };
    const [first, second] = await Promise.all([
      database.reserveLinearReply(input),
      database.reserveLinearReply({
        ...input,
        id: randomUUID(),
        payload: { ...input.payload, body: "Must not replace" },
      }),
    ]);
    assert.equal(first.id, second.id);
    const leaseId = randomUUID();
    assert.ok(
      await database.claimLinearReply(first.id, leaseId, now, new Date(now.getTime() + 1000)),
    );
    assert.equal(
      await database.claimLinearReply(first.id, randomUUID(), now, new Date(now.getTime() + 1000)),
      undefined,
    );
    await database.confirmLinearReplyDestination(first.id, "comment", now);
    await assert.rejects(database.acknowledgeLinearReply(first.id, now), /does not match/u);
    await database.failAgentExecutionOutput(execution.id, attempt.id, now);
    await bundle.runtime.close();
    bundle = await embeddedDatabaseRuntime(join(root, "database"));
    database = createDatabase(bundle.runtime, bundle.locks);
    const resumed = await database.findLinearReply(execution.id, "initial");
    assert.ok(resumed);
    assert.equal(resumed.payload.commentId, input.payload.commentId);
    assert.equal(resumed.commentConfirmedAt?.toISOString(), now.toISOString());
    const later = new Date(now.getTime() + 60 * 60_000);
    assert.equal((await database.listPendingLinearReplies("other-app", later, 20)).length, 0);
    assert.equal((await database.listPendingLinearReplies("app", later, 20))[0]?.id, resumed.id);
    await database.confirmLinearReplyDestination(resumed.id, "activity", later);
    await database.acknowledgeLinearReply(resumed.id, later);
    await database.acknowledgeLinearReply(resumed.id, later);
    const completed = await database.findAgentExecutionById(execution.id);
    assert.ok(completed);
    assert.equal(completed.outputEmissions["linear.reply"], 1);
    assert.equal(completed.outputDeliveryAttempts[attempt.id]?.status, "succeeded");
    assert.equal((await database.listPendingLinearReplies("app", later, 20)).length, 0);
    // Terminal attempts are explicit opt-in and tied to the persisted current input.
    assert.equal(
      await database.beginTerminalLinearReplyAttempt(execution.id, "initial", later),
      undefined,
    );
    await database.transitionAgentExecution(execution.id, "failed", {
      result: { reason: "interrupted" },
    });
    assert.equal(
      await database.beginTerminalLinearReplyAttempt(execution.id, "turn:other", later),
      undefined,
    );
    assert.ok(await database.beginTerminalLinearReplyAttempt(execution.id, "initial", later));
    const action = await database.reserveLinearFinalization({
      replyId: first.id,
      target: { stateId: "review" },
      previous: { stateId: "started", assigneeId: "human" },
      createdAt: later,
    });
    assert.equal(action.status, "pending");
    assert.equal(await database.startLinearFinalization(first.id, later), true);
    assert.equal(await database.startLinearFinalization(first.id, later), false);
    await database.completeLinearFinalization(first.id, "ambiguous", "Unconfirmed update", later);
    await database.completeLinearFinalization(
      first.id,
      "applied",
      "Must not overwrite ambiguity",
      later,
    );
    assert.equal((await database.findLinearFinalization(first.id))?.status, "ambiguous");
    const connectionId = randomUUID();
    await bundle.runtime.query(
      `insert into linear_connections
      (id,organization_id,linear_organization_id,provider_application_id,slug,
       linear_organization_name,app_user_id,access_token)
      values ($1,'report-org','linear-org','app','reports','Reports','bot','test-only')`,
      [connectionId],
    );
    const candidateIds: string[] = [];
    for (const bound of [
      { connectionId, organizationId: "linear-org", issueId: "issue" },
      { connectionId: randomUUID(), organizationId: "linear-org", issueId: "issue" },
      { connectionId, organizationId: "other-org", issueId: "issue" },
      { connectionId, organizationId: "linear-org", issueId: "other-issue" },
    ]) {
      const candidate = await database.insertAgentExecution({
        id: randomUUID(),
        organizationId: "report-org",
        projectId,
        machineId: null,
        configurationRevisionId: revision.id,
        outputContext: context,
        triggerContext: {
          provider: "linear",
          event: {
            linear: {
              connection_id: bound.connectionId,
              organization: { id: bound.organizationId },
              issue: { id: bound.issueId },
            },
          },
        },
      });
      await database.transitionAgentExecution(candidate.id, "failed", {
        result: { reason: "interrupted" },
      });
      candidateIds.push(candidate.id);
    }
    assert.deepEqual(await database.listTerminalLinearReplyCandidates("app", 20), [
      candidateIds[0],
    ]);
    assert.deepEqual(await database.listTerminalLinearReplyCandidates("other-app", 20), []);
  } finally {
    await bundle.runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
