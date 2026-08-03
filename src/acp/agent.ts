import path from "node:path";
import {
  PROTOCOL_VERSION,
  RequestError,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type DisableProviderRequest,
  type DisableProviderResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListProvidersRequest,
  type ListProvidersResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SetProviderRequest,
  type SetProviderResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type {
  RuntimeCommand,
  RuntimeConfigOption,
  RuntimeElicitationRequest,
  RuntimeEvent,
  RuntimePermissionRequest,
  RuntimePromptContext,
  RuntimeSession,
  RuntimeSessionLoadInput,
  RuntimeSessionOpenResult,
  RuntimeTurnResult,
} from "../runtime/types.js";
import {
  RuntimeCompatibilityError,
  RuntimeUnsupportedError,
} from "../runtime/types.js";
import {
  assertAcpBaseline,
  mapAgentCapabilities,
  mapAuthMethods,
  mapConfigOptions,
  mapMcpServers,
  mapModes,
  mapPromptContent,
  mapProviders,
  mapRuntimeEvent,
  mapSessionInfo,
  mapUsage,
  validateProviderSelection,
} from "./mapping.js";
import type {
  DshAcpAgentOptions,
  DshAcpClient,
  DshAcpConnectionState,
  DshSteeringRequest,
  DshSteeringResponse,
} from "./types.js";

const ABORTED = Symbol("aborted");

interface SessionState {
  readonly id: string;
  readonly runtime: RuntimeSession;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly modes: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
  readonly emittedToolCalls: Set<string>;
  readonly terminalStates: Map<string, "open" | "closed">;
  configOptions: readonly RuntimeConfigOption[];
  commands: readonly RuntimeCommand[];
  commandsPublished: boolean;
  currentModeId?: string;
  generation: number;
  ready: boolean;
  activeTurn: ActiveTurn | undefined;
  closePromise: Promise<void> | undefined;
}

interface ActiveTurn {
  readonly generation: number;
  readonly turnId: string;
  readonly controller: AbortController;
  readonly emittedToolCalls: Set<string>;
  cancelStarted?: Promise<void>;
  cancelFinished?: Promise<void>;
  runner?: Promise<RuntimeTurnResult>;
  generator?: AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void>;
  drainTimer?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
}

interface PendingUrlElicitation {
  readonly session: SessionState;
  readonly client: DshAcpClient;
  accepted: boolean;
  completed: boolean;
}

interface PendingOpen {
  drain: Promise<void>;
}

interface NormalizedAgentOptions {
  readonly driver: DshAcpAgentOptions["driver"];
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly cancelDrainTimeoutMs: number;
  readonly elicitationCompletion: boolean;
  readonly terminalAuthCommand?: string;
}

type OpenMethod = "session/new" | "session/load" | "session/resume" | "session/fork";

/** ACP protocol state machine backed by one versioned DSH runtime driver. */
export class DshAcpAgent {
  readonly #options: NormalizedAgentOptions;
  readonly #sessions = new Map<string, SessionState>();
  readonly #openingSessionIds = new Set<string>();
  readonly #pendingOpens = new Set<PendingOpen>();
  readonly #pendingUrlElicitations = new Map<string, PendingUrlElicitation>();
  readonly #connection: DshAcpConnectionState = { clientCapabilities: {} };
  readonly #lifecycleController = new AbortController();
  #initialized = false;
  #initializationClaimed = false;
  #lifecycleGeneration = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: DshAcpAgentOptions) {
    const cancelDrainTimeoutMs = options.cancelDrainTimeoutMs ?? 5_000;
    if (!Number.isFinite(cancelDrainTimeoutMs) || cancelDrainTimeoutMs < 0) {
      throw new TypeError("cancelDrainTimeoutMs must be a non-negative finite number");
    }
    this.#options = {
      driver: options.driver,
      name: options.name ?? "dsh-acp",
      title: options.title ?? "DeepSeek Harness ACP",
      version: options.version ?? "0.1.0",
      cancelDrainTimeoutMs,
      elicitationCompletion: options.elicitationCompletion ?? false,
      ...(options.terminalAuthCommand === undefined
        ? {}
        : { terminalAuthCommand: options.terminalAuthCommand }),
    };
  }

  async initialize(
    request: InitializeRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<InitializeResponse> {
    this.#ensureOpen();
    if (this.#initializationClaimed) {
      throw RequestError.invalidRequest(
        { code: "ALREADY_INITIALIZED" },
        "The ACP connection can only be initialized once",
      );
    }
    this.#initializationClaimed = true;
    assertAcpBaseline(this.#options.driver.capabilities);
    if (!Number.isInteger(request.protocolVersion) || request.protocolVersion < PROTOCOL_VERSION) {
      throw RequestError.invalidParams(
        { protocolVersion: request.protocolVersion, minimum: PROTOCOL_VERSION },
        "This adapter requires ACP protocol version 1 or newer",
      );
    }
    const lifecycleGeneration = this.#lifecycleGeneration;
    const initializeSignal = AbortSignal.any([
      signal,
      this.#lifecycleController.signal,
    ]);
    if (initializeSignal.aborted) {
      throw RequestError.requestCancelled();
    }

    await this.#callRuntime(
      () => this.#options.driver.initialize(initializeSignal),
      initializeSignal,
    );
    if (
      this.#closed ||
      this.#lifecycleGeneration !== lifecycleGeneration ||
      this.#lifecycleController.signal.aborted
    ) {
      throw RequestError.requestCancelled(
        { code: "AGENT_CLOSED_DURING_INITIALIZE" },
      );
    }
    this.#initialized = true;
    this.#connection.clientCapabilities = request.clientCapabilities ?? {};

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: mapAgentCapabilities(this.#options.driver.capabilities, {
        elicitationCompletion: this.#options.elicitationCompletion,
      }),
      authMethods: this.#options.driver.capabilities.auth.authenticate
        ? mapAuthMethods(this.#options.driver.authMethods, {
            clientSupportsTerminal: request.clientCapabilities?.auth?.terminal === true,
            ...(this.#options.terminalAuthCommand === undefined
              ? {}
              : { terminalAuthCommand: this.#options.terminalAuthCommand }),
          })
        : [],
      agentInfo: {
        name: this.#options.name,
        title: this.#options.title,
        version: this.#options.version,
      },
      _meta: {
        runtimeDriverId: this.#options.driver.id,
        requestedProtocolVersion: request.protocolVersion,
      },
    };
  }

  async authenticate(
    request: AuthenticateRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<AuthenticateResponse> {
    this.#requireInitialized();
    this.#requireCapability(
      this.#options.driver.capabilities.auth.authenticate,
      "authenticate",
    );
    if (!this.#options.driver.authMethods.some((method) => method.id === request.methodId)) {
      throw RequestError.invalidParams(
        { methodId: request.methodId },
        "Unknown authentication method",
      );
    }
    await this.#callRuntime(
      () => this.#options.driver.authenticate(request.methodId, signal),
      signal,
    );
    return {};
  }

  async logout(
    _request: LogoutRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<LogoutResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.auth.logout, "logout");
    await this.#callRuntime(() => this.#options.driver.logout(signal), signal);
    return {};
  }

  async listProviders(
    _request: ListProvidersRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<ListProvidersResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.providers, "providers/list");
    const result = await this.#callRuntime(
      () => this.#options.driver.listProviders(signal),
      signal,
    );
    return { providers: mapProviders(result.providers, result.currentProviderId) };
  }

  async setProvider(
    request: SetProviderRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<SetProviderResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.providers, "providers/set");
    validateProviderSelection(
      request.providerId,
      request.apiType,
      request.baseUrl,
      request.headers,
    );
    await this.#callRuntime(
      () => this.#options.driver.setProvider(request.providerId, signal),
      signal,
    );
    return {};
  }

  async disableProvider(
    request: DisableProviderRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<DisableProviderResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.providers, "providers/disable");
    await this.#callRuntime(
      () => this.#options.driver.disableProvider(request.providerId, signal),
      signal,
    );
    return {};
  }

  async newSession(
    request: NewSessionRequest,
    client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<NewSessionResponse> {
    this.#requireInitialized();
    this.#validateOpenRequest(request.cwd, request.additionalDirectories, request.mcpServers);
    const openSignal = AbortSignal.any([signal, this.#lifecycleController.signal]);
    const result = await this.#callRuntimeOpen(
      () =>
        this.#options.driver.newSession(
          {
            cwd: request.cwd,
            additionalDirectories: request.additionalDirectories ?? [],
            mcpServers: mapMcpServers(
              request.mcpServers,
              this.#options.driver.capabilities.mcp,
            ),
            ...(request._meta == null ? {} : { _meta: request._meta }),
          },
          openSignal,
        ),
      openSignal,
    );
    const state = await this.#activateSession(
      "session/new",
      result,
      request.cwd,
      request.additionalDirectories ?? [],
      client,
      openSignal,
    );
    return {
      sessionId: state.id,
      ...this.#sessionSetupResponse(state),
    };
  }

  async loadSession(
    request: LoadSessionRequest,
    client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<LoadSessionResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.sessions.load, "session/load");
    const input = this.#mapLoadInput(request);
    const openSignal = AbortSignal.any([signal, this.#lifecycleController.signal]);
    const result = await this.#callRuntimeOpen(
      () => this.#options.driver.loadSession(input, openSignal),
      openSignal,
    );
    const state = await this.#activateSession(
      "session/load",
      result,
      request.cwd,
      request.additionalDirectories ?? [],
      client,
      openSignal,
      request.sessionId,
    );
    return this.#sessionSetupResponse(state);
  }

  async resumeSession(
    request: ResumeSessionRequest,
    client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<ResumeSessionResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.sessions.resume, "session/resume");
    const input = this.#mapLoadInput(request);
    const openSignal = AbortSignal.any([signal, this.#lifecycleController.signal]);
    const result = await this.#callRuntimeOpen(
      () => this.#options.driver.resumeSession(input, openSignal),
      openSignal,
    );
    const state = await this.#activateSession(
      "session/resume",
      result,
      request.cwd,
      request.additionalDirectories ?? [],
      client,
      openSignal,
      request.sessionId,
    );
    return this.#sessionSetupResponse(state);
  }

  async forkSession(
    request: ForkSessionRequest,
    client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<ForkSessionResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.sessions.fork, "session/fork");
    this.#validateOpenRequest(request.cwd, request.additionalDirectories, request.mcpServers ?? []);
    const openSignal = AbortSignal.any([signal, this.#lifecycleController.signal]);
    const result = await this.#callRuntimeOpen(
      () =>
        this.#options.driver.forkSession(
          {
            sessionId: request.sessionId,
            cwd: request.cwd,
            additionalDirectories: request.additionalDirectories ?? [],
            mcpServers: mapMcpServers(
              request.mcpServers ?? [],
              this.#options.driver.capabilities.mcp,
            ),
            ...(request._meta == null ? {} : { _meta: request._meta }),
          },
          openSignal,
        ),
      openSignal,
    );
    const state = await this.#activateSession(
      "session/fork",
      result,
      request.cwd,
      request.additionalDirectories ?? [],
      client,
      openSignal,
    );
    if (state.id === request.sessionId) {
      await this.#discardSession(state);
      throw RequestError.internalError(
        { code: "INVALID_RUNTIME_SESSION" },
        "DSH returned the source session as its fork",
      );
    }
    return { sessionId: state.id, ...this.#sessionSetupResponse(state) };
  }

  async listSessions(
    request: ListSessionsRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<ListSessionsResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.sessions.list, "session/list");
    if (request.cwd != null) {
      this.#requireAbsolutePath(request.cwd, "cwd");
    }
    const page = await this.#callRuntime(
      () => this.#options.driver.listSessions(
        request.cwd ?? undefined,
        request.cursor ?? undefined,
        signal,
      ),
      signal,
    );
    return {
      sessions: page.sessions
        .map(mapSessionInfo),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async closeSession(
    request: CloseSessionRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<CloseSessionResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.sessions.close, "session/close");
    const state = this.#requireSession(request.sessionId, true);
    await this.#closeRuntimeSession(state);
    if (this.#sessions.get(state.id) === state) this.#sessions.delete(state.id);
    if (signal.aborted) {
      throw RequestError.requestCancelled();
    }
    return {};
  }

  async deleteSession(
    request: DeleteSessionRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<DeleteSessionResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.sessions.delete, "session/delete");
    const state = this.#sessions.get(request.sessionId);
    if (state !== undefined) {
      await this.#closeRuntimeSession(state);
      if (this.#sessions.get(state.id) === state) this.#sessions.delete(state.id);
    }
    const cleanupSignal = new AbortController().signal;
    await this.#callCleanup(
      () => this.#options.driver.deleteSession(request.sessionId, cleanupSignal),
    );
    if (signal.aborted) {
      throw RequestError.requestCancelled();
    }
    return {};
  }

  async setSessionMode(
    request: SetSessionModeRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<SetSessionModeResponse> {
    this.#requireInitialized();
    const state = this.#requireSession(request.sessionId);
    if (
      state.runtime.setMode === undefined ||
      state.modes.length === 0 ||
      !state.modes.some((mode) => mode.id === request.modeId)
    ) {
      throw RequestError.invalidParams(
        { modeId: request.modeId },
        "This session does not support the requested mode",
      );
    }
    const setMode = state.runtime.setMode;
    await this.#callRuntime(() => setMode.call(state.runtime, request.modeId), signal);
    state.currentModeId = request.modeId;
    return {};
  }

  async setSessionConfigOption(
    request: SetSessionConfigOptionRequest,
    _client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<SetSessionConfigOptionResponse> {
    this.#requireInitialized();
    const state = this.#requireSession(request.sessionId);
    const option = state.configOptions.find((candidate) => candidate.id === request.configId);
    if (state.runtime.setConfigOption === undefined || option === undefined) {
      throw RequestError.invalidParams(
        { configId: request.configId },
        "This session does not support the requested configuration option",
      );
    }
    this.#validateConfigValue(option, request.value);
    const setConfigOption = state.runtime.setConfigOption;
    await this.#callRuntime(
      () => setConfigOption.call(state.runtime, request.configId, request.value),
      signal,
    );
    state.configOptions = state.configOptions.map((candidate) =>
      candidate.id === request.configId
        ? { ...candidate, currentValue: request.value }
        : candidate,
    );
    return { configOptions: mapConfigOptions(state.configOptions) };
  }

  async steer(
    request: DshSteeringRequest,
    _client: DshAcpClient,
    requestSignal: AbortSignal,
  ): Promise<DshSteeringResponse> {
    this.#requireInitialized();
    this.#requireCapability(this.#options.driver.capabilities.steering, "_session/steering");
    const state = this.#requireSession(request.sessionId);
    const turn = state.activeTurn;
    if (turn === undefined || state.runtime.steer === undefined || !this.#isLiveTurn(state, turn)) {
      throw RequestError.invalidRequest(
        { sessionId: state.id },
        "Steering requires an active prompt turn",
      );
    }
    const signal = AbortSignal.any([requestSignal, turn.controller.signal]);
    const content = mapPromptContent(
      request.prompt,
      this.#options.driver.capabilities.prompt,
    );
    const steer = state.runtime.steer;
    await this.#callRuntime(
      () =>
        steer.call(
          state.runtime,
          {
            content,
            ...(request._meta == null ? {} : { _meta: request._meta }),
          },
          signal,
        ),
      signal,
    );
    this.#ensureLiveTurn(state, turn);
    return { outcome: "injected" };
  }

  async prompt(
    request: PromptRequest,
    client: DshAcpClient,
    requestSignal: AbortSignal,
  ): Promise<PromptResponse> {
    this.#requireInitialized();
    const state = this.#requireSession(request.sessionId);
    if (state.activeTurn !== undefined) {
      throw RequestError.invalidRequest(
        { sessionId: state.id },
        "Only one prompt turn may run in a session at a time",
      );
    }

    const generation = ++state.generation;
    const turn: ActiveTurn = {
      generation,
      turnId: `${state.id}:${generation}`,
      controller: new AbortController(),
      emittedToolCalls: state.emittedToolCalls,
      cancelled: false,
    };
    state.activeTurn = turn;
    const onRequestAbort = () => {
      this.#startTurnCancellation(state, turn);
    };
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
    if (requestSignal.aborted) {
      onRequestAbort();
    }

    let runnerStarted = false;
    try {
      const openingSignal = AbortSignal.any([requestSignal, turn.controller.signal]);
      await this.#publishInitialCommands(state, client, openingSignal);
      if (turn.cancelled) {
        return { stopReason: "cancelled" };
      }
      this.#ensureLiveTurn(state, turn);

      const content = mapPromptContent(request.prompt, this.#options.driver.capabilities.prompt);
      const context = this.#promptContext(state, turn, client);
      const generator = state.runtime.prompt(
        {
          content,
          ...(request._meta == null ? {} : { _meta: request._meta }),
        },
        context,
      );
      turn.generator = generator;
      const runner = this.#runTurn(state, turn, generator, client);
      turn.runner = runner;
      runnerStarted = true;
      void runner.then(
        () => this.#finishTurn(state, turn),
        () => this.#finishTurn(state, turn),
      );

      const raced = await raceAbort(runner, turn.controller.signal);
      if (raced === ABORTED || turn.cancelled) {
        return { stopReason: "cancelled" };
      }
      return {
        stopReason: raced.stopReason,
        ...(raced.usage === undefined ? {} : { usage: mapUsage(raced.usage) }),
        ...(raced._meta === undefined ? {} : { _meta: raced._meta }),
      };
    } catch (error) {
      if (turn.cancelled || requestSignal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw error;
    } finally {
      requestSignal.removeEventListener("abort", onRequestAbort);
      if (!runnerStarted) {
        if (turn.cancelled) {
          await this.#awaitTurnCancellation(turn);
        } else {
          turn.controller.abort(new Error("ACP prompt opening completed"));
          this.#releaseTurn(state, turn);
        }
      } else if (turn.cancelled) {
        await this.#awaitTurnCancellation(turn);
      } else {
        turn.controller.abort(new Error("ACP prompt turn completed"));
      }
    }
  }

  cancel(request: CancelNotification): void {
    const state = this.#sessions.get(request.sessionId);
    if (state?.activeTurn !== undefined) {
      this.#startTurnCancellation(state, state.activeTurn);
    }
  }

  /**
   * Completes a previously accepted URL elicitation. Versioned runtime
   * integrations call this only from their authenticated out-of-band callback.
   */
  async completeElicitation(elicitationId: string): Promise<boolean> {
    this.#requireInitialized();
    this.#requireCapability(
      this.#options.elicitationCompletion,
      "elicitation/complete",
    );
    const pending = this.#pendingUrlElicitations.get(elicitationId);
    if (pending === undefined) {
      return false;
    }
    pending.completed = true;
    if (!pending.accepted) {
      return true;
    }
    return this.#deliverElicitationCompletion(elicitationId, pending);
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#lifecycleGeneration++;
      this.#lifecycleController.abort(new Error("ACP connection closed"));
    }
    if (this.#closePromise === undefined) {
      const attempt = this.#closeOnce();
      this.#closePromise = attempt;
      void attempt.catch(() => {
        // Admission stays closed, but exact session/driver ownership remains
        // retryable after a transient teardown failure.
        if (this.#closePromise === attempt) this.#closePromise = undefined;
      });
    }
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#sessions.values()].map(async (state) => {
        await this.#closeRuntimeSession(state);
        if (this.#sessions.get(state.id) === state) this.#sessions.delete(state.id);
      }),
    );
    await raceTimeout(
      Promise.allSettled([...this.#pendingOpens].map((pending) => pending.drain))
        .then(() => undefined),
      this.#options.cancelDrainTimeoutMs,
    );
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length > 0 || this.#sessions.size > 0) {
      throw new AggregateError(failures, "failed to close one or more ACP runtime sessions");
    }
    await this.#options.driver.close();
  }

  #mapLoadInput(
    request: LoadSessionRequest | ResumeSessionRequest,
  ): RuntimeSessionLoadInput {
    this.#validateOpenRequest(request.cwd, request.additionalDirectories, request.mcpServers ?? []);
    return {
      sessionId: request.sessionId,
      cwd: request.cwd,
      additionalDirectories: request.additionalDirectories ?? [],
      mcpServers: mapMcpServers(
        request.mcpServers ?? [],
        this.#options.driver.capabilities.mcp,
      ),
      ...(request._meta == null ? {} : { _meta: request._meta }),
    };
  }

  async #activateSession(
    method: OpenMethod,
    result: RuntimeSessionOpenResult,
    requestedCwd: string,
    requestedAdditionalDirectories: readonly string[],
    client: DshAcpClient,
    signal: AbortSignal,
    expectedSessionId?: string,
  ): Promise<SessionState> {
    if (signal.aborted || this.#closed) {
      await result.session.close().catch(() => undefined);
      throw RequestError.requestCancelled();
    }
    try {
      this.#validateOpenResult(result, requestedCwd, expectedSessionId);
    } catch (error) {
      await result.session.close().catch(() => undefined);
      throw error;
    }
    const sessionId = result.descriptor.id;
    if (this.#sessions.has(sessionId) || this.#openingSessionIds.has(sessionId)) {
      await result.session.close().catch(() => undefined);
      throw RequestError.invalidRequest(
        { sessionId },
        "The session is already active on this ACP connection",
      );
    }

    const state: SessionState = {
      id: sessionId,
      runtime: result.session,
      cwd: result.descriptor.cwd,
      additionalDirectories: [...requestedAdditionalDirectories],
      modes: result.modes ?? [],
      configOptions: result.configOptions ?? [],
      commands: result.commands ?? [],
      ...(result.descriptor.modeId === undefined
        ? {}
        : { currentModeId: result.descriptor.modeId }),
      emittedToolCalls: new Set<string>(),
      terminalStates: new Map<string, "open" | "closed">(),
      commandsPublished: false,
      generation: 0,
      ready: false,
      activeTurn: undefined,
      closePromise: undefined,
    };
    this.#openingSessionIds.add(sessionId);
    this.#sessions.set(sessionId, state);

    try {
      if (method === "session/load" && result.replay !== undefined) {
        for await (const event of result.replay) {
          if (signal.aborted || this.#sessions.get(sessionId) !== state) {
            throw RequestError.requestCancelled();
          }
          this.#assertDeclaredEvent(event);
          await this.#notifyUpdate(client, state.id, mapRuntimeEvent(event, {
            emittedToolCalls: state.emittedToolCalls,
            terminalStates: state.terminalStates,
            clientCapabilities: this.#connection.clientCapabilities,
          }), signal);
        }
      } else if (result.replay !== undefined) {
        throw RequestError.internalError(
          { code: "INVALID_RUNTIME_SESSION", method },
          "DSH returned history for a session operation that must not replay history",
        );
      }

      if (method === "session/load" || method === "session/resume") {
        await this.#publishInitialCommands(state, client, signal);
      }
      if (signal.aborted || this.#closed) {
        throw RequestError.requestCancelled();
      }
      state.ready = true;
      return state;
    } catch (error) {
      this.#sessions.delete(sessionId);
      this.#invalidateSession(state);
      await result.session.close().catch(() => undefined);
      throw error;
    } finally {
      this.#openingSessionIds.delete(sessionId);
    }
  }

  #sessionSetupResponse(state: SessionState): {
    modes?: SessionModeState;
    configOptions?: SessionConfigOption[];
  } {
    const modes = mapModes(state.modes, state.currentModeId);
    const configOptions = mapConfigOptions(state.configOptions);
    return {
      ...(modes === undefined ? {} : { modes }),
      ...(configOptions.length === 0 ? {} : { configOptions }),
    };
  }

  async #publishInitialCommands(
    state: SessionState,
    client: DshAcpClient,
    signal: AbortSignal,
  ): Promise<void> {
    if (state.commandsPublished) {
      return;
    }
    if (state.commands.length > 0) {
      await this.#notifyUpdate(
        client,
        state.id,
        mapRuntimeEvent(
          { type: "available_commands_update", commands: state.commands },
          {
            emittedToolCalls: state.emittedToolCalls,
            terminalStates: state.terminalStates,
            clientCapabilities: this.#connection.clientCapabilities,
          },
        ),
        signal,
      );
    }
    state.commandsPublished = true;
  }

  #validateOpenResult(
    result: RuntimeSessionOpenResult,
    requestedCwd: string,
    expectedSessionId: string | undefined,
  ): void {
    if (
      result.session.id !== result.descriptor.id ||
      result.session.cwd !== result.descriptor.cwd ||
      result.descriptor.cwd !== requestedCwd ||
      (expectedSessionId !== undefined && result.descriptor.id !== expectedSessionId)
    ) {
      throw RequestError.internalError(
        { code: "INVALID_RUNTIME_SESSION" },
        "DSH returned a session that does not match the ACP request",
      );
    }
  }

  #validateOpenRequest(
    cwd: string,
    additionalDirectories: readonly string[] | undefined,
    mcpServers: readonly unknown[],
  ): void {
    this.#requireAbsolutePath(cwd, "cwd");
    for (const directory of additionalDirectories ?? []) {
      this.#requireAbsolutePath(directory, "additionalDirectories");
    }
    if (
      (additionalDirectories?.length ?? 0) > 0 &&
      !this.#options.driver.capabilities.sessions.additionalDirectories
    ) {
      throw RequestError.invalidParams(
        { field: "additionalDirectories" },
        "The selected DSH runtime does not support additional session directories",
      );
    }
    void mcpServers;
  }

  #requireAbsolutePath(value: string, field: string): void {
    if (!path.isAbsolute(value)) {
      throw RequestError.invalidParams({ field }, `${field} must contain absolute paths`);
    }
  }

  #requireSessionPath(state: SessionState, filePath: string): void {
    if (!path.isAbsolute(filePath) || filePath.includes("\0")) {
      throw RequestError.invalidParams(
        { code: "INVALID_SESSION_PATH" },
        "Client file access requires an absolute path inside a session root",
      );
    }
    const roots = [state.cwd, ...state.additionalDirectories];
    const allowed = roots.some((root) => {
      const relative = path.relative(root, filePath);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      );
    });
    if (!allowed) {
      throw RequestError.invalidParams(
        { code: "PATH_OUTSIDE_SESSION_ROOTS" },
        "Client file access is outside the session roots",
      );
    }
  }

  #validateConfigValue(option: RuntimeConfigOption, value: string | boolean): void {
    if (option.kind === "boolean") {
      if (typeof value !== "boolean") {
        throw RequestError.invalidParams(
          { configId: option.id },
          "This configuration option requires a boolean value",
        );
      }
      return;
    }
    if (
      typeof value !== "string" ||
      option.options === undefined ||
      !option.options.some((candidate) => candidate.value === value)
    ) {
      throw RequestError.invalidParams(
        { configId: option.id },
        "This configuration option requires one of its advertised values",
      );
    }
  }

  #promptContext(
    state: SessionState,
    turn: ActiveTurn,
    client: DshAcpClient,
  ): RuntimePromptContext {
    return {
      turnId: turn.turnId,
      signal: turn.controller.signal,
      requestPermission: (request, signal) =>
        this.#requestPermission(state, turn, client, request, signal),
      requestElicitation: (request, signal) =>
        this.#requestElicitation(state, turn, client, request, signal),
      readTextFile: async (filePath, line, limit) => {
        if (!this.#connection.clientCapabilities.fs?.readTextFile) {
          throw RequestError.methodNotFound("fs/read_text_file");
        }
        this.#ensureLiveTurn(state, turn);
        this.#requireSessionPath(state, filePath);
        return client.readTextFile(
          {
            sessionId: state.id,
            path: filePath,
            ...(line === undefined ? {} : { line }),
            ...(limit === undefined ? {} : { limit }),
          },
          turn.controller.signal,
        );
      },
      writeTextFile: async (filePath, content) => {
        if (!this.#connection.clientCapabilities.fs?.writeTextFile) {
          throw RequestError.methodNotFound("fs/write_text_file");
        }
        this.#ensureLiveTurn(state, turn);
        this.#requireSessionPath(state, filePath);
        await client.writeTextFile(
          { sessionId: state.id, path: filePath, content },
          turn.controller.signal,
        );
      },
    };
  }

  async #requestPermission(
    state: SessionState,
    turn: ActiveTurn,
    client: DshAcpClient,
    request: RuntimePermissionRequest,
    runtimeSignal: AbortSignal,
  ) {
    if (!this.#options.driver.capabilities.permissions) {
      return { outcome: "cancelled" as const };
    }
    this.#validatePermissionRequest(request);
    const signal = AbortSignal.any([turn.controller.signal, runtimeSignal]);
    if (!state.emittedToolCalls.has(request.toolCallId)) {
      const sent = await this.#notifyLiveUpdate(
        client,
        state,
        turn,
        {
          sessionUpdate: "tool_call",
          toolCallId: request.toolCallId,
          title: request.title,
          kind: request.kind,
          status: "pending",
          ...(request.locations === undefined
            ? {}
            : {
                locations: request.locations.map((location) => ({
                  path: location.path,
                  ...(location.line === undefined ? {} : { line: location.line }),
                })),
              }),
          ...(request.rawInput === undefined ? {} : { rawInput: request.rawInput }),
          _meta: { ...(request._meta ?? {}), runtimePermissionRequestId: request.requestId },
        },
        signal,
      );
      if (!sent) {
        return { outcome: "cancelled" as const };
      }
      state.emittedToolCalls.add(request.toolCallId);
    }

    if (!this.#isLiveTurn(state, turn) || signal.aborted) {
      return { outcome: "cancelled" as const };
    }
    const pending = client.requestPermission(
      {
        sessionId: state.id,
        toolCall: {
          toolCallId: request.toolCallId,
          title: request.title,
          kind: request.kind,
          status: "pending",
          ...(request.locations === undefined
            ? {}
            : {
                locations: request.locations.map((location) => ({
                  path: location.path,
                  ...(location.line === undefined ? {} : { line: location.line }),
                })),
              }),
          ...(request.rawInput === undefined ? {} : { rawInput: request.rawInput }),
        },
        options: request.choices.map((choice) => ({
          optionId: choice.id,
          name: choice.name,
          kind: choice.kind,
          ...(choice._meta === undefined ? {} : { _meta: choice._meta }),
        })),
        _meta: { ...(request._meta ?? {}), runtimePermissionRequestId: request.requestId },
      },
      signal,
    );
    const response = await raceAbort(pending, signal);
    if (response === ABORTED || !this.#isLiveTurn(state, turn)) {
      return { outcome: "cancelled" as const };
    }
    const outcome = response.outcome;
    if (outcome.outcome === "cancelled") {
      return { outcome: "cancelled" as const };
    }
    if (!request.choices.some((choice) => choice.id === outcome.optionId)) {
      return { outcome: "cancelled" as const };
    }
    return { outcome: "selected" as const, optionId: outcome.optionId };
  }

  #validatePermissionRequest(request: RuntimePermissionRequest): void {
    const choiceIds = new Set<string>();
    const validKinds = new Set(["reject_once", "allow_once", "allow_always"]);
    let invalid =
      typeof request.requestId !== "string" ||
      request.requestId.length === 0 ||
      typeof request.toolCallId !== "string" ||
      request.toolCallId.length === 0 ||
      typeof request.title !== "string" ||
      request.title.length === 0 ||
      !Array.isArray(request.choices) ||
      request.choices.length === 0;
    if (!invalid) {
      invalid = request.choices.some((choice) => {
        if (
          typeof choice.id !== "string" ||
          choice.id.length === 0 ||
          typeof choice.name !== "string" ||
          choice.name.length === 0 ||
          choiceIds.has(choice.id) ||
          typeof choice.kind !== "string" ||
          !validKinds.has(choice.kind)
        ) {
          return true;
        }
        choiceIds.add(choice.id);
        return false;
      });
    }
    if (invalid) {
      throw new RuntimeCompatibilityError(
        "INVALID_PERMISSION_REQUEST",
        "DSH emitted an invalid permission request",
      );
    }
  }

  async #requestElicitation(
    state: SessionState,
    turn: ActiveTurn,
    client: DshAcpClient,
    request: RuntimeElicitationRequest,
    runtimeSignal: AbortSignal,
  ) {
    const supportedByRuntime = this.#options.driver.capabilities.elicitation[request.mode];
    const supportedByClient = this.#connection.clientCapabilities.elicitation?.[request.mode] != null;
    if (!supportedByRuntime || !supportedByClient) {
      return { action: "cancel" as const };
    }
    const signal = AbortSignal.any([turn.controller.signal, runtimeSignal]);
    if (!this.#isLiveTurn(state, turn) || signal.aborted) {
      return { action: "cancel" as const };
    }

    const params = request.mode === "url"
      ? {
          mode: "url" as const,
          sessionId: state.id,
          elicitationId: request.elicitationId,
          message: request.message,
          url: request.url ?? "",
          ...(request._meta === undefined ? {} : { _meta: request._meta }),
        }
      : {
          mode: "form" as const,
          sessionId: state.id,
          message: request.message,
          requestedSchema: request.schema ?? { type: "object" as const },
          _meta: { ...(request._meta ?? {}), runtimeElicitationId: request.elicitationId },
        };
    if (request.mode === "url" && request.url === undefined) {
      return { action: "cancel" as const };
    }
    let pendingCompletion: PendingUrlElicitation | undefined;
    if (request.mode === "url" && this.#options.elicitationCompletion) {
      if (this.#pendingUrlElicitations.has(request.elicitationId)) {
        return { action: "cancel" as const };
      }
      pendingCompletion = {
        session: state,
        client,
        accepted: false,
        completed: false,
      };
      this.#pendingUrlElicitations.set(request.elicitationId, pendingCompletion);
    }
    const response = await raceAbort(client.createElicitation(params, signal), signal);
    if (response === ABORTED || !this.#isLiveTurn(state, turn)) {
      if (pendingCompletion !== undefined) {
        this.#pendingUrlElicitations.delete(request.elicitationId);
      }
      return { action: "cancel" as const };
    }
    if (response.action === "accept") {
      if (pendingCompletion !== undefined) {
        pendingCompletion.accepted = true;
        if (pendingCompletion.completed) {
          await this.#deliverElicitationCompletion(
            request.elicitationId,
            pendingCompletion,
          );
        }
      }
      return {
        action: "accept" as const,
        ...(response.content === undefined ? {} : { content: response.content }),
      };
    }
    if (pendingCompletion !== undefined) {
      this.#pendingUrlElicitations.delete(request.elicitationId);
    }
    return { action: response.action === "decline" ? "decline" as const : "cancel" as const };
  }

  async #deliverElicitationCompletion(
    elicitationId: string,
    pending: PendingUrlElicitation,
  ): Promise<boolean> {
    if (
      this.#pendingUrlElicitations.get(elicitationId) !== pending ||
      this.#sessions.get(pending.session.id) !== pending.session ||
      !pending.session.ready
    ) {
      this.#pendingUrlElicitations.delete(elicitationId);
      return false;
    }
    this.#pendingUrlElicitations.delete(elicitationId);
    await pending.client.completeElicitation(elicitationId);
    return true;
  }

  async #runTurn(
    state: SessionState,
    turn: ActiveTurn,
    generator: AsyncGenerator<RuntimeEvent, RuntimeTurnResult, void>,
    client: DshAcpClient,
  ): Promise<RuntimeTurnResult> {
    try {
      while (true) {
        const next = await generator.next();
        if (next.done) {
          return next.value;
        }
        if (!this.#isLiveTurn(state, turn)) {
          continue;
        }
        this.#assertDeclaredEvent(next.value);
        await this.#sendRuntimeEvent(client, state, turn, next.value);
      }
    } catch (error) {
      if (turn.cancelled || turn.controller.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      throw this.#translateRuntimeError(error);
    }
  }

  async #sendRuntimeEvent(
    client: DshAcpClient,
    state: SessionState,
    turn: ActiveTurn,
    event: RuntimeEvent,
  ): Promise<void> {
    if (event.type === "current_mode_update") {
      if (
        state.modes.length > 0 &&
        !state.modes.some((mode) => mode.id === event.modeId)
      ) {
        throw new RuntimeCompatibilityError(
          "INVALID_MODE_UPDATE",
          "DSH emitted an unknown session mode",
          { modeId: event.modeId },
        );
      }
      state.currentModeId = event.modeId;
    } else if (event.type === "config_option_update") {
      state.configOptions = event.options;
    } else if (event.type === "available_commands_update") {
      state.commands = event.commands;
      state.commandsPublished = true;
    }
    if (
      event.type === "tool_call_update" &&
      !state.emittedToolCalls.has(event.toolCallId)
    ) {
      const sent = await this.#notifyLiveUpdate(
        client,
        state,
        turn,
        {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: event.title ?? "Tool call",
          kind: event.kind ?? "other",
          status: "pending",
        },
        turn.controller.signal,
      );
      if (!sent) {
        return;
      }
      state.emittedToolCalls.add(event.toolCallId);
    }
    await this.#notifyLiveUpdate(
      client,
      state,
      turn,
      mapRuntimeEvent(event, {
        emittedToolCalls: state.emittedToolCalls,
        terminalStates: state.terminalStates,
        clientCapabilities: this.#connection.clientCapabilities,
      }),
      turn.controller.signal,
    );
  }

  async #notifyLiveUpdate(
    client: DshAcpClient,
    state: SessionState,
    turn: ActiveTurn,
    update: Parameters<DshAcpClient["sessionUpdate"]>[0]["update"],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.#isLiveTurn(state, turn) || signal.aborted) {
      return false;
    }
    const result = await raceAbort(client.sessionUpdate({ sessionId: state.id, update }), signal);
    return result !== ABORTED && this.#isLiveTurn(state, turn);
  }

  async #notifyUpdate(
    client: DshAcpClient,
    sessionId: string,
    update: Parameters<DshAcpClient["sessionUpdate"]>[0]["update"],
    signal: AbortSignal,
  ): Promise<void> {
    const result = await raceAbort(client.sessionUpdate({ sessionId, update }), signal);
    if (result === ABORTED) {
      throw RequestError.requestCancelled();
    }
  }

  #assertDeclaredEvent(event: RuntimeEvent): void {
    if (!this.#options.driver.capabilities.updates.has(event.type)) {
      throw new RuntimeCompatibilityError(
        "UNDECLARED_RUNTIME_EVENT",
        "DSH emitted an event that its driver did not declare",
        { eventType: event.type },
      );
    }
  }

  #startTurnCancellation(state: SessionState, turn: ActiveTurn): void {
    if (turn.cancelled) {
      return;
    }
    turn.cancelled = true;
    state.generation++;
    turn.controller.abort(new Error("ACP prompt turn cancelled"));
    turn.cancelStarted = state.runtime.cancel(turn.turnId).catch(() => undefined);
    let finishCancellation!: () => void;
    turn.cancelFinished = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const drained = Promise.allSettled([
      turn.cancelStarted,
      turn.runner ?? Promise.resolve({ stopReason: "cancelled" as const }),
    ]).then(() => undefined);
    void drained.then(() => {
      this.#releaseTurn(state, turn);
      finishCancellation();
    });
    if (turn.generator !== undefined) {
      void turn.generator.return({ stopReason: "cancelled" }).catch(() => undefined);
    }
    turn.drainTimer = setTimeout(() => {
      this.#isolateHungTurn(state, turn);
      finishCancellation();
    }, this.#options.cancelDrainTimeoutMs);
    turn.drainTimer.unref?.();
  }

  #finishTurn(state: SessionState, turn: ActiveTurn): void {
    if (turn.cancelled) return;
    this.#releaseTurn(state, turn);
  }

  async #awaitTurnCancellation(turn: ActiveTurn): Promise<void> {
    await (turn.cancelFinished ?? turn.cancelStarted ?? Promise.resolve());
  }

  #releaseTurn(state: SessionState, turn: ActiveTurn): void {
    if (turn.drainTimer !== undefined) {
      clearTimeout(turn.drainTimer);
    }
    if (state.activeTurn === turn) {
      state.activeTurn = undefined;
    }
  }

  #isolateHungTurn(state: SessionState, turn: ActiveTurn): void {
    if (
      !turn.cancelled ||
      state.activeTurn !== turn ||
      this.#sessions.get(state.id) !== state
    ) {
      return;
    }
    if (state.closePromise !== undefined) {
      state.activeTurn = undefined;
      return;
    }
    this.#sessions.delete(state.id);
    state.ready = false;
    state.generation++;
    state.activeTurn = undefined;
    this.#removeSessionElicitations(state);
    void state.runtime.close().catch(() => undefined);
  }

  #invalidateSession(state: SessionState): void {
    state.ready = false;
    state.generation++;
    this.#removeSessionElicitations(state);
    if (state.activeTurn !== undefined) {
      this.#startTurnCancellation(state, state.activeTurn);
    }
  }

  #closeRuntimeSession(state: SessionState): Promise<void> {
    if (state.closePromise === undefined) {
      const attempt = this.#closeRuntimeSessionOnce(state);
      state.closePromise = attempt;
      void attempt.catch(() => {
        if (state.closePromise === attempt) state.closePromise = undefined;
      });
    }
    return state.closePromise;
  }

  async #closeRuntimeSessionOnce(state: SessionState): Promise<void> {
    const turn = state.activeTurn;
    this.#invalidateSession(state);
    if (turn !== undefined) {
      await this.#drainTurnForClose(state, turn);
    }
    await this.#callCleanup(() => state.runtime.close());
  }

  async #drainTurnForClose(state: SessionState, turn: ActiveTurn): Promise<void> {
    const pending = Promise.allSettled([
      turn.cancelStarted ?? Promise.resolve(),
      turn.runner ?? Promise.resolve({ stopReason: "cancelled" as const }),
    ]).then(() => undefined);
    await raceTimeout(pending, this.#options.cancelDrainTimeoutMs);
    if (turn.drainTimer !== undefined) {
      clearTimeout(turn.drainTimer);
      delete turn.drainTimer;
    }
    if (state.activeTurn === turn) {
      state.activeTurn = undefined;
    }
  }

  #removeSessionElicitations(state: SessionState): void {
    for (const [elicitationId, pending] of this.#pendingUrlElicitations) {
      if (pending.session === state) {
        this.#pendingUrlElicitations.delete(elicitationId);
      }
    }
  }

  async #discardSession(state: SessionState): Promise<void> {
    this.#sessions.delete(state.id);
    await this.#closeRuntimeSession(state).catch(() => undefined);
  }

  #isLiveTurn(state: SessionState, turn: ActiveTurn): boolean {
    return (
      this.#sessions.get(state.id) === state &&
      state.ready &&
      state.activeTurn === turn &&
      state.generation === turn.generation &&
      !turn.cancelled &&
      !turn.controller.signal.aborted
    );
  }

  #ensureLiveTurn(state: SessionState, turn: ActiveTurn): void {
    if (!this.#isLiveTurn(state, turn)) {
      throw RequestError.requestCancelled();
    }
  }

  #requireSession(sessionId: string, allowOpening = false): SessionState {
    const state = this.#sessions.get(sessionId);
    if (state === undefined || (!allowOpening && !state.ready)) {
      throw RequestError.resourceNotFound(`session:${sessionId}`);
    }
    return state;
  }

  #requireInitialized(): void {
    this.#ensureOpen();
    if (!this.#initialized) {
      throw RequestError.invalidRequest(
        { code: "NOT_INITIALIZED" },
        "The ACP connection must be initialized first",
      );
    }
  }

  #ensureOpen(): void {
    if (this.#closed) {
      throw RequestError.invalidRequest(
        { code: "AGENT_CLOSED" },
        "The ACP agent is closed",
      );
    }
  }

  #requireCapability(supported: boolean, method: string): void {
    if (!supported) {
      throw RequestError.methodNotFound(method);
    }
  }

  async #callRuntime<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw RequestError.requestCancelled();
    }
    try {
      const result = await raceAbort(operation(), signal);
      if (result === ABORTED) {
        throw RequestError.requestCancelled();
      }
      return result;
    } catch (error) {
      if (error instanceof RequestError) {
        throw error;
      }
      throw this.#translateRuntimeError(error);
    }
  }

  async #callRuntimeOpen(
    operation: () => Promise<RuntimeSessionOpenResult>,
    signal: AbortSignal,
  ): Promise<RuntimeSessionOpenResult> {
    if (signal.aborted) {
      throw RequestError.requestCancelled();
    }
    let pending: Promise<RuntimeSessionOpenResult>;
    let decide!: (decision: "owned" | "abandoned") => void;
    let decided = false;
    const decision = new Promise<"owned" | "abandoned">((resolve) => {
      decide = resolve;
    });
    const settleDecision = (value: "owned" | "abandoned"): void => {
      if (!decided) {
        decided = true;
        decide(value);
      }
    };
    try {
      pending = operation();
      const tracked: PendingOpen = { drain: Promise.resolve() };
      tracked.drain = pending.then(
        async (openResult) => {
          if (await decision === "abandoned") {
            await openResult.session.close().catch(() => undefined);
          }
        },
        () => undefined,
      ).finally(() => {
        this.#pendingOpens.delete(tracked);
      });
      this.#pendingOpens.add(tracked);
      const result = await raceAbort(pending, signal);
      if (result === ABORTED) {
        settleDecision("abandoned");
        throw RequestError.requestCancelled();
      }
      settleDecision("owned");
      return result;
    } catch (error) {
      settleDecision(signal.aborted ? "abandoned" : "owned");
      if (error instanceof RequestError) {
        throw error;
      }
      throw this.#translateRuntimeError(error);
    }
  }

  async #callCleanup<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw this.#translateRuntimeError(error);
    }
  }

  #translateRuntimeError(error: unknown): RequestError {
    if (error instanceof RequestError) {
      return error;
    }
    if (error instanceof RuntimeUnsupportedError) {
      return RequestError.methodNotFound(error.capability);
    }
    if (error instanceof RuntimeCompatibilityError) {
      switch (error.code) {
        case "DSH_SESSION_CURSOR_INVALID":
        case "DSH_CWD_INVALID":
        case "DSH_CWD_UNSUPPORTED":
        case "DSH_PROMPT_EMPTY":
        case "DSH_STEER_EMPTY":
        case "DSH_MCP_CONFIG_INVALID":
          return RequestError.invalidParams(
            { code: error.code },
            "The DSH request parameters are invalid or unsupported",
          );
        case "DSH_SESSION_CURSOR_STALE":
          return RequestError.invalidParams(
            { code: error.code, restartWithoutCursor: true },
            "The session list changed; restart listing without a cursor",
          );
        case "DSH_SESSION_NOT_FOUND":
        case "DSH_SESSION_NOT_PERSISTED":
        case "DSH_SESSION_CLOSED":
        case "DSH_AGENT_RETIRED":
          return RequestError.resourceNotFound("session");
        case "DSH_SESSION_ALREADY_ACTIVE":
        case "DSH_SESSION_BUSY":
        case "DSH_SESSION_OWNERSHIP_MISMATCH":
        case "DSH_PROMPT_INFLIGHT":
        case "DSH_STEER_REJECTED":
          return RequestError.invalidRequest(
            { code: error.code },
            "The DSH session is not in a state that accepts this request",
          );
        case "DSH_SESSION_CANCELLED":
        case "DSH_INITIALIZE_CANCELLED":
        case "DSH_MCP_SETUP_CANCELLED":
        case "DSH_STEER_CANCELLED":
          return RequestError.requestCancelled({ code: error.code });
      }
      return RequestError.internalError(
        { code: error.code, ...(error.details ?? {}) },
        "The installed DSH runtime is not compatible with this adapter",
      );
    }
    return RequestError.internalError(
      { code: "DSH_RUNTIME_ERROR" },
      "The DSH runtime operation failed",
    );
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (!settled) {
        settled = true;
        resolve(ABORTED);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        }
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      },
    );
  });
}

async function raceTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs === 0) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([promise, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}
