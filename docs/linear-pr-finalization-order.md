# Linear PR links and final issue state

Durable Linear replies now attach session PR links after the canonical report reservation and
confirmation of both the root issue comment and native response, before issue finalization.
The links are derived from the reserved report body, not from a later tool retry.

PR enrichment may cause Linear to evaluate GitHub issue-state automation. It therefore runs
under the same `execution.prompt` advisory lock as finalization and only for the current turn
and native session. Once any finalization record exists (including pending), no link update
is sent for that report. A delivery lease expiring cannot place an enrichment after another
attempt has finalized the issue. The finalizer itself is invoked outside that lock, avoiding
nested acquisition.

When a finalization policy is configured, enrichment first reuses its read-only decision:
only a pending, authorized decision may enrich the session. Closed issues, no-action outcomes,
changed delegation/team, invalid destination states and unauthorized assignees do not qualify.
Finalization then performs its normal live checks again; PR enrichment and human activity may
have changed the issue since the preflight. No provider authority or finalization target is
added by this change.

Link enrichment remains best effort. An acknowledged or uncertain link update is followed by
normal verified finalization. A crash before finalization is reserved can retry enrichment;
after that reservation, recovery skips links and reconciles finalization without blindly
replaying the metadata mutation. A contradictory report is rejected before enrichment.

## Regression coverage and limits

The local regression simulates an issue-state update caused by a session PR link. It failed
on the previous ordering (final state `started`), then passed on this ordering (final state
`review`). The tests also cover lost report/link acknowledgements, a crash before reservation,
pending-journal recovery, concurrent expired leases, contradictory replies, changed authority,
and closed issues.

This ordering cannot prevent a genuinely later GitHub or human event from changing issue state.

Official references:

- https://linear.app/developers/agent-interaction (session PR links)
- https://linear.app/docs/github (issue status automation)
