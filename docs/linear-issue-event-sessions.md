# Native sessions for delegated issue events

`linear.delegatedIssueUpdated` represents a signed issue delivery, not a comment.
`sessionForIssueEvent` in `src/triggers/linear/issue-session-bridge.ts` reserves that
identity before creating a native Linear session on the issue. The caller supplies
the verified app owner, authorized actor, current issue filter, receipt and project.
The bridge re-reads delegation and scope before reserving and immediately before
creation; reservation alone does not authorize an agent run.

The public [`AgentSessionCreateOnIssue` API](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
accepts `issueId` and `externalUrls`, but no caller-provided session ID. Migration
`0050_linear_issue_session_bridges.sql` therefore records a creation attempt before
sending the mutation. The mutation attaches a marker with label `Paseo Hub`:

```text
https://<public-hub-host>/#linear-event=<sha256-of-the-complete-reservation-key>
```

The key includes Hub organization, project, connection, Linear organization, issue
and delivery/event identity. It never invents a comment ID. The URL points at the
existing Hub home route, and its fragment is a correlation marker.

A retry first reads every `issue.agentSessions` page (including archived sessions),
using official `externalLinks` fields, and matches the exact URL and app user. A
pagination error, repeated/missing cursor or 100-page limit throws instead of
returning an incomplete list. The session ID is then bound to the reservation.

After a creation attempt starts, an empty provider result, network failure, expired
lease or restart cannot authorize a second creation. If the outcome remains
ambiguous, the original receipt remains retryable for reconciliation. This avoids
duplicates at the cost of requiring investigation when Linear never accepted the
original request and cannot provide positive evidence. Source actor/body are
preserved across retries rather than replaced by a later replay payload.

A newly created session also emits its own native webhook. The provider uses
`isIssueSessionBridgeEcho` before executing such a `created` event. It checks the
same complete scope and app, finds either a bound session or an exact persisted
marker with a started attempt, and atomically binds the session if necessary. If
the webhook omits external URLs, its caller passes the client so the helper can
read the exact session first. This covers webhook-before-HTTP-response races.
`prompted` events remain independent turns and must not be suppressed by this helper.

Verification:

```sh
bunx vitest run src/triggers/linear/issue-session-bridge.test.ts src/providers/linear/client.test.ts src/db/linear-issue-session-bridges.integration.test.ts
bun run typecheck:node
bun run db:check
```

The integration test applies real migrations to a temporary PostgreSQL container,
reserves concurrently, records an attempt, reconnects the runtime, reconciles and
checks foreign-scope exclusion and project deletion. It never contacts Linear or
a production database.
