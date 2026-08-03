import type {
  Dsh001Host,
  DshApprovalOutcome,
  DshHostAgent,
  DshHostAgentHandle,
  DshHostApprovalRequest,
  DshHostEvent,
  DshHostSession,
} from "../../src/runtime/drivers/dsh-0.0.1/index.js";
import type {
  DshHostSessionHeader,
  DshHostSessionRecord,
  DshHostSessionSnapshot,
  DshHostSessionTitle,
} from "../../src/runtime/drivers/dsh-0.0.1/host.js";
import type { RuntimeMcpServer } from "../../src/runtime/types.js";

type SessionListener = (session: DshHostSession, event: DshHostEvent) => void;
type StatusListener = (agent: DshHostAgent, status: string) => void;
type ApprovalListener = (
  request: DshHostApprovalRequest,
  next: () => Promise<DshApprovalOutcome>,
) => Promise<DshApprovalOutcome>;

export class FakeAgent implements DshHostAgent {
  readonly session: {
    readonly id: string;
    readonly header: DshHostSessionHeader;
    readonly events: DshHostEvent[];
  };
  status = "idle";
  cancelCalls = 0;
  cancelFailuresRemaining = 0;
  followups: unknown[] = [];
  disposed = false;

  constructor(
    readonly id: string,
    header: DshHostSessionHeader,
    events: readonly DshHostEvent[],
    private readonly host: FakeDshHost,
  ) {
    this.session = { id, header, events: [...structuredClone(events)] };
  }

  followup(message: unknown): void {
    this.followups.push(message);
    this.status = "running";
    this.host.emitStatus(this, "running");
  }

  cancel(_cause: { readonly kind: "user" }): void {
    this.cancelCalls += 1;
    if (this.cancelFailuresRemaining > 0) {
      this.cancelFailuresRemaining -= 1;
      throw new Error("transient agent cancel failure");
    }
    this.status = "idle";
    this.host.emitStatus(this, "idle");
  }

  whenIdle(): Promise<void> {
    return Promise.resolve();
  }

  steer(_message: unknown): { readonly outcome: Promise<{ readonly status: "admitted" }> } {
    return { outcome: Promise.resolve({ status: "admitted" }) };
  }
}

export class FakeDshHost implements Dsh001Host {
  readonly route = { provider: "fixture-provider", model: "fixture-model" };
  readonly cwd: string;
  readonly agents: FakeAgent[] = [];
  readonly createInputs: {
    readonly id: string;
    readonly cwd: string;
    readonly mcpServers: readonly RuntimeMcpServer[];
    readonly signal: AbortSignal;
    readonly seed?: readonly DshHostEvent[];
    readonly parentSession?: string;
  }[] = [];
  readonly resumeInputs: {
    readonly id: string;
    readonly cwd: string;
    readonly mcpServers: readonly RuntimeMcpServer[];
    readonly signal: AbortSignal;
  }[] = [];
  readonly lifecycle: string[] = [];
  closed = false;
  disposeFailuresRemaining = 0;
  descendantDrainFailuresRemaining = 0;
  closeFailuresRemaining = 0;
  private readonly live = new Map<string, FakeAgent>();
  private readonly stored = new Map<string, DshHostSessionSnapshot>();
  private readonly titles = new Map<string, DshHostSessionTitle>();
  private clock = 1_700_000_000_000;
  private readonly sessionListeners: SessionListener[] = [];
  private readonly statusListeners: StatusListener[] = [];
  private readonly approvalListeners: ApprovalListener[] = [];

  constructor(cwd = process.cwd(), private readonly failListener?: "session" | "status" | "approval") {
    this.cwd = cwd;
  }

  async createAgent(input: {
    readonly id: string;
    readonly cwd: string;
    readonly mcpServers: readonly RuntimeMcpServer[];
    readonly signal: AbortSignal;
    readonly seed?: readonly DshHostEvent[];
    readonly parentSession?: string;
  }): Promise<DshHostAgentHandle> {
    if (input.signal.aborted) throw new Error("cancelled");
    if (this.live.has(input.id) || this.stored.has(input.id)) throw new Error("already exists");
    this.createInputs.push(input);
    const events = [...structuredClone(input.seed ?? [])];
    if (input.seed !== undefined && events.at(-1)?.type !== "session/end-seed") {
      events.push({
        type: "session/end-seed",
        seq: events.length,
        time: events.at(-1)?.time ?? this.clock,
        data: {},
      });
    }
    const header: DshHostSessionHeader = {
      version: 0,
      id: input.id,
      createdAt: this.clock++,
      cwd: input.cwd,
      ...(input.parentSession === undefined ? {} : {
        parentSession: input.parentSession,
        seedLength: input.seed?.length ?? 0,
      }),
    };
    const agent = new FakeAgent(input.id, header, events, this);
    this.agents.push(agent);
    this.live.set(agent.id, agent);
    this.stored.set(agent.id, { session: structuredClone(header), events: structuredClone(events) });
    this.lifecycle.push(`create:${agent.id}`);
    return this.handle(agent);
  }

  async resumeAgent(input: {
    readonly id: string;
    readonly cwd: string;
    readonly mcpServers: readonly RuntimeMcpServer[];
    readonly signal: AbortSignal;
  }): Promise<DshHostAgentHandle> {
    if (input.signal.aborted) throw new Error("cancelled");
    if (this.live.has(input.id)) throw new Error("already live");
    const snapshot = this.stored.get(input.id);
    if (snapshot === undefined) throw new Error("not found");
    this.resumeInputs.push(input);
    const events = [...structuredClone(snapshot.events)];
    if (events.at(-1)?.type !== "session/end-seed") {
      events.push({
        type: "session/end-seed",
        seq: events.length,
        time: events.at(-1)?.time ?? snapshot.session.createdAt,
        data: {},
      });
    }
    const agent = new FakeAgent(input.id, structuredClone(snapshot.session), events, this);
    this.agents.push(agent);
    this.live.set(agent.id, agent);
    this.stored.set(agent.id, { session: structuredClone(snapshot.session), events: structuredClone(events) });
    this.lifecycle.push(`resume:${agent.id}`);
    return this.handle(agent);
  }

  readSession(id: string, signal: AbortSignal): Promise<DshHostSessionSnapshot> {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    const live = this.live.get(id);
    if (live !== undefined) {
      return Promise.resolve({
        session: structuredClone(live.session.header),
        events: structuredClone(live.session.events),
      });
    }
    const snapshot = this.stored.get(id);
    return snapshot === undefined
      ? Promise.reject(new Error("not found"))
      : Promise.resolve(structuredClone(snapshot));
  }

  listSessions(signal: AbortSignal): Promise<readonly DshHostSessionRecord[]> {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    return Promise.resolve([...this.stored.values()]
      .map((snapshot): DshHostSessionRecord => ({
        header: structuredClone(snapshot.session),
        live: this.live.has(snapshot.session.id),
        persisted: true,
      }))
      .sort((left, right) => right.header.createdAt - left.header.createdAt
        || (left.header.id < right.header.id ? -1 : left.header.id > right.header.id ? 1 : 0)));
  }

  readTitle(id: string, signal: AbortSignal): Promise<DshHostSessionTitle | undefined> {
    if (signal.aborted) return Promise.reject(new Error("cancelled"));
    return Promise.resolve(structuredClone(this.titles.get(id)));
  }

  seedSession(
    snapshot: DshHostSessionSnapshot,
    title?: DshHostSessionTitle,
  ): void {
    this.stored.set(snapshot.session.id, structuredClone(snapshot));
    if (title !== undefined) this.titles.set(snapshot.session.id, structuredClone(title));
  }

  setTitle(id: string, title: DshHostSessionTitle): void {
    this.titles.set(id, structuredClone(title));
  }

  isAgentLive(agent: DshHostAgent): boolean {
    return this.live.get(agent.id) === agent;
  }

  createUserMessage(text: string): unknown {
    return { role: "user", content: [{ type: "text", text }] };
  }

  onSessionEvent(listener: SessionListener): () => void {
    if (this.failListener === "session") throw new Error("session listener failed");
    this.sessionListeners.push(listener);
    return () => {
      this.lifecycle.push("listener-dispose:session");
      this.remove(this.sessionListeners, listener);
    };
  }

  onAgentStatus(listener: StatusListener): () => void {
    if (this.failListener === "status") throw new Error("status listener failed");
    this.statusListeners.push(listener);
    return () => {
      this.lifecycle.push("listener-dispose:status");
      this.remove(this.statusListeners, listener);
    };
  }

  onApproval(listener: ApprovalListener): () => void {
    if (this.failListener === "approval") throw new Error("approval listener failed");
    this.approvalListeners.push(listener);
    return () => {
      this.lifecycle.push("listener-dispose:approval");
      this.remove(this.approvalListeners, listener);
    };
  }

  async drainContinuableDescendants(agents: readonly DshHostAgent[]): Promise<void> {
    for (const agent of agents) {
      this.lifecycle.push(`drain:${agent.id}`);
      if (!this.isAgentLive(agent)) throw new Error("descendant drain root is not live");
    }
    if (this.descendantDrainFailuresRemaining > 0) {
      this.descendantDrainFailuresRemaining -= 1;
      throw new Error("transient descendant drain failure");
    }
  }

  close(): Promise<void> {
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      this.lifecycle.push("host-close-failed");
      return Promise.reject(new Error("transient host close failure"));
    }
    this.closed = true;
    this.lifecycle.push("host-close");
    return Promise.resolve();
  }

  emitSession(agent: FakeAgent, event: DshHostEvent): void {
    if (event.seq === agent.session.events.length && event.time !== undefined) {
      agent.session.events.push(structuredClone(event));
      this.stored.set(agent.id, {
        session: structuredClone(agent.session.header),
        events: structuredClone(agent.session.events),
      });
    }
    for (const listener of [...this.sessionListeners]) listener(agent.session, event);
  }

  emitStatus(agent: FakeAgent, status: string): void {
    for (const listener of [...this.statusListeners]) listener(agent, status);
  }

  async requestApproval(request: DshHostApprovalRequest): Promise<DshApprovalOutcome> {
    const listener = this.approvalListeners[0];
    return listener === undefined ? "unavailable" : await listener(request, () => Promise.resolve("unavailable"));
  }

  private handle(agent: FakeAgent): DshHostAgentHandle {
    return {
      agent,
      dispose: async () => {
        if (this.disposeFailuresRemaining > 0) {
          this.disposeFailuresRemaining -= 1;
          this.lifecycle.push(`dispose-failed:${agent.id}`);
          throw new Error("transient disposal failure");
        }
        agent.disposed = true;
        this.live.delete(agent.id);
        this.lifecycle.push(`dispose:${agent.id}`);
      },
    };
  }

  private remove<T>(values: T[], value: T): void {
    const index = values.indexOf(value);
    if (index >= 0) values.splice(index, 1);
  }
}
