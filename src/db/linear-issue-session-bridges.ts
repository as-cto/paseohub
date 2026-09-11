import type { DatabaseRuntime, QueryRow } from "./runtime/index.js";

/** An issue event has its own durable identity; it is never represented as a fake comment. */
export interface LinearIssueSessionBridgeKey {
  organizationId: string;
  projectId: string;
  connectionId: string;
  linearOrganizationId: string;
  issueId: string;
  eventKey: string;
}

export interface LinearIssueSessionBridgeRecord extends LinearIssueSessionBridgeKey {
  appUserId: string;
  providerEventReceiptId: string;
  sourceActorId: string;
  sourceBody: string;
  markerUrl: string;
  sessionId: string | null;
  creationStartedAt: Date | null;
  leaseId: string;
  leaseExpiresAt: Date;
}

export interface LinearIssueSessionBridgeClaim extends Omit<
  LinearIssueSessionBridgeRecord,
  "sessionId" | "creationStartedAt"
> {
  now: Date;
}

export type LinearIssueSessionBridgeScope = Omit<LinearIssueSessionBridgeKey, "eventKey"> & {
  appUserId: string;
};

export interface LinearIssueSessionBridgeStore {
  findLinearIssueSessionBridgeBySession(
    scope: LinearIssueSessionBridgeScope,
    sessionId: string,
  ): Promise<LinearIssueSessionBridgeRecord | undefined>;
  findLinearIssueSessionBridgeByMarker(
    scope: LinearIssueSessionBridgeScope,
    markerUrl: string,
  ): Promise<LinearIssueSessionBridgeRecord | undefined>;
  findLinearIssueSessionBridge(
    key: LinearIssueSessionBridgeKey,
  ): Promise<LinearIssueSessionBridgeRecord | undefined>;
  claimLinearIssueSessionBridge(
    input: LinearIssueSessionBridgeClaim,
  ): Promise<{ bridge: LinearIssueSessionBridgeRecord; claimed: boolean }>;
  bindLinearIssueSessionBridge(
    key: LinearIssueSessionBridgeKey,
    sessionId: string,
  ): Promise<LinearIssueSessionBridgeRecord>;
  startLinearIssueSessionBridgeCreation(
    key: LinearIssueSessionBridgeKey,
    leaseId: string,
    now: Date,
  ): Promise<boolean>;
}

function parameters(key: LinearIssueSessionBridgeKey): string[] {
  return [
    key.organizationId,
    key.projectId,
    key.connectionId,
    key.linearOrganizationId,
    key.issueId,
    key.eventKey,
  ];
}

export function linearIssueSessionBridgeKey(key: LinearIssueSessionBridgeKey): string {
  return JSON.stringify(parameters(key));
}

const whereKey =
  "organization_id=$1 and project_id=$2 and connection_id=$3 and linear_organization_id=$4 and issue_id=$5 and event_key=$6";

interface BridgeRow extends QueryRow {
  organization_id: string;
  project_id: string;
  connection_id: string;
  linear_organization_id: string;
  issue_id: string;
  event_key: string;
  app_user_id: string;
  provider_event_receipt_id: string;
  source_actor_id: string;
  source_body: string;
  marker_url: string;
  session_id: string | null;
  creation_started_at: Date | null;
  lease_id: string;
  lease_expires_at: Date;
}

function record(row: BridgeRow): LinearIssueSessionBridgeRecord {
  return {
    organizationId: row.organization_id,
    projectId: row.project_id,
    connectionId: row.connection_id,
    linearOrganizationId: row.linear_organization_id,
    issueId: row.issue_id,
    eventKey: row.event_key,
    appUserId: row.app_user_id,
    providerEventReceiptId: row.provider_event_receipt_id,
    sourceActorId: row.source_actor_id,
    sourceBody: row.source_body,
    markerUrl: row.marker_url,
    sessionId: row.session_id,
    creationStartedAt: row.creation_started_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export class LinearIssueSessionBridgeRepository {
  constructor(private readonly database: DatabaseRuntime) {}

  async findBySession(scope: LinearIssueSessionBridgeScope, sessionId: string) {
    return this.findByIdentity(scope, "session_id", sessionId);
  }

  async findByMarker(scope: LinearIssueSessionBridgeScope, markerUrl: string) {
    return this.findByIdentity(scope, "marker_url", markerUrl);
  }

  private async findByIdentity(
    scope: LinearIssueSessionBridgeScope,
    column: "session_id" | "marker_url",
    value: string,
  ) {
    const result = await this.database.query<BridgeRow>(
      `select * from linear_issue_session_bridges where organization_id=$1 and project_id=$2 and connection_id=$3 and linear_organization_id=$4 and issue_id=$5 and app_user_id=$6 and ${column}=$7`,
      [
        scope.organizationId,
        scope.projectId,
        scope.connectionId,
        scope.linearOrganizationId,
        scope.issueId,
        scope.appUserId,
        value,
      ],
    );
    if (result.rows.length > 1) throw new Error("Linear issue session has multiple reservations");
    return result.rows[0] === undefined ? undefined : record(result.rows[0]);
  }

  async find(
    key: LinearIssueSessionBridgeKey,
  ): Promise<LinearIssueSessionBridgeRecord | undefined> {
    const result = await this.database.query<BridgeRow>(
      `select * from linear_issue_session_bridges where ${whereKey}`,
      parameters(key),
    );
    return result.rows[0] === undefined ? undefined : record(result.rows[0]);
  }

  async claim(
    input: LinearIssueSessionBridgeClaim,
  ): Promise<{ bridge: LinearIssueSessionBridgeRecord; claimed: boolean }> {
    return this.database.transaction(async (transaction) => {
      await transaction.query(
        `insert into linear_issue_session_bridges
        (organization_id,project_id,connection_id,linear_organization_id,issue_id,event_key,
         app_user_id,provider_event_receipt_id,source_actor_id,source_body,marker_url,lease_id,lease_expires_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        on conflict (organization_id,project_id,connection_id,linear_organization_id,issue_id,event_key) do nothing`,
        [
          ...parameters(input),
          input.appUserId,
          input.providerEventReceiptId,
          input.sourceActorId,
          input.sourceBody,
          input.markerUrl,
          input.leaseId,
          input.leaseExpiresAt,
        ],
      );
      await transaction.query(
        `update linear_issue_session_bridges set lease_id=$7,lease_expires_at=$8
         where ${whereKey} and session_id is null and lease_expires_at <= $9`,
        [...parameters(input), input.leaseId, input.leaseExpiresAt, input.now],
      );
      const found = await transaction.query<BridgeRow>(
        `select * from linear_issue_session_bridges where ${whereKey}`,
        parameters(input),
      );
      if (found.rows[0] === undefined)
        throw new Error("Linear issue session reservation was not persisted");
      const bridge = record(found.rows[0]);
      return { bridge, claimed: bridge.sessionId === null && bridge.leaseId === input.leaseId };
    });
  }

  async bind(
    key: LinearIssueSessionBridgeKey,
    sessionId: string,
  ): Promise<LinearIssueSessionBridgeRecord> {
    await this.database.query(
      `update linear_issue_session_bridges set session_id=$7 where ${whereKey} and session_id is null`,
      [...parameters(key), sessionId],
    );
    const found = await this.find(key);
    if (found === undefined) throw new Error("Linear issue session reservation is missing");
    if (found.sessionId !== sessionId)
      throw new Error("Linear issue event has conflicting native session identities");
    return found;
  }

  async startCreation(
    key: LinearIssueSessionBridgeKey,
    leaseId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.database.query(
      `update linear_issue_session_bridges set creation_started_at=$8
       where ${whereKey} and lease_id=$7 and lease_expires_at>$8
       and session_id is null and creation_started_at is null`,
      [...parameters(key), leaseId, now],
    );
    return result.rowCount === 1;
  }
}
