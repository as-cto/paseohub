# Linear issue workspace capability validation

Linear steps using a daemon environment with both `worktree.mode: branch-off` and
`reuseWorkspace: true` require the daemon's `hubWorkspaceBindings` capability.
An explicitly authored `workspaceKey` on a branch-off environment requires the same
capability for every provider, including manual runs and steps without workspace reuse.
`ActiveDaemonRegistry` reads this flag from the authenticated session handshake;
the installed CLI version and an enrolled daemon record alone do not establish support.

Bundle validation and revision preparation check this requirement independently of
named-agent provider validation, so inline agents receive the same check. Activation
checks it again after asynchronous provider validation and route compilation;
rollback also checks the target before activation. The runtime create gate remains
necessary because a daemon can disconnect or change after configuration activation.

The check reports `daemon_not_connected` separately from
`workspace_binding_unsupported`. The public validation and installation responses
retain structured issue paths and include the actionable capability failure in
their problem `detail`, for clients that display only that field. This gate does
not install a daemon companion or grant execution permissions.

For a missing project, installation validates the bundle before creating the project
or recording a revision. A preflight rejection therefore has no revision ID. The
revision is still validated after project resolution; preflight is not an atomic
reservation of daemon availability.

Routes without this requirement remain configurable. Static steps check only their
selected environment; finite dynamic input choices check only reachable environments.
Unconstrained dynamic selections check every potentially selected daemon environment.

The stable Linear issue identity is also required when replaying a persisted launch
intent. An old reusable-workspace intent without a nonblank `workspaceKey` fails
with `linear_workspace_identity_missing` before daemon creation or credential
materialization. This applies both before handoff and after a daemon reconnects;
the execution becomes terminal as well as its workflow, so it cannot retain issue
ownership indefinitely. Recovery does not invent a key or rewrite old evidence.

Coverage: `src/configuration/store-workspace-bindings.test.ts`,
`src/daemons/registry.test.ts`,
`src/public-operations/install-configuration.test.ts`, and
`src/public-api/public-api.test.ts`.
Legacy recovery coverage: `src/workflows/engine.test.ts` and
`src/daemons/daemons.test.ts`.
