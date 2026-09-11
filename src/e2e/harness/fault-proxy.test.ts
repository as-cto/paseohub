import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { HubFaultProxy } from "./fault-proxy.js";

describe("source daemon fault proxy handshake", () => {
  it.each([true, false])(
    "preserves the upstream protocol decision: session=%s",
    async (session) => {
      const server = createServer();
      const upstream = new WebSocketServer({ server });
      upstream.on("headers", (headers) => {
        if (session) headers.push("x-paseo-session-protocol: 1");
      });
      upstream.on("connection", echoWithGreeting);
      const port = await listen(server);
      const proxy = await HubFaultProxy.start(`http://127.0.0.1:${port}`, await availablePort());
      const client = new WebSocket(proxy.origin, { headers: { "x-paseo-session-protocol": "1" } });
      let negotiated: string | string[] | undefined;
      client.on("upgrade", (response) => {
        negotiated = response.headers["x-paseo-session-protocol"];
      });
      const messages: string[] = [];
      const echoed = new Promise<void>((resolve, reject) => {
        client.on("error", reject);
        client.on("open", () => client.send("echo"));
        client.on("message", (data) => {
          messages.push(readText(data));
          if (messages.length === 2) resolve();
        });
      });
      try {
        await echoed;
        assert.equal(negotiated, session ? "1" : undefined);
        assert.deepEqual(messages, ["hello", "echo"]);
        assert.equal(proxy.connectionCount(), 1);
      } finally {
        client.terminate();
        await proxy.stop();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("propagates an upstream authorization rejection without opening the daemon socket", async () => {
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    const port = await listen(server);
    const proxy = await HubFaultProxy.start(`http://127.0.0.1:${port}`, await availablePort());
    const client = new WebSocket(proxy.origin);
    let opened = false;
    client.on("open", () => {
      opened = true;
    });
    client.on("error", () => undefined);
    try {
      const status = await new Promise<number | undefined>((resolve) => {
        client.on("unexpected-response", (_request, response) => {
          resolve(response.statusCode);
          response.destroy();
        });
      });
      assert.equal(status, 403);
      assert.equal(opened, false);
    } finally {
      client.terminate();
      await proxy.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([true, false])(
    "checks the advertised ordinary-agent boundary: supported=%s",
    async (supported) => {
      const server = createServer();
      const upstream = new WebSocketServer({ server });
      const greeted = observeGreeting(upstream);
      const proxy = await HubFaultProxy.start(
        `http://127.0.0.1:${await listen(server)}`,
        await availablePort(),
      );
      const client = new WebSocket(proxy.origin);
      client.on("open", () =>
        client.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: { status: "server_info", features: { hubAgentRpc: supported } },
            },
          }),
        ),
      );
      client.on("message", (data) => {
        const { message } = z
          .object({
            message: z.object({ requestId: z.string(), type: z.string() }),
          })
          .parse(JSON.parse(readText(data)));
        // A response belonging to a different caller must not satisfy this probe.
        client.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "rpc_error",
              payload: { requestId: "unrelated", requestType: "wrong", code: "wrong" },
            },
          }),
        );
        const response =
          supported && message.type === "send_agent_message_request"
            ? {
                type: "send_agent_message_response",
                payload: { requestId: message.requestId, accepted: true },
              }
            : {
                type: "rpc_error",
                payload: {
                  requestId: message.requestId,
                  requestType: message.type,
                  code: "access_denied",
                },
              };
        client.send(JSON.stringify({ type: "session", message: response }));
      });
      try {
        await greeted;
        assert.equal(proxy.supportsOrdinaryAgentRpc(), supported);
        assert.deepEqual(
          await proxy.requestOrdinarySteer("isolated-agent"),
          supported
            ? { type: "send_agent_message_response", accepted: true }
            : {
                type: "rpc_error",
                requestType: "send_agent_message_request",
                code: "access_denied",
              },
        );
        assert.deepEqual(await proxy.requestForbiddenOperation(), {
          type: "rpc_error",
          requestType: "daemon.get_status.request",
          code: "access_denied",
        });
      } finally {
        client.terminate();
        await proxy.stop();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

function observeGreeting(upstream: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    upstream.on("connection", (socket) => socket.once("message", () => resolve()));
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function echoWithGreeting(socket: WebSocket): void {
  socket.send("hello");
  socket.on("message", (data) => socket.send(data));
}

function readText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}
