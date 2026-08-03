import type {
  DshRuntimeDriver,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimePromptContext,
  RuntimePromptInput,
  RuntimeProvider,
  RuntimeSession,
  RuntimeSessionLoadInput,
  RuntimeSessionOpenInput,
  RuntimeSessionOpenResult,
  RuntimeSessionPage,
  RuntimeTurnResult,
} from "../runtime/types.js";

export const ALL_RUNTIME_EVENT_TYPES = [
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update",
  "terminal_info",
  "terminal_output",
  "terminal_exit",
  "subagent_activity",
] as const satisfies readonly RuntimeEvent["type"][];

export function fullRuntimeCapabilities(): RuntimeCapabilities {
  return {
    prompt: { text: true, image: true, embeddedContext: true, resourceLink: true },
    sessions: {
      load: true,
      resume: true,
      fork: true,
      list: true,
      close: true,
      delete: true,
      additionalDirectories: true,
    },
    auth: { authenticate: true, logout: true },
    providers: true,
    mcp: { stdio: true, http: true, sse: true },
    steering: true,
    permissions: true,
    elicitation: { form: true, url: true },
    updates: new Set(ALL_RUNTIME_EVENT_TYPES),
  };
}

export function minimalRuntimeCapabilities(): RuntimeCapabilities {
  return {
    prompt: { text: true, image: false, embeddedContext: false, resourceLink: true },
    sessions: {
      load: false,
      resume: false,
      fork: false,
      list: false,
      close: false,
      delete: false,
      additionalDirectories: false,
    },
    auth: { authenticate: false, logout: false },
    providers: false,
    mcp: { stdio: false, http: false, sse: false },
    steering: false,
    permissions: false,
    elicitation: { form: false, url: false },
    updates: new Set<RuntimeEvent["type"]>(["agent_message_chunk"]),
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export type FakePromptHandler = (
  input: RuntimePromptInput,
  context: RuntimePromptContext,
) => AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void>;

export class FakeRuntimeSession implements RuntimeSession {
  readonly id: string;
  readonly cwd: string;
  readonly promptCalls: Array<{ input: RuntimePromptInput; context: RuntimePromptContext }> = [];
  readonly cancelCalls: string[] = [];
  readonly modeCalls: string[] = [];
  readonly configCalls: Array<{ configId: string; value: string | boolean }> = [];
  readonly steerCalls: Array<{ input: RuntimePromptInput; signal: AbortSignal }> = [];
  closeCalls = 0;
  promptHandler: FakePromptHandler;
  cancelHandler: (turnId: string) => Promise<void> = async () => undefined;
  closeHandler: () => Promise<void> = async () => undefined;

  constructor(
    id: string,
    cwd = "/workspace",
    promptHandler: FakePromptHandler = async function* () {
      return { stopReason: "end_turn" };
    },
  ) {
    this.id = id;
    this.cwd = cwd;
    this.promptHandler = promptHandler;
  }

  prompt(
    input: RuntimePromptInput,
    context: RuntimePromptContext,
  ): AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void> {
    this.promptCalls.push({ input, context });
    return this.promptHandler(input, context);
  }

  async cancel(turnId: string): Promise<void> {
    this.cancelCalls.push(turnId);
    await this.cancelHandler(turnId);
  }

  async close(): Promise<void> {
    this.closeCalls++;
    await this.closeHandler();
  }

  async steer(input: RuntimePromptInput, signal: AbortSignal): Promise<void> {
    this.steerCalls.push({ input, signal });
  }

  async setMode(modeId: string): Promise<void> {
    this.modeCalls.push(modeId);
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    this.configCalls.push({ configId, value });
  }
}

export function openResult(
  session: FakeRuntimeSession,
  overrides: Partial<Omit<RuntimeSessionOpenResult, "session">> = {},
): RuntimeSessionOpenResult {
  return {
    session,
    descriptor: { id: session.id, cwd: session.cwd },
    ...overrides,
  };
}

export async function* runtimeEvents(
  events: readonly RuntimeEvent[],
  result: RuntimeTurnResult = { stopReason: "end_turn" },
): AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void> {
  for (const event of events) {
    yield event;
  }
  return result;
}

export interface FakeDriverOptions {
  readonly id?: string;
  readonly capabilities?: RuntimeCapabilities;
}

export class FakeDshRuntimeDriver implements DshRuntimeDriver {
  readonly id: string;
  readonly capabilities: RuntimeCapabilities;
  readonly authMethods = [{ id: "fake-auth", name: "Fake authentication" }] as const;
  readonly calls: Array<{ method: string; input?: unknown }> = [];
  readonly newResults: RuntimeSessionOpenResult[] = [];
  readonly loadResults: RuntimeSessionOpenResult[] = [];
  readonly resumeResults: RuntimeSessionOpenResult[] = [];
  readonly forkResults: RuntimeSessionOpenResult[] = [];
  providers: readonly RuntimeProvider[] = [
    { id: "deepseek", name: "DeepSeek" },
    { id: "other", name: "Other" },
  ];
  currentProviderId: string | undefined = "deepseek";
  sessionPage: RuntimeSessionPage = { sessions: [] };
  closeCalls = 0;
  closeHandler: () => Promise<void> = async () => undefined;
  initializeHandler: (signal: AbortSignal) => Promise<void> = async () => undefined;
  #nextSession = 1;

  constructor(options: FakeDriverOptions = {}) {
    this.id = options.id ?? "fake-dsh";
    this.capabilities = options.capabilities ?? fullRuntimeCapabilities();
  }

  async initialize(signal: AbortSignal): Promise<void> {
    this.#record("initialize");
    throwIfAborted(signal);
    await this.initializeHandler(signal);
  }

  async authenticate(methodId: string, signal: AbortSignal): Promise<void> {
    this.#record("authenticate", methodId);
    throwIfAborted(signal);
  }

  async logout(signal: AbortSignal): Promise<void> {
    this.#record("logout");
    throwIfAborted(signal);
  }

  async listProviders(signal: AbortSignal) {
    this.#record("providers/list");
    throwIfAborted(signal);
    return {
      providers: this.providers,
      ...(this.currentProviderId === undefined
        ? {}
        : { currentProviderId: this.currentProviderId }),
    };
  }

  async setProvider(providerId: string, signal: AbortSignal): Promise<void> {
    this.#record("providers/set", providerId);
    throwIfAborted(signal);
    this.currentProviderId = providerId;
  }

  async disableProvider(providerId: string, signal: AbortSignal): Promise<void> {
    this.#record("providers/disable", providerId);
    throwIfAborted(signal);
    if (this.currentProviderId === providerId) {
      this.currentProviderId = undefined;
    }
  }

  async newSession(
    input: RuntimeSessionOpenInput,
    signal: AbortSignal,
  ): Promise<RuntimeSessionOpenResult> {
    this.#record("session/new", input);
    throwIfAborted(signal);
    return this.newResults.shift() ?? openResult(
      new FakeRuntimeSession(`fake-${this.#nextSession++}`, input.cwd),
    );
  }

  async loadSession(
    input: RuntimeSessionLoadInput,
    signal: AbortSignal,
  ): Promise<RuntimeSessionOpenResult> {
    this.#record("session/load", input);
    throwIfAborted(signal);
    return this.#shiftRequired(this.loadResults, "loadSession");
  }

  async resumeSession(
    input: RuntimeSessionLoadInput,
    signal: AbortSignal,
  ): Promise<RuntimeSessionOpenResult> {
    this.#record("session/resume", input);
    throwIfAborted(signal);
    return this.#shiftRequired(this.resumeResults, "resumeSession");
  }

  async forkSession(
    input: RuntimeSessionLoadInput,
    signal: AbortSignal,
  ): Promise<RuntimeSessionOpenResult> {
    this.#record("session/fork", input);
    throwIfAborted(signal);
    return this.#shiftRequired(this.forkResults, "forkSession");
  }

  async listSessions(
    cwd: string | undefined,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<RuntimeSessionPage> {
    this.#record("session/list", { cwd, cursor });
    throwIfAborted(signal);
    return {
      sessions: this.sessionPage.sessions.filter(session => cwd === undefined || session.cwd === cwd),
      ...(this.sessionPage.nextCursor === undefined ? {} : { nextCursor: this.sessionPage.nextCursor }),
    };
  }

  async deleteSession(sessionId: string, signal: AbortSignal): Promise<void> {
    this.#record("session/delete", sessionId);
    throwIfAborted(signal);
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.#record("close");
    await this.closeHandler();
  }

  #record(method: string, input?: unknown): void {
    this.calls.push({ method, ...(input === undefined ? {} : { input }) });
  }

  #shiftRequired(
    queue: RuntimeSessionOpenResult[],
    method: string,
  ): RuntimeSessionOpenResult {
    const result = queue.shift();
    if (result === undefined) {
      throw new Error(`No fake result queued for ${method}`);
    }
    return result;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
}
