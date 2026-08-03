import { describe, expect, it } from "vitest";

import { projectForHost } from "../../src/runtime/drivers/dsh-0.0.1/events.js";

describe("DSH event projection", () => {
  it("redacts provider-prefixed credentials recursively", () => {
    const projected = projectForHost({
      deepseek_api_key: "deepseek-raw-secret",
      providers: [{
        openaiApiKey: "openai-raw-secret",
        nested: [{ anthropicApiKey: "anthropic-raw-secret" }],
      }],
      access_token: "access-raw-secret",
      accessTokenExpiresAt: "expiry-associated-with-a-secret",
      clientSecretValue: "client-secret-value",
      sshPrivateKey: "private-raw-secret",
      webhookSigningKey: "signing-raw-secret",
      safe: { tokenCount: 42, provider: "deepseek" },
    });

    expect(projected).toEqual({
      deepseek_api_key: "[REDACTED]",
      providers: [{
        openaiApiKey: "[REDACTED]",
        nested: [{ anthropicApiKey: "[REDACTED]" }],
      }],
      access_token: "[REDACTED]",
      accessTokenExpiresAt: "[REDACTED]",
      clientSecretValue: "[REDACTED]",
      sshPrivateKey: "[REDACTED]",
      webhookSigningKey: "[REDACTED]",
      safe: { tokenCount: 42, provider: "deepseek" },
    });
  });

  it("redacts credential values even when they appear under innocuous keys or encoded JSON", () => {
    const secrets = [
      "sk-ant-abcdefghijklmnopqrstuvwxyz",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "github_pat_abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "xoxb-1234567890-secret",
      "opaque.bearer-token_123",
      "pem-private-material",
      "unterminated-private-material",
    ];
    const projected = projectForHost({
      messages: [
        `request used Bearer ${secrets[5]}`,
        `provider returned ${secrets[0]}`,
        `fallback ${secrets[1]}`,
        `github ${secrets[2]} and ${secrets[3]}`,
        `slack ${secrets[4]}`,
        `-----BEGIN PRIVATE KEY-----\n${secrets[6]}\n-----END PRIVATE KEY-----`,
        `-----BEGIN OPENSSH PRIVATE KEY-----\n${secrets[7]}`,
      ],
      encoded: JSON.stringify({
        items: [{ deepseek_api_key: secrets[0] }],
        note: `Authorization: Bearer ${secrets[5]}`,
      }),
      [`cache-${secrets[1]}`]: "credential material must not survive in an object key",
      prose: "access token: access-token-in-prose",
    });
    const serialized = JSON.stringify(projected);

    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("access-token-in-prose");
    expect(serialized).toContain("[REDACTED]");
  });
});
