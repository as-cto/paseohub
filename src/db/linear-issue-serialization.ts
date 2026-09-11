import { z } from "zod";
import { hasCompletedIdleConversationTurn } from "./idle-completion.js";
import { currentTurnOutputEmissions } from "../execution-capabilities/required-outputs.js";
import type { Database, WorkflowDeadlineRecovery } from "./types.js";

const ContextSchema = z.object({
  provider: z.literal("linear"),
  event: z.object({
    linear: z.object({
      connection_id: z.string().min(1),
      organization: z.object({ id: z.string().min(1) }),
      issue: z.object({ id: z.string().min(1) }),
    }),
  }),
});

/** A work item spans sessions and comment threads, but never projects or connections. */
export function linearIssueExecutionKey(
  projectId: string,
  triggerContext: unknown,
): string | undefined {
  const parsed = ContextSchema.safeParse(triggerContext);
  if (!parsed.success) return undefined;
  const linear = parsed.data.event.linear;
  return JSON.stringify([
    "linear.issue.execution",
    projectId,
    linear.connection_id,
    linear.organization.id,
    linear.issue.id,
  ]);
}

/** A terminal database row can still own a live agent until its stop/archive is acknowledged. */
export function executionStillOwnsWork(execution: {
  status: string;
  hubAction: string | null;
  hubActionCompletedAt: Date | null;
}): boolean {
  return (
    execution.status === "spawning" ||
    execution.status === "running" ||
    (execution.hubAction !== null && execution.hubActionCompletedAt === null)
  );
}

export const ISSUE_EXECUTION_RETRY_MS = 1_000;

const NativeOutputSchema = z.object({
  provider: z.literal("linear"),
  agentSessionId: z.string().min(1),
});

/**
 * A final answer may leave a daemon alive for optional follow-ups. A different native session
 * on the same issue need not wait out that grace period. Retire only its fully acknowledged
 * idle turn; the issue lock continues to exclude the next execution until the stop RPC is ACKed.
 */
export async function retireCompletedLinearIssueExecutions(
  database: Pick<
    Database,
    | "findPendingAgentExecutions"
    | "findAgentExecutionById"
    | "findWorkflowStepRunById"
    | "completeWorkflowAgentExecution"
    | "withAdvisoryLock"
  >,
  waiting: {
    id: string;
    projectId: string;
    triggerContext: unknown;
    outputContext: unknown;
  },
  observedAt: Date,
): Promise<WorkflowDeadlineRecovery[]> {
  const issueKey = linearIssueExecutionKey(waiting.projectId, waiting.triggerContext);
  const output = NativeOutputSchema.safeParse(waiting.outputContext);
  if (issueKey === undefined || !output.success) return [];
  const recoveries: WorkflowDeadlineRecovery[] = [];
  for (const candidate of await database.findPendingAgentExecutions()) {
    const candidateOutput = NativeOutputSchema.safeParse(candidate.outputContext);
    if (
      !candidateOutput.success ||
      candidateOutput.data.agentSessionId === output.data.agentSessionId ||
      linearIssueExecutionKey(candidate.projectId, candidate.triggerContext) !== issueKey ||
      !hasCompletedIdleConversationTurn(candidate)
    )
      continue;
    const recovery = await database.withAdvisoryLock(
      `execution.prompt:${candidate.id}`,
      async () => {
        const current = await database.findAgentExecutionById(candidate.id);
        if (
          current === undefined ||
          current.workflowStepRunId === null ||
          (current.deadlineAt !== null && current.deadlineAt <= observedAt) ||
          (current.idleDeadlineAt !== null && current.idleDeadlineAt <= observedAt) ||
          !hasCompletedIdleConversationTurn(current) ||
          (currentTurnOutputEmissions(current)["linear.reply"] ?? 0) < 1
        )
          return undefined;
        const step = await database.findWorkflowStepRunById(current.workflowStepRunId);
        if (step === undefined || step.triggerRunId === waiting.id) return undefined;
        const result = await database.completeWorkflowAgentExecution({
          executionId: current.id,
          executionStatus: "succeeded",
          stepStatus: "succeeded",
          result: { status: "succeeded" },
          completedByAgent: true,
          observedAt,
          idleTurnCondition: { turnId: current.hubActionAcknowledgements.turn?.id ?? null },
          hubAction: current.daemonId === null ? null : "interrupt",
        });
        return result.transitioned
          ? {
              triggerRunId: step.triggerRunId,
              executionIds: [],
              completedExecutionIds: [current.id],
            }
          : undefined;
      },
    );
    if (recovery !== undefined) recoveries.push(recovery);
  }
  return recoveries;
}
