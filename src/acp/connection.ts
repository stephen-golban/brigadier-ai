/**
 * JSON-RPC 2.0 over a `LineChannel`, in both directions.
 *
 * ACP is bidirectional and that is not a detail: the agent issues requests back
 * at the client — `session/request_permission`, `fs/read_text_file`,
 * `fs/write_text_file` — and a client that only sends requests will hang the
 * moment an agent asks for permission. This module owns both directions so
 * nothing above it has to think about correlation.
 */

import type { LineChannel } from "./channel.ts";

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Thrown when the far side answers a request with an error object. */
export class RpcFailure extends Error {
  constructor(
    readonly method: string,
    readonly rpc: RpcError,
  ) {
    super(`${method}: ${rpc.code} ${rpc.message}`);
    this.name = "RpcFailure";
  }
}

/** A request from the agent to us. Return a result, or throw to answer with an error. */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export interface ConnectionOptions {
  /** Answers agent→client requests. Unhandled methods should throw `MethodNotFound`. */
  onRequest: RequestHandler;
  /** Receives agent→client notifications, chiefly `session/update`. */
  onNotification: NotificationHandler;
  /** Called with every frame in both directions. For transcripts and probes. */
  onFrame?: (direction: "out" | "in", raw: string) => void;
}

export const METHOD_NOT_FOUND = -32601;

export class MethodNotFound extends Error {
  constructor(readonly method: string) {
    super(`not implemented: ${method}`);
    this.name = "MethodNotFound";
  }
}

export class Connection {
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
  #closed = false;
  #pump: Promise<void>;

  constructor(
    private readonly channel: LineChannel,
    private readonly options: ConnectionOptions,
  ) {
    this.#pump = this.#readLoop();
  }

  /**
   * Send a request and wait for its response.
   *
   * Rejects with `RpcFailure` if the agent answers with an error, or a plain
   * `Error` if the connection closes first — a distinction that matters,
   * because #25 measured that every agent completes `initialize` while
   * unauthenticated and fails one step later at `session/new` with an
   * actionable message. That message is the remedy, so it must survive.
   */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`connection closed before ${method}`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const [, pending] of this.#pending) {
      pending.reject(new Error(`connection closed during ${pending.method}`));
    }
    this.#pending.clear();
    await this.channel.close();
    await this.#pump;
  }

  diagnostics(): string {
    return this.channel.diagnostics();
  }

  #write(message: unknown): void {
    const raw = JSON.stringify(message);
    this.options.onFrame?.("out", raw);
    this.channel.send(raw);
  }

  async #readLoop(): Promise<void> {
    for await (const line of this.channel.lines()) {
      this.options.onFrame?.("in", line);

      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A non-JSON line is the agent writing to the wrong stream. Not fatal:
        // several agents emit banners before speaking protocol.
        continue;
      }

      const id = message["id"] as number | undefined;
      const method = message["method"] as string | undefined;

      if (id !== undefined && method === undefined) {
        this.#settle(id, message);
      } else if (id !== undefined && method !== undefined) {
        void this.#serve(id, method, message["params"]);
      } else if (method !== undefined) {
        this.options.onNotification(method, message["params"]);
      }
    }

    // The channel ended. Anything still waiting will never be answered.
    for (const [, pending] of this.#pending) {
      pending.reject(new Error(`agent closed the connection during ${pending.method}`));
    }
    this.#pending.clear();
  }

  #settle(id: number, message: Record<string, unknown>): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    const error = message["error"] as RpcError | undefined;
    if (error) pending.reject(new RpcFailure(pending.method, error));
    else pending.resolve(message["result"]);
  }

  async #serve(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.options.onRequest(method, params);
      this.#write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const code = error instanceof MethodNotFound ? METHOD_NOT_FOUND : -32000;
      const message = error instanceof Error ? error.message : String(error);
      this.#write({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }
}
