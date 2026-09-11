import { describe, expect, it } from "vitest";
import { linearIssueChanges } from "./issue-changes.js";

describe("Linear work changes", () => {
  it("retains status, human assignment and label removals with their before/after evidence", () => {
    expect(
      linearIssueChanges(
        {
          stateId: "review",
          assigneeId: "reviewer",
          labelIds: ["bug"],
          sortOrder: 2,
          updatedAt: "later",
        },
        {
          stateId: "started",
          assigneeId: "author",
          labelIds: ["urgent", "bug"],
          sortOrder: 1,
          updatedAt: "before",
        },
      ),
    ).toEqual([
      { field: "stateId", before: "started", after: "review" },
      { field: "assigneeId", before: "author", after: "reviewer" },
      { field: "labelIds", before: ["bug", "urgent"], after: ["bug"] },
    ]);
  });

  it("ignores reorderings, unchanged values and absent fields", () => {
    expect(
      linearIssueChanges(
        { labelIds: ["b", "a"], title: "same", sortOrder: 10 },
        { labelIds: ["a", "b"], title: "same", sortOrder: 5, assigneeId: "someone" },
      ),
    ).toEqual([]);
  });

  it("keeps explicit unassignment, removed deadlines and edited descriptions", () => {
    expect(
      linearIssueChanges(
        { assigneeId: null, dueDate: null, description: "new", estimate: 0 },
        { assigneeId: "person", dueDate: "2026-09-11", description: null, estimate: 3 },
      ),
    ).toEqual([
      { field: "description", before: null, after: "new" },
      { field: "assigneeId", before: "person", after: null },
      { field: "dueDate", before: "2026-09-11", after: null },
      { field: "estimate", before: 3, after: 0 },
    ]);
  });
});
