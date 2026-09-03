import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import { missingRequiredOutputs } from "../execution-capabilities/required-outputs.js";
import type { AgentExecutionRecord } from "./types.js";

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
  launchIntent: Pick<
    LaunchMachineIntent,
    "outputSchema" | "allowOutputs" | "keepAliveBetweenTurns"
  > | null;
  hubActionAcknowledgements?: Pick<
    AgentExecutionRecord["hubActionAcknowledgements"],
    "finishExecutionCall"
  >;
}): boolean {
  if (execution.launchIntent?.outputSchema !== undefined) return false;
  // A conversation counts its outputs per turn, so its counters are back to zero the moment a
  // turn ends and prove nothing about the turns before. Its acknowledged `finish_execution` does:
  // an agent that answered and then heard nothing more has finished, not timed out.
  if (execution.launchIntent?.keepAliveBetweenTurns === true) {
    return execution.hubActionAcknowledgements?.finishExecutionCall?.status === "completed";
  }
  return (
    missingRequiredOutputs(execution).length === 0 &&
    Object.values(execution.outputEmissions).some((count) => count > 0)
  );
}
