/** The dispatch key proves the initial prompt, not an unacknowledged follow-up. */
export function nextTurnOutputContext(previous: unknown, incoming: unknown): unknown {
  if (!isRecord(incoming)) return incoming;
  const { turnKey: _incomingDispatchKey, ...destination } = incoming;
  return {
    ...destination,
    ...(isRecord(previous) && typeof previous["turnKey"] === "string"
      ? { turnKey: previous["turnKey"] }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
