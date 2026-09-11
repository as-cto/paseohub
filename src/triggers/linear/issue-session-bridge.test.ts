import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createMemoryDatabase } from "../../db/memory.js";
import type { LinearIssueDetails } from "../../providers/linear/client.js";
import {
  isIssueSessionBridgeEcho,
  linearIssueSessionMarker,
  sessionForIssueEvent,
  type LinearIssueSessionClient,
  type LinearIssueSessionSummary,
} from "./issue-session-bridge.js";

const key = {
  organizationId: "hub-org",
  projectId: "hub-project",
  connectionId: "connection",
  linearOrganizationId: "linear-org",
  issueId: "issue",
  eventKey: "delivery",
};
const issue: LinearIssueDetails = {
  id: "issue",
  identifier: "SEN-1",
  title: "Issue",
  description: null,
  teamId: "team",
  projectId: null,
  assigneeId: "human",
  delegateId: "app",
  stateId: "state",
  labelIds: [],
};

function fixture() {
  const database = createMemoryDatabase();
  const sessions: LinearIssueSessionSummary[] = [];
  let time = 0;
  let creations = 0;
  const client: LinearIssueSessionClient = {
    readIssue: async () => issue,
    readIssueSessions: async () => sessions,
    createAgentSessionOnIssue: async (input) => {
      creations += 1;
      const session = {
        id: `session-${creations}`,
        appUserId: "app",
        externalUrls: input.externalUrls,
      };
      sessions.push(session);
      return session;
    },
  };
  const input = {
    key,
    database,
    client,
    appUserId: "app",
    providerEventReceiptId: "receipt",
    sourceActorId: "human",
    sourceBody: "Status changed",
    publicBaseUrl: "https://hub.test/base",
    issueAllowed: (current: LinearIssueDetails) => current.teamId === "team",
    now: () => new Date(time),
  };
  return {
    input,
    sessions,
    creations: () => creations,
    advance: () => {
      time += 31_000;
    },
  };
}

describe("native sessions for issue events", () => {
  it("creates once for retries, and keeps distinct events and projects independent", async () => {
    const f = fixture();
    assert.equal(await sessionForIssueEvent(f.input), "session-1");
    assert.equal(await sessionForIssueEvent(f.input), "session-1");
    assert.equal(
      await sessionForIssueEvent({ ...f.input, key: { ...key, eventKey: "next-delivery" } }),
      "session-2",
    );
    assert.equal(
      await sessionForIssueEvent({ ...f.input, key: { ...key, projectId: "other-project" } }),
      "session-3",
    );
    assert.equal(f.creations(), 3);
    const marker = new URL(f.sessions[0]!.externalUrls[0]!.url);
    assert.equal(marker.pathname, "/");
    assert.match(marker.hash, /^#linear-event=[a-f0-9]{64}$/u);
  });

  it("allows only one concurrent creator", async () => {
    const f = fixture();
    const create = f.input.client.createAgentSessionOnIssue.bind(f.input.client);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.input.client.createAgentSessionOnIssue = async (input) => {
      entered();
      await pending;
      return create(input);
    };
    const first = sessionForIssueEvent(f.input);
    await started;
    await assert.rejects(sessionForIssueEvent(f.input), /pending/u);
    release();
    assert.equal(await first, "session-1");
    assert.equal(f.creations(), 1);
  });

  it("recovers an accepted creation after its HTTP acknowledgement is lost", async () => {
    const f = fixture();
    const create = f.input.client.createAgentSessionOnIssue.bind(f.input.client);
    f.input.client.createAgentSessionOnIssue = async (input) => {
      await create(input);
      throw new Error("lost acknowledgement");
    };
    assert.equal(await sessionForIssueEvent(f.input), "session-1");
    assert.equal(f.creations(), 1);
  });

  it("never creates twice when the original result remains invisible after lease expiry", async () => {
    const f = fixture();
    let calls = 0;
    f.input.client.createAgentSessionOnIssue = async () => {
      calls += 1;
      throw new Error("timeout");
    };
    await assert.rejects(sessionForIssueEvent(f.input), /timeout/u);
    f.advance();
    await assert.rejects(sessionForIssueEvent(f.input), /uncertain/u);
    assert.equal(calls, 1);
    f.sessions.push({
      id: "accepted-but-late",
      appUserId: "app",
      externalUrls: [
        { label: "Paseo Hub", url: linearIssueSessionMarker(f.input.publicBaseUrl, key) },
      ],
    });
    f.advance();
    assert.equal(await sessionForIssueEvent(f.input), "accepted-but-late");
    assert.equal(calls, 1);
  });

  it("does not create after a partial/failed listing or delegation revocation", async () => {
    const f = fixture();
    f.input.client.readIssueSessions = async () => {
      throw new Error("page 2 failed");
    };
    await assert.rejects(sessionForIssueEvent(f.input), /page 2/u);
    assert.equal(f.creations(), 0);
    f.advance();
    f.input.client.readIssueSessions = async () => {
      f.input.client.readIssue = async () => ({ ...issue, delegateId: null });
      return [];
    };
    await assert.rejects(sessionForIssueEvent(f.input), /delegation/u);
    assert.equal(f.creations(), 0);
  });

  it("rejects another app or multiple sessions bearing the same exact marker", async () => {
    const f = fixture();
    const externalUrls = [
      { label: "Paseo Hub", url: linearIssueSessionMarker(f.input.publicBaseUrl, key) },
    ];
    f.sessions.push({ id: "foreign", appUserId: "other-app", externalUrls });
    await assert.rejects(sessionForIssueEvent(f.input), /another agent/u);
    f.advance();
    f.sessions.splice(
      0,
      1,
      { id: "one", appUserId: "app", externalUrls },
      { id: "two", appUserId: "app", externalUrls },
    );
    await assert.rejects(sessionForIssueEvent(f.input), /multiple native/u);
    assert.equal(f.creations(), 0);
  });

  it("reads the exact created session when its webhook omits the marker", async () => {
    const f = fixture();
    const scope = { ...key, appUserId: "app" };
    f.input.client.createAgentSessionOnIssue = async (input) => {
      f.sessions.push({ id: "omitted-marker", appUserId: "app", externalUrls: input.externalUrls });
      assert.equal(
        await isIssueSessionBridgeEcho({
          scope,
          session: { id: "omitted-marker", appUserId: "app", externalUrls: [] },
          database: f.input.database,
          client: f.input.client,
        }),
        true,
      );
      return { id: "omitted-marker" };
    };
    assert.equal(await sessionForIssueEvent(f.input), "omitted-marker");
    await assert.rejects(
      isIssueSessionBridgeEcho({
        scope,
        session: { id: "not-visible", appUserId: "app", externalUrls: [] },
        database: f.input.database,
        client: f.input.client,
      }),
      /not visible/u,
    );
  });

  it("reconciles its created webhook arriving before the creation response", async () => {
    const f = fixture();
    const scope = { ...key, appUserId: "app" };
    f.input.client.createAgentSessionOnIssue = async (input) => {
      const session = { id: "webhook-first", appUserId: "app", externalUrls: input.externalUrls };
      assert.equal(
        await isIssueSessionBridgeEcho({ scope, session, database: f.input.database }),
        true,
      );
      assert.equal(
        await isIssueSessionBridgeEcho({
          scope: { ...scope, projectId: "other" },
          session,
          database: f.input.database,
        }),
        false,
      );
      assert.equal(
        await isIssueSessionBridgeEcho({
          scope,
          session: { ...session, appUserId: "other" },
          database: f.input.database,
        }),
        false,
      );
      return session;
    };
    assert.equal(await sessionForIssueEvent(f.input), "webhook-first");
    assert.equal(
      await isIssueSessionBridgeEcho({
        scope,
        session: { id: "webhook-first", appUserId: "app", externalUrls: [] },
        database: f.input.database,
      }),
      true,
    );
    await assert.rejects(
      f.input.database.bindLinearIssueSessionBridge(key, "conflicting-id"),
      /conflicting/u,
    );
  });
});
