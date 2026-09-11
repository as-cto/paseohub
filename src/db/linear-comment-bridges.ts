import type {
  LinearCommentBridgeClaim,
  LinearCommentBridgeKey,
  LinearCommentBridgeRecord,
} from "./types.js";
import type { DatabaseRuntime, QueryRow } from "./runtime/index.js";

export function linearCommentBridgeKey(key: LinearCommentBridgeKey): string {
  return JSON.stringify([
    key.organizationId,
    key.projectId,
    key.connectionId,
    key.linearOrganizationId,
    key.rootCommentId,
  ]);
}

function parameters(key: LinearCommentBridgeKey): string[] {
  return [
    key.organizationId,
    key.projectId,
    key.connectionId,
    key.linearOrganizationId,
    key.rootCommentId,
  ];
}

const whereKey =
  "organization_id=$1 and project_id=$2 and connection_id=$3 and linear_organization_id=$4 and root_comment_id=$5";

interface BridgeRow extends QueryRow {
  organization_id: string;
  project_id: string;
  connection_id: string;
  linear_organization_id: string;
  root_comment_id: string;
  app_user_id: string;
  provider_event_receipt_id: string;
  source_comment_id: string;
  source_actor_id: string;
  source_body: string;
  session_id: string | null;
  creation_started_at: Date | null;
  lease_id: string;
  lease_expires_at: Date;
}

function record(row: BridgeRow): LinearCommentBridgeRecord {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    linearOrganizationId: row.linear_organization_id,
    rootCommentId: row.root_comment_id,
    appUserId: row.app_user_id,
    providerEventReceiptId: row.provider_event_receipt_id,
    sourceCommentId: row.source_comment_id,
    sourceActorId: row.source_actor_id,
    sourceBody: row.source_body,
    sessionId: row.session_id,
    creationStartedAt: row.creation_started_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export class LinearCommentBridgeRepository {
  constructor(private readonly database: DatabaseRuntime) {}

  async find(key: LinearCommentBridgeKey): Promise<LinearCommentBridgeRecord | undefined> {
    const result = await this.database.query<BridgeRow>(
      `select * from linear_comment_bridges where ${whereKey}`,
      parameters(key),
    );
    return result.rows[0] === undefined ? undefined : record(result.rows[0]);
  }

  async claim(
    input: LinearCommentBridgeClaim,
  ): Promise<{ bridge: LinearCommentBridgeRecord; claimed: boolean }> {
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into linear_comment_bridges
        (organization_id,project_id,connection_id,linear_organization_id,root_comment_id,app_user_id,
         provider_event_receipt_id,source_comment_id,source_actor_id,source_body,lease_id,lease_expires_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict (organization_id,project_id,connection_id,linear_organization_id,root_comment_id) do nothing`,
        [
          ...parameters(input),
          input.appUserId,
          input.providerEventReceiptId,
          input.sourceCommentId,
          input.sourceActorId,
          input.sourceBody,
          input.leaseId,
          input.leaseExpiresAt,
        ],
      );
      // The insert conflict waits for the competing transaction. Only an expired lease can be
      // taken over; even a replay of the same receipt needs its own fresh claim.
      await transaction.query(
        `update linear_comment_bridges set lease_id=$6, lease_expires_at=$7
        where ${whereKey} and session_id is null and lease_expires_at <= $8`,
        [...parameters(input), input.leaseId, input.leaseExpiresAt, input.now],
      );
      const found = await transaction.query<BridgeRow>(
        `select * from linear_comment_bridges where ${whereKey}`,
        parameters(input),
      );
      if (found.rows[0] === undefined)
        throw new Error("Linear bridge reservation was not persisted");
      const bridge = record(found.rows[0]);
      return { bridge, claimed: bridge.sessionId === null && bridge.leaseId === input.leaseId };
    });
  }

  async bind(key: LinearCommentBridgeKey, sessionId: string): Promise<LinearCommentBridgeRecord> {
    // First observed provider success wins. A late response cannot replace a session already
    // bound by its webhook while the original HTTP request was still in flight.
    await this.database.query(
      `update linear_comment_bridges set session_id=$6
      where ${whereKey} and session_id is null`,
      [...parameters(key), sessionId],
    );
    const found = await this.find(key);
    if (found === undefined) throw new Error("Linear bridge reservation is missing");
    return found;
  }

  async startCreation(key: LinearCommentBridgeKey, leaseId: string, now: Date): Promise<boolean> {
    const result = await this.database.query(
      `update linear_comment_bridges set creation_started_at=$7
       where ${whereKey} and lease_id=$6 and lease_expires_at>$7
       and session_id is null and creation_started_at is null`,
      [...parameters(key), leaseId, now],
    );
    return result.rowCount === 1;
  }
}
