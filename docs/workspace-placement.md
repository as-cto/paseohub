# Durable workspace placement

A branch-off environment with `reuseWorkspace: true` can bind its work identity to
one checkout. Linear supplies the immutable connection ID, Linear organization ID,
and issue UUID; Hub adds its own organization ID. The display identifier remains
useful for the initial branch name, but a rename never changes the binding key.
Providers without a workspace identity and environments without this explicit
opt-in retain their existing allocation behavior.

There are two complementary records:

- Hub migration `0051_workspace_placements.sql` adds `workspace_placements`. An
  atomic first claim permanently records the project ID, daemon ID, exact source
  directory and first execution ID for the work identity. Conflicting claims fail
  with `workspace_placement_conflict` before agent creation. The workflow engine,
  direct daemon dispatch and daemon recovery all enforce this claim.
  For Linear, uniqueness uses the Hub organization, Linear organization and issue UUID;
  the stored authority still includes the exact connection. Replacing that connection
  therefore conflicts with the original claim and requires reconciliation instead of
  silently allocating another checkout.
- A daemon advertising `server_info.features.hubWorkspaceBindings: true` accepts
  the optional `worktree.workspaceKey`. It persists an association with the exact
  workspace ID and directory under its Paseo home. Subsequent agents reuse that
  workspace, including dirty files. Missing, archived, ambiguous or conflicting
  workspaces require reconciliation; the allocator cannot pick a suffixed checkout.

The Hub rejects a daemon that does not advertise the capability before sending a
create request. Deploying only the Hub is insufficient. The companion daemon
change must be built and verified, and the cross-repository compatibility pin must
be updated before release. No automatic fallback to legacy allocation is allowed.

## Concurrent events

The database serializes execution creation by immutable Linear issue identity.
Two events can both be accepted before the first daemon agent exists; only one
execution is created, while the other run remains queued. For a single-step
`continue_issue` route, the engine retries the provider's explicit
`continuePendingRun` hook before allocating work. It rejoins the live agent only
when the saved revision, environment, prompt, agent options, output authority and
workflow/step/idle runtime limits match.

Every queued attempt also checks that the saved revision is still active, resolves
the same connected Linear account, and reads the issue again. Current team/project
scope, required delegate and allowed actor checks must still pass. Revocation or a
failed authority read leaves the run pending and never falls through to creation.

The native turn key is the durable prompt identity. A confirmed input ACK lets
the queued run be consumed with `continued_existing_execution`, without another
agent or execution charge. A retry after the ACK was persisted does not resend
the prompt. An uncertain ACK or incompatible saved configuration leaves the run
pending for reconciliation, subject to its existing deadline. Consuming this
routing run does not publish an agent-completed notification; the execution that
received the input owns the eventual result.

## Activation and reconciliation

The migration only adds storage. It does not activate routes, change permissions,
or infer historical workspace placement. The guarantee starts with the first
recorded claim. Existing installations must reconcile their known issue checkouts
and historical execution placement before enabling bindings or moving routes to
another daemon. Do not infer that an absent new record proves that no historical
checkout exists.

A claim is written before the first agent starts and survives a failed start,
execution completion, project archive/deletion, and daemon removal. A conservative
claim may therefore exist without a completed checkout. Hub does not resolve paths
or symlinks on remote hosts: even a change in source path spelling requires review.
Only organization deletion cascades its Hub records.

On a conflict, stop routing the affected work identity and inspect the recorded
Hub project/daemon/source directory, its first execution, and that daemon's binding
and Git worktree metadata. Restore the original placement when appropriate. A real
move requires an operator to verify and preserve the sole existing workspace and
its dirty files, stop outstanding agents, and reconcile both records together
before resuming events. No automated move, delete, reset or replacement API is
provided. Deleting a record merely to dismiss an error can create a second copy.

## Local verification

```sh
npx vitest run src/db/workspace-placements.test.ts src/db/workspace-placements.integration.test.ts src/daemons/workspace-placement.test.ts
npx vitest run src/workflows/engine.test.ts src/daemons/registry.test.ts -t 'workspace'
npm run db:check
```

The embedded database test applies actual migrations to a temporary local
database, races claims, restarts the database, and checks retained placement after
project deletion. No provider or deployed database is contacted.
