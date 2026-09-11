import { z } from "zod";

const LinearReplyAuthoritySchema = z.object({
  provider: z.literal("linear"),
  event: z.object({
    linear: z.object({
      connection_id: z.string().min(1),
      organization: z.object({ id: z.string().min(1) }),
      issue: z.object({ id: z.string().min(1) }),
    }),
  }),
});

/** The signed event's bound connection authorizes a reply; the current installation does not. */
export function authorizedLinearReplyConnection(
  triggerContext: unknown,
  target: { linearOrganizationId: string; issueId: string },
): string {
  const connectionId = matchingLinearReplyConnection(triggerContext, target);
  if (connectionId === undefined)
    throw new Error("The Linear reply target has no matching authorized event connection");
  return connectionId;
}

export function matchingLinearReplyConnection(
  triggerContext: unknown,
  target: { linearOrganizationId: string; issueId: string },
): string | undefined {
  const parsed = LinearReplyAuthoritySchema.safeParse(triggerContext);
  if (
    !parsed.success ||
    parsed.data.event.linear.organization.id !== target.linearOrganizationId ||
    parsed.data.event.linear.issue.id !== target.issueId
  )
    return undefined;
  return parsed.data.event.linear.connection_id;
}
