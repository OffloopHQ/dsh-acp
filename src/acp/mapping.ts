import { RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  AuthMethod,
  ClientCapabilities,
  ContentBlock,
  McpServer,
  ProviderInfo,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionUpdate,
  ToolCallContent,
  Usage,
} from "@agentclientprotocol/sdk";
import type {
  RuntimeAuthMethod,
  RuntimeCapabilities,
  RuntimeConfigOption,
  RuntimeContentBlock,
  RuntimeEvent,
  RuntimeMcpServer,
  RuntimeMode,
  RuntimeProvider,
  RuntimeSessionDescriptor,
  RuntimeToolContent,
} from "../runtime/types.js";

const DSH_PROVIDER_PROTOCOL = "_dsh";

export function assertAcpBaseline(capabilities: RuntimeCapabilities): void {
  if (!capabilities.prompt.text || !capabilities.prompt.resourceLink) {
    throw RequestError.internalError(
      { code: "INCOMPATIBLE_RUNTIME" },
      "The selected DSH runtime lacks baseline ACP prompt support",
    );
  }
}

export function mapAgentCapabilities(
  capabilities: RuntimeCapabilities,
  extensions: { readonly elicitationCompletion: boolean },
): AgentCapabilities {
  return {
    loadSession: capabilities.sessions.load,
    promptCapabilities: {
      image: capabilities.prompt.image,
      embeddedContext: capabilities.prompt.embeddedContext,
    },
    mcpCapabilities: {
      http: capabilities.mcp.http,
      sse: capabilities.mcp.sse,
    },
    sessionCapabilities: {
      ...(capabilities.sessions.list ? { list: {} } : {}),
      ...(capabilities.sessions.delete ? { delete: {} } : {}),
      ...(capabilities.sessions.additionalDirectories ? { additionalDirectories: {} } : {}),
      ...(capabilities.sessions.fork ? { fork: {} } : {}),
      ...(capabilities.sessions.resume ? { resume: {} } : {}),
      ...(capabilities.sessions.close ? { close: {} } : {}),
    },
    ...(capabilities.auth.logout ? { auth: { logout: {} } } : {}),
    ...(capabilities.providers ? { providers: {} } : {}),
    _meta: {
      steering: { supported: capabilities.steering },
      "offloop.dsh-acp": {
        steering: capabilities.steering,
        elicitationCompletion:
          capabilities.elicitation.url && extensions.elicitationCompletion,
        security: {
          builtInNetworkTools: false,
          processNetworkIsolation: false,
          permissionGate: "dsh-emitted-only",
          protectedAdmissionFromInitialize: false,
        },
      },
    },
  };
}

export interface AuthMappingOptions {
  readonly clientSupportsTerminal: boolean;
  readonly terminalAuthCommand?: string;
}

export function mapAuthMethods(
  methods: readonly RuntimeAuthMethod[],
  options: AuthMappingOptions,
): AuthMethod[] {
  return methods.map((method) => {
    const shared = {
      id: method.id,
      name: method.name,
      ...(method.description === undefined ? {} : { description: method.description }),
    };
    if (
      method.terminal !== undefined &&
      options.clientSupportsTerminal &&
      options.terminalAuthCommand !== undefined &&
      method.terminal.command === options.terminalAuthCommand
    ) {
      return {
        ...shared,
        type: "terminal" as const,
        args: [...method.terminal.args],
        _meta: {
          ...(method._meta ?? {}),
          ...(method.terminal.label === undefined
            ? {}
            : { label: method.terminal.label }),
        },
      };
    }
    return {
      ...shared,
      _meta: {
        ...(method._meta ?? {}),
        ...(method.terminal === undefined
          ? {}
          : { terminalAuthHandledByAgent: true }),
      },
    };
  });
}

export function providerUri(providerId: string): string {
  return `dsh-provider:${encodeURIComponent(providerId)}`;
}

export function mapProviders(
  providers: readonly RuntimeProvider[],
  currentProviderId: string | undefined,
): ProviderInfo[] {
  return providers.map((provider) => ({
    providerId: provider.id,
    supported: [DSH_PROVIDER_PROTOCOL],
    required: false,
    ...(provider.id === currentProviderId
      ? {
          current: {
            apiType: DSH_PROVIDER_PROTOCOL,
            baseUrl: providerUri(provider.id),
          },
        }
      : {}),
    _meta: {
      ...(provider._meta ?? {}),
      name: provider.name,
      ...(provider.description === undefined ? {} : { description: provider.description }),
    },
  }));
}

export function validateProviderSelection(
  providerId: string,
  apiType: string,
  baseUrl: string,
  headers: Record<string, string> | undefined,
): void {
  if (
    apiType !== DSH_PROVIDER_PROTOCOL ||
    baseUrl !== providerUri(providerId) ||
    (headers !== undefined && Object.keys(headers).length > 0)
  ) {
    throw RequestError.invalidParams(
      { providerId },
      "DSH providers can only be selected using their advertised routing configuration",
    );
  }
}

export function mapMcpServers(
  servers: readonly McpServer[],
  capabilities: RuntimeCapabilities["mcp"],
): RuntimeMcpServer[] {
  return servers.map((server) => {
    if ("command" in server) {
      requireMcp(capabilities.stdio, "stdio");
      return {
        name: server.name,
        transport: "stdio",
        command: server.command,
        args: server.args,
        env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
      };
    }

    if (server.type === "http" || server.type === "sse") {
      requireMcp(capabilities[server.type], server.type);
      return {
        name: server.name,
        transport: server.type,
        url: server.url,
        headers: Object.fromEntries(server.headers.map((entry) => [entry.name, entry.value])),
      };
    }

    throw RequestError.invalidParams(
      { server: server.name, transport: server.type },
      "The selected DSH runtime does not support this MCP transport",
    );
  });
}

function requireMcp(supported: boolean, transport: string): void {
  if (!supported) {
    throw RequestError.invalidParams(
      { transport },
      "The selected DSH runtime does not support this MCP transport",
    );
  }
}

export function mapPromptContent(
  blocks: readonly ContentBlock[],
  capabilities: RuntimeCapabilities["prompt"],
): RuntimeContentBlock[] {
  return blocks.map((block) => {
    switch (block.type) {
      case "text":
        if (!capabilities.text) {
          return unsupportedPrompt(block.type);
        }
        return { type: "text", text: block.text };
      case "image":
        if (!capabilities.image) {
          return unsupportedPrompt(block.type);
        }
        return { type: "image", data: block.data, mimeType: block.mimeType };
      case "resource": {
        if (!capabilities.embeddedContext) {
          return unsupportedPrompt(block.type);
        }
        if ("text" in block.resource) {
          return {
            type: "resource",
            uri: block.resource.uri,
            ...(block.resource.mimeType == null ? {} : { mimeType: block.resource.mimeType }),
            text: block.resource.text,
          };
        }
        return {
          type: "resource",
          uri: block.resource.uri,
          ...(block.resource.mimeType == null ? {} : { mimeType: block.resource.mimeType }),
          blob: block.resource.blob,
        };
      }
      case "resource_link":
        if (!capabilities.resourceLink) {
          return unsupportedPrompt(block.type);
        }
        return {
          type: "resource_link",
          uri: block.uri,
          name: block.name,
          ...(block.description == null ? {} : { description: block.description }),
          ...(block.mimeType == null ? {} : { mimeType: block.mimeType }),
          ...(block.size == null ? {} : { size: block.size }),
        };
      case "audio":
        return unsupportedPrompt(block.type);
      default:
        return unsupportedPrompt(String((block as { type?: unknown }).type ?? "unknown"));
    }
  });
}

function unsupportedPrompt(type: string): never {
  throw RequestError.invalidParams(
    { contentType: type },
    "The selected DSH runtime does not support this prompt content type",
  );
}

export function mapRuntimeContent(block: RuntimeContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "resource": {
      if (block.text !== undefined && block.blob !== undefined) {
        return invalidRuntimeContent(block.type, "both text and blob are set");
      }
      if (block.text !== undefined) {
        return {
          type: "resource",
          resource: {
            uri: block.uri,
            text: block.text,
            ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
          },
        };
      }
      if (block.blob !== undefined) {
        return {
          type: "resource",
          resource: {
            uri: block.uri,
            blob: block.blob,
            ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
          },
        };
      }
      return invalidRuntimeContent(block.type, "neither text nor blob is set");
    }
    case "resource_link":
      return {
        type: "resource_link",
        uri: block.uri,
        name: block.name ?? block.uri,
        ...(block.description === undefined ? {} : { description: block.description }),
        ...(block.mimeType === undefined ? {} : { mimeType: block.mimeType }),
        ...(block.size === undefined ? {} : { size: block.size }),
      };
  }
}

function invalidRuntimeContent(type: string, reason: string): never {
  throw RequestError.internalError(
    { code: "INVALID_RUNTIME_EVENT", contentType: type },
    `DSH emitted invalid ${type} content: ${reason}`,
  );
}

export function mapToolContent(content: RuntimeToolContent): ToolCallContent {
  switch (content.type) {
    case "content":
      if (content.content === undefined) {
        return invalidRuntimeToolContent(content.type);
      }
      return {
        type: "content",
        content: mapRuntimeContent(content.content),
        ...meta(content._meta),
      };
    case "diff":
      if (content.path === undefined || content.newText === undefined) {
        return invalidRuntimeToolContent(content.type);
      }
      return {
        type: "diff",
        path: content.path,
        newText: content.newText,
        ...(content.oldText === undefined ? {} : { oldText: content.oldText }),
        ...meta(content._meta),
      };
    case "terminal":
      if (content.terminalId === undefined) {
        return invalidRuntimeToolContent(content.type);
      }
      return {
        type: "terminal",
        terminalId: content.terminalId,
        ...meta(content._meta),
      };
  }
}

function invalidRuntimeToolContent(type: string): never {
  throw RequestError.internalError(
    { code: "INVALID_RUNTIME_EVENT", toolContentType: type },
    "DSH emitted an incomplete tool result",
  );
}

export interface EventMappingState {
  readonly emittedToolCalls: Set<string>;
  readonly terminalStates: Map<string, "open" | "closed">;
  readonly clientCapabilities: ClientCapabilities;
}

export function mapRuntimeEvent(event: RuntimeEvent, state: EventMappingState): SessionUpdate {
  switch (event.type) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return {
        sessionUpdate: event.type,
        content: mapRuntimeContent(event.content),
        ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
      };
    case "tool_call":
      if (state.emittedToolCalls.has(event.toolCallId)) {
        return {
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          title: event.title,
          kind: event.kind,
          status: event.status,
          ...(event.locations === undefined
            ? {}
            : { locations: event.locations.map(mapLocation) }),
          ...(event.rawInput === undefined ? {} : { rawInput: event.rawInput }),
          ...meta(event._meta),
        };
      }
      state.emittedToolCalls.add(event.toolCallId);
      return {
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        title: event.title,
        kind: event.kind,
        status: event.status,
        ...(event.locations === undefined
          ? {}
          : { locations: event.locations.map(mapLocation) }),
        ...(event.rawInput === undefined ? {} : { rawInput: event.rawInput }),
        ...meta(event._meta),
      };
    case "tool_call_update":
      state.emittedToolCalls.add(event.toolCallId);
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        ...(event.title === undefined ? {} : { title: event.title }),
        ...(event.kind === undefined ? {} : { kind: event.kind }),
        ...(event.status === undefined ? {} : { status: event.status }),
        ...(event.locations === undefined
          ? {}
          : { locations: event.locations.map(mapLocation) }),
        ...(event.content === undefined
          ? {}
          : { content: event.content.map(mapToolContent) }),
        ...(event.rawInput === undefined ? {} : { rawInput: event.rawInput }),
        ...(event.rawOutput === undefined ? {} : { rawOutput: event.rawOutput }),
        ...meta(event._meta),
      };
    case "plan":
      return { sessionUpdate: "plan", entries: event.entries.map((entry) => ({ ...entry })) };
    case "plan_update":
      if (state.clientCapabilities.plan != null) {
        return {
          sessionUpdate: "plan_update",
          plan: {
            type: "items",
            planId: "dsh-plan",
            entries: event.entries.map((entry) => ({ ...entry })),
          },
        };
      }
      return { sessionUpdate: "plan", entries: event.entries.map((entry) => ({ ...entry })) };
    case "available_commands_update":
      return {
        sessionUpdate: "available_commands_update",
        availableCommands: event.commands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.inputHint === undefined
            ? {}
            : { input: { hint: command.inputHint } }),
        })),
      };
    case "current_mode_update":
      return { sessionUpdate: "current_mode_update", currentModeId: event.modeId };
    case "config_option_update":
      return {
        sessionUpdate: "config_option_update",
        configOptions: mapConfigOptions(event.options),
      };
    case "session_info_update":
      return {
        sessionUpdate: "session_info_update",
        ...(event.title === undefined ? {} : { title: event.title }),
        ...(event.updatedAt === undefined ? {} : { updatedAt: event.updatedAt }),
      };
    case "usage_update":
      return {
        sessionUpdate: "usage_update",
        used: (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
        size: event.contextWindow ?? 0,
        ...(event.costUsd === undefined
          ? {}
          : { cost: { amount: event.costUsd, currency: "USD" } }),
        ...meta(event._meta),
      };
    case "terminal_info": {
      const toolCallId = terminalToolCallId(event.terminalId);
      const first = !state.emittedToolCalls.has(toolCallId);
      state.emittedToolCalls.add(toolCallId);
      const terminalState = state.terminalStates.get(toolCallId);
      if (!first) {
        return {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: event.title ?? "Terminal",
          kind: "execute",
          ...(terminalState === "closed" ? {} : { status: "in_progress" as const }),
          _meta: { ...(event._meta ?? {}), dshTerminalId: event.terminalId },
        };
      }
      state.terminalStates.set(toolCallId, "open");
      return {
        sessionUpdate: "tool_call",
        toolCallId,
        title: event.title ?? "Terminal",
        kind: "execute",
        status: "in_progress",
        _meta: { ...(event._meta ?? {}), dshTerminalId: event.terminalId },
      };
    }
    case "terminal_output": {
      const toolCallId = terminalToolCallId(event.terminalId);
      const first = !state.emittedToolCalls.has(toolCallId);
      state.emittedToolCalls.add(toolCallId);
      if (state.terminalStates.get(toolCallId) !== "closed") {
        state.terminalStates.set(toolCallId, "open");
      }
      if (first) {
        return {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Terminal",
          kind: "execute",
          status: "in_progress",
          content: [{ type: "content", content: { type: "text", text: event.data } }],
          _meta: { dshTerminalId: event.terminalId, terminalStreamChunk: true },
        };
      }
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: [{ type: "content", content: { type: "text", text: event.data } }],
        _meta: { dshTerminalId: event.terminalId, terminalStreamChunk: true },
      };
    }
    case "terminal_exit": {
      const toolCallId = terminalToolCallId(event.terminalId);
      const first = !state.emittedToolCalls.has(toolCallId);
      state.emittedToolCalls.add(toolCallId);
      state.terminalStates.set(toolCallId, "closed");
      const status = event.exitCode === 0 && event.signal === undefined
        ? "completed" as const
        : "failed" as const;
      const rawOutput = {
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        ...(event.signal === undefined ? {} : { signal: event.signal }),
      };
      if (first) {
        return {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Terminal",
          kind: "execute",
          status,
          rawOutput,
          _meta: { dshTerminalId: event.terminalId },
        };
      }
      return {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
        rawOutput,
        _meta: { dshTerminalId: event.terminalId },
      };
    }
    case "subagent_activity": {
      const first = !state.emittedToolCalls.has(event.toolCallId);
      state.emittedToolCalls.add(event.toolCallId);
      if (first) {
        return {
          sessionUpdate: "tool_call",
          toolCallId: event.toolCallId,
          title: "Subagent activity",
          kind: "think",
          status: event.status,
          ...(event.content === undefined
            ? {}
            : { content: [{ type: "content", content: mapRuntimeContent(event.content) }] }),
          ...meta(event._meta),
        };
      }
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: event.status,
        ...(event.content === undefined
          ? {}
          : { content: [{ type: "content", content: mapRuntimeContent(event.content) }] }),
        ...meta(event._meta),
      };
    }
  }
}

function terminalToolCallId(terminalId: string): string {
  return `dsh-terminal:${terminalId}`;
}

function mapLocation(location: { readonly path: string; readonly line?: number }) {
  return {
    path: location.path,
    ...(location.line === undefined ? {} : { line: location.line }),
  };
}

export function mapModes(
  modes: readonly RuntimeMode[] | undefined,
  currentModeId: string | undefined,
): SessionModeState | undefined {
  if (modes === undefined || modes.length === 0) {
    return undefined;
  }
  if (currentModeId === undefined || !modes.some((mode) => mode.id === currentModeId)) {
    throw RequestError.internalError(
      { code: "INVALID_RUNTIME_SESSION" },
      "DSH returned modes without a valid current mode",
    );
  }
  return {
    currentModeId,
    availableModes: modes.map((mode) => ({
      id: mode.id,
      name: mode.name,
      ...(mode.description === undefined ? {} : { description: mode.description }),
    })),
  };
}

export function mapConfigOptions(options: readonly RuntimeConfigOption[]): SessionConfigOption[] {
  return options.map((option) => {
    const shared = {
      id: option.id,
      name: option.name,
      ...(option.description === undefined ? {} : { description: option.description }),
    };
    if (option.kind === "boolean") {
      if (typeof option.currentValue !== "boolean") {
        return invalidConfigOption(option.id);
      }
      return { ...shared, type: "boolean", currentValue: option.currentValue };
    }
    if (typeof option.currentValue !== "string" || option.options === undefined) {
      return invalidConfigOption(option.id);
    }
    return {
      ...shared,
      type: "select",
      currentValue: option.currentValue,
      options: option.options.map((value) => ({ ...value })),
    };
  });
}

function invalidConfigOption(id: string): never {
  throw RequestError.internalError(
    { code: "INVALID_RUNTIME_SESSION", configId: id },
    "DSH returned an invalid session configuration option",
  );
}

export function mapSessionInfo(descriptor: RuntimeSessionDescriptor): SessionInfo {
  return {
    sessionId: descriptor.id,
    cwd: descriptor.cwd,
    ...(descriptor.title === undefined ? {} : { title: descriptor.title }),
    ...(descriptor.updatedAt === undefined ? {} : { updatedAt: descriptor.updatedAt }),
    ...meta(descriptor._meta),
  };
}

export function mapUsage(event: Extract<RuntimeEvent, { type: "usage_update" }>): Usage {
  const inputTokens = event.inputTokens ?? 0;
  const outputTokens = event.outputTokens ?? 0;
  const cachedReadTokens = event.cachedInputTokens ?? 0;
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedReadTokens,
    ...meta(event._meta),
  };
}

function meta(value: Record<string, unknown> | undefined): { _meta?: Record<string, unknown> } {
  return value === undefined ? {} : { _meta: value };
}
