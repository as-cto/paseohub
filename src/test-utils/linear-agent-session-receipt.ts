import {
  normalizeLinearEvent,
  type NormalizedLinearAgentSessionEvent,
} from "../triggers/linear/events.js";

/**
 * The payload of a `linear.agent_session` receipt as the webhook source persists it: the
 * delivered event, normalized. Built through the normalizer itself so the lookups that read
 * `agentSession.rootCommentId` and `agentSession.sourceCommentId` are tested against the shape
 * intake actually stores, and a drift in it fails these tests instead of emptying their results.
 */
export function linearAgentSessionReceiptPayload(input: {
  action?: "created" | "prompted";
  sessionId?: string;
  /** The root of the thread the session is attached to. */
  rootCommentId?: string;
  /** The comment that opened the session (`created`) or was turned into the prompt (`prompted`). */
  sourceCommentId?: string;
}): NormalizedLinearAgentSessionEvent {
  const action = input.action ?? "prompted";
  const event = normalizeLinearEvent(
    {
      type: "AgentSessionEvent",
      action,
      organizationId: "linear-org",
      appUserId: "app-user",
      createdAt: "2026-01-02T00:00:00.000Z",
      promptContext: "<issue>Canonical Linear context</issue>",
      agentSession: {
        id: input.sessionId ?? "session-1",
        appUserId: "app-user",
        issueId: "issue-1",
        status: action === "created" ? "pending" : "active",
        createdAt: "2026-01-02T00:00:00.000Z",
        creator: { id: "operator", name: "Operator" },
        ...(input.rootCommentId === undefined
          ? {}
          : {
              comment: {
                id: input.rootCommentId,
                issueId: "issue-1",
                userId: "operator",
                body: "@Paseo please draft a fix",
              },
            }),
        ...(action === "created" && input.sourceCommentId !== undefined
          ? { sourceCommentId: input.sourceCommentId }
          : {}),
        issue: {
          id: "issue-1",
          identifier: "ENG-42",
          title: "Ship the feature",
          description: "Useful context",
          projectId: "project-1",
          teamId: "team-1",
          stateId: "ready",
          assigneeId: null,
          labelIds: [],
        },
      },
      ...(action === "prompted"
        ? {
            agentActivity: {
              id: "activity-1",
              agentSessionId: input.sessionId ?? "session-1",
              createdAt: "2026-01-02T00:01:00.000Z",
              user: { id: "operator", name: "Operator" },
              content: { type: "prompt", body: "Please also add tests" },
              ...(input.sourceCommentId === undefined
                ? {}
                : { sourceCommentId: input.sourceCommentId }),
            },
          }
        : {}),
    },
    "AgentSessionEvent",
  );
  if (event?.type !== "agent_session") throw new Error("expected an agent session event");
  return event;
}
