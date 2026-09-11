import { createHash, randomUUID } from "node:crypto";
import {
  linearIssueSessionBridgeKey,
  type LinearIssueSessionBridgeKey,
  type LinearIssueSessionBridgeStore,
  type LinearIssueSessionBridgeScope,
} from "../../db/linear-issue-session-bridges.js";
import type {
  LinearApiClient,
  LinearIssueDetails,
  LinearIssueSessionSummary,
} from "../../providers/linear/client.js";

export type { LinearIssueSessionSummary } from "../../providers/linear/client.js";

export interface LinearIssueSessionClient extends Pick<LinearApiClient, "readIssue"> {
  /** Return every page or throw. A truncated result cannot prove an earlier mutation absent. */
  readIssueSessions(input: {
    expectedConnectionId?: string;
    linearOrganizationId: string;
    issueId: string;
  }): Promise<ReadonlyArray<LinearIssueSessionSummary>>;
  createAgentSessionOnIssue(input: {
    expectedConnectionId?: string;
    linearOrganizationId: string;
    issueId: string;
    externalUrls: ReadonlyArray<{ label: string; url: string }>;
  }): Promise<{ id: string }>;
}

export function linearIssueSessionMarker(
  publicBaseUrl: string,
  key: LinearIssueSessionBridgeKey,
): string {
  const marker = new URL("/", publicBaseUrl);
  if (marker.protocol !== "https:" || marker.username || marker.password)
    throw new Error("Linear issue session marker requires a public HTTPS Hub URL");
  marker.hash = `linear-event=${createHash("sha256").update(linearIssueSessionBridgeKey(key)).digest("hex")}`;
  return marker.href;
}

/**
 * Create one native session for an authorized issue event. Linear's public creation API has no
 * client ID: once the durable attempt starts, only positive provider evidence permits progress.
 * A timeout, expired lease, complete empty listing or restart never permits another mutation.
 */
export async function sessionForIssueEvent(input: {
  key: LinearIssueSessionBridgeKey;
  appUserId: string;
  providerEventReceiptId: string;
  sourceActorId: string;
  sourceBody: string;
  publicBaseUrl: string;
  client: LinearIssueSessionClient;
  database: LinearIssueSessionBridgeStore;
  issueAllowed: (issue: LinearIssueDetails) => boolean;
  now?: () => Date;
}): Promise<string> {
  const { key, client, database, appUserId } = input;
  const now = input.now ?? (() => new Date());
  const assertCurrentAuthority = async () => {
    const current = await client.readIssue({
      linearOrganizationId: key.linearOrganizationId,
      expectedConnectionId: key.connectionId,
      issueId: key.issueId,
    });
    if (
      !current ||
      current.id !== key.issueId ||
      current.delegateId !== appUserId ||
      !input.issueAllowed(current)
    )
      throw new Error("Linear delegation or issue scope changed while the event was pending");
  };
  await assertCurrentAuthority();
  const timestamp = now();
  const { bridge, claimed } = await database.claimLinearIssueSessionBridge({
    ...key,
    appUserId,
    providerEventReceiptId: input.providerEventReceiptId,
    sourceActorId: input.sourceActorId,
    sourceBody: input.sourceBody,
    markerUrl: linearIssueSessionMarker(input.publicBaseUrl, key),
    leaseId: randomUUID(),
    leaseExpiresAt: new Date(timestamp.getTime() + 30_000),
    now: timestamp,
  });
  if (bridge.appUserId !== appUserId)
    throw new Error("Linear issue session reservation belongs to another agent");
  if (bridge.sessionId !== null) return bridge.sessionId;
  if (!claimed) throw new Error("Linear issue session creation is pending; retry this receipt");

  const bind = async (sessionId: string) => {
    const bound = await database.bindLinearIssueSessionBridge(key, sessionId);
    if (bound.sessionId !== sessionId)
      throw new Error("Linear issue event has conflicting native session identities");
    return sessionId;
  };
  const reconcile = async (): Promise<string | undefined> => {
    const sessions = await client.readIssueSessions({
      linearOrganizationId: key.linearOrganizationId,
      expectedConnectionId: key.connectionId,
      issueId: key.issueId,
    });
    const exact = sessions.filter((session) =>
      session.externalUrls.some((entry) => entry.url === bridge.markerUrl),
    );
    if (exact.some((session) => session.appUserId !== appUserId))
      throw new Error("Linear issue session marker belongs to another agent");
    const ids = [...new Set(exact.map((session) => session.id))];
    if (ids.length > 1)
      throw new Error("Linear issue event has multiple native sessions; reconciliation required");
    return ids[0] === undefined ? undefined : bind(ids[0]);
  };
  const existing = await reconcile();
  if (existing !== undefined) return existing;
  if (bridge.creationStartedAt !== null)
    throw new Error(
      "Linear issue session creation is uncertain; reconcile the original attempt before retrying mutation",
    );
  // Listing may take several pages. Recheck delegation and configured issue scope immediately
  // before the atomic attempt marker rather than treating the earlier reservation as authority.
  await assertCurrentAuthority();
  if (!(await database.startLinearIssueSessionBridgeCreation(key, bridge.leaseId, now())))
    throw new Error("Linear issue session creation lease changed; retry this receipt");
  try {
    const created = await client.createAgentSessionOnIssue({
      linearOrganizationId: key.linearOrganizationId,
      expectedConnectionId: key.connectionId,
      issueId: key.issueId,
      externalUrls: [{ label: "Paseo Hub", url: bridge.markerUrl }],
    });
    return await bind(created.id);
  } catch (error) {
    const recovered = await reconcile();
    if (recovered !== undefined) return recovered;
    throw error;
  }
}

/** Suppress only our own already-reserved creation echo, including webhook-before-HTTP-ack races. */
export async function isIssueSessionBridgeEcho(input: {
  scope: LinearIssueSessionBridgeScope;
  session: LinearIssueSessionSummary;
  database: LinearIssueSessionBridgeStore;
  client?: Pick<LinearIssueSessionClient, "readIssueSessions">;
}): Promise<boolean> {
  const { scope, session, database } = input;
  if (session.appUserId !== scope.appUserId) return false;
  const bound = await database.findLinearIssueSessionBridgeBySession(scope, session.id);
  if (bound !== undefined) return true;
  let externalUrls = session.externalUrls;
  if (externalUrls.length === 0 && input.client !== undefined) {
    const sessions = await input.client.readIssueSessions({
      linearOrganizationId: scope.linearOrganizationId,
      expectedConnectionId: scope.connectionId,
      issueId: scope.issueId,
    });
    const current = sessions.find((candidate) => candidate.id === session.id);
    if (current === undefined)
      throw new Error("Linear created session is not visible yet; retry echo reconciliation");
    if (current.appUserId !== scope.appUserId) return false;
    externalUrls = current.externalUrls;
  }
  for (const link of externalUrls) {
    const reservation = await database.findLinearIssueSessionBridgeByMarker(scope, link.url);
    if (reservation === undefined || reservation.creationStartedAt === null) continue;
    await database.bindLinearIssueSessionBridge(reservation, session.id);
    return true;
  }
  return false;
}
