// SPDX-License-Identifier: Apache-2.0
/**
 * The third `LineChannel`: this process's own stdio, for when brigadier is the
 * AGENT rather than the client.
 *
 * `spawnChannel` speaks to a child brigadier started; `memoryChannel` speaks to
 * a test. Neither shape fits an editor that started US and holds the other end
 * of our stdin and stdout. Framing is unchanged and is the whole protocol at
 * this level: one JSON object per line, no Content-Length header.
 *
 * THE WRITER IS INJECTED, AND THAT IS RULING 65 RATHER THAN TESTABILITY.
 *
 * A frame written straight to the process's output stream would be a second
 * writer on stdout beside the CLI's one `Sink`, which is exactly what
 * `src/secrets/audit.ts` ratchets against — and it would be the worst possible
 * second writer, because an ACP frame is COMPOSED from run text and then
 * JSON-escaped, so it is precisely the artifact that has to be redacted after
 * composition rather than before. So this module owns no output stream at all:
 * the caller hands it a `writeLine` and the caller is expected to hand it the
 * sink's. `unsinkedWrites` over this file therefore finds nothing, which is the
 * point rather than a coincidence.
 *
 * THE READER IS A READER AND NOT A `for await`. `close()` has to be able to
 * interrupt a read that is parked on an editor that will never type again;
 * cancelling the reader is the only thing that does, and a bare `for await` over
 * the stream gives no handle to cancel with.
 */

import type { LineChannel } from "./channel.ts";

export interface StdioChannelOptions {
  /**
   * Where one composed frame goes. The newline is appended here, so the caller
   * receives exactly the JSON object.
   *
   * Pass the process's ONE sink. There is deliberately no default: a default
   * would be this module choosing to write, and then the choice would be
   * invisible at every call site.
   */
  writeLine(line: string): void;
  /** The byte source. Defaults to this process's stdin. */
  input?: ReadableStream<Uint8Array>;
}

/**
 * What `diagnostics()` can honestly say here.
 *
 * `LineChannel.diagnostics()` means "whatever the far side wrote to its error
 * stream", and when the far side is the editor that spawned us there is no such
 * stream to read — our stderr is an output, not an input. Returning `""` would
 * read as "the client said nothing", which is a different claim.
 */
export const NO_DIAGNOSTICS =
  "no diagnostics: the far side is the client that spawned this process, and its error stream is not readable from here";

export function stdioChannel(options: StdioChannelOptions): LineChannel {
  const source = options.input ?? (Bun.stdin.stream() as ReadableStream<Uint8Array>);
  const reader = source.getReader();
  let closed = false;

  return {
    send(line) {
      if (closed) return;
      options.writeLine(line);
    },

    async *lines() {
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || value === undefined) break;
          buffered += decoder.decode(value, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
            if (line) yield line;
          }
        }
      } catch {
        // Cancelled by close(), or stdin torn down under us. Either way the
        // iteration ends, which is what the far side hanging up looks like.
      }
      // A last frame with no trailing newline. Yielded rather than dropped: a
      // client that closes its pipe immediately after the frame has still sent
      // it, and silently losing the final request would look like a hang.
      const rest = buffered.trim();
      if (rest) yield rest;
    },

    diagnostics() {
      return NO_DIAGNOSTICS;
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        await reader.cancel();
      } catch {
        // Already torn down. Idempotent by contract.
      }
    },
  };
}
