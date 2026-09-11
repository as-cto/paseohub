/** Optional provider-owned identity for a single native Linear turn, independent of webhook order. */
export function linearDispatchKey(outputContext: unknown): string | undefined {
  if (!isRecord(outputContext)) return undefined;
  const value = outputContext;
  return value["provider"] === "linear" &&
    typeof value["agentSessionId"] === "string" &&
    value["agentSessionId"].length > 0 &&
    typeof value["turnKey"] === "string" &&
    value["turnKey"].length > 0
    ? value["turnKey"]
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
