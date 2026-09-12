import { z } from "zod";
import type {
  OutputExecutor,
  OutputToolDefinition,
  OutputExecutionInput,
} from "../../execution-capabilities/outputs.js";
import type { LinearApiClient } from "../../providers/linear/client.js";
import type { Database } from "../../db/types.js";
import { createLinearReplyReporter, type LinearReplyReporter } from "./reporting.js";
import type { LinearReplyPayload, LinearFinalOutcome } from "../../db/linear-replies.js";
import { LinearIssueFinalizationContextSchema } from "./finalization.js";
import { attachLinearReplyLinks } from "./reply-links.js";

/**
 * Output type of the Linear reply tool. Shared by the provider registration
 * (which registers the output) and the trigger provider (which reads the
 * emission count to decide whether a session still needs an explicit close).
 */
export const LINEAR_REPLY_OUTPUT_TYPE = "linear.reply";
// These nonterminal outputs must never satisfy a required `linear.reply`.
export const LINEAR_PROGRESS_OUTPUT_TYPE = "linear.progress";
export const LINEAR_PLAN_OUTPUT_TYPE = "linear.plan";

const LinearChoiceSchema = z.union([
  z.string().min(1),
  z.object({ label: z.string().min(1), value: z.string().min(1) }),
]);
const LinearAuthSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    }, "Authentication requires an HTTPS URL without embedded credentials"),
  userId: z.string().min(1).optional(),
  providerName: z.string().min(1).optional(),
});

const LinearReplyArgsSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .refine((content) => content.trim().length > 0, "A final reply cannot be blank"),
    kind: z.enum(["response", "question", "auth", "error"]).default("response"),
    options: z.array(LinearChoiceSchema).min(1).optional(),
    auth: LinearAuthSchema.optional(),
    outcome: z
      .object({
        kind: z.enum([
          "ready_for_review",
          "completed",
          "needs_input",
          "blocked",
          "interrupted",
          "no_action",
        ]),
        validation: z.string().trim().min(1),
        nextAction: z.string().trim().min(1),
        assigneeId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .superRefine((args, ctx) => {
    if (args.kind === "auth" && args.auth === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["auth"],
        message: "An auth reply requires a Connect Link",
      });
    }
    if (args.kind !== "auth" && args.auth !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["auth"],
        message: "Authentication metadata requires kind auth",
      });
    }
    if (args.kind === "auth" && args.options !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "An auth reply cannot also offer choices",
      });
    }
  });
const LinearProgressArgsSchema = z.object({ content: z.string().min(1) });
const LinearPlanArgsSchema = z.object({
  steps: z.array(
    z.object({
      content: z.string().min(1),
      status: z.enum(["pending", "inProgress", "completed", "canceled"]),
    }),
  ),
});
const LinearReplyOutputContextSchema = z.object({
  provider: z.literal("linear"),
  linearOrganizationId: z.string().min(1),
  issueId: z.string().min(1),
  agentSessionId: z.string().min(1).nullable(),
  // Optional: executions recorded before threading existed carry no root comment.
  threadRootCommentId: z.string().min(1).nullable().optional(),
  publishIssueComment: z.boolean().optional(),
  finalizeIssue: LinearIssueFinalizationContextSchema.optional(),
});

/**
 * The shared reply tool only carries `content`; Linear agent sessions additionally distinguish a
 * final answer (`response`, closes the session) from a question (`elicitation`, leaves the session
 * awaiting input), optionally with a fixed list of choices.
 *
 * The elicitation body does not repeat the choices: they travel in `signalMetadata`, which the
 * session history reread on the next execution does not retain (only `body` is kept). The
 * question text should therefore stand on its own once the user's answer comes back.
 */
export const linearReplyOutputTool: OutputToolDefinition = {
  name: "reply",
  description:
    "Sends a reply to the conversation that triggered this execution. " +
    'Use kind "question" when you need an answer before continuing: post the question, then call ' +
    "finish_execution. The user's answer arrives as a later input; do not wait for it here. " +
    "Provide options to offer fixed choices (the user may still answer freely). " +
    'Use kind "auth" with auth.url from the connection provider when account linking is needed, ' +
    'or kind "error" to report a failure. Use the separate progress tool for work in progress; ' +
    "a response completes the session. Include outcome to record the result, validation and next action. " +
    "Issue status and assignee updates require an explicitly configured finalization policy.",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", minLength: 1 },
      outcome: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "ready_for_review",
              "completed",
              "needs_input",
              "blocked",
              "interrupted",
              "no_action",
            ],
          },
          validation: { type: "string", minLength: 1 },
          nextAction: { type: "string", minLength: 1 },
          assigneeId: { type: "string", minLength: 1 },
        },
        required: ["kind", "validation", "nextAction"],
        additionalProperties: false,
      },
      kind: { type: "string", enum: ["response", "question", "auth", "error"] },
      options: {
        type: "array",
        items: {
          anyOf: [
            { type: "string", minLength: 1 },
            {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1 },
                value: { type: "string", minLength: 1 },
              },
              required: ["label", "value"],
              additionalProperties: false,
            },
          ],
        },
        minItems: 1,
      },
      auth: {
        type: "object",
        properties: {
          url: { type: "string", pattern: "^https://", minLength: 9 },
          userId: { type: "string", minLength: 1 },
          providerName: { type: "string", minLength: 1 },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    required: ["content"],
    additionalProperties: false,
    // Keep shared fields on one object: tool signature generators can otherwise
    // render only the anyOf branches and hide content/outcome from the agent.
    if: { properties: { kind: { const: "auth" } }, required: ["kind"] },
    // eslint-disable-next-line unicorn/no-thenable -- JSON Schema keyword, not a Promise method.
    then: {
      properties: { auth: {} },
      required: ["auth"],
      not: { properties: { options: {} }, required: ["options"] },
    },
    else: { not: { properties: { auth: {} }, required: ["auth"] } },
  },
};

export const linearProgressOutputTool: OutputToolDefinition = {
  name: "progress",
  description:
    "Posts a brief progress update to the native Linear session without completing it. " +
    "This does not satisfy the required final reply. Do not send progress while waiting for a user answer or authentication.",
  inputSchema: {
    type: "object",
    properties: { content: { type: "string", minLength: 1 } },
    required: ["content"],
    additionalProperties: false,
  },
};

export const linearPlanOutputTool: OutputToolDefinition = {
  name: "plan",
  description:
    "Replaces the native Linear session checklist with the complete list of steps. " +
    "Update step statuses as work advances. This does not complete the session or satisfy the required reply.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["pending", "inProgress", "completed", "canceled"] },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
};

export function linearSessionOutputAvailable(outputContext: unknown): boolean {
  const parsed = LinearReplyOutputContextSchema.safeParse(outputContext);
  return parsed.success && parsed.data.agentSessionId !== null;
}

export function createLinearProgressExecutor(options: { client: LinearApiClient }): OutputExecutor {
  return async (input) => {
    const args = LinearProgressArgsSchema.parse(input.args);
    const context = LinearReplyOutputContextSchema.parse(input.outputContext);
    if (context.agentSessionId === null)
      throw new Error("Linear progress requires a native session");
    await options.client.createAgentActivity({
      linearOrganizationId: context.linearOrganizationId,
      agentSessionId: context.agentSessionId,
      content: { type: "thought", body: args.content },
      ephemeral: true,
    });
  };
}

export function createLinearPlanExecutor(options: { client: LinearApiClient }): OutputExecutor {
  return async (input) => {
    const args = LinearPlanArgsSchema.parse(input.args);
    const context = LinearReplyOutputContextSchema.parse(input.outputContext);
    if (context.agentSessionId === null) throw new Error("Linear plans require a native session");
    await options.client.updateAgentSessionPlan({
      linearOrganizationId: context.linearOrganizationId,
      agentSessionId: context.agentSessionId,
      plan: args.steps,
    });
  };
}

/**
 * Replies through the native agent session when present, otherwise through an issue comment,
 * threaded under the triggering comment's root when the context carries one.
 */
export function createLinearReplyExecutor(options: {
  client: LinearApiClient;
  database?: Database;
  reporter?: LinearReplyReporter;
}): OutputExecutor {
  const reporter =
    options.reporter ??
    (options.database === undefined
      ? undefined
      : createLinearReplyReporter({ client: options.client, database: options.database }));
  return async function executeLinearReply(input) {
    const args = replyWithOutcome(LinearReplyArgsSchema.parse(input.args));
    const context = LinearReplyOutputContextSchema.parse(input.outputContext);
    if (context.publishIssueComment === true) {
      if (reporter === undefined)
        throw new Error("Publishing a durable issue report requires the Linear reply journal");
      await publishDurableReply(reporter, input, context, args);
      return { deliveryAcknowledged: true };
    }
    if (context.agentSessionId !== null) {
      await options.client.createAgentActivity({
        linearOrganizationId: context.linearOrganizationId,
        agentSessionId: context.agentSessionId,
        ...nativeReplyActivity(args, args.content),
      });
      await attachLinearReplyLinks(options.client, context, args.content);
      return undefined;
    }
    await options.client.createComment({
      linearOrganizationId: context.linearOrganizationId,
      issueId: context.issueId,
      body: commentBody(args),
      ...(typeof context.threadRootCommentId === "string"
        ? { parentId: context.threadRootCommentId }
        : {}),
    });
    return undefined;
  };
}

function replyWithOutcome(
  args: z.infer<typeof LinearReplyArgsSchema>,
): z.infer<typeof LinearReplyArgsSchema> {
  if (args.outcome === undefined) return args;
  return {
    ...args,
    content: `${args.content}\n\nValidation: ${args.outcome.validation}\n\nNext action: ${args.outcome.nextAction}`,
  };
}

function nativeReplyActivity(
  args: z.infer<typeof LinearReplyArgsSchema>,
  body: string,
): LinearReplyPayload["activity"] {
  const activity: LinearReplyPayload["activity"] = {
    content: {
      type: args.kind === "question" || args.kind === "auth" ? "elicitation" : args.kind,
      body,
    },
  };
  if (args.auth !== undefined) {
    activity.signal = "auth";
    activity.signalMetadata = {
      url: args.auth.url,
      ...(args.auth.userId === undefined ? {} : { userId: args.auth.userId }),
      ...(args.auth.providerName === undefined ? {} : { providerName: args.auth.providerName }),
    };
  } else {
    const choices = questionChoices(args);
    if (choices.length > 0) {
      activity.signal = "select";
      activity.signalMetadata = { options: choices };
    }
  }
  return activity;
}

function publishDurableReply(
  reporter: LinearReplyReporter,
  input: OutputExecutionInput,
  context: z.infer<typeof LinearReplyOutputContextSchema>,
  args: z.infer<typeof LinearReplyArgsSchema>,
) {
  let outcome: LinearFinalOutcome | undefined;
  if (args.outcome !== undefined)
    outcome = {
      kind: args.outcome.kind,
      validation: args.outcome.validation,
      nextAction: args.outcome.nextAction,
      ...(args.outcome.assigneeId === undefined ? {} : { assigneeId: args.outcome.assigneeId }),
    };
  const body = commentBody(args);
  return reporter.publish({
    executionId: input.agentExecutionId,
    ...(input.triggerContext === undefined ? {} : { triggerContext: input.triggerContext }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    context,
    body,
    activity: nativeReplyActivity(args, body),
    ...(outcome === undefined ? {} : { outcome }),
  });
}

/** Issue comments have no elicitation: a question with choices lists them in Markdown instead. */
function commentBody(args: z.infer<typeof LinearReplyArgsSchema>): string {
  if (args.auth !== undefined) {
    return `${args.content}\n\n[Connect account](<${args.auth.url}>)`;
  }
  const choices = questionChoices(args);
  return choices.length === 0
    ? args.content
    : `${args.content}\n\n${choices.map((choice) => `- ${choice.label}`).join("\n")}`;
}

/** Only a question carries choices; a duplicated choice would render twice in Linear's select. */
function questionChoices(
  args: z.infer<typeof LinearReplyArgsSchema>,
): Array<{ label: string; value: string }> {
  if (args.kind !== "question") return [];
  const choices = new Map<string, { label: string; value: string }>();
  for (const option of args.options ?? []) {
    const choice = typeof option === "string" ? { label: option, value: option } : option;
    if (!choices.has(choice.value)) choices.set(choice.value, choice);
  }
  return [...choices.values()];
}
