import assert from "node:assert/strict";
import { it } from "vitest";
import { normalizeLinearEvent } from "./events.js";

it("preserves the original creation version and bot evidence independently of later hydration", () => {
  const event = normalizeLinearEvent(
    {
      type: "Issue",
      action: "create",
      organizationId: "org",
      actor: { id: "authorized-looking-bot", type: "application" },
      data: {
        id: "issue",
        title: "New",
        stateId: "backlog",
        updatedAt: "2026-09-11T10:00:00.000Z",
      },
    },
    "Issue",
    {
      id: "issue",
      identifier: "ADE-1",
      title: "Changed",
      description: null,
      projectId: null,
      teamId: "team",
      stateId: "done",
      updatedAt: "2026-09-11T10:30:00.000Z",
      assigneeId: null,
      delegateId: null,
      labelIds: [],
    },
  );
  assert.ok(event?.type === "issue");
  assert.equal(event.sourceStateId, "backlog");
  assert.equal(event.sourceIssueUpdatedAt, "2026-09-11T10:00:00.000Z");
  assert.equal(event.sourceActorIsBot, true);
});
