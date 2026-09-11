import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { LinearIssueDetails, LinearApiClient } from "../../providers/linear/client.js";
import type { LinearFinalOutcome } from "../../db/linear-replies.js";
import { finalizeLinearIssue } from "./finalization.js";

async function fixture(kind: LinearFinalOutcome["kind"] = "ready_for_review", assigneeId?: string) {
  const now = () => new Date("2026-09-11T12:00:00Z");
  const database = createMemoryDatabase({ now });
  const execution = await database.insertAgentExecution({
    id: randomUUID(),
    organizationId: "org",
    projectId: "project",
    machineId: null,
    triggerContext: {},
    outputContext: { provider: "linear" },
    configurationRevisionId: "revision",
  });
  const attempt = await database.beginAgentExecutionOutput(
    execution.id,
    "linear.reply",
    undefined,
    now(),
  );
  assert.ok(attempt);
  const reply = await database.reserveLinearReply({
    id: randomUUID(),
    executionId: execution.id,
    turnKey: "initial",
    attemptId: attempt.id,
    createdAt: now(),
    payload: {
      organizationId: "org",
      projectId: "project",
      connectionId: "connection",
      applicationId: "app",
      linearOrganizationId: "linear-org",
      issueId: "issue",
      agentSessionId: "session",
      commentId: randomUUID(),
      activityId: randomUUID(),
      body: "Report",
      activity: { content: { type: "response", body: "Report" } },
      finalizeIssue: {
        teamId: "team",
        reviewStateId: "review",
        completedStateId: "done",
        waitingStateId: "waiting",
        allowedAssigneeIds: ["human", "app-user", "disabled"],
      },
      outcome: {
        kind,
        validation: "Tests passed",
        nextAction: "Review",
        ...(assigneeId === undefined ? {} : { assigneeId }),
      },
    },
  });
  vi.spyOn(database, "findLinearConnectionForOrganization").mockResolvedValue({
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
  });
  let issue: LinearIssueDetails = {
    id: "issue",
    title: "Work",
    description: null,
    projectId: "project",
    teamId: "team",
    stateId: "started",
    stateType: "started",
    assigneeId: "original-human",
    delegateId: "agent",
    labelIds: [],
  };
  const updates: Array<Parameters<NonNullable<LinearApiClient["updateIssue"]>>[0]> = [];
  const states = [
    { id: "review", type: "started" },
    { id: "done", type: "completed" },
    { id: "waiting", type: "unstarted" },
  ];
  const client: LinearApiClient = {
    readIssue: async () => ({ ...issue }),
    readTeamWorkflowStates: async () => states,
    readTeamMembers: async () => [
      { id: "human", active: true, app: false },
      { id: "app-user", active: true, app: true },
      { id: "disabled", active: false, app: false },
    ],
    updateIssue: async (input) => {
      updates.push(input);
      issue = {
        ...issue,
        ...(input.stateId === undefined
          ? {}
          : {
              stateId: input.stateId,
              stateType: states.find((state) => state.id === input.stateId)?.type ?? "unknown",
            }),
        ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
      };
    },
    readIssueComments: async () => ({ complete: true, comments: [] }),
    readAgentSessionActivities: async () => ({ complete: true, activities: [] }),
    readCommentThread: async () => undefined,
    createComment: async () => {},
    createAgentActivity: async () => {},
    updateAgentSessionExternalUrls: async () => {},
    updateAgentSessionPlan: async () => {},
    createAgentSessionOnComment: async () => ({ id: "unused" }),
  };
  return {
    database,
    client,
    reply,
    updates,
    states,
    now,
    setIssue: (patch: Partial<LinearIssueDetails>) => {
      issue = { ...issue, ...patch };
    },
    run: () => finalizeLinearIssue({ database, client, reply, now }),
  };
}

describe("explicit Linear issue finalization", () => {
  it.each([
    ["ready_for_review", "review"],
    ["completed", "done"],
    ["needs_input", "waiting"],
    ["blocked", "waiting"],
    ["interrupted", "waiting"],
  ] as const)(
    "maps %s to its configured state and preserves the owner/delegate",
    async (kind, stateId) => {
      const f = await fixture(kind);
      await f.run();
      assert.deepEqual(f.updates, [
        {
          linearOrganizationId: "linear-org",
          expectedConnectionId: "connection",
          issueId: "issue",
          stateId,
        },
      ]);
      assert.equal((await f.database.findLinearFinalization(f.reply.id))?.status, "applied");
      await f.run();
      assert.equal(f.updates.length, 1);
    },
  );
  it.each(["completed", "canceled", "duplicate"])(
    "preserves an issue already in %s",
    async (stateType) => {
      const f = await fixture();
      f.setIssue({ stateType, stateId: "human-closed" });
      await f.run();
      assert.equal(f.updates.length, 0);
      assert.equal((await f.database.findLinearFinalization(f.reply.id))?.status, "skipped");
    },
  );
  it("does not mutate for no_action or without an opt-in policy", async () => {
    const f = await fixture("no_action");
    await f.run();
    assert.equal(f.updates.length, 0);
    const other = await fixture();
    delete other.reply.payload.finalizeIssue;
    await other.run();
    assert.equal(other.updates.length, 0);
    assert.equal(await other.database.findLinearFinalization(other.reply.id), undefined);
  });
  it("assigns only an explicitly allowed active human", async () => {
    const f = await fixture("needs_input", "human");
    await f.run();
    assert.equal(f.updates[0]?.assigneeId, "human");
    assert.equal(Object.hasOwn(f.updates[0], "delegateId"), false);
  });
  it.each(["stranger", "app-user", "disabled"])(
    "refuses unsafe assignee %s without changing the issue",
    async (person) => {
      const f = await fixture("needs_input", person);
      await assert.rejects(f.run(), /assignee/u);
      assert.equal(f.updates.length, 0);
      assert.equal((await f.database.findLinearFinalization(f.reply.id))?.status, "refused");
    },
  );
  it.each([{ teamId: "other-team" }, { delegateId: "other-agent" }, { stateType: "unverified" }])(
    "refuses mismatched or unverified authority %j",
    async (patch) => {
      const f = await fixture();
      f.setIssue(patch);
      await assert.rejects(f.run(), /requires|verified/u);
      assert.equal(f.updates.length, 0);
    },
  );
  it.each(["completed", "duplicate", "unknown"])(
    "refuses an invalid review state type %s",
    async (type) => {
      const f = await fixture();
      f.states[0]!.type = type;
      await assert.rejects(f.run(), /workflow type/u);
      assert.equal(f.updates.length, 0);
    },
  );
  it("reconciles an accepted update with a lost acknowledgement without repeating the mutation", async () => {
    const f = await fixture();
    const update = f.client.updateIssue!.bind(f.client);
    f.client.updateIssue = async (input) => {
      await update(input);
      throw new Error("ACK lost");
    };
    await f.run();
    await f.run();
    assert.equal(f.updates.length, 1);
    assert.equal((await f.database.findLinearFinalization(f.reply.id))?.status, "applied");
  });
  it("records uncertainty and never retries an attempted mutation that cannot be confirmed", async () => {
    const f = await fixture();
    const update = vi.fn(async () => {
      throw new Error("offline");
    });
    f.client.updateIssue = update;
    await assert.rejects(f.run(), /not confirmed/u);
    await assert.rejects(f.run(), /not confirmed/u);
    assert.equal(update.mock.calls.length, 1);
    assert.equal((await f.database.findLinearFinalization(f.reply.id))?.status, "ambiguous");
  });
  it("preserves human changes made after preparation", async () => {
    const f = await fixture();
    const read = f.client.readIssue.bind(f.client);
    let calls = 0;
    f.client.readIssue = async (input) => {
      calls += 1;
      if (calls === 2) f.setIssue({ assigneeId: "human-chosen-owner" });
      return read(input);
    };
    await f.run();
    assert.equal(f.updates.length, 0);
    assert.equal((await f.database.findLinearFinalization(f.reply.id))?.status, "skipped");
  });
  it("does not apply an older turn's outcome after a new input", async () => {
    const f = await fixture();
    await f.database.beginAgentExecutionTurn(f.reply.executionId, f.now(), "new");
    await f.run();
    assert.equal(f.updates.length, 0);
    assert.equal((await f.database.findLinearFinalization(f.reply.id))?.status, "skipped");
  });
});
