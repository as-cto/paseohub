import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { LinearIssueDetails } from "../../providers/linear/client.js";
import { intakeIssueCreated, type LinearTriageIntakeClient } from "./triage-intake.js";

function fixture() {
  const key = {
    organizationId: "hub-org",
    projectId: "project",
    connectionId: "connection",
    linearOrganizationId: "linear-org",
    issueId: "issue",
  };
  const database = createMemoryDatabase();
  let current: LinearIssueDetails = {
    id: "issue",
    identifier: "SEN-1",
    title: "Issue",
    description: null,
    teamId: "team",
    projectId: null,
    assigneeId: "human",
    delegateId: null,
    labelIds: [],
    stateId: "backlog",
    stateType: "backlog",
    updatedAt: "2026-09-11T10:00:00Z",
  };
  let time = 0;
  const writes: Array<Parameters<NonNullable<LinearTriageIntakeClient["updateIssue"]>>[0]> = [];
  const client: LinearTriageIntakeClient = {
    readIssue: async () => ({ ...current }),
    readTeamWorkflowStates: async () => [
      { id: "backlog", type: "backlog" },
      { id: "triage", type: "triage" },
      { id: "done", type: "completed" },
    ],
    updateIssue: async (input) => {
      writes.push(input);
      current = { ...current, stateId: input.stateId ?? current.stateId };
    },
  };
  const input = {
    key,
    eventKey: "create-delivery",
    providerEventReceiptId: "receipt",
    teamId: "team",
    triageStateId: "triage",
    sourceActorId: "human",
    fromUsers: ["human"],
    sourceStateId: "backlog",
    sourceIssueUpdatedAt: "2026-09-11T10:00:00Z",
    client,
    database,
    now: () => new Date(time),
  };
  return {
    input,
    writes,
    setIssue: (patch: Partial<LinearIssueDetails>) => {
      current = { ...current, ...patch };
    },
    advance: () => {
      time += 31_000;
    },
  };
}

describe("explicit one-time Triage intake", () => {
  it("moves to the verified team Triage once across distinct delivery IDs without assigning/delegating", async () => {
    const f = fixture();
    assert.deepEqual(await intakeIssueCreated(f.input), {
      status: "applied",
      reason: "linear_acknowledged_intake",
    });
    assert.deepEqual(f.writes, [
      {
        linearOrganizationId: "linear-org",
        expectedConnectionId: "connection",
        issueId: "issue",
        stateId: "triage",
      },
    ]);
    f.setIssue({ stateId: "done" });
    assert.equal(
      (await intakeIssueCreated({ ...f.input, eventKey: "another-delivery" })).status,
      "applied",
    );
    assert.equal(f.writes.length, 1);
  });

  it.each([null, "unauthorized"])(
    "ignores actor %s before reserving or using the provider",
    async (sourceActorId) => {
      const f = fixture();
      f.input.client.readIssue = async () => {
        throw new Error("must not read");
      };
      assert.deepEqual(await intakeIssueCreated({ ...f.input, sourceActorId }), {
        status: "ignored",
        reason: "actor_not_authorized",
      });
      assert.equal(await f.input.database.findLinearTriageIntake(f.input.key), undefined);
    },
  );

  it.each([
    [{ teamId: "other-team" }, "issue_outside_configured_team"],
    [{ stateId: "triage" }, "already_in_triage"],
    [{ stateId: "done" }, "issue_already_advanced"],
    [{ updatedAt: "2026-09-11T10:00:01Z" }, "issue_changed_since_creation"],
    [{ updatedAt: "" }, "creation_version_unavailable"],
  ] as const)("ignores stale/out-of-scope creation snapshots %#", async (patch, reason) => {
    const f = fixture();
    f.setIssue(patch);
    assert.deepEqual(await intakeIssueCreated(f.input), { status: "ignored", reason });
    assert.equal(f.writes.length, 0);
    assert.equal(
      (await f.input.database.findLinearTriageIntake(f.input.key))?.attemptStartedAt,
      null,
    );
  });

  it("verifies the selected status belongs to the team and has type triage", async () => {
    const f = fixture();
    f.input.client.readTeamWorkflowStates = async () => [{ id: "triage", type: "completed" }];
    assert.deepEqual(await intakeIssueCreated(f.input), {
      status: "ignored",
      reason: "configured_state_is_not_team_triage",
    });
    assert.equal(f.writes.length, 0);
  });

  it("rechecks issue freshness after the paginated team-state read", async () => {
    const f = fixture();
    const states = f.input.client.readTeamWorkflowStates.bind(f.input.client);
    f.input.client.readTeamWorkflowStates = async (input) => {
      f.setIssue({ stateId: "done" });
      return states(input);
    };
    assert.deepEqual(await intakeIssueCreated(f.input), {
      status: "ignored",
      reason: "issue_changed_before_intake",
    });
    assert.equal(f.writes.length, 0);
  });

  it("recovers a lost acknowledgement by reading Triage and never repeats the mutation", async () => {
    const f = fixture();
    const update = f.input.client.updateIssue.bind(f.input.client);
    f.input.client.updateIssue = async (input) => {
      await update(input);
      throw new Error("response lost");
    };
    assert.deepEqual(await intakeIssueCreated(f.input), {
      status: "applied",
      reason: "triage_observed_after_lost_ack",
    });
    assert.equal(f.writes.length, 1);
  });

  it("retains an ambiguous attempt across lease expiry and never moves an advanced issue back", async () => {
    const f = fixture();
    let attempts = 0;
    f.input.client.updateIssue = async () => {
      attempts += 1;
      f.setIssue({ stateId: "done" });
      throw new Error("lost acknowledgement after rule applied");
    };
    assert.equal((await intakeIssueCreated(f.input)).status, "ambiguous");
    f.advance();
    assert.deepEqual(await intakeIssueCreated(f.input), {
      status: "ambiguous",
      reason: "original_attempt_unconfirmed_no_repeat",
    });
    assert.equal(attempts, 1);
    assert.equal(
      (await f.input.database.findLinearTriageIntake(f.input.key))?.attemptStartedAt?.getTime(),
      0,
    );
  });

  it("persists ambiguity when even the read-back fails", async () => {
    const f = fixture();
    f.input.client.updateIssue = async () => {
      f.input.client.readIssue = async () => {
        throw new Error("offline");
      };
      throw new Error("timeout");
    };
    assert.equal((await intakeIssueCreated(f.input)).status, "ambiguous");
    assert.equal((await f.input.database.findLinearTriageIntake(f.input.key))?.status, "ambiguous");
  });

  it("lets only one concurrent worker send the mutation", async () => {
    const f = fixture();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = f.input.client.updateIssue.bind(f.input.client);
    f.input.client.updateIssue = async (input) => {
      started();
      await pending;
      await update(input);
    };
    const first = intakeIssueCreated(f.input);
    await entered;
    assert.equal((await intakeIssueCreated(f.input)).status, "pending");
    release();
    assert.equal((await first).status, "applied");
    assert.equal(f.writes.length, 1);
  });
});
