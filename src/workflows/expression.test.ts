import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  parseExpression,
  renderExecutionTemplate,
  renderExpressionTemplate,
} from "./expression.js";

describe("workflow expression context", () => {
  it("keeps the triggering prompt and ambient context as distinct merge values", () => {
    const context = {
      prompt: "the triggering body",
      context: { slack: { thread: { messages: [{ content: "earlier" }] } } },
      inputs: {},
      steps: {},
      values: {},
    };

    assert.equal(renderExpressionTemplate("${{ paseo.prompt }}", context), "the triggering body");
    assert.equal(
      renderExpressionTemplate("${{ paseo.context }}", context),
      JSON.stringify(context.context),
    );
    assert.deepEqual(parseExpression("${{ paseo.context }}"), {
      kind: "path",
      value: { namespace: "paseo", path: "context" },
    });
  });

  it("renders the stable execution ID without provider context", () => {
    assert.equal(
      renderExecutionTemplate(
        "trigger-${{ paseo.execution.id }}",
        "64ae56ff-281c-4c5f-bf5c-d572f125c702",
      ),
      "trigger-64ae56ff-281c-4c5f-bf5c-d572f125c702",
    );
  });
});

describe("worktree templates", () => {
  it("names a worktree after the work rather than the execution", () => {
    assert.equal(
      renderExecutionTemplate("${{ paseo.work.id }}", "execution-1", "pos-33"),
      "pos-33",
    );
  });

  it("refuses a work template on an event that names no work", () => {
    // Better a configuration error at launch than a worktree silently named after nothing.
    assert.throws(
      () => renderExecutionTemplate("${{ paseo.work.id }}", "execution-1"),
      /work key/u,
    );
  });

  it("still supports the execution id", () => {
    assert.equal(
      renderExecutionTemplate("run-${{ paseo.execution.id }}", "execution-1", "pos-33"),
      "run-execution-1",
    );
  });
});
