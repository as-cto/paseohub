import assert from "node:assert/strict";
import { it } from "vitest";
import { z } from "zod";
import { createLinearApiClient } from "./client.js";
import type { LinearConnectionRecord } from "../../db/types.js";

function fixture(response: unknown, replaceDuringRefresh = false) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let refreshCalls = 0;
  const connection: LinearConnectionRecord = {
    id: "connection",
    organizationId: "org",
    slug: "linear",
    providerApplicationId: "app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Linear",
    appUserId: "agent",
    accessToken: "test",
    refreshToken: replaceDuringRefresh ? "test-refresh" : null,
    accessTokenExpiresAt: replaceDuringRefresh ? new Date(0) : null,
    scopes: ["read", "write"],
  };
  const api = createLinearApiClient({
    connectionForLinearOrganization: async () => connection,
    withLinearConnectionRefresh: async (_id, operation) =>
      operation(
        replaceDuringRefresh ? { ...connection, id: "replacement" } : connection,
        async () => {},
      ),
    connectionClient: {
      refresh: async () => {
        refreshCalls += 1;
        return { accessToken: "unused" };
      },
    },
    fetch: async (_url, init) => {
      const body = init?.body;
      assert.equal(typeof body, "string");
      if (typeof body !== "string") throw new Error("Expected a JSON request");
      requests.push(
        z
          .object({ query: z.string(), variables: z.record(z.string(), z.unknown()) })
          .parse(JSON.parse(body)),
      );
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { api, requests, refreshCalls: () => refreshCalls };
}

it.each(["comment", "activity", "readComment", "readActivity", "updateIssue"] as const)(
  "refuses replacement credentials at the %s HTTP boundary",
  async (operation) => {
    const f = fixture({});
    const scope = {
      linearOrganizationId: "linear-org",
      expectedConnectionId: "original-connection",
    };
    const calls = {
      comment: () => f.api.createComment({ ...scope, issueId: "issue", body: "Report" }),
      activity: () =>
        f.api.createAgentActivity({
          ...scope,
          agentSessionId: "session",
          content: { type: "response", body: "Report" },
        }),
      readComment: () => f.api.readPublishedComment!({ ...scope, id: "comment" }),
      readActivity: () => f.api.readPublishedAgentActivity!({ ...scope, id: "activity" }),
      updateIssue: () => f.api.updateIssue!({ ...scope, issueId: "issue", stateId: "review" }),
    };
    await assert.rejects(calls[operation](), /connection changed before credential lookup/u);
    assert.equal(f.requests.length, 0);
    assert.equal(f.refreshCalls(), 0);
  },
);

it("refuses a connection replacement between token lookup and locked refresh", async () => {
  const f = fixture({}, true);
  await assert.rejects(
    f.api.createComment({
      linearOrganizationId: "linear-org",
      expectedConnectionId: "connection",
      issueId: "issue",
      body: "Report",
    }),
    /connection changed before credential refresh/u,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(f.refreshCalls(), 0);
});

it("sends caller-reserved UUIDs in both publication mutations", async () => {
  const comment = fixture({ data: { commentCreate: { success: true } } });
  await comment.api.createComment({
    id: "00000000-0000-4000-8000-000000000001",
    linearOrganizationId: "linear-org",
    expectedConnectionId: "connection",
    issueId: "issue",
    body: "Report",
  });
  assert.equal(comment.requests[0]?.variables["id"], "00000000-0000-4000-8000-000000000001");
  assert.equal(comment.requests[0]?.variables["expectedConnectionId"], undefined);
  assert.match(comment.requests[0]?.query ?? "", /commentCreate\(input: \{ id: \$id/u);
  const native = fixture({ data: { agentActivityCreate: { success: true } } });
  await native.api.createAgentActivity({
    id: "00000000-0000-4000-8000-000000000002",
    linearOrganizationId: "linear-org",
    agentSessionId: "session",
    content: { type: "response", body: "Report" },
  });
  assert.equal(native.requests[0]?.variables["id"], "00000000-0000-4000-8000-000000000002");
  assert.match(native.requests[0]?.query ?? "", /agentActivityCreate\(input: \{\s+id: \$id/u);
});

it("reads a root issue comment by exact ID and retains target/content proof", async () => {
  const { api, requests } = fixture({
    data: {
      comments: {
        nodes: [{ id: "comment", body: "Report", issue: { id: "issue" }, parent: null }],
      },
    },
  });
  assert.deepEqual(
    await api.readPublishedComment!({ linearOrganizationId: "linear-org", id: "comment" }),
    { id: "comment", issueId: "issue", parentId: null, body: "Report" },
  );
  assert.match(requests[0]!.query, /comments\(filter: \{ id: \{ eq: \$id \} \}, first: 1\)/u);
  assert.deepEqual(requests[0]?.variables, { id: "comment" });
});

it("reads native publication by exact ID and retains session/body/type proof", async () => {
  const { api, requests } = fixture({
    data: {
      agentActivities: {
        nodes: [
          {
            id: "activity",
            agentSession: { id: "session" },
            content: { __typename: "AgentActivityErrorContent", type: "error", body: "Stopped" },
          },
        ],
      },
    },
  });
  assert.deepEqual(
    await api.readPublishedAgentActivity!({ linearOrganizationId: "linear-org", id: "activity" }),
    { id: "activity", agentSessionId: "session", type: "error", body: "Stopped" },
  );
  assert.match(
    requests[0]!.query,
    /agentActivities\(filter: \{ id: \{ eq: \$id \} \}, first: 1\)/u,
  );
});

it("distinguishes confirmed absence from a provider lookup failure", async () => {
  const empty = fixture({ data: { comments: { nodes: [] }, agentActivities: { nodes: [] } } });
  assert.equal(
    await empty.api.readPublishedComment!({ linearOrganizationId: "linear-org", id: "missing" }),
    undefined,
  );
  assert.equal(
    await empty.api.readPublishedAgentActivity!({
      linearOrganizationId: "linear-org",
      id: "missing",
    }),
    undefined,
  );
  const denied = fixture({ errors: [{ message: "Forbidden" }] });
  await assert.rejects(
    denied.api.readPublishedComment!({ linearOrganizationId: "linear-org", id: "unknown" }),
    /Forbidden/u,
  );
});
