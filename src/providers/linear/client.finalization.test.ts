import assert from "node:assert/strict";
import { it } from "vitest";
import { z } from "zod";
import { createLinearApiClient } from "./client.js";
import type { LinearConnectionRecord } from "../../db/types.js";

function fixture(responses: unknown[]) {
  const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const connection: LinearConnectionRecord = {
    id: "connection",
    organizationId: "org",
    slug: "linear",
    providerApplicationId: "app",
    linearOrganizationId: "linear-org",
    linearOrganizationName: "Linear",
    appUserId: "agent",
    accessToken: "test",
    refreshToken: null,
    accessTokenExpiresAt: null,
    scopes: ["read", "write"],
  };
  const api = createLinearApiClient({
    connectionForLinearOrganization: async () => connection,
    withLinearConnectionRefresh: async (_id, operation) => operation(connection, async () => {}),
    connectionClient: { refresh: async () => ({ accessToken: "unused" }) },
    fetch: async (_url, init) => {
      const body = init?.body;
      if (typeof body !== "string") throw new Error("Expected JSON");
      requests.push(
        z
          .object({ query: z.string(), variables: z.record(z.string(), z.unknown()) })
          .parse(JSON.parse(body)),
      );
      const response = responses.length === 1 ? responses[0] : responses.shift();
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  return { api, requests };
}

it("reads state type and updatedAt from the issue for finalization and intake guards", async () => {
  const { api, requests } = fixture([
    {
      data: {
        issue: {
          id: "issue",
          title: "Work",
          state: { id: "done", type: "completed" },
          updatedAt: "2026-09-11T12:00:00Z",
          labels: { nodes: [] },
        },
      },
    },
  ]);
  const issue = await api.readIssue({ linearOrganizationId: "linear-org", issueId: "issue" });
  assert.equal(issue?.stateType, "completed");
  assert.equal(issue?.updatedAt, "2026-09-11T12:00:00Z");
  assert.match(requests[0]?.query ?? "", /state \{ id type \}/u);
  assert.match(requests[0]?.query ?? "", /updatedAt/u);
});

it("reads every page of team states and human/app membership", async () => {
  const { api, requests } = fixture([
    {
      data: {
        team: {
          states: {
            nodes: [{ id: "review", type: "started" }],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
        },
      },
    },
    {
      data: {
        team: {
          states: {
            nodes: [{ id: "done", type: "completed" }],
            pageInfo: { hasNextPage: false, endCursor: "end" },
          },
        },
      },
    },
    {
      data: {
        team: {
          members: {
            nodes: [
              { id: "human", active: true, app: false },
              { id: "bot", active: true, app: true },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ]);
  assert.deepEqual(
    await api.readTeamWorkflowStates!({ linearOrganizationId: "linear-org", teamId: "team" }),
    [
      { id: "review", type: "started" },
      { id: "done", type: "completed" },
    ],
  );
  assert.equal(requests[1]?.variables["after"], "next");
  assert.deepEqual(
    await api.readTeamMembers!({ linearOrganizationId: "linear-org", teamId: "team" }),
    [
      { id: "human", active: true, app: false },
      { id: "bot", active: true, app: true },
    ],
  );
  assert.match(requests[2]?.query ?? "", /id active app/u);
});

it("rejects incomplete team collections instead of treating them as complete absence", async () => {
  const { api } = fixture([
    { data: { team: { states: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } },
  ]);
  await assert.rejects(
    api.readTeamWorkflowStates!({ linearOrganizationId: "linear-org", teamId: "team" }),
    /incomplete/u,
  );
  const members = fixture([
    {
      data: {
        team: { members: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "repeat" } } },
      },
    },
  ]);
  await assert.rejects(
    members.api.readTeamMembers!({ linearOrganizationId: "linear-org", teamId: "team" }),
    /incomplete/u,
  );
});

it("restricts mutations to the requested state and human assignee, without clearing delegation", async () => {
  const { api, requests } = fixture([{ data: { issueUpdate: { success: true } } }]);
  const input = {
    linearOrganizationId: "linear-org",
    issueId: "issue",
    stateId: "review",
    assigneeId: "human",
    delegateId: null,
  };
  await api.updateIssue!(input);
  assert.deepEqual(requests[0]?.variables, {
    issueId: "issue",
    input: { stateId: "review", assigneeId: "human" },
  });
  const failed = fixture([{ data: { issueUpdate: { success: false } } }]);
  await assert.rejects(failed.api.updateIssue!(input));
});
