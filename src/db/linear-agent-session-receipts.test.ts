import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "./memory.js";
import { linearAgentSessionReceiptPayload } from "../test-utils/linear-agent-session-receipt.js";
import {
  createActiveProjectConfiguration,
  TEST_DAEMON_SLUG,
} from "../test-utils/project-configuration.js";

describe("agent-session receipts by Linear comment", () => {
  it("lists the undropped session receipts opened from or prompted by the comment, newest first", async () => {
    const database = createMemoryDatabase();
    const organizationId = "session-receipts-org";
    const configuration = {
      environments: [{ name: "runner", kind: "daemon", daemon: TEST_DAEMON_SLUG, cwd: "/repo" }],
      triggers: [],
    };
    const { project } = await createActiveProjectConfiguration(database, configuration, {
      organizationId,
    });
    const { project: elsewhere } = await createActiveProjectConfiguration(database, configuration, {
      organizationId: "other-org",
    });
    const persist = async (
      deliveryId: string,
      source: string,
      payload: unknown,
      receivedAt: Date,
      owner: { organizationId: string; projectId: string } = {
        organizationId,
        projectId: project.id,
      },
    ) => {
      const receipt = await database.persistManualEvent({
        ...owner,
        source,
        deliveryId,
        receivedAt,
        payload,
      });
      if (receipt.status !== "accepted") throw new Error("expected an accepted receipt");
      return receipt.event.providerEventReceiptId;
    };
    const created = await persist(
      "created",
      "linear.agent_session",
      linearAgentSessionReceiptPayload({
        action: "created",
        rootCommentId: "comment-1",
        sourceCommentId: "comment-1",
      }),
      new Date(1_000),
    );
    const prompted = await persist(
      "prompted",
      "linear.agent_session",
      linearAgentSessionReceiptPayload({ rootCommentId: "comment-1", sourceCommentId: "reply-1" }),
      new Date(2_000),
    );
    const other = await persist(
      "other",
      "linear.agent_session",
      linearAgentSessionReceiptPayload({ rootCommentId: "comment-2", sourceCommentId: "reply-2" }),
      new Date(3_000),
    );
    // A comment receipt carries no session, whatever its payload names.
    await persist(
      "comment",
      "linear.comment",
      { type: "comment", agentSession: { rootCommentId: "comment-1", sourceCommentId: "reply-1" } },
      new Date(4_000),
    );
    // A dropped receipt never starts a run, so it answers for no comment.
    const dropped = await persist(
      "dropped",
      "linear.agent_session",
      linearAgentSessionReceiptPayload({ sourceCommentId: "comment-1" }),
      new Date(5_000),
    );
    await database.markProviderEventDropped(dropped, "no_trigger_for_source");
    await persist(
      "elsewhere",
      "linear.agent_session",
      linearAgentSessionReceiptPayload({ sourceCommentId: "comment-1" }),
      new Date(6_000),
      { organizationId: "other-org", projectId: elsewhere.id },
    );

    const ids = async (commentId: string) =>
      (await database.listLinearAgentSessionReceiptsForComment(organizationId, commentId)).map(
        (receipt) => receipt.id,
      );
    assert.deepEqual(await ids("comment-1"), [prompted, created]);
    assert.deepEqual(await ids("reply-1"), [prompted]);
    assert.deepEqual(await ids("comment-2"), [other]);
    assert.deepEqual(await ids("reply-2"), [other]);
    assert.deepEqual(await ids("comment-3"), []);
  });
});
