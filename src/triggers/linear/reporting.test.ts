import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { LinearConnectionRecord } from "../../db/types.js";
import type { LinearApiClient } from "../../providers/linear/client.js";
import { currentTurnOutputEmissions } from "../../execution-capabilities/required-outputs.js";
import { createLinearReplyExecutor } from "./reply.js";
import { createLinearReplyReporter } from "./reporting.js";
import { reserveLinearNativeHandoff } from "./native-handoff.js";

async function fixture() {
  let time = new Date("2026-09-11T12:00:00Z");
  const now = () => time;
  const database = createMemoryDatabase({ now });
  const context = {
    provider: "linear",
    linearOrganizationId: "linear-org",
    issueId: "issue",
    agentSessionId: "session",
    publishIssueComment: true,
    threadRootCommentId: "thread",
  };
  const execution = await database.insertAgentExecution({
    id: randomUUID(),
    organizationId: "org",
    projectId: "project",
    machineId: null,
    triggerContext: {
      provider: "linear",
      event: {
        linear: {
          connection_id: "connection",
          organization: { id: "linear-org" },
          issue: { id: "issue" },
        },
      },
    },
    outputContext: context,
    configurationRevisionId: "revision",
  });
  let connection: LinearConnectionRecord = {
    id: "connection",
    organizationId: "org",
    slug: "linear",
    providerApplicationId: "app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Workspace",
    appUserId: "agent",
    accessToken: "test",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: ["read", "write"],
  };
  vi.spyOn(database, "findLinearConnectionForOrganization").mockImplementation(
    async (organizationId, linearOrganizationId) =>
      connection.organizationId === organizationId &&
      connection.linearOrganizationId === linearOrganizationId
        ? connection
        : undefined,
  );
  const comments = new Map<
    string,
    { id: string; issueId: string; body: string; parentId: string | null }
  >();
  const activities = new Map<
    string,
    { id: string; agentSessionId: string; body: string; type: string }
  >();
  const calls: string[] = [];
  const client: LinearApiClient = {
    readIssue: async () => undefined,
    readIssueComments: async () => ({ complete: true, comments: [] }),
    readAgentSessionActivities: async () => ({ complete: true, activities: [] }),
    readCommentThread: async () => undefined,
    readPublishedComment: async ({ id }) => comments.get(id),
    readPublishedAgentActivity: async ({ id }) => activities.get(id),
    createComment: async (input) => {
      assert.equal(input.expectedConnectionId, "connection");
      assert.ok(input.id);
      assert.equal(
        comments.has(input.id),
        false,
        "duplicate mutation must be reconciled before creation",
      );
      calls.push("comment");
      comments.set(input.id, {
        id: input.id,
        issueId: input.issueId,
        body: input.body,
        parentId: input.parentId ?? null,
      });
    },
    createAgentActivity: async (input) => {
      assert.equal(input.expectedConnectionId, "connection");
      assert.ok(input.id);
      assert.ok("body" in input.content);
      assert.equal(
        activities.has(input.id),
        false,
        "duplicate mutation must be reconciled before creation",
      );
      calls.push("activity");
      activities.set(input.id, {
        id: input.id,
        agentSessionId: input.agentSessionId,
        type: input.content.type,
        body: input.content.body,
      });
    },
    updateAgentSessionExternalUrls: async () => {},
    updateAgentSessionPlan: async () => {},
    createAgentSessionOnComment: async () => ({ id: "unused" }),
  };
  const reporter = () => createLinearReplyReporter({ database, client, now, applicationId: "app" });
  const args = {
    content: "Fixed the import failure. PR: https://github.com/acme/project/pull/42",
    outcome: {
      kind: "ready_for_review",
      validation: "Focused tests passed.",
      nextAction: "A reviewer should inspect the PR.",
    },
  };
  async function reply(overrideArgs = args) {
    return createLinearReplyExecutor({ client, reporter: reporter() })({
      agentExecutionId: execution.id,
      toolType: "linear.reply",
      args: overrideArgs,
      outputContext: context,
    });
  }
  return {
    database,
    execution,
    context,
    client,
    calls,
    comments,
    activities,
    reporter,
    reply,
    args,
    now,
    advance: () => {
      time = new Date(time.getTime() + 16 * 60_000);
    },
    replaceConnection: () => {
      connection = { ...connection, id: "replacement" };
    },
  };
}

describe("durable Linear final reports", () => {
  it.each(["reply", "terminal", "handoff"] as const)(
    "rejects a replacement connection before the first %s reservation",
    async (path) => {
      const f = await fixture();
      f.replaceConnection();
      if (path === "reply") await assert.rejects(f.reply(), /connection.*changed/u);
      if (path === "terminal") {
        await f.database.transitionAgentExecution(f.execution.id, "failed", {
          result: { reason: "agent_turn_failed" },
        });
        await assert.rejects(
          f.reporter().reportMissingTerminalOutcome(f.execution.id),
          /connection changed/u,
        );
        assert.deepEqual(await f.database.listTerminalLinearReplyCandidates("app", 20), []);
      }
      if (path === "handoff")
        await assert.rejects(
          reserveLinearNativeHandoff(
            f.database,
            f.execution.id,
            { ...f.context, agentSessionId: "next" },
            f.now(),
          ),
          /connection is unavailable/u,
        );
      assert.equal(f.calls.length, 0);
      assert.equal(await f.database.findLinearReply(f.execution.id, "initial"), undefined);
      assert.equal(
        Object.keys(
          (await f.database.findAgentExecutionById(f.execution.id))!.outputDeliveryAttempts,
        ).length,
        0,
      );
    },
  );

  it("retains the authorized event snapshot of an already-reserved output attempt across a new input", async () => {
    const f = await fixture();
    const attempt = await f.database.beginAgentExecutionOutput(
      f.execution.id,
      "linear.reply",
      undefined,
      f.now(),
    );
    assert.ok(attempt);
    await f.database.beginAgentExecutionTurn(f.execution.id, f.now(), "next", {
      triggerContext: {
        provider: "linear",
        event: {
          linear: {
            connection_id: "unrelated-new-binding",
            organization: { id: "linear-org" },
            issue: { id: "issue" },
          },
        },
      },
      outputContext: { ...f.context, agentSessionId: "new-session" },
    });
    await createLinearReplyExecutor({ client: f.client, reporter: f.reporter() })({
      agentExecutionId: f.execution.id,
      attemptId: attempt.id,
      toolType: "linear.reply",
      args: f.args,
      outputContext: f.context,
      triggerContext: f.execution.triggerContext,
    });
    assert.equal(
      (await f.database.findLinearReply(f.execution.id, "initial"))?.payload.connectionId,
      "connection",
    );
    assert.equal([...f.activities.values()][0]?.agentSessionId, "session");
  });

  it.each([true, false])(
    "acknowledges configured finalization only when live authority is valid (%s)",
    async (authorized) => {
      const f = await fixture();
      Object.assign(f.context, {
        finalizeIssue: { teamId: "team", reviewStateId: "review", completedStateId: "done" },
      });
      let stateId = "started";
      f.client.readIssue = async () => ({
        id: "issue",
        title: "Work",
        description: null,
        projectId: "project",
        teamId: authorized ? "team" : "other-team",
        stateId,
        stateType: "started",
        assigneeId: "human",
        delegateId: "agent",
        labelIds: [],
      });
      f.client.readTeamWorkflowStates = async () => [{ id: "review", type: "started" }];
      f.client.readTeamMembers = async () => [];
      f.client.updateIssue = async (input) => {
        f.calls.push("update");
        if (input.stateId !== undefined) stateId = input.stateId;
      };
      if (authorized) await f.reply();
      else await assert.rejects(f.reply(), /configured team/u);
      assert.deepEqual(
        f.calls,
        authorized ? ["comment", "activity", "update"] : ["comment", "activity"],
      );
      const reply = await f.database.findLinearReply(f.execution.id, "initial");
      assert.ok(reply);
      assert.ok(reply.commentConfirmedAt);
      assert.ok(reply.activityConfirmedAt);
      assert.equal(reply.completedAt !== null, authorized);
      assert.equal(
        (await f.database.findAgentExecutionById(f.execution.id))?.outputEmissions["linear.reply"],
        authorized ? 1 : undefined,
      );
      assert.equal(
        (await f.database.findLinearFinalization(reply.id))?.status,
        authorized ? "applied" : "refused",
      );
      f.advance();
      await f.reporter().recover();
      assert.equal(f.calls.length, authorized ? 3 : 2);
    },
  );

  it("publishes the complete report as a root issue comment and native response before acknowledging", async () => {
    const f = await fixture();
    assert.deepEqual(await f.reply(), { deliveryAcknowledged: true });
    assert.deepEqual(f.calls, ["comment", "activity"]);
    const comment = [...f.comments.values()][0]!;
    const activity = [...f.activities.values()][0]!;
    assert.match(comment.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
    assert.equal(comment.parentId, null);
    assert.equal(comment.body, activity.body);
    assert.match(comment.body, /PR:.*\/42/u);
    assert.match(comment.body, /Validation: Focused tests passed/u);
    assert.match(comment.body, /Next action: A reviewer/u);
    const record = await f.database.findLinearReply(f.execution.id, "initial");
    assert.ok(record?.completedAt);
    assert.ok(record.commentConfirmedAt);
    assert.ok(record.activityConfirmedAt);
    assert.equal(record.payload.outcome?.kind, "ready_for_review");
    assert.equal(
      (await f.database.findAgentExecutionById(f.execution.id))?.outputEmissions["linear.reply"],
      1,
    );
    await f.reply();
    assert.equal(f.calls.length, 2);
    assert.equal(
      (await f.database.findAgentExecutionById(f.execution.id))?.outputEmissions["linear.reply"],
      1,
    );
  });

  it.each(["comment", "activity"] as const)(
    "confirms a lost %s acknowledgement by the reserved UUID",
    async (destination) => {
      const f = await fixture();
      if (destination === "comment") {
        const create = f.client.createComment.bind(f.client);
        vi.spyOn(f.client, "createComment").mockImplementation(async (input) => {
          await create(input);
          throw new Error("ACK lost");
        });
      } else {
        const create = f.client.createAgentActivity.bind(f.client);
        vi.spyOn(f.client, "createAgentActivity").mockImplementation(async (input) => {
          await create(input);
          throw new Error("ACK lost");
        });
      }
      await f.reply();
      assert.deepEqual(f.calls, ["comment", "activity"]);
      assert.ok((await f.database.findLinearReply(f.execution.id, "initial"))?.completedAt);
    },
  );

  it.each(["comment", "activity"] as const)(
    "recovers %s delivery after restart and an expired/failed original tool attempt",
    async (destination) => {
      const f = await fixture();
      let offline = false;
      if (destination === "comment") {
        const create = f.client.createComment.bind(f.client);
        vi.spyOn(f.client, "createComment").mockImplementation(async (input) => {
          await create(input);
          offline = true;
          throw new Error("ACK lost");
        });
        const read = f.client.readPublishedComment!.bind(f.client);
        f.client.readPublishedComment = async (input) => {
          if (offline) throw new Error("offline");
          return read(input);
        };
      } else {
        const create = f.client.createAgentActivity.bind(f.client);
        vi.spyOn(f.client, "createAgentActivity").mockImplementation(async (input) => {
          await create(input);
          offline = true;
          throw new Error("ACK lost");
        });
        const read = f.client.readPublishedAgentActivity!.bind(f.client);
        f.client.readPublishedAgentActivity = async (input) => {
          if (offline) throw new Error("offline");
          return read(input);
        };
      }
      await assert.rejects(f.reply(), /offline/u);
      const reserved = await f.database.findLinearReply(f.execution.id, "initial");
      assert.ok(reserved);
      await f.database.failAgentExecutionOutput(f.execution.id, reserved.attemptId, f.now());
      assert.equal(
        (await f.database.findAgentExecutionById(f.execution.id))?.outputEmissions["linear.reply"],
        undefined,
      );
      f.advance();
      offline = false;
      await f.reporter().recover();
      assert.deepEqual(f.calls, ["comment", "activity"]);
      assert.equal(
        (await f.database.findLinearReply(f.execution.id, "initial"))?.payload.commentId,
        reserved.payload.commentId,
      );
      assert.equal(
        (await f.database.findAgentExecutionById(f.execution.id))?.outputDeliveryAttempts[
          reserved.attemptId
        ]?.status,
        "succeeded",
      );
    },
  );

  it("recovers a database acknowledgement failure without publishing again", async () => {
    const f = await fixture();
    const ack = vi
      .spyOn(f.database, "acknowledgeLinearReply")
      .mockRejectedValueOnce(new Error("database unavailable"));
    await assert.rejects(f.reply(), /database unavailable/u);
    f.advance();
    await f.reporter().recover();
    assert.equal(ack.mock.calls.length, 2);
    assert.deepEqual(f.calls, ["comment", "activity"]);
    assert.equal(
      (await f.database.findAgentExecutionById(f.execution.id))?.outputEmissions["linear.reply"],
      1,
    );
  });

  it("converges concurrent tool calls onto the first reserved report", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.reply(), f.reply()]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.deepEqual(f.calls, ["comment", "activity"]);
    const execution = await f.database.findAgentExecutionById(f.execution.id);
    assert.ok(execution);
    assert.equal(
      Object.values(execution.outputDeliveryAttempts).filter(
        (attempt) => attempt.status === "succeeded",
      ).length,
      1,
    );
  });

  it("preserves an old issue report without closing or acknowledging a newer native turn", async () => {
    const f = await fixture();
    const activity = vi
      .spyOn(f.client, "createAgentActivity")
      .mockRejectedValue(new Error("offline"));
    await assert.rejects(f.reply(), /offline/u);
    await f.database.beginAgentExecutionTurn(f.execution.id, f.now(), "new-input");
    activity.mockRestore();
    f.advance();
    await f.reporter().recover();
    assert.deepEqual(f.calls, ["comment"]);
    assert.ok((await f.database.findLinearReply(f.execution.id, "initial"))?.supersededAt);
    const execution = await f.database.findAgentExecutionById(f.execution.id);
    assert.ok(execution);
    assert.equal(currentTurnOutputEmissions(execution)["linear.reply"], undefined);
    await f.reply({ ...f.args, content: "No further change is needed." });
    assert.deepEqual(f.calls, ["comment", "comment", "activity"]);
    const latest = await f.database.findAgentExecutionById(f.execution.id);
    assert.ok(latest);
    assert.equal(currentTurnOutputEmissions(latest)["linear.reply"], 1);
  });

  it("serializes the native final response with delivery of the next input", async () => {
    const f = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = f.client.createAgentActivity.bind(f.client);
    let entered = false;
    vi.spyOn(f.client, "createAgentActivity").mockImplementation(async (input) => {
      entered = true;
      await blocked;
      await create(input);
    });
    const publication = f.reply();
    await vi.waitFor(() => assert.equal(entered, true));
    let advanced = false;
    const prompt = f.database.withAdvisoryLock(`execution.prompt:${f.execution.id}`, async () => {
      await f.database.beginAgentExecutionTurn(f.execution.id, f.now(), "next");
      advanced = true;
    });
    await Promise.resolve();
    assert.equal(advanced, false);
    release();
    await publication;
    await prompt;
    assert.equal(advanced, true);
    const execution = await f.database.findAgentExecutionById(f.execution.id);
    assert.ok(execution);
    assert.equal(currentTurnOutputEmissions(execution)["linear.reply"], undefined);
  });

  it("finishes an older distinct native session while leaving the current turn unacknowledged", async () => {
    const f = await fixture();
    const activity = vi
      .spyOn(f.client, "createAgentActivity")
      .mockRejectedValue(new Error("offline"));
    await assert.rejects(f.reply(), /offline/u);
    await f.database.beginAgentExecutionTurn(f.execution.id, f.now(), "new-input", {
      triggerContext: {},
      outputContext: { ...f.context, agentSessionId: "new-session" },
    });
    activity.mockRestore();
    f.advance();
    await f.reporter().recover();
    assert.deepEqual(f.calls, ["comment", "activity"]);
    assert.equal([...f.activities.values()][0]?.agentSessionId, "session");
    assert.ok((await f.database.findLinearReply(f.execution.id, "initial"))?.completedAt);
    const execution = await f.database.findAgentExecutionById(f.execution.id);
    assert.ok(execution);
    assert.equal(currentTurnOutputEmissions(execution)["linear.reply"], undefined);
  });

  it("durably closes a superseded native session even if its agent never produced a final report", async () => {
    const f = await fixture();
    const next = { ...f.context, agentSessionId: "new-session" };
    await f.database.withAdvisoryLock(`execution.prompt:${f.execution.id}`, async () => {
      await reserveLinearNativeHandoff(f.database, f.execution.id, next, f.now());
      await f.database.beginAgentExecutionTurn(f.execution.id, f.now(), "new-input", {
        triggerContext: {},
        outputContext: next,
      });
    });
    assert.equal(f.calls.length, 0);
    await f.reporter().recover();
    assert.deepEqual(f.calls, ["comment", "activity"]);
    assert.equal([...f.activities.values()][0]?.agentSessionId, "session");
    assert.match(
      [...f.comments.values()][0]?.body ?? "",
      /does not confirm that the work is complete/u,
    );
    assert.equal(
      (await f.database.findLinearReply(f.execution.id, "initial"))?.payload.outcome,
      undefined,
    );
    const execution = await f.database.findAgentExecutionById(f.execution.id);
    assert.ok(execution);
    assert.equal(currentTurnOutputEmissions(execution)["linear.reply"], undefined);
  });

  it("never replaces a real final report with a handoff notice", async () => {
    const f = await fixture();
    await f.reply();
    const previous = await f.database.findLinearReply(f.execution.id, "initial");
    assert.ok(previous);
    await reserveLinearNativeHandoff(
      f.database,
      f.execution.id,
      { ...f.context, agentSessionId: "next" },
      f.now(),
    );
    assert.deepEqual(await f.database.findLinearReply(f.execution.id, "initial"), previous);
  });

  it("refuses a changed retry and replacement connection authority", async () => {
    const f = await fixture();
    vi.spyOn(f.client, "createAgentActivity").mockRejectedValue(new Error("offline"));
    await assert.rejects(f.reply(), /offline/u);
    await assert.rejects(
      f.reply({ ...f.args, content: "Different result" }),
      /different final report/u,
    );
    f.replaceConnection();
    f.advance();
    await f.reporter().recover();
    assert.deepEqual(f.calls, ["comment"]);
    assert.match(
      (await f.database.findLinearReply(f.execution.id, "initial"))?.lastError ?? "",
      /connection changed/u,
    );
  });

  it("recovers a missed terminal hook with a factual issue report without changing failure into success", async () => {
    const f = await fixture();
    await f.database.transitionAgentExecution(f.execution.id, "failed", {
      result: { reason: "agent_turn_failed" },
    });
    await f.reporter().recover();
    assert.deepEqual(f.calls, ["comment", "activity"]);
    assert.match(
      [...f.comments.values()][0]?.body ?? "",
      /Changes, tests and pull request readiness are unconfirmed/u,
    );
    assert.equal([...f.activities.values()][0]?.type, "error");
    assert.equal((await f.database.findAgentExecutionById(f.execution.id))?.status, "failed");
    await f.reporter().recover();
    assert.equal(f.calls.length, 2);
  });
});
