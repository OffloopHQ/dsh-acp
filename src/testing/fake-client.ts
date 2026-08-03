import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ReadTextFileRequest,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type { DshAcpClient } from "../acp/types.js";

export class FakeAcpClient implements DshAcpClient {
  readonly updates: SessionNotification[] = [];
  readonly permissionRequests: RequestPermissionRequest[] = [];
  readonly elicitationRequests: CreateElicitationRequest[] = [];
  readonly completedElicitations: string[] = [];
  readonly readRequests: ReadTextFileRequest[] = [];
  readonly writeRequests: WriteTextFileRequest[] = [];
  readonly files = new Map<string, string>();
  permissionHandler: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse> = async () => ({
    outcome: { outcome: "cancelled" },
  });
  elicitationHandler: (
    request: CreateElicitationRequest,
    signal: AbortSignal,
  ) => Promise<CreateElicitationResponse> = async () => ({ action: "cancel" });
  updateHandler: (notification: SessionNotification) => Promise<void> = async () => undefined;

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.updates.push(params);
    await this.updateHandler(params);
  }

  async requestPermission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    this.permissionRequests.push(params);
    return this.permissionHandler(params, signal);
  }

  async createElicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    this.elicitationRequests.push(params);
    return this.elicitationHandler(params, signal);
  }

  async completeElicitation(elicitationId: string): Promise<void> {
    this.completedElicitations.push(elicitationId);
  }

  async readTextFile(params: ReadTextFileRequest, _signal: AbortSignal): Promise<string> {
    this.readRequests.push(params);
    return this.files.get(params.path) ?? "";
  }

  async writeTextFile(params: WriteTextFileRequest, _signal: AbortSignal): Promise<void> {
    this.writeRequests.push(params);
    this.files.set(params.path, params.content);
  }
}
