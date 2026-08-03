import {
  RequestError,
  agent,
  methods,
  type AgentApp,
  type AgentContext,
  type ContentBlock,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { DshRuntimeDriver } from "../runtime/types.js";
import { DshAcpAgent } from "./agent.js";
import {
  AgentContextClient,
  DSH_STEERING_METHOD,
  type DshAcpAgentOptions,
  type DshSteeringRequest,
  type DshSteeringResponse,
} from "./types.js";

type SharedAgentOptions = Omit<DshAcpAgentOptions, "driver">;

/**
 * A driver factory is required when one app can accept multiple connections.
 * Passing a concrete driver remains supported for the single-connection stdio
 * entrypoint, but that app intentionally rejects a second connection.
 */
export type DshAcpAppOptions = SharedAgentOptions & (
  | {
      readonly createDriver: () => DshRuntimeDriver | Promise<DshRuntimeDriver>;
      readonly driver?: never;
    }
  | {
      readonly driver: DshRuntimeDriver;
      readonly createDriver?: never;
    }
);

export type DshAcpApp = AgentApp & {
  /** Present only for the legacy, single-connection concrete-driver form. */
  readonly dshAgent?: DshAcpAgent;
  readonly activeAgents: ReadonlySet<DshAcpAgent>;
  completeElicitation(elicitationId: string): Promise<boolean>;
  /** Retry teardown retained from closed connections until ownership is empty. */
  retryCleanup(): Promise<void>;
};

interface ConnectionRecord {
  readonly core: Promise<DshAcpAgent>;
  closed: boolean;
  closePromise: Promise<void> | undefined;
  cleanupRun: Promise<void> | undefined;
}

const steeringParams = {
  parse(value: unknown): DshSteeringRequest {
    const parsed = z.object({
      sessionId: z.string().min(1),
      prompt: z.array(z.unknown()),
      _meta: z.record(z.string(), z.unknown()).nullable().optional(),
    }).parse(value);
    return {
      sessionId: parsed.sessionId,
      prompt: parsed.prompt as ContentBlock[],
      ...(parsed._meta === undefined ? {} : { _meta: parsed._meta }),
    };
  },
};

export function createDshAcpAgent(options: DshAcpAgentOptions): DshAcpAgent {
  return new DshAcpAgent(options);
}

export function createDshAcpApp(options: DshAcpAppOptions): DshAcpApp {
  const app = agent({ name: options.name ?? "dsh-acp" });
  const records = new WeakMap<object, ConnectionRecord>();
  const activeAgents = new Set<DshAcpAgent>();
  const retainedCleanup = new Set<ConnectionRecord>();
  const { createCore, legacyCore } = coreFactory(options);

  const coreFor = async (context: AgentContext): Promise<DshAcpAgent> => {
    const record = records.get(connectionScope(context));
    if (record === undefined || record.closed) {
      throw RequestError.internalError(
        { code: "ACP_CONNECTION_SCOPE_MISSING" },
        "The ACP connection does not have an active DSH runtime",
      );
    }
    return record.core;
  };

  const closeAttempt = (record: ConnectionRecord): Promise<void> => {
    if (record.closePromise === undefined) {
      const attempt = record.core.then(async (core) => {
        activeAgents.delete(core);
        await core.close();
      }, () => undefined).then(() => {
        retainedCleanup.delete(record);
      });
      record.closePromise = attempt;
    }
    return record.closePromise;
  };

  const runCleanup = async (record: ConnectionRecord): Promise<void> => {
    let lastFailure: unknown;
    for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1) {
      const attempt = closeAttempt(record);
      try {
        await attempt;
        return;
      } catch (error) {
        lastFailure = error;
        if (record.closePromise === attempt) record.closePromise = undefined;
      }
    }
    throw lastFailure;
  };

  const closeRecord = (record: ConnectionRecord): Promise<void> => {
    if (record.cleanupRun === undefined) {
      let tracked!: Promise<void>;
      tracked = runCleanup(record).catch((error: unknown) => {
        if (record.cleanupRun === tracked) record.cleanupRun = undefined;
        throw error;
      });
      record.cleanupRun = tracked;
    }
    return record.cleanupRun;
  };

  app.onConnect((connection) => {
    const key = connectionScope(connection.client);
    const record: ConnectionRecord = {
      core: Promise.resolve().then(createCore),
      closed: false,
      closePromise: undefined,
      cleanupRun: undefined,
    };
    records.set(key, record);
    void record.core.then(async (core) => {
      if (record.closed) {
        await closeRecord(record);
        return;
      }
      activeAgents.add(core);
    }).catch(() => undefined);
    void connection.closed.then(async () => {
      record.closed = true;
      records.delete(key);
      retainedCleanup.add(record);
      void record.core.then(core => activeAgents.delete(core), () => undefined);
      await closeRecord(record).catch(() => undefined);
    });
    // A rejected factory closes this exact SDK connection via onConnect's
    // promise handling; other connection records remain unaffected.
    return record.core.then(() => undefined);
  });

  app.onRequest(methods.agent.initialize, async (context) =>
    (await coreFor(context.client)).initialize(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.authenticate, async (context) =>
    (await coreFor(context.client)).authenticate(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.logout, async (context) =>
    (await coreFor(context.client)).logout(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.providers.list, async (context) =>
    (await coreFor(context.client)).listProviders(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.providers.set, async (context) =>
    (await coreFor(context.client)).setProvider(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.providers.disable, async (context) =>
    (await coreFor(context.client)).disableProvider(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );

  app.onRequest(methods.agent.session.new, async (context) =>
    (await coreFor(context.client)).newSession(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.load, async (context) =>
    (await coreFor(context.client)).loadSession(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.resume, async (context) =>
    (await coreFor(context.client)).resumeSession(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.fork, async (context) =>
    (await coreFor(context.client)).forkSession(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.list, async (context) =>
    (await coreFor(context.client)).listSessions(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.close, async (context) =>
    (await coreFor(context.client)).closeSession(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.delete, async (context) =>
    (await coreFor(context.client)).deleteSession(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.setMode, async (context) =>
    (await coreFor(context.client)).setSessionMode(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.setConfigOption, async (context) =>
    (await coreFor(context.client)).setSessionConfigOption(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onRequest(methods.agent.session.prompt, async (context) =>
    (await coreFor(context.client)).prompt(
      context.params,
      new AgentContextClient(context.client),
      context.signal,
    ),
  );
  app.onNotification(methods.agent.session.cancel, (context) => {
    void coreFor(context.client)
      .then((core) => core.cancel(context.params))
      .catch(() => undefined);
  });
  app.onRequest<DshSteeringRequest, DshSteeringResponse>(
    DSH_STEERING_METHOD,
    steeringParams,
    async (context) =>
      (await coreFor(context.client)).steer(
        context.params,
        new AgentContextClient(context.client),
        context.signal,
      ),
  );

  const completeElicitation = async (elicitationId: string): Promise<boolean> => {
    for (const core of activeAgents) {
      if (await core.completeElicitation(elicitationId)) {
        return true;
      }
    }
    return false;
  };

  const retryCleanup = async (): Promise<void> => {
    const outcomes = await Promise.allSettled([...retainedCleanup].map(async (record) => {
      // If automatic connection-close cleanup is still running, observe it
      // first. An explicit retry then starts a fresh bounded batch after a
      // failed automatic batch instead of merely echoing that old failure.
      const current = record.cleanupRun;
      if (current !== undefined) await current.catch(() => undefined);
      if (retainedCleanup.has(record)) await closeRecord(record);
    }));
    const failures = outcomes.flatMap(outcome =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : []);
    if (failures.length > 0 || retainedCleanup.size > 0) {
      throw new AggregateError(failures, "failed to clean up one or more closed ACP connections");
    }
  };

  return Object.assign(app, {
    ...(legacyCore === undefined ? {} : { dshAgent: legacyCore }),
    activeAgents,
    completeElicitation,
    retryCleanup,
  });
}

function coreFactory(options: DshAcpAppOptions): {
  readonly createCore: () => DshAcpAgent | Promise<DshAcpAgent>;
  readonly legacyCore?: DshAcpAgent;
} {
  if (options.createDriver !== undefined) {
    return {
      createCore: async () => createDshAcpAgent(
        agentOptions(options, await options.createDriver()),
      ),
    };
  }

  const legacyCore = createDshAcpAgent(agentOptions(options, options.driver));
  let claimed = false;
  return {
    legacyCore,
    createCore: () => {
      if (claimed) {
        throw new Error(
          "A concrete DSH driver can serve only one ACP connection; use createDriver for multiple connections",
        );
      }
      claimed = true;
      return legacyCore;
    },
  };
}

function agentOptions(
  options: SharedAgentOptions,
  driver: DshRuntimeDriver,
): DshAcpAgentOptions {
  return {
    driver,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.cancelDrainTimeoutMs === undefined
      ? {}
      : { cancelDrainTimeoutMs: options.cancelDrainTimeoutMs }),
    ...(options.elicitationCompletion === undefined
      ? {}
      : { elicitationCompletion: options.elicitationCompletion }),
    ...(options.terminalAuthCommand === undefined
      ? {}
      : { terminalAuthCommand: options.terminalAuthCommand }),
  };
}

/**
 * SDK 1.3.0 exposes the underlying per-connection context through this
 * @internal getter. Request handlers receive a fresh AgentContext each time,
 * so this pinned seam is the stable identity shared with onConnect.
 */
function connectionScope(context: AgentContext): object {
  const internal = context as unknown as { readonly connectionContext?: unknown };
  const key = internal.connectionContext;
  if ((typeof key !== "object" && typeof key !== "function") || key === null) {
    throw new Error("ACP SDK connection context is unavailable");
  }
  return key as object;
}
