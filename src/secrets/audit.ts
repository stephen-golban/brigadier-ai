// SPDX-License-Identifier: Apache-2.0
/**
 * The gate that makes "one sink" true rather than intended.
 *
 * Ruling 65 names the sink being bypassed as the most likely way redaction
 * fails in practice, and ruling 57's classification settles what to do about
 * it: **a rule nobody enforces is a request.** `src/secrets/sink.ts` returns
 * `void` from every method so a caller cannot take the bytes and write them
 * itself, but nothing in TypeScript stops a module importing `node:fs` and
 * opening a file. So this is a full-tree scan for the write primitives, run as
 * part of `test-gate`, and a new one is a red gate.
 *
 * IT IS A RATCHET, NOT A CLIFF, and the reason is honesty rather than
 * convenience. The tree already contains writers that predate the sink; a scan
 * that failed on all of them would have to be switched off to be committed, and
 * a switched-off gate is worth nothing. So every existing bypass is listed in
 * `BASELINE` **by name, with the adoption it owes**, the count may only go
 * down, and anything not on the list fails immediately. The list is the
 * migration, visible in the repository instead of in somebody's head.
 *
 * WHAT IS ALLOWED TO WRITE DIRECTLY is a short list, and each entry says why in
 * terms of the BYTES rather than the convenience. Two of them matter:
 *
 *   - `src/isolation/safe-fs.ts` DEFINES the refusing write. It is the syscall
 *     the sink calls; it composes nothing and never sees run text.
 *   - `src/agent/worker.ts` writes the WORKER's file, inside the worker's own
 *     clone, at the worker's request. Redacting that would be brigadier
 *     rewriting a worker's artifact — which ruling 65 does not promise, BAR
 *     item 12 explicitly excludes, and which is the honest limit of the whole
 *     mechanism rather than a gap in this scan.
 *
 * A NOTE ON WHAT IS NOT SCANNED. `child.stdin.write` is not a write primitive
 * here. It is a stream INTO a process brigadier spawned, carrying the brief;
 * ruling 65 delivers secrets by environment injection at spawn, so the brief
 * does not carry them, and redacting a prompt would be redacting the one
 * channel that is supposed to be readable.
 */

/** A write primitive. Matched against source with comments and string bodies blanked out. */
export interface WritePrimitive {
  readonly name: string;
  readonly pattern: RegExp;
}

export const WRITE_PRIMITIVES: readonly WritePrimitive[] = [
  { name: "Bun.write", pattern: /\bBun\s*\.\s*write\s*\(/g },
  { name: "writeFileSync", pattern: /\bwriteFileSync\s*\(/g },
  { name: "appendFileSync", pattern: /\bappendFileSync\s*\(/g },
  { name: "writeFile", pattern: /\bwriteFile\s*\(/g },
  { name: "writeSync", pattern: /\bwriteSync\s*\(/g },
  { name: "createWriteStream", pattern: /\bcreateWriteStream\s*\(/g },
  { name: "writeRegularFile", pattern: /\bwriteRegularFile\s*\(/g },
  { name: "console", pattern: /\bconsole\s*\.\s*(?:log|error|warn|info|debug|trace)\s*\(/g },
  { name: "process.stdout/stderr.write", pattern: /\bprocess\s*\.\s*std(?:out|err)\s*\.\s*write\s*\(/g },
];

export interface Allowance {
  readonly file: RegExp;
  readonly why: string;
}

export const ALLOWED: readonly Allowance[] = [
  {
    file: /^src\/secrets\//,
    why: "the sink itself, and the audit that guards it",
  },
  {
    file: /^src\/isolation\/safe-fs\.ts$/,
    why:
      "defines the refusing write. It is the syscall the sink calls; it composes nothing, sees no run text, and moving it behind the sink would make the sink call itself",
  },
  {
    file: /^src\/agent\/worker\.ts$/,
    why:
      "writes the WORKER's file inside the worker's own clone, at the worker's request over ACP. Redacting it would be brigadier rewriting a worker's artifact, which ruling 65 does not promise and BAR item 12 explicitly places outside the boundary",
  },
  {
    file: /^src\/agent\/ambient\.ts$/,
    why:
      "writes ruling 83's launcher shim, whose bytes are a compile-time constant plus ONE interpolated value: the path of the vendor binary, resolved from PATH or from the operator's own CLAUDE_CODE_EXECUTABLE. No plan text, no worker output and no run text reaches it. Redaction would also be the wrong operation rather than a missing one — the file is executed, so replacing bytes inside it produces a shim that execs a path that does not exist, which is worker.ts's case one file over. Bounded instead: mode 0700, inside brigadier's own run root, and swept with the run",
  },
  {
    file: /^src\/repomap\/selfcheck\.ts$/,
    why:
      "a standalone diagnostic entry point. It is not part of a run, there is no inventory in scope, and it prints a repository map of a directory the operator named on the command line",
  },
];

export interface Unsinked {
  readonly file: string;
  readonly line: number;
  readonly primitive: string;
  readonly text: string;
}

/**
 * Every bypass in the tree TODAY, with the adoption each owes.
 *
 * `count` may only fall. A new entry, or a higher count on an existing one,
 * fails `test-gate`. Delete a row when its file is clean.
 */
export interface BaselineEntry {
  readonly file: string;
  readonly primitive: string;
  readonly count: number;
  readonly adoption: string;
}

export const BASELINE: readonly BaselineEntry[] = [
  {
    file: "src/cli.ts",
    primitive: "console",
    count: 60,
    adoption:
      "construct one `Sink` at the top of `main` and route every line through `sink.outLine` / `sink.errLine`, then `sink.end()` before returning an exit code. `console.log(result.report)` is the one that matters: the report is composed from run text and is the artifact ruling 65 calls a stream out of brigadier",
  },
  {
    file: "src/queue/execute.ts",
    primitive: "writeRegularFile",
    count: 1,
    adoption:
      "delete the private `Sink` class and `redactEvent`, import `Sink` from `src/secrets/sink.ts`, and pass the sink down. `redactEvent` redacts each field and then serialises, which is v1's failure 2 and failure 3 in one function: an escaped form is never generated at the time it redacts, a non-string field is never touched, and a value spanning the join between two fields is not seen. `sink.append(record, JSON.stringify(event))` is the fix, and `executeRun` should return the sink so the CLI does not build a second one",
  },
  {
    file: "src/isolation/manifest.ts",
    primitive: "writeRegularFile",
    count: 1,
    adoption:
      "`manifest.json` sits in the run directory and is scanned by BAR item 12. Take a `Sink` and call `sink.write(path, JSON.stringify(merged, null, 2) + \"\\n\")` — composition first, redaction on the final bytes",
  },
  {
    file: "src/run/record.ts",
    primitive: "writeSync",
    count: 1,
    adoption:
      "`appendEvent` should become `encodeEvent(event): string` and the caller should hand the composed line to `sink.append`. The sink already carries the O_APPEND, O_NOFOLLOW and truncated-tail handling this function has, so nothing is lost by moving the write",
  },
  {
    file: "src/isolation/clone.ts",
    primitive: "writeRegularFile",
    count: 6,
    adoption:
      "git plumbing inside a clone — `.git/config`, the clone signature, the hermetic global config, the release token. None of it is composed run text, but it is still a writer outside the sink; route it through `sink.write` when a sink is available in `prepareClone`, or promote a narrow allowance naming these four contents once someone has read them all",
  },
  {
    file: "src/isolation/internal-git.ts",
    primitive: "writeRegularFile",
    count: 2,
    adoption: "same as `clone.ts`: hermetic git config, written inside a clone",
  },
  {
    file: "src/integrate/gate.ts",
    primitive: "writeRegularFile",
    count: 1,
    adoption: "same as `clone.ts`: an empty hermetic global git config",
  },
  {
    file: "src/plugin/index.ts",
    primitive: "console",
    count: 14,
    adoption:
      "the plugin subcommands print through `console` directly. Take the `Sink` the CLI builds and use `sink.outLine` / `sink.errLine`; a hook report naming paths under the operator's home is exactly the stream ruling 65 covers",
  },
  {
    file: "src/plugin/install.ts",
    primitive: "writeFileSync",
    count: 1,
    adoption:
      "installs plugin assets into a directory outside any clone. It writes bundled contents rather than run text, but it is a writer outside the sink and it writes to a path the operator keeps — take a `Sink` and use `sink.write`",
  },
];

/**
 * The counts above were MEASURED against `bun 1.3.14` on 2026-08-18 by
 * `unsinkedWrites` over `src/`, and they agreed exactly with an independent
 * `grep -c` of the same tree. They are a snapshot of a tree being worked on;
 * a row going UP is the gate doing its job, and the remedy is the `adoption`
 * on that row rather than a higher number.
 */

/**
 * Blank out comments and string bodies, preserving offsets and line breaks.
 *
 * Necessary rather than fussy: this repository's modules document the
 * primitives they deliberately do not call — `src/queue/execute.ts` says
 * "nothing in this file calls `writeFileSync`" — and a scanner that read prose
 * would report the sentence as the violation. Line breaks are preserved so line
 * numbers stay true, and the regex-literal handling is here because `/^src\//`
 * ends in two slashes and would otherwise blank the rest of its line.
 */
export function stripNonCode(source: string): string {
  const out: string[] = [];
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  let i = 0;
  // The previous significant code character, which is what distinguishes a
  // regex literal from a division.
  let prev = "";
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out.push(blank(source.slice(i, stop)));
      i = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out.push(blank(source.slice(i, stop)));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      const stop = Math.min(j + 1, source.length);
      out.push(c + blank(source.slice(i + 1, stop - 1)) + (source[stop - 1] === c ? c : ""));
      i = stop;
      prev = c;
      continue;
    }
    if (c === "/" && REGEX_MAY_START.has(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break;
        j++;
      }
      const stop = Math.min(j + 1, source.length);
      out.push(blank(source.slice(i, stop)));
      i = stop;
      prev = "/";
      continue;
    }
    out.push(c);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join("");
}

/** After one of these, a `/` opens a regex rather than dividing. */
const REGEX_MAY_START = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">", "\n"]);

export function isAllowed(file: string): Allowance | null {
  return ALLOWED.find((allowance) => allowance.file.test(file)) ?? null;
}

/** Every write primitive called from a file that is not the sink and not allowed. */
export function unsinkedWrites(files: ReadonlyMap<string, string>): Unsinked[] {
  const found: Unsinked[] = [];
  for (const [file, source] of files) {
    if (!file.startsWith("src/")) continue;
    if (isAllowed(file) !== null) continue;
    const code = stripNonCode(source);
    const lines = code.split("\n");
    const raw = source.split("\n");
    for (const primitive of WRITE_PRIMITIVES) {
      for (let n = 0; n < lines.length; n++) {
        const matches = lines[n]!.match(new RegExp(primitive.pattern.source, "g"));
        if (matches === null) continue;
        for (let k = 0; k < matches.length; k++) {
          found.push({ file, line: n + 1, primitive: primitive.name, text: (raw[n] ?? "").trim() });
        }
      }
    }
  }
  return found;
}

export interface Ratchet {
  /** A bypass in a file the baseline has never heard of, or more of them than it records. */
  readonly regressions: string[];
  /** Baseline rows whose file is now clean or cleaner. Informational; the row should be updated. */
  readonly improvements: string[];
}

/**
 * Compare the tree against `BASELINE`.
 *
 * Counts may fall freely — adoption should never need a second commit to the
 * gate. They may not rise, and a file:primitive pair the baseline does not list
 * is a regression however small, because that is the case where somebody wrote
 * a new artifact without the sink.
 */
export function ratchet(found: readonly Unsinked[], baseline: readonly BaselineEntry[] = BASELINE): Ratchet {
  const counted = new Map<string, number>();
  for (const hit of found) {
    const key = `${hit.file}:${hit.primitive}`;
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  const allowed = new Map(baseline.map((entry) => [`${entry.file}:${entry.primitive}`, entry]));
  const regressions: string[] = [];
  for (const [key, count] of counted) {
    const entry = allowed.get(key);
    if (entry === undefined) {
      regressions.push(
        `${key} — a write primitive outside src/secrets/sink.ts that the baseline does not list. ` +
          "Ruling 65: anything writing around the sink is unredacted. Route it through `Sink`.",
      );
    } else if (count > entry.count) {
      regressions.push(`${key} — ${count} calls, baseline records ${entry.count}. ${entry.adoption}`);
    }
  }
  const improvements: string[] = [];
  for (const [key, entry] of allowed) {
    const count = counted.get(key) ?? 0;
    if (count < entry.count) improvements.push(`${key} — now ${count}, baseline says ${entry.count}; lower the row`);
  }
  return { regressions, improvements };
}
