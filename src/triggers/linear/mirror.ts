import { z } from "zod";

import type { HubExecutionAgentStreamEvent } from "../../hub/protocol.js";
import type { LinearAgentActivityContent } from "../../providers/linear/client.js";

/**
 * Mirrors a running agent into a Linear agent session.
 *
 * Linear's session panel is a live feed: `thought` for what the agent says or reasons, `action`
 * for what it does. The daemon already streams both to Hub for every execution — until now the
 * stream only pushed back the idle deadline. This module turns that stream into the activities
 * Linear expects, which is the difference between a panel that says "Working…" for two minutes
 * and one that shows the work.
 *
 * Three constraints shape every decision here:
 *
 * 1. **The panel is shared.** Everyone with access to the issue reads it, including people who
 *    cannot read the repository. Tool parameters are summarised, never echoed wholesale, and
 *    results are reduced to an outcome. Secrets are redacted on top of that.
 * 2. **Activities cost a round trip each.** An agent emits hundreds of timeline items per turn.
 *    Assistant text is coalesced per message and flushed on transitions, tool calls are posted
 *    once (on completion, when the outcome is known), and a per-execution ceiling stops a
 *    runaway agent from flooding the issue.
 * 3. **A mirror must never break the run.** Every failure here is swallowed by the caller: a
 *    missing thought is a cosmetic loss, a failed execution is not.
 */

/** Hard ceiling of mirrored activities per execution; beyond it the mirror goes quiet. */
export const LINEAR_MIRROR_ACTIVITY_LIMIT = 150;

/** Longest body posted to Linear. Long agent messages are cut, not dropped. */
const MAX_BODY_LENGTH = 1_500;

/** Longest action parameter (a command, a path, a query). */
const MAX_PARAMETER_LENGTH = 180;

/** Longest action result. Results are outcomes here, never payloads. */
const MAX_RESULT_LENGTH = 200;

/** Below this, an assistant message is noise (a stray newline between tool calls). */
const MIN_BODY_LENGTH = 2;

/**
 * The daemon's timeline item, read defensively.
 *
 * Hub's own schema (`HubTimelineItemSchema`) is a passthrough object: it validates the handful of
 * fields Hub itself uses and preserves the rest untyped. `detail` is the rest — it is the daemon's
 * structured description of a tool call, and it is what makes an action readable ("Ran command"
 * plus the command) instead of opaque ("Bash"). Parsing it here keeps that dependency one-way and
 * tolerant: an unknown detail shape degrades to the tool name, it never throws.
 */
const MirrorToolDetailSchema = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    filePath: z.string().optional(),
    query: z.string().optional(),
    url: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    description: z.string().optional(),
    subAgentType: z.string().optional(),
    numFiles: z.number().optional(),
    numMatches: z.number().optional(),
    durationMs: z.number().optional(),
    exitCode: z.number().optional(),
  })
  .partial()
  .passthrough();

const MirrorTimelineItemSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    messageId: z.string().optional(),
    callId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    detail: MirrorToolDetailSchema.optional(),
  })
  .passthrough();

/**
 * Per-execution mirror state.
 *
 * Kept in memory rather than in the database on purpose: it is a de-duplication and coalescing
 * buffer, not a source of truth. Losing it (Hub restart) costs at worst a repeated thought or a
 * missing one, never a wrong session state — and the alternative, a write per timeline item,
 * would cost more than the mirror itself.
 */
export interface LinearMirrorState {
  /** Text of the assistant message being accumulated, keyed by the daemon's message id. */
  pendingMessageId: string | null;
  pendingText: string;
  /** Tool calls already posted, so a re-emitted `completed` item does not post twice. */
  postedCallIds: Set<string>;
  /** Bodies already posted, so a provider that re-sends a whole message does not repeat it. */
  postedBodies: Set<string>;
  posted: number;
  /** True once the ceiling notice was posted; stops the mirror for good. */
  exhausted: boolean;
  /**
   * True once the agent called `finish_execution`.
   *
   * Agents narrate what they just did after finishing ("Replied in the thread: …"), which the
   * mirror published as a thought right under the answer it repeated. After the turn is closed
   * the agent has nothing left to say to the panel.
   */
  turnClosed: boolean;
}

export function createLinearMirrorState(): LinearMirrorState {
  return {
    pendingMessageId: null,
    pendingText: "",
    postedCallIds: new Set(),
    postedBodies: new Set(),
    posted: 0,
    exhausted: false,
    turnClosed: false,
  };
}

/**
 * Turns one stream event into the activities to post, mutating `state`.
 *
 * Returns them in order; the caller posts them sequentially so the panel reads like a transcript.
 * An empty array is the common case — most events only feed the coalescing buffer.
 */
export function planLinearMirrorActivities(
  event: HubExecutionAgentStreamEvent,
  state: LinearMirrorState,
): LinearAgentActivityContent[] {
  if (state.exhausted) return [];
  const planned: LinearAgentActivityContent[] = [];

  // A turn boundary flushes whatever text was being accumulated: nothing more will extend it.
  if (isTurnBoundary(event.type)) {
    pushFlush(planned, state);
    return capped(planned, state);
  }
  if (event.type !== "timeline") return [];

  const parsed = MirrorTimelineItemSchema.safeParse(event.item);
  if (!parsed.success) return [];
  planTimelineItem(parsed.data, planned, state);
  return capped(planned, state);
}

function isTurnBoundary(type: HubExecutionAgentStreamEvent["type"]): boolean {
  return type === "turn_completed" || type === "turn_failed" || type === "turn_canceled";
}

function planTimelineItem(
  item: z.infer<typeof MirrorTimelineItemSchema>,
  planned: LinearAgentActivityContent[],
  state: LinearMirrorState,
): void {
  if (item.type === "assistant_message" || item.type === "reasoning") {
    if (state.turnClosed) return;
    planAgentText(item, planned, state);
    return;
  }
  if (item.type === "tool_call") {
    planToolCall(item, planned, state);
    return;
  }
  if (item.type === "error") {
    pushFlush(planned, state);
    const body = redact(truncate(item.text ?? "", MAX_BODY_LENGTH));
    if (body.length >= MIN_BODY_LENGTH) planned.push({ type: "thought", body });
  }
}

function planAgentText(
  item: z.infer<typeof MirrorTimelineItemSchema>,
  planned: LinearAgentActivityContent[],
  state: LinearMirrorState,
): void {
  const messageId = item.messageId ?? null;
  if (messageId !== null && messageId === state.pendingMessageId) {
    state.pendingText = extendStreamedText(state.pendingText, item.text ?? "");
    return;
  }
  pushFlush(planned, state);
  state.pendingMessageId = messageId;
  state.pendingText = item.text ?? "";
  // An item with no id cannot be extended by a later one, so it is complete already.
  if (messageId === null) pushFlush(planned, state);
}

function planToolCall(
  item: z.infer<typeof MirrorTimelineItemSchema>,
  planned: LinearAgentActivityContent[],
  state: LinearMirrorState,
): void {
  // Posted once the outcome is known: an action that says what it did AND how it went is worth
  // more than the ~1 s of extra latency, and it halves the number of activities.
  if (item.status === "running") return;
  const callId = item.callId ?? "";
  if (callId.length > 0) {
    if (state.postedCallIds.has(callId)) return;
    state.postedCallIds.add(callId);
  }
  const name = item.name ?? "";
  const closesTurn = name.includes("finish_execution");
  // Hub's own tools are the turn's plumbing, and publishing them REOPENS the panel: Linear ends
  // the turn on the `response`, so any activity after it starts a new "Working" block that never
  // closes — the session looks busy while the agent is only waiting for the next message.
  // Observed on SEN-98: "Posted a reply" and "Finished the turn" landed after the answer and left
  // the panel spinning. They say nothing a reader needs; the answer above them says it all.
  if (closesTurn || name.includes("hub__reply") || name === "hub.reply") {
    if (closesTurn) state.turnClosed = true;
    return;
  }
  // Text before the action: the agent usually narrates, then acts.
  pushFlush(planned, state);
  planned.push(toolCallActivity(item));
}

/**
 * Grows a streamed message, whichever way its provider streams it.
 *
 * Both shapes exist behind the same `messageId`, and picking one broke the other in production:
 * Claude Code sends deltas (`"I"`, then `"'ll read the docs"`), so replacing published a thought
 * missing its first word, while other providers re-send the whole message each time, so appending
 * would publish it as a staircase. The prefix test tells them apart with no provider knowledge.
 */
function extendStreamedText(accumulated: string, incoming: string): string {
  if (incoming.startsWith(accumulated)) return incoming;
  if (accumulated.startsWith(incoming)) return accumulated;
  return accumulated + incoming;
}

/** Flushes the buffered assistant text as a `thought`, if there is anything worth posting. */
export function flushLinearMirror(state: LinearMirrorState): LinearAgentActivityContent[] {
  if (state.exhausted) return [];
  const planned: LinearAgentActivityContent[] = [];
  pushFlush(planned, state);
  return capped(planned, state);
}

function pushFlush(planned: LinearAgentActivityContent[], state: LinearMirrorState): void {
  const body = redact(truncate(state.pendingText.trim(), MAX_BODY_LENGTH));
  state.pendingMessageId = null;
  state.pendingText = "";
  if (body.length < MIN_BODY_LENGTH) return;
  // The same body twice in a row is a provider re-emission, not the agent repeating itself.
  if (state.postedBodies.has(body)) return;
  state.postedBodies.add(body);
  planned.push({ type: "thought", body });
}

/**
 * Applies the per-execution ceiling.
 *
 * The last slot is spent on saying that the mirror stopped: a feed that goes silent looks like a
 * hung agent, which is the exact confusion the mirror exists to remove.
 */
function capped(
  planned: LinearAgentActivityContent[],
  state: LinearMirrorState,
): LinearAgentActivityContent[] {
  if (planned.length === 0) return planned;
  const room = LINEAR_MIRROR_ACTIVITY_LIMIT - state.posted;
  if (room <= 0) {
    state.exhausted = true;
    return [];
  }
  if (planned.length < room) {
    state.posted += planned.length;
    return planned;
  }
  state.posted = LINEAR_MIRROR_ACTIVITY_LIMIT;
  state.exhausted = true;
  return [
    ...planned.slice(0, room - 1),
    {
      type: "thought",
      body: `Paseo is still working; this session reached ${LINEAR_MIRROR_ACTIVITY_LIMIT} live updates and will only post its reply from here.`,
    },
  ];
}

/**
 * Describes a tool call for a reader who cannot see the repository.
 *
 * The parameter is the one field that identifies the call (the command, the path, the query); the
 * result is an outcome, never the payload. Reading a file must not publish the file.
 */
function toolCallActivity(
  item: z.infer<typeof MirrorTimelineItemSchema>,
): LinearAgentActivityContent {
  const detail = item.detail ?? {};
  const name = item.name ?? detail.type ?? "tool";

  const { action, parameter } = describeToolCall(detail, name);
  const result = toolCallResult(item, detail);
  return {
    type: "action",
    action,
    parameter: redact(truncate(parameter, MAX_PARAMETER_LENGTH)),
    ...(result === undefined ? {} : { result: redact(truncate(result, MAX_RESULT_LENGTH)) }),
  };
}

/** Maps the daemon's structured tool detail to a label a non-developer can read. */
const TOOL_ACTION_LABELS: Readonly<Record<string, string>> = {
  shell: "Ran a command",
  read: "Read a file",
  edit: "Edited a file",
  write: "Wrote a file",
  search: "Searched the repository",
  fetch: "Fetched a page",
  sub_agent: "Delegated to a sub-agent",
};

function describeToolCall(
  detail: z.infer<typeof MirrorToolDetailSchema>,
  name: string,
): { action: string; parameter: string } {
  // A shell call carries only its command line — the daemon's `ToolCallDetail` has no intent
  // field for it — so the verb has to be read off the command itself. Linear's model wants a
  // verb in `action` and its object in `parameter` ("Searched" / "San Francisco Weather"); this
  // keeps that shape instead of collapsing every call into "Ran a command" plus raw shell.
  const known = detail.command === undefined ? TOOL_ACTION_LABELS[detail.type ?? ""] : undefined;
  const parameter =
    (detail.command === undefined ? undefined : shellObject(detail.command)) ??
    detail.description ??
    detail.filePath ??
    detail.query ??
    detail.url ??
    detail.subAgentType ??
    detail.label ??
    detail.text;
  if (detail.command !== undefined) {
    return { action: shellVerb(detail.command), parameter: parameter ?? detail.command };
  }
  // With nothing but the tool's name, "Used a tool | ToolSearch" beats "Used ToolSearch |
  // ToolSearch": the name belongs on one side or the other, not on both.
  if (known === undefined) return { action: "Used a tool", parameter: parameter ?? name };
  return { action: known, parameter: parameter ?? name };
}

/**
 * Strips the scaffolding a command carries before the part that says what it does.
 *
 * A shell line starts with the machinery of running it — the directory to be in, environment to
 * load, a timeout, a nice level — and that prefix dominated the panel: "Ran a command cd
 * /home/agent/Projets/paseohub-wt-mirror && sed -n '318,400p' src/…". None of it describes the
 * work.
 */
function shellObject(command: string): string {
  let text = command.trim();
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/^cd\s+\S+\s*&&\s*/u, "")
      .replace(/^(?:sudo|nice)(?:\s+-[A-Za-z]+(?:\s+\d+)?)*\s+/u, "")
      .replace(/^timeout\s+\d+\s+/u, "")
      .replace(/^set\s+[+-]a;.*?set\s+[+-]a\s*/su, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/u, "")
      .trim();
  }
  return text.length === 0 ? command.trim() : text;
}

/**
 * Reads a verb off a command, for a reader who does not write code.
 *
 * Deliberately a small table of what this repository actually runs, not a shell parser: an
 * unrecognised command falls back to "Ran a command", which is exactly as informative as before
 * and never wrong. The object stays next to it, so nothing is hidden from a reader who does.
 */
const SHELL_VERBS: readonly (readonly [RegExp, string])[] = [
  [/^git\s+(?:push|pull|fetch)/u, "Synced the repository"],
  [/^git\s+commit/u, "Committed a change"],
  [/^git\s+(?:checkout|switch|worktree|branch)/u, "Switched branch"],
  [/^git\b/u, "Inspected the repository"],
  [/^gh\s+pr\s+create/u, "Opened a pull request"],
  [/^gh\s+pr\s+merge/u, "Merged the pull request"],
  [/^gh\s+(?:pr|run)\b/u, "Checked the pull request"],
  [/^gh\b/u, "Used GitHub"],
  [/\b(?:vitest|jest|playwright|test)\b/u, "Ran the tests"],
  [/\b(?:oxlint|eslint|lint)\b/u, "Ran the linter"],
  [/\b(?:tsgo|tsc|typecheck)\b/u, "Checked types"],
  [/\b(?:oxfmt|prettier|fmt|format)\b/u, "Checked formatting"],
  [/\bbuild\b/u, "Built the project"],
  [/^(?:grep|rg|ug|ugrep|ag)\b/u, "Searched the code"],
  [/^(?:ls|find|tree)\b/u, "Listed files"],
  [/^(?:cat|sed|head|tail|less|wc|od)\b/u, "Read a file"],
  [/^(?:curl|wget)\b/u, "Called an API"],
  [/^ssh\b/u, "Ran a command on a server"],
  [/^docker\b/u, "Inspected containers"],
  [/^(?:psql|sqlite3)\b/u, "Queried the database"],
  [/^(?:python3?|node|bun|npx)\b/u, "Ran a script"],
  [/^(?:printenv|env|echo)\b/u, "Checked the environment"],
];

function shellVerb(command: string): string {
  const text = shellObject(command);
  for (const [pattern, verb] of SHELL_VERBS) {
    if (pattern.test(text)) return verb;
  }
  return "Ran a command";
}

function toolCallResult(
  item: z.infer<typeof MirrorTimelineItemSchema>,
  detail: z.infer<typeof MirrorToolDetailSchema>,
): string | undefined {
  if (item.status === "canceled") return "canceled";
  if (item.status === "failed") return failureText(item.error);
  return successText(detail);
}

function successText(detail: z.infer<typeof MirrorToolDetailSchema>): string | undefined {
  if (typeof detail.numMatches === "number") return `${detail.numMatches} matches`;
  if (typeof detail.numFiles === "number") return `${detail.numFiles} files`;
  if (typeof detail.exitCode === "number" && detail.exitCode !== 0) {
    return `exit ${detail.exitCode}`;
  }
  return undefined;
}

function failureText(error: unknown): string {
  if (typeof error === "string" && error.length > 0) return `failed: ${error}`;
  if (error !== null && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return `failed: ${message}`;
  }
  return "failed";
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Removes credential-shaped strings before they reach a shared panel.
 *
 * This is a net, not a guarantee: the real containment is that parameters are summaries and
 * results are outcomes. It catches the case that actually happens — a token pasted into a command
 * or an environment assignment — at negligible cost.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/gu,
  /\bsk-[A-Za-z0-9_-]{16,}/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{16,}/gu,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  /\b(?:[Bb]earer|[Tt]oken)\s+[A-Za-z0-9._~+/=-]{12,}/gu,
  /\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY)[A-Z0-9_]*)\s*=\s*\S+/gu,
];

export function redact(value: string): string {
  let text = value;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return text;
}
