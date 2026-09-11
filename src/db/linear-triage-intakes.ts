import { z } from "zod";
import type { DatabaseRuntime, QueryRow } from "./runtime/index.js";

export interface LinearTriageIntakeKey {
  organizationId: string;
  projectId: string;
  connectionId: string;
  linearOrganizationId: string;
  issueId: string;
}
const SourceSchema = z.object({
  eventKey: z.string(),
  actorId: z.string(),
  teamId: z.string(),
  triageStateId: z.string(),
  stateId: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
const StatusSchema = z.enum(["reserved", "attempted", "applied", "ignored", "ambiguous"]);
export type LinearTriageIntakeStatus = z.infer<typeof StatusSchema>;
export interface LinearTriageIntakeRecord extends LinearTriageIntakeKey {
  providerEventReceiptId: string;
  source: z.infer<typeof SourceSchema>;
  status: LinearTriageIntakeStatus;
  reason: string | null;
  attemptStartedAt: Date | null;
  leaseId: string;
  leaseExpiresAt: Date;
}
export interface LinearTriageIntakeClaim extends Omit<
  LinearTriageIntakeRecord,
  "status" | "reason" | "attemptStartedAt"
> {
  now: Date;
}
export interface LinearTriageIntakeSettlement {
  status: "applied" | "ignored" | "ambiguous";
  reason: string;
}
export interface LinearTriageIntakeStore {
  findLinearTriageIntake(key: LinearTriageIntakeKey): Promise<LinearTriageIntakeRecord | undefined>;
  claimLinearTriageIntake(
    input: LinearTriageIntakeClaim,
  ): Promise<{ record: LinearTriageIntakeRecord; claimed: boolean }>;
  startLinearTriageIntake(key: LinearTriageIntakeKey, leaseId: string, now: Date): Promise<boolean>;
  settleLinearTriageIntake(
    key: LinearTriageIntakeKey,
    leaseId: string,
    outcome: LinearTriageIntakeSettlement,
  ): Promise<LinearTriageIntakeRecord>;
}
function parameters(key: LinearTriageIntakeKey) {
  return [
    key.organizationId,
    key.projectId,
    key.connectionId,
    key.linearOrganizationId,
    key.issueId,
  ];
}
export function linearTriageIntakeKey(key: LinearTriageIntakeKey) {
  return JSON.stringify(parameters(key));
}
const whereKey =
  "organization_id=$1 and project_id=$2 and connection_id=$3 and linear_organization_id=$4 and issue_id=$5";
interface IntakeRow extends QueryRow {
  organization_id: string;
  project_id: string;
  connection_id: string;
  linear_organization_id: string;
  issue_id: string;
  provider_event_receipt_id: string;
  source: unknown;
  status: string;
  reason: string | null;
  attempt_started_at: Date | null;
  lease_id: string;
  lease_expires_at: Date;
}
function record(row: IntakeRow): LinearTriageIntakeRecord {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    linearOrganizationId: row.linear_organization_id,
    issueId: row.issue_id,
    providerEventReceiptId: row.provider_event_receipt_id,
    source: SourceSchema.parse(row.source),
    status: StatusSchema.parse(row.status),
    reason: row.reason,
    attemptStartedAt: row.attempt_started_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
  };
}
export class LinearTriageIntakeRepository {
  constructor(private readonly database: DatabaseRuntime) {}
  async find(key: LinearTriageIntakeKey) {
    const rows = await this.database.query<IntakeRow>(
      `select * from linear_triage_intakes where ${whereKey}`,
      parameters(key),
    );
    return rows.rows[0] === undefined ? undefined : record(rows.rows[0]);
  }
  async claim(input: LinearTriageIntakeClaim) {
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into linear_triage_intakes
        (organization_id,project_id,connection_id,linear_organization_id,issue_id,provider_event_receipt_id,source,status,lease_id,lease_expires_at)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb,'reserved',$8,$9)
        on conflict (organization_id,project_id,connection_id,linear_organization_id,issue_id) do nothing`,
        [
          ...parameters(input),
          input.providerEventReceiptId,
          JSON.stringify(input.source),
          input.leaseId,
          input.leaseExpiresAt,
        ],
      );
      await transaction.query(
        `update linear_triage_intakes set lease_id=$6,lease_expires_at=$7
        where ${whereKey} and status not in ('applied','ignored') and lease_expires_at <= $8`,
        [...parameters(input), input.leaseId, input.leaseExpiresAt, input.now],
      );
      const result = await transaction.query<IntakeRow>(
        `select * from linear_triage_intakes where ${whereKey}`,
        parameters(input),
      );
      if (result.rows[0] === undefined)
        throw new Error("Linear intake reservation was not persisted");
      const found = record(result.rows[0]);
      return {
        record: found,
        claimed: !["applied", "ignored"].includes(found.status) && found.leaseId === input.leaseId,
      };
    });
  }
  async start(key: LinearTriageIntakeKey, leaseId: string, now: Date) {
    const result = await this.database.query(
      `update linear_triage_intakes set status='attempted',attempt_started_at=$7
      where ${whereKey} and lease_id=$6 and lease_expires_at>$7 and status='reserved' and attempt_started_at is null`,
      [...parameters(key), leaseId, now],
    );
    return result.rowCount === 1;
  }
  async settle(key: LinearTriageIntakeKey, leaseId: string, outcome: LinearTriageIntakeSettlement) {
    await this.database.query(
      `update linear_triage_intakes set status=$7,reason=$8
      where ${whereKey} and status not in ('applied','ignored') and (lease_id=$6 or ($7='applied' and attempt_started_at is not null))`,
      [...parameters(key), leaseId, outcome.status, outcome.reason],
    );
    const found = await this.find(key);
    if (found === undefined) throw new Error("Linear intake reservation is missing");
    return found;
  }
}
