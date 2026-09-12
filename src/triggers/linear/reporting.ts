import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Database } from "../../db/types.js";
import {
  linearReplyTurnKey,
  type LinearFinalOutcome,
  type LinearReplyDelivery,
  type LinearReplyPayload,
} from "../../db/linear-replies.js";
import type { LinearApiClient } from "../../providers/linear/client.js";
import { reportFailure } from "../../failures/index.js";
import type { TriggerSource } from "../index.js";
import { finalizeLinearIssue, LinearIssueFinalizationContextSchema } from "./finalization.js";
import type { LinearIssueFinalizationPolicy } from "../../db/linear-finalizations.js";
import { authorizedLinearReplyConnection } from "./reply-authority.js";

export interface PublishLinearReplyInput {
  executionId: string;
  attemptId?: string;
  triggerContext?: unknown;
  context: {
    linearOrganizationId: string;
    issueId: string;
    agentSessionId: string | null;
    finalizeIssue?: LinearIssueFinalizationPolicy | undefined;
  };
  body: string;
  activity: LinearReplyPayload["activity"];
  outcome?: LinearFinalOutcome;
}

export type LinearReplyReporter = ReturnType<typeof createLinearReplyReporter>;

/** Publishes only the already-authorized final report; recovery never starts or resumes an agent. */
export function createLinearReplyReporter(options: {
  database: Database;
  client: LinearApiClient;
  applicationId?: string;
  now?: () => Date;
  pollIntervalMs?: number;
}) {
  const { database, client } = options;
  const now = options.now ?? (() => new Date());

  async function publish(
    input: PublishLinearReplyInput,
  ): Promise<{ deliveryAcknowledged: true; connectionId: string }> {
    const execution = await database.findAgentExecutionById(input.executionId);
    if (execution === undefined) throw new Error("Linear report execution is missing");
    const authorizedConnectionId = authorizedLinearReplyConnection(
      input.triggerContext ?? execution.triggerContext,
      input.context,
    );
    validateReportOutcome(input);
    const connection = await database.findLinearConnectionForOrganization(
      execution.organizationId,
      input.context.linearOrganizationId,
    );
    if (
      connection === undefined ||
      connection.id !== authorizedConnectionId ||
      (options.applicationId !== undefined &&
        connection.providerApplicationId !== options.applicationId)
    ) {
      throw new Error(
        "Linear report connection is unavailable, changed, or belongs to a different application",
      );
    }
    const attempt =
      input.attemptId === undefined
        ? await database.beginAgentExecutionOutput(execution.id, "linear.reply", undefined, now())
        : execution.outputDeliveryAttempts[input.attemptId];
    if (attempt?.outputType !== "linear.reply")
      throw new Error("Linear report output attempt is missing");
    if (
      input.triggerContext === undefined &&
      attempt.turnId !== execution.hubActionAcknowledgements.turn?.id
    )
      throw new Error("An older Linear reply requires its original authorized event snapshot");
    const turnKey = linearReplyTurnKey(attempt.turnId);
    const payload: LinearReplyPayload = {
      organizationId: execution.organizationId,
      projectId: execution.projectId,
      connectionId: connection.id,
      applicationId: connection.providerApplicationId,
      linearOrganizationId: input.context.linearOrganizationId,
      issueId: input.context.issueId,
      agentSessionId: input.context.agentSessionId,
      ...(input.context.finalizeIssue === undefined
        ? {}
        : { finalizeIssue: input.context.finalizeIssue }),
      commentId: randomUUID(),
      activityId: input.context.agentSessionId === null ? null : randomUUID(),
      body: input.body,
      activity: input.activity,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    };
    const reply = await database.reserveLinearReply({
      id: randomUUID(),
      executionId: execution.id,
      turnKey,
      attemptId: attempt.id,
      payload,
      createdAt: now(),
    });
    // The first accepted report owns this turn. A changed retry must not silently rewrite it.
    if (!sameReplyPayload(reply.payload, payload)) {
      if (attempt.id !== reply.attemptId)
        await database.failAgentExecutionOutput(execution.id, attempt.id, now());
      throw new Error(
        "A different final report is already reserved for this turn; its delivery is being recovered",
      );
    }
    try {
      await deliver(reply);
    } finally {
      // Retried tool calls must not count as extra final replies. Only the canonical attempt is
      // acknowledged, atomically with its journal, even when the original tool call failed.
      if (attempt.id !== reply.attemptId)
        await database.failAgentExecutionOutput(execution.id, attempt.id, now());
    }
    return { deliveryAcknowledged: true, connectionId: reply.payload.connectionId };
  }

  async function reportMissingTerminalOutcome(executionId: string): Promise<void> {
    const execution = await database.findAgentExecutionById(executionId);
    if (
      execution === undefined ||
      (execution.status !== "failed" && execution.status !== "succeeded")
    )
      return;
    const context = z
      .object({
        provider: z.literal("linear"),
        publishIssueComment: z.literal(true),
        linearOrganizationId: z.string().min(1),
        issueId: z.string().min(1),
        agentSessionId: z.string().min(1).nullable(),
        finalizeIssue: LinearIssueFinalizationContextSchema.optional(),
      })
      .safeParse(execution.outputContext);
    if (!context.success) return;
    const turnKey = linearReplyTurnKey(execution.hubActionAcknowledgements.turn?.id);
    const existing = await database.findLinearReply(executionId, turnKey);
    if (existing !== undefined) {
      if (existing.supersededAt === null) await deliver(existing);
      return;
    }
    const authorizedConnectionId = authorizedLinearReplyConnection(
      execution.triggerContext,
      context.data,
    );
    const connection = await database.findLinearConnectionForOrganization(
      execution.organizationId,
      context.data.linearOrganizationId,
    );
    if (connection?.id !== authorizedConnectionId)
      throw new Error("The terminal report's authorized Linear connection changed");
    const result = execution.result;
    const rawReason: unknown =
      typeof result === "object" && result !== null ? Reflect.get(result, "reason") : undefined;
    const reason =
      typeof rawReason === "string" && /^[a-z][a-z_]{0,63}$/u.test(rawReason)
        ? rawReason
        : undefined;
    const interrupted = reason !== undefined && /cancel|interrupt|stop/u.test(reason);
    const outcome: LinearFinalOutcome = {
      kind: interrupted ? "interrupted" : "blocked",
      validation:
        "No final verification was recorded. Changes, tests and pull request readiness are unconfirmed.",
      nextAction:
        "A human should review the issue and session history, then decide whether to authorize further work.",
    };
    const body =
      `This work session ${interrupted ? "was interrupted" : "ended"} without a final work summary. ` +
      `Hub recorded the session as ${execution.status}${reason === undefined ? "." : ` (${reason}).`} ` +
      "No agent was restarted to generate this notice.\n\n" +
      `Validation: ${outcome.validation}\n\nNext action: ${outcome.nextAction}`;
    const attempt = await database.beginTerminalLinearReplyAttempt(executionId, turnKey, now());
    if (attempt === undefined) return;
    await publish({
      executionId,
      attemptId: attempt.id,
      context: context.data,
      body,
      activity: { content: { type: "error", body } },
      outcome,
    });
  }

  async function deliver(record: LinearReplyDelivery): Promise<void> {
    if (record.completedAt !== null) return;
    if (record.supersededAt !== null)
      throw new Error("The old native report was superseded; its issue comment was preserved");
    const leaseId = randomUUID();
    const claimed = await database.claimLinearReply(
      record.id,
      leaseId,
      now(),
      new Date(now().getTime() + 5 * 60_000),
    );
    if (claimed === undefined) {
      const current = await database.findLinearReply(record.executionId, record.turnKey);
      if (current?.completedAt !== null && current?.completedAt !== undefined) return;
      throw new Error("Linear report delivery is already in progress");
    }
    try {
      const connection = await database.findLinearConnectionForOrganization(
        claimed.payload.organizationId,
        claimed.payload.linearOrganizationId,
      );
      if (
        connection?.id !== claimed.payload.connectionId ||
        connection.providerApplicationId !== claimed.payload.applicationId
      ) {
        throw new Error(
          "Linear report connection changed; refusing to publish with replacement authority",
        );
      }
      if (
        client.readPublishedComment === undefined ||
        (claimed.payload.agentSessionId !== null && client.readPublishedAgentActivity === undefined)
      ) {
        throw new Error("Durable Linear reports require exact-ID publication lookup support");
      }
      if (claimed.commentConfirmedAt === null) {
        await reconcileComment(claimed.payload);
        await database.confirmLinearReplyDestination(claimed.id, "comment", now());
      }
      if (claimed.payload.agentSessionId !== null && claimed.activityConfirmedAt === null) {
        await database.withAdvisoryLock(`execution.prompt:${claimed.executionId}`, async () => {
          const execution = await database.findAgentExecutionById(claimed.executionId);
          if (execution === undefined) throw new Error("Linear report execution is missing");
          const currentTurn =
            linearReplyTurnKey(execution.hubActionAcknowledgements.turn?.id) === claimed.turnKey;
          const activeSessionId: unknown =
            typeof execution.outputContext === "object" && execution.outputContext !== null
              ? Reflect.get(execution.outputContext, "agentSessionId")
              : undefined;
          const differentSession =
            typeof activeSessionId === "string" &&
            activeSessionId !== claimed.payload.agentSessionId;
          if (!(await reconcileActivity(claimed.payload, currentTurn || differentSession))) {
            // Shared with prompt delivery: no newer turn can start between this check and the
            // terminal native mutation. Historical issue comments remain independently useful.
            await database.supersedeLinearReply(claimed.id, now());
            throw new Error(
              "The old native report was superseded; its issue comment was preserved",
            );
          }
          await database.confirmLinearReplyDestination(claimed.id, "activity", now());
        });
      }
      await finalizeLinearIssue({ database, client, reply: claimed, now });
      await database.acknowledgeLinearReply(claimed.id, now());
    } catch (error) {
      const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(claimed.attempts - 1, 8));
      await database.retryLinearReply(
        claimed.id,
        leaseId,
        new Date(now().getTime() + delay),
        error instanceof Error ? error.message : "Linear report delivery failed",
      );
      throw error;
    }
  }

  async function reconcileComment(payload: LinearReplyPayload): Promise<void> {
    const read = async () => {
      const comment = await client.readPublishedComment!({
        linearOrganizationId: payload.linearOrganizationId,
        expectedConnectionId: payload.connectionId,
        id: payload.commentId,
      });
      if (comment === undefined) return false;
      if (
        comment.id !== payload.commentId ||
        comment.issueId !== payload.issueId ||
        comment.parentId !== null ||
        comment.body !== payload.body
      ) {
        throw new Error("Linear report comment ID exists with different content or target");
      }
      return true;
    };
    if (await read()) return;
    try {
      await client.createComment({
        id: payload.commentId,
        linearOrganizationId: payload.linearOrganizationId,
        expectedConnectionId: payload.connectionId,
        issueId: payload.issueId,
        body: payload.body,
      });
    } catch (error) {
      // A lost acknowledgement or duplicate-ID rejection is success only after an exact read.
      if (await read()) return;
      throw error;
    }
  }

  async function reconcileActivity(
    payload: LinearReplyPayload,
    allowCreate: boolean,
  ): Promise<boolean> {
    if (payload.agentSessionId === null || payload.activityId === null)
      throw new Error("Native report target is missing");
    const read = async () => {
      const activity = await client.readPublishedAgentActivity!({
        linearOrganizationId: payload.linearOrganizationId,
        expectedConnectionId: payload.connectionId,
        id: payload.activityId!,
      });
      if (activity === undefined) return false;
      if (
        activity.id !== payload.activityId ||
        activity.agentSessionId !== payload.agentSessionId ||
        activity.type !== payload.activity.content.type ||
        activity.body !== payload.activity.content.body
      ) {
        throw new Error("Linear report activity ID exists with different content or target");
      }
      return true;
    };
    if (await read()) return true;
    if (!allowCreate) return false;
    try {
      await client.createAgentActivity({
        id: payload.activityId,
        linearOrganizationId: payload.linearOrganizationId,
        expectedConnectionId: payload.connectionId,
        agentSessionId: payload.agentSessionId,
        ...payload.activity,
      });
    } catch (error) {
      if (await read()) return true;
      throw error;
    }
    return true;
  }

  async function recover(applicationId = options.applicationId): Promise<void> {
    if (applicationId === undefined)
      throw new Error("Linear report recovery requires an application identity");
    const records = await database.listPendingLinearReplies(applicationId, now(), 20);
    for (const record of records) {
      try {
        await deliver(record);
      } catch (error) {
        reportFailure(error, {
          operation: "linear.reply.recover",
          component: "triggers",
          provider: "linear",
          executionId: record.executionId,
        });
      }
    }
    for (const executionId of await database.listTerminalLinearReplyCandidates(applicationId, 20)) {
      try {
        await reportMissingTerminalOutcome(executionId);
      } catch (error) {
        reportFailure(error, {
          operation: "linear.reply.terminal-recovery",
          component: "triggers",
          provider: "linear",
          executionId,
        });
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = true;
  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(tick, options.pollIntervalMs ?? 15_000);
    timer.unref();
  }
  function tick(): void {
    if (stopped) return;
    running = recover()
      .catch((error: unknown) => {
        reportFailure(error, {
          operation: "linear.reply.recovery",
          component: "triggers",
          provider: "linear",
        });
      })
      .finally(() => {
        running = undefined;
        schedule();
      });
  }
  const source: TriggerSource = {
    async start() {
      if (!stopped) return;
      stopped = false;
      tick();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await running;
    },
  };
  return { publish, deliver, recover, reportMissingTerminalOutcome, source };
}

function sameReplyPayload(left: LinearReplyPayload, right: LinearReplyPayload): boolean {
  // PostgreSQL jsonb reorders object properties. Compare their values so the first
  // reservation and identical retries are acknowledged without accepting changed reports.
  return (
    left.body === right.body &&
    left.issueId === right.issueId &&
    left.agentSessionId === right.agentSessionId &&
    left.connectionId === right.connectionId &&
    isDeepStrictEqual(left.activity, right.activity) &&
    isDeepStrictEqual(left.outcome, right.outcome) &&
    isDeepStrictEqual(left.finalizeIssue, right.finalizeIssue)
  );
}

function validateReportOutcome(input: PublishLinearReplyInput): void {
  if (input.context.finalizeIssue !== undefined && input.outcome === undefined)
    throw new Error(
      "Issue finalization requires a structured outcome with validation and next action",
    );
}
