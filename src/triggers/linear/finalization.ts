import { z } from "zod";
import type { Database } from "../../db/types.js";
import type {
  LinearIssueFinalization,
  LinearIssueFinalizationPolicy,
} from "../../db/linear-finalizations.js";
import { linearReplyTurnKey, type LinearReplyDelivery } from "../../db/linear-replies.js";
import type { LinearApiClient, LinearIssueDetails } from "../../providers/linear/client.js";

export const LinearIssueFinalizationContextSchema = z
  .object({
    teamId: z.string().min(1),
    reviewStateId: z.string().min(1),
    completedStateId: z.string().min(1),
    waitingStateId: z.string().min(1).optional(),
    allowedAssigneeIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  })
  .strict()
  .transform(
    (value): LinearIssueFinalizationPolicy => ({
      teamId: value.teamId,
      reviewStateId: value.reviewStateId,
      completedStateId: value.completedStateId,
      ...(value.waitingStateId === undefined ? {} : { waitingStateId: value.waitingStateId }),
      ...(value.allowedAssigneeIds === undefined
        ? {}
        : { allowedAssigneeIds: value.allowedAssigneeIds }),
    }),
  );

export class LinearFinalizationRefused extends Error {}

/** One attempted metadata mutation at most. A lost ACK is reconciled, never blindly replayed. */
export async function finalizeLinearIssue(options: {
  database: Database;
  client: LinearApiClient;
  reply: LinearReplyDelivery;
  now: () => Date;
}): Promise<void> {
  const { database, client, reply, now } = options;
  const policy = reply.payload.finalizeIssue;
  if (policy === undefined) return;
  await database.withAdvisoryLock(`execution.prompt:${reply.executionId}`, async () => {
    await database.withAdvisoryLock(
      `linear.issue.finalize:${reply.payload.linearOrganizationId}:${reply.payload.issueId}`,
      async () => {
        let action = await database.findLinearFinalization(reply.id);
        if (action !== undefined && action.status !== "pending") {
          assertResolved(action);
          return;
        }
        const issue = await client.readIssue({
          linearOrganizationId: reply.payload.linearOrganizationId,
          expectedConnectionId: reply.payload.connectionId,
          issueId: reply.payload.issueId,
        });
        if (issue === undefined || issue.id !== reply.payload.issueId)
          throw new Error("Linear finalization issue is unavailable");
        if (action === undefined) {
          const decision = await prepareFinalization(options, issue, policy);
          action = await database.reserveLinearFinalization({
            replyId: reply.id,
            target: decision.target,
            previous: { stateId: issue.stateId, assigneeId: issue.assigneeId },
            createdAt: now(),
          });
          if (decision.status !== "pending") {
            await database.completeLinearFinalization(
              reply.id,
              decision.status,
              decision.detail,
              now(),
            );
            if (decision.status === "refused") throw new LinearFinalizationRefused(decision.detail);
            return;
          }
        }
        await applyFinalization(options, action, policy);
      },
    );
  });
}

interface FinalizationDecision {
  target: LinearIssueFinalization["target"];
  status: "pending" | "skipped" | "refused";
  detail: string;
}
async function prepareFinalization(
  options: Parameters<typeof finalizeLinearIssue>[0],
  issue: LinearIssueDetails,
  policy: LinearIssueFinalizationPolicy,
): Promise<FinalizationDecision> {
  const { database, client, reply } = options;
  const unchanged = (status: "skipped" | "refused", detail: string): FinalizationDecision => ({
    status,
    detail,
    target: {},
  });
  if (isClosed(issue)) return unchanged("skipped", "The human-closed issue was preserved");
  const execution = await database.findAgentExecutionById(reply.executionId);
  if (
    execution === undefined ||
    linearReplyTurnKey(execution.hubActionAcknowledgements.turn?.id) !== reply.turnKey
  )
    return unchanged("skipped", "A newer input superseded this issue finalization");
  const connection = await database.findLinearConnectionForOrganization(
    reply.payload.organizationId,
    reply.payload.linearOrganizationId,
  );
  if (
    connection?.id !== reply.payload.connectionId ||
    issue.teamId !== policy.teamId ||
    issue.delegateId !== connection.appUserId
  )
    return unchanged(
      "refused",
      "Finalization requires the configured team, connection and current agent delegation",
    );
  const outcome = reply.payload.outcome;
  if (outcome === undefined)
    return unchanged("refused", "Issue finalization requires a structured outcome");
  if (outcome.kind === "no_action")
    return unchanged("skipped", "The reported outcome requires no issue change");
  if (
    client.readTeamWorkflowStates === undefined ||
    client.readTeamMembers === undefined ||
    client.updateIssue === undefined
  )
    return unchanged("refused", "The Linear adapter does not support verified issue finalization");
  if (
    issue.stateType === undefined ||
    !["backlog", "unstarted", "started", "triage", "completed", "canceled"].includes(
      issue.stateType,
    )
  )
    return unchanged("refused", "The current issue workflow state could not be verified");
  return prepareTarget(client, reply, policy, outcome);
}

async function prepareTarget(
  client: LinearApiClient,
  reply: LinearReplyDelivery,
  policy: LinearIssueFinalizationPolicy,
  outcome: NonNullable<LinearReplyDelivery["payload"]["outcome"]>,
): Promise<FinalizationDecision> {
  const unchanged = (status: "skipped" | "refused", detail: string): FinalizationDecision => ({
    status,
    detail,
    target: {},
  });
  const stateId = targetState(policy, outcome.kind);
  if (stateId !== undefined) {
    const states = await client.readTeamWorkflowStates!({
      linearOrganizationId: reply.payload.linearOrganizationId,
      expectedConnectionId: reply.payload.connectionId,
      teamId: policy.teamId,
    });
    const state = states.find((entry) => entry.id === stateId);
    const expectCompleted = outcome.kind === "completed";
    if (
      state === undefined ||
      (expectCompleted
        ? state.type !== "completed"
        : !["triage", "backlog", "unstarted", "started"].includes(state.type))
    )
      return unchanged(
        "refused",
        "The configured target state has the wrong team or workflow type",
      );
  }
  const target: LinearIssueFinalization["target"] = stateId === undefined ? {} : { stateId };
  if (outcome.assigneeId !== undefined) {
    if (!(policy.allowedAssigneeIds ?? []).includes(outcome.assigneeId))
      return unchanged("refused", "The requested assignee is not explicitly allowed");
    const members = await client.readTeamMembers!({
      linearOrganizationId: reply.payload.linearOrganizationId,
      expectedConnectionId: reply.payload.connectionId,
      teamId: policy.teamId,
    });
    if (!members.some((member) => member.id === outcome.assigneeId && member.active && !member.app))
      return unchanged(
        "refused",
        "The requested assignee is not an active human in the configured team",
      );
    target.assigneeId = outcome.assigneeId;
  }
  // Without an explicit person, keep the current owner. Permission lists are not priority lists.
  return {
    status: Object.keys(target).length === 0 ? "skipped" : "pending",
    detail: "Preserve the current human owner unless a verified assignee was explicitly requested",
    target,
  };
}

async function applyFinalization(
  options: Parameters<typeof finalizeLinearIssue>[0],
  action: LinearIssueFinalization,
  policy: LinearIssueFinalizationPolicy,
): Promise<void> {
  const { database, client, reply, now } = options;
  const issue = await client.readIssue({
    linearOrganizationId: reply.payload.linearOrganizationId,
    expectedConnectionId: reply.payload.connectionId,
    issueId: reply.payload.issueId,
  });
  if (issue === undefined || issue.id !== reply.payload.issueId)
    throw new Error("Linear finalization issue is unavailable");
  const finish = async (
    status: Exclude<LinearIssueFinalization["status"], "pending">,
    detail: string,
  ) => {
    await database.completeLinearFinalization(reply.id, status, detail, now());
    if (status === "ambiguous" || status === "refused") throw new LinearFinalizationRefused(detail);
  };
  if (matchesTarget(issue, action.target)) {
    await finish("applied", "The requested issue state and assignee are confirmed");
    return;
  }
  if (isClosed(issue)) {
    await finish("skipped", "The closed issue was preserved");
    return;
  }
  if (action.startedAt !== null) {
    await finish(
      "ambiguous",
      "The earlier update is unconfirmed or the issue changed afterwards; no mutation was replayed",
    );
    return;
  }
  if (!(await hasUnchangedAuthority(options, issue, action, policy))) {
    await finish(
      "skipped",
      "The issue or active input changed before finalization; it was left unchanged",
    );
    return;
  }
  if (client.updateIssue === undefined)
    throw new Error("The Linear adapter does not support issue updates");
  if (!(await database.startLinearFinalization(reply.id, now())))
    throw new Error("Linear issue finalization is already being attempted");
  try {
    await client.updateIssue({
      linearOrganizationId: reply.payload.linearOrganizationId,
      expectedConnectionId: reply.payload.connectionId,
      issueId: reply.payload.issueId,
      ...action.target,
    });
  } catch (error) {
    // Even a provider error can mean the mutation committed before its response was lost.
    const observed = await client.readIssue({
      linearOrganizationId: reply.payload.linearOrganizationId,
      expectedConnectionId: reply.payload.connectionId,
      issueId: reply.payload.issueId,
    });
    if (observed !== undefined && matchesTarget(observed, action.target)) {
      await finish("applied", "The issue update was verified after its acknowledgement was lost");
      return;
    }
    await database.completeLinearFinalization(
      reply.id,
      "ambiguous",
      "The attempted issue update was not confirmed; review it before any retry",
      now(),
    );
    throw new LinearFinalizationRefused(
      "The attempted issue update was not confirmed; no automatic mutation retry is permitted",
      { cause: error },
    );
  }
  const observed = await client.readIssue({
    linearOrganizationId: reply.payload.linearOrganizationId,
    expectedConnectionId: reply.payload.connectionId,
    issueId: reply.payload.issueId,
  });
  if (observed !== undefined && matchesTarget(observed, action.target)) {
    await finish("applied", "The requested issue state and assignee were verified");
    return;
  }
  await finish(
    "ambiguous",
    "The issue differs from the attempted update; no automatic mutation retry is permitted",
  );
}

async function hasUnchangedAuthority(
  options: Parameters<typeof finalizeLinearIssue>[0],
  issue: LinearIssueDetails,
  action: LinearIssueFinalization,
  policy: LinearIssueFinalizationPolicy,
): Promise<boolean> {
  const { database, reply } = options;
  const execution = await database.findAgentExecutionById(reply.executionId);
  const connection = await database.findLinearConnectionForOrganization(
    reply.payload.organizationId,
    reply.payload.linearOrganizationId,
  );
  return (
    execution !== undefined &&
    linearReplyTurnKey(execution.hubActionAcknowledgements.turn?.id) === reply.turnKey &&
    issue.teamId === policy.teamId &&
    issue.delegateId === connection?.appUserId &&
    connection?.id === reply.payload.connectionId &&
    issue.stateId === action.previous.stateId &&
    issue.assigneeId === action.previous.assigneeId
  );
}

function targetState(
  policy: LinearIssueFinalizationPolicy,
  kind: NonNullable<LinearReplyDelivery["payload"]["outcome"]>["kind"],
): string | undefined {
  if (kind === "completed") return policy.completedStateId;
  if (kind === "ready_for_review") return policy.reviewStateId;
  return policy.waitingStateId;
}
function isClosed(issue: LinearIssueDetails): boolean {
  return (
    issue.stateType === "completed" ||
    issue.stateType === "canceled" ||
    issue.stateType === "duplicate"
  );
}
function matchesTarget(
  issue: LinearIssueDetails,
  target: LinearIssueFinalization["target"],
): boolean {
  return (
    (target.stateId === undefined || issue.stateId === target.stateId) &&
    (target.assigneeId === undefined || issue.assigneeId === target.assigneeId)
  );
}
function assertResolved(action: LinearIssueFinalization): void {
  if (action.status !== "applied" && action.status !== "skipped")
    throw new LinearFinalizationRefused(action.detail ?? "Linear issue finalization is unresolved");
}
