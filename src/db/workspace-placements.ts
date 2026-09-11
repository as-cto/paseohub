import { createHash } from "node:crypto";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { DatabaseRuntime, QueryRow } from "./runtime/index.js";

export interface WorkspacePlacementClaim {
  organizationId: string;
  workspaceKey: string;
  projectId: string;
  daemonId: string;
  sourceCwd: string;
  firstExecutionId: string;
}

export interface WorkspacePlacementRecord extends WorkspacePlacementClaim {
  createdAt: Date;
}

export interface WorkspacePlacementStore {
  claimWorkspacePlacement(input: WorkspacePlacementClaim): Promise<WorkspacePlacementRecord>;
}

export class WorkspacePlacementConflictError extends Error {
  constructor() {
    super(
      "workspace_placement_conflict: this work identity belongs to another connection, project, daemon, or source directory; reconcile its existing workspace before changing placement",
    );
    this.name = "WorkspacePlacementConflictError";
  }
}

export function workspacePlacementKey(
  input: Pick<WorkspacePlacementClaim, "organizationId" | "workspaceKey">,
): string {
  // Hash the index key so the maximum wire length also works for multibyte identifiers.
  return createHash("sha256")
    .update(JSON.stringify([input.organizationId, placementIdentity(input)]))
    .digest("hex");
}

/** Connection replacement must collide with the original Linear claim, not allocate a new one. */
function placementIdentity(
  input: Pick<WorkspacePlacementClaim, "organizationId" | "workspaceKey">,
): string {
  try {
    const scoped: unknown = JSON.parse(input.workspaceKey);
    if (
      !Array.isArray(scoped) ||
      scoped.length !== 2 ||
      scoped[0] !== input.organizationId ||
      typeof scoped[1] !== "string"
    )
      return input.workspaceKey;
    const provider: unknown = JSON.parse(scoped[1]);
    if (
      !Array.isArray(provider) ||
      provider.length !== 4 ||
      provider[0] !== "linear" ||
      !provider.every((part): part is string => typeof part === "string" && part.length > 0)
    )
      return input.workspaceKey;
    // The full key remains stored and checked by assertWorkspacePlacement, pinning authority.
    return JSON.stringify(["linear", provider[2], provider[3]]);
  } catch {
    // Other providers may use opaque keys rather than this scoped JSON representation.
    return input.workspaceKey;
  }
}

export function assertWorkspacePlacement(
  existing: WorkspacePlacementRecord,
  input: WorkspacePlacementClaim,
): void {
  if (
    existing.organizationId !== input.organizationId ||
    existing.workspaceKey !== input.workspaceKey ||
    existing.projectId !== input.projectId ||
    existing.daemonId !== input.daemonId ||
    existing.sourceCwd !== input.sourceCwd
  ) {
    throw new WorkspacePlacementConflictError();
  }
}

export async function claimWorkspacePlacementForIntent(
  database: WorkspacePlacementStore,
  intent: LaunchMachineIntent,
  executionId: string,
): Promise<void> {
  const worktree = intent.environment.worktree;
  if (worktree?.mode !== "branch-off" || worktree.workspaceKey === undefined) return;
  await database.claimWorkspacePlacement({
    organizationId: intent.organizationId,
    workspaceKey: worktree.workspaceKey,
    projectId: intent.projectId,
    daemonId: intent.environment.daemonId,
    // Keep the authored daemon path exact. Hub cannot resolve symlinks on a remote host.
    sourceCwd: intent.environment.cwd,
    firstExecutionId: executionId,
  });
}

interface PlacementRow extends QueryRow {
  organization_id: string;
  workspace_key: string;
  project_id: string;
  daemon_id: string;
  source_cwd: string;
  first_execution_id: string;
  created_at: Date;
}

export class WorkspacePlacementRepository {
  constructor(private readonly database: DatabaseRuntime) {}

  async claim(input: WorkspacePlacementClaim): Promise<WorkspacePlacementRecord> {
    return this.database.transaction(async (transaction) => {
      const key = workspacePlacementKey(input);
      await transaction.query(
        `insert into workspace_placements
         (key_hash, organization_id, workspace_key, project_id, daemon_id, source_cwd, first_execution_id)
         values ($1,$2,$3,$4,$5,$6,$7) on conflict (key_hash) do nothing`,
        [
          key,
          input.organizationId,
          input.workspaceKey,
          input.projectId,
          input.daemonId,
          input.sourceCwd,
          input.firstExecutionId,
        ],
      );
      const result = await transaction.query<PlacementRow>(
        "select * from workspace_placements where key_hash=$1",
        [key],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("Workspace placement claim was not persisted");
      const record: WorkspacePlacementRecord = {
        organizationId: row.organization_id,
        workspaceKey: row.workspace_key,
        projectId: row.project_id,
        daemonId: row.daemon_id,
        sourceCwd: row.source_cwd,
        firstExecutionId: row.first_execution_id,
        createdAt: row.created_at,
      };
      assertWorkspacePlacement(record, input);
      return record;
    });
  }
}
