export const PROVIDER_EVENT_DROP_REASON_CODES = [
  "no_project_route",
  "no_trigger_for_source",
  "trigger_filters_rejected",
  "configuration_unavailable",
  "agent_session_stopped",
  "superseded_by_agent_session",
  "steered_into_live_session",
] as const;

export type ProviderEventDropReasonCode = (typeof PROVIDER_EVENT_DROP_REASON_CODES)[number];

const SUMMARIES: Readonly<Record<ProviderEventDropReasonCode, string>> = {
  no_project_route: "No project route is configured for this event.",
  no_trigger_for_source: "No configured trigger handles this event.",
  trigger_filters_rejected: "The event did not pass the configured trigger filters.",
  configuration_unavailable: "The relevant configuration or connection is unavailable.",
  agent_session_stopped: "The event stopped the active agent session instead of starting a run.",
  superseded_by_agent_session:
    "The comment behind the event already opened or prompted an agent session, which handles it.",
  steered_into_live_session:
    "The message was delivered to the agent already running for this session, which answers it.",
};

export function isProviderEventDropReasonCode(value: string): value is ProviderEventDropReasonCode {
  return PROVIDER_EVENT_DROP_REASON_CODES.some((code) => code === value);
}

/**
 * Drop reasons that leave an event unhandled, i.e. worth surfacing as "unrouted" to the
 * organization. `agent_session_stopped`, `superseded_by_agent_session` and
 * `steered_into_live_session` are deliberately absent: the receipt was handled (it stopped the
 * session, the session it opened answers for it, or the running agent received it), it just
 * never became a run. The Postgres query in
 * `listUnroutedProviderEventsForOrganization` lists these same codes as a SQL literal; the
 * `unrouted-provider-events.test.ts` freezes both sides to this list.
 */
export const UNROUTED_PROVIDER_EVENT_DROP_REASON_CODES = [
  "no_project_route",
  "no_trigger_for_source",
  "trigger_filters_rejected",
  "configuration_unavailable",
] as const satisfies readonly ProviderEventDropReasonCode[];

export function isUnroutedProviderEventDropReasonCode(
  value: string,
): value is (typeof UNROUTED_PROVIDER_EVENT_DROP_REASON_CODES)[number] {
  return UNROUTED_PROVIDER_EVENT_DROP_REASON_CODES.some((code) => code === value);
}

export function providerEventDropReasonSummary(value: string): string | null {
  return isProviderEventDropReasonCode(value) ? SUMMARIES[value] : null;
}
