import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { assertDshUnchanged } from "../../../discovery/index.js";
import type { DshInstallation } from "../../../discovery/index.js";
import {
  RuntimeCompatibilityError,
  RuntimeUnsupportedError,
  type DshRuntimeDriver,
  type RuntimeAuthMethod,
  type RuntimeCapabilities,
  type RuntimeContentBlock,
  type RuntimeEvent,
  type RuntimePermissionOutcome,
  type RuntimePromptContext,
  type RuntimePromptInput,
  type RuntimeProvider,
  type RuntimeSession,
  type RuntimeSessionLoadInput,
  type RuntimeSessionOpenInput,
  type RuntimeSessionOpenResult,
  type RuntimeSessionPage,
  type RuntimeStopReason,
  type RuntimeTurnResult,
} from "../../types.js";
import { eventTurn, mapDshEvent, projectForHost, type DshToolRecord } from "./events.js";
import {
  loadInstalledDsh001Host,
  Dsh001HostInitializationError,
  type Dsh001Host,
  type Dsh001HostLoader,
  type DshApprovalOutcome,
  type DshHostAgent,
  type DshHostAgentHandle,
  type DshHostApprovalRequest,
  type DshHostEvent,
  type DshHostSession,
  type DshHostSessionHeader,
  type DshHostSessionRecord,
  type DshHostSessionSnapshot,
} from "./host.js";
import { classifyDshTool } from "./tool-kinds.js";

const UPDATE_TYPES = new Set<RuntimeEvent["type"]>([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "session_info_update",
  "usage_update",
]);

export const DSH_001_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  prompt: Object.freeze({ text: true, image: false, embeddedContext: false, resourceLink: true }),
  sessions: Object.freeze({
    load: true,
    resume: true,
    fork: true,
    list: true,
    close: true,
    delete: false,
    additionalDirectories: false,
  }),
  auth: Object.freeze({ authenticate: false, logout: false }),
  providers: false,
  mcp: Object.freeze({ stdio: true, http: true, sse: false }),
  steering: true,
  permissions: true,
  elicitation: Object.freeze({ form: false, url: false }),
  updates: UPDATE_TYPES,
});

type PromptStreamItem =
  | { readonly kind: "event"; readonly event: RuntimeEvent }
  | { readonly kind: "result"; readonly result: RuntimeTurnResult }
  | { readonly kind: "error"; readonly error: Error };

export const DSH_PROMPT_MAX_QUEUED_EVENTS = 1_024;
export const DSH_PROMPT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
export const DSH_PROMPT_MAX_EVENT_BYTES = 1024 * 1024;
export const DSH_APPROVAL_REASON_MAX_BYTES = 1024;
export const DSH_TEARDOWN_TIMEOUT_MS = 15_000;
export const DSH_SESSION_READ_TIMEOUT_MS = 15_000;
export const DSH_SESSION_PAGE_SIZE = 50;

function cancelled(label: string): RuntimeCompatibilityError {
  return new RuntimeCompatibilityError("DSH_SESSION_CANCELLED", `${label} was cancelled`);
}

async function boundedSessionRead<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  if (signal.aborted) throw cancelled(label);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(cancelled(label));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", onAbort);
    timer = setTimeout(() => {
      reject(new RuntimeCompatibilityError(
        "DSH_SESSION_READ_TIMEOUT",
        `${label} exceeded ${String(DSH_SESSION_READ_TIMEOUT_MS)}ms`,
      ));
    }, DSH_SESSION_READ_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbort?.();
  }
}

async function boundedTeardown<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new RuntimeCompatibilityError(
            "DSH_TEARDOWN_TIMEOUT",
            `${label} exceeded ${String(DSH_TEARDOWN_TIMEOUT_MS)}ms`,
          ));
        }, DSH_TEARDOWN_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface DescendantDrainState {
  operation: Promise<void> | undefined;
  complete: boolean;
}

function continueDescendantDrain(
  state: DescendantDrainState,
  operation: () => Promise<void>,
): Promise<void> {
  if (state.complete) return Promise.resolve();
  if (state.operation === undefined) {
    let tracked!: Promise<void>;
    tracked = Promise.resolve().then(operation).then(
      () => {
        if (state.operation === tracked) {
          state.complete = true;
          state.operation = undefined;
        }
      },
      (error: unknown) => {
        if (state.operation === tracked) state.operation = undefined;
        throw error;
      },
    );
    state.operation = tracked;
  }
  return state.operation;
}

class PromptEventStream {
  private readonly queue: { readonly item: PromptStreamItem; readonly bytes: number }[] = [];
  private waiter: ((item: PromptStreamItem) => void) | undefined;
  private terminal = false;
  private queuedBytes = 0;

  push(event: RuntimeEvent): void {
    if (this.terminal) return;
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(event);
    } catch {
      throw new RuntimeCompatibilityError("DSH_EVENT_INVALID", "DSH produced a non-serializable runtime event");
    }
    if (encoded === undefined) {
      throw new RuntimeCompatibilityError("DSH_EVENT_INVALID", "DSH produced a non-serializable runtime event");
    }
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > DSH_PROMPT_MAX_EVENT_BYTES) {
      throw new RuntimeCompatibilityError(
        "DSH_EVENT_TOO_LARGE",
        `DSH runtime event exceeded ${String(DSH_PROMPT_MAX_EVENT_BYTES)} bytes`,
      );
    }
    const item: PromptStreamItem = { kind: "event", event };
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      waiter(item);
      return;
    }
    if (this.queue.length >= DSH_PROMPT_MAX_QUEUED_EVENTS
      || this.queuedBytes + bytes > DSH_PROMPT_MAX_QUEUED_BYTES) {
      throw new RuntimeCompatibilityError(
        "DSH_EVENT_BACKPRESSURE",
        `DSH event backlog exceeded ${String(DSH_PROMPT_MAX_QUEUED_EVENTS)} events or ${String(DSH_PROMPT_MAX_QUEUED_BYTES)} bytes`,
      );
    }
    this.queue.push({ item, bytes });
    this.queuedBytes += bytes;
  }

  finish(result: RuntimeTurnResult): void {
    if (this.terminal) return;
    this.terminal = true;
    this.publish({ kind: "result", result });
  }

  fail(error: Error, discardBuffered = false): void {
    if (this.terminal) return;
    this.terminal = true;
    if (discardBuffered) {
      this.queue.length = 0;
      this.queuedBytes = 0;
    }
    this.publish({ kind: "error", error });
  }

  private publish(item: PromptStreamItem): void {
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.queue.push({ item, bytes: 0 });
      return;
    }
    this.waiter = undefined;
    waiter(item);
  }

  private async take(): Promise<PromptStreamItem> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.queuedBytes -= queued.bytes;
      return queued.item;
    }
    return await new Promise<PromptStreamItem>((resolve) => {
      this.waiter = resolve;
    });
  }

  async *iterate(): AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void> {
    while (true) {
      const item = await this.take();
      if (item.kind === "event") {
        yield item.event;
      } else if (item.kind === "result") {
        return item.result;
      } else {
        throw item.error;
      }
    }
  }
}

interface InflightPrompt {
  readonly context: RuntimePromptContext;
  readonly stream: PromptEventStream;
  readonly tools: Map<string, DshToolRecord>;
  turn: number | undefined;
  pendingError: boolean;
}

interface TurnCleanup {
  readonly turnId: string;
  readonly promise: Promise<void>;
}

function contentToText(input: RuntimePromptInput): string {
  return input.content.flatMap((block): string[] => {
    if (block.type === "text") return [block.text];
    if (block.type === "resource_link") {
      return [`\n[resource_link name=${JSON.stringify(block.name ?? "")} uri=${JSON.stringify(block.uri)}]\n`];
    }
    throw new RuntimeUnsupportedError(`prompt content ${block.type}`);
  }).join("");
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function headerIdentity(header: DshHostSessionHeader): readonly unknown[] {
  return [
    header.version,
    header.id,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.seedLength ?? null,
    header.origin ?? null,
    header.delegationDepth ?? null,
  ];
}

function assertSnapshotIdentity(
  snapshot: DshHostSessionSnapshot,
  expectedId: string,
  expectedCwd: string,
): void {
  if (snapshot.session.id !== expectedId) {
    throw new RuntimeCompatibilityError(
      "DSH_SESSION_ID_MISMATCH",
      "DSH returned history for a different session identity",
    );
  }
  if (snapshot.session.cwd === undefined || resolve(snapshot.session.cwd) !== resolve(expectedCwd)) {
    throw new RuntimeCompatibilityError(
      "DSH_SESSION_CWD_MISMATCH",
      "DSH persisted session cwd does not match the ACP request",
    );
  }
}

const DSH_SESSION_POLICY_EVENT_TYPES = new Set([
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
]);
const DSH_SESSION_POLICY_SETUP_ORDER = new Map([
  ["permission/preset", 0],
  ["sandbox/mode", 1],
  ["approval/policy", 2],
]);

function hasExactPlainShape(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) return false;
  const stringKeys = keys as string[];
  if (requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  return stringKeys.every(key => allowed.has(key));
}

/**
 * DSH folds these log-only facts on every capability call. Treat persisted,
 * seeded, and newly returned session logs as untrusted adoption input: an ACP
 * client cannot approve a wider standing sandbox or a no-prompt policy after
 * the fact. Exact event/data shapes also prevent merge extensions from
 * smuggling a policy event outside the reviewed 0.0.1 semantics.
 */
function assertSafeSessionPolicyEvents(
  events: readonly DshHostEvent[],
  label: string,
): void {
  const unsafe = (): never => {
    throw new RuntimeCompatibilityError(
      "DSH_SESSION_POLICY_UNSAFE",
      `${label} contains a permission policy outside the reviewed ACP boundary`,
    );
  };
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined || !DSH_SESSION_POLICY_EVENT_TYPES.has(event.type)) continue;
    if (!hasExactPlainShape(event, ["type", "seq", "time", "data"])
      || event.seq !== index
      || !Number.isSafeInteger(event.time)
      || (event.time as number) < 0) {
      unsafe();
    }
    if (event.type === "permission/preset") {
      if (!hasExactPlainShape(event.data, ["preset"])
        || (event.data["preset"] !== "read-only" && event.data["preset"] !== "workspace-write")) {
        unsafe();
      }
      continue;
    }
    if (event.type === "sandbox/mode") {
      if (!hasExactPlainShape(event.data, ["mode"], ["source"])
        || (event.data["mode"] !== "read-only" && event.data["mode"] !== "workspace-write")
        || (Object.prototype.hasOwnProperty.call(event.data, "source")
          && event.data["source"] !== "delegation")) {
        unsafe();
      }
      continue;
    }
    if (!hasExactPlainShape(event.data, ["policy"], ["source"])
      || event.data["policy"] !== "ask"
      || (Object.prototype.hasOwnProperty.call(event.data, "source")
        && event.data["source"] !== "delegation")) {
      unsafe();
    }
  }
}

function assertAdoptedSeed(
  seed: readonly DshHostEvent[],
  adopted: DshHostSessionSnapshot,
  label: string,
  allowEndSeedMarker = true,
  allowCrashRepair = false,
): void {
  if (adopted.events.length < seed.length) {
    throw new RuntimeCompatibilityError("DSH_SESSION_DRIFT", `${label} truncated persisted history`);
  }
  for (let index = 0; index < seed.length; index += 1) {
    if (!sameJson(adopted.events[index], seed[index])) {
      throw new RuntimeCompatibilityError("DSH_SESSION_DRIFT", `${label} changed history at seq ${String(index)}`);
    }
  }
  const suffix = adopted.events.slice(seed.length);
  if (suffix.length === 0) return;
  let setupBoundary = suffix.length;
  while (setupBoundary > 0
    && DSH_SESSION_POLICY_EVENT_TYPES.has(suffix[setupBoundary - 1]?.type ?? "")) {
    setupBoundary -= 1;
  }
  const setupPolicyEvents = suffix.slice(setupBoundary);
  const structuralSuffix = suffix.slice(0, setupBoundary);
  let previousSetupOrder = -1;
  for (const event of setupPolicyEvents) {
    const order = DSH_SESSION_POLICY_SETUP_ORDER.get(event.type);
    if (order === undefined || order <= previousSetupOrder) {
      throw new RuntimeCompatibilityError(
        "DSH_SESSION_DRIFT",
        `${label} appended policy facts outside the reviewed setup order`,
      );
    }
    previousSetupOrder = order;
  }
  // The permission service may pin missing safe facts after Session emits its
  // end-seed marker. A genuinely fresh empty fork has no marker and consists
  // only of these setup facts. Their values and exact shape are validated at
  // the actual-handle boundary before this adoption comparison.
  if (structuralSuffix.length === 0 && setupPolicyEvents.length > 0) return;
  const marker = structuralSuffix[structuralSuffix.length - 1];
  const validMarker = allowEndSeedMarker && marker?.type === "session/end-seed"
    && marker.seq === seed.length + structuralSuffix.length - 1 && sameJson(marker.data, {});
  if (!validMarker || (!allowCrashRepair && structuralSuffix.length !== 1)) {
    throw new RuntimeCompatibilityError("DSH_SESSION_DRIFT", `${label} appended unexpected history during setup`);
  }
}

function completeForkSeed(events: readonly DshHostEvent[]): readonly DshHostEvent[] {
  let boundary = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn/end") {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) return [];
  const seed = events.slice(0, boundary + 1);
  let openTurn = false;
  for (const event of seed) {
    if (event.type === "turn/start") {
      if (openTurn) {
        throw new RuntimeCompatibilityError(
          "DSH_FORK_SOURCE_INVALID",
          "DSH fork source contains overlapping open turns",
        );
      }
      openTurn = true;
    } else if (event.type === "turn/end") {
      if (!openTurn) {
        throw new RuntimeCompatibilityError(
          "DSH_FORK_SOURCE_INVALID",
          "DSH fork source contains a turn end without a matching start",
        );
      }
      openTurn = false;
    }
  }
  if (openTurn) {
    throw new RuntimeCompatibilityError(
      "DSH_FORK_SOURCE_INVALID",
      "DSH fork prefix ends inside an open turn",
    );
  }
  return seed;
}

function replayUserEvent(event: DshHostEvent): RuntimeEvent[] {
  if (event.type !== "user/message" && event.type !== "steering/message") return [];
  const data = record(event.data);
  const message = event.type === "steering/message" ? record(data?.["message"]) : data;
  const source = record(message?.["source"]);
  if (source?.["kind"] !== "user") return [];
  const content = message?.["content"];
  if (!Array.isArray(content)) {
    throw new RuntimeCompatibilityError("DSH_REPLAY_INVALID", "DSH user message has no content array");
  }
  const messageId = typeof message?.["id"] === "string" ? message["id"] : undefined;
  return content.flatMap((candidate): RuntimeEvent[] => {
    const block = record(candidate);
    if (block?.["type"] !== "text" || typeof block["text"] !== "string") {
      throw new RuntimeCompatibilityError(
        "DSH_REPLAY_CONTENT_UNSUPPORTED",
        "DSH replay contains a non-text user content block",
      );
    }
    return [{
      type: "user_message_chunk",
      content: { type: "text", text: block["text"] },
      ...(messageId === undefined ? {} : { messageId }),
    }];
  });
}

async function* replaySessionEvents(
  events: readonly DshHostEvent[],
  signal: AbortSignal,
): AsyncGenerator<RuntimeEvent, void, void> {
  const tools = new Map<string, DshToolRecord>();
  for (const event of events) {
    if (signal.aborted) throw cancelled("DSH session replay");
    const mapped = event.type === "user/message" || event.type === "steering/message"
      ? replayUserEvent(event)
      : mapDshEvent(event, tools);
    for (const update of mapped) {
      if (signal.aborted) throw cancelled("DSH session replay");
      yield update;
    }
  }
}

const CURSOR_PREFIX = "dsh001.";

function sessionListDigest(records: readonly DshHostSessionRecord[]): string {
  const canonical = records.map(record => headerIdentity(record.header));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function encodeSessionCursor(
  offset: number,
  digest: string,
  records: readonly DshHostSessionRecord[],
): string {
  const boundary = records[offset - 1];
  if (boundary === undefined) {
    throw new RuntimeCompatibilityError("DSH_SESSION_CURSOR_INVALID", "session cursor boundary is invalid");
  }
  const payload = JSON.stringify({
    v: 1,
    offset,
    digest,
    afterCreatedAt: boundary.header.createdAt,
    afterId: boundary.header.id,
  });
  return `${CURSOR_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

function decodeSessionCursor(
  cursor: string | undefined,
  digest: string,
  records: readonly DshHostSessionRecord[],
): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(CURSOR_PREFIX) || cursor.length > 1_024) {
    throw new RuntimeCompatibilityError("DSH_SESSION_CURSOR_INVALID", "session cursor is invalid");
  }
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  let value: unknown;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) throw new Error("non-canonical");
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new RuntimeCompatibilityError("DSH_SESSION_CURSOR_INVALID", "session cursor is invalid");
  }
  const payload = record(value);
  if (payload === undefined || Object.keys(payload).length !== 5
    || payload["v"] !== 1 || typeof payload["digest"] !== "string"
    || !/^[0-9a-f]{64}$/u.test(payload["digest"])
    || !Number.isSafeInteger(payload["offset"]) || (payload["offset"] as number) <= 0
    || (payload["offset"] as number) >= records.length
    || !Number.isSafeInteger(payload["afterCreatedAt"])
    || (payload["afterCreatedAt"] as number) < 0
    || typeof payload["afterId"] !== "string" || payload["afterId"].length === 0) {
    throw new RuntimeCompatibilityError("DSH_SESSION_CURSOR_INVALID", "session cursor is invalid");
  }
  if (payload["digest"] !== digest) {
    throw new RuntimeCompatibilityError(
      "DSH_SESSION_CURSOR_STALE",
      "session corpus changed between pages; restart listing without a cursor",
    );
  }
  const offset = payload["offset"] as number;
  const boundary = records[offset - 1];
  if (boundary === undefined || boundary.header.createdAt !== payload["afterCreatedAt"]
    || boundary.header.id !== payload["afterId"]) {
    throw new RuntimeCompatibilityError("DSH_SESSION_CURSOR_INVALID", "session cursor boundary is invalid");
  }
  return offset;
}

function turnStart(event: DshHostEvent): { readonly turn: number; readonly trigger: Readonly<Record<string, unknown>> } | undefined {
  if (event.type !== "turn/start") return undefined;
  const data = record(event.data);
  const turn = data?.["turn"];
  const trigger = record(data?.["trigger"]);
  return typeof turn === "number" && trigger !== undefined ? { turn, trigger } : undefined;
}

function turnEnd(event: DshHostEvent): { readonly turn: number; readonly reason: Readonly<Record<string, unknown>> } | undefined {
  if (event.type !== "turn/end") return undefined;
  const data = record(event.data);
  const turn = data?.["turn"];
  const reason = record(data?.["reason"]);
  return typeof turn === "number" && reason !== undefined ? { turn, reason } : undefined;
}

function stopReason(reason: Readonly<Record<string, unknown>>): RuntimeStopReason | "error" | "unsupported" {
  switch (reason["kind"]) {
    case "completed":
      return "end_turn";
    case "max-tokens":
      return "max_tokens";
    case "aborted":
    case "disposed":
    case "interrupted":
      return "cancelled";
    case "error":
      return "error";
    default:
      return "unsupported";
  }
}

function permissionSignal(request: DshHostApprovalRequest, context: RuntimePromptContext): AbortSignal {
  const requestSignal = request.signal;
  return requestSignal === undefined || requestSignal === context.signal
    ? context.signal
    : AbortSignal.any([requestSignal, context.signal]);
}

class Dsh001Session implements RuntimeSession {
  readonly id: string;
  readonly cwd: string;
  private inflight: InflightPrompt | undefined;
  private turnCleanupPending = false;
  private turnCleanup: TurnCleanup | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private disposed = false;
  private closeComplete = false;
  private readonly descendantDrain: DescendantDrainState = {
    operation: undefined,
    complete: false,
  };

  constructor(
    private readonly host: Dsh001Host,
    private readonly handle: DshHostAgentHandle,
    cwd: string,
    private readonly didClose: (id: string) => void,
  ) {
    this.id = handle.agent.id;
    this.cwd = cwd;
  }

  owns(agent: DshHostAgent): boolean {
    return this.handle.agent === agent;
  }

  ownsSession(session: DshHostSession): boolean {
    return this.handle.agent.session === session;
  }

  isIdleForFork(): boolean {
    return !this.closed
      && this.inflight === undefined
      && !this.turnCleanupPending
      && this.handle.agent.status === "idle"
      && this.host.isAgentLive(this.handle.agent);
  }

  /**
   * Settlement is authoritative even when the host's synchronous cancel seam
   * fails. Retire the session on failure so the still-running DSH turn can
   * never overlap a later prompt; close() retains the handle and retries the
   * same cleanup path.
   */
  private cancelAgentAfterSettlement(): unknown | undefined {
    try {
      this.handle.agent.cancel({ kind: "user" });
      return undefined;
    } catch (error) {
      this.closed = true;
      return error;
    }
  }

  onSessionEvent(event: DshHostEvent): void {
    const inflight = this.inflight;
    if (this.closed || inflight === undefined) return;

    const started = turnStart(event);
    if (started !== undefined) {
      const kind = started.trigger["kind"];
      const source = record(started.trigger["source"]);
      if (inflight.turn === undefined && kind === "message" && source?.["kind"] === "user") {
        inflight.turn = started.turn;
      } else if (inflight.pendingError && kind === "retry") {
        inflight.turn = started.turn;
        inflight.pendingError = false;
      }
      return;
    }

    const ended = turnEnd(event);
    if (ended !== undefined && inflight.turn === ended.turn) {
      const reason = stopReason(ended.reason);
      if (reason === "error") {
        // DSH recovery can immediately adopt this prompt in a retry turn.
        // Settle only when the agent reaches idle without that successor.
        inflight.turn = undefined;
        inflight.pendingError = true;
      } else if (reason === "unsupported") {
        this.inflight = undefined;
        inflight.stream.fail(new RuntimeCompatibilityError(
          "DSH_TURN_REASON_UNSUPPORTED",
          `DSH returned an unsupported turn end reason: ${String(ended.reason["kind"])}`,
        ));
      } else {
        this.inflight = undefined;
        inflight.stream.finish({ stopReason: reason });
      }
      return;
    }

    const eventOwnedTurn = eventTurn(event);
    if (eventOwnedTurn !== undefined && eventOwnedTurn !== inflight.turn) return;
    try {
      for (const mapped of mapDshEvent(event, inflight.tools)) inflight.stream.push(mapped);
    } catch (error) {
      this.inflight = undefined;
      // An event that cannot be mapped means this live DSH generation is no
      // longer safe to reuse even if its defensive cancel succeeds.
      this.closed = true;
      inflight.stream.fail(
        error instanceof Error ? error : new Error(String(error)),
        true,
      );
      // Preserve the mapping failure as the prompt's sole settlement. A
      // synchronous cancel failure retires the session for close() instead of
      // replacing that already-published error or leaving the stream pending.
      this.cancelAgentAfterSettlement();
    }
  }

  onAgentStatus(status: string): void {
    const inflight = this.inflight;
    if (status !== "idle" || inflight === undefined || inflight.turn !== undefined) return;
    this.inflight = undefined;
    if (inflight.pendingError) {
      inflight.stream.fail(new Error("DSH turn failed; inspect DSH diagnostics for the provider or tool error"));
    } else {
      inflight.stream.finish({ stopReason: "cancelled" });
    }
  }

  async onApproval(
    request: DshHostApprovalRequest,
    next: () => Promise<DshApprovalOutcome>,
  ): Promise<DshApprovalOutcome> {
    const inflight = this.inflight;
    if (this.closed || inflight === undefined || request.callId === undefined) return await next();
    const known = inflight.tools.get(request.callId);
    const signal = permissionSignal(request, inflight.context);
    const kind = known?.kind ?? classifyDshTool(request.toolName, known?.rawInput);
    try {
      const projectedReason = request.reason === undefined
        ? undefined
        : projectForHost(request.reason, DSH_APPROVAL_REASON_MAX_BYTES);
      const outcome = await inflight.context.requestPermission({
        requestId: randomUUID(),
        toolCallId: request.callId,
        title: request.toolName,
        kind,
        choices: [
          { id: "allow-once", name: "Allow once", kind: "allow_once" },
          { id: "reject-once", name: "Reject", kind: "reject_once" },
        ],
        ...(known?.rawInput === undefined ? {} : { rawInput: known.rawInput }),
        ...(projectedReason === undefined ? {} : { _meta: { reason: projectedReason } }),
      }, signal);
      if (outcome.outcome === "cancelled" || signal.aborted) return "cancelled";
      return outcome.optionId === "allow-once" ? "allowed-once" : "rejected";
    } catch {
      return signal.aborted ? "cancelled" : "rejected";
    }
  }

  async *prompt(
    input: RuntimePromptInput,
    context: RuntimePromptContext,
  ): AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void> {
    if (this.closed) throw new RuntimeCompatibilityError("DSH_SESSION_CLOSED", `session ${this.id} is closed`);
    if (this.inflight !== undefined || this.turnCleanupPending) {
      throw new RuntimeCompatibilityError("DSH_PROMPT_INFLIGHT", `session ${this.id} already has a prompt in flight`);
    }
    if (!this.host.isAgentLive(this.handle.agent)) {
      throw new RuntimeCompatibilityError("DSH_AGENT_RETIRED", `session ${this.id} no longer owns a live DSH agent`);
    }
    const text = contentToText(input);
    if (text.trim().length === 0) {
      throw new RuntimeCompatibilityError("DSH_PROMPT_EMPTY", "prompt must contain non-empty text or a resource link");
    }

    const stream = new PromptEventStream();
    const inflight: InflightPrompt = {
      context,
      stream,
      tools: new Map(),
      turn: undefined,
      pendingError: false,
    };
    this.inflight = inflight;
    const onAbort = (): void => {
      void this.cancel(context.turnId).catch((error: unknown) => {
        stream.fail(error instanceof Error ? error : new Error(String(error)));
      });
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (context.signal.aborted) {
        this.inflight = undefined;
        stream.finish({ stopReason: "cancelled" });
      } else {
        try {
          this.handle.agent.followup(this.host.createUserMessage(text));
        } catch (error) {
          this.inflight = undefined;
          throw new RuntimeCompatibilityError("DSH_PROMPT_REJECTED", `DSH rejected the prompt: ${String(error)}`);
        }
      }
      return yield* stream.iterate();
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (this.inflight === inflight) {
        this.inflight = undefined;
        this.turnCleanupPending = true;
        stream.finish({ stopReason: "cancelled" });
        // The generator may already be returning or throwing. Never replace
        // that settlement with a host cleanup exception, but keep the session
        // fenced until the abandoned DSH turn is actually idle.
        this.cancelAgentAfterSettlement();
        try {
          await boundedTeardown(
            this.handle.agent.whenIdle(),
            `DSH session ${this.id} abandoned prompt drain`,
          );
        } catch {
          this.closed = true;
        } finally {
          this.turnCleanupPending = false;
        }
      }
    }
  }

  cancel(turnId: string): Promise<void> {
    const existing = this.turnCleanup;
    if (existing?.turnId === turnId) return existing.promise;
    const inflight = this.inflight;
    if (inflight === undefined || inflight.context.turnId !== turnId) return Promise.resolve();
    this.inflight = undefined;
    this.turnCleanupPending = true;
    // Publish the terminal result before invoking the fallible host seam so
    // abort-driven callers cannot strand the prompt generator.
    inflight.stream.finish({ stopReason: "cancelled" });
    let tracked!: Promise<void>;
    tracked = this.cancelOwned().finally(() => {
      if (this.turnCleanup?.promise === tracked) {
        this.turnCleanup = undefined;
        this.turnCleanupPending = false;
      }
    });
    this.turnCleanup = { turnId, promise: tracked };
    return tracked;
  }

  private async cancelOwned(): Promise<void> {
    const failures: unknown[] = [];
    const cancelError = this.cancelAgentAfterSettlement();
    if (cancelError !== undefined) failures.push(cancelError);
    try {
      await boundedTeardown(this.handle.agent.whenIdle(), `DSH session ${this.id} cancellation drain`);
    } catch (error) {
      this.closed = true;
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, `failed to cancel DSH session ${this.id}`);
    }
  }

  async steer(input: RuntimePromptInput, signal: AbortSignal): Promise<void> {
    if (this.closed) throw new RuntimeCompatibilityError("DSH_SESSION_CLOSED", `session ${this.id} is closed`);
    const steer = this.handle.agent.steer;
    if (steer === undefined) throw new RuntimeUnsupportedError("session steering");
    const text = contentToText(input);
    if (text.trim().length === 0) throw new RuntimeCompatibilityError("DSH_STEER_EMPTY", "steering text is empty");
    if (signal.aborted) throw new RuntimeCompatibilityError("DSH_STEER_CANCELLED", "steering was cancelled");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<{ status: "rejected" }>((settle) => {
      onAbort = () => settle({ status: "rejected" });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let outcome: { readonly status: "admitted" | "rejected" };
    try {
      // Abort may race the first check and listener registration. Recheck
      // after registration, then keep the listener armed while DSH steer()
      // runs because that call may synchronously abort before returning its
      // receipt.
      if (signal.aborted) onAbort?.();
      if (signal.aborted) {
        outcome = { status: "rejected" };
      } else {
        const receipt = steer.call(this.handle.agent, this.host.createUserMessage(text));
        if (signal.aborted) onAbort?.();
        outcome = await Promise.race([receipt.outcome, aborted]);
      }
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
    if (outcome.status !== "admitted") {
      throw new RuntimeCompatibilityError("DSH_STEER_REJECTED", "DSH did not admit the steering message");
    }
  }

  close(): Promise<void> {
    if (this.closePromise === undefined) {
      const attempt = this.closeOwned();
      this.closePromise = attempt;
      void attempt.catch(() => {
        // A transient drain or disposal failure keeps this exact cleanup
        // record driver-owned and retryable. The session stays closed to new
        // prompt work during that gap.
        if (!this.closeComplete && this.closePromise === attempt) this.closePromise = undefined;
      });
    }
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    this.closed = true;
    const inflight = this.inflight;
    this.inflight = undefined;
    const failures: unknown[] = [];
    if (!this.disposed) {
      try {
        this.handle.agent.cancel({ kind: "user" });
      } catch (error) {
        failures.push(error);
      }
    }
    inflight?.stream.finish({ stopReason: "cancelled" });
    if (!this.disposed) {
      try {
        await boundedTeardown(
          this.handle.agent.whenIdle(),
          `DSH session ${this.id} close cancellation drain`,
        );
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await boundedTeardown(
        continueDescendantDrain(
          this.descendantDrain,
          () => this.host.drainContinuableDescendants([this.handle.agent]),
        ),
        `DSH session ${this.id} descendant drain`,
      );
    } catch (error) {
      failures.push(error);
    }
    // DSH accepts only an exact live registry root for descendant draining.
    // Never unregister the root while that drain is pending or failed: a
    // timeout keeps the original operation reachable, while a rejection can
    // be retried against the still-live root.
    if (this.descendantDrain.complete && !this.disposed) {
      try {
        await boundedTeardown(this.handle.dispose(), `DSH session ${this.id} handle disposal`);
        this.disposed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to close DSH session ${this.id}`);
    }
    this.didClose(this.id);
    this.closeComplete = true;
  }
}

interface PendingHandleCleanup {
  readonly host: Dsh001Host;
  readonly handle: DshHostAgentHandle;
  readonly label: string;
  readonly descendantDrain: DescendantDrainState;
  closePromise: Promise<void> | undefined;
  disposed: boolean;
}

export interface Dsh001DriverOptions {
  readonly hostLoader?: Dsh001HostLoader;
}

export class Dsh001RuntimeDriver implements DshRuntimeDriver {
  readonly id = "dsh-source-0.0.1";
  readonly runtimeFingerprint: string;
  readonly capabilities = DSH_001_CAPABILITIES;
  readonly authMethods: readonly RuntimeAuthMethod[] = [];
  private readonly hostLoader: Dsh001HostLoader;
  private host: Dsh001Host | undefined;
  private initializing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private initialized = false;
  private readonly sessions = new Map<string, Dsh001Session>();
  private readonly pendingHandleCleanups = new Map<DshHostAgentHandle, PendingHandleCleanup>();
  private readonly pendingHostCleanups = new Set<() => Promise<void>>();
  private readonly openingSessionIds = new Set<string>();
  private readonly listenerDisposers: (() => void)[] = [];

  constructor(
    readonly installation: DshInstallation,
    options: Dsh001DriverOptions = {},
  ) {
    this.runtimeFingerprint = installation.fingerprint;
    this.hostLoader = options.hostLoader ?? loadInstalledDsh001Host;
  }

  initialize(signal: AbortSignal): Promise<void> {
    this.initializing ??= this.initializeOnce(signal);
    return this.initializing;
  }

  private async initializeOnce(signal: AbortSignal): Promise<void> {
    if (this.closed || signal.aborted) {
      throw new RuntimeCompatibilityError("DSH_INITIALIZE_CANCELLED", "DSH runtime initialization was cancelled");
    }
    await assertDshUnchanged(this.installation);
    let host: Dsh001Host;
    try {
      host = await this.hostLoader(this.installation);
    } catch (error) {
      if (error instanceof Dsh001HostInitializationError) {
        this.pendingHostCleanups.add(error.cleanup);
      }
      throw error;
    }
    // Publish ownership immediately. Readiness remains false until every
    // listener is registered; failed rollback stays reachable by close().
    this.host = host;
    if (this.closed || signal.aborted) {
      const cancelledError = new RuntimeCompatibilityError(
        "DSH_INITIALIZE_CANCELLED",
        "DSH runtime initialization was cancelled",
      );
      try {
        await boundedTeardown(host.close(), "DSH host rollback after cancelled initialization");
        if (this.host === host) this.host = undefined;
      } catch (closeError) {
        throw new AggregateError([cancelledError, closeError], "failed to roll back cancelled DSH initialization");
      }
      throw cancelledError;
    }
    const registered: (() => void)[] = [];
    try {
      registered.push(host.onSessionEvent((session, event) => {
        const owned = this.sessions.get(session.id);
        if (owned?.ownsSession(session) === true) owned.onSessionEvent(event);
      }));
      registered.push(host.onAgentStatus((agent, status) => {
        const owned = this.sessions.get(agent.id);
        if (owned?.owns(agent) === true) owned.onAgentStatus(status);
      }));
      registered.push(host.onApproval(async (request, next) => {
        const owned = this.sessions.get(request.agent.id);
        return owned?.owns(request.agent) === true ? await owned.onApproval(request, next) : await next();
      }));
      if (this.closed || signal.aborted) {
        throw new RuntimeCompatibilityError("DSH_INITIALIZE_CANCELLED", "DSH runtime initialization was cancelled");
      }
    } catch (error) {
      const failures: unknown[] = [error];
      const failedDisposers: (() => void)[] = [];
      for (const dispose of registered.reverse()) {
        try {
          dispose();
        } catch (disposeError) {
          failures.push(disposeError);
          failedDisposers.push(dispose);
        }
      }
      try {
        await boundedTeardown(host.close(), "DSH host rollback after listener failure");
        if (this.host === host) this.host = undefined;
      } catch (closeError) {
        failures.push(closeError);
        this.listenerDisposers.push(...failedDisposers.reverse());
      }
      throw failures.length === 1
        ? error
        : new AggregateError(failures, "failed to roll back DSH runtime initialization");
    }
    this.listenerDisposers.push(...registered);
    this.initialized = true;
  }

  private requireHost(): Dsh001Host {
    if (this.closed) throw new RuntimeCompatibilityError("DSH_RUNTIME_CLOSED", "DSH runtime is closed");
    if (!this.initialized || this.host === undefined) {
      throw new RuntimeCompatibilityError("DSH_RUNTIME_NOT_INITIALIZED", "initialize must complete before opening a session");
    }
    return this.host;
  }

  private validateWorkspaceInput(
    input: Pick<RuntimeSessionOpenInput, "cwd" | "additionalDirectories" | "mcpServers">,
    host: Dsh001Host,
    signal: AbortSignal,
  ): void {
    if (!isAbsolute(input.cwd)) {
      throw new RuntimeCompatibilityError("DSH_CWD_INVALID", `session cwd must be absolute: ${input.cwd}`);
    }
    if (resolve(input.cwd) !== resolve(host.cwd)) {
      throw new RuntimeCompatibilityError(
        "DSH_CWD_UNSUPPORTED",
        `DSH 0.0.1 binds filesystem and sandbox services to ${host.cwd}; requested session cwd was ${input.cwd}`,
      );
    }
    if (input.additionalDirectories.length > 0) throw new RuntimeUnsupportedError("additional directories");
    for (const server of input.mcpServers) {
      if (server.transport === "stdio" && !isAbsolute(server.command)) {
        throw new RuntimeCompatibilityError(
          "DSH_MCP_CONFIG_INVALID",
          `MCP stdio command must be absolute: ${server.command}`,
        );
      }
      if (server.transport === "sse") throw new RuntimeUnsupportedError("MCP SSE servers");
    }
    if (signal.aborted) throw cancelled("DSH session operation");
  }

  private claimSessionId(id: string): () => void {
    if (id.length === 0 || id.includes("\0")) {
      throw new RuntimeCompatibilityError("DSH_SESSION_ID_INVALID", "session id is empty or contains a NUL byte");
    }
    if (this.sessions.has(id) || this.openingSessionIds.has(id)) {
      throw new RuntimeCompatibilityError("DSH_SESSION_ALREADY_ACTIVE", `session ${id} is already active`);
    }
    this.openingSessionIds.add(id);
    return () => this.openingSessionIds.delete(id);
  }

  private async hostSessions(host: Dsh001Host, signal: AbortSignal): Promise<readonly DshHostSessionRecord[]> {
    return boundedSessionRead(host.listSessions(signal), signal, "DSH session listing");
  }

  private async hostSnapshot(
    host: Dsh001Host,
    id: string,
    signal: AbortSignal,
  ): Promise<DshHostSessionSnapshot> {
    return boundedSessionRead(host.readSession(id, signal), signal, `DSH session ${id} read`);
  }

  private validateHandle(
    host: Dsh001Host,
    handle: DshHostAgentHandle,
    expectedId: string,
    expectedCwd: string,
  ): void {
    const header = handle.agent.session.header;
    if (handle.agent.id !== expectedId || handle.agent.session.id !== expectedId || header.id !== expectedId) {
      throw new RuntimeCompatibilityError("DSH_SESSION_ID_MISMATCH", "DSH returned a mismatched agent/session identity");
    }
    if (header.cwd === undefined || resolve(header.cwd) !== resolve(expectedCwd)) {
      throw new RuntimeCompatibilityError("DSH_SESSION_CWD_MISMATCH", "DSH returned a mismatched session cwd");
    }
    if (!host.isAgentLive(handle.agent)) {
      throw new RuntimeCompatibilityError(
        "DSH_SESSION_OWNERSHIP_MISMATCH",
        "DSH returned an agent that is not the live registry owner",
      );
    }
    assertSafeSessionPolicyEvents(handle.agent.session.events, "DSH live session");
    if (this.closed) throw new RuntimeCompatibilityError("DSH_RUNTIME_CLOSED", "DSH runtime closed during session setup");
  }

  private rollbackHandle(
    host: Dsh001Host,
    handle: DshHostAgentHandle,
    label: string,
  ): Promise<void> {
    const cleanup = this.pendingHandleCleanups.get(handle) ?? {
      host,
      handle,
      label,
      descendantDrain: { operation: undefined, complete: false },
      closePromise: undefined,
      disposed: false,
    };
    this.pendingHandleCleanups.set(handle, cleanup);
    if (cleanup.closePromise === undefined) {
      let tracked!: Promise<void>;
      tracked = this.rollbackHandleOwned(cleanup).catch((error: unknown) => {
        if (cleanup.closePromise === tracked) cleanup.closePromise = undefined;
        throw error;
      });
      cleanup.closePromise = tracked;
    }
    return cleanup.closePromise;
  }

  private async rollbackHandleOwned(cleanup: PendingHandleCleanup): Promise<void> {
    const failures: unknown[] = [];
    if (!cleanup.disposed) {
      try {
        cleanup.handle.agent.cancel({ kind: "user" });
      } catch (error) {
        failures.push(error);
      }
      try {
        await boundedTeardown(cleanup.handle.agent.whenIdle(), `${cleanup.label} cancellation drain`);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await boundedTeardown(
        continueDescendantDrain(
          cleanup.descendantDrain,
          () => cleanup.host.drainContinuableDescendants([cleanup.handle.agent]),
        ),
        `${cleanup.label} descendant drain`,
      );
    } catch (error) {
      failures.push(error);
    }
    if (cleanup.descendantDrain.complete && !cleanup.disposed) {
      try {
        await boundedTeardown(cleanup.handle.dispose(), `${cleanup.label} disposal`);
        cleanup.disposed = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `failed to roll back ${cleanup.label}`);
    }
    this.pendingHandleCleanups.delete(cleanup.handle);
  }

  private async rejectHandle(
    host: Dsh001Host,
    handle: DshHostAgentHandle,
    label: string,
    cause: unknown,
  ): Promise<never> {
    try {
      await this.rollbackHandle(host, handle, label);
    } catch (rollbackError) {
      throw new AggregateError([cause, rollbackError], `${label} validation and rollback failed`);
    }
    throw cause;
  }

  private attachHandle(
    host: Dsh001Host,
    handle: DshHostAgentHandle,
    cwd: string,
  ): Dsh001Session {
    const session = new Dsh001Session(host, handle, cwd, (id) => this.sessions.delete(id));
    if (this.sessions.has(session.id)) {
      throw new RuntimeCompatibilityError("DSH_SESSION_ALREADY_ACTIVE", `session ${session.id} is already active`);
    }
    this.sessions.set(session.id, session);
    return session;
  }

  async newSession(input: RuntimeSessionOpenInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult> {
    const host = this.requireHost();
    this.validateWorkspaceInput(input, host, signal);
    if (input.modeId !== undefined) throw new RuntimeUnsupportedError("session modes");
    if (input.config !== undefined && Object.keys(input.config).length > 0) {
      throw new RuntimeUnsupportedError("session config options");
    }

    const requestedId = randomUUID();
    const releaseClaim = this.claimSessionId(requestedId);
    let handle: DshHostAgentHandle | undefined;
    try {
      handle = await host.createAgent({
        id: requestedId,
        cwd: input.cwd,
        mcpServers: input.mcpServers,
        signal,
      });
      const opened = handle;
      try {
        if (signal.aborted) throw cancelled("DSH session creation");
        this.validateHandle(host, opened, requestedId, input.cwd);
        const session = this.attachHandle(host, opened, input.cwd);
        handle = undefined;
        return { session, descriptor: { id: session.id, cwd: session.cwd } };
      } catch (error) {
        handle = undefined;
        return await this.rejectHandle(host, opened, `DSH session ${requestedId}`, error);
      }
    } finally {
      releaseClaim();
      if (handle !== undefined) {
        await this.rollbackHandle(host, handle, `DSH session ${requestedId}`).catch(() => undefined);
      }
    }
  }

  private async openPersistedSession(
    input: RuntimeSessionLoadInput,
    signal: AbortSignal,
    includeReplay: boolean,
  ): Promise<RuntimeSessionOpenResult> {
    const host = this.requireHost();
    this.validateWorkspaceInput(input, host, signal);
    const releaseClaim = this.claimSessionId(input.sessionId);
    let handle: DshHostAgentHandle | undefined;
    try {
      const records = await this.hostSessions(host, signal);
      const listed = records.find(record => record.header.id === input.sessionId);
      if (listed === undefined) {
        throw new RuntimeCompatibilityError("DSH_SESSION_NOT_FOUND", `session ${input.sessionId} was not found`);
      }
      if (listed.live) {
        throw new RuntimeCompatibilityError(
          "DSH_SESSION_ALREADY_ACTIVE",
          `session ${input.sessionId} already has a live DSH owner`,
        );
      }
      if (!listed.persisted) {
        throw new RuntimeCompatibilityError(
          "DSH_SESSION_NOT_PERSISTED",
          `session ${input.sessionId} has no persisted history to resume`,
        );
      }

      const before = await this.hostSnapshot(host, input.sessionId, signal);
      assertSnapshotIdentity(before, input.sessionId, input.cwd);
      assertSafeSessionPolicyEvents(before.events, "DSH persisted session");
      if (!sameJson(headerIdentity(before.session), headerIdentity(listed.header))) {
        throw new RuntimeCompatibilityError(
          "DSH_SESSION_DRIFT",
          "DSH session header changed between listing and read",
        );
      }

      handle = await host.resumeAgent({
        id: input.sessionId,
        cwd: input.cwd,
        mcpServers: input.mcpServers,
        signal,
      });
      const opened = handle;
      try {
        if (signal.aborted) throw cancelled("DSH session resume");
        this.validateHandle(host, opened, input.sessionId, input.cwd);
        const liveSnapshot: DshHostSessionSnapshot = {
          session: opened.agent.session.header,
          events: opened.agent.session.events,
        };
        if (!sameJson(headerIdentity(liveSnapshot.session), headerIdentity(before.session))) {
          throw new RuntimeCompatibilityError(
            "DSH_SESSION_DRIFT",
            "DSH resume changed immutable session metadata",
          );
        }
        // agents.resume may crash-repair an open persisted tail before adding
        // its end-seed marker. The immutable observed prefix must remain exact;
        // the versioned public resume seam owns validation of the repair suffix.
        assertAdoptedSeed(before.events, liveSnapshot, "DSH resume", true, true);
        const session = this.attachHandle(host, opened, input.cwd);
        handle = undefined;
        return {
          session,
          descriptor: { id: session.id, cwd: session.cwd },
          ...(includeReplay ? { replay: replaySessionEvents(liveSnapshot.events, signal) } : {}),
        };
      } catch (error) {
        handle = undefined;
        return await this.rejectHandle(host, opened, `DSH session ${input.sessionId}`, error);
      }
    } finally {
      releaseClaim();
      if (handle !== undefined) {
        await this.rollbackHandle(host, handle, `DSH session ${input.sessionId}`).catch(() => undefined);
      }
    }
  }

  authenticate(_methodId: string, _signal: AbortSignal): Promise<void> {
    return Promise.reject(new RuntimeUnsupportedError("authentication"));
  }

  logout(_signal: AbortSignal): Promise<void> {
    return Promise.reject(new RuntimeUnsupportedError("logout"));
  }

  listProviders(_signal: AbortSignal): Promise<{
    providers: readonly RuntimeProvider[];
    currentProviderId?: string;
  }> {
    return Promise.reject(new RuntimeUnsupportedError("provider listing"));
  }

  setProvider(_providerId: string, _signal: AbortSignal): Promise<void> {
    return Promise.reject(new RuntimeUnsupportedError("provider selection"));
  }

  disableProvider(_providerId: string, _signal: AbortSignal): Promise<void> {
    return Promise.reject(new RuntimeUnsupportedError("provider disabling"));
  }

  loadSession(input: RuntimeSessionLoadInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult> {
    return this.openPersistedSession(input, signal, true);
  }

  resumeSession(input: RuntimeSessionLoadInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult> {
    return this.openPersistedSession(input, signal, false);
  }

  async forkSession(input: RuntimeSessionLoadInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult> {
    const host = this.requireHost();
    this.validateWorkspaceInput(input, host, signal);
    const records = await this.hostSessions(host, signal);
    const sourceRecord = records.find(record => record.header.id === input.sessionId);
    if (sourceRecord === undefined) {
      throw new RuntimeCompatibilityError("DSH_SESSION_NOT_FOUND", `session ${input.sessionId} was not found`);
    }
    const ownedSource = this.sessions.get(input.sessionId);
    if (sourceRecord.live && ownedSource === undefined) {
      throw new RuntimeCompatibilityError(
        "DSH_SESSION_OWNERSHIP_MISMATCH",
        `fork source ${input.sessionId} has a live DSH owner outside this adapter connection`,
      );
    }
    if (ownedSource !== undefined && !ownedSource.isIdleForFork()) {
      throw new RuntimeCompatibilityError(
        "DSH_SESSION_BUSY",
        `fork source ${input.sessionId} must be idle`,
      );
    }
    const source = await this.hostSnapshot(host, input.sessionId, signal);
    assertSnapshotIdentity(source, input.sessionId, input.cwd);
    if (!sameJson(headerIdentity(source.session), headerIdentity(sourceRecord.header))) {
      throw new RuntimeCompatibilityError("DSH_SESSION_DRIFT", "DSH fork source changed during preflight");
    }
    const seed = completeForkSeed(source.events);
    assertSafeSessionPolicyEvents(seed, "DSH fork seed");
    const childId = randomUUID();
    if (records.some(record => record.header.id === childId)) {
      throw new RuntimeCompatibilityError("DSH_SESSION_ID_COLLISION", "generated DSH fork id already exists");
    }
    const releaseClaim = this.claimSessionId(childId);
    let handle: DshHostAgentHandle | undefined;
    try {
      handle = await host.createAgent({
        id: childId,
        cwd: input.cwd,
        mcpServers: input.mcpServers,
        signal,
        ...(seed.length === 0 ? {} : { seed }),
        parentSession: input.sessionId,
      });
      const opened = handle;
      try {
        if (signal.aborted) throw cancelled("DSH session fork");
        this.validateHandle(host, opened, childId, input.cwd);
        const liveSnapshot: DshHostSessionSnapshot = {
          session: opened.agent.session.header,
          events: opened.agent.session.events,
        };
        if (liveSnapshot.session.parentSession !== input.sessionId
          || liveSnapshot.session.seedLength !== seed.length) {
          throw new RuntimeCompatibilityError(
            "DSH_SESSION_LINEAGE_MISMATCH",
            "DSH fork did not preserve parentSession and seedLength",
          );
        }
        assertAdoptedSeed(seed, liveSnapshot, "DSH fork", seed.length > 0);
        const session = this.attachHandle(host, opened, input.cwd);
        handle = undefined;
        return { session, descriptor: { id: session.id, cwd: session.cwd } };
      } catch (error) {
        handle = undefined;
        return await this.rejectHandle(host, opened, `DSH fork ${childId}`, error);
      }
    } finally {
      releaseClaim();
      if (handle !== undefined) {
        await this.rollbackHandle(host, handle, `DSH fork ${childId}`).catch(() => undefined);
      }
    }
  }

  async listSessions(
    cwd: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<RuntimeSessionPage> {
    const host = this.requireHost();
    if (cwd !== undefined && !isAbsolute(cwd)) {
      throw new RuntimeCompatibilityError("DSH_CWD_INVALID", `session list cwd must be absolute: ${cwd}`);
    }
    const effectiveCwd = cwd ?? host.cwd;
    if (resolve(effectiveCwd) !== resolve(host.cwd)) {
      return { sessions: [] };
    }
    const listed = [...await this.hostSessions(host, signal)]
      .filter((candidate): candidate is DshHostSessionRecord & {
        readonly header: DshHostSessionHeader & { readonly cwd: string };
      } => candidate.header.cwd !== undefined
        && resolve(candidate.header.cwd) === resolve(host.cwd))
      .sort((left, right) => right.header.createdAt - left.header.createdAt
        || (left.header.id < right.header.id ? -1 : left.header.id > right.header.id ? 1 : 0));
    const digest = sessionListDigest(listed);
    const offset = decodeSessionCursor(cursor, digest, listed);
    const pageRecords = listed.slice(offset, offset + DSH_SESSION_PAGE_SIZE);
    const sessions: RuntimeSessionPage["sessions"][number][] = [];
    for (const item of pageRecords) {
      if (signal.aborted) throw cancelled("DSH session listing");
      const [snapshot, title] = await Promise.all([
        this.hostSnapshot(host, item.header.id, signal),
        boundedSessionRead(
          host.readTitle(item.header.id, signal),
          signal,
          `DSH session ${item.header.id} title read`,
        ),
      ]);
      if (!sameJson(headerIdentity(snapshot.session), headerIdentity(item.header))) {
        throw new RuntimeCompatibilityError(
          "DSH_SESSION_DRIFT",
          `DSH session ${item.header.id} changed while building the list page`,
        );
      }
      let lastActivity = item.header.createdAt;
      for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
        const event = snapshot.events[index];
        if (event !== undefined && event.type !== "session/end-seed") {
          lastActivity = event.time ?? item.header.createdAt;
          break;
        }
      }
      const updatedAt = new Date(lastActivity);
      if (Number.isNaN(updatedAt.valueOf())) {
        throw new RuntimeCompatibilityError(
          "DSH_SESSION_TIMESTAMP_INVALID",
          `DSH session ${item.header.id} has an invalid activity timestamp`,
        );
      }
      sessions.push({
        id: item.header.id,
        cwd: item.header.cwd,
        ...(title === undefined ? {} : { title: title.title }),
        updatedAt: updatedAt.toISOString(),
      });
    }
    const nextOffset = offset + pageRecords.length;
    return {
      sessions,
      ...(nextOffset < listed.length ? { nextCursor: encodeSessionCursor(nextOffset, digest, listed) } : {}),
    };
  }

  deleteSession(_sessionId: string, _signal: AbortSignal): Promise<void> {
    return Promise.reject(new RuntimeUnsupportedError("session deletion"));
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      const attempt = this.closeOnce();
      this.closing = attempt;
      void attempt.catch(() => {
        if (this.closing === attempt) this.closing = undefined;
      });
    }
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const initializing = this.initializing;
    if (initializing !== undefined) {
      await boundedTeardown(
        initializing.catch(() => undefined),
        "DSH initialization shutdown drain",
      );
    }
    const hostCleanupResults = await Promise.allSettled(
      [...this.pendingHostCleanups].map(async (cleanup) => {
        await boundedTeardown(cleanup(), "DSH failed-initialization cleanup");
        this.pendingHostCleanups.delete(cleanup);
      }),
    );
    const hostCleanupFailures = hostCleanupResults
      .flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (hostCleanupFailures.length > 0 || this.pendingHostCleanups.size > 0) {
      throw new AggregateError(hostCleanupFailures, "failed to finish DSH initialization cleanup");
    }
    const sessionResults = await Promise.allSettled(
      [...this.sessions.values()].map(session => session.close()),
    );
    const orphanResults = await Promise.allSettled(
      [...this.pendingHandleCleanups.values()].map(cleanup =>
        this.rollbackHandle(cleanup.host, cleanup.handle, cleanup.label)),
    );
    const failures: unknown[] = [...sessionResults, ...orphanResults]
      .flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length > 0 || this.sessions.size > 0 || this.pendingHandleCleanups.size > 0) {
      throw new AggregateError(failures, "failed to close one or more owned DSH handles");
    }

    const pendingDisposers = this.listenerDisposers.splice(0);
    const failedDisposers: (() => void)[] = [];
    for (const dispose of [...pendingDisposers].reverse()) {
      try {
        dispose();
      } catch (error) {
        failures.push(error);
        failedDisposers.push(dispose);
      }
    }
    this.listenerDisposers.push(...failedDisposers.reverse());
    if (failures.length > 0) {
      throw new AggregateError(failures, "failed to dispose one or more DSH listeners");
    }

    const host = this.host;
    if (host !== undefined) {
      await boundedTeardown(host.close(), "DSH host shutdown");
      if (this.host === host) {
        this.host = undefined;
        this.initialized = false;
      }
    }
  }
}
