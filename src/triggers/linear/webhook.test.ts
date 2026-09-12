import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it, vi } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { DurableProviderEvent, ProviderEventAcceptance } from "../../db/types.js";
import {
  NormalizedLinearAgentSessionEventSchema,
  NormalizedLinearCommentEventSchema,
  NormalizedLinearIssueEventSchema,
} from "./events.js";
import {
  createLinearWebhookSource,
  verifyLinearSignature,
  verifyLinearWebhookTimestamp,
} from "./webhook.js";

const SECRET = "linear-webhook-secret";
const NOW = 1_700_000_000_000;

describe("Linear webhook", () => {
  it("hydrates an omitted assignee removal even when the issue already has a complete project route", async () => {
    const original = issueEnvelope();
    const { assigneeId: previousAssignee, ...data } = original.data;
    const resolveIssue = vi.fn(async () => ({
      ...projectlessIssueDetails(),
      projectId: "project-1",
      assigneeId: null,
    }));
    let accepted = false;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      resolveIssue,
      accept: async (input) => {
        accepted = true;
        const event = NormalizedLinearIssueEventSchema.parse(input.payload);
        assert.deepEqual(event.changes, [
          { field: "assigneeId", before: previousAssignee, after: null },
        ]);
        assert.equal(input.projectId, "project-1");
        return acceptedEvent(input);
      },
    });
    const response = await endpoint.handle(
      request({
        ...original,
        action: "update",
        data,
        updatedFrom: { assigneeId: previousAssignee },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(accepted, true);
    assert.deepEqual(resolveIssue.mock.calls, [
      [{ linearOrganizationId: "linear-org", issueId: "issue-1" }],
    ]);
  });

  it("acknowledges durable admission before blocked hydration and dispatch, then deduplicates signature replays", async () => {
    const database = createMemoryDatabase({ now: () => new Date(NOW) });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dispatches = 0;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      inbox: { database, applicationId: "app", configurationVersion: 7 },
      resolveIssue: async () => {
        await blocked;
        return projectlessIssueDetails();
      },
      accept: async (input) => {
        assert.equal(input.providerConfigurationVersion, 7);
        return acceptedEvent(input);
      },
    });
    await endpoint.start(async () => {
      dispatches++;
    });
    try {
      assert.equal((await endpoint.handle(request(commentEnvelope(), "Comment"))).status, 200);
      const [admitted] = await database.listPendingLinearWebhooks("app", new Date(NOW), 10);
      assert.ok(admitted);
      assert.equal(dispatches, 0);
      assert.deepEqual(admitted.payload, commentEnvelope());
      assert.equal(
        (
          await endpoint.handle(
            request(commentEnvelope(), "Comment", { deliveryId: "replayed-delivery" }),
          )
        ).status,
        200,
      );
      release();
      await vi.waitFor(async () =>
        assert.ok((await database.findLinearWebhook(admitted.id))?.completedAt),
      );
      assert.equal(dispatches, 1);
      assert.equal((await endpoint.handle(request(commentEnvelope(), "Comment"))).status, 200);
      assert.equal(dispatches, 1);
    } finally {
      release();
      await endpoint.stop();
    }
  });

  it("recovers admitted work after restart and persists transient handoff retry", async () => {
    let now = NOW;
    const database = createMemoryDatabase({ now: () => new Date(now) });
    const options = {
      signingSecret: SECRET,
      now: () => now,
      inbox: { database, applicationId: "app", configurationVersion: 1 },
      accept: async (
        input: Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0],
      ) => acceptedEvent(input),
    };
    const admission = createLinearWebhookSource(options);
    assert.equal((await admission.handle(request(issueEnvelope()))).status, 200);
    const [row] = await database.listPendingLinearWebhooks("app", new Date(now), 10);
    assert.ok(row);
    const firstWorker = createLinearWebhookSource(options);
    await firstWorker.start(async () => {
      throw new Error("temporary provider failure");
    });
    await vi.waitFor(async () =>
      assert.equal((await database.findLinearWebhook(row.id))?.attempts, 1),
    );
    await firstWorker.stop();
    const failed = await database.findLinearWebhook(row.id);
    assert.equal(failed?.completedAt, null);
    assert.ok(failed?.lastError);
    assert.equal((await database.listPendingLinearWebhooks("app", new Date(now), 10)).length, 0);
    now += 2000;
    let recovered = 0;
    const recoveredWorker = createLinearWebhookSource(options);
    await recoveredWorker.start(async () => {
      recovered++;
    });
    try {
      await vi.waitFor(async () =>
        assert.ok((await database.findLinearWebhook(row.id))?.completedAt),
      );
      assert.equal(recovered, 1);
      assert.equal((await database.findLinearWebhook(row.id))?.attempts, 2);
    } finally {
      await recoveredWorker.stop();
    }
  });

  it("returns a retryable error if verified admission cannot be persisted", async () => {
    const database = createMemoryDatabase();
    database.admitLinearWebhook = async () => {
      throw new Error("database unavailable");
    };
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      inbox: { database, applicationId: "app", configurationVersion: 1 },
      accept: async () => {
        throw new Error("must not dispatch without durable admission");
      },
    });
    assert.equal((await endpoint.handle(request(issueEnvelope()))).status, 503);
  });

  it("serializes recovery by two source workers so they dispatch one admitted webhook once", async () => {
    const database = createMemoryDatabase({ now: () => new Date(NOW) });
    const options = {
      signingSecret: SECRET,
      now: () => NOW,
      inbox: { database, applicationId: "app", configurationVersion: 1 },
      accept: async (
        input: Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0],
      ) => acceptedEvent(input),
    };
    const first = createLinearWebhookSource(options);
    const second = createLinearWebhookSource(options);
    await first.handle(request(issueEnvelope()));
    const [row] = await database.listPendingLinearWebhooks("app", new Date(NOW), 10);
    assert.ok(row);
    let dispatches = 0;
    const handle = async () => {
      dispatches++;
    };
    await Promise.all([first.start(handle), second.start(handle)]);
    try {
      await vi.waitFor(async () =>
        assert.ok((await database.findLinearWebhook(row.id))?.completedAt),
      );
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
    assert.equal(dispatches, 1);
  });
  it("verifies the exact raw body and its signed replay timestamp", () => {
    const body = new TextEncoder().encode('{"title":"héllo"}');
    const signature = sign(body);
    assert.equal(verifyLinearSignature(SECRET, body, signature), true);
    assert.equal(verifyLinearSignature(SECRET, body, `sha256=${signature.toUpperCase()}`), true);
    assert.equal(verifyLinearSignature(SECRET, body, sign("different")), false);
    assert.equal(verifyLinearSignature(SECRET, body, "short"), false);
    assert.equal(verifyLinearWebhookTimestamp({ webhookTimestamp: NOW }, NOW), true);
    assert.equal(verifyLinearWebhookTimestamp({ webhookTimestamp: NOW - 60_001 }, NOW), false);
    assert.equal(verifyLinearWebhookTimestamp({ webhookTimestamp: "not-a-time" }, NOW), false);
  });

  it("normalizes an issue, durably accepts it, and dispatches its selected route", async () => {
    const accepted: unknown[] = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptedEvent(input));
    });
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await endpoint.handle(request(issueEnvelope()));
    assert.equal(response.status, 200);
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      dispatched.map(({ source: eventSource, resourceId }) => ({ eventSource, resourceId })),
      [{ eventSource: "linear.issue", resourceId: "project-1" }],
    );
    assert.deepEqual(accepted[0], {
      linearOrganizationId: "linear-org",
      projectId: "project-1",
      teamId: "team-1",
      deliveryId: "delivery-1",
      signatureHash: acceptedSignatureHash(),
      source: "linear.issue",
      payload: {
        type: "issue",
        action: "create",
        id: "issue-1",
        organizationId: "linear-org",
        actor: { id: "user-1", name: "Operator" },
        issue: {
          id: "issue-1",
          identifier: "ENG-42",
          title: "Ship the feature",
          description: "Useful context",
          url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
          projectId: "project-1",
          teamId: "team-1",
          stateId: "ready",
          assigneeId: "user-2",
          delegateId: null,
          labelIds: ["label-1"],
        },
        updatedFrom: {},
        changes: [],
        occurredAt: new Date(NOW).toISOString(),
      },
      receivedAt: new Date(NOW),
    });
  });

  it("canonicalizes accepted signature evidence before receipt deduplication", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    const endpoint = webhookSource((input) => {
      accepted.push(input);
      return Promise.resolve(acceptedEvent(input));
    });
    const body = JSON.stringify(issueEnvelope());
    const signature = sign(body);

    assert.equal(
      (await endpoint.handle(request(issueEnvelope(), "Issue", { signature }))).status,
      200,
    );
    assert.equal(
      (
        await endpoint.handle(
          request(issueEnvelope(), "Issue", { signature: `sha256=${signature.toUpperCase()}` }),
        )
      ).status,
      200,
    );

    assert.deepEqual(
      accepted.map((input) => input.signatureHash),
      [acceptedSignatureHash(), acceptedSignatureHash()],
    );
  });

  it("routes an explicitly projectless team event without issue hydration", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    let issueReads = 0;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => {
        issueReads += 1;
        throw new Error("complete team event must not hydrate");
      },
      accept: async (input) => {
        accepted.push(input);
        return { status: "duplicate", receiptId: input.deliveryId };
      },
    });
    const envelope = issueEnvelope();

    const response = await endpoint.handle(
      request({ ...envelope, data: { ...envelope.data, projectId: null } }),
    );

    assert.equal(response.status, 200);
    assert.equal(issueReads, 0);
    assert.equal(accepted[0]?.projectId, undefined);
    assert.equal(accepted[0]?.teamId, "team-1");
  });

  it("hydrates a compact project-scoped comment before matching", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => ({
        id: "issue-1",
        identifier: "ENG-42",
        title: "Ship the feature",
        description: null,
        projectId: "project-1",
        teamId: "team-1",
        stateId: "ready",
        assigneeId: "user-2",
        labelIds: ["label-1"],
      }),
      accept: async (input) => {
        accepted.push(input);
        return { status: "duplicate", receiptId: input.deliveryId };
      },
    });

    const envelope = commentEnvelope();
    assert.equal(
      (
        await endpoint.handle(
          request(
            {
              ...envelope,
              data: {
                ...envelope.data,
                issue: {
                  id: "issue-1",
                  title: "Ship the feature",
                  projectId: "project-1",
                  teamId: "team-1",
                },
              },
            },
            "Comment",
          ),
        )
      ).status,
      200,
    );
    assert.equal(accepted[0]?.projectId, "project-1");
    assert.equal(accepted[0]?.source, "linear.comment");
    const issue = NormalizedLinearCommentEventSchema.parse(accepted[0]?.payload).issue;
    assert.equal(issue?.stateId, "ready");
    assert.equal(issue?.assigneeId, "user-2");
    assert.deepEqual(issue?.labelIds, ["label-1"]);
  });

  it("hydrates a compact projectless team comment before matching", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    let issueReads = 0;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => {
        issueReads += 1;
        return projectlessIssueDetails();
      },
      accept: async (input) => {
        accepted.push(input);
        return { status: "duplicate", receiptId: input.deliveryId };
      },
    });
    const envelope = commentEnvelope();

    assert.equal(
      (
        await endpoint.handle(
          request(
            {
              ...envelope,
              data: { ...envelope.data, issue: compactProjectlessTeamIssue() },
            },
            "Comment",
          ),
        )
      ).status,
      200,
    );
    assert.equal(issueReads, 1);
    assert.equal(accepted[0]?.projectId, undefined);
    assert.equal(accepted[0]?.teamId, "team-1");
    assert.deepEqual(
      NormalizedLinearCommentEventSchema.parse(accepted[0]?.payload).issue,
      projectlessIssueDetails(),
    );
  });

  it("hydrates and dispatches compact project-scoped native Linear agent-session events", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    const dispatched: DurableProviderEvent[] = [];
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => ({
        id: "issue-1",
        identifier: "ENG-42",
        title: "Ship the feature",
        description: "Useful context",
        projectId: "project-1",
        teamId: "team-1",
        stateId: "ready",
        assigneeId: "app-user",
        labelIds: ["label-1"],
      }),
      accept: async (input) => {
        accepted.push(input);
        return acceptedEvent(input);
      },
    });
    await endpoint.start((event) => {
      dispatched.push(event);
      return Promise.resolve();
    });

    const response = await endpoint.handle(request(agentSessionEnvelope(), "AgentSessionEvent"));

    assert.equal(response.status, 200);
    assert.equal(accepted[0]?.source, "linear.agent_session");
    assert.equal(accepted[0]?.projectId, "project-1");
    assert.equal(dispatched[0]?.source, "linear.agent_session");
    const event = NormalizedLinearAgentSessionEventSchema.parse(accepted[0]?.payload);
    assert.equal(event.prompt, "<issue>Canonical Linear context</issue>");
    assert.equal(event.issue?.stateId, "ready");
    assert.equal(event.issue?.assigneeId, "app-user");
    assert.deepEqual(event.issue?.labelIds, ["label-1"]);
  });

  it.each(["created", "prompted"])(
    "accepts and dispatches a signed %s agent session without an actor or labels",
    async (action) => {
      const accepted: Array<
        Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
      > = [];
      const dispatched: DurableProviderEvent[] = [];
      const endpoint = createLinearWebhookSource({
        signingSecret: SECRET,
        now: () => NOW,
        canHydrateIssue: async () => true,
        resolveIssue: async () => ({ ...projectlessIssueDetails(), labelIds: [] }),
        accept: async (input) => {
          accepted.push(input);
          return acceptedEvent(input);
        },
      });
      await endpoint.start(async (event) => {
        dispatched.push(event);
      });
      const envelope = agentSessionEnvelope();
      const response = await endpoint.handle(
        request(
          {
            ...envelope,
            action,
            agentSession: {
              ...envelope.agentSession,
              creator: null,
              comment: { id: "comment-1", body: "Please investigate", user: null },
              issue: compactProjectlessTeamIssue(),
            },
            ...(action === "prompted"
              ? {
                  agentActivity: {
                    id: "activity-1",
                    createdAt: new Date(NOW).toISOString(),
                    user: null,
                    content: { type: "prompt", body: "Please continue" },
                  },
                }
              : {}),
          },
          "AgentSessionEvent",
        ),
      );

      assert.equal(response.status, 200);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0]?.source, "linear.agent_session");
      assert.equal(accepted[0]?.teamId, "team-1");
      assert.equal(accepted[0]?.projectId, undefined);
      const event = NormalizedLinearAgentSessionEventSchema.parse(accepted[0]?.payload);
      assert.equal(event.action, action);
      assert.equal(event.actor, null);
      assert.equal(event.agentSession.id, "session-1");
      assert.deepEqual(event.issue?.labelIds, []);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]?.source, "linear.agent_session");
      assert.deepEqual(dispatched[0]?.payload, event);
    },
  );

  it("hydrates a compact projectless team Agent Session before matching", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    let issueReads = 0;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => {
        issueReads += 1;
        return projectlessIssueDetails();
      },
      accept: async (input) => {
        accepted.push(input);
        return { status: "duplicate", receiptId: input.deliveryId };
      },
    });
    const envelope = agentSessionEnvelope();

    assert.equal(
      (
        await endpoint.handle(
          request(
            {
              ...envelope,
              agentSession: {
                ...envelope.agentSession,
                issue: compactProjectlessTeamIssue(),
              },
            },
            "AgentSessionEvent",
          ),
        )
      ).status,
      200,
    );
    assert.equal(issueReads, 1);
    assert.equal(accepted[0]?.projectId, undefined);
    assert.equal(accepted[0]?.teamId, "team-1");
    assert.deepEqual(
      NormalizedLinearAgentSessionEventSchema.parse(accepted[0]?.payload).issue,
      projectlessIssueDetails(),
    );
  });

  it("acknowledges an unbound compact agent session before issue hydration", async () => {
    let issueReads = 0;
    let acceptedSource: string | undefined;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => false,
      resolveIssue: async () => {
        issueReads += 1;
        throw new Error("Linear connection unavailable");
      },
      accept: async (input) => {
        acceptedSource = input.source;
        return { status: "dropped", receiptId: input.deliveryId, reason: "linear_unbound" };
      },
    });

    assert.equal(
      (await endpoint.handle(request(agentSessionEnvelope(), "AgentSessionEvent"))).status,
      200,
    );
    assert.equal(issueReads, 0);
    assert.equal(acceptedSource, "linear.agent_session");
  });

  it("acknowledges an unbound compact comment before attempting issue hydration", async () => {
    const accepted: Array<
      Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0]
    > = [];
    let issueReads = 0;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => false,
      resolveIssue: async () => {
        issueReads += 1;
        throw new Error("Linear connection unavailable");
      },
      accept: async (input) => {
        accepted.push(input);
        return { status: "dropped", receiptId: input.deliveryId, reason: "linear_unbound" };
      },
    });

    assert.equal((await endpoint.handle(request(commentEnvelope(), "Comment"))).status, 200);
    assert.equal(issueReads, 0);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.projectId, undefined);
    assert.equal(accepted[0]?.dropReason, undefined);
  });

  it("keeps a bound compact comment retryable when issue hydration fails", async () => {
    let accepted = false;
    const endpoint = createLinearWebhookSource({
      signingSecret: SECRET,
      now: () => NOW,
      canHydrateIssue: async () => true,
      resolveIssue: async () => Promise.reject(new Error("Linear API unavailable")),
      accept: async () => {
        accepted = true;
        return { status: "duplicate", receiptId: "delivery-1" };
      },
    });

    assert.equal((await endpoint.handle(request(commentEnvelope(), "Comment"))).status, 503);
    assert.equal(accepted, false);
  });

  it("rejects unsigned and unavailable handoffs", async () => {
    const endpoint = webhookSource(() => Promise.reject(new Error("database offline")));
    assert.equal(
      (
        await endpoint.handle(
          new Request("https://hub.test/api/integrations/linear/events", {
            method: "POST",
            body: JSON.stringify(issueEnvelope()),
          }),
        )
      ).status,
      401,
    );
    assert.equal(
      (await endpoint.handle(request({ ...issueEnvelope(), webhookTimestamp: NOW - 60_001 })))
        .status,
      401,
    );
    assert.equal((await endpoint.handle(request(issueEnvelope()))).status, 503);
  });
});

function webhookSource(
  accept: (
    input: Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0],
  ) => Promise<ProviderEventAcceptance>,
) {
  return createLinearWebhookSource({ signingSecret: SECRET, now: () => NOW, accept });
}

function request(
  payload: unknown,
  event = "Issue",
  evidence: { deliveryId?: string; signature?: string } = {},
): Request {
  const body = JSON.stringify(payload);
  return new Request("https://hub.test/api/integrations/linear/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": evidence.deliveryId ?? "delivery-1",
      "linear-event": event,
      "linear-signature": evidence.signature ?? sign(body),
    },
    body,
  });
}

function sign(body: string | Uint8Array): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function acceptedSignatureHash(): string {
  return createHash("sha256")
    .update(sign(JSON.stringify(issueEnvelope())))
    .digest("hex");
}

function acceptedEvent(
  input: Parameters<Parameters<typeof createLinearWebhookSource>[0]["accept"]>[0],
): ProviderEventAcceptance {
  return {
    status: "accepted",
    receiptId: "receipt-1",
    events: [
      {
        providerEventReceiptId: "receipt-1",
        organizationId: "org-1",
        projectId: "hub-project-1",
        configurationRevisionId: "11111111-1111-4111-8111-111111111132",
        deliveryId: input.deliveryId,
        source: input.source,
        payload: input.payload,
        receivedAt: input.receivedAt,
        connectionId: "linear-connection",
        resourceId: input.projectId ?? input.teamId ?? null,
      },
    ],
  };
}

function issueEnvelope() {
  return {
    action: "create",
    type: "Issue",
    organizationId: "linear-org",
    createdAt: new Date(NOW).toISOString(),
    webhookTimestamp: NOW,
    actor: { id: "user-1", name: "Operator" },
    data: {
      id: "issue-1",
      identifier: "ENG-42",
      title: "Ship the feature",
      description: "Useful context",
      url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
      projectId: "project-1",
      teamId: "team-1",
      stateId: "ready",
      assigneeId: "user-2",
      labelIds: ["label-1"],
    },
  };
}

function commentEnvelope() {
  return {
    action: "create",
    type: "Comment",
    organizationId: "linear-org",
    webhookTimestamp: NOW,
    actor: { id: "user-1", name: "Operator" },
    data: { id: "comment-1", issueId: "issue-1", body: "Please investigate" },
  };
}

function compactProjectlessTeamIssue() {
  return {
    id: "issue-1",
    title: "Ship the feature",
    project: null,
    team: { id: "team-1" },
  };
}

function projectlessIssueDetails() {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Ship the feature",
    description: "Useful context",
    projectId: null,
    teamId: "team-1",
    stateId: "ready",
    assigneeId: "user-2",
    delegateId: null,
    labelIds: ["label-1"],
  };
}

function agentSessionEnvelope() {
  return {
    action: "created",
    type: "AgentSessionEvent",
    organizationId: "linear-org",
    appUserId: "app-user",
    createdAt: new Date(NOW).toISOString(),
    webhookTimestamp: NOW,
    promptContext: "<issue>Canonical Linear context</issue>",
    agentSession: {
      id: "session-1",
      appUserId: "app-user",
      issueId: "issue-1",
      status: "pending",
      createdAt: new Date(NOW).toISOString(),
      creator: { id: "user-1", name: "Operator" },
      comment: {
        id: "comment-1",
        issueId: "issue-1",
        userId: "user-1",
        body: "@Paseo please draft a fix",
      },
      issue: {
        id: "issue-1",
        identifier: "ENG-42",
        title: "Ship the feature",
        description: "Useful context",
        url: "https://linear.app/acme/issue/ENG-42/ship-the-feature",
        projectId: "project-1",
        teamId: "team-1",
        team: { id: "team-1", name: "Engineering", key: "ENG" },
      },
    },
  };
}
