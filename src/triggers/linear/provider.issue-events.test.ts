import { z } from "zod";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import type { LinearIssueDetails } from "../../providers/linear/client.js";
import type { ExternalTrigger } from "../index.js";
import { normalizeLinearEvent, type NormalizedLinearIssueEvent } from "./events.js";
import { createLinearTriggerProvider } from "./provider.js";

const issue: LinearIssueDetails = {
  id: "issue-1",
  identifier: "ADE-154",
  title: "Review the document",
  description: null,
  projectId: null,
  teamId: "team-1",
  stateId: "review",
  assigneeId: "human",
  delegateId: "agent",
  labelIds: [],
};
async function fixture(
  options: { intake?: boolean; legacy?: boolean; replacedConnection?: boolean } = {},
) {
  const database = createMemoryDatabase();
  const active = await createActiveProjectConfiguration(
    database,
    {
      environments: [{ name: "issue", kind: "daemon", daemon: "runner", cwd: "/repo" }],
      triggers: [
        {
          name: "issue-updated",
          on: "linear.delegated_issue_updated",
          max_runtime: "1h",
          filters: {
            connection: "linear",
            team: "team-1",
            from_users: ["human"],
            require_delegate: true,
            publish_issue_comment: true,
            continue_issue: true,
            ...(options.intake ? { intake_triage_state_id: "triage" } : {}),
          },
          steps: [
            {
              id: "work",
              environment: "issue",
              max_runtime: "1h",
              idle_timeout: "5m",
              agent: { provider: "codex" },
              prompt: [{ text: "${{ paseo.context }}" }],
            },
          ],
        },
        ...(options.legacy
          ? [
              {
                name: "legacy-create",
                on: "linear.issue_entered_scope",
                max_runtime: "1h",
                filters: { team: "team-1", connection: "linear", from_users: ["human"] },
                steps: [
                  {
                    id: "work",
                    environment: "issue",
                    max_runtime: "1h",
                    idle_timeout: "5m",
                    agent: { provider: "codex" },
                    prompt: [{ text: "legacy" }],
                  },
                ],
              },
            ]
          : []),
      ],
    },
    { organizationId: "org-1" },
  );
  const stored = (await active.store.getRevision(active.revision.id))!;
  vi.spyOn(active.store, "getRevision").mockResolvedValue({
    ...stored,
    configuration: {
      ...stored.configuration,
      triggers: stored.configuration.triggers.map((trigger) =>
        Object.assign({}, trigger, {
          filters: { ...trigger.filters, connectionId: "10000000-0000-4000-8000-000000000001" },
        }),
      ),
    },
  });
  const client = {
    readTeamWorkflowStates: vi.fn(async () => [
      { id: "backlog", type: "backlog" },
      { id: "triage", type: "triage" },
    ]),
    updateIssue: vi.fn(async () => undefined),
    readIssue: vi.fn(async (): Promise<LinearIssueDetails | undefined> => issue),
    readIssueComments: vi.fn(async () => ({ complete: true, comments: [] })),
    readAgentSessionActivities: vi.fn(async () => ({ complete: true, activities: [] })),
    readCommentThread: vi.fn(async () => {
      throw new Error("Issue event must not invent a comment");
    }),
    createAgentActivity: vi.fn(async () => undefined),
    readIssueSessions: vi.fn(async () => []),
    createAgentSessionOnIssue: vi.fn(async () => ({ id: "native-issue-session" })),
  };
  const provider = createLinearTriggerProvider({
    database,
    client,
    publicBaseUrl: "https://hub.example",
    configurationStoreForProject: () => active.store,
    connectionForLinearOrganization: async () => ({
      appUserId: "agent",
      id: options.replacedConnection ? "replacement" : "10000000-0000-4000-8000-000000000001",
    }),
  });
  const event: NormalizedLinearIssueEvent = {
    type: "issue",
    action: "update",
    id: issue.id,
    organizationId: "linear-org",
    actor: { id: "human" },
    issue,
    updatedFrom: { stateId: "in-progress" },
    changes: [{ field: "stateId", before: "in-progress", after: "review" }],
    occurredAt: "2026-09-11T16:00:00.000Z",
  };
  const external = (payload = event): ExternalTrigger => ({
    providerEventReceiptId: randomUUID(),
    organizationId: "org-1",
    projectId: active.project.id,
    configurationRevisionId: active.revision.id,
    source: "linear.issue",
    deliveryId: "issue-event-1",
    connectionId: "10000000-0000-4000-8000-000000000001",
    receivedAt: new Date(),
    payload,
  });
  return { provider, client, event, external };
}
describe("delegated Linear issue events", () => {
  it("routes an isolated unassignment only after hydration confirms the omitted assignee", async () => {
    const f = await fixture();
    const current = { ...issue, assigneeId: null };
    f.client.readIssue.mockResolvedValue(current);
    const event = normalizeLinearEvent(
      {
        action: "update",
        type: "Issue",
        organizationId: "linear-org",
        actor: { id: "human" },
        data: { id: issue.id, title: issue.title, teamId: issue.teamId, projectId: null },
        updatedFrom: { assigneeId: "human" },
      },
      undefined,
      current,
    );
    if (event?.type !== "issue") throw new Error("expected an issue event");
    const result = await f.provider.match(f.external(event));
    if (typeof result === "string") throw new Error(result);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0]?.triggerContext.event.linear.changes, [
      { field: "assigneeId", before: "human", after: null },
    ]);
    assert.equal(f.client.createAgentSessionOnIssue.mock.calls.length, 1);
    assert.equal(f.client.updateIssue.mock.calls.length, 0);
  });

  it("refuses a replaced connection before creating a native session or admitting an issue", async () => {
    for (const intake of [false, true]) {
      const f = await fixture({ intake, replacedConnection: true });
      const event = intake ? { ...f.event, action: "create" as const } : f.event;
      await assert.rejects(f.provider.match(f.external(event)), /connection no longer matches/);
      assert.equal(f.client.readIssue.mock.calls.length, 0);
      assert.equal(f.client.createAgentSessionOnIssue.mock.calls.length, 0);
      assert.equal(f.client.updateIssue.mock.calls.length, 0);
    }
  });
  it("routes a status change to a durable native session with root-comment reporting", async () => {
    const f = await fixture();
    const result = await f.provider.match(f.external());
    assert.notEqual(typeof result, "string");
    if (typeof result === "string") throw new Error(result);
    assert.equal(result.length, 1);
    const match = result[0]!;
    assert.equal(match.outputContext.agentSessionId, "native-issue-session");
    assert.equal(match.outputContext.publishIssueComment, true);
    assert.equal(match.outputContext.threadRootCommentId, null);
    assert.equal(match.triggerContext.event.linear.agent_session?.id, "native-issue-session");
    assert.deepEqual(match.triggerContext.event.linear.changes, f.event.changes);
    await f.provider.match(f.external());
    assert.equal(f.client.createAgentSessionOnIssue.mock.calls.length, 1);
    assert.equal(f.client.readCommentThread.mock.calls.length, 0);
  });
  it("rechecks delegation and excludes revoked work before creating a session", async () => {
    const f = await fixture();
    f.client.readIssue.mockResolvedValue({ ...issue, delegateId: null });
    assert.equal(await f.provider.match(f.external()), "linear_issue_not_delegated");
    assert.equal(f.client.createAgentSessionOnIssue.mock.calls.length, 0);
  });
  it("does not run for sort order, unchanged labels, the app's own actions, or another team", async () => {
    const f = await fixture();
    for (const changes of [[], [{ field: "delegateId" as const, before: null, after: "agent" }]]) {
      assert.equal(
        await f.provider.match(f.external({ ...f.event, changes })),
        "linear_no_work_change",
      );
    }
    assert.equal(
      await f.provider.match(f.external({ ...f.event, actor: { id: "agent" } })),
      "linear_app_event_ignored",
    );
    f.client.readIssue.mockResolvedValue({ ...issue, teamId: "other-team" });
    assert.equal(await f.provider.match(f.external()), "linear_issue_outside_scope");
    assert.equal(f.client.createAgentSessionOnIssue.mock.calls.length, 0);
  });
});

describe("Triage admission before delegation filtering", () => {
  function created(event: NormalizedLinearIssueEvent): NormalizedLinearIssueEvent {
    return {
      ...event,
      action: "create",
      updatedFrom: {},
      changes: [],
      issue: { ...event.issue, stateId: "backlog", delegateId: null },
      sourceStateId: "backlog",
      sourceIssueUpdatedAt: "2026-09-11T10:00:00.000Z",
    };
  }
  it("is opt-in and moves an authorized newly-created issue before it is delegated", async () => {
    const enabled = await fixture({ intake: true });
    enabled.client.readIssue.mockResolvedValue({
      ...issue,
      stateId: "backlog",
      delegateId: null,
      updatedAt: "2026-09-11T10:00:00.000Z",
    });
    assert.equal(
      await enabled.provider.match(enabled.external(created(enabled.event))),
      "linear_intake_applied",
    );
    assert.deepEqual(enabled.client.updateIssue.mock.calls, [
      [
        {
          linearOrganizationId: "linear-org",
          expectedConnectionId: "10000000-0000-4000-8000-000000000001",
          issueId: "issue-1",
          stateId: "triage",
        },
      ],
    ]);
    assert.equal(enabled.client.createAgentSessionOnIssue.mock.calls.length, 0);
    const disabled = await fixture();
    disabled.client.readIssue.mockResolvedValue({ ...issue, delegateId: null });
    await disabled.provider.match(disabled.external(created(disabled.event)));
    assert.equal(disabled.client.updateIssue.mock.calls.length, 0);
  });
  it.each(["app", "bot", "unauthorized", "absent"])(
    "does not mutate for %s actors",
    async (kind) => {
      const f = await fixture({ intake: true });
      f.client.readIssue.mockResolvedValue({
        ...issue,
        stateId: "backlog",
        delegateId: null,
        updatedAt: "2026-09-11T10:00:00.000Z",
      });
      const event = created(f.event);
      if (kind === "app") event.actor = { id: "agent" };
      if (kind === "bot") event.sourceActorIsBot = true;
      if (kind === "unauthorized") event.actor = { id: "someone-else" };
      if (kind === "absent") event.actor = null;
      assert.equal(await f.provider.match(f.external(event)), "linear_intake_ignored");
      assert.equal(f.client.updateIssue.mock.calls.length, 0);
    },
  );
  it("keeps other create triggers eligible when intake lacks an original issue version", async () => {
    const f = await fixture({ intake: true, legacy: true });
    f.client.readIssue.mockResolvedValue({
      ...issue,
      stateId: "backlog",
      delegateId: null,
      updatedAt: "2026-09-11T10:00:00.000Z",
    });
    const event = created(f.event);
    delete event.sourceIssueUpdatedAt;
    const result = await f.provider.match(f.external(event));
    assert.ok(Array.isArray(result));
    assert.equal(
      z.array(z.object({ triggerName: z.string() })).parse(result)[0]?.triggerName,
      "legacy-create",
    );
    assert.equal(f.client.updateIssue.mock.calls.length, 0);
  });
  it("surfaces an ambiguous write instead of claiming the issue entered Triage", async () => {
    const f = await fixture({ intake: true });
    f.client.readIssue.mockResolvedValue({
      ...issue,
      stateId: "backlog",
      delegateId: null,
      updatedAt: "2026-09-11T10:00:00.000Z",
    });
    f.client.updateIssue.mockRejectedValue(new Error("lost acknowledgement"));
    assert.equal(await f.provider.match(f.external(created(f.event))), "linear_intake_ambiguous");
  });
});
