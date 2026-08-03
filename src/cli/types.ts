import type { Readable, Writable } from "node:stream";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface RuntimeSelectionOptions {
  readonly dshPath?: string;
  readonly dshHome?: string;
}

export interface ServeOptions extends RuntimeSelectionOptions {
  readonly nodePath?: string;
  readonly expectedRuntimeFingerprint?: string;
}

export interface InspectOptions extends RuntimeSelectionOptions {}

export interface DoctorOptions extends RuntimeSelectionOptions {}

export interface CliStreams {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
}

/**
 * The CLI depends only on this narrow facade. Production bindings may use the
 * ACP app, runtime factory, and discovery modules, while tests can prove routing
 * and stream isolation without starting a real DSH runtime.
 */
export interface CliServices {
  readonly programName: string;
  readonly version: string;
  serve(options: ServeOptions, streams: CliStreams): Promise<void>;
  inspect(options: InspectOptions): Promise<JsonValue>;
  doctor(options: DoctorOptions): Promise<JsonValue>;
}
