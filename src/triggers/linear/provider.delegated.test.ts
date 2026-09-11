import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { Database } from "../../db/types.js";
import type {
  LinearApiClient,
  LinearCommentThread,
  LinearIssueDetails,
} from "../../providers/linear/client.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch, type ExternalTrigger } from "../index.js";
import type { NormalizedLinearAgentSessionEvent, NormalizedLinearCommentEvent } from "./events.js";
import { createLinearTriggerProvider } from "./provider.js";

const liveIssue: LinearIssueDetails = {
  id: "issue-84",
  identifier: "SEN-84",
  title: "Analyse des scénarios du plan d’action",
  description: null,
  projectId: null,
  teamId: "project-team",
  stateId: "triage",
  assigneeId: "studio-reviewer",
  delegateId: "p-agent",
  labelIds: [],
};

// Sanitized SEN-84 incident replay: a CEO posts a new root comment on an issue delegated
// to P Agent. The human assignee is deliberately different from the app delegate.
const incident: NormalizedLinearCommentEvent = {
  type: "comment",
  action: "create",
  id: "ceo-feedback",
  organizationId: "linear-org",
  actor: { id: "ceo", name: "Project CEO" },
  comment: {
    id: "ceo-feedback",
    issueId: "issue-84",
    parentId: null,
    body: "Nous avons déjà tranché : mesurer le gain en confort, pas en équipement posé. Vérifie et confirme-moi.",
  },
  issue: liveIssue,
  occurredAt: "2026-09-09T12:00:00.000Z",
};

function configuration(
  extraFilters: Record<string, unknown> = {},
  inputs: Record<string, unknown> = {},
) {
  const step = {
    id: "work",
    environment: "runner",
    max_runtime: "1h",
    idle_timeout: "5m",
    agent: { provider: "codex" },
    prompt: [{ text: "${{ paseo.context }}" }],
  };
  return {
    environments: [{ name: "runner", kind: "daemon", daemon: "runner", cwd: "/repo" }],
    triggers: [
      {
        name: "delegated",
        on: "linear.delegated_comment",
        max_runtime: "1h",
        inputs,
        filters: {
          connection: "linear-connection",
          team: "project-team",
          from_users: ["ceo"],
          ...extraFilters,
        },
        steps: [step],
      },
      {
        name: "session",
        on: "linear.agent_session",
        max_runtime: "1h",
        filters: {
          connection: "linear-connection",
          team: "project-team",
          from_users: ["ceo"],
          allow_automated_sessions: true,
        },
        steps: [step],
      },
    ],
  };
}

function nativeCreated(
  rootId = incident.comment.id,
  sessionId = "native-session",
): NormalizedLinearAgentSessionEvent {
  return {
    type: "agent_session",
    action: "created",
    id: sessionId,
    organizationId: "linear-org",
    actor: null,
    agentSession: {
      id: sessionId,
      appUserId: "p-agent",
      issueId: "issue-84",
      status: "pending",
      rootCommentId: rootId,
      sourceCommentId: rootId,
    },
    agentActivity: null,
    prompt: "Old root context",
    parserMessage: "Old root context",
    promptContext: null,
    issue: incident.issue,
    occurredAt: "2026-09-09T12:00:01.000Z",
  };
}

async function fixture(
  extraFilters: Record<string, unknown> = {},
  database: Database = createMemoryDatabase(),
  inputs: Record<string, unknown> = {},
) {
  const active = await createActiveProjectConfiguration(
    database,
    configuration(extraFilters, inputs),
    {
      organizationId: "hub-org",
    },
  );
  const stored = await active.store.getRevision(active.revision.id);
  assert.ok(stored);
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
  let thread: LinearCommentThread = {
    rootId: incident.comment.id,
    authorIds: ["ceo"],
    agentSessionRootIds: [],
    agentSession: null,
  };
  const client = {
    readIssue: vi.fn(async (): Promise<LinearIssueDetails | undefined> => liveIssue),
    readIssueComments: vi.fn(async () => ({ complete: true, comments: [] })),
    readAgentSessionActivities: vi.fn(async () => ({ complete: true, activities: [] })),
    readCommentThread: vi.fn(async () => thread),
    createAgentActivity: vi.fn(async () => undefined),
    createAgentSessionOnComment: vi.fn(async () => {
      thread = {
        ...thread,
        agentSession: {
          id: "native-session",
          appUserId: "p-agent",
          createdAt: "2026-09-09T12:00:01.000Z",
        },
        agentSessionRootIds: [thread.rootId],
      };
      return { id: "native-session" };
    }),
  } satisfies Pick<
    LinearApiClient,
    | "readIssue"
    | "readIssueComments"
    | "readAgentSessionActivities"
    | "readCommentThread"
    | "createAgentActivity"
    | "createAgentSessionOnComment"
  >;
  const provider = createLinearTriggerProvider({
    database,
    client,
    configurationStoreForProject: () => active.store,
    connectionForLinearOrganization: async () => ({
      appUserId: "p-agent",
      id: "10000000-0000-4000-8000-000000000001",
    }),
  });
  const external = (
    payload: NormalizedLinearCommentEvent | NormalizedLinearAgentSessionEvent = incident,
  ): ExternalTrigger => ({
    providerEventReceiptId: randomUUID(),
    organizationId: "hub-org",
    projectId: active.project.id,
    configurationRevisionId: active.revision.id,
    source: payload.type === "comment" ? "linear.comment" : "linear.agent_session",
    deliveryId: randomUUID(),
    connectionId: "10000000-0000-4000-8000-000000000001",
    receivedAt: new Date(payload.occurredAt!),
    payload,
  });
  const accept = async (event: ExternalTrigger) => {
    const matches = await provider.match(event);
    if (typeof matches === "string") return matches;
    return Promise.all(
      matches.map(async (match) => {
        assert.ok(isAcceptedTriggerProviderMatch(match));
        return database.createAcceptedTriggerRun({
          organizationId: event.organizationId,
          projectId: event.projectId,
          configurationRevisionId: active.revision.id,
          providerEventReceiptId: event.providerEventReceiptId,
          configuredTriggerName: match.triggerName,
          prompt: match.invocation.prompt,
          inputs: match.invocation.inputs,
          triggerContext: match.triggerContext,
          outputContext: match.outputContext,
          stepIds: ["work"],
          deadlineAt: new Date("2099-01-01"),
        });
      }),
    );
  };
  return {
    ...active,
    database,
    provider,
    client,
    external,
    accept,
    setThread(value: LinearCommentThread) {
      thread = value;
    },
  };
}

describe("Linear delegated comment native bridge", () => {
  it("replays SEN-84 top-level CEO feedback with current delegation and original body", async () => {
    const f = await fixture();
    const matches = await f.provider.match(f.external());
    assert.ok(typeof matches !== "string");
    const match = matches[0];
    assert.ok(isAcceptedTriggerProviderMatch(match));
    assert.equal(match.invocation.prompt, incident.comment.body);
    assert.equal(match.triggerContext.event.linear.actor?.id, "ceo");
    assert.equal(match.outputContext.agentSessionId, "native-session");
    assert.equal(match.outputContext.threadRootCommentId, "ceo-feedback");
    assert.deepEqual(f.client.createAgentSessionOnComment.mock.calls[0], [
      { linearOrganizationId: "linear-org", commentId: "ceo-feedback" },
    ]);
  });

  it.each(["actor", "delegate", "team", "connection"])(
    "rejects a comment with unauthorized %s before external mutation",
    async (field) => {
      const f = await fixture();
      const event = structuredClone(incident);
      const external = f.external(event);
      if (field === "actor") event.actor = { id: "outsider" };
      if (field === "delegate")
        f.client.readIssue.mockResolvedValue({ ...liveIssue, delegateId: "another-app" });
      if (field === "team")
        f.client.readIssue.mockResolvedValue({ ...liveIssue, teamId: "other-team" });
      if (field === "connection") external.connectionId = "another-connection";
      assert.equal(await f.provider.match(external), "trigger_filters_rejected");
      assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 0);
    },
  );

  it("revalidates delegation after obtaining a pending bridge lease", async () => {
    const f = await fixture();
    f.client.readIssue
      .mockResolvedValueOnce(liveIssue)
      .mockResolvedValue({ ...liveIssue, delegateId: null });
    await assert.rejects(f.provider.match(f.external()), /delegation or team changed/u);
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 0);
    // No bridge mutation was sent: a later independent native session is not its echo.
    const independent = await f.provider.match(f.external(nativeCreated()));
    assert.ok(typeof independent !== "string");
    assert.equal(independent[0]?.outputContext.agentSessionId, "native-session");
  });

  it("does not create a session for rejected invocation inputs or input filters", async () => {
    const missing = await fixture({}, undefined, { priority: { type: "string", required: true } });
    const rejected = await missing.provider.match(missing.external());
    assert.ok(typeof rejected !== "string");
    assert.equal(rejected[0]?.invocation.status, "rejected");
    assert.equal(missing.client.createAgentSessionOnComment.mock.calls.length, 0);
    const filtered = await fixture({ inputs: { priority: "high" } }, undefined, {
      priority: { type: "string", default: "low" },
    });
    assert.equal(await filtered.provider.match(filtered.external()), "trigger_filters_rejected");
    assert.equal(filtered.client.createAgentSessionOnComment.mock.calls.length, 0);
  });

  it("keeps latest nested plain-thread feedback as owner and suppresses only its bridge-created session", async () => {
    const f = await fixture();
    f.setThread({
      rootId: "old-root",
      authorIds: ["ceo", "p-agent"],
      agentSessionRootIds: [],
      agentSession: null,
    });
    const nested = { ...incident, comment: { ...incident.comment, parentId: "old-root" } };
    const commentRuns = await f.accept(f.external(nested));
    assert.ok(Array.isArray(commentRuns));
    assert.equal(commentRuns[0]?.run.prompt, incident.comment.body);
    assert.equal(
      await f.accept(f.external(nativeCreated("old-root"))),
      "superseded_by_agent_session",
    );
    const retry = await f.accept(f.external(nativeCreated("old-root", "explicit-retry-session")));
    assert.ok(Array.isArray(retry));
    assert.equal(retry[0]?.created, true);
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
  });

  it("reuses a native session delivered first and gives the root comment the same durable dispatch identity", async () => {
    const f = await fixture();
    f.setThread({
      rootId: incident.comment.id,
      authorIds: ["ceo"],
      agentSessionRootIds: [incident.comment.id],
      agentSession: { id: "native-session", appUserId: "p-agent" },
    });
    const first = await f.accept(f.external(nativeCreated()));
    const second = await f.accept(f.external());
    assert.ok(Array.isArray(first) && Array.isArray(second));
    assert.equal(first[0]?.created, true);
    assert.equal(second[0]?.created, false);
    assert.equal(first[0]?.run.id, second[0]?.run.id);
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 0);
  });

  it("does not start a native-thread reply twice", async () => {
    const f = await fixture();
    f.setThread({
      rootId: "native-root",
      authorIds: ["ceo", "p-agent"],
      agentSessionRootIds: ["native-root"],
      agentSession: { id: "native-session", appUserId: "p-agent" },
    });
    assert.equal(
      await f.provider.match(
        f.external({ ...incident, comment: { ...incident.comment, parentId: "native-root" } }),
      ),
      "trigger_filters_rejected",
    );
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 0);
  });

  it("retries the original nested receipt after its thread became native without losing the body", async () => {
    const f = await fixture();
    f.setThread({ rootId: "old-root", authorIds: ["ceo"], agentSessionRootIds: [] });
    const external = f.external({
      ...incident,
      comment: { ...incident.comment, parentId: "old-root" },
    });
    const first = await f.accept(external);
    const replay = await f.accept(external);
    assert.ok(Array.isArray(first) && Array.isArray(replay));
    assert.equal(replay[0]?.created, false);
    assert.equal(replay[0]?.run.prompt, incident.comment.body);
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
  });

  it("recovers a lost creation acknowledgement from the exact app-owned root", async () => {
    const f = await fixture();
    f.client.createAgentSessionOnComment.mockImplementationOnce(async () => {
      f.setThread({
        rootId: incident.comment.id,
        authorIds: ["ceo"],
        agentSessionRootIds: [incident.comment.id],
        agentSession: { id: "native-session", appUserId: "p-agent" },
      });
      throw new Error("HTTP acknowledgement lost");
    });
    const first = await f.accept(f.external());
    assert.ok(Array.isArray(first));
    assert.equal(first[0]?.created, true);
    assert.equal(await f.accept(f.external(nativeCreated())), "superseded_by_agent_session");
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
  });

  it("keeps an ambiguous creation attempt recoverable without repeating its mutation after lease expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T12:00:00.000Z"));
    try {
      const f = await fixture();
      const external = f.external();
      f.client.createAgentSessionOnComment.mockRejectedValue(
        new Error("HTTP acknowledgement lost"),
      );
      await assert.rejects(f.provider.match(external), /acknowledgement lost/u);
      vi.setSystemTime(new Date("2026-09-09T12:01:00.000Z"));
      await assert.rejects(f.provider.match(external), /delivery is uncertain/u);
      assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
      f.setThread({
        rootId: incident.comment.id,
        authorIds: ["ceo"],
        agentSessionRootIds: [incident.comment.id],
        agentSession: { id: "recovered-session", appUserId: "p-agent" },
      });
      const recovered = await f.provider.match(external);
      assert.ok(typeof recovered !== "string");
      assert.equal(recovered[0]?.outputContext.agentSessionId, "recovered-session");
      assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles a delayed human comment posted before the bridge session existed, and excludes later native replies", async () => {
    const f = await fixture();
    f.setThread({ rootId: "old-root", authorIds: ["ceo"], agentSessionRootIds: [] });
    await f.accept(
      f.external({ ...incident, comment: { ...incident.comment, parentId: "old-root" } }),
    );
    const delayed = {
      ...incident,
      id: "delayed-child",
      comment: {
        ...incident.comment,
        id: "delayed-child",
        parentId: "old-root",
        body: "Une autre précision avant la création de la session.",
      },
    };
    const accepted = await f.accept(f.external(delayed));
    assert.ok(Array.isArray(accepted));
    assert.equal(accepted[0]?.run.prompt, delayed.comment.body);
    const later = { ...delayed, occurredAt: "2026-09-09T12:00:02.000Z" };
    assert.equal(await f.provider.match(f.external(later)), "trigger_filters_rejected");
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
  });

  it("does not reinterpret a prior native reply as ordinary feedback after a later explicit Retry", async () => {
    const f = await fixture();
    f.setThread({ rootId: "old-root", authorIds: ["ceo"], agentSessionRootIds: [] });
    await f.accept(
      f.external({ ...incident, comment: { ...incident.comment, parentId: "old-root" } }),
    );
    f.setThread({
      rootId: "old-root",
      authorIds: ["ceo", "p-agent"],
      agentSessionRootIds: ["old-root"],
      agentSession: {
        id: "retry-session",
        appUserId: "p-agent",
        createdAt: "2026-09-09T12:01:00.000Z",
      },
    });
    const delayedNativeReply = {
      ...incident,
      id: "native-reply",
      occurredAt: "2026-09-09T12:00:02.000Z",
      comment: { ...incident.comment, id: "native-reply", parentId: "old-root" },
    };
    assert.equal(
      await f.provider.match(f.external(delayedNativeReply)),
      "trigger_filters_rejected",
    );
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
  });

  it("reserves before mutation and defers concurrent created webhooks until the exact session is bound", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.client.createAgentSessionOnComment.mockImplementationOnce(async () => {
      entered();
      await waiting;
      return { id: "native-session" };
    });
    const first = f.accept(f.external());
    await entering;
    await assert.rejects(f.accept(f.external()), /creation is pending/u);
    await assert.rejects(f.accept(f.external(nativeCreated())), /binding is pending/u);
    release();
    await first;
    assert.equal(await f.accept(f.external(nativeCreated())), "superseded_by_agent_session");
    assert.equal(f.client.createAgentSessionOnComment.mock.calls.length, 1);
  });
});
