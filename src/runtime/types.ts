export type RuntimeStopReason =
  | "end_turn"
  | "cancelled"
  | "refusal"
  | "max_tokens"
  | "max_turn_requests";

export type RuntimeToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "think"
  | "switch_mode"
  | "other";

export type RuntimeToolStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

export type RuntimeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      uri: string;
      name?: string;
      mimeType?: string;
      text?: string;
      blob?: string;
    }
  | {
      type: "resource_link";
      uri: string;
      name?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    };

export interface RuntimeCapabilities {
  readonly prompt: {
    readonly text: boolean;
    readonly image: boolean;
    readonly embeddedContext: boolean;
    readonly resourceLink: boolean;
  };
  readonly sessions: {
    readonly load: boolean;
    readonly resume: boolean;
    readonly fork: boolean;
    readonly list: boolean;
    readonly close: boolean;
    readonly delete: boolean;
    readonly additionalDirectories: boolean;
  };
  readonly auth: {
    readonly authenticate: boolean;
    readonly logout: boolean;
  };
  readonly providers: boolean;
  readonly mcp: {
    readonly stdio: boolean;
    readonly http: boolean;
    readonly sse: boolean;
  };
  readonly steering: boolean;
  readonly permissions: boolean;
  readonly elicitation: {
    readonly form: boolean;
    readonly url: boolean;
  };
  readonly updates: ReadonlySet<RuntimeEvent["type"]>;
}

export interface RuntimeAuthMethod {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly terminal?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly label?: string;
  };
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimeProvider {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly _meta?: Record<string, unknown>;
}

export type RuntimeMcpServer =
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly transport: "http" | "sse";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface RuntimeSessionDescriptor {
  readonly id: string;
  readonly cwd: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly modeId?: string;
  readonly config?: Readonly<Record<string, string | boolean>>;
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimeSessionPage {
  readonly sessions: readonly RuntimeSessionDescriptor[];
  readonly nextCursor?: string;
}

export interface RuntimeSessionOpenInput {
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly mcpServers: readonly RuntimeMcpServer[];
  readonly modeId?: string;
  readonly config?: Readonly<Record<string, string | boolean>>;
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimeSessionLoadInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly mcpServers: readonly RuntimeMcpServer[];
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimeSessionOpenResult {
  readonly session: RuntimeSession;
  readonly descriptor: RuntimeSessionDescriptor;
  readonly replay?: AsyncIterable<RuntimeEvent>;
  readonly modes?: readonly RuntimeMode[];
  readonly configOptions?: readonly RuntimeConfigOption[];
  readonly commands?: readonly RuntimeCommand[];
}

export interface RuntimePromptInput {
  readonly content: readonly RuntimeContentBlock[];
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimePermissionChoice {
  readonly id: string;
  readonly name: string;
  readonly kind: "reject_once" | "allow_once" | "allow_always";
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimePermissionRequest {
  readonly requestId: string;
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: RuntimeToolKind;
  readonly choices: readonly RuntimePermissionChoice[];
  readonly locations?: readonly RuntimeToolLocation[];
  readonly rawInput?: unknown;
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimePermissionOutcome {
  readonly outcome: "selected" | "cancelled";
  readonly optionId?: string;
}

export interface RuntimeElicitationRequest {
  readonly elicitationId: string;
  readonly mode: "form" | "url";
  readonly message: string;
  readonly url?: string;
  readonly schema?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimeElicitationOutcome {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: unknown;
}

export interface RuntimePromptContext {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly requestPermission: (
    request: RuntimePermissionRequest,
    signal: AbortSignal,
  ) => Promise<RuntimePermissionOutcome>;
  readonly requestElicitation: (
    request: RuntimeElicitationRequest,
    signal: AbortSignal,
  ) => Promise<RuntimeElicitationOutcome>;
  readonly readTextFile: (path: string, line?: number, limit?: number) => Promise<string>;
  readonly writeTextFile: (path: string, content: string) => Promise<void>;
}

export interface RuntimeToolLocation {
  readonly path: string;
  readonly line?: number;
}

export interface RuntimeToolContent {
  readonly type: "content" | "diff" | "terminal";
  readonly content?: RuntimeContentBlock;
  readonly path?: string;
  readonly oldText?: string;
  readonly newText?: string;
  readonly terminalId?: string;
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimePlanEntry {
  readonly content: string;
  readonly priority: "high" | "medium" | "low";
  readonly status: "pending" | "in_progress" | "completed";
}

export interface RuntimeMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface RuntimeConfigOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly kind: "select" | "boolean";
  readonly currentValue: string | boolean;
  readonly options?: readonly { value: string; name: string; description?: string }[];
}

export interface RuntimeCommand {
  readonly name: string;
  readonly description: string;
  readonly inputHint?: string;
}

export type RuntimeEvent =
  | { type: "user_message_chunk"; content: RuntimeContentBlock; messageId?: string }
  | { type: "agent_message_chunk"; content: RuntimeContentBlock; messageId?: string }
  | { type: "agent_thought_chunk"; content: RuntimeContentBlock; messageId?: string }
  | {
      type: "tool_call";
      toolCallId: string;
      title: string;
      kind: RuntimeToolKind;
      status: RuntimeToolStatus;
      locations?: readonly RuntimeToolLocation[];
      rawInput?: unknown;
      _meta?: Record<string, unknown>;
    }
  | {
      type: "tool_call_update";
      toolCallId: string;
      title?: string;
      kind?: RuntimeToolKind;
      status?: RuntimeToolStatus;
      locations?: readonly RuntimeToolLocation[];
      content?: readonly RuntimeToolContent[];
      rawInput?: unknown;
      rawOutput?: unknown;
      _meta?: Record<string, unknown>;
    }
  | { type: "plan"; entries: readonly RuntimePlanEntry[] }
  | { type: "plan_update"; entries: readonly RuntimePlanEntry[] }
  | { type: "available_commands_update"; commands: readonly RuntimeCommand[] }
  | { type: "current_mode_update"; modeId: string }
  | { type: "config_option_update"; options: readonly RuntimeConfigOption[] }
  | { type: "session_info_update"; title?: string; updatedAt?: string }
  | {
      type: "usage_update";
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      contextWindow?: number;
      costUsd?: number;
      _meta?: Record<string, unknown>;
    }
  | { type: "terminal_info"; terminalId: string; title?: string; _meta?: Record<string, unknown> }
  | { type: "terminal_output"; terminalId: string; data: string }
  | { type: "terminal_exit"; terminalId: string; exitCode?: number; signal?: string }
  | {
      type: "subagent_activity";
      toolCallId: string;
      status: RuntimeToolStatus;
      content?: RuntimeContentBlock;
      _meta?: Record<string, unknown>;
    };

export interface RuntimeTurnResult {
  readonly stopReason: RuntimeStopReason;
  readonly usage?: Extract<RuntimeEvent, { type: "usage_update" }>;
  readonly _meta?: Record<string, unknown>;
}

export interface RuntimeSession {
  readonly id: string;
  readonly cwd: string;
  prompt(
    input: RuntimePromptInput,
    context: RuntimePromptContext,
  ): AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void>;
  cancel(turnId: string): Promise<void>;
  close(): Promise<void>;
  steer?(input: RuntimePromptInput, signal: AbortSignal): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  setConfigOption?(configId: string, value: string | boolean): Promise<void>;
}

export interface DshRuntimeDriver {
  readonly id: string;
  /** Exact inspected DSH compatibility-seam fingerprint, when the driver owns one. */
  readonly runtimeFingerprint?: string;
  readonly capabilities: RuntimeCapabilities;
  readonly authMethods: readonly RuntimeAuthMethod[];
  initialize(signal: AbortSignal): Promise<void>;
  authenticate(methodId: string, signal: AbortSignal): Promise<void>;
  logout(signal: AbortSignal): Promise<void>;
  listProviders(signal: AbortSignal): Promise<{
    providers: readonly RuntimeProvider[];
    currentProviderId?: string;
  }>;
  setProvider(providerId: string, signal: AbortSignal): Promise<void>;
  disableProvider(providerId: string, signal: AbortSignal): Promise<void>;
  newSession(input: RuntimeSessionOpenInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult>;
  loadSession(input: RuntimeSessionLoadInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult>;
  resumeSession(input: RuntimeSessionLoadInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult>;
  forkSession(input: RuntimeSessionLoadInput, signal: AbortSignal): Promise<RuntimeSessionOpenResult>;
  listSessions(
    cwd: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<RuntimeSessionPage>;
  deleteSession(sessionId: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export class RuntimeUnsupportedError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`The selected DSH runtime does not support ${capability}`);
    this.name = "RuntimeUnsupportedError";
    this.capability = capability;
  }
}

export class RuntimeCompatibilityError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "RuntimeCompatibilityError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
