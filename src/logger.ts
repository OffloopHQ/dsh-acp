import type { Writable } from "node:stream";

export type DiagnosticFields = Readonly<Record<string, unknown>>;

export interface DiagnosticLogger {
  debug(message: string, fields?: DiagnosticFields): void;
  info(message: string, fields?: DiagnosticFields): void;
  warn(message: string, fields?: DiagnosticFields): void;
  error(message: string, fields?: DiagnosticFields): void;
}

const sensitiveKey = /(authorization|cookie|credential|password|secret|token|(?:api|private|access|signing)[-_]?key)/i;
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const sensitiveName = "authorization|cookie|credential|password|secret|token|(?:api|private|access|signing)[-_]?key";
const sensitiveHeader = /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*).*$/gim;
const quotedSecret = new RegExp(
  `(["']?(?:${sensitiveName})["']?\\s*[:=]\\s*)(["'])(.*?)\\2`,
  "gi",
);
const assignedSecret = new RegExp(`(${sensitiveName})(\\s*[:=]\\s*)([^\\s,;&#]+)`, "gi");
const querySecret = new RegExp(`([?&](?:${sensitiveName})=)([^&#\\s]*)`, "gi");
const urlUserInfo = /(https?:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi;
const privateKey = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/giu;
const truncatedPrivateKey = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*/giu;
const providerToken = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{4,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/giu;
const environmentSecret = /(\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|SIGNING_KEY|CREDENTIALS?)\s*=\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gu;

const MAX_MESSAGE_LENGTH = 4_096;
const MAX_FIELD_STRING_LENGTH = 1_024;
const MAX_FIELD_ITEMS = 50;
const MAX_LINE_LENGTH = 8_192;

export function createDiagnosticLogger(
  stderr: Writable = process.stderr,
  prefix = "dsh-acp",
): DiagnosticLogger {
  const emit = (level: string, message: string, fields?: DiagnosticFields): void => {
    const safeMessage = truncate(redactDiagnosticText(message), MAX_MESSAGE_LENGTH);
    const suffix = fields === undefined ? "" : ` ${safeJson(redactDiagnosticValue(fields))}`;
    const line = truncate(`[${prefix}] ${level} ${safeMessage}${suffix}`, MAX_LINE_LENGTH);
    stderr.write(`${line}\n`);
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

export function diagnosticErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return truncate(redactDiagnosticText(error.message || error.name), MAX_MESSAGE_LENGTH);
  }
  return truncate(redactDiagnosticText(String(error)), MAX_MESSAGE_LENGTH);
}

export function redactDiagnosticText(text: string): string {
  return text
    .replace(privateKey, "[REDACTED]")
    .replace(truncatedPrivateKey, "[REDACTED]")
    .replace(bearerValue, "Bearer [REDACTED]")
    .replace(providerToken, "[REDACTED]")
    .replace(environmentSecret, "$1[REDACTED]")
    .replace(sensitiveHeader, "$1[REDACTED]")
    .replace(quotedSecret, (_match, prefix: string, quote: string) => `${prefix}${quote}[REDACTED]${quote}`)
    .replace(querySecret, "$1[REDACTED]")
    .replace(urlUserInfo, "$1[REDACTED]$3")
    .replace(assignedSecret, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`);
}

export function redactDiagnosticValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (depth > 6) {
    return "[TRUNCATED]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return truncate(redactDiagnosticText(value), MAX_FIELD_STRING_LENGTH);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactDiagnosticText(value.message),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result = value
      .slice(0, MAX_FIELD_ITEMS)
      .map((entry) => redactDiagnosticValue(entry, depth + 1, seen));
    if (value.length > MAX_FIELD_ITEMS) result.push("[TRUNCATED]");
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result: Record<string, unknown> = {};
    let entries: [string, unknown][];
    try {
      entries = Object.entries(value);
    } catch {
      return "[UNSERIALIZABLE]";
    }
    for (const [key, entry] of entries.slice(0, MAX_FIELD_ITEMS)) {
      result[key] = sensitiveKey.test(key)
        ? "[REDACTED]"
        : redactDiagnosticValue(entry, depth + 1, seen);
    }
    if (entries.length > MAX_FIELD_ITEMS) {
      result["[TRUNCATED]"] = `${entries.length - MAX_FIELD_ITEMS} more fields`;
    }
    return result;
  }
  return String(value);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 14))}...[TRUNCATED]`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[UNSERIALIZABLE]"';
  }
}
