// SPDX-License-Identifier: Apache-2.0
/**
 * A duplex channel of newline-delimited text, and the process adapter that
 * satisfies it.
 *
 * This is an INTERNAL seam. Callers of `Worker` never see it; it exists so the
 * JSON-RPC layer above can be driven in-memory by tests without spawning a
 * child process, and so a recording adapter can sit in the middle.
 *
 * ACP framing is one JSON object per line. That is the whole protocol at this
 * level — there is no Content-Length header as in LSP.
 */

/** Everything a caller must know to use a channel correctly. */
export interface LineChannel {
  /** Write one line. Appends the newline itself; the line must not contain one. */
  send(line: string): void;
  /**
   * Every line received, in order, until the channel closes. Iterating twice is
   * not supported — there is exactly one consumer.
   */
  lines(): AsyncIterable<string>;
  /** Whatever the far side wrote to its error stream. Diagnostics only. */
  diagnostics(): string;
  /** Idempotent. Safe to call while `lines()` is being iterated. */
  close(): Promise<void>;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

/**
 * Spawn a process and speak newline-delimited text to it.
 *
 * POSIX detail that is not incidental: the child is spawned in its own process
 * group so the whole tree can be signalled. Ticket #43 measured that
 * `Bun.spawn().kill()` leaks grandchildren on macOS and Linux while Windows
 * gets a job object for free — and that the job object permits breakaway, so
 * neither platform's primitive is a guarantee. Ruling 38 makes the reclamation
 * sweep the actual containment boundary; this is only the fast path.
 */
export function spawnChannel(
  command: string,
  args: string[],
  options: SpawnOptions,
): LineChannel {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const errorChunks: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
        errorChunks.push(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // The stream tears down with the process; that is the normal exit path.
    }
  })();

  let closed = false;

  return {
    send(line) {
      if (closed) return;
      child.stdin.write(`${line}\n`);
      child.stdin.flush();
    },

    async *lines() {
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffered += decoder.decode(chunk, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
            if (line) yield line;
          }
        }
      } catch {
        // Torn down by close(); the iteration simply ends.
      }
    },

    diagnostics() {
      return errorChunks.join("");
    },

    async close() {
      if (closed) return;
      closed = true;
      child.kill("SIGKILL");
      await child.exited;
    },
  };
}

/**
 * An in-memory channel for tests: `send` pushes onto `sent`, and `deliver`
 * feeds a line to the consumer as though the far side had written it.
 *
 * This is the second adapter that makes the seam real rather than hypothetical.
 */
export function memoryChannel(): LineChannel & {
  sent: string[];
  deliver(line: string): void;
  finish(): void;
} {
  const sent: string[] = [];
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let finished = false;

  return {
    sent,
    deliver(line) {
      queue.push(line);
      notify?.();
    },
    finish() {
      finished = true;
      notify?.();
    },
    send(line) {
      sent.push(line);
    },
    async *lines() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (finished) return;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = null;
            resolve();
          };
        });
      }
    },
    diagnostics() {
      return "";
    },
    async close() {
      finished = true;
      notify?.();
    },
  };
}
