# Linear session launch authority

Linear sessions created by automation can have no responsible human user. Linear's
[Agent Session schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
documents `creator` as nullable for this case. Hub preserves the missing actor; it does
not substitute the issue creator, assignee, or the author of a nearby issue update.

`filters.allow_automated_sessions: true` explicitly authorizes these session creations.
It is available only on `linear.agent_session` and requires an explicit Linear connection,
team, and non-empty `from_users` list. The option is off by default and does not alter
existing wildcard behavior. Human-created sessions and follow-up prompts still need an
author in `from_users`; the option grants nothing to an identified agent or other user.

```yaml
name: engineering-agent
on:
  linear.agent_session:
    connection: acme-linear
    filters:
      team: engineering-team-id
      from_users: [operator-user-id]
      allow_automated_sessions: true
run:
  target:
    daemon: devbox
    cwd: /workspace/engineering
  agent:
    provider: codex
    mode: full-access
  max_runtime: 1h
  idle_timeout: 5m
  prompt: |
    Handle the Linear request and report the result.
    ${{ paseo.prompt }}
```

For legacy project bundles, put the same option in the workflow's `filters`, with
`connection` beside `team` and `from_users`. Both authoring formats compile to the same
runtime policy. The self-contained trigger schema exposes `team` so this policy does
not require using the legacy bundle API.

The matcher first checks the resolved connection and issue scope. All existing project,
state, assignee, label, and text filters remain effective. The additional authorization
applies only when the event is `created`, its actor is null, and the connection has been
resolved. Actorless `prompted` events, comments, and assignments do not gain access.

Enabling this option delegates authority to the team's Linear automation. It can start
sessions resulting indirectly from other users' actions; it does not prove that a listed
human requested the work. Review the team's automation inputs and the agent's execution
authority before enabling it. Use a direct human delegation when launch authority must
remain limited to the listed users.

Focused verification:

```sh
bunx vitest run src/config/compiler.test.ts src/triggers/linear/match.test.ts src/triggers/configuration/index.test.ts
```

Public documentation lives in the Paseo repository. A companion public-docs change is
required before releasing this option; this repository-local reference records the
reviewable contract while implementation is prepared.
