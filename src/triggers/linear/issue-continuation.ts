import type { CompiledTriggerConfig } from "../../config/index.js";
import { parseCompiledHubConfig } from "../../config/compiler.js";
import type { LaunchMachineIntent } from "../../dispatcher/launch-machine-intent.js";
import type { TriggerProviderExecutionControl } from "../../providers/registration.js";
import type { LinearOutputContext, LinearTriggerContext } from "./provider.js";

/** Only the same saved runtime and output authority may receive another issue event. */
export function canContinueIssueWork(
  intent: LaunchMachineIntent | null | undefined,
  revisionId: string,
  trigger: CompiledTriggerConfig,
): boolean {
  if (intent == null || intent.configurationRevisionId !== revisionId || trigger.steps.length !== 1)
    return false;
  const original = parseCompiledHubConfig(intent.hubConfig).triggers.find(
    (item) => item.name === intent.triggerName,
  );
  if (original?.steps.length !== 1 || original.filters?.continue_issue !== true) return false;
  if (original.maxRuntimeMs !== trigger.maxRuntimeMs) return false;
  if (
    original.filters.connectionId !== trigger.filters?.connectionId ||
    original.filters.team !== trigger.filters?.team ||
    original.filters.project !== trigger.filters?.project
  )
    return false;
  if (
    JSON.stringify(original.filters.finalize_issue) !==
    JSON.stringify(trigger.filters?.finalize_issue)
  )
    return false;
  const contract = (step: CompiledTriggerConfig["steps"][number]) =>
    JSON.stringify({
      environment: step.environment,
      agent: step.agent,
      env: step.env,
      github: step.github,
      allowOutputs: step.allowOutputs,
      output: step.output,
      autoArchive: step.autoArchive,
      maxRuntimeMs: step.maxRuntimeMs,
      idleTimeoutMs: step.idleTimeoutMs,
      prompt: step.prompt,
    });
  return contract(original.steps[0]!) === contract(trigger.steps[0]!);
}

export async function continueLinearIssue(input: {
  executions: TriggerProviderExecutionControl;
  projectId: string;
  revisionId: string;
  trigger: CompiledTriggerConfig;
  triggerContext: LinearTriggerContext;
  outputContext: LinearOutputContext;
  prompt: string;
}): Promise<boolean> {
  const target = input.outputContext;
  if (target.agentSessionId === null || target.turnKey === undefined) return false;
  const result = await input.executions.promptActive({
    projectId: input.projectId,
    inputId: target.turnKey,
    prompt: input.prompt,
    activeTurnBehavior: "steer",
    turnContext: { triggerContext: input.triggerContext, outputContext: target },
    matches: (work) => {
      const context = work.outputContext;
      const sameIssue =
        typeof context === "object" &&
        context !== null &&
        "provider" in context &&
        context.provider === "linear" &&
        "linearOrganizationId" in context &&
        context.linearOrganizationId === target.linearOrganizationId &&
        "issueId" in context &&
        context.issueId === target.issueId;
      if (sameIssue && !canContinueIssueWork(work.launchIntent, input.revisionId, input.trigger)) {
        throw new Error(
          "The issue already has an active agent with a different saved configuration; reconcile it before starting another agent",
        );
      }
      return sameIssue;
    },
  });
  if (result.live && !result.delivered) {
    throw new Error(
      "The issue agent is temporarily unreachable; its event remains pending, without starting another agent",
    );
  }
  return result.delivered;
}
