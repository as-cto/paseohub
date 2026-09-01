import type { AgentExecutionRecord } from "../db/types.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { AllowedOutput } from "./outputs.js";

export interface OutputEmissionState {
  outputEmissions: AgentExecutionRecord["outputEmissions"];
  launchIntent: Pick<LaunchMachineIntent, "allowOutputs"> | null;
}

/**
 * The `required: true` outputs the execution has not emitted yet. This is the
 * single definition of "the execution still owes an output": `finish_execution`
 * refuses while it is non-empty, and the idle deadline must not complete an
 * execution that `finish_execution` would have refused.
 */
export function missingRequiredOutputs(execution: OutputEmissionState): readonly AllowedOutput[] {
  return (execution.launchIntent?.allowOutputs ?? [])
    .filter((output) => output.required === true)
    .filter((output) => (execution.outputEmissions[output.type] ?? 0) < 1);
}
