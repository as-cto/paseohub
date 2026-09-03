import type { CompiledTriggerConfig } from "../../config/index.js";
import type { ProjectConfigurationStore } from "../../configuration/store.js";
import type { Database, LinearConnectionRecord } from "../../db/types.js";
import {
  LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT,
  LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT,
  type LinearApiClient,
  type LinearAgentActivity,
  type LinearIssueComment,
} from "../../providers/linear/client.js";
import { OUTPUT_DELIVERY_FAILED_REASON } from "../../execution-capabilities/required-outputs.js";
import { reportFailure } from "../../failures/index.js";
import { logger } from "../../logger.js";
import type { TriggerProviderExecutionControl } from "../../providers/registration.js";
import type { ProviderEventDropReasonCode } from "../drop-reason.js";
import type {
  ExternalTrigger,
  TriggerProvider,
  TriggerProviderMatch,
  TriggerProviderReactionState,
} from "../index.js";
import { matchesInputFilters, parseInvocation } from "../invocation.js";
import {
  NormalizedLinearAgentSessionEventSchema,
  NormalizedLinearEventSchema,
  type NormalizedLinearAgentSessionEvent,
  type NormalizedLinearCommentEvent,
  type NormalizedLinearEvent,
} from "./events.js";
import {
  matchLinearTriggers,
  readLinearAgentSessionInvocationParserMessage,
  readLinearCommentInvocationParserMessage,
} from "./match.js";
import { LINEAR_REPLY_OUTPUT_TYPE } from "./reply.js";
import {
  createLinearMirrorState,
  planLinearMirrorActivities,
  type LinearMirrorState,
} from "./mirror.js";

export interface LinearOutputContext {
  provider: "linear";
  linearOrganizationId: string;
  issueId: string;
  agentSessionId: string | null;
  /**
   * Linear threads are one level deep: a reply's parent must be the top-level comment, and
   * Linear rejects a nested comment as parent. Null when the trigger was not a comment.
   */
  threadRootCommentId: string | null;
}

export interface LinearTriggerContext {
  provider: "linear";
  target: LinearOutputContext;
  event: {
    linear: {
      event_type: "issue" | "comment" | "agent_session";
      action: "create" | "update" | "remove" | "created" | "prompted";
      delivery_id: string;
      connection_id: string | null;
      organization: { id: string };
      actor: { id: string; name?: string | undefined } | null;
      issue: {
        id: string;
        identifier?: string;
        title: string;
        description: string | null;
        url?: string;
        project: { id: string } | null;
        team: { id: string } | null;
        state: { id: string } | null;
        assignee: { id: string } | null;
        label_ids: string[];
      };
      comment: { id: string; body: string; parent_id: string | null } | null;
      agent_session: {
        id: string;
        app_user_id: string;
        status: string;
        url?: string;
      } | null;
      agent_activity: {
        id: string;
        type: "prompt";
        body: string;
        created_at: string;
        signal?: "stop";
      } | null;
      prompt_context: string | null;
      trigger_thread_context:
        | {
            status: "deferred";
            issue: { id: string };
            before: { created_at: string };
          }
        | {
            status: "deferred";
            agent_session: { id: string };
            before: { created_at: string };
          }
        | { status: "embedded" }
        | { status: "unavailable" };
    };
  };
}

export interface LinearIssueContextMessage {
  id: string;
  content: string;
  author: { id: string; name?: string } | null;
  created_at: string | null;
}

export interface LinearMaterializedContext {
  linear: Omit<LinearTriggerContext["event"]["linear"], "trigger_thread_context"> & {
    thread: {
      status: "available" | "incomplete" | "unavailable";
      messages: LinearIssueContextMessage[];
    };
  };
}

/** Failure reason of an execution ended by Linear's `stop` signal; not an error for the user. */
export const LINEAR_STOPPED_BY_USER_REASON = "stopped_by_user";

/** Failure reason of a comment-triggered run replaced by the agent session opened for its comment. */
export const LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON = "superseded_by_agent_session";

/**
 * Failure reason of a conversation's execution ended because its next turn had to start fresh.
 *
 * Happens against a daemon too old to receive a prompt: the execution is alive but unreachable,
 * so leaving it running would leave two agents on one session — the one that cannot be reached
 * and the one about to start. Not an error for the user, so no error activity is posted.
 */
export const LINEAR_SUPERSEDED_BY_NEW_TURN_REASON = "superseded_by_new_turn";

export interface LinearTriggerProviderOptions {
  configurationStoreForProject: (projectId: string) => ProjectConfigurationStore;
  client?: Pick<
    LinearApiClient,
    "readIssueComments" | "readAgentSessionActivities" | "readCommentThread" | "createAgentActivity"
  >;
  /** The connection bound to a Linear workspace; its app user is what `thread_with_app` looks for. */
  connectionForLinearOrganization?: (input: {
    organizationId: string;
    linearOrganizationId: string;
  }) => Promise<Pick<LinearConnectionRecord, "appUserId"> | undefined>;
  /**
   * Finds the runs a comment trigger started, so a new agent session can supersede them, and
   * the session receipts a comment already opened or prompted, so the comment starts none.
   */
  database?: Pick<
    Database,
    "listTriggerRunsForLinearComments" | "listLinearAgentSessionReceiptsForComment"
  >;
  executions?: TriggerProviderExecutionControl;
}

export function createLinearTriggerProvider(
  options: LinearTriggerProviderOptions,
): TriggerProvider<"linear", LinearTriggerContext, LinearOutputContext, LinearMaterializedContext> {
  /**
   * Live mirror state, one entry per Linear agent session.
   *
   * Keyed by session rather than by execution because the panel is the session: what must not be
   * posted twice, or out of order, is defined by the thread the user reads. Each turn resets its
   * budget in `onDispatchAccepted`, and `onAgentExecutionTerminal` drops the entry.
   */
  const mirrors = new Map<string, LinearMirrorState>();
  /**
   * One in-flight post per session, chained.
   *
   * Stream events arrive faster than Linear answers. Without this chain the activities would race
   * and land shuffled, which in a transcript is worse than being late.
   */
  const mirrorQueues = new Map<string, Promise<void>>();

  const mirrorActivities = (
    linearOrganizationId: string,
    agentSessionId: string,
    event: Parameters<NonNullable<TriggerProvider["onAgentStreamEvent"]>>[2],
  ): Promise<void> => {
    const client = options.client;
    if (client === undefined) return Promise.resolve();
    const state = mirrors.get(agentSessionId);
    if (state === undefined) return Promise.resolve();
    const planned = planLinearMirrorActivities(event, state);
    if (planned.length === 0) return Promise.resolve();
    const queued = (mirrorQueues.get(agentSessionId) ?? Promise.resolve())
      .then(async () => {
        for (const content of planned) {
          await client.createAgentActivity({
            linearOrganizationId,
            agentSessionId,
            content,
            // Never ephemeral. Linear replaces an ephemeral activity with the next one, which
            // turns a transcript into a single "currently doing X" line — the opposite of what a
            // mirror is for. The acceptance thought stays ephemeral (below) because being
            // replaced is exactly its job.
          });
        }
        return undefined;
      })
      .catch((error: unknown) => {
        reportFailure(
          error,
          { operation: "linear.session.mirror", component: "triggers", provider: "linear" },
          { diagnostic: { linearOrganizationId, agentSessionId } },
        );
      })
      .finally(() => {
        if (mirrorQueues.get(agentSessionId) === queued) mirrorQueues.delete(agentSessionId);
      });
    mirrorQueues.set(agentSessionId, queued);
    return queued;
  };

  return {
    name: "linear",
    eventNames: ["linear.issue", "linear.comment", "linear.agent_session"],
    async match(externalTrigger) {
      const received = NormalizedLinearEventSchema.parse(externalTrigger.payload);
      const stored = await options
        .configurationStoreForProject(externalTrigger.projectId)
        .getRevision(externalTrigger.configurationRevisionId);
      if (stored === undefined) return "configuration_unavailable";
      if (!hasSourceTrigger(stored.configuration.triggers, externalTrigger.source)) {
        return "no_trigger_for_source";
      }
      if (received.type === "agent_session" && received.agentActivity?.signal === "stop") {
        await stopLinearAgentSession(options, externalTrigger.projectId, received);
        return "agent_session_stopped";
      }
      const { event, appUserId } = await hydrateLinearCommentThread(
        options,
        externalTrigger,
        received,
        stored.configuration.triggers,
      );
      const matched = matchLinearTriggers(
        stored.configuration,
        event,
        externalTrigger.connectionId,
        appUserId,
      );
      if (matched.length === 0) return "trigger_filters_rejected";

      const matches: TriggerProviderMatch<LinearTriggerContext, LinearOutputContext>[] = [];
      for (const candidate of matched) {
        const compiledTrigger = stored.configuration.triggers.find(
          (trigger) => trigger.name === candidate.trigger.name,
        );
        if (compiledTrigger === undefined) {
          throw new Error(`compiled trigger not found: ${candidate.trigger.name}`);
        }
        const issue = event.type === "issue" ? event.issue : event.issue;
        if (issue === null) continue;
        const outputContext: LinearOutputContext = {
          provider: "linear",
          linearOrganizationId: event.organizationId,
          issueId: issue.id,
          agentSessionId: event.type === "agent_session" ? event.agentSession.id : null,
          threadRootCommentId:
            event.type === "comment" ? (event.comment.parentId ?? event.comment.id) : null,
        };
        const triggerContext: LinearTriggerContext = {
          provider: "linear",
          target: outputContext,
          event: {
            linear: buildLinearContext(
              event,
              externalTrigger.deliveryId,
              externalTrigger.connectionId,
            ),
          },
        };
        const prompt = promptForEvent(event);
        const invocation = parseInvocation(
          prompt,
          compiledTrigger.inputs,
          undefined,
          parserMessageForEvent(event, compiledTrigger.filters),
        );
        if (invocation.status === "accepted") {
          if (!matchesInputFilters(invocation.inputs, compiledTrigger.filters?.inputs)) continue;
          matches.push({
            triggerName: candidate.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
        } else {
          matches.push({
            triggerName: candidate.trigger.name,
            triggerContext,
            outputContext,
            configurationRevisionId: stored.revision.id,
            hubConfig: stored.configuration,
            invocation,
          });
        }
      }
      if (matches.length === 0) return "trigger_filters_rejected";
      // Deliberately after the filters. A steer injects text straight into an agent running with
      // `bypassPermissions` on a private repository, so it must clear exactly the checks a new run
      // clears — `from_users`, team, connection. The `stop` path above skips them; this one must
      // not, and the difference is on purpose.
      const steered = await steerLiveLinearSession(
        { ...options, resetMirror: (id) => mirrors.set(id, createLinearMirrorState()) },
        externalTrigger,
        event,
      );
      if (steered) return "steered_into_live_session";
      const superseded = await settleLinearCommentSessionDuplicate(
        options,
        externalTrigger,
        event,
        stored.configuration,
      );
      return superseded ?? matches;
    },
    async materializeContext(launch): Promise<LinearMaterializedContext> {
      const { trigger_thread_context: locator, ...linear } = launch.triggerContext.event.linear;
      const root = issueRootMessage(linear.issue);
      if (locator.status === "embedded") {
        return linearThreadContext(linear, "available", [root]);
      }
      if (locator.status !== "deferred" || options.client === undefined) {
        return linearThreadContext(linear, "unavailable", [root]);
      }
      if ("agent_session" in locator) {
        try {
          const history = await options.client.readAgentSessionActivities({
            linearOrganizationId: linear.organization.id,
            agentSessionId: locator.agent_session.id,
            beforeCreatedAt: locator.before.created_at,
          });
          const causalActivities = history.activities.filter((activity) =>
            isBeforeLinearActivity(activity, locator.before.created_at),
          );
          const messages = causalActivities
            .sort(compareLinearActivityOrder)
            .slice(-LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT)
            .map(activityMessage);
          const complete =
            history.complete &&
            causalActivities.length === history.activities.length &&
            causalActivities.length <= LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT;
          return linearThreadContext(linear, complete ? "available" : "incomplete", [
            root,
            ...messages,
          ]);
        } catch (error) {
          reportFailure(
            error,
            {
              operation: "linear.agent-session.history.hydrate",
              component: "triggers",
              provider: "linear",
            },
            {
              diagnostic: {
                linearOrganizationId: linear.organization.id,
                agentSessionId: locator.agent_session.id,
              },
            },
          );
          return linearThreadContext(linear, "unavailable", [root]);
        }
      }
      try {
        const history = await options.client.readIssueComments({
          linearOrganizationId: linear.organization.id,
          issueId: locator.issue.id,
          beforeCreatedAt: locator.before.created_at,
        });
        const causalComments = history.comments.filter((comment) =>
          isBeforeLinearTrigger(comment, locator.before.created_at),
        );
        const messages = causalComments
          .sort(compareLinearCommentOrder)
          .slice(-LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT)
          .map(commentMessage);
        const complete =
          history.complete &&
          causalComments.length === history.comments.length &&
          causalComments.length <= LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT;
        return linearThreadContext(linear, complete ? "available" : "incomplete", [
          root,
          ...messages,
        ]);
      } catch (error) {
        reportFailure(
          error,
          { operation: "linear.issue.history.hydrate", component: "triggers", provider: "linear" },
          {
            diagnostic: { linearOrganizationId: linear.organization.id, issueId: locator.issue.id },
          },
        );
        return linearThreadContext(linear, "unavailable", [root]);
      }
    },
    keepsExecutionAliveBetweenTurns(triggerContext) {
      // Only agent sessions. A comment-triggered run answers once and is done; a session is a
      // panel the user keeps writing into, and Linear treats it as one conversation.
      return triggerContext.event.linear.agent_session !== null;
    },
    async onDispatchAccepted(triggerContext, _outputContext, reactionState) {
      const agentSession = triggerContext.event.linear.agent_session;
      if (agentSession === null || options.client === undefined) return reactionState;
      if (linearAgentReactionPhase(reactionState) !== undefined) return reactionState;
      // A fresh budget per turn: the ceiling protects one turn from flooding the issue, it is not
      // a lifetime quota on the conversation.
      mirrors.set(agentSession.id, createLinearMirrorState());
      await options.client.createAgentActivity({
        linearOrganizationId: triggerContext.event.linear.organization.id,
        agentSessionId: agentSession.id,
        content: {
          type: "thought",
          body: "Paseo accepted this task and is starting the workflow.",
        },
        ephemeral: true,
      });
      return { phase: "accepted" };
    },
    async onAgentExecutionCompleted(triggerContext, _outputContext, result, reactionState) {
      const agentSession = triggerContext.event.linear.agent_session;
      if (agentSession === null || options.client === undefined) return reactionState;
      if (linearAgentReactionPhase(reactionState) === "completed") return reactionState;
      // Linear keeps the session `active` (then `stale`) until a response or error
      // lands. A reply already closed it; otherwise close it explicitly. Unknown
      // emissions are left alone rather than risking a false "no reply" notice.
      if (
        result.outputEmissions !== undefined &&
        (result.outputEmissions[LINEAR_REPLY_OUTPUT_TYPE] ?? 0) === 0
      ) {
        await options.client.createAgentActivity({
          linearOrganizationId: triggerContext.event.linear.organization.id,
          agentSessionId: agentSession.id,
          content: {
            type: "response",
            body: "Paseo finished this workflow without posting a reply.",
          },
        });
      }
      return { phase: "completed" };
    },
    async onAgentExecutionFailed(triggerContext, _outputContext, reason, reactionState) {
      return notifyLinearAgentFailure(options.client, triggerContext, reason, reactionState);
    },
    async onMachineTerminated(triggerContext, reason, reactionState) {
      return notifyLinearAgentFailure(options.client, triggerContext, reason, reactionState);
    },
    /**
     * Mirrors the running agent into the session panel.
     *
     * Only sessions have a panel to mirror into: a comment-triggered run answers with a single
     * comment, and posting its every step would turn one reply into fifty.
     */
    async onAgentStreamEvent(triggerContext, _outputContext, event) {
      const agentSession = triggerContext.event.linear.agent_session;
      if (agentSession === null) return;
      await mirrorActivities(triggerContext.event.linear.organization.id, agentSession.id, event);
    },
    async onAgentExecutionTerminal(_executionId, triggerContext) {
      const agentSession = triggerContext.event.linear.agent_session;
      if (agentSession === null) return;
      // Drains before dropping: the last activities of a turn are the ones that explain how it
      // ended, and losing them to a cleanup would be the wrong trade.
      await mirrorQueues.get(agentSession.id);
      mirrors.delete(agentSession.id);
      mirrorQueues.delete(agentSession.id);
    },
  };
}

function linearThreadContext(
  linear: Omit<LinearTriggerContext["event"]["linear"], "trigger_thread_context">,
  status: LinearMaterializedContext["linear"]["thread"]["status"],
  messages: LinearIssueContextMessage[],
): LinearMaterializedContext {
  return { linear: { ...linear, thread: { status, messages } } };
}

function issueRootMessage(
  issue: LinearTriggerContext["event"]["linear"]["issue"],
): LinearIssueContextMessage {
  return {
    id: issue.id,
    content:
      issue.description === null || issue.description.length === 0
        ? issue.title
        : `${issue.title}\n\n${issue.description}`,
    author: null,
    created_at: null,
  };
}

function commentMessage(comment: LinearIssueComment): LinearIssueContextMessage {
  return {
    id: comment.id,
    content: comment.body,
    author: comment.author,
    created_at: comment.createdAt,
  };
}

function activityMessage(activity: LinearAgentActivity): LinearIssueContextMessage {
  return {
    id: activity.id,
    content: activity.body,
    author: activity.author,
    created_at: activity.createdAt,
  };
}

function isBeforeLinearTrigger(comment: LinearIssueComment, beforeCreatedAt: string): boolean {
  const commentAt = Date.parse(comment.createdAt);
  const triggerAt = Date.parse(beforeCreatedAt);
  return Number.isFinite(commentAt) && Number.isFinite(triggerAt) && commentAt < triggerAt;
}

function compareLinearCommentOrder(left: LinearIssueComment, right: LinearIssueComment): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function isBeforeLinearActivity(activity: LinearAgentActivity, beforeCreatedAt: string): boolean {
  const activityAt = Date.parse(activity.createdAt);
  const triggerAt = Date.parse(beforeCreatedAt);
  return Number.isFinite(activityAt) && Number.isFinite(triggerAt) && activityAt < triggerAt;
}

function compareLinearActivityOrder(left: LinearAgentActivity, right: LinearAgentActivity): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function hasSourceTrigger(triggers: readonly { on: string }[], source: string): boolean {
  return triggers.some((trigger) => triggerMatchesLinearSource(trigger.on, source));
}

function triggerMatchesLinearSource(trigger: string, source: string): boolean {
  if (source === "linear.issue") {
    return trigger === "linear.issue_entered_scope" || trigger === "linear.issue_assigned";
  }
  if (source === "linear.comment") return trigger === "linear.comment_created";
  return source === "linear.agent_session" && trigger === "linear.agent_session";
}

function promptForEvent(event: NormalizedLinearEvent): string {
  if (event.type === "comment") return event.comment.body;
  if (event.type === "agent_session") return event.prompt;
  return event.issue.description === null
    ? event.issue.title
    : `${event.issue.title}\n\n${event.issue.description}`;
}

function parserMessageForEvent(
  event: NormalizedLinearEvent,
  filters: Parameters<typeof readLinearCommentInvocationParserMessage>[1],
): string {
  if (event.type === "comment") return readLinearCommentInvocationParserMessage(event, filters);
  if (event.type === "agent_session") {
    return readLinearAgentSessionInvocationParserMessage(event, filters);
  }
  return promptForEvent(event);
}

function buildLinearContext(
  event: NormalizedLinearEvent,
  deliveryId: string,
  connectionId: string | null | undefined,
): LinearTriggerContext["event"]["linear"] {
  const issue = event.type === "issue" ? event.issue : event.issue;
  if (issue === null) throw new Error("Linear event issue context unavailable");
  return {
    event_type: event.type,
    action: event.action,
    delivery_id: deliveryId,
    connection_id: connectionId ?? null,
    organization: { id: event.organizationId },
    actor: event.actor,
    issue: {
      id: issue.id,
      ...(issue.identifier === undefined ? {} : { identifier: issue.identifier }),
      title: issue.title,
      description: issue.description,
      ...(issue.url === undefined ? {} : { url: issue.url }),
      project: issue.projectId === null ? null : { id: issue.projectId },
      team: issue.teamId === null ? null : { id: issue.teamId },
      state: issue.stateId === null ? null : { id: issue.stateId },
      assignee: issue.assigneeId === null ? null : { id: issue.assigneeId },
      label_ids: issue.labelIds,
    },
    comment:
      event.type === "comment"
        ? {
            id: event.comment.id,
            body: event.comment.body,
            parent_id: event.comment.parentId,
          }
        : null,
    agent_session:
      event.type === "agent_session"
        ? {
            id: event.agentSession.id,
            app_user_id: event.agentSession.appUserId,
            status: event.agentSession.status,
            ...(event.agentSession.url === undefined ? {} : { url: event.agentSession.url }),
          }
        : null,
    agent_activity:
      event.type === "agent_session" && event.agentActivity !== null
        ? {
            id: event.agentActivity.id,
            type: event.agentActivity.type,
            body: event.agentActivity.body,
            created_at: event.agentActivity.createdAt,
            ...(event.agentActivity.signal === undefined
              ? {}
              : { signal: event.agentActivity.signal }),
          }
        : null,
    prompt_context: event.type === "agent_session" ? event.promptContext : null,
    trigger_thread_context: linearThreadContextLocator(event, issue.id),
  };
}

function linearThreadContextLocator(
  event: NormalizedLinearEvent,
  issueId: string,
): LinearTriggerContext["event"]["linear"]["trigger_thread_context"] {
  if (event.type === "agent_session") {
    if (event.action === "created") return { status: "embedded" };
    return {
      status: "deferred",
      agent_session: { id: event.agentSession.id },
      before: { created_at: event.occurredAt },
    };
  }
  if (event.occurredAt === undefined) return { status: "unavailable" };
  return {
    status: "deferred",
    issue: { id: issueId },
    before: { created_at: event.occurredAt },
  };
}

/**
 * `thread_with_app` needs three things the webhook does not carry: who wrote in the thread,
 * whether the thread is an agent session's, and which Linear user the connection acts as. All
 * are read only when a configured trigger asks for them, and a failed read leaves the event as
 * delivered so the filter fails closed while every other trigger still dispatches.
 */
async function hydrateLinearCommentThread(
  options: Pick<LinearTriggerProviderOptions, "client" | "connectionForLinearOrganization">,
  externalTrigger: ExternalTrigger,
  event: NormalizedLinearEvent,
  triggers: readonly Pick<CompiledTriggerConfig, "on" | "filters">[],
): Promise<{ event: NormalizedLinearEvent; appUserId: string | undefined }> {
  if (
    event.type !== "comment" ||
    event.action !== "create" ||
    event.comment.parentId === null ||
    !triggers.some(
      (trigger) =>
        trigger.on === "linear.comment_created" && trigger.filters?.thread_with_app === true,
    )
  ) {
    return { event, appUserId: undefined };
  }
  const diagnostic = { linearOrganizationId: event.organizationId, commentId: event.comment.id };
  let appUserId: string | undefined;
  try {
    const connection = await options.connectionForLinearOrganization?.({
      organizationId: externalTrigger.organizationId,
      linearOrganizationId: event.organizationId,
    });
    appUserId = connection?.appUserId;
  } catch (error) {
    logger.warn(
      { err: error, ...diagnostic },
      "Linear connection lookup failed; thread_with_app triggers will not match",
    );
  }
  if (appUserId === undefined || event.threadAuthorIds !== undefined) return { event, appUserId };
  try {
    const thread = await options.client?.readCommentThread(diagnostic);
    if (thread === undefined) return { event, appUserId };
    const threadIsAgentSession = thread.agentSessionRootIds.includes(thread.rootId);
    if (threadIsAgentSession) {
      logger.debug(
        { ...diagnostic, rootCommentId: thread.rootId },
        "Linear comment is in an agent-session thread; thread_with_app triggers leave it to the session",
      );
    }
    return {
      event: { ...event, threadAuthorIds: thread.authorIds, threadIsAgentSession },
      appUserId,
    };
  } catch (error) {
    logger.warn(
      { err: error, ...diagnostic },
      "Linear comment thread read failed; thread_with_app triggers will not match",
    );
    return { event, appUserId };
  }
}

/**
 * A mention that opens an agent session also arrives as a comment, moments earlier, and so does
 * a reply in the session's thread before Linear turns it into a prompt. When a comment trigger
 * already started a run from that comment, the session is the canonical handling: the comment
 * run is stopped so the user is not answered twice. For a new session the mention may sit in a
 * reply, so the comment that created it is checked as well as the thread's root; a prompt is
 * tied to the one comment behind it. A failure here is reported but does not hold back the
 * session's own run.
 */
async function supersedeLinearCommentRuns(
  options: Pick<LinearTriggerProviderOptions, "database" | "executions">,
  projectId: string,
  event: NormalizedLinearAgentSessionEvent,
): Promise<void> {
  const commentIds = supersededCommentIds(event);
  if (
    commentIds.length === 0 ||
    options.database === undefined ||
    options.executions === undefined
  ) {
    return;
  }
  try {
    const superseded = new Set(
      (await options.database.listTriggerRunsForLinearComments(projectId, commentIds)).map(
        (run) => run.id,
      ),
    );
    if (superseded.size === 0) return;
    await options.executions.stopActive({
      projectId,
      reason: LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON,
      matches: (work) => work.triggerRunId !== null && superseded.has(work.triggerRunId),
    });
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "linear.agent-session.supersede-comment-runs",
        component: "triggers",
        provider: "linear",
      },
      { diagnostic: { projectId, agentSessionId: event.agentSession.id, commentIds } },
    );
  }
}

/**
 * A mention duplicates itself as a comment and an agent session, and either may be matched
 * second. A session stops the comment runs that beat it; a comment yields to the session
 * receipts that beat its run. Returns the drop reason when the event yields.
 */
/**
 * Sends a session's new message to the agent already working on it.
 *
 * Linear's session panel is one conversation; Hub answered it with a new agent per message, each
 * one cold-started and handed the thread replayed as text. Everything the previous agent had in
 * context — the files it read, what it had already tried — was thrown away between two sentences
 * of the same exchange.
 *
 * Only `prompted` qualifies: `created` is the first message of a session, so there is nothing live
 * to continue. A delegation therefore keeps its single-turn shape until someone writes into its
 * panel, which is exactly when it becomes a conversation.
 *
 * Returns false whenever no live agent took the message — turn already finished, daemon too old to
 * support prompting, daemon offline. Every one of those falls back to starting a run, which is the
 * behaviour that existed before this path.
 */
async function steerLiveLinearSession(
  options: {
    executions?: TriggerProviderExecutionControl;
    resetMirror?: (agentSessionId: string) => void;
  },
  externalTrigger: ExternalTrigger,
  event: NormalizedLinearEvent,
): Promise<boolean> {
  if (event.type !== "agent_session" || event.action !== "prompted") return false;
  if (options.executions === undefined) return false;
  const prompt = event.prompt.trim();
  if (prompt.length === 0) return false;
  const agentSessionId = event.agentSession.id;
  const result = await options.executions.promptActive({
    projectId: externalTrigger.projectId,
    prompt,
    // `steer` rather than `interrupt`: the user adding a precision mid-work expects it to be taken
    // into account, not to cancel what they asked for a minute earlier.
    activeTurnBehavior: "steer",
    matches: (work) => readLinearAgentSessionId(work.outputContext) === agentSessionId,
  });
  if (!result.delivered && result.live) {
    // Alive but out of reach: a daemon that predates prompting. A new run is about to start for
    // this session, and leaving the stranded one running would put two agents on one panel.
    await options.executions.stopActive({
      projectId: externalTrigger.projectId,
      reason: LINEAR_SUPERSEDED_BY_NEW_TURN_REASON,
      matches: (work) => readLinearAgentSessionId(work.outputContext) === agentSessionId,
    });
    return false;
  }
  if (result.delivered) {
    // A steered turn never passes through `onDispatchAccepted`, so the mirror's per-turn budget
    // has to be reopened here — otherwise a long conversation would spend one turn's allowance of
    // activities and go quiet for the rest of the session.
    options.resetMirror?.(agentSessionId);
    logger.info(
      { agentSessionId, deliveryId: externalTrigger.deliveryId },
      "linear.session.prompt.steered",
    );
  }
  return result.delivered;
}

async function settleLinearCommentSessionDuplicate(
  options: Pick<LinearTriggerProviderOptions, "database" | "executions">,
  externalTrigger: ExternalTrigger,
  event: NormalizedLinearEvent,
  configuration: { triggers: readonly Pick<CompiledTriggerConfig, "name" | "on" | "filters">[] },
): Promise<ProviderEventDropReasonCode | undefined> {
  if (event.type === "agent_session") {
    await supersedeLinearCommentRuns(options, externalTrigger.projectId, event);
    return undefined;
  }
  if (event.type !== "comment") return undefined;
  const handled = await isLinearCommentHandledByAgentSession(
    options,
    externalTrigger,
    event,
    configuration,
  );
  return handled ? LINEAR_SUPERSEDED_BY_AGENT_SESSION_REASON : undefined;
}

/**
 * The other side of `supersedeLinearCommentRuns`, which only finds a comment run that already
 * exists. Usually none does: the comment arrives first, but its run waits for the issue and the
 * thread to be hydrated. Measured in production: session receipt persisted 123 ms after the
 * comment receipt, comment run inserted 144 ms after that, inside the 12 ms window in which the
 * session side was looking for it. Receipts, however, are persisted at intake, before matching.
 * So the comment checks them just before it starts a run: a session receipt that names this
 * comment and would start a run in this project makes the comment its duplicate. A failed
 * lookup is reported and the comment runs, because answering twice is the recoverable outcome.
 */
async function isLinearCommentHandledByAgentSession(
  options: Pick<LinearTriggerProviderOptions, "database">,
  externalTrigger: ExternalTrigger,
  event: NormalizedLinearCommentEvent,
  configuration: { triggers: readonly Pick<CompiledTriggerConfig, "name" | "on" | "filters">[] },
): Promise<boolean> {
  if (options.database === undefined) return false;
  const diagnostic = {
    linearOrganizationId: event.organizationId,
    commentId: event.comment.id,
    receiptId: externalTrigger.providerEventReceiptId,
  };
  try {
    const receipts = await options.database.listLinearAgentSessionReceiptsForComment(
      externalTrigger.organizationId,
      event.comment.id,
    );
    const sessions = receipts.flatMap((receipt) => {
      const session = NormalizedLinearAgentSessionEventSchema.safeParse(receipt.payload);
      if (
        !session.success ||
        matchLinearTriggers(configuration, session.data, externalTrigger.connectionId).length === 0
      ) {
        return [];
      }
      return [{ receiptId: receipt.id, agentSessionId: session.data.agentSession.id }];
    });
    if (sessions.length === 0) return false;
    logger.info(
      { ...diagnostic, agentSessions: sessions },
      "Linear comment already opened or prompted an agent session; leaving it to the session",
    );
    return true;
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "linear.comment.agent-session-receipts",
        component: "triggers",
        provider: "linear",
      },
      { diagnostic },
    );
    return false;
  }
}

function supersededCommentIds(event: NormalizedLinearAgentSessionEvent): string[] {
  const { rootCommentId, sourceCommentId } = event.agentSession;
  const candidates =
    event.action === "prompted" ? [sourceCommentId] : [rootCommentId, sourceCommentId];
  return [...new Set(candidates.filter((id): id is string => id !== undefined))];
}

function linearAgentReactionPhase(
  reactionState: TriggerProviderReactionState | undefined,
): "accepted" | "completed" | "failed" | undefined {
  if (typeof reactionState !== "object" || reactionState === null || Array.isArray(reactionState)) {
    return undefined;
  }
  const phase = reactionState["phase"];
  return phase === "accepted" || phase === "completed" || phase === "failed" ? phase : undefined;
}

/**
 * Linear's `stop` signal arrives as a prompt; it must not start a run. The session's pending
 * executions and not-yet-dispatched runs are failed with a dedicated reason (so no error is
 * posted for them), and Linear receives the `response` it expects to settle the session.
 */
async function stopLinearAgentSession(
  options: {
    client?: Pick<LinearApiClient, "createAgentActivity">;
    executions?: TriggerProviderExecutionControl;
  },
  projectId: string,
  event: NormalizedLinearAgentSessionEvent,
): Promise<void> {
  const agentSessionId = event.agentSession.id;
  await options.executions?.stopActive({
    projectId,
    reason: LINEAR_STOPPED_BY_USER_REASON,
    matches: (execution) => readLinearAgentSessionId(execution.outputContext) === agentSessionId,
  });
  await options.client?.createAgentActivity({
    linearOrganizationId: event.organizationId,
    agentSessionId,
    content: { type: "response", body: "Stopped at your request." },
  });
}

function readLinearAgentSessionId(outputContext: unknown): string | null {
  if (typeof outputContext !== "object" || outputContext === null) return null;
  const context = outputContext as Partial<LinearOutputContext>;
  if (context.provider !== "linear") return null;
  return typeof context.agentSessionId === "string" ? context.agentSessionId : null;
}

async function notifyLinearAgentFailure(
  client: Pick<LinearApiClient, "createAgentActivity"> | undefined,
  triggerContext: LinearTriggerContext,
  reason: string,
  reactionState: TriggerProviderReactionState | undefined,
): Promise<TriggerProviderReactionState | undefined> {
  const agentSession = triggerContext.event.linear.agent_session;
  if (agentSession === null || client === undefined) return reactionState;
  if (linearAgentReactionPhase(reactionState) === "failed") return reactionState;
  // The stop handler already confirmed the stop; an error would contradict it. A conversation
  // whose turn restarted elsewhere is not a failure the user should read about either.
  if (reason === LINEAR_STOPPED_BY_USER_REASON || reason === LINEAR_SUPERSEDED_BY_NEW_TURN_REASON) {
    return { phase: "failed" };
  }
  await client.createAgentActivity({
    linearOrganizationId: triggerContext.event.linear.organization.id,
    agentSessionId: agentSession.id,
    content: { type: "error", body: linearFailureBody(reason) },
  });
  return { phase: "failed" };
}

function linearFailureBody(reason: string): string {
  // The reply itself is what failed; the internal reason would not help the user.
  if (reason === OUTPUT_DELIVERY_FAILED_REASON) {
    return "Paseo could not deliver its reply to this session.";
  }
  return `Paseo could not complete this workflow: ${reason.slice(0, 1_000)}`;
}
