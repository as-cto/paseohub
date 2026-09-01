import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { AgentExecutionRecord } from "./types.js";

/**
 * An execution that already delivered an output and then went quiet has done
 * its job; it merely skipped `finish_execution`. Its idle deadline therefore
 * ends a successful execution rather than a failed one, so a correct reply is
 * never followed by an idle-timeout error.
 *
 * Executions that owe a structured output are excluded: their success is the
 * validated output itself, which only `finish_execution` can deliver.
 */
export function completesAtIdleDeadline(execution: {
  outputEmissions: AgentExecutionRecord["outputEmissions"];
  launchIntent: Pick<LaunchMachineIntent, "outputSchema"> | null;
}): boolean {
  return (
    execution.launchIntent?.outputSchema === undefined &&
    Object.values(execution.outputEmissions).some((count) => count > 0)
  );
}
