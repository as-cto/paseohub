export function relayConnectionLogMessages(chunks: readonly string[]): string[] {
  return chunks
    .join("")
    .split(/\r?\n/u)
    .flatMap((line) => {
      let message = line;
      try {
        const record: unknown = JSON.parse(line);
        if (
          typeof record === "object" &&
          record !== null &&
          "msg" in record &&
          typeof record.msg === "string"
        ) {
          message = record.msg;
        }
      } catch {
        // Supervisor diagnostics can be plain text even with daemon JSON logging.
      }
      return /relay.+(?:connect|dial|socket)/iu.test(message) ? [message] : [];
    });
}
