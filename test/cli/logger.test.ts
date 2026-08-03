import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  createDiagnosticLogger,
  redactDiagnosticText,
  redactDiagnosticValue,
} from "../../src/logger.js";

class CaptureWritable extends Writable {
  value = "";

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : Buffer.from(chunk, encoding).toString("utf8");
    callback();
  }
}

describe("diagnostic redaction", () => {
  it("redacts credential-shaped text and fields", () => {
    expect(redactDiagnosticText("token: abc Bearer xyz.123")).toBe(
      "token: [REDACTED] Bearer [REDACTED]",
    );
    expect(
      redactDiagnosticValue({
        apiKey: "abc",
        nested: {
          password: "def",
          privateKey: "opaque-private-material",
          accessKey: "opaque-access-material",
          signingKey: "opaque-signing-material",
          path: "/safe",
        },
      }),
    ).toEqual({
      apiKey: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        privateKey: "[REDACTED]",
        accessKey: "[REDACTED]",
        signingKey: "[REDACTED]",
        path: "/safe",
      },
    });
    expect(redactDiagnosticText("privateKey: opaque-value")).toBe("privateKey: [REDACTED]");

    expect(
      redactDiagnosticText(
        'request={"token":"json-secret"} https://user:pass@example.test/?api_key=query-secret',
      ),
    ).toBe(
      'request={"token":"[REDACTED]"} https://user:[REDACTED]@example.test/?api_key=[REDACTED]',
    );
    expect(redactDiagnosticText("Authorization: Basic abc123\nCookie: sid=secret; theme=dark")).toBe(
      "Authorization: [REDACTED]\nCookie: [REDACTED]",
    );
    const secretShapes = [
      "sk-ant-abcdefghijklmnopqrstuvwxyz",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-secret",
    ];
    const redacted = redactDiagnosticText([
      ...secretShapes,
      "DEEPSEEK_API_KEY=plain-secret",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\ntruncated-private-material",
    ].join("\n"));
    for (const secret of secretShapes) expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("plain-secret");
    expect(redacted).not.toContain("private-material");
    expect(redacted).not.toContain("truncated-private-material");
  });

  it("writes only to the configured diagnostic stream", () => {
    const stderr = new CaptureWritable();
    const logger = createDiagnosticLogger(stderr);

    logger.warn("credential=abc", { token: "def", driver: "v1" });

    expect(stderr.value).toBe(
      '[dsh-acp] warn credential=[REDACTED] {"token":"[REDACTED]","driver":"v1"}\n',
    );
  });

  it("bounds diagnostic messages and field serialization", () => {
    const stderr = new CaptureWritable();
    const logger = createDiagnosticLogger(stderr);

    logger.error("x".repeat(20_000), { values: Array.from({ length: 200 }, (_, index) => index) });

    expect(stderr.value.length).toBeLessThanOrEqual(8_193);
    expect(stderr.value).toContain("[TRUNCATED]");
  });
});
