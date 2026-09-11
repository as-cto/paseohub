import type { AgentExecutionRecord, AgentExecutionOutputAttempt } from "./types.js";
import { randomUUID } from "node:crypto";
import type { LinearIssueFinalizationPolicy } from "./linear-finalizations.js";
import type { AgentExecutionRow } from "./pg.js";
import { toAgentExecutionRecord } from "./mappers.js";
import type { DatabaseRuntime, QueryRow } from "./runtime/index.js";
import type {
  LinearAgentActivitySignal,
  LinearAgentActivitySignalMetadata,
} from "../providers/linear/client.js";

export interface LinearFinalOutcome {
  kind: "ready_for_review" | "completed" | "needs_input" | "blocked" | "interrupted" | "no_action";
  validation: string;
  nextAction: string;
  assigneeId?: string;
}

export interface LinearReplyPayload {
  finalizeIssue?: LinearIssueFinalizationPolicy;
  organizationId: string;
  projectId: string;
  connectionId: string;
  applicationId: string | null;
  linearOrganizationId: string;
  issueId: string;
  agentSessionId: string | null;
  commentId: string;
  activityId: string | null;
  body: string;
  activity: {
    content: { type: "response" | "elicitation" | "error"; body: string };
    signal?: LinearAgentActivitySignal;
    signalMetadata?: LinearAgentActivitySignalMetadata;
  };
  outcome?: LinearFinalOutcome;
}

export interface LinearReplyDelivery {
  id: string;
  executionId: string;
  /** Initial executions have no turn ID. Subsequent input IDs are namespaced. */
  turnKey: string;
  attemptId: string;
  payload: LinearReplyPayload;
  createdAt: Date;
  commentConfirmedAt: Date | null;
  activityConfirmedAt: Date | null;
  completedAt: Date | null;
  supersededAt: Date | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date;
  attempts: number;
  lastError: string | null;
}

export type ReserveLinearReply = Pick<
  LinearReplyDelivery,
  "id" | "executionId" | "turnKey" | "attemptId" | "payload" | "createdAt"
>;
export interface LinearReplyDeliveryStore {
  beginTerminalLinearReplyAttempt(
    executionId: string,
    expectedTurnKey: string,
    now: Date,
  ): Promise<AgentExecutionOutputAttempt | undefined>;
  listTerminalLinearReplyCandidates(applicationId: string, limit: number): Promise<string[]>;
  reserveLinearReply(input: ReserveLinearReply): Promise<LinearReplyDelivery>;
  findLinearReply(executionId: string, turnKey: string): Promise<LinearReplyDelivery | undefined>;
  listPendingLinearReplies(
    applicationId: string,
    now: Date,
    limit: number,
  ): Promise<LinearReplyDelivery[]>;
  claimLinearReply(
    id: string,
    leaseId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<LinearReplyDelivery | undefined>;
  confirmLinearReplyDestination(
    id: string,
    destination: "comment" | "activity",
    now: Date,
  ): Promise<void>;
  retryLinearReply(id: string, leaseId: string, nextAttemptAt: Date, error: string): Promise<void>;
  supersedeLinearReply(id: string, now: Date): Promise<void>;
  acknowledgeLinearReply(id: string, now: Date): Promise<void>;
}

export function linearReplyTurnKey(turnId: string | undefined): string {
  return turnId === undefined ? "initial" : `turn:${turnId}`;
}

export function newLinearReply(input: ReserveLinearReply): LinearReplyDelivery {
  return {
    ...input,
    commentConfirmedAt: null,
    activityConfirmedAt: null,
    completedAt: null,
    supersededAt: null,
    leaseId: null,
    leaseExpiresAt: null,
    nextAttemptAt: input.createdAt,
    attempts: 0,
    lastError: null,
  };
}

/** Both destinations precede the one canonical output acknowledgement, even after its lease expires. */
export function acknowledgeLinearReplyExecution(
  record: LinearReplyDelivery,
  execution: AgentExecutionRecord,
  now: Date,
): AgentExecutionRecord {
  const attempt = execution.outputDeliveryAttempts[record.attemptId];
  if (
    record.commentConfirmedAt === null ||
    (record.payload.agentSessionId !== null && record.activityConfirmedAt === null) ||
    record.supersededAt !== null ||
    execution.organizationId !== record.payload.organizationId ||
    execution.projectId !== record.payload.projectId ||
    attempt?.outputType !== "linear.reply" ||
    linearReplyTurnKey(attempt.turnId) !== record.turnKey
  ) {
    throw new Error("Linear reply acknowledgement does not match its durable delivery and turn");
  }
  if (record.completedAt !== null) return execution;
  if (attempt.status === "succeeded")
    throw new Error("Linear reply attempt was acknowledged outside its journal");
  return {
    ...execution,
    outputEmissions: {
      ...execution.outputEmissions,
      "linear.reply": (execution.outputEmissions["linear.reply"] ?? 0) + 1,
    },
    outputDeliveryAttempts: {
      ...execution.outputDeliveryAttempts,
      [attempt.id]: { ...attempt, status: "succeeded", completedAt: now },
    },
  };
}

interface ReplyRow extends QueryRow {
  id: string;
  execution_id: string;
  turn_key: string;
  attempt_id: string;
  payload: LinearReplyPayload;
  created_at: Date;
  comment_confirmed_at: Date | null;
  activity_confirmed_at: Date | null;
  completed_at: Date | null;
  superseded_at: Date | null;
  lease_id: string | null;
  lease_expires_at: Date | null;
  next_attempt_at: Date;
  attempts: number;
  last_error: string | null;
}
function fromRow(row: ReplyRow): LinearReplyDelivery {
  return {
    id: row.id,
    executionId: row.execution_id,
    turnKey: row.turn_key,
    attemptId: row.attempt_id,
    payload: row.payload,
    createdAt: row.created_at,
    commentConfirmedAt: row.comment_confirmed_at,
    activityConfirmedAt: row.activity_confirmed_at,
    completedAt: row.completed_at,
    supersededAt: row.superseded_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    attempts: row.attempts,
    lastError: row.last_error,
  };
}

export class LinearReplyRepository {
  constructor(private readonly database: DatabaseRuntime) {}

  async beginTerminalAttempt(
    executionId: string,
    expectedTurnKey: string,
    now: Date,
  ): Promise<AgentExecutionOutputAttempt | undefined> {
    return this.database.transaction(async (tx) => {
      const rows = await tx.query<AgentExecutionRow>(
        "select * from agent_executions where id=$1 for update",
        [executionId],
      );
      if (rows.rows[0] === undefined) return undefined;
      const execution = toAgentExecutionRecord(rows.rows[0]);
      const attempt = terminalLinearReplyAttempt(execution, expectedTurnKey, now);
      if (attempt === undefined) return undefined;
      await tx.query("update agent_executions set output_delivery_attempts=$2::jsonb where id=$1", [
        executionId,
        JSON.stringify({ ...execution.outputDeliveryAttempts, [attempt.id]: attempt }),
      ]);
      return attempt;
    });
  }
  async listTerminalCandidates(applicationId: string, limit: number): Promise<string[]> {
    const rows = await this.database.query<{ id: string }>(
      `select e.id from agent_executions e
      join linear_connections c on c.organization_id=e.organization_id
        and c.linear_organization_id=e.output_context->>'linearOrganizationId'
      where c.provider_application_id=$1 and e.status in ('succeeded','failed')
        and e.trigger_context->>'provider'='linear'
        and c.id::text=(e.trigger_context#>>'{event,linear,connection_id}')
        and (e.output_context->>'linearOrganizationId')=(e.trigger_context#>>'{event,linear,organization,id}')
        and (e.output_context->>'issueId')=(e.trigger_context#>>'{event,linear,issue,id}')
        and e.output_context->>'provider'='linear' and e.output_context->>'publishIssueComment'='true'
        and not exists (select 1 from linear_reply_deliveries r where r.execution_id=e.id
          and r.turn_key=case when e.hub_action_acknowledgements->'turn'->>'id' is null then 'initial'
            else 'turn:' || (e.hub_action_acknowledgements->'turn'->>'id') end)
      order by e.completed_at, e.id limit $2`,
      [applicationId, limit],
    );
    return rows.rows.map((row) => row.id);
  }

  async reserve(input: ReserveLinearReply): Promise<LinearReplyDelivery> {
    await this.database.query(
      `insert into linear_reply_deliveries
      (id, execution_id, turn_key, attempt_id, application_id, payload, created_at, next_attempt_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)
      on conflict (execution_id, turn_key) do nothing`,
      [
        input.id,
        input.executionId,
        input.turnKey,
        input.attemptId,
        input.payload.applicationId,
        JSON.stringify(input.payload),
        input.createdAt,
      ],
    );
    const found = await this.find(input.executionId, input.turnKey);
    if (found === undefined) throw new Error("Linear reply reservation was not persisted");
    return found;
  }
  async find(executionId: string, turnKey: string): Promise<LinearReplyDelivery | undefined> {
    const rows = await this.database.query<ReplyRow>(
      "select * from linear_reply_deliveries where execution_id=$1 and turn_key=$2",
      [executionId, turnKey],
    );
    return rows.rows[0] === undefined ? undefined : fromRow(rows.rows[0]);
  }
  async listPending(
    applicationId: string,
    now: Date,
    limit: number,
  ): Promise<LinearReplyDelivery[]> {
    const rows = await this.database.query<ReplyRow>(
      `select * from linear_reply_deliveries
      where application_id=$1 and completed_at is null and superseded_at is null and next_attempt_at <= $2
      and not exists (select 1 from linear_issue_finalizations f where f.reply_id=linear_reply_deliveries.id and f.status in ('refused','ambiguous'))
      and (lease_expires_at is null or lease_expires_at <= $2) order by next_attempt_at, created_at limit $3`,
      [applicationId, now, limit],
    );
    return rows.rows.map(fromRow);
  }
  async claim(
    id: string,
    leaseId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<LinearReplyDelivery | undefined> {
    const rows = await this.database.query<ReplyRow>(
      `update linear_reply_deliveries
      set lease_id=$2,lease_expires_at=$4,attempts=attempts+1 where id=$1 and completed_at is null
      and superseded_at is null and (lease_expires_at is null or lease_expires_at <= $3) returning *`,
      [id, leaseId, now, leaseExpiresAt],
    );
    return rows.rows[0] === undefined ? undefined : fromRow(rows.rows[0]);
  }
  async confirm(id: string, destination: "comment" | "activity", now: Date): Promise<void> {
    const column = destination === "comment" ? "comment_confirmed_at" : "activity_confirmed_at";
    await this.database.query(
      `update linear_reply_deliveries set ${column}=coalesce(${column}, $2) where id=$1`,
      [id, now],
    );
  }
  async retry(id: string, leaseId: string, nextAttemptAt: Date, error: string): Promise<void> {
    await this.database.query(
      `update linear_reply_deliveries set next_attempt_at=$3,last_error=$4,lease_id=null,lease_expires_at=null
      where id=$1 and lease_id=$2 and completed_at is null and superseded_at is null`,
      [id, leaseId, nextAttemptAt, error],
    );
  }
  async supersede(id: string, now: Date): Promise<void> {
    await this.database.query(
      `update linear_reply_deliveries set superseded_at=$2,last_error='Native response superseded by a newer turn',lease_id=null,lease_expires_at=null
      where id=$1 and completed_at is null and comment_confirmed_at is not null`,
      [id, now],
    );
  }
  async acknowledge(id: string, now: Date): Promise<void> {
    await this.database.transaction(async (tx) => {
      const result = await tx.query<ReplyRow>(
        "select * from linear_reply_deliveries where id=$1 for update",
        [id],
      );
      if (result.rows[0] === undefined) throw new Error("Linear reply journal is missing");
      const reply = fromRow(result.rows[0]);
      const rows = await tx.query<AgentExecutionRow>(
        "select * from agent_executions where id=$1 for update",
        [reply.executionId],
      );
      if (rows.rows[0] === undefined) throw new Error("Linear reply execution is missing");
      const execution = acknowledgeLinearReplyExecution(
        reply,
        toAgentExecutionRecord(rows.rows[0]),
        now,
      );
      await tx.query(
        "update agent_executions set output_emissions=$2::jsonb,output_delivery_attempts=$3::jsonb where id=$1",
        [
          execution.id,
          JSON.stringify(execution.outputEmissions),
          JSON.stringify(execution.outputDeliveryAttempts),
        ],
      );
      await tx.query(
        "update linear_reply_deliveries set completed_at=coalesce(completed_at,$2),last_error=null,lease_id=null,lease_expires_at=null where id=$1",
        [id, now],
      );
    });
  }
}

export function terminalLinearReplyAttempt(
  execution: AgentExecutionRecord,
  expectedTurnKey: string,
  now: Date,
): AgentExecutionOutputAttempt | undefined {
  if (
    (execution.status !== "failed" && execution.status !== "succeeded") ||
    linearReplyTurnKey(execution.hubActionAcknowledgements.turn?.id) !== expectedTurnKey ||
    typeof execution.outputContext !== "object" ||
    execution.outputContext === null ||
    Reflect.get(execution.outputContext, "provider") !== "linear" ||
    Reflect.get(execution.outputContext, "publishIssueComment") !== true
  )
    return undefined;
  const turnId = execution.hubActionAcknowledgements.turn?.id;
  return {
    id: randomUUID(),
    outputType: "linear.reply",
    status: "pending",
    startedAt: now,
    leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
    completedAt: null,
    ...(turnId === undefined ? {} : { turnId }),
  };
}
