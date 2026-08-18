// SPDX-License-Identifier: Apache-2.0
/**
 * Spawning an agent with BOTH markers on it, and keeping the pid.
 *
 * Ruling 38 and ruling 57 are two markers for two jobs, and conflating them
 * breaks one of the two:
 *
 *   `BRIGADIER_WORKER=<run-id>/<item>` in the ENVIRONMENT makes brigadier's own
 *   plugin inert inside the worker. A sweep reading `ps` cannot see it.
 *
 *   `--brigadier-run=<run-id>/<item>` in the COMMAND LINE is what ruling 38's
 *   reclamation sweep matches on. A binary reading `process.env` cannot see it.
 *
 * Both are set here, in one place, because the failure mode of setting one is
 * silent: a worker with only the environment marker is a worker the sweep will
 * never find, and nothing about the run looks different until an interrupt
 * leaves it running.
 *
 * WHY THIS EXISTS BESIDE `src/acp/channel.ts`. That module's `spawnChannel` is
 * the reference implementation of ACP's newline-delimited framing and this one
 * does not reimplement the framing — it wraps `Bun.spawn` for exactly two
 * things `spawnChannel` cannot give a caller: an argv the caller composed
 * (ruling 38's marker has to be IN it) and the child's pid (the run record's
 * `process-spawned` event is what a later sweep is told it should have
 * matched). The framing below is the same three rules — one JSON object per
 * line, trim, skip blanks — and any divergence between the two is a bug in this
 * file.
 *
 * THE HONEST LIMIT, and it is ruling 38's own: the command line is the
 * process's own memory. A vendor binary that re-`exec`s something else without
 * carrying the marker stops matching, and no sweep reading `ps` will find it
 * again. `SweepCoverage.completeness` says `not-proven` for exactly this
 * reason.
 */

import type { LineChannel } from "../acp/channel.ts";
import { RUN_MARKER_FLAG, WORKER_MARKER, workerMarkerValue } from "../agent/marker.ts";
import { buildEnvironment, type LaunchProfile } from "../agent/profiles.ts";
import { runMarkerArg } from "../run/marker.ts";
import type { WorkKind } from "../work/kind.ts";

export interface MarkedSpawn {
  channel: LineChannel;
  pid: number;
  /** Exactly what a `ps` scan will see. Recorded so a sweep can be audited. */
  commandLine: string;
  kill(): void;
}

export interface MarkedSpawnOptions {
  profile: LaunchProfile;
  runId: string;
  item: number;
  /** The clone. The agent's working directory and its lane root. */
  cwd: string;
  kind: WorkKind;
  /** Decision 17's suppression lever: point the agent's config root here. */
  configRoot: string;
  /** Ruling 64: inside the item's own directory, never the shared temp root. */
  tmpDir: string;
  /** Ruling 65: granted at spawn, through the environment and nowhere else. */
  secrets?: Record<string, string>;
}

/**
 * Spawn one agent for one item.
 *
 * The marker is APPENDED to the profile's argv rather than inserted, so a
 * vendor that reads positional arguments sees them in the order its profile
 * measured. It is still an extra argument, and that is a real cost of ruling
 * 38: a vendor that rejects unknown arguments will fail to start, and it will
 * fail loudly at the handshake rather than silently mid-run.
 */
export function spawnMarkedAgent(options: MarkedSpawnOptions): MarkedSpawn {
  const marker = runMarkerArg(options.runId, options.item);
  const argv = [options.profile.command, ...options.profile.args, marker];
  const env = buildEnvironment(options.profile, {
    configRoot: options.configRoot,
    kind: options.kind,
    tmpDir: options.tmpDir,
    restrictive: true,
    extra: {
      // Ruling 59 upgrades this from a boolean to an identity: a refused
      // delegation needs to know whose record to be written to.
      [WORKER_MARKER]: workerMarkerValue(options.runId, options.item),
      ...(options.secrets ?? {}),
    },
  });

  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env,
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
  const channel: LineChannel = {
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

  return {
    channel,
    pid: child.pid,
    commandLine: argv.join(" "),
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    },
  };
}

/** The flag a reader will see in `ps`, exported so a report can name it. */
export const MARKER_FLAG = RUN_MARKER_FLAG;
