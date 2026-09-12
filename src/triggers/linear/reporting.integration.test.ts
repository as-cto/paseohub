import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { it } from "vitest";
import { createPostgresTestRuntime } from "../../db/test-utils/runtime.js";
import type { LinearApiClient } from "../../providers/linear/client.js";
import { createLinearReplyReporter, type PublishLinearReplyInput } from "./reporting.js";

it("acknowledges the first final report and identical retries after PostgreSQL jsonb reorders its keys", async () => {
  const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
  try {
    const { database, runtime } = await createPostgresTestRuntime(postgres.getConnectionUri());
    try {
      const projectId = randomUUID();
      const connectionId = randomUUID();
      await runtime.query(
        "insert into organization (id,name,slug) values ('report-org','Reports','reports')",
      );
      await runtime.query(
        "insert into projects (id,organization_id,name,slug) values ($1,'report-org','Reports','reports')",
        [projectId],
      );
      await runtime.query(
        `insert into linear_connections
         (id,organization_id,linear_organization_id,provider_application_id,slug,
          linear_organization_name,app_user_id,access_token)
         values ($1,'report-org','linear-org','app','reports','Reports','bot','test-only')`,
        [connectionId],
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
        finalizeIssue: { teamId: "team", reviewStateId: "review", completedStateId: "done" },
      };
      const execution = await database.insertAgentExecution({
        id: randomUUID(),
        organizationId: "report-org",
        projectId,
        machineId: null,
        configurationRevisionId: revision.id,
        triggerContext: {
          provider: "linear",
          event: {
            linear: {
              connection_id: connectionId,
              organization: { id: "linear-org" },
              issue: { id: "issue" },
            },
          },
        },
        outputContext: context,
      });
      const calls: string[] = [];
      const client: LinearApiClient = {
        readIssue: async () => ({
          id: "issue",
          title: "Work",
          description: null,
          projectId,
          teamId: "team",
          delegateId: "bot",
          stateId: "started",
          stateType: "started",
          assigneeId: "human",
          labelIds: [],
        }),
        readIssueComments: async () => ({ complete: true, comments: [] }),
        readAgentSessionActivities: async () => ({ complete: true, activities: [] }),
        readCommentThread: async () => undefined,
        readPublishedComment: async () => undefined,
        readPublishedAgentActivity: async () => undefined,
        createComment: async ({ expectedConnectionId, parentId }) => {
          assert.equal(expectedConnectionId, connectionId);
          assert.equal(parentId, undefined);
          calls.push("comment");
        },
        createAgentActivity: async ({ expectedConnectionId, agentSessionId }) => {
          assert.equal(expectedConnectionId, connectionId);
          assert.equal(agentSessionId, "native");
          calls.push("activity");
        },
        updateAgentSessionExternalUrls: async () => {},
        updateAgentSessionPlan: async () => {},
        createAgentSessionOnComment: async () => ({ id: "unused" }),
      };
      const reporter = createLinearReplyReporter({ database, client, applicationId: "app" });
      const input: PublishLinearReplyInput = {
        executionId: execution.id,
        context,
        body: "Inspected the issue; no change required.",
        activity: {
          content: { type: "response", body: "Inspected the issue; no change required." },
        },
        outcome: {
          kind: "no_action",
          validation: "Read the issue and existing workspace.",
          nextAction: "The reviewer can continue verification.",
        },
      };
      const acknowledged = { deliveryAcknowledged: true, connectionId };
      assert.deepEqual(await reporter.publish(input), acknowledged);
      const journal = await database.findLinearReply(execution.id, "initial");
      assert.ok(journal?.completedAt);
      assert.ok(journal.commentConfirmedAt);
      assert.ok(journal.activityConfirmedAt);
      assert.deepEqual(journal.payload.activity, input.activity);
      assert.notEqual(JSON.stringify(journal.payload.activity), JSON.stringify(input.activity));
      assert.deepEqual(journal.payload.outcome, input.outcome);
      assert.deepEqual(journal.payload.finalizeIssue, context.finalizeIssue);
      assert.equal((await database.findLinearFinalization(journal.id))?.status, "skipped");
      assert.deepEqual(await reporter.publish(input), acknowledged);
      await assert.rejects(
        reporter.publish({
          ...input,
          outcome: { ...input.outcome!, nextAction: "A different request" },
        }),
        /A different final report is already reserved/u,
      );
      assert.deepEqual(calls, ["comment", "activity"]);
      assert.equal(
        (await database.findAgentExecutionById(execution.id))?.outputEmissions["linear.reply"],
        1,
      );
      assert.equal((await database.findLinearReply(execution.id, "initial"))?.id, journal.id);
    } finally {
      await runtime.close();
    }
  } finally {
    await postgres.stop();
  }
}, 120_000);
