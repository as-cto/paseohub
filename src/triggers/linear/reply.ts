import { z } from "zod";
import type { OutputExecutor, OutputToolDefinition } from "../../execution-capabilities/outputs.js";
import type { LinearApiClient } from "../../providers/linear/client.js";

const LinearReplyArgsSchema = z.object({
  content: z.string().min(1),
  kind: z.enum(["response", "question"]).default("response"),
  options: z.array(z.string().min(1)).optional(),
});
const LinearReplyOutputContextSchema = z.object({
  provider: z.literal("linear"),
  linearOrganizationId: z.string().min(1),
  issueId: z.string().min(1),
  agentSessionId: z.string().min(1).nullable(),
});

/**
 * The shared reply tool only carries `content`; Linear agent sessions additionally distinguish a
 * final answer (`response`, closes the session) from a question (`elicitation`, leaves the session
 * awaiting input), optionally with a fixed list of choices.
 */
export const linearReplyOutputTool: OutputToolDefinition = {
  name: "reply",
  description:
    "Sends a reply to the conversation that triggered this execution. " +
    'Use kind "question" when you need an answer from the user before continuing: the session ' +
    "waits for their reply instead of completing. Provide options to offer fixed choices.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", minLength: 1 },
      kind: { type: "string", enum: ["response", "question"] },
      options: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
      },
    },
    required: ["content"],
    additionalProperties: false,
  },
};

/** Replies through the native agent session when present, otherwise through an issue comment. */
export function createLinearReplyExecutor(options: { client: LinearApiClient }): OutputExecutor {
  return async function executeLinearReply(input) {
    const args = LinearReplyArgsSchema.parse(input.args);
    const context = LinearReplyOutputContextSchema.parse(input.outputContext);
    if (context.agentSessionId !== null) {
      const choices = args.kind === "question" ? (args.options ?? []) : [];
      await options.client.createAgentActivity({
        linearOrganizationId: context.linearOrganizationId,
        agentSessionId: context.agentSessionId,
        content: {
          type: args.kind === "question" ? "elicitation" : "response",
          body: args.content,
        },
        ...(choices.length === 0
          ? {}
          : {
              signal: "select",
              signalMetadata: {
                options: choices.map((choice) => ({
                  label: choice,
                  value: choice,
                })),
              },
            }),
      });
      return;
    }
    await options.client.createComment({
      linearOrganizationId: context.linearOrganizationId,
      issueId: context.issueId,
      body: commentBody(args),
    });
  };
}

/** Issue comments have no elicitation: a question with choices lists them in Markdown instead. */
function commentBody(args: z.infer<typeof LinearReplyArgsSchema>): string {
  const choices = args.kind === "question" ? (args.options ?? []) : [];
  return choices.length === 0
    ? args.content
    : `${args.content}\n\n${choices.map((choice) => `- ${choice}`).join("\n")}`;
}
