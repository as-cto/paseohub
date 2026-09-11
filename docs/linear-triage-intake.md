# Explicit Triage intake

This optional deterministic intake handles signed `Issue/create` receipts before checking
agent delegation. It changes only `stateId`. Linear's existing Triage rules retain ownership
of human assignment and agent delegation; no model is started to perform intake.

Enable it only after verifying the intended team's Triage state ID:

```yaml
on: linear.delegated_issue_updated
filters:
  connection: project-linear
  team: <verified-team-id>
  from_users: [<authorized-human-linear-id>]
  require_delegate: true
  intake_triage_state_id: <verified-team-triage-state-id>
```

The compiler rejects this option on other events, without the explicit team/connection/actor
scope, or with a wildcard actor. P OS generated workflows do not set this option by default.
Bots, the current app user and absent/unauthorized actors never cause this mutation.

The provider matches the configured connection/team/project before intake. It captures the
original creation `stateId` and `updatedAt` directly from the signed payload; hydrating the
issue later cannot replace that evidence. The helper reads the current issue and all team
workflow states, verifies the configured target has category `triage`, and accepts only an
unchanged issue still in `backlog` or `unstarted`. Missing creation version, another team,
an advanced state, or a concurrent edit produces an explicit ignored disposition. Other
matching creation workflows still proceed when intake is ignored.

Migration `0053_linear_triage_intakes.sql` records a reservation uniquely by Hub organization,
project, connection, Linear organization and issue. Different webhook deliveries cannot
reapply intake to the same issue. A durable attempt marker precedes the provider mutation;
leases only serialize workers and never erase that marker. Source evidence is immutable on
replay. An acknowledged result is recorded as applied. After a lost response, observing the
same team's Triage state can reconcile the attempt; otherwise it remains ambiguous and the
mutation is never automatically sent a second time. A late positive acknowledgement can
still settle a reservation whose lease was renewed by another worker.

Linear's `IssueUpdateInput` has no atomic expected-version check. The final re-read reduces,
but cannot eliminate, the race where a person updates the issue immediately before the
mutation reaches Linear. This feature does not promise universal or exactly-once remote
admission under every concurrent edit or network failure. It deliberately does not move
already-advanced issues back to Triage.

The receipt has `linear_intake_applied`, `linear_intake_ignored` or
`linear_intake_ambiguous` when no agent workflow matches afterward. Ignored and ambiguous
receipts appear in the unrouted view; exact reasons are stored in `linear_triage_intakes`
and emitted as `intakeStatus`/`intakeReason` in provider logs. Reasons include
`creation_version_unavailable`, `issue_changed_since_creation`, `issue_already_advanced`,
`actor_not_authorized` and `original_attempt_unconfirmed_no_repeat`. Lease contention stays
retryable. Ambiguous outcomes require inspection/reconciliation, not clearing the attempt
marker and resending a status change.

Verification covers compiler scope, raw version preservation, bot refusal, delegation-free
admission, independent legacy triggers, duplicate deliveries, concurrent workers, missing or
changed versions, lost acknowledgements and persistence across a PostgreSQL runtime reconnect:

```sh
bunx vitest run src/triggers/linear/triage-intake.test.ts src/triggers/linear/provider.issue-events.test.ts src/config/linear-triage-policy.test.ts src/triggers/linear/events.intake.test.ts src/db/linear-issue-session-bridges.integration.test.ts src/db/unrouted-provider-events.test.ts
```
