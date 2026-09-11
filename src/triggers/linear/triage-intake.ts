import { randomUUID } from "node:crypto";
import type { LinearApiClient, LinearIssueDetails } from "../../providers/linear/client.js";
import type {
  LinearTriageIntakeKey,
  LinearTriageIntakeStore,
  LinearTriageIntakeSettlement,
  LinearTriageIntakeRecord,
} from "../../db/linear-triage-intakes.js";

export type LinearTriageIntakeClient = Pick<LinearApiClient, "readIssue"> &
  Required<Pick<LinearApiClient, "readTeamWorkflowStates" | "updateIssue">>;
export interface LinearTriageIntakeResult {
  status: "applied" | "ignored" | "ambiguous" | "pending";
  reason: string;
}

export interface LinearTriageIntakeInput {
  key: LinearTriageIntakeKey;
  eventKey: string;
  providerEventReceiptId: string;
  teamId: string;
  triageStateId: string;
  sourceActorId: string | null;
  fromUsers: readonly string[];
  sourceStateId: string | null;
  sourceIssueUpdatedAt?: string;
  client: LinearTriageIntakeClient;
  database: LinearTriageIntakeStore;
  now?: () => Date;
}

/** Caller invokes only for verified Issue/create. This never assigns or delegates an issue. */
export async function intakeIssueCreated(
  input: LinearTriageIntakeInput,
): Promise<LinearTriageIntakeResult> {
  if (input.sourceActorId === null || !input.fromUsers.includes(input.sourceActorId))
    return { status: "ignored", reason: "actor_not_authorized" };
  const { key, database } = input;
  const now = input.now ?? (() => new Date());
  const timestamp = now();
  const claim = await database.claimLinearTriageIntake({
    ...key,
    providerEventReceiptId: input.providerEventReceiptId,
    source: {
      eventKey: input.eventKey,
      actorId: input.sourceActorId,
      teamId: input.teamId,
      triageStateId: input.triageStateId,
      stateId: input.sourceStateId,
      updatedAt: input.sourceIssueUpdatedAt ?? null,
    },
    leaseId: randomUUID(),
    leaseExpiresAt: new Date(timestamp.getTime() + 30_000),
    now: timestamp,
  });
  const reservation = claim.record;
  if (
    reservation.source.teamId !== input.teamId ||
    reservation.source.triageStateId !== input.triageStateId
  )
    return { status: "ignored", reason: "intake_configuration_changed" };
  if (reservation.status === "applied" || reservation.status === "ignored")
    return { status: reservation.status, reason: reservation.reason ?? reservation.status };
  if (!claim.claimed) return { status: "pending", reason: "intake_lease_busy" };
  return runReservedIntake(input, reservation, now);
}

function readIssue(input: LinearTriageIntakeInput) {
  return input.client.readIssue({
    linearOrganizationId: input.key.linearOrganizationId,
    expectedConnectionId: input.key.connectionId,
    issueId: input.key.issueId,
  });
}
function scopedIssue(
  issue: LinearIssueDetails | undefined,
  input: LinearTriageIntakeInput,
): issue is LinearIssueDetails {
  return issue !== undefined && issue.id === input.key.issueId && issue.teamId === input.teamId;
}
async function settle(
  input: LinearTriageIntakeInput,
  reservation: LinearTriageIntakeRecord,
  outcome: LinearTriageIntakeSettlement,
): Promise<LinearTriageIntakeResult> {
  const saved = await input.database.settleLinearTriageIntake(
    input.key,
    reservation.leaseId,
    outcome,
  );
  if (saved.status === "reserved" || saved.status === "attempted")
    return { status: "pending", reason: "intake_lease_changed" };
  return { status: saved.status, reason: saved.reason ?? saved.status };
}
async function initialIssueRejection(
  input: LinearTriageIntakeInput,
  reservation: LinearTriageIntakeRecord,
  issue: LinearIssueDetails,
): Promise<string | undefined> {
  const states = await input.client.readTeamWorkflowStates({
    linearOrganizationId: input.key.linearOrganizationId,
    expectedConnectionId: input.key.connectionId,
    teamId: input.teamId,
  });
  if (!states.some((state) => state.id === input.triageStateId && state.type === "triage"))
    return "configured_state_is_not_team_triage";
  if (issue.stateId === input.triageStateId) return "already_in_triage";
  const currentType = states.find((state) => state.id === issue.stateId)?.type;
  if (currentType !== "backlog" && currentType !== "unstarted") return "issue_already_advanced";
  const initialTime = Date.parse(reservation.source.updatedAt ?? "");
  const currentTime = Date.parse(issue.updatedAt ?? "");
  if (!Number.isFinite(initialTime) || !Number.isFinite(currentTime))
    return "creation_version_unavailable";
  if (issue.stateId !== reservation.source.stateId || currentTime !== initialTime)
    return "issue_changed_since_creation";
  return undefined;
}
async function runReservedIntake(
  input: LinearTriageIntakeInput,
  reservation: LinearTriageIntakeRecord,
  now: () => Date,
): Promise<LinearTriageIntakeResult> {
  const issue = await readIssue(input);
  if (reservation.attemptStartedAt !== null) {
    if (scopedIssue(issue, input) && issue.stateId === input.triageStateId)
      return settle(input, reservation, {
        status: "applied",
        reason: "triage_observed_after_attempt",
      });
    return settle(input, reservation, {
      status: "ambiguous",
      reason: "original_attempt_unconfirmed_no_repeat",
    });
  }
  if (!scopedIssue(issue, input))
    return settle(input, reservation, {
      status: "ignored",
      reason: "issue_outside_configured_team",
    });
  const rejection = await initialIssueRejection(input, reservation, issue);
  if (rejection !== undefined)
    return settle(input, reservation, { status: "ignored", reason: rejection });
  // There is no provider CAS. Recheck after paginated team reads to minimize the remaining race.
  const latest = await readIssue(input);
  if (
    !scopedIssue(latest, input) ||
    latest.stateId !== issue.stateId ||
    latest.updatedAt !== issue.updatedAt
  )
    return settle(input, reservation, { status: "ignored", reason: "issue_changed_before_intake" });
  if (!(await input.database.startLinearTriageIntake(input.key, reservation.leaseId, now())))
    return { status: "pending", reason: "intake_lease_changed" };
  return applyAndReconcile(input, reservation);
}
async function applyAndReconcile(
  input: LinearTriageIntakeInput,
  reservation: LinearTriageIntakeRecord,
): Promise<LinearTriageIntakeResult> {
  try {
    await input.client.updateIssue({
      linearOrganizationId: input.key.linearOrganizationId,
      expectedConnectionId: input.key.connectionId,
      issueId: input.key.issueId,
      stateId: input.triageStateId,
    });
    return settle(input, reservation, { status: "applied", reason: "linear_acknowledged_intake" });
  } catch {
    try {
      const observed = await readIssue(input);
      if (scopedIssue(observed, input) && observed.stateId === input.triageStateId)
        return settle(input, reservation, {
          status: "applied",
          reason: "triage_observed_after_lost_ack",
        });
    } catch {
      // Persist the ambiguous remote outcome below, including a failed read-back.
    }
    return settle(input, reservation, {
      status: "ambiguous",
      reason: "original_attempt_unconfirmed_no_repeat",
    });
  }
}
