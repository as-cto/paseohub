import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import {
  currentTurnOutputEmissions,
  isCurrentTurnAttempt,
  missingRequiredOutputs,
} from "../execution-capabilities/required-outputs.js";
import type { AgentExecutionRecord, WorkflowAgentCompletionInput } from "./types.js";

/**
 * An execution that already delivered an output and then went quiet has done
 * its job; it merely skipped `finish_execution`. Its idle deadline therefore
 * ends a successful execution rather than a failed one, so a correct reply is
 * never followed by an idle-timeout error.
 *
 * The bar is the one `finish_execution` applies: every `required` output must
 * have been emitted (and at least one output when none is required).
 * Executions that owe a structured output are excluded: their success is the
 * validated output itself, which only `finish_execution` can deliver.
 */
export function completesAtIdleDeadline(execution: {
  outputEmissions: AgentExecutionRecord["outputEmissions"];
  outputDeliveryAttempts?: AgentExecutionRecord["outputDeliveryAttempts"];
  launchIntent: Pick<
    LaunchMachineIntent,
    "outputSchema" | "allowOutputs" | "keepAliveBetweenTurns"
  > | null;
  hubActionAcknowledgements?: Pick<
    AgentExecutionRecord["hubActionAcknowledgements"],
    "finishExecutionCall" | "turn"
  >;
}): boolean {
  if (execution.launchIntent?.outputSchema !== undefined) return false;
  // Completion belongs to the current input. A previous answer or a delayed finish event
  // cannot turn a later unanswered request into a successful conversation.
  if (execution.launchIntent?.keepAliveBetweenTurns === true) {
    return (
      missingRequiredOutputs(execution).length === 0 &&
      Object.values(currentTurnOutputEmissions(execution)).some((count) => count > 0) &&
      execution.hubActionAcknowledgements?.finishExecutionCall?.status === "completed"
    );
  }
  return (
    missingRequiredOutputs(execution).length === 0 &&
    Object.values(execution.outputEmissions).some((count) => count > 0)
  );
}

/** A completed conversation can yield to queued work before its optional keep-alive expires. */
export function hasCompletedIdleConversationTurn(execution: AgentExecutionRecord): boolean {
  const { terminalAt, idleAt, finishExecutionCall, turn, inputDeliveries } =
    execution.hubActionAcknowledgements;
  if (
    execution.status !== "running" ||
    execution.launchIntent?.keepAliveBetweenTurns !== true ||
    execution.hubAction !== null ||
    execution.idleDeadlineAt === null ||
    !completesAtIdleDeadline(execution) ||
    terminalAt === null ||
    idleAt === null ||
    finishExecutionCall?.status !== "completed"
  )
    return false;
  const startedAt = turn?.startedAt ?? execution.startedAt;
  if (
    finishExecutionCall.observedAt < startedAt ||
    terminalAt < finishExecutionCall.observedAt ||
    idleAt < finishExecutionCall.observedAt
  )
    return false;
  return (
    !Object.values(inputDeliveries ?? {}).includes("pending") &&
    !Object.values(execution.outputDeliveryAttempts).some(
      (attempt) => isCurrentTurnAttempt(execution, attempt) && attempt.status === "pending",
    )
  );
}

export function matchesIdleTurnCompletionCondition(
  execution: AgentExecutionRecord,
  condition: WorkflowAgentCompletionInput["idleTurnCondition"],
): boolean {
  return (
    condition === undefined ||
    (execution.workflowStepRunId !== null &&
      (execution.hubActionAcknowledgements.turn?.id ?? null) === condition.turnId &&
      hasCompletedIdleConversationTurn(execution))
  );
}
