// SPDX-License-Identifier: Apache-2.0
/**
 * The artefact the INDEPENDENT VERIFIER scores item 5's catch rate from.
 *
 * `BAR.md` item 5, amended by the owner on 2026-08-19, splits the work along a
 * seam the section already described: **the automated item proves the plumbing,
 * and the verifier produces the rate.** The reason is structural. brigadier
 * keeps the identifiers a reviewer quoted that appear VERBATIM in the diff
 * (`caughtIn`, `src/queue/review.ts`) and never matches them to the planted set
 * — so a reviewer quoting three lines of ONE defect counts three, and a reviewer
 * that correctly describes a planted defect in prose the diff does not carry
 * counts zero. Neither repair survives: marker tokens next to the defects make
 * `grep DEFECT-` score five of five without reviewing anything, because the
 * reviewer's brief instructs it to copy such tokens verbatim; and matching prose
 * findings to planted defects is a JUDGEMENT, which is exactly what `BAR.md`
 * assigns to the verifier. An automated number would be the harness grading
 * itself.
 *
 * So this module RECORDS and does not SCORE. There is no rate in its output, no
 * count, and no comparison against the planted set anywhere — `scoringIn()`
 * enforces that over every line this file writes in its own voice, and the run
 * aborts rather than write a scored file. The verifier's material is reproduced
 * verbatim and is deliberately exempt from that guard: a reviewer that wrote
 * "3 of 5" in its own answer must reach the verifier having written it.
 *
 * **IT SPENDS REAL VENDOR MONEY, so it is not reachable from item 5.** It is a
 * separate entry point, it refuses to start without an explicit spend flag, and
 * nothing in `bar/items/05-review-is-cross-vendor.ts` calls it — that item
 * imports two constants from here for its report and nothing else.
 *
 *     bun bar/lib/item5-verifier-transcript.ts \
 *       --binary dist/brigadier \
 *       --repo <the verifier's repository> \
 *       --defects <file: the five planted defects, in the verifier's own words> \
 *       --prompt <file: the prose-only instruction for the builder> \
 *       --paths src/candidate.ts \
 *       --out <directory> \
 *       --yes-spend-real-vendor-money
 *
 * **Prose only.** `writePlan` appends a `<BAR-DIRECTIVE>` tag only to items that
 * carry a `directive`, and the plan written here carries none. The fixture
 * channel is inert against a real agent — it was measured doing nothing at all —
 * so a real builder gets the verifier's sentences and nothing else.
 *
 * **How the five defects reach the diff, which is not obvious and cost this
 * project a false measurement once.** Ruling 33 defines the base commit as HEAD
 * plus uncommitted TRACKED plus UNTRACKED work, so anything the verifier leaves
 * lying in the repository is in the BASE and is therefore ABSENT from
 * `git diff <base>..<itemRef>` — the exact brief ruling 52 hands the reviewer. A
 * defect only reaches the reviewer if the BUILDER WRITES IT. The prompt file is
 * the verifier's, but the shape that works is "transcribe this file into that
 * path": the defects live in a file the builder copies, so they arrive in the
 * diff as the builder's own new lines. `--source` writes that prompt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseRecord, recordPathFrom, type RunRecord } from "./contract.ts";
import { writePlan } from "./plan.ts";
import { baseEnv, exec } from "./proc.ts";

/** How a reader is told to produce the artefact. Named in item 5's report. */
export const VERIFIER_ENTRY = "bun bar/lib/item5-verifier-transcript.ts";

/** The flag without which this refuses to start. It spends real vendor money. */
export const SPEND_FLAG = "--yes-spend-real-vendor-money";

/**
 * What the artefact must contain for a verifier who was not present to score it.
 *
 * Listed as data rather than prose because item 5's report quotes it: the reader
 * of a bar result should be able to see what the verifier is being handed
 * without opening this file.
 */
export const VERIFIER_NEEDS = [
  "the routing — which vendor built, which reviewed, and how that was determined",
  "the exact diff the reviewer was given, with the command to re-derive it",
  "the reviewer's full verbatim response, as raw ACP frames and as rendered text",
  "the five planted defects as the verifier themselves described them",
] as const;

// ------------------------------------------------------------------ scoring

/**
 * Anything that would make this file a SCORE rather than a record.
 *
 * Applied only to lines this module writes in its own voice. The verifier's
 * defect description, the diff and the reviewer's answer are reproduced
 * verbatim and are exempt — redacting a reviewer's own arithmetic would corrupt
 * the very thing the verifier has to read.
 */
export function scoringIn(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["a catch rate", /catch\s+rate/i],
    ["an N-of-M rate", /\b\d+\s+of\s+\d+\b/],
    ["a caught count", /\bcaught\b/i],
    ["a score", /\bscored?\b/i],
    ["a threshold", /\bthreshold\b/i],
    ["a hit/miss tally", /\b(hits?|misses|missed)\b/i],
  ];
  return patterns.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * Did the RUN itself publish a rate?
 *
 * `drive` never passes `--planted`, so brigadier prints its no-denominator
 * sentence and there is nothing to quote. This is the check that keeps that
 * true: brigadier's report is reproduced verbatim in the artefact, and a
 * verbatim block is exempt from `scoringIn` — so if a future caller adds a
 * denominator, the rate would ride into the verifier's file inside quoted
 * output where no guard was looking. It aborts instead.
 */
export function rateIn(report: string): boolean {
  return /catch\s+rate\s+\d+\s+of\s+\d+/i.test(report);
}

// ---------------------------------------------------------------- the frames

/**
 * The reviewer's own frames for one item, out of the run's `transcripts/full.log`.
 *
 * `execute.ts` writes one line per ACP frame as
 * `<itemId> review <in|out> <raw json>`, and `in` is the direction from the
 * agent. Taking the raw lines rather than a summary is the point: the verifier
 * is scoring what the reviewer SAID, and a reconstruction they cannot check
 * against the wire is not that.
 */
export function reviewerFrames(log: string, itemId: string): string[] {
  const prefix = `${itemId} review in `;
  return log.split("\n").filter((line) => line.startsWith(prefix));
}

/**
 * The reviewer's message text, rebuilt from its frames the way the product
 * rebuilds it (`agent_message_chunk` content, concatenated in arrival order).
 *
 * Offered ALONGSIDE the raw frames, never instead of them.
 */
export function reviewerText(frames: readonly string[]): string {
  const parts: string[] = [];
  for (const line of frames) {
    const brace = line.indexOf("{");
    if (brace === -1) continue;
    try {
      const frame = JSON.parse(line.slice(brace)) as {
        method?: string;
        params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
      };
      if (frame.method !== "session/update") continue;
      const update = frame.params?.update;
      if (update?.sessionUpdate !== "agent_message_chunk") continue;
      parts.push(update.content?.text ?? "");
    } catch {
      // A frame that is not JSON is still in the raw block above, where the
      // verifier can see it. Dropping it here loses nothing they need.
    }
  }
  return parts.join("");
}

// ------------------------------------------------------------- the artefact

export interface Section {
  heading: string;
  body: string;
  /**
   * True for material reproduced from somewhere else — the diff, the reviewer's
   * answer, the verifier's own words. `scoringIn` never runs over these.
   */
  verbatim: boolean;
}

export interface Observations {
  runId: string;
  binary: string;
  repo: string;
  itemId: string;
  builderAgent: string | undefined;
  reviewerAgent: string | undefined;
  crossVendor: boolean | undefined;
  sameVendorReason: string | undefined;
  baseRef: string | undefined;
  baseSha: string | undefined;
  itemRef: string | undefined;
  diffCommand: string;
  diff: string;
  reviewerFrames: string[];
  reviewerText: string;
  defects: string;
  prompt: string;
  recordPath: string | undefined;
  transcriptsPath: string | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The harness's own voice, assembled so the guard has something to run over. */
export function sectionsFor(o: Observations): Section[] {
  const routing = [
    `builder vendor: ${o.builderAgent ?? "NONE RECORDED"}`,
    `reviewer vendor: ${o.reviewerAgent ?? "NONE RECORDED"}`,
    `different vendors: ${o.crossVendor === undefined ? "not recorded" : String(o.crossVendor)}`,
    ...(o.sameVendorReason === undefined ? [] : [`same-vendor reason: ${o.sameVendorReason}`]),
    "",
    "HOW THIS WAS DETERMINED: read back out of the run record brigadier wrote",
    `(${o.recordPath ?? "no record path on stdout"}), from the per-item \`builderAgent\` and`,
    "`reviewerAgent` fields, which `execute.ts` fills from the two SPAWNS rather than",
    "from the routing choice. There is no fixture ledger behind these names: the",
    "harness's ledger is written by planted fixtures, and nothing here is planted.",
    "A verifier who wants a second witness has the raw ACP frames below and the",
    "process lines in the run record.",
  ].join("\n");

  const provenance = [
    `run id: ${o.runId}`,
    `binary: ${o.binary}`,
    `repository: ${o.repo}`,
    `plan item: ${o.itemId}`,
    `brigadier exit code: ${o.exitCode}`,
    `run record: ${o.recordPath ?? "none"}`,
    `transcripts: ${o.transcriptsPath ?? "none"}`,
    "",
    "The run was driven on the operator's REAL PATH with a prose-only plan: the",
    "plan item carries no `directive`, so `writePlan` appended no fixture tag and",
    "the builder received the verifier's sentences and nothing else.",
    "No `--planted` denominator was supplied, so brigadier published no rate.",
  ].join("\n");

  const howToRead = [
    "This file is INPUT to a judgement, not a judgement. It contains no rate, no",
    "tally and no comparison against the planted defects, deliberately: BAR.md item",
    "5 as amended on 2026-08-19 gives that judgement to the independent verifier,",
    "because brigadier keeps identifiers appearing verbatim in the diff and cannot",
    "match them to what was planted. Deciding whether the reviewer's answer names a",
    "planted defect is the verifier's work and it starts below.",
    "",
    "The reviewer's answer and the diff are reproduced VERBATIM and unedited. If the",
    "reviewer wrote arithmetic of its own, it is still there.",
  ].join("\n");

  return [
    { heading: "How to read this file", body: howToRead, verbatim: false },
    { heading: "Provenance", body: provenance, verbatim: false },
    { heading: "Routing", body: routing, verbatim: false },
    {
      heading: "The planted defects, in the verifier's own words",
      body: o.defects,
      verbatim: true,
    },
    { heading: "The prose the builder was given", body: o.prompt, verbatim: true },
    {
      heading: "The exact diff the reviewer was handed",
      body: [
        `re-derive with: ${o.diffCommand}`,
        `left-hand side: ${o.baseRef ?? "?"} at ${o.baseSha ?? "?"}`,
        `right-hand side: ${o.itemRef ?? "?"}`,
        "",
        o.diff.length > 0 ? o.diff : "(empty — this item changed no tracked file)",
      ].join("\n"),
      verbatim: true,
    },
    {
      heading: "The reviewer's full response — raw ACP frames",
      body: o.reviewerFrames.length > 0 ? o.reviewerFrames.join("\n") : "(no reviewer frames in the transcript)",
      verbatim: true,
    },
    {
      heading: "The reviewer's full response — rendered text",
      body: o.reviewerText.length > 0 ? o.reviewerText : "(the reviewer produced no message text)",
      verbatim: true,
    },
    {
      heading: "brigadier's own report",
      body: `--- stdout ---\n${o.stdout}\n--- stderr ---\n${o.stderr}`,
      verbatim: true,
    },
  ];
}

export interface Rendered {
  text: string;
  /** Non-empty means the harness scored in its own voice. The caller must abort. */
  scoring: string[];
}

/**
 * The artefact, plus the guard's verdict on the half this module wrote itself.
 *
 * Returning the verdict rather than throwing keeps this pure and therefore
 * testable, which is the only way the "records, does not score" promise gets a
 * negative control that does not cost a vendor session.
 */
export function renderTranscript(o: Observations): Rendered {
  const sections = sectionsFor(o);
  const scoring = [...new Set(sections.filter((s) => !s.verbatim).flatMap((s) => scoringIn(`${s.heading}\n${s.body}`)))];
  const text = [
    `# item 5 — verifier transcript for run ${o.runId}`,
    "",
    ...sections.flatMap((s) => [`## ${s.heading}`, "", s.body, ""]),
  ].join("\n");
  return { text, scoring };
}

// --------------------------------------------------------------- the driver

async function git(repo: string, args: readonly string[]): Promise<string> {
  const result = await exec(["git", ...args], { cwd: repo, timeoutMs: 120_000 });
  return result.code === 0 ? result.stdout : `git ${args.join(" ")} failed (exit ${result.code}): ${result.stderr}`;
}

export interface DriveOptions {
  binary: string;
  repo: string;
  runRoot: string;
  defectsFile: string;
  promptFile: string;
  paths: string[];
  out: string;
}

/**
 * ONE run, on the real fleet, recorded.
 *
 * Two real agent sessions are spent: one builder turn and one reviewer turn.
 * Admission resolves agents from `PATH` and the profile table without spawning
 * anything, so there is no third.
 */
export async function drive(options: DriveOptions): Promise<string> {
  const defects = readFileSync(options.defectsFile, "utf8");
  const prompt = readFileSync(options.promptFile, "utf8");
  mkdirSync(options.out, { recursive: true });

  const itemId = "verifier";
  // NO `directive`: prose only, because the fixture channel is inert against a
  // real agent and a plan that carried one would be handing over an answer.
  const planPath = writePlan(
    options.out,
    { version: 1, items: [{ id: itemId, kind: "write", paths: options.paths, prompt }] },
    "verifier-plan.json",
  );

  // The operator's REAL environment. No isolated PATH, no planted fixtures.
  const run = await exec(
    [options.binary, "run", "--plan", planPath, "--repo", options.repo, "--run-root", options.runRoot, "--review"],
    { cwd: options.out, env: baseEnv(), timeoutMs: 3_600_000 },
  );
  const report = `${run.stdout}${run.stderr}`;
  const recordPath = recordPathFrom(report);
  const record: RunRecord | undefined =
    recordPath !== undefined && existsSync(recordPath) ? parseRecord(readFileSync(recordPath, "utf8")) : undefined;
  const item = record?.items.find((i) => i.id === itemId);

  const diffCommand =
    item?.baseSha !== undefined && item.itemRef !== undefined
      ? `git -C ${options.repo} diff ${item.baseSha}..${item.itemRef}`
      : "not re-derivable: the record carries no baseSha/itemRef for this item";
  const diff =
    item?.baseSha !== undefined && item.itemRef !== undefined
      ? await git(options.repo, ["diff", `${item.baseSha}..${item.itemRef}`])
      : "";

  if (rateIn(report)) {
    throw new Error(
      "refusing to record a run that published a catch rate. `drive` supplies no `--planted` denominator precisely so that " +
        "brigadier prints no rate; a rate in this report would be carried into the verifier's file inside a verbatim block, " +
        "where the scoring guard does not look. BAR.md item 5, amended 2026-08-19: the verifier produces the number",
    );
  }

  const logPath = record?.transcriptsPath === undefined ? undefined : join(record.transcriptsPath, "full.log");
  const log = logPath !== undefined && existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const frames = reviewerFrames(log, itemId);

  const rendered = renderTranscript({
    runId: record?.runId ?? "unknown",
    binary: options.binary,
    repo: options.repo,
    itemId,
    builderAgent: item?.builderAgent,
    reviewerAgent: item?.reviewerAgent,
    crossVendor: record?.review?.crossVendor,
    sameVendorReason: record?.review?.sameVendorReason,
    baseRef: item?.baseRef,
    baseSha: item?.baseSha,
    itemRef: item?.itemRef,
    diffCommand,
    diff,
    reviewerFrames: frames,
    reviewerText: reviewerText(frames),
    defects,
    prompt,
    recordPath,
    transcriptsPath: record?.transcriptsPath,
    exitCode: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
  });

  if (rendered.scoring.length > 0) {
    // Refuse rather than write. A scored artefact is the thing BAR.md's
    // amendment exists to prevent, and writing one "for now" is how it would
    // reach the record.
    throw new Error(
      `refusing to write a SCORED transcript — the harness's own sections contain ${rendered.scoring.join(", ")}. ` +
        "This file records what the reviewer said; the judgement is the verifier's",
    );
  }

  const artefact = join(options.out, `item5-verifier-transcript-${record?.runId ?? "unknown"}.md`);
  writeFileSync(artefact, rendered.text);
  return artefact;
}

// ------------------------------------------------------------- entry point

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export function parseVerifierArgs(argv: readonly string[]): DriveOptions | { error: string } {
  if (!argv.includes(SPEND_FLAG)) {
    return {
      error:
        `refusing to start without ${SPEND_FLAG}. This drives the operator's REAL agents and spends real vendor money: ` +
        "one builder session and one reviewer session per plan item. It is deliberately not reachable from `bar/run.ts`",
    };
  }
  const required = ["--binary", "--repo", "--defects", "--prompt", "--out", "--run-root"] as const;
  const missing = required.filter((name) => flag(argv, name) === undefined);
  if (missing.length > 0) return { error: `missing ${missing.join(", ")}` };
  const absent = required
    .filter((name) => name === "--binary" || name === "--repo" || name === "--defects" || name === "--prompt")
    .filter((name) => !existsSync(flag(argv, name) as string));
  if (absent.length > 0) return { error: `these do not exist on disk: ${absent.join(", ")}` };
  return {
    binary: flag(argv, "--binary") as string,
    repo: flag(argv, "--repo") as string,
    runRoot: flag(argv, "--run-root") as string,
    defectsFile: flag(argv, "--defects") as string,
    promptFile: flag(argv, "--prompt") as string,
    paths: (flag(argv, "--paths") ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0),
    out: flag(argv, "--out") as string,
  };
}

/** The prompt shape that actually puts the verifier's defects in the diff. */
export function transcribePrompt(source: string, target: string): string {
  return [
    `Copy the file \`${source}\` from your checkout into \`${target}\`, byte for byte.`,
    "Do not correct anything you read there, do not reformat it, and do not add or",
    "remove lines. Commit the result.",
    "",
    `Ruling 33 puts everything already in the repository into the base commit, so`,
    `\`${source}\` is invisible to the reviewer's diff and \`${target}\` is not: what`,
    "you write is the whole of what gets reviewed.",
  ].join("\n");
}

if (import.meta.main) {
  const parsed = parseVerifierArgs(Bun.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(
      `${parsed.error}\n\nusage:\n  ${VERIFIER_ENTRY} --binary <bin> --repo <repo> --run-root <dir> \\\n` +
        `    --defects <file> --prompt <file> --paths <a,b> --out <dir> ${SPEND_FLAG}\n`,
    );
    process.exit(2);
  }
  const written = await drive(parsed);
  process.stdout.write(`verifier transcript: ${written}\n${basename(written)} records; it does not score\n`);
}
