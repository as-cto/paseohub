import { z } from "zod";
import type { Database, LinearConnectionRecord } from "../../db/types.js";

/** The original issue/comment trigger authority. `write` also satisfies comment creation. */
export const LINEAR_REQUIRED_SCOPES = ["read", "comments:create"] as const;

/** Additional authority requested for Linear's optional native app-agent mode. */
export const LINEAR_AGENT_SESSION_REQUIRED_SCOPES = [
  "read",
  "write",
  "app:assignable",
  "app:mentionable",
] as const;

export type LinearAuthorizationMode = "baseline" | "agentSessions";

/** Keep an issue description plus its preceding discussion within one bounded context window. */
export const LINEAR_ISSUE_CONTEXT_LIMIT = 50;
export const LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT = LINEAR_ISSUE_CONTEXT_LIMIT - 1;
export const LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT = LINEAR_ISSUE_CONTEXT_LIMIT - 1;
const LINEAR_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

const LinearTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive().optional(),
    scope: z.string().optional(),
  })
  .passthrough();

const ViewerResponseSchema = z.object({
  data: z.object({
    viewer: z.object({
      id: z.string().min(1),
      organization: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    }),
  }),
});

const GraphqlErrorSchema = z.object({
  errors: z
    .array(z.object({ message: z.string().min(1) }))
    .min(1)
    .optional(),
});

const IssueResponseSchema = z.object({
  data: z.object({
    issue: z
      .object({
        id: z.string().min(1),
        identifier: z.string().min(1).optional(),
        title: z.string(),
        updatedAt: z.string().optional(),
        description: z.string().nullable().optional(),
        url: z.string().url().optional(),
        project: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        team: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        state: z
          .object({ id: z.string().min(1), type: z.string().optional() })
          .nullable()
          .optional(),
        assignee: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        delegate: z
          .object({ id: z.string().min(1) })
          .nullable()
          .optional(),
        labels: z.object({ nodes: z.array(z.object({ id: z.string().min(1) })) }),
      })
      .nullable(),
  }),
});

const IssueCommentHistoryResponseSchema = z.object({
  data: z.object({
    comments: z.object({
      nodes: z.array(
        z.object({
          id: z.string().min(1),
          body: z.string(),
          createdAt: z.string().datetime(),
          user: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1).nullable().optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
      pageInfo: z.object({ hasPreviousPage: z.boolean() }),
    }),
  }),
});

const CommentAuthorSchema = z.object({
  user: z
    .object({ id: z.string().min(1) })
    .nullable()
    .optional(),
  botActor: z
    .object({ id: z.string().min(1).nullable().optional() })
    .nullable()
    .optional(),
});

const CommentRepliesSchema = z.object({ nodes: z.array(CommentAuthorSchema) });
const CommentAgentSessionSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.string().optional(),
    appUser: z.object({ id: z.string().min(1) }),
  })
  .nullable()
  .optional();

const CommentThreadResponseSchema = z.object({
  data: z.object({
    comment: CommentAuthorSchema.extend({
      id: z.string().min(1),
      agentSession: CommentAgentSessionSchema,
      parent: CommentAuthorSchema.extend({
        id: z.string().min(1),
        agentSession: CommentAgentSessionSchema,
        children: CommentRepliesSchema,
      })
        .nullable()
        .optional(),
      children: CommentRepliesSchema,
      issue: z
        .object({
          agentSessions: z.object({
            nodes: z.array(
              z.object({
                comment: z
                  .object({ id: z.string().min(1) })
                  .nullable()
                  .optional(),
              }),
            ),
          }),
        })
        .nullable()
        .optional(),
    }).nullable(),
  }),
});

const CommentResponseSchema = z.object({
  data: z.object({
    commentCreate: z.object({ success: z.literal(true) }),
  }),
});

const AgentActivityBodyContentSchema = z.object({
  __typename: z.enum([
    "AgentActivityThoughtContent",
    "AgentActivityElicitationContent",
    "AgentActivityErrorContent",
    "AgentActivityPromptContent",
    "AgentActivityResponseContent",
  ]),
  type: z.enum(["thought", "elicitation", "error", "prompt", "response"]),
  body: z.string(),
});

const AgentActivityActionContentSchema = z.object({
  __typename: z.literal("AgentActivityActionContent"),
  type: z.literal("action"),
  action: z.string(),
  parameter: z.string(),
  result: z.string().nullable().optional(),
});

const AgentActivityHistoryResponseSchema = z.object({
  data: z.object({
    agentSession: z.object({
      activities: z.object({
        nodes: z.array(
          z.object({
            id: z.string().min(1),
            createdAt: z.string().datetime(),
            user: z.object({ id: z.string().min(1), name: z.string().min(1) }),
            content: z.union([AgentActivityBodyContentSchema, AgentActivityActionContentSchema]),
          }),
        ),
        pageInfo: z.object({ hasPreviousPage: z.boolean() }),
      }),
    }),
  }),
});

const AgentActivityResponseSchema = z.object({
  data: z.object({
    agentActivityCreate: z.object({ success: z.literal(true) }),
  }),
});

const AgentSessionUpdateResponseSchema = z.object({
  data: z.object({ agentSessionUpdate: z.object({ success: z.boolean() }) }),
});
const AgentSessionCreateResponseSchema = z.object({
  data: z.object({
    agentSessionCreateOnComment: z.object({
      success: z.literal(true),
      agentSession: z.object({ id: z.string().min(1) }),
    }),
  }),
});

const IssueSessionsResponseSchema = z.object({
  data: z.object({
    issue: z
      .object({
        agentSessions: z.object({
          nodes: z.array(
            z.object({
              id: z.string().min(1),
              appUser: z.object({ id: z.string().min(1) }),
              externalLinks: z.array(z.object({ label: z.string(), url: z.string().url() })),
            }),
          ),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      })
      .nullable(),
  }),
});
const AgentSessionOnIssueResponseSchema = z.object({
  data: z.object({
    agentSessionCreateOnIssue: z.object({
      success: z.literal(true),
      agentSession: z.object({ id: z.string().min(1) }),
    }),
  }),
});

export interface LinearIssueSessionSummary {
  id: string;
  appUserId: string;
  externalUrls: ReadonlyArray<{ label: string; url: string }>;
}

export interface LinearInstallation {
  linearOrganizationId: string;
  linearOrganizationName: string;
  appUserId: string;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string[];
}

export interface LinearTokenRefresh {
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: Date | null;
  scopes?: string[];
}

export interface LinearConnectionClient {
  authorizationUrl(state: string, mode?: LinearAuthorizationMode): string;
  exchangeCode(code: string, mode?: LinearAuthorizationMode): Promise<LinearInstallation>;
  refresh(refreshToken: string): Promise<LinearTokenRefresh>;
  revoke(accessToken: string): Promise<void>;
}

export interface LinearIssueDetails {
  updatedAt?: string;
  id: string;
  identifier?: string;
  title: string;
  description: string | null;
  url?: string;
  projectId: string | null;
  teamId: string | null;
  stateId: string | null;
  stateType?: string;
  assigneeId: string | null;
  delegateId?: string | null;
  labelIds: string[];
}

export interface LinearIssueComment {
  id: string;
  body: string;
  createdAt: string;
  author: { id: string; name?: string } | null;
}

export interface LinearCommentThread {
  /** The thread root: the comment's parent when it is a reply, otherwise the comment itself. */
  rootId: string;
  /** Distinct authors of the root and its replies: `user.id`, or `botActor.id` without a user. */
  authorIds: string[];
  /**
   * Root comments of the issue's agent-session threads. Linear materializes a session as a
   * comment thread (bot root, human prompts, app responses), so one of these as `rootId` marks
   * a thread the session already handles.
   */
  agentSessionRootIds: string[];
  /** Native session already associated with this root; callers verify the app owner. */
  agentSession?: { id: string; appUserId: string; createdAt?: string } | null;
}

export interface LinearIssueCommentHistory {
  comments: LinearIssueComment[];
  complete: boolean;
}

export type LinearAgentActivityType =
  | "thought"
  | "elicitation"
  | "action"
  | "response"
  | "prompt"
  | "error";

export interface LinearAgentActivity {
  id: string;
  type: LinearAgentActivityType;
  body: string;
  createdAt: string;
  author: { id: string; name?: string } | null;
}

export interface LinearAgentActivityHistory {
  activities: LinearAgentActivity[];
  complete: boolean;
}

export type LinearAgentActivityContent =
  | {
      type: "thought" | "response" | "error" | "elicitation";
      body: string;
    }
  /**
   * What the agent DID, as opposed to what it said. Linear renders it as a labelled step with
   * its parameter, and folds it into the session timeline. `result` is optional because an
   * action is posted when it starts, before its outcome is known.
   */
  | {
      type: "action";
      action: string;
      parameter: string;
      result?: string;
    };

/** Linear renders a `select` elicitation as a choice list built from `signalMetadata.options`. */
export type LinearAgentActivitySignal = "select" | "auth";

export type LinearAgentActivitySignalMetadata =
  | { options: Array<{ label: string; value: string }> }
  | { url: string; userId?: string; providerName?: string };

export interface LinearAgentPlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

export interface LinearApiClient {
  readTeamWorkflowStates?(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    teamId: string;
  }): Promise<Array<{ id: string; type: string }>>;
  readTeamMembers?(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    teamId: string;
  }): Promise<Array<{ id: string; active: boolean; app: boolean }>>;
  updateIssue?(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    issueId: string;
    stateId?: string;
    assigneeId?: string;
  }): Promise<void>;
  /** Complete listing or error; required for safe recovery of issue session creation. */
  readIssueSessions?(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    issueId: string;
  }): Promise<ReadonlyArray<LinearIssueSessionSummary>>;
  /** Caller owns durable reservation: this API has no client-provided session ID. */
  createAgentSessionOnIssue?(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    issueId: string;
    externalUrls: ReadonlyArray<{ label: string; url: string }>;
  }): Promise<{ id: string }>;

  /** Exact-ID reconciliation for durable publication; absent on older custom adapters. */
  readPublishedComment?(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    id: string;
  }): Promise<{ id: string; issueId: string; parentId: string | null; body: string } | undefined>;
  readPublishedAgentActivity?(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    id: string;
  }): Promise<{ id: string; agentSessionId: string; body: string; type: string } | undefined>;
  readIssue(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    issueId: string;
  }): Promise<LinearIssueDetails | undefined>;
  readIssueComments(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    issueId: string;
    beforeCreatedAt: string;
  }): Promise<LinearIssueCommentHistory>;
  readAgentSessionActivities(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    agentSessionId: string;
    beforeCreatedAt: string;
  }): Promise<LinearAgentActivityHistory>;
  /** The thread a comment belongs to; `undefined` when Linear no longer has the comment. */
  readCommentThread(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    commentId: string;
  }): Promise<LinearCommentThread | undefined>;
  createComment(input: {
    /** UUID v4 reserved durably by the caller before the first network request. */
    id?: string;
    linearOrganizationId: string;
    expectedConnectionId?: string;
    issueId: string;
    body: string;
    /** Top-level comment to reply under; Linear rejects a nested comment as parent. */
    parentId?: string;
  }): Promise<void>;
  createAgentActivity(input: {
    id?: string;
    linearOrganizationId: string;
    expectedConnectionId?: string;
    agentSessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
    signal?: LinearAgentActivitySignal;
    signalMetadata?: LinearAgentActivitySignalMetadata;
  }): Promise<void>;
  /**
   * Attaches links to a session — Linear's own way of surfacing an agent's pull request.
   *
   * The URL in a reply is text; here it becomes a first-class field Linear renders, uses for its
   * pull-request features, and treats as proof the session is alive rather than unresponsive.
   */
  updateAgentSessionExternalUrls(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    agentSessionId: string;
    externalUrls: ReadonlyArray<{ label: string; url: string }>;
  }): Promise<void>;
  updateAgentSessionPlan(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    agentSessionId: string;
    plan: ReadonlyArray<LinearAgentPlanStep>;
  }): Promise<void>;
  /** Caller owns authorization, root resolution and durable deduplication. */
  createAgentSessionOnComment(input: {
    linearOrganizationId: string;
    expectedConnectionId?: string;
    commentId: string;
  }): Promise<{ id: string }>;
}

export function hasRequiredLinearScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return granted.has("read") && (granted.has("comments:create") || granted.has("write"));
}

export function hasRequiredLinearAgentSessionScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return LINEAR_AGENT_SESSION_REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

export function linearConnectionRequiresReauthorization(
  connection: Pick<LinearConnectionRecord, "scopes" | "refreshToken" | "accessTokenExpiresAt">,
  now = new Date(),
): boolean {
  return (
    !hasRequiredLinearScopes(connection.scopes) ||
    (connection.refreshToken === null && !hasUsableLinearAccessToken(connection, now))
  );
}

function hasUsableLinearAccessToken(
  connection: Pick<LinearConnectionRecord, "accessTokenExpiresAt">,
  now: Date,
): boolean {
  const expiresAt = connection.accessTokenExpiresAt;
  return (
    expiresAt === null || expiresAt.getTime() > now.getTime() + LINEAR_ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}

export function createLinearConnectionClient(options: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearConnectionClient {
  const request = options.fetch ?? fetch;
  const redirectUri = new URL(
    "/api/integrations/linear/callback",
    options.publicBaseUrl,
  ).toString();
  const now = options.now ?? (() => new Date());

  return {
    authorizationUrl(state, mode = "baseline") {
      const requestedScopes = linearAuthorizationScopes(mode);
      const parameters = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: requestedScopes.join(","),
        state,
        // Keep workflow results visibly attributable to the installed Paseo application instead
        // of impersonating the administrator who completed the connection.
        actor: "app",
      });
      return `https://linear.app/oauth/authorize?${parameters.toString()}`;
    },
    async exchangeCode(code, mode = "baseline") {
      const requestedScopes = linearAuthorizationScopes(mode);
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        },
        now,
      );
      const viewer = await readViewer(request, token.accessToken);
      return {
        linearOrganizationId: viewer.organization.id,
        linearOrganizationName: viewer.organization.name,
        appUserId: viewer.id,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? null,
        accessTokenExpiresAt: token.accessTokenExpiresAt ?? null,
        scopes: token.scopes ?? [...requestedScopes],
      };
    },
    async refresh(refreshToken) {
      const token = await exchangeToken(
        request,
        options,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        },
        now,
      );
      return {
        accessToken: token.accessToken,
        ...(token.refreshToken === undefined ? {} : { refreshToken: token.refreshToken }),
        accessTokenExpiresAt: token.accessTokenExpiresAt ?? null,
        ...(token.scopes === undefined ? {} : { scopes: token.scopes }),
      };
    },
    async revoke(accessToken) {
      const response = await request("https://api.linear.app/oauth/revoke", {
        signal: AbortSignal.timeout(20_000),
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          token: accessToken,
        }),
      });
      if (!response.ok) throw new Error(`Linear revoke HTTP ${response.status}`);
    },
  };
}

function linearAuthorizationScopes(mode: LinearAuthorizationMode): readonly string[] {
  return mode === "agentSessions" ? LINEAR_AGENT_SESSION_REQUIRED_SCOPES : LINEAR_REQUIRED_SCOPES;
}

/**
 * The API client always finds credentials through the external Linear organization ID. That ID is
 * part of signed webhook evidence and output context, while Hub organization IDs remain internal.
 */
export function createLinearApiClient(options: {
  connectionForLinearOrganization(
    linearOrganizationId: string,
  ): Promise<LinearConnectionRecord | undefined>;
  withLinearConnectionRefresh: Database["withLinearConnectionRefresh"];
  connectionClient: Pick<LinearConnectionClient, "refresh">;
  fetch?: typeof fetch;
  now?: () => Date;
}): LinearApiClient {
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  // Avoid duplicate local work, while the database transaction remains the cross-process source of
  // truth for refresh serialization and rebind safety.
  const refreshes = new Map<string, Promise<string>>();

  const hasUsableAccessToken = (connection: LinearConnectionRecord): boolean =>
    hasUsableLinearAccessToken(connection, now());

  const accessTokenFor = async (
    linearOrganizationId: string,
    expectedConnectionId?: string,
  ): Promise<string> => {
    const connection = await options.connectionForLinearOrganization(linearOrganizationId);
    if (connection === undefined) throw new Error("Linear connection unavailable");
    if (expectedConnectionId !== undefined && connection.id !== expectedConnectionId)
      throw new Error("The authorized Linear connection changed before credential lookup");
    if (hasUsableAccessToken(connection)) return connection.accessToken;
    if (connection.refreshToken === null)
      throw new Error("Linear connection requires reauthorization");
    return refreshAccessToken(linearOrganizationId, connection);
  };

  const refreshAccessToken = async (
    linearOrganizationId: string,
    connection: LinearConnectionRecord,
  ): Promise<string> => {
    const existing = refreshes.get(connection.id);
    if (existing !== undefined) return existing;
    const pending = options.withLinearConnectionRefresh(
      linearOrganizationId,
      async (current, updateTokens) => {
        if (current === undefined) throw new Error("Linear connection unavailable");
        if (current.id !== connection.id)
          throw new Error("The authorized Linear connection changed before credential refresh");
        if (hasUsableAccessToken(current)) return current.accessToken;
        if (current.refreshToken === null)
          throw new Error("Linear connection requires reauthorization");
        const refreshed = await options.connectionClient.refresh(current.refreshToken);
        await updateTokens(refreshed);
        return refreshed.accessToken;
      },
    );
    refreshes.set(connection.id, pending);
    try {
      return await pending;
    } finally {
      if (refreshes.get(connection.id) === pending) refreshes.delete(connection.id);
    }
  };

  return {
    async readTeamWorkflowStates(input) {
      const nodes: Array<{ id: string; type: string }> = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = z
          .object({
            data: z.object({
              team: z.object({
                states: z.object({
                  nodes: z.array(z.object({ id: z.string().min(1), type: z.string().min(1) })),
                  pageInfo: z.object({
                    hasNextPage: z.boolean(),
                    endCursor: z.string().nullable(),
                  }),
                }),
              }),
            }),
          })
          .parse(
            await graphql(
              request,
              await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
              {
                query: `query PaseoTeamStates($teamId: String!, $after: String) {
            team(id: $teamId) { states(first: 100, after: $after) { nodes { id type } pageInfo { hasNextPage endCursor } } }
          }`,
                variables: { teamId: input.teamId, after },
              },
            ),
          );
        const states = result.data.team.states;
        nodes.push(...states.nodes);
        if (!states.pageInfo.hasNextPage) return nodes;
        const cursor = states.pageInfo.endCursor;
        if (cursor === null || cursor === after)
          throw new Error("Linear workflow state pagination is incomplete");
        after = cursor;
      }
      throw new Error("Linear workflow state pagination exceeded its limit");
    },
    async readTeamMembers(input) {
      const nodes: Array<{ id: string; active: boolean; app: boolean }> = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = z
          .object({
            data: z.object({
              team: z.object({
                members: z.object({
                  nodes: z.array(
                    z.object({ id: z.string().min(1), active: z.boolean(), app: z.boolean() }),
                  ),
                  pageInfo: z.object({
                    hasNextPage: z.boolean(),
                    endCursor: z.string().nullable(),
                  }),
                }),
              }),
            }),
          })
          .parse(
            await graphql(
              request,
              await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
              {
                query: `query PaseoTeamMembers($teamId: String!, $after: String) {
            team(id: $teamId) { members(first: 100, after: $after) { nodes { id active app } pageInfo { hasNextPage endCursor } } }
          }`,
                variables: { teamId: input.teamId, after },
              },
            ),
          );
        const members = result.data.team.members;
        nodes.push(...members.nodes);
        if (!members.pageInfo.hasNextPage) return nodes;
        const cursor = members.pageInfo.endCursor;
        if (cursor === null || cursor === after)
          throw new Error("Linear team member pagination is incomplete");
        after = cursor;
      }
      throw new Error("Linear team member pagination exceeded its limit");
    },
    async updateIssue(input) {
      if (input.stateId === undefined && input.assigneeId === undefined)
        throw new Error("Linear issue update is empty");
      z.object({ data: z.object({ issueUpdate: z.object({ success: z.literal(true) }) }) }).parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `mutation PaseoFinalizeIssue($issueId: String!, $input: IssueUpdateInput!) { issueUpdate(id: $issueId, input: $input) { success } }`,
            variables: {
              issueId: input.issueId,
              input: {
                ...(input.stateId === undefined ? {} : { stateId: input.stateId }),
                ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
              },
            },
          },
        ),
      );
    },
    async readIssue(input) {
      const result = IssueResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `query PaseoIssue($id: String!) {
            issue(id: $id) {
              id identifier title description url updatedAt
              project { id }
              team { id }
              state { id type }
              assignee { id }
              delegate { id }
              labels { nodes { id } }
            }
          }`,
            variables: { id: input.issueId },
          },
        ),
      );
      const issue = result.data.issue;
      return issue === null
        ? undefined
        : {
            id: issue.id,
            ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
            ...(issue.identifier === undefined ? {} : { identifier: issue.identifier }),
            title: issue.title,
            description: issue.description ?? null,
            ...(issue.url === undefined ? {} : { url: issue.url }),
            projectId: issue.project?.id ?? null,
            teamId: issue.team?.id ?? null,
            stateId: issue.state?.id ?? null,
            ...(issue.state?.type === undefined ? {} : { stateType: issue.state.type }),
            assigneeId: issue.assignee?.id ?? null,
            ...(issue.delegate === undefined ? {} : { delegateId: issue.delegate?.id ?? null }),
            labelIds: issue.labels.nodes.map(({ id }) => id),
          };
    },
    async readIssueComments(input) {
      const result = IssueCommentHistoryResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `query PaseoIssueCommentHistory($issueId: ID!, $before: DateTimeOrDuration!) {
            comments(
              last: ${LINEAR_ISSUE_COMMENT_CONTEXT_LIMIT}
              orderBy: createdAt
              filter: {
                issue: { id: { eq: $issueId } }
                createdAt: { lt: $before }
              }
            ) {
              nodes { id body createdAt user { id name } }
              pageInfo { hasPreviousPage }
            }
          }`,
            variables: { issueId: input.issueId, before: input.beforeCreatedAt },
          },
        ),
      );
      const comments = result.data.comments.nodes
        .map((comment) => ({
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          author:
            comment.user === undefined || comment.user === null
              ? null
              : {
                  id: comment.user.id,
                  ...(comment.user.name === undefined || comment.user.name === null
                    ? {}
                    : { name: comment.user.name }),
                },
        }))
        .sort(compareLinearCommentOrder);
      return {
        comments,
        complete: !result.data.comments.pageInfo.hasPreviousPage,
      };
    },
    async readAgentSessionActivities(input) {
      const result = AgentActivityHistoryResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `query PaseoAgentSessionActivityHistory(
            $agentSessionId: String!
            $before: DateTimeOrDuration!
          ) {
            agentSession(id: $agentSessionId) {
              activities(
                last: ${LINEAR_AGENT_ACTIVITY_CONTEXT_LIMIT}
                orderBy: createdAt
                filter: { createdAt: { lt: $before } }
              ) {
                nodes {
                  id createdAt user { id name }
                  content {
                    __typename
                    ... on AgentActivityThoughtContent { type body }
                    ... on AgentActivityElicitationContent { type body }
                    ... on AgentActivityErrorContent { type body }
                    ... on AgentActivityPromptContent { type body }
                    ... on AgentActivityResponseContent { type body }
                    ... on AgentActivityActionContent { type action parameter result }
                  }
                }
                pageInfo { hasPreviousPage }
              }
            }
          }`,
            variables: {
              agentSessionId: input.agentSessionId,
              before: input.beforeCreatedAt,
            },
          },
        ),
      );
      const activities = result.data.agentSession.activities.nodes
        .map((activity) => ({
          id: activity.id,
          type: activity.content.type,
          body: agentActivityBody(activity.content),
          createdAt: activity.createdAt,
          author: { id: activity.user.id, name: activity.user.name },
        }))
        .sort(compareLinearActivityOrder);
      return {
        activities,
        complete: !result.data.agentSession.activities.pageInfo.hasPreviousPage,
      };
    },
    async readCommentThread(input) {
      const result = CommentThreadResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `query PaseoCommentThread($id: String!) {
            comment(id: $id) {
              id user { id } botActor { id }
              agentSession { id createdAt appUser { id } }
              parent {
                id user { id } botActor { id }
                agentSession { id createdAt appUser { id } }
                children(first: 100) { nodes { user { id } botActor { id } } }
              }
              children(first: 100) { nodes { user { id } botActor { id } } }
              issue { agentSessions(first: 50) { nodes { comment { id } } } }
            }
          }`,
            variables: { id: input.commentId },
          },
        ),
      );
      const comment = result.data.comment;
      if (comment === null) return undefined;
      // Linear threads are one level deep: a reply's parent is the root, and the root's
      // children are the whole thread.
      const root = comment.parent ?? comment;
      const authorIds = new Set<string>();
      for (const author of [root, ...root.children.nodes]) {
        const id = author.user?.id ?? author.botActor?.id ?? undefined;
        if (id !== undefined) authorIds.add(id);
      }
      const agentSessionRootIds = new Set<string>();
      for (const session of comment.issue?.agentSessions.nodes ?? []) {
        if (session.comment !== undefined && session.comment !== null) {
          agentSessionRootIds.add(session.comment.id);
        }
      }
      return {
        rootId: root.id,
        authorIds: [...authorIds],
        agentSessionRootIds: [...agentSessionRootIds],
        ...(root.agentSession === undefined
          ? {}
          : {
              agentSession:
                root.agentSession === null
                  ? null
                  : {
                      id: root.agentSession.id,
                      appUserId: root.agentSession.appUser.id,
                      ...(root.agentSession.createdAt === undefined
                        ? {}
                        : { createdAt: root.agentSession.createdAt }),
                    },
            }),
      };
    },
    async readPublishedComment(input) {
      const result = z
        .object({
          data: z.object({
            comments: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  body: z.string(),
                  issue: z.object({ id: z.string() }).nullable(),
                  parent: z.object({ id: z.string() }).nullable(),
                }),
              ),
            }),
          }),
        })
        .parse(
          await graphql(
            request,
            await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
            {
              query: `query PaseoPublishedComment($id: ID!) {
          comments(filter: { id: { eq: $id } }, first: 1) {
            nodes { id body issue { id } parent { id } }
          }
        }`,
              variables: { id: input.id },
            },
          ),
        );
      const node = result.data.comments.nodes[0];
      if (node === undefined) return undefined;
      if (node.issue === null) throw new Error("Published Linear comment is not an issue comment");
      return {
        id: node.id,
        body: node.body,
        issueId: node.issue.id,
        parentId: node.parent?.id ?? null,
      };
    },
    async readPublishedAgentActivity(input) {
      const result = z
        .object({
          data: z.object({
            agentActivities: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  agentSession: z.object({ id: z.string() }),
                  content: AgentActivityBodyContentSchema,
                }),
              ),
            }),
          }),
        })
        .parse(
          await graphql(
            request,
            await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
            {
              query: `query PaseoPublishedAgentActivity($id: ID!) {
          agentActivities(filter: { id: { eq: $id } }, first: 1) {
            nodes { id agentSession { id } content {
              __typename
              ... on AgentActivityResponseContent { type body }
              ... on AgentActivityElicitationContent { type body }
              ... on AgentActivityErrorContent { type body }
            } }
          }
        }`,
              variables: { id: input.id },
            },
          ),
        );
      const node = result.data.agentActivities.nodes[0];
      return node === undefined
        ? undefined
        : {
            id: node.id,
            agentSessionId: node.agentSession.id,
            type: node.content.type,
            body: node.content.body,
          };
    },
    async createComment(input) {
      const result = CommentResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `mutation PaseoComment($id: String, $issueId: String!, $body: String!, $parentId: String) {
            commentCreate(input: { id: $id, issueId: $issueId, body: $body, parentId: $parentId }) {
              success
            }
          }`,
            variables: {
              ...(input.id === undefined ? {} : { id: input.id }),
              issueId: input.issueId,
              body: input.body,
              ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
            },
          },
        ),
      );
      if (!result.data.commentCreate.success) throw new Error("Linear comment was not accepted");
    },
    async createAgentActivity(input) {
      const result = AgentActivityResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `mutation PaseoAgentActivity(
            $id: String
            $agentSessionId: String!
            $content: JSONObject!
            $ephemeral: Boolean
            $signal: AgentActivitySignal
            $signalMetadata: JSONObject
          ) {
            agentActivityCreate(input: {
              id: $id
              agentSessionId: $agentSessionId
              content: $content
              ephemeral: $ephemeral
              signal: $signal
              signalMetadata: $signalMetadata
            }) { success }
          }`,
            variables: {
              ...(input.id === undefined ? {} : { id: input.id }),
              agentSessionId: input.agentSessionId,
              content: input.content,
              ...(input.ephemeral === undefined ? {} : { ephemeral: input.ephemeral }),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
              ...(input.signalMetadata === undefined
                ? {}
                : { signalMetadata: input.signalMetadata }),
            },
          },
        ),
      );
      if (!result.data.agentActivityCreate.success) {
        throw new Error("Linear agent activity was not accepted");
      }
    },
    async updateAgentSessionExternalUrls(input) {
      const result = AgentSessionUpdateResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `mutation PaseoAgentSessionUrls($id: String!, $externalUrls: [AgentSessionExternalUrlInput!]) {
            agentSessionUpdate(id: $id, input: { addedExternalUrls: $externalUrls }) { success }
          }`,
            variables: {
              id: input.agentSessionId,
              externalUrls: input.externalUrls.map((entry) => ({
                label: entry.label,
                url: entry.url,
              })),
            },
          },
        ),
      );
      if (!result.data.agentSessionUpdate.success) {
        throw new Error("Linear agent session update was not accepted");
      }
    },
    async updateAgentSessionPlan(input) {
      const result = AgentSessionUpdateResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `mutation PaseoAgentSessionPlan($id: String!, $plan: JSONObject!) {
            agentSessionUpdate(id: $id, input: { plan: $plan }) { success }
          }`,
            variables: { id: input.agentSessionId, plan: input.plan },
          },
        ),
      );
      if (!result.data.agentSessionUpdate.success) {
        throw new Error("Linear agent session plan was not accepted");
      }
    },
    async readIssueSessions(input) {
      const sessions: LinearIssueSessionSummary[] = [];
      const seen = new Set<string>();
      let after: string | null = null;
      // Refuse an incomplete listing. The caller must never interpret truncation as no match.
      for (let page = 0; page < 100; page += 1) {
        const result = IssueSessionsResponseSchema.parse(
          await graphql(
            request,
            await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
            {
              query: `query PaseoIssueSessions($id: String!, $after: String) {
            issue(id: $id) { agentSessions(first: 100, after: $after, includeArchived: true) {
              nodes { id appUser { id } externalLinks { label url } }
              pageInfo { hasNextPage endCursor }
            } }
          }`,
              variables: { id: input.issueId, after },
            },
          ),
        );
        if (result.data.issue === null)
          throw new Error("Linear issue disappeared while reading its sessions");
        const connection = result.data.issue.agentSessions;
        for (const session of connection.nodes)
          sessions.push({
            id: session.id,
            appUserId: session.appUser.id,
            externalUrls: session.externalLinks,
          });
        if (!connection.pageInfo.hasNextPage) return sessions;
        const next = connection.pageInfo.endCursor;
        if (!next || seen.has(next))
          throw new Error("Linear issue session pagination did not advance");
        seen.add(next);
        after = next;
      }
      throw new Error("Linear issue session listing exceeds the safe pagination limit");
    },
    async createAgentSessionOnIssue(input) {
      const result = AgentSessionOnIssueResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `mutation PaseoAgentSessionOnIssue($input: AgentSessionCreateOnIssue!) {
          agentSessionCreateOnIssue(input: $input) { success agentSession { id } }
        }`,
            variables: { input: { issueId: input.issueId, externalUrls: input.externalUrls } },
          },
        ),
      );
      return result.data.agentSessionCreateOnIssue.agentSession;
    },
    async createAgentSessionOnComment(input) {
      const result = AgentSessionCreateResponseSchema.parse(
        await graphql(
          request,
          await accessTokenFor(input.linearOrganizationId, input.expectedConnectionId),
          {
            query: `mutation PaseoAgentSessionOnComment($input: AgentSessionCreateOnComment!) {
            agentSessionCreateOnComment(input: $input) { success agentSession { id } }
          }`,
            variables: { input: { commentId: input.commentId } },
          },
        ),
      );
      return result.data.agentSessionCreateOnComment.agentSession;
    },
  };
}

function compareLinearCommentOrder(
  left: Pick<LinearIssueComment, "createdAt" | "id">,
  right: Pick<LinearIssueComment, "createdAt" | "id">,
): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function compareLinearActivityOrder(
  left: Pick<LinearAgentActivity, "createdAt" | "id">,
  right: Pick<LinearAgentActivity, "createdAt" | "id">,
): number {
  const byCreatedAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return byCreatedAt === 0 ? left.id.localeCompare(right.id) : byCreatedAt;
}

function agentActivityBody(
  content:
    | z.infer<typeof AgentActivityBodyContentSchema>
    | z.infer<typeof AgentActivityActionContentSchema>,
): string {
  if (content.type !== "action") return content.body;
  const invocation = `${content.action}: ${content.parameter}`;
  return content.result === undefined || content.result === null || content.result.length === 0
    ? invocation
    : `${invocation}\n\n${content.result}`;
}

async function exchangeToken(
  request: typeof fetch,
  options: Pick<Parameters<typeof createLinearConnectionClient>[0], "clientId" | "clientSecret">,
  values: Record<string, string>,
  now: () => Date,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
  scopes?: string[];
}> {
  const response = await request("https://api.linear.app/oauth/token", {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      ...values,
    }),
  });
  if (!response.ok) throw new Error(`Linear OAuth HTTP ${response.status}`);
  const token = LinearTokenResponseSchema.parse(await response.json());
  return {
    accessToken: token.access_token,
    ...(token.refresh_token === undefined ? {} : { refreshToken: token.refresh_token }),
    ...(token.expires_in === undefined
      ? {}
      : { accessTokenExpiresAt: new Date(now().getTime() + token.expires_in * 1_000) }),
    ...(token.scope === undefined ? {} : { scopes: parseLinearScopes(token.scope) }),
  };
}

async function readViewer(request: typeof fetch, accessToken: string) {
  const result = ViewerResponseSchema.parse(
    await graphql(request, accessToken, {
      query: `query PaseoViewer { viewer { id organization { id name } } }`,
      variables: {},
    }),
  );
  return result.data.viewer;
}

async function graphql(
  request: typeof fetch,
  accessToken: string,
  payload: { query: string; variables: Record<string, unknown> },
): Promise<unknown> {
  const response = await request("https://api.linear.app/graphql", {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
  const result: unknown = await response.json();
  const errors = GraphqlErrorSchema.safeParse(result);
  if (errors.success && errors.data.errors !== undefined) {
    throw new Error(`Linear GraphQL ${errors.data.errors[0]!.message}`);
  }
  return result;
}

function parseLinearScopes(scope: string | undefined): string[] {
  return [
    ...new Set(
      (scope ?? "")
        .split(/[\s,]+/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}
