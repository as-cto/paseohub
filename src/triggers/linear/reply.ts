import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { LinearApiClient } from "../../providers/linear/client.js";

/**
 * Output type of the Linear reply tool. Shared by the provider registration
 * (which registers the output) and the trigger provider (which reads the
 * emission count to decide whether a session still needs an explicit close).
 */
export const LINEAR_REPLY_OUTPUT_TYPE = "linear.reply";

const LinearReplyArgsSchema = z.object({ content: z.string().min(1) });
const LinearReplyOutputContextSchema = z.object({
  provider: z.literal("linear"),
  linearOrganizationId: z.string().min(1),
  issueId: z.string().min(1),
  agentSessionId: z.string().min(1).nullable(),
});

/** Replies through the native agent session when present, otherwise through an issue comment. */
export function createLinearReplyExecutor(options: { client: LinearApiClient }): OutputExecutor {
  return async function executeLinearReply(input) {
    const args = LinearReplyArgsSchema.parse(input.args);
    const context = LinearReplyOutputContextSchema.parse(input.outputContext);
    if (context.agentSessionId !== null) {
      await options.client.createAgentActivity({
        linearOrganizationId: context.linearOrganizationId,
        agentSessionId: context.agentSessionId,
        content: { type: "response", body: args.content },
      });
      return;
    }
    await options.client.createComment({
      linearOrganizationId: context.linearOrganizationId,
      issueId: context.issueId,
      body: args.content,
    });
  };
}
