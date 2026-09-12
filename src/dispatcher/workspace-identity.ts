import type { WorktreeTarget } from "../config/index.js";

export class LinearWorkspaceIdentityMissingError extends Error {
  constructor() {
    super(
      "linear_workspace_identity_missing: reusable Linear workspaces require a stable issue identity",
    );
    this.name = "LinearWorkspaceIdentityMissingError";
  }
}

/** Shared by new workflow launches and recovery of intentions persisted before this contract. */
export function assertLinearWorkspaceIdentity(
  triggerContext: unknown,
  worktree: WorktreeTarget | undefined,
  workspaceKey: string | undefined,
): void {
  if (
    typeof triggerContext === "object" &&
    triggerContext !== null &&
    "provider" in triggerContext &&
    triggerContext.provider === "linear" &&
    worktree?.mode === "branch-off" &&
    worktree.reuseWorkspace === true &&
    !workspaceKey?.trim()
  )
    throw new LinearWorkspaceIdentityMissingError();
}
