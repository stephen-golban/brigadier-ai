// SPDX-License-Identifier: Apache-2.0
/**
 * The sink: the one writer every persisted artifact and every stream goes
 * through.
 *
 * Ruling 65's second rule, and the one the ruling itself names as the most
 * likely way redaction fails in practice — **not** because the matching is
 * weak, but because something wrote around it. `redact.ts` holds the inventory
 * and the encodings; this file holds the only place bytes leave the process.
 *
 * WHY A SINK AND NOT A HELPER EVERYONE CALLS. v1's three failures were all
 * "redaction happened at the wrong point", and two of them were introduced by
 * code that *did* call the redactor:
 *
 *   - it redacted each field of an event and then serialised, so a value the
 *     serialiser escaped and a value spanning the join between two fields both
 *     survived a redactor that ran;
 *   - it redacted each line before printing, so a secret spanning two writes
 *     survived, because neither write contained the whole thing.
 *
 * So the sink takes COMPOSED BYTES and nothing else. There is no method here
 * that takes an object and serialises it, because a serialiser inside the sink
 * would put a transformation after the redaction again. Callers compose first —
 * `sink.write(path, JSON.stringify(record, null, 2))` — and the sink redacts
 * what is actually going to be on disk.
 *
 * STREAMS ARE COMPOSED ACROSS CALLS, which is the same failure one level up.
 * `out` and `err` buffer, redact EVERYTHING BUFFERED on each call — before
 * deciding what is settled, never after — and then hold back only what a
 * partial match could still reach back into: nothing at all unless an
 * inventoried value contains a newline, so a line-oriented caller waits for
 * nothing. `end()` flushes the remainder and must be called before the process
 * exits.
 *
 * WHAT PREVENTS WRITING AROUND IT. Two things, neither of them discipline:
 *
 *   1. Nothing here HANDS BACK bytes. Every method returns `void`. The shape
 *      that invites a bypass is a redactor that returns a string for the caller
 *      to print, because then the caller owns the write; there is no such
 *      method on this class.
 *   2. `src/secrets/audit.ts` is a full-tree scan for the write primitives —
 *      `Bun.write`, `writeFileSync`, `writeSync`, `writeRegularFile`,
 *      `console.log`, `process.stdout.write` and the rest — and `test-gate`
 *      fails on any new one. A bypass is a red gate, not a review comment.
 *
 * REDACTION IS MANDATORY AND NON-OPTIONAL. There is no flag, and the sink
 * redacts every artifact whether or not that item was granted anything: the
 * inventory can hold a value a worker reached some other way, and an artifact
 * that skipped redaction because "this item has no secrets" is exactly the
 * artifact nobody thinks to check.
 *
 * A PATH IS NOT A SECRET; AN INVENTORIED VALUE IS. The sink never inspects
 * paths. Under ruling 51 `refs/heads/brigadier/<run-id>` is the deliverable the
 * operator is meant to find, and redacting slugs out of branch names destroys
 * diagnostics to protect nothing.
 *
 * THE HONEST LIMIT, which belongs everywhere this is described and must never
 * be quietly dropped: **this defeats VERBATIM leaks only.** A worker that
 * paraphrases a key, re-encodes it in a scheme `encodedForms` does not
 * enumerate, splits it across prose, or describes it is caught by neither the
 * sink nor the product. And the sink covers BRIGADIER's artifacts. A file the
 * worker writes inside its own clone and commits is the worker's artifact;
 * brigadier does not rewrite a worker's commit, and nothing here claims to.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { writeRegularFile } from "../isolation/safe-fs.ts";
import { MINIMUM_SECRET_LENGTH, SecretInventory, type EncodingName } from "./redact.ts";

/** `O_NOFOLLOW` where the platform has it. Windows does not; the lstat below carries it there. */
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/**
 * A caller handed the sink something it cannot write without breaking an
 * invariant somebody else depends on. Refuse, never repair — `safe-fs.ts`'s
 * rule, for the same reason.
 */
export class SinkMisuse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SinkMisuse";
  }
}

/** Where `out` and `err` land. Injectable so the tests can read what was flushed. */
export interface SinkStreams {
  out(chunk: string): void;
  err(chunk: string): void;
}

/**
 * What a grant did, reported by NAME.
 *
 * `tooShort` is the hole `MINIMUM_SECRET_LENGTH` cuts, said out loud instead of
 * left to be discovered: a granted value under 8 characters is DELIVERED to the
 * worker and is NOT inventoried, so it will not be redacted out of anything.
 * Redacting every occurrence of a three-character string destroys more than it
 * protects, so the length floor stays — but an operator who granted a short
 * value is owed the sentence.
 */
export interface Grant {
  /** The environment to inject at spawn. Ruling 65: delivery is injection, never a copied file. */
  readonly env: Record<string, string>;
  readonly inventoried: string[];
  readonly tooShort: string[];
  readonly unset: string[];
}

function stdio(): SinkStreams {
  return {
    out: (chunk) => void process.stdout.write(chunk),
    err: (chunk) => void process.stderr.write(chunk),
  };
}

export class Sink {
  readonly inventory: SecretInventory;
  readonly #streams: SinkStreams;
  #pending = { out: "", err: "" };
  #ended = false;

  constructor(inventory: SecretInventory = new SecretInventory(), streams: SinkStreams = stdio()) {
    this.inventory = inventory;
    this.#streams = streams;
  }

  /**
   * Read the granted environment variables and inventory them in the same step.
   *
   * One step on purpose. v1's failure 1 was a value that had been delivered
   * living in a different structure from the values being redacted; if reading
   * a grant and inventorying it are two calls, there is a program in which one
   * happened and the other did not. `env` defaults to the host environment
   * because ruling 65's channel is injection at spawn — there is deliberately no
   * parameter here that reads a FILE, because a repository naming
   * `~/.aws/credentials` is a hostile repository asking for the operator's keys,
   * and the source list is per-machine only.
   */
  grant(names: readonly string[], env: Record<string, string | undefined> = process.env): Grant {
    const granted: Record<string, string> = {};
    const inventoried: string[] = [];
    const tooShort: string[] = [];
    const unset: string[] = [];
    for (const name of names) {
      const value = env[name];
      if (value === undefined || value === "") {
        unset.push(name);
        continue;
      }
      granted[name] = value;
      if (value.length >= MINIMUM_SECRET_LENGTH) {
        this.inventory.add(value);
        inventoried.push(name);
      } else {
        tooShort.push(name);
      }
    }
    return { env: granted, inventoried, tooShort, unset };
  }

  /**
   * Write a whole artifact, replacing whatever was there.
   *
   * Takes composed bytes. `writeRegularFile` is the syscall — it refuses to
   * write through a symlink or a hard link at the destination, which matters
   * here because these paths sit beside directories an agent can reach.
   */
  write(path: string, contents: string): void {
    if (this.#ended) throw new SinkMisuse(`the sink was ended before ${path} was written`);
    mkdirSync(dirname(path), { recursive: true });
    writeRegularFile(path, this.inventory.redact(contents));
  }

  /**
   * Append exactly one line.
   *
   * Ruling 70's record is NDJSON, and one event is always one line — so this
   * REFUSES a line containing a newline rather than writing it and silently
   * turning one event into two, one of which is not valid JSON. Redaction runs
   * on the composed line, so a secret spanning the join between two serialised
   * fields is caught here and would not be by redacting the fields.
   *
   * `O_APPEND` so two processes writing the same record interleave whole lines,
   * `O_NOFOLLOW` plus the lstat for `safe-fs.ts`'s reason, and the leading
   * newline for ruling 70's: a record whose last line was truncated by a kill
   * does not end in one, and appending straight onto the fragment costs the new
   * event as well as the old.
   */
  append(path: string, line: string): void {
    if (this.#ended) throw new SinkMisuse(`the sink was ended before ${path} was appended to`);
    const redacted = this.inventory.redact(line);
    if (redacted.includes("\n")) {
      throw new SinkMisuse(
        `refusing to append a line containing a newline to ${path}: ruling 70's record is one ` +
          "event per line, and writing this would split one event into two records, the second " +
          "of which parses as nothing. Compose it as a single JSON line first.",
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(path);
    } catch {
      stat = null;
    }
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new SinkMisuse(
          `refusing to append through a symlink: ${path}. The record is evidence about processes ` +
            "brigadier may have to kill; writing it somewhere an agent chose is not recoverable.",
        );
      }
      if (!stat.isFile()) throw new SinkMisuse(`refusing to append to ${path}, which is not a regular file`);
    }
    const needsBreak = stat !== null && stat.size > 0 && !endsWithNewline(path);
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NOFOLLOW);
    try {
      writeSync(fd, `${needsBreak ? "\n" : ""}${redacted}\n`);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * stdout, which is a persisted artifact too: in host-first it lands in a
   * context window and stays there.
   *
   * Returns `void` deliberately. A method that returned the redacted string
   * would hand the write back to the caller, and the caller writing is the
   * failure this class exists to make impossible.
   */
  out(text: string): void {
    this.#stream("out", text);
  }

  err(text: string): void {
    this.#stream("err", text);
  }

  /** A whole line, the shape almost every caller wants. */
  outLine(text: string): void {
    this.#stream("out", `${text}\n`);
  }

  errLine(text: string): void {
    this.#stream("err", `${text}\n`);
  }

  /**
   * Flush what is still held back and refuse further writes.
   *
   * Idempotent. Must be called before the process exits or a trailing fragment
   * is lost — the tail is held precisely because a pattern could straddle it.
   */
  end(): void {
    if (this.#ended) return;
    for (const which of ["out", "err"] as const) {
      const rest = this.#pending[which];
      this.#pending[which] = "";
      if (rest.length > 0) this.#streams[which](this.inventory.redact(rest));
    }
    this.#ended = true;
  }

  /**
   * Does this text still hold a secret, in ANY enumerated encoding?
   *
   * Reports encoding NAMES, never the matched pattern: a leak report that
   * quotes what it found is a leak. The v1 assertion this replaces —
   * *"the output does not contain the secret"* — was true of a file that
   * contained it, so a helper that repeats the bug is worse than none.
   */
  leaks(text: string): EncodingName[] {
    return this.inventory.leakEncodings(text);
  }

  /**
   * REDACT FIRST, THEN DECIDE WHAT IS SETTLED — in that order, because the
   * other order is failure 3 again one level up.
   *
   * Redaction runs over everything buffered so far, so every complete
   * occurrence is gone whatever call boundary it happened to span. What is left
   * to worry about is a PARTIAL occurrence at the tail that a later write would
   * complete, and there are two cases:
   *
   *   - no inventoried pattern contains a newline, which is every case unless a
   *     multi-line value like a PEM key was granted. Then a newline is a
   *     boundary no pattern can cross, and everything up to the last one is
   *     settled — a line-oriented caller waits for nothing;
   *   - one does. Then hold back one byte short of the longest such pattern,
   *     which is the furthest a partial occurrence could reach back from the
   *     end of the buffer.
   *
   * What is held back is the REDACTED tail rather than the raw one: redaction
   * removed only complete occurrences, and a complete occurrence cannot be part
   * of one that needs future input to finish.
   */
  #stream(which: "out" | "err", text: string): void {
    if (this.#ended) throw new SinkMisuse("the sink was ended before this write");
    const redacted = this.inventory.redact(this.#pending[which] + text);
    const guard = this.inventory.straddleGuard();
    const cut = guard === 0 ? redacted.lastIndexOf("\n") + 1 : Math.max(0, redacted.length - guard);
    if (cut <= 0) {
      this.#pending[which] = redacted;
      return;
    }
    this.#pending[which] = redacted.slice(cut);
    this.#streams[which](redacted.slice(0, cut));
  }
}

/** Does the file end in a newline, i.e. is its last record whole? */
function endsWithNewline(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const tail = Buffer.alloc(1);
    readSync(fd, tail, 0, 1, size - 1);
    return tail[0] === 0x0a;
  } catch {
    // Unreadable: assume it needs the break. A spurious blank line costs
    // nothing; a fused event costs an event.
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
