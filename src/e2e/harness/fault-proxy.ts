import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";

interface Denial {
  type: "rpc_error";
  requestType: string;
  code: string;
}

type SteerResult = Denial | { type: "send_agent_message_response"; accepted: boolean };

export class HubFaultProxy {
  private readonly server: Server;
  private readonly sockets = new WebSocketServer({ noServer: true });
  private readonly negotiatedProtocols = new WeakMap<IncomingMessage, string>();
  private readonly upstreamSockets = new Set<WebSocket>();
  private daemonSocket: WebSocket | undefined;
  private hubSocket: WebSocket | undefined;
  private loseCreateResponse = false;
  private createResponseDropped: (() => void) | undefined;
  private readonly droppedCreateResponse = new Promise<void>((resolve) => {
    this.createResponseDropped = resolve;
  });
  private rpcObserver: { requestId: string; resolve: (value: SteerResult) => void } | undefined;
  private ordinaryAgentRpc = false;
  private readonly createsByExecution = new Map<string, number>();
  private readonly agentIdsByExecution = new Map<string, Set<string>>();
  private readonly createdAgentsByExecution = new Map<
    string,
    { agentId: string; hasCurrentState: boolean; status: string | null }
  >();
  private readonly events: string[] = [];
  private connectionGeneration = 0;

  private constructor(
    private readonly targetOrigin: string,
    readonly origin: string,
  ) {
    this.server = createServer((request, response) => {
      void this.forwardHttp(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    this.sockets.on("headers", (headers, request) => {
      const protocol = this.negotiatedProtocols.get(request);
      if (protocol) headers.push(`x-paseo-session-protocol: ${protocol}`);
    });
  }

  static async start(targetOrigin: string, port: number): Promise<HubFaultProxy> {
    const proxy = new HubFaultProxy(targetOrigin, `http://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(port, "127.0.0.1", resolve);
    });
    return proxy;
  }

  loseNextCreateResponse(): void {
    this.loseCreateResponse = true;
  }

  async createResponseWasDropped(): Promise<void> {
    await this.droppedCreateResponse;
  }

  async requestForbiddenOperation(): Promise<Denial> {
    return this.requestDenied({
      type: "daemon.get_status.request",
      requestId: "hub-e2e-denied",
    });
  }

  supportsOrdinaryAgentRpc(): boolean {
    return this.ordinaryAgentRpc;
  }

  async requestOrdinarySteer(agentId: string): Promise<SteerResult> {
    return this.requestObserved({
      type: "send_agent_message_request",
      requestId: "hub-e2e-unrelated-steer",
      agentId,
      text: "isolated contract probe",
      messageId: "hub-e2e-unrelated-arrival",
      activeTurnBehavior: "steer",
    });
  }

  private async requestDenied(message: Record<string, unknown>): Promise<Denial> {
    const response = await this.requestObserved(message);
    if (response.type !== "rpc_error") throw new Error("Expected an authorization denial");
    return response;
  }

  private async requestObserved(message: Record<string, unknown>): Promise<SteerResult> {
    const socket = this.daemonSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Daemon is not connected");
    const requestId = readString(message, "requestId");
    if (!requestId || this.rpcObserver)
      throw new Error("Expected one identified RPC probe at a time");
    this.events.push(`RPC observer armed request=${requestId}`);
    const observed = new Promise<SteerResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rpcObserver = undefined;
        reject(
          new Error(
            `RPC probe response was not observed\nFault proxy evidence:\n${this.evidence()}`,
          ),
        );
      }, 10_000);
      this.rpcObserver = {
        requestId,
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
      };
    });
    socket.send(
      JSON.stringify({
        type: "session",
        message,
      }),
    );
    return observed;
  }

  createAttempts(executionId: string): number {
    return this.createsByExecution.get(executionId) ?? 0;
  }

  daemonAgents(executionId: string): number {
    return this.agentIdsByExecution.get(executionId)?.size ?? 0;
  }

  daemonAgentsForAnyExecution(): number {
    return Array.from(this.agentIdsByExecution.values()).reduce(
      (total, ids) => total + ids.size,
      0,
    );
  }

  creation(executionId: string) {
    const agent = this.createdAgentsByExecution.get(executionId);
    return {
      agentId: agent?.agentId ?? null,
      hasCurrentState: agent?.hasCurrentState ?? false,
      status: agent?.status ?? null,
    };
  }

  hasReplacementConnection(): boolean {
    return this.connectionGeneration > 1;
  }

  connectionCount(): number {
    return this.connectionGeneration;
  }

  hubConnectionIsOpen(): boolean {
    return this.hubSocket?.readyState === WebSocket.OPEN;
  }

  evidence(): string {
    return this.events.join("\n");
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets.clients) socket.terminate();
    for (const socket of this.upstreamSockets) socket.terminate();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    this.server.closeIdleConnections();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async forwardHttp(
    request: IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    try {
      const body = await readRequestBody(request);
      const upstream = await fetch(new URL(request.url ?? "/", this.targetOrigin), {
        method: request.method ?? "GET",
        headers: forwardedHeaders(request),
        ...(body.length === 0 ? {} : { body: new Uint8Array(body) }),
      });
      this.events.push(`http ${request.method ?? "GET"} ${request.url ?? "/"} ${upstream.status}`);
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "content-encoding")
          response.setHeader(name, value);
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      response.statusCode = 502;
      response.end(error instanceof Error ? error.message : String(error));
    }
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const generation = ++this.connectionGeneration;
    const target = new URL(request.url ?? "/", this.targetOrigin);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const hubSocket = new WebSocket(target.toString(), {
      headers: forwardedHeaders(request),
    });
    this.upstreamSockets.add(hubSocket);
    this.hubSocket = hubSocket;
    let daemonSocket: WebSocket | undefined;
    socket.on("error", () => hubSocket.terminate());
    socket.on("close", () => hubSocket.terminate());
    // Negotiate upstream first: acknowledging the daemon early loses Hub's protocol
    // response header, leaving the two peers speaking different wire formats.
    hubSocket.once("upgrade", (response) => {
      if (response.headers["x-paseo-session-protocol"] === "1") {
        this.negotiatedProtocols.set(request, "1");
      }
    });
    hubSocket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 502;
      this.events.push(`${generation}: hub rejected upgrade ${status}`);
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      response.destroy();
      hubSocket.terminate();
    });
    hubSocket.on("open", () => {
      this.events.push(`${generation}: hub opened`);
      this.sockets.handleUpgrade(request, socket, head, (accepted) => {
        daemonSocket = accepted;
        this.daemonSocket = accepted;
        this.events.push(
          `${generation}: daemon accepted ${request.url ?? "/"} protocol=${this.negotiatedProtocols.get(request) ?? "legacy"}`,
        );
        accepted.on("message", (data) => {
          if (this.observeDaemonMessage(data)) return;
          if (hubSocket.readyState === WebSocket.OPEN) hubSocket.send(data);
        });
        accepted.on("close", (code, reason) => {
          this.events.push(`${generation}: daemon closed ${code} ${reason.toString()}`);
          hubSocket.terminate();
        });
        accepted.on("error", (error) => {
          this.events.push(`${generation}: daemon error ${error.message}`);
          hubSocket.terminate();
        });
      });
    });
    hubSocket.on("message", (data) => {
      const raw = readText(data);
      this.observeHubMessage(raw);
      if (daemonSocket?.readyState === WebSocket.OPEN) daemonSocket.send(raw);
    });
    hubSocket.on("close", (code, reason) => {
      this.upstreamSockets.delete(hubSocket);
      this.events.push(`${generation}: hub closed ${code} ${reason.toString()}`);
      if (daemonSocket) daemonSocket.terminate();
      else socket.destroy();
    });
    hubSocket.on("error", (error) => {
      this.events.push(`${generation}: hub error ${error.message}`);
      if (daemonSocket) daemonSocket.terminate();
      else socket.destroy();
    });
  }

  private observeHubMessage(raw: string): void {
    const message = sessionMessage(parseRecord(raw));
    const executionId = message && readString(message, "executionId");
    if (!executionId) return;
    if (message["type"] === "hub.execution.agent.create.request") {
      this.createsByExecution.set(executionId, (this.createsByExecution.get(executionId) ?? 0) + 1);
    }
  }

  private observeDaemonMessage(data: RawData): boolean {
    const raw = readText(data);
    const message = sessionMessage(parseRecord(raw));
    this.recordDaemonEvidence(message);
    this.observeRpcProbe(message);
    return this.observeCreateResponse(message);
  }

  private recordDaemonEvidence(message: Record<string, unknown> | undefined): void {
    const status = message?.["type"] === "status" ? recordAt(message, "payload") : undefined;
    if (status?.["status"] === "server_info") {
      this.ordinaryAgentRpc = recordAt(status, "features")?.["hubAgentRpc"] === true;
    }
    if (
      typeof message?.["type"] === "string" &&
      (message["type"].startsWith("hub.") || message["type"] === "rpc_error")
    ) {
      const payload = recordAt(message, "payload");
      const event = payload && recordAt(payload, "event");
      const item = event && recordAt(event, "item");
      const requestId = payload && readString(payload, "requestId");
      this.events.push(
        `daemon message ${message["type"]}${requestId ? ` request=${requestId}` : ""}${
          message["type"] === "rpc_error" ? ` payload=${JSON.stringify(payload)}` : ""
        }${event ? ` event=${String(event["type"])}` : ""}${
          item ? ` item=${JSON.stringify(item)}` : ""
        }`,
      );
    }
  }

  private observeRpcProbe(message: Record<string, unknown> | undefined): void {
    if (!message || !this.rpcObserver) return;
    const payload = recordAt(message, "payload");
    if (payload?.["requestId"] !== this.rpcObserver.requestId) return;
    if (message["type"] === "rpc_error") {
      const requestType = readString(payload, "requestType");
      const code = readString(payload, "code");
      if (!requestType || !code) return;
      this.rpcObserver.resolve({ type: "rpc_error", requestType, code });
    } else if (
      message["type"] === "send_agent_message_response" &&
      typeof payload["accepted"] === "boolean"
    ) {
      this.rpcObserver.resolve({
        type: "send_agent_message_response",
        accepted: payload["accepted"],
      });
    } else {
      return;
    }
    this.rpcObserver = undefined;
  }

  private observeCreateResponse(message: Record<string, unknown> | undefined): boolean {
    if (message?.["type"] !== "hub.execution.agent.create.response") return false;
    const payload = recordAt(message, "payload");
    const executionId = payload && readString(payload, "executionId");
    const agentId = payload && readString(payload, "agentId");
    if (executionId && agentId) {
      const ids = this.agentIdsByExecution.get(executionId) ?? new Set<string>();
      ids.add(agentId);
      this.agentIdsByExecution.set(executionId, ids);
      const agent = recordAt(payload, "agent");
      const status = agent ? (readString(agent, "status") ?? null) : null;
      this.createdAgentsByExecution.set(executionId, {
        agentId,
        hasCurrentState: agent !== undefined,
        status,
      });
    }
    if (!this.loseCreateResponse) return false;
    this.loseCreateResponse = false;
    this.createResponseDropped?.();
    this.createResponseDropped = undefined;
    return true;
  }
}

function forwardedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === "host" || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const rawChunk of request) {
    const chunk: unknown = rawChunk;
    if (typeof chunk === "string" || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function readText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}

function parseRecord(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return z.record(z.string(), z.unknown()).safeParse(value).data;
  } catch {
    return undefined;
  }
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  return z.record(z.string(), z.unknown()).safeParse(value[key]).data;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function sessionMessage(
  envelope: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (envelope?.["type"] !== "session") return envelope;
  return recordAt(envelope, "message");
}
