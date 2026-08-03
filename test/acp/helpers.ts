import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { DshAcpAgent } from "../../src/acp/agent.js";
import { FakeAcpClient } from "../../src/testing/fake-client.js";
import {
  FakeDshRuntimeDriver,
  FakeRuntimeSession,
  openResult,
} from "../../src/testing/fake-runtime.js";

export const TEST_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  session: { configOptions: { boolean: {} } },
  plan: {},
  elicitation: { form: {}, url: {} },
};

export async function initializedAgent(driver = new FakeDshRuntimeDriver()) {
  const client = new FakeAcpClient();
  const agent = new DshAcpAgent({ driver, version: "test" });
  await agent.initialize(
    { protocolVersion: 1, clientCapabilities: TEST_CLIENT_CAPABILITIES },
    client,
    new AbortController().signal,
  );
  return { agent, client, driver };
}

export async function activeSession(
  session = new FakeRuntimeSession("session-1"),
  driver = new FakeDshRuntimeDriver(),
) {
  driver.newResults.push(openResult(session));
  const initialized = await initializedAgent(driver);
  const opened = await initialized.agent.newSession(
    { cwd: session.cwd, mcpServers: [] },
    initialized.client,
    new AbortController().signal,
  );
  return { ...initialized, session, sessionId: opened.sessionId };
}

export async function waitUntil(predicate: () => boolean, message = "condition"): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
