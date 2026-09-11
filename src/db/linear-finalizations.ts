import type { DatabaseRuntime, QueryRow } from "./runtime/index.js";

export interface LinearIssueFinalizationPolicy {
  teamId: string;
  reviewStateId: string;
  completedStateId: string;
  waitingStateId?: string;
  allowedAssigneeIds?: readonly string[];
}
export interface LinearIssueFinalization {
  replyId: string;
  target: { stateId?: string; assigneeId?: string };
  previous: { stateId: string | null; assigneeId: string | null };
  status: "pending" | "applied" | "skipped" | "ambiguous" | "refused";
  detail: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
export type ReserveLinearFinalization = Pick<
  LinearIssueFinalization,
  "replyId" | "target" | "previous" | "createdAt"
>;
export interface LinearFinalizationStore {
  reserveLinearFinalization(input: ReserveLinearFinalization): Promise<LinearIssueFinalization>;
  findLinearFinalization(replyId: string): Promise<LinearIssueFinalization | undefined>;
  startLinearFinalization(replyId: string, now: Date): Promise<boolean>;
  completeLinearFinalization(
    replyId: string,
    status: Exclude<LinearIssueFinalization["status"], "pending">,
    detail: string,
    now: Date,
  ): Promise<void>;
}
interface FinalizationRow extends QueryRow {
  reply_id: string;
  target: LinearIssueFinalization["target"];
  previous: LinearIssueFinalization["previous"];
  status: LinearIssueFinalization["status"];
  detail: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}
function fromRow(row: FinalizationRow): LinearIssueFinalization {
  return {
    replyId: row.reply_id,
    target: row.target,
    previous: row.previous,
    status: row.status,
    detail: row.detail,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}
export class LinearFinalizationRepository {
  constructor(private readonly database: DatabaseRuntime) {}
  async reserve(input: ReserveLinearFinalization): Promise<LinearIssueFinalization> {
    await this.database.query(
      `insert into linear_issue_finalizations (reply_id,target,previous,created_at)
      values ($1,$2::jsonb,$3::jsonb,$4) on conflict (reply_id) do nothing`,
      [
        input.replyId,
        JSON.stringify(input.target),
        JSON.stringify(input.previous),
        input.createdAt,
      ],
    );
    const found = await this.find(input.replyId);
    if (found === undefined) throw new Error("Linear issue finalization was not persisted");
    return found;
  }
  async find(replyId: string): Promise<LinearIssueFinalization | undefined> {
    const result = await this.database.query<FinalizationRow>(
      "select * from linear_issue_finalizations where reply_id=$1",
      [replyId],
    );
    return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
  }
  async start(replyId: string, now: Date): Promise<boolean> {
    const result = await this.database.query(
      "update linear_issue_finalizations set started_at=$2 where reply_id=$1 and status='pending' and started_at is null",
      [replyId, now],
    );
    return result.rowCount === 1;
  }
  async complete(
    replyId: string,
    status: Exclude<LinearIssueFinalization["status"], "pending">,
    detail: string,
    now: Date,
  ): Promise<void> {
    await this.database.query(
      "update linear_issue_finalizations set status=$2,detail=$3,completed_at=$4 where reply_id=$1 and status='pending'",
      [replyId, status, detail, now],
    );
  }
}
