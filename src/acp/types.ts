import type {
  AgentContext,
  ClientCapabilities,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ReadTextFileRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type { DshRuntimeDriver } from "../runtime/types.js";

export interface DshAcpAgentOptions {
  readonly driver: DshRuntimeDriver;
  readonly name?: string;
  readonly title?: string;
  readonly version?: string;
  /** Maximum time to drain a cancelled runtime generator before isolating its session. */
  readonly cancelDrainTimeoutMs?: number;
  /** Enable only when the integration wires authenticated URL-completion callbacks. */
  readonly elicitationCompletion?: boolean;
  /** Exact adapter self-invocation command understood by the packaged CLI. */
  readonly terminalAuthCommand?: string;
}

export interface DshSteeringRequest {
  readonly sessionId: string;
  readonly prompt: readonly ContentBlock[];
  readonly _meta?: Record<string, unknown> | null;
}

export interface DshSteeringResponse {
  readonly outcome: "injected";
  readonly _meta?: Record<string, unknown> | null;
}

export const DSH_STEERING_METHOD = "_session/steering";

/**
 * The client-facing operations used by the protocol core. Keeping this small
 * makes the session state machine testable without a transport.
 */
export interface DshAcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  requestPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  createElicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  completeElicitation(elicitationId: string): Promise<void>;
  readTextFile(params: ReadTextFileRequest, signal: AbortSignal): Promise<string>;
  writeTextFile(params: WriteTextFileRequest, signal: AbortSignal): Promise<void>;
}

export class AgentContextClient implements DshAcpClient {
  readonly #context: AgentContext;

  constructor(context: AgentContext) {
    this.#context = context;
  }

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.#context.notify("session/update", params);
  }

  requestPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.#context.request("session/request_permission", params, {
      cancellationSignal: signal,
    });
  }

  createElicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.#context.request("elicitation/create", params, {
      cancellationSignal: signal,
    });
  }

  async completeElicitation(elicitationId: string): Promise<void> {
    await this.#context.notify("elicitation/complete", { elicitationId });
  }

  async readTextFile(params: ReadTextFileRequest, signal: AbortSignal): Promise<string> {
    const response = await this.#context.request("fs/read_text_file", params, {
      cancellationSignal: signal,
    });
    return response.content;
  }

  async writeTextFile(params: WriteTextFileRequest, signal: AbortSignal): Promise<void> {
    await this.#context.request("fs/write_text_file", params, {
      cancellationSignal: signal,
    });
  }
}

export interface DshAcpConnectionState {
  clientCapabilities: ClientCapabilities;
}
