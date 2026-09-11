import { describe, expect, it } from "vitest";
import { relayConnectionLogMessages } from "./daemon-log-evidence.js";

describe("source daemon relay evidence", () => {
  it("distinguishes configuration fields from an actual connection log", () => {
    const config = JSON.stringify({
      relay: { enabled: false },
      websocket: { connected: true },
      msg: "Daemon configuration loaded",
    });
    expect(relayConnectionLogMessages([`${config}\n`])).toEqual([]);
  });

  it("detects connection messages split across output chunks", () => {
    const connection = JSON.stringify({ msg: "relay_control_connected", connectionId: "test" });
    expect(
      relayConnectionLogMessages([connection.slice(0, 19), `${connection.slice(19)}\n`]),
    ).toEqual(["relay_control_connected"]);
  });

  it("retains evidence from a plain-text supervisor diagnostic", () => {
    expect(relayConnectionLogMessages(["relay: dial failed\n"])).toEqual(["relay: dial failed"]);
  });
});
