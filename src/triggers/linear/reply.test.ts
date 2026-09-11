import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { LinearApiClient } from "../../providers/linear/client.js";
import { compileJsonSchema } from "../../workflows/json-schema.js";
import {
  createLinearReplyExecutor,
  linearReplyOutputTool,
  createLinearProgressExecutor,
  linearProgressOutputTool,
  createLinearPlanExecutor,
  linearPlanOutputTool,
  linearSessionOutputAvailable,
  LINEAR_REPLY_OUTPUT_TYPE,
  LINEAR_PROGRESS_OUTPUT_TYPE,
  LINEAR_PLAN_OUTPUT_TYPE,
} from "./reply.js";

describe("Linear reply output", () => {
  it("rejects a blank final report before publishing", async () => {
    const client = new RecordingLinearClient();
    await assert.rejects(
      createLinearReplyExecutor({ client })({
        agentExecutionId: "execution",
        toolType: "linear.reply",
        args: { content: " \n " },
        outputContext: sessionContext(),
      }),
      /cannot be blank/u,
    );
    assert.equal(client.comments.length, 0);
    assert.equal(client.activities.length, 0);
  });
  it("posts the workflow outcome onto its triggering issue", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Draft PR: https://github.com/acme/repo/pull/42" },
      outputContext: {
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: null,
      },
    });
    assert.deepEqual(client.comments, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        body: "Draft PR: https://github.com/acme/repo/pull/42",
      },
    ]);
  });

  it("threads an issue comment under the root of the triggering comment", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done." },
      outputContext: {
        ...sessionContext(),
        agentSessionId: null,
        threadRootCommentId: "root-comment",
      },
    });

    assert.deepEqual(client.comments, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        body: "Done.",
        parentId: "root-comment",
      },
    ]);
  });

  it("posts a top-level comment when the trigger was not a comment", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done." },
      outputContext: { ...sessionContext(), agentSessionId: null, threadRootCommentId: null },
    });

    assert.deepEqual(client.comments, [
      { linearOrganizationId: "linear-org", issueId: "issue-1", body: "Done." },
    ]);
    assert.equal("parentId" in (client.comments[0] ?? {}), false);
  });

  it("posts a top-level comment for a context recorded before threading existed", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done." },
      outputContext: { ...sessionContext(), agentSessionId: null },
    });

    assert.deepEqual(client.comments, [
      { linearOrganizationId: "linear-org", issueId: "issue-1", body: "Done." },
    ]);
    assert.equal("parentId" in (client.comments[0] ?? {}), false);
  });

  it("responds through a native Linear agent session", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Draft PR: https://github.com/acme/repo/pull/42" },
      outputContext: {
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: "session-1",
      },
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: {
          type: "response",
          body: "Draft PR: https://github.com/acme/repo/pull/42",
        },
      },
    ]);
    assert.deepEqual(client.comments, []);
  });

  it("asks a question as an elicitation so the session awaits input", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch should the fix target?", kind: "question" },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "elicitation", body: "Which branch should the fix target?" },
      },
    ]);
  });

  it("offers fixed choices through a select signal", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch?", kind: "question", options: ["main", "release/1.2"] },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "elicitation", body: "Which branch?" },
        signal: "select",
        signalMetadata: {
          options: [
            { label: "main", value: "main" },
            { label: "release/1.2", value: "release/1.2" },
          ],
        },
      },
    ]);
  });

  it("ignores options on a final response", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Done.", kind: "response", options: ["main"] },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "response", body: "Done." },
      },
    ]);
  });

  it("lists the choices of a question in an issue comment", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch?", kind: "question", options: ["main", "release/1.2"] },
      outputContext: { ...sessionContext(), agentSessionId: null },
    });

    assert.deepEqual(client.comments, [
      {
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        body: "Which branch?\n\n- main\n- release/1.2",
      },
    ]);
    assert.deepEqual(client.activities, []);
  });

  it("rejects an unknown kind", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "linear.reply",
        args: { content: "Done", kind: "thought" },
        outputContext: sessionContext(),
      }),
    );
    assert.deepEqual(client.activities, []);
  });

  it("exposes kind and options on the reply tool schema", () => {
    assert.equal(linearReplyOutputTool.name, "reply");
    assert.deepEqual(Object.keys(linearReplyOutputTool.inputSchema.properties ?? {}), [
      "content",
      "outcome",
      "kind",
      "options",
      "auth",
    ]);
    assert.deepEqual(linearReplyOutputTool.inputSchema.required, ["content"]);
  });

  it("validates reply arguments against the tool schema", () => {
    const { validate } = compileJsonSchema(linearReplyOutputTool.inputSchema);
    assert.equal(linearReplyOutputTool.inputSchema["additionalProperties"], false);
    assert.equal(validate({ content: "Which branch?", kind: "question", options: ["a"] }), true);
    assert.equal(validate({ content: "Done", kind: "thought" }), false);
    assert.equal(validate({ content: "Which branch?", options: [] }), false);
    assert.equal(validate({ content: "Done", extra: 1 }), false);
  });

  it("drops duplicated choices before offering them", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Which branch?", kind: "question", options: ["main", "main", "dev"] },
      outputContext: sessionContext(),
    });

    assert.deepEqual(client.activities[0]?.signalMetadata, {
      options: [
        { label: "main", value: "main" },
        { label: "dev", value: "dev" },
      ],
    });
  });

  it("fails closed for an output context from another provider", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });
    await assert.rejects(() =>
      execute({
        agentExecutionId: "execution-1",
        toolType: "linear.reply",
        args: { content: "Done" },
        outputContext: { provider: "slack", issueId: "issue-1" },
      }),
    );
    assert.deepEqual(client.comments, []);
  });

  it("preserves a readable label separately from the selected value", async () => {
    const client = new RecordingLinearClient();
    await createLinearReplyExecutor({ client })({
      agentExecutionId: "execution-1",
      toolType: LINEAR_REPLY_OUTPUT_TYPE,
      args: {
        content: "Which result?",
        kind: "question",
        options: [
          { label: "Comfort improvement", value: "comfort" },
          { label: "Duplicate", value: "comfort" },
          "Other",
        ],
      },
      outputContext: sessionContext(),
    });
    assert.deepEqual(client.activities[0]?.signalMetadata, {
      options: [
        { label: "Comfort improvement", value: "comfort" },
        { label: "Other", value: "Other" },
      ],
    });
  });

  it("offers a native account connection with optional target user, without invalid ephemeral flag", async () => {
    const client = new RecordingLinearClient();
    const auth = {
      url: "https://connect.composio.dev/link/project-account",
      userId: "ceo",
      providerName: "GitHub",
    };
    await createLinearReplyExecutor({ client })({
      agentExecutionId: "execution-1",
      toolType: LINEAR_REPLY_OUTPUT_TYPE,
      args: { content: "Connect the project account.", kind: "auth", auth },
      outputContext: sessionContext(),
    });
    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "elicitation", body: "Connect the project account." },
        signal: "auth",
        signalMetadata: auth,
      },
    ]);
  });

  it("reports a native error instead of claiming completion", async () => {
    const client = new RecordingLinearClient();
    await createLinearReplyExecutor({ client })({
      agentExecutionId: "execution-1",
      toolType: LINEAR_REPLY_OUTPUT_TYPE,
      args: { content: "The provider could not deliver the change.", kind: "error" },
      outputContext: sessionContext(),
    });
    assert.equal(client.activities[0]?.content.type, "error");
  });

  it("rejects missing, insecure or malformed authentication before delivery", async () => {
    for (const auth of [
      undefined,
      { url: "http://example.com/auth" },
      { url: "javascript:alert(1)" },
      { url: "https://user:password@example.com/auth" },
      { url: "https://" },
    ]) {
      const client = new RecordingLinearClient();
      await assert.rejects(() =>
        createLinearReplyExecutor({ client })({
          agentExecutionId: "execution-1",
          toolType: LINEAR_REPLY_OUTPUT_TYPE,
          args: { content: "Connect.", kind: "auth", auth },
          outputContext: sessionContext(),
        }),
      );
      assert.equal(client.activities.length, 0);
      assert.equal(client.comments.length, 0);
    }
  });

  it("keeps progress and plans separate from required final replies", async () => {
    const client = new RecordingLinearClient();
    const input = { agentExecutionId: "execution-1", outputContext: sessionContext() };
    await createLinearProgressExecutor({ client })({
      ...input,
      toolType: LINEAR_PROGRESS_OUTPUT_TYPE,
      args: { content: "Checking the requested improvement." },
    });
    const steps = [
      { content: "Verify behavior", status: "inProgress" },
      { content: "Apply feedback", status: "pending" },
    ];
    await createLinearPlanExecutor({ client })({
      ...input,
      toolType: LINEAR_PLAN_OUTPUT_TYPE,
      args: { steps },
    });
    assert.deepEqual(client.activities, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        content: { type: "thought", body: "Checking the requested improvement." },
        ephemeral: true,
      },
    ]);
    assert.deepEqual(client.plans, [
      { linearOrganizationId: "linear-org", agentSessionId: "session-1", plan: steps },
    ]);
    assert.equal(client.comments.length, 0);
    assert.notEqual(LINEAR_PROGRESS_OUTPUT_TYPE, LINEAR_REPLY_OUTPUT_TYPE);
    assert.notEqual(LINEAR_PLAN_OUTPUT_TYPE, LINEAR_REPLY_OUTPUT_TYPE);
  });

  it("requires a native session for progress and plans", async () => {
    const client = new RecordingLinearClient();
    const outputContext = { ...sessionContext(), agentSessionId: null };
    assert.equal(linearSessionOutputAvailable(outputContext), false);
    assert.equal(linearSessionOutputAvailable(sessionContext()), true);
    await assert.rejects(() =>
      createLinearProgressExecutor({ client })({
        agentExecutionId: "execution-1",
        toolType: LINEAR_PROGRESS_OUTPUT_TYPE,
        args: { content: "Checking" },
        outputContext,
      }),
    );
    await assert.rejects(() =>
      createLinearPlanExecutor({ client })({
        agentExecutionId: "execution-1",
        toolType: LINEAR_PLAN_OUTPUT_TYPE,
        args: { steps: [] },
        outputContext,
      }),
    );
    assert.equal(client.activities.length, 0);
    assert.equal(client.plans.length, 0);
  });

  it("exposes only valid native terminal kinds and optional progress/plan shapes", () => {
    const reply = compileJsonSchema(linearReplyOutputTool.inputSchema).validate;
    assert.equal(
      reply({
        content: "Connect",
        kind: "auth",
        auth: { url: "https://connect.example.com/link" },
      }),
      true,
    );
    assert.equal(reply({ content: "Connect", kind: "auth" }), false);
    assert.equal(
      reply({ content: "Connect", kind: "auth", auth: { url: "http://example.com" } }),
      false,
    );
    assert.equal(reply({ content: "Working", kind: "progress" }), false);
    assert.equal(
      reply({
        content: "Choose",
        kind: "question",
        options: [{ label: "Comfort", value: "comfort" }],
      }),
      true,
    );
    assert.equal(
      compileJsonSchema(linearProgressOutputTool.inputSchema).validate({ content: "Working" }),
      true,
    );
    const plan = compileJsonSchema(linearPlanOutputTool.inputSchema).validate;
    assert.equal(plan({ steps: [{ content: "Check", status: "completed" }] }), true);
    assert.equal(plan({ steps: [{ content: "Check", status: "done" }] }), false);
    assert.equal(plan({ steps: [] }), true);
  });
});

function sessionContext() {
  return {
    provider: "linear",
    linearOrganizationId: "linear-org",
    issueId: "issue-1",
    agentSessionId: "session-1",
  };
}

class RecordingLinearClient implements LinearApiClient {
  comments: Array<{
    linearOrganizationId: string;
    issueId: string;
    body: string;
    parentId?: string;
  }> = [];
  activities: Parameters<LinearApiClient["createAgentActivity"]>[0][] = [];
  plans: Parameters<LinearApiClient["updateAgentSessionPlan"]>[0][] = [];
  externalUrls: Parameters<LinearApiClient["updateAgentSessionExternalUrls"]>[0][] = [];

  async readIssue(): Promise<undefined> {
    return undefined;
  }

  async readIssueComments() {
    return { comments: [], complete: true };
  }

  async readAgentSessionActivities() {
    return { activities: [], complete: true };
  }

  async readCommentThread(): Promise<undefined> {
    return undefined;
  }

  async createComment(input: (typeof this.comments)[number]): Promise<void> {
    this.comments.push(input);
  }

  async createAgentActivity(
    input: Parameters<LinearApiClient["createAgentActivity"]>[0],
  ): Promise<void> {
    this.activities.push(input);
  }

  async updateAgentSessionExternalUrls(
    input: Parameters<LinearApiClient["updateAgentSessionExternalUrls"]>[0],
  ): Promise<void> {
    this.externalUrls.push(input);
  }
  async updateAgentSessionPlan(
    input: Parameters<LinearApiClient["updateAgentSessionPlan"]>[0],
  ): Promise<void> {
    this.plans.push(input);
  }
  async createAgentSessionOnComment(): Promise<{ id: string }> {
    throw new Error("Reply delivery must not create a session");
  }
}

describe("Linear session external URLs", () => {
  it("attaches a pull request named in a reply to the session", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });

    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Fait : https://github.com/acme/project/pull/128 (ne pas fusionner)." },
      outputContext: {
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: "session-1",
      },
    });

    assert.deepEqual(client.externalUrls, [
      {
        linearOrganizationId: "linear-org",
        agentSessionId: "session-1",
        externalUrls: [
          { label: "acme/project#128", url: "https://github.com/acme/project/pull/128" },
        ],
      },
    ]);
  });

  it("attaches nothing when the reply names no pull request", async () => {
    const client = new RecordingLinearClient();
    const execute = createLinearReplyExecutor({ client });

    await execute({
      agentExecutionId: "execution-1",
      toolType: "linear.reply",
      args: { content: "Voir https://linear.app/pstudio/issue/POS-33 pour le detail." },
      outputContext: {
        provider: "linear",
        linearOrganizationId: "linear-org",
        issueId: "issue-1",
        agentSessionId: "session-1",
      },
    });

    assert.deepEqual(client.externalUrls, []);
  });
});
