import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../../db/types.js";
import { linearReplyTurnKey } from "../../db/linear-replies.js";
import { authorizedLinearReplyConnection } from "./reply-authority.js";

const HandoffContextSchema = z.object({
  provider: z.literal("linear"),
  publishIssueComment: z.literal(true),
  linearOrganizationId: z.string().min(1),
  issueId: z.string().min(1),
  agentSessionId: z.string().min(1),
});

/** Caller holds execution.prompt. Reserve only; the reporting worker performs all external I/O. */
export async function reserveLinearNativeHandoff(
  database: Database,
  executionId: string,
  nextOutputContext: unknown,
  now: Date,
): Promise<void> {
  const execution = await database.findAgentExecutionById(executionId);
  if (execution === undefined) return;
  const previous = HandoffContextSchema.safeParse(execution.outputContext);
  const next = HandoffContextSchema.safeParse(nextOutputContext);
  if (
    !previous.success ||
    !next.success ||
    previous.data.agentSessionId === next.data.agentSessionId ||
    previous.data.linearOrganizationId !== next.data.linearOrganizationId ||
    previous.data.issueId !== next.data.issueId
  )
    return;
  const turnKey = linearReplyTurnKey(execution.hubActionAcknowledgements.turn?.id);
  if ((await database.findLinearReply(execution.id, turnKey)) !== undefined) return;
  const authorizedConnectionId = authorizedLinearReplyConnection(
    execution.triggerContext,
    previous.data,
  );
  const connection = await database.findLinearConnectionForOrganization(
    execution.organizationId,
    previous.data.linearOrganizationId,
  );
  if (connection === undefined || connection.id !== authorizedConnectionId)
    throw new Error("The previous Linear session connection is unavailable");
  const attempt = await database.beginAgentExecutionOutput(
    execution.id,
    "linear.reply",
    undefined,
    now,
  );
  if (attempt === undefined)
    throw new Error("The previous Linear session could not reserve its handoff notice");
  const body =
    "A newer input has been routed to another session on this issue. This session is being superseded. " +
    "This notice does not confirm that the work is complete or verified. Follow the latest session for the next work summary or delivery status.";
  await database.reserveLinearReply({
    id: randomUUID(),
    executionId,
    turnKey,
    attemptId: attempt.id,
    createdAt: now,
    payload: {
      organizationId: execution.organizationId,
      projectId: execution.projectId,
      connectionId: connection.id,
      applicationId: connection.providerApplicationId,
      linearOrganizationId: previous.data.linearOrganizationId,
      issueId: previous.data.issueId,
      agentSessionId: previous.data.agentSessionId,
      commentId: randomUUID(),
      activityId: randomUUID(),
      body,
      activity: { content: { type: "response", body } },
    },
  });
}
