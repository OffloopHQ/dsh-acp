import type {
  RuntimeContentBlock,
  RuntimeEvent,
  RuntimeToolContent,
  RuntimeToolKind,
} from "../../types.js";
import type { DshHostEvent } from "./host.js";
import { classifyDshTool } from "./tool-kinds.js";

export const DSH_EVENT_MAX_DEPTH = 6;
export const DSH_EVENT_MAX_KEYS = 64;
export const DSH_EVENT_MAX_ARRAY_ITEMS = 32;
export const DSH_EVENT_MAX_STRING_BYTES = 4 * 1024;
export const DSH_EVENT_MAX_SERIALIZED_BYTES = 32 * 1024;
export const DSH_TOOL_RESULT_MAX_BLOCK_BYTES = 8 * 1024;
export const DSH_TOOL_RESULT_MAX_TOTAL_BYTES = 24 * 1024;

const DSH_STRING_SCAN_MAX_BYTES = 32 * 1024;
const DSH_INPUT_PARSE_MAX_BYTES = 256 * 1024;
const DSH_EVENT_MAX_KEY_BYTES = 256;
const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";

interface ProjectionState {
  keys: number;
  readonly seen: WeakSet<object>;
  readonly maxStringBytes: number;
}

export interface DshToolRecord {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly kind: RuntimeToolKind;
  readonly rawInput?: unknown;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  let output = "";
  let used = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (used + size > maxBytes) break;
    output += character;
    used += size;
  }
  return output;
}

function truncateWithMarker(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const markerBytes = byteLength(TRUNCATED);
  if (maxBytes <= markerBytes) return truncateUtf8(TRUNCATED, maxBytes);
  return `${truncateUtf8(value, maxBytes - markerBytes)}${TRUNCATED}`;
}

function sensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  const credentialMarker = normalized.includes("apikey")
    || normalized.includes("accesskey")
    || normalized.includes("accesstoken")
    || normalized.includes("refreshtoken")
    || normalized.includes("authtoken")
    || normalized.includes("idtoken")
    || normalized.includes("privatekey")
    || normalized.includes("signingkey")
    || normalized.includes("clientsecret")
    || normalized.includes("password")
    || normalized.includes("passwd")
    || normalized.includes("credential")
    || normalized.includes("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("auth");
  const providerCredential = /^(?:openai|anthropic|deepseek|gemini|google|azureopenai|mistral|groq|cohere|xai|github|gitlab|aws).*(?:key|token|secret|credential)$/.test(normalized);
  return normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized === "password"
    || normalized === "passwd"
    || normalized === "secret"
    || credentialMarker
    || providerCredential
    || normalized === "credential"
    || normalized === "credentials"
    || normalized === "headers"
    || normalized === "env"
    || normalized === "environment"
    || normalized === "envvars"
    || normalized === "environmentvariables";
}

function redactFreeText(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/gu,
      REDACTED,
    )
    .replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*/gu, REDACTED)
    .replace(
      /((?:"|')?(?:(?:openai|anthropic|deepseek|gemini|google|azure[-_\s]?openai|mistral|groq|cohere|xai|github|gitlab|aws)[-_\s]?)?(?:api[-_\s]?key|access[-_\s]?key|(?:access|refresh|id|auth)[-_\s]?token|authorization|proxy[-_\s]?authorization|cookie|set[-_\s]?cookie|password|passwd|secret|client[-_\s]?secret|credential(?:s)?|private[-_\s]?key|signing[-_\s]?key|headers?|env(?:ironment)?)(?:"|')?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]\r\n]+)/giu,
      (_match, prefix: string, secret: string) => {
        const quote = secret.startsWith("\"") ? "\"" : secret.startsWith("'") ? "'" : "";
        return `${prefix}${quote}${REDACTED}${quote}`;
      },
    )
    .replace(
      /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*).+$/gimu,
      `$1${REDACTED}`,
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`)
    .replace(
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{4,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/giu,
      REDACTED,
    )
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|SIGNING_KEY|CREDENTIALS?)\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gu,
      `$1${REDACTED}`,
    );
}

function sanitizeString(value: string, state: ProjectionState, depth: number): string {
  const scan = truncateUtf8(value, DSH_STRING_SCAN_MAX_BYTES);
  const trimmed = scan.trim();
  if (scan.length === value.length
    && depth < DSH_EVENT_MAX_DEPTH
    && ((trimmed.startsWith("{") && trimmed.endsWith("}"))
      || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const projected = sanitizeValue(parsed, state, depth + 1);
      const serialized = JSON.stringify(projected);
      if (serialized !== undefined) {
        return truncateWithMarker(redactFreeText(serialized), state.maxStringBytes);
      }
    } catch {
      // Not JSON after all; treat it as bounded free-form text below.
    }
  }
  return truncateWithMarker(redactFreeText(scan), state.maxStringBytes);
}

function sanitizeValue(value: unknown, state: ProjectionState, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeString(value, state, depth);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "function" || typeof value === "symbol") return `[UNSUPPORTED:${typeof value}]`;
  if (depth >= DSH_EVENT_MAX_DEPTH) return "[MAX_DEPTH]";

  if (value instanceof Error) {
    return {
      name: sanitizeString(value.name, state, depth + 1),
      message: sanitizeString(value.message, state, depth + 1),
    };
  }
  if (state.seen.has(value)) return "[CIRCULAR]";
  state.seen.add(value);

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    const limit = Math.min(value.length, DSH_EVENT_MAX_ARRAY_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      if (state.keys >= DSH_EVENT_MAX_KEYS) break;
      state.keys += 1;
      output.push(sanitizeValue(value[index], state, depth + 1));
    }
    if (limit < value.length || output.length < limit) output.push(TRUNCATED);
    return output;
  }

  let entries: [string, unknown][];
  try {
    entries = Object.entries(value as Record<string, unknown>);
  } catch {
    return "[UNREADABLE]";
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (state.keys >= DSH_EVENT_MAX_KEYS) {
      output["__truncated__"] = true;
      break;
    }
    state.keys += 1;
    const safeKey = truncateWithMarker(redactFreeText(key), DSH_EVENT_MAX_KEY_BYTES);
    output[safeKey] = sensitiveKey(key) ? REDACTED : sanitizeValue(child, state, depth + 1);
  }
  return output;
}

/** Create a JSON-safe, secret-redacted, size-bounded copy for ACP updates. */
export function projectForHost(value: unknown, maxStringBytes = DSH_EVENT_MAX_STRING_BYTES): unknown {
  const projected = sanitizeValue(value, {
    keys: 0,
    seen: new WeakSet<object>(),
    maxStringBytes,
  }, 0);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(projected);
  } catch {
    return { truncated: true, preview: "[UNSERIALIZABLE]" };
  }
  if (serialized === undefined || byteLength(serialized) <= DSH_EVENT_MAX_SERIALIZED_BYTES) return projected;
  return {
    truncated: true,
    preview: truncateWithMarker(redactFreeText(serialized), DSH_EVENT_MAX_STRING_BYTES),
  };
}

function parseInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (byteLength(raw) > DSH_INPUT_PARSE_MAX_BYTES) return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function dshMeta(event: DshHostEvent, extra?: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const projectedExtra = record(projectForHost(extra ?? {})) ?? {};
  return {
    ...(event.seq === undefined ? {} : { eventSeq: event.seq }),
    ...(event.time === undefined ? {} : { eventTime: event.time }),
    ...projectedExtra,
  };
}

function messageBlocks(value: unknown): readonly unknown[] {
  const message = record(value);
  return Array.isArray(message?.["content"]) ? message["content"] as readonly unknown[] : [];
}

function committedAssistantEvents(data: Readonly<Record<string, unknown>>, event: DshHostEvent): RuntimeEvent[] {
  const output: RuntimeEvent[] = [];
  const message = record(data["message"]);
  for (const rawBlock of messageBlocks(message)) {
    const block = record(rawBlock);
    const text = block?.["text"];
    if (typeof text !== "string" || text.length === 0) continue;
    if (block?.["type"] === "text") {
      output.push({
        type: "agent_message_chunk",
        content: { type: "text", text },
        ...(typeof message?.["id"] === "string" ? { messageId: message["id"] } : {}),
      });
    } else if (block?.["type"] === "reasoning") {
      output.push({
        type: "agent_thought_chunk",
        content: { type: "text", text },
        ...(typeof message?.["id"] === "string" ? { messageId: message["id"] } : {}),
      });
    }
  }

  const usage = record(data["usage"]);
  if (usage !== undefined) {
    const inputTokens = finiteNumber(usage["inputTokens"]);
    const outputTokens = finiteNumber(usage["outputTokens"]);
    const cacheRead = finiteNumber(usage["cacheReadTokens"]);
    const cacheWrite = finiteNumber(usage["cacheWriteTokens"]);
    output.push({
      type: "usage_update",
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cacheRead === undefined && cacheWrite === undefined
        ? {}
        : { cachedInputTokens: (cacheRead ?? 0) + (cacheWrite ?? 0) }),
      _meta: dshMeta(event, {
        ...(finiteNumber(usage["reasoningTokens"]) === undefined
          ? {}
          : { reasoningTokens: finiteNumber(usage["reasoningTokens"]) }),
      }),
    });
  }
  return output;
}

function toolResultContent(message: Readonly<Record<string, unknown>> | undefined): RuntimeToolContent[] {
  const content: RuntimeToolContent[] = [];
  let totalBytes = 0;
  for (const outerRaw of messageBlocks(message)) {
    const outer = record(outerRaw);
    if (outer?.["type"] !== "tool-result") continue;
    const blocks = Array.isArray(outer["content"]) ? outer["content"] as readonly unknown[] : [];
    for (const rawBlock of blocks) {
      const block = record(rawBlock);
      if ((block?.["type"] === "text" || block?.["type"] === "reasoning")
        && typeof block["text"] === "string") {
        const remaining = DSH_TOOL_RESULT_MAX_TOTAL_BYTES - totalBytes;
        if (remaining <= 0) return content;
        const limit = Math.min(DSH_TOOL_RESULT_MAX_BLOCK_BYTES, remaining);
        const projected = projectForHost(block["text"], limit);
        const text = typeof projected === "string"
          ? truncateWithMarker(projected, limit)
          : truncateWithMarker(JSON.stringify(projected), limit);
        totalBytes += byteLength(text);
        const runtimeBlock: RuntimeContentBlock = { type: "text", text };
        content.push({ type: "content", content: runtimeBlock });
      }
    }
  }
  return content;
}

function resultCallId(message: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const source = record(message?.["source"]);
  if (typeof source?.["callId"] === "string") return source["callId"];
  for (const rawBlock of messageBlocks(message)) {
    const block = record(rawBlock);
    if (block?.["type"] === "tool-result" && typeof block["toolCallId"] === "string") {
      return block["toolCallId"];
    }
  }
  return undefined;
}

function resultIsError(data: Readonly<Record<string, unknown>>, message: Readonly<Record<string, unknown>> | undefined): boolean {
  if (data["error"] !== undefined && data["error"] !== null) return true;
  return messageBlocks(message).some((rawBlock) => {
    const block = record(rawBlock);
    return block?.["type"] === "tool-result" && block["isError"] === true;
  });
}

/** Map one committed DSH event. Raw assistant chunks are intentionally excluded. */
export function mapDshEvent(
  event: DshHostEvent,
  tools: Map<string, DshToolRecord>,
): RuntimeEvent[] {
  const data = record(event.data);
  if (data === undefined) return [];
  switch (event.type) {
    case "assistant/message":
      return committedAssistantEvents(data, event);

    case "tool/call": {
      const id = data["callId"];
      const name = data["name"];
      if (typeof id !== "string" || typeof name !== "string") return [];
      const parsedInput = parseInput(data["arguments"]);
      const rawInput = parsedInput === undefined ? undefined : projectForHost(parsedInput);
      const tool: DshToolRecord = {
        id,
        name,
        title: name,
        kind: classifyDshTool(name, parsedInput),
        ...(rawInput === undefined ? {} : { rawInput }),
      };
      tools.set(id, tool);
      return [{
        type: "tool_call",
        toolCallId: id,
        title: tool.title,
        kind: tool.kind,
        status: "in_progress",
        ...(rawInput === undefined ? {} : { rawInput }),
        _meta: dshMeta(event, { dshToolName: name }),
      }];
    }

    case "tool/result": {
      const message = record(data["message"]);
      const id = resultCallId(message);
      if (id === undefined) return [];
      const tool = tools.get(id);
      const contents = toolResultContent(message);
      const failed = resultIsError(data, message);
      return [{
        type: "tool_call_update",
        toolCallId: id,
        ...(tool === undefined ? {} : { title: tool.title, kind: tool.kind }),
        status: failed ? "failed" : "completed",
        ...(contents.length === 0 ? {} : { content: contents }),
        ...(tool?.rawInput === undefined ? {} : { rawInput: tool.rawInput }),
        rawOutput: projectForHost(message),
        _meta: dshMeta(event, {
          ...(data["error"] === undefined ? {} : { error: projectForHost(data["error"]) }),
          ...(data["meta"] === undefined ? {} : { toolMeta: projectForHost(data["meta"]) }),
        }),
      }];
    }

    case "todo/write": {
      if (!Array.isArray(data["todos"])) return [];
      const entries = data["todos"].flatMap((rawTodo): {
        content: string;
        priority: "medium";
        status: "pending" | "in_progress" | "completed";
      }[] => {
        const todo = record(rawTodo);
        const content = todo?.["content"];
        const status = todo?.["status"];
        if (typeof content !== "string"
          || (status !== "pending" && status !== "in_progress" && status !== "completed")) return [];
        return [{ content, priority: "medium", status }];
      });
      return [{ type: "plan", entries }];
    }

    case "session/title": {
      const title = data["title"];
      return typeof title === "string" ? [{ type: "session_info_update", title }] : [];
    }

    case "request/context": {
      const contextWindow = finiteNumber(data["contextWindow"]);
      return contextWindow === undefined ? [] : [{ type: "usage_update", contextWindow }];
    }

    default:
      return [];
  }
}

export function eventTurn(event: DshHostEvent): number | undefined {
  return finiteNumber(record(event.data)?.["turn"]);
}
