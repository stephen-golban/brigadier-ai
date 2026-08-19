// SPDX-License-Identifier: Apache-2.0
/**
 * Item 12's negative controls, driven end to end against a real fixture.
 *
 * Amendment §10 records that an independent critic **deleted the redaction sink
 * entirely and item 12 still passed**. That is the finding this file exists to
 * make impossible to reintroduce, and it cannot be settled by asserting on the
 * judge in isolation: the judge was never the part that was wrong. The item was
 * looking at a run in which the secret had never moved, and "the secret is
 * nowhere" is trivially true of such a run whether or not any sink exists.
 *
 * So three arms, over `bar/fakes/honest.ts` — a brigadier that really clones,
 * really spawns workers, really merges and really writes a record — each arm
 * differing from the one before it by ONE edit, asserted to have applied:
 *
 *   A. the STOCK fixture, sink INTACT
 *      → item 12 PASSES, and the pass is EARNED: ruling 65's placeholder stands
 *        in the transcript where the granted value would otherwise be.
 *   B. the same, sink DELETED
 *      → item 12 FAILS, naming the artefacts that hold the value. A and B are
 *        now DIFFERENT, and that difference is the whole point of this file.
 *
 * Until 2026-08-19 A and B produced BYTE-IDENTICAL verdicts, and that was the
 * finding rather than a defect in this file: `bar/fakes/vendor.ts` wrote the
 * granted value only into a JSON file, so a diff of it inside a frame carried
 * the value JSON-escaped TWICE and `src/secrets/redact.ts` enumerates four flat
 * forms of which that is not one. The sink could not act on it either way, so
 * deleting the sink changed nothing observable. That directive now ALSO writes
 * the value as plain text at one escape level — the JSON copy is deliberately
 * kept beside it, as evidence of the documented limit — and the two arms
 * separate. If they ever agree again, the single-escape channel has gone and
 * this control has stopped controlling.
 *   D. the transcript reverted to the CONSTANT it used to be, so the granted
 *      value never traverses the sink at all → ruling 65's placeholder is absent
 *      and item 12 reports `error` naming it. That constant is this fixture's
 *      own history, and it is why the sink could be deleted unnoticed: with the
 *      transcript carrying nothing, redacting it and not redacting it produce
 *      identical bytes. Absence-of-secret and presence-of-placeholder are
 *      different claims, and only the second was ever capable of failing.
 *
 *   C. sink intact, and brigadier NEVER DELIVERS the secret to the worker
 *      → item 12 blocks — the worker's receipt reads `NO-SECRET-IN-ENVIRONMENT`,
 *        so the derivation does not derive from the granted value and the scan
 *        is reported NOT ATTEMPTED. This is amendment §10's run exactly: nothing
 *        to find, nothing found, and the old item called that containment.
 *
 * The gate's other three branches — ruling 51's whole-item refusal, a record
 * that never names the item, and a receipt that is absent rather than wrong —
 * cannot be produced by any fixture here (`bar/fakes/honest.ts` implements no
 * ownership check), so they are driven directly in the second `describe`.
 *
 * **Arm A is not decoration.** Without it, arm B's failure could be anything —
 * a broken rewrite, a fixture that no longer starts, a timeout. The pair is what
 * makes the sink the single variable.
 *
 * **Nothing is hand-injected any more.** Arms A and B are the stock fixture and
 * the stock fixture minus the sink: ONE edit between them, and no help from this
 * file. That became possible when `bar/fakes/honest.ts` stopped writing a
 * constant transcript and started writing the frames it actually exchanged —
 * the root cause of this item's original defect, and a fixture that could not
 * fail the check it is a fixture to.
 *
 * **AND THE DOUBLY-ESCAPED COPY IS STILL THERE.** `bar/fakes/vendor.ts` writes
 * `config.json` as well as `credential.txt`, so every arm still carries a copy
 * of the value in an encoding ruling 65 does not enumerate. Item 12 reports it
 * as the honest limit BAR.md states rather than as a product failure, and it is
 * kept rather than removed: a fixture that only ever leaked in forms the sink
 * can see would let the limit go unstated.
 *
 * **And the leak lands in JSON.** The worker writes `{"credential": "<secret>"}`
 * and the secret contains a quote and a backslash, so the value appears in the
 * transcript in JSON-ESCAPED form and never as the raw literal. Arm B therefore
 * also demonstrates the third defect: v1's raw-literal assertion still reports
 * zero hits on the very file that holds the secret, while the four-encoding scan
 * catches it.
 *
 * **AND THE THIRD `describe` JUDGES THE JUDGE.** Everything above reads item
 * 12's rendered RESULT, which is the right thing to assert and still leaves
 * `judgeSink` — the function that decides ruling 65's verdict — named in no test
 * at all. That debt stood for three rounds, and it is the same shape as the
 * original defect: a judge nobody has seen return anything but `pass` is
 * indistinguishable from one that cannot. So seven more arms drive the same
 * fixture, and each one is judged on the `SinkReading` ITEM 12 ASSEMBLED —
 * handed over by `takeSinkReading`, never written here — covering all six
 * blocking branches and the affirmative one, with the seven rulings asserted
 * PAIRWISE DISTINCT rather than assumed to be.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ITEM_12 from "../items/12-secret-not-persisted.ts";
import type { BarContext, BarResult, RunOptions } from "../types.ts";
import type { RecordCheck, RecordItem, RunRecord } from "./contract.ts";
import { ensureDir, pruneEmpty, removeDir, writeScript } from "./fs.ts";
import {
  type SinkReading,
  type SinkRuling,
  isInsideWorkerClone,
  judgeDelivery,
  judgeSink,
  readIntegration,
  takeSinkReading,
} from "./item12-delivery.ts";
import { productRunDir } from "./layout.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv, exec } from "./proc.ts";

/** Above the bar's own per-run deadline, for the reason `bar/fakes.test.ts` states. */
const ARM_BUDGET_MS = HARNESS_RUN_TIMEOUT_MS + 300_000;

const HONEST = fileURLToPath(new URL("../fakes/honest.ts", import.meta.url));
const VENDOR = fileURLToPath(new URL("../fakes/vendor.ts", import.meta.url));
const LIB_DIR = fileURLToPath(new URL(".", import.meta.url));

interface Rewrite {
  /** What this edit is for, quoted back in the error if its anchor is gone. */
  why: string;
  find: string;
  replace: string;
}

/**
 * A copy of the honest fixture with named edits applied, each one asserted.
 *
 * The assertion is the load-bearing part. A control built by string replacement
 * degrades silently the moment the source it patches is reworded: the copy still
 * compiles, still runs, and no longer differs from the original — at which point
 * "sink deleted" and "sink intact" are the same binary and the control reports a
 * clean pass forever. So a missing anchor is a thrown error naming the edit that
 * did not happen.
 */
function variantOf(dir: string, name: string, rewrites: readonly Rewrite[]): string {
  let source = readFileSync(HONEST, "utf8");
  // The copy lives outside `bar/fakes/`, so everything it reaches for by
  // relative path is made absolute first.
  const relocations: Rewrite[] = [
    { why: "relocate the fixture's `../lib` imports", find: 'from "../lib/', replace: `from "${LIB_DIR}` },
    {
      why: "relocate the vendor script the fixture spawns",
      find: 'fileURLToPath(new URL("./vendor.ts", import.meta.url))',
      replace: JSON.stringify(VENDOR),
    },
  ];
  for (const rewrite of [...relocations, ...rewrites]) {
    if (!source.includes(rewrite.find)) {
      throw new Error(
        `item 12's negative control could not apply "${rewrite.why}": the anchor ${JSON.stringify(rewrite.find)} ` +
          "is no longer present in bar/fakes/honest.ts. A control that silently stops controlling is worse than " +
          "no control, so this is an error rather than a skipped edit. Re-anchor it against the current fixture.",
      );
    }
    source = source.split(rewrite.find).join(rewrite.replace);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, source);
  return path;
}

/**
 * Put the transcript back the way it was before `honest.ts` was fixed: a
 * constant, carrying nothing any worker produced.
 *
 * This is the arm the coordinator asked for — a variant in which the granted
 * value never traverses ruling 65's sink at all. It is also this fixture's own
 * history: the stub below is verbatim what `honest.ts:920` used to write, and it
 * is why an independent critic could delete the sink entirely and item 12 still
 * passed. Redacting a constant and not redacting it produce identical bytes.
 */
const TRANSCRIPT_IS_A_CONSTANT: Rewrite = {
  why: "revert the transcript to the constant it was, so the sink is handed nothing",
  find: "  const transcriptBody = `${transcriptLines.join(\"\\n\")}\\n`;",
  replace: '  const transcriptBody = "turn detail\\n".repeat(30);',
};

/** Ruling 65's single sink, deleted — the critic's edit, reproduced. */
const SINK_DELETED: Rewrite = {
  why: "delete ruling 65's redaction sink entirely",
  find: "function redactGranted(text: string, secret: string | undefined): string {",
  replace: "function redactGranted(text: string, secret: string | undefined): string {\n  return text;",
};

/** A brigadier that never grants the secret. Nothing to find, and nothing found. */
const NEVER_DELIVERED: Rewrite = {
  why: "stop brigadier delivering the secret through ruling 65's environment channel",
  find:
    "        if (secretEnv !== undefined && process.env[secretEnv] !== undefined) {\n" +
    "          workerEnv[secretEnv] = process.env[secretEnv] as string;\n" +
    "        }",
  replace: "      // ruling 65's channel, deliberately removed by the negative control",
};

/**
 * The record stops attesting that a reviewer ran, while the review still runs.
 *
 * Ruling 52's reviewer is the channel that puts the worker's file on
 * brigadier's writing path, and `judgeSink` refuses to read a transcript as
 * evidence when nothing says that channel was open. This is the INSTRUMENT
 * branch: the transcript below it may look perfect, and the judge must still
 * decline to call it a pass.
 */
const REVIEWER_UNRECORDED: Rewrite = {
  why: "drop the reviewer fields from the run record, so nothing attests ruling 52's channel ran",
  find: '          ...(flag("review") ? { reviewerAgent: reviewer, reviewVerdict: verdict } : {}),',
  replace: "          // ruling 52's reviewer fields, dropped by item 12's negative control",
};

/** brigadier writes the transcript file, and writes it EMPTY. */
const TRANSCRIPT_EMPTY: Rewrite = {
  why: "write brigadier's transcript empty, so the sink cannot be read out of it either way",
  find: '  writeFileSync(join(transcripts, "full.log"), redact(transcriptBody));',
  replace: '  writeFileSync(join(transcripts, "full.log"), "");',
};

/**
 * The single-escape channel removed, leaving only the doubly-escaped copy.
 *
 * This is the fixture as it stood BEFORE 2026-08-19, reproduced deliberately:
 * `credential.txt` is kept out of the diff ruling 52 hands the reviewer, so the
 * only copy of the granted value on brigadier's writing path is the one inside
 * `config.json` — JSON-escaped on disk and escaped AGAIN by the frame carrying
 * the diff. `src/secrets/redact.ts` enumerates four flat forms and that is not
 * one of them, so the sink cannot act and this item's own scan cannot see it.
 *
 * The owner ruled on 2026-08-19 that the four encodings not composing is a
 * documented limit to RECORD, with the fixture fixed and the product left
 * alone. This arm is that record, executable: it proves the state produces a
 * BLOCKING verdict naming the encoding, rather than the silent agreement
 * between two arms that once let the sink be deleted unnoticed.
 */
const ONLY_THE_DOUBLY_ESCAPED_COPY: Rewrite = {
  why: "keep credential.txt out of the diff, leaving only the copy escaped past ruling 65's four forms",
  find: '          const diff = safeGit(clone, emptyHooks, ["diff", `${operatorHead}..HEAD`], runRoot).out;',
  replace:
    "          const diff = safeGit(clone, emptyHooks, " +
    '["diff", `${operatorHead}..HEAD`, "--", ".", ":(exclude)credential.txt"], runRoot).out;',
};

/**
 * The sink still fires; the transcript no longer names the file it fired in.
 *
 * The placeholder is then present for SOME value, which is not this item's
 * claim — the claim is that it stands where the granted value stood, in the
 * artifact that carried it. Forced rather than natural: no product state
 * observed so far redacts a diff and renames its path, and the arm exists to
 * show the branch is not decoration.
 */
const TRANSCRIPT_RENAMES_THE_LEAK_PATH: Rewrite = {
  why: "rename config.json out of the transcript, leaving the placeholder with nothing to be about",
  find: '  const transcriptBody = `${transcriptLines.join("\\n")}\\n`;',
  replace: '  const transcriptBody = `${transcriptLines.join("\\n").split("config.json").join("cfg.json")}\\n`;',
};

function asBinary(dir: string, script: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  return writeScript(
    join(dir, name),
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
  );
}

// Outside every temp root, because ruling 61 is one of the things under test.
const ROOTS = join(homedir(), ".brigadier-bar-item12");
afterAll(() => pruneEmpty(ROOTS));

/**
 * Drive item 12 directly, rather than through `bar/run.ts`.
 *
 * `runBar` reaches `bar/items/index.ts`, which imports all thirteen items — so
 * this control would go red whenever any OTHER item was mid-edit, and a control
 * that fails for reasons unrelated to what it controls is a control people
 * learn to ignore. The context below is exactly the one `runItem` builds.
 */
async function scoreItem12(
  name: string,
  rewrites: readonly Rewrite[],
): Promise<{ record: BarResult; reading: SinkReading | undefined; clean: () => void }> {
  const root = join(ROOTS, `${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  const script = variantOf(join(root, "fixture"), `honest-${name}`, rewrites);
  const binary = asBinary(join(root, "bin"), script, `brigadier-${name}`);
  const workdir = ensureDir(join(root, "12"));
  const ctx: BarContext = {
    binary,
    live: true,
    workdir,
    run: (args: string[], opts: RunOptions = {}) =>
      exec([binary, ...args], {
        cwd: opts.cwd ?? workdir,
        env: opts.env ?? baseEnv(),
        ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
        timeoutMs: opts.timeoutMs ?? 120_000,
      }),
    log: () => {},
  };
  // Anything a PREVIOUS arm left behind is discarded before this one runs, so a
  // control can never assert against another arm's evidence and call it this
  // arm's. A stale reading would pass exactly as loudly as a real one.
  takeSinkReading();
  const record = await ITEM_12.run(ctx);
  // `undefined` when the item returned before reaching gate 3 at all — which is
  // itself a fact a control must be able to see rather than paper over.
  return { record, reading: takeSinkReading(), clean: () => removeDir(root) };
}

describe("item 12's guard against the run in which nothing moved", () => {
  test(
    "ARM A — sink INTACT: the item PASSES, and the placeholder is what earns it",
    async () => {
      // The stock fixture and the stock vendor, nothing edited. `leak-secret`
      // writes the granted value as plain text as well as into JSON, so the
      // copy that rides inside a transcript frame is escaped ONCE — a form
      // `src/secrets/redact.ts` enumerates — and ruling 65's sink can act on it.
      const { record, clean } = await scoreItem12("sink-intact", []);
      try {
        expect(record.outcome).toBe("PASS");
        // EARNED, not absent: the pass rests on the placeholder standing where
        // the value would otherwise be, which is the one claim a run in which
        // nothing moved cannot satisfy.
        expect(record.observed).toContain("ruling 65's sink FIRED");
        // And the limit is still stated in the same breath, because the JSON
        // copy is still there and still outside the enumerated four.
        expect(record.observed).toContain("JSON-ESCAPED TWICE");
      } finally {
        clean();
      }
    },
    ARM_BUDGET_MS,
  );

  test(
    "ARM B — THE CONTROL: with the sink DELETED the item FAILS and names the leak",
    async () => {
      // ONE edit from arm A, and the verdict flips. That is what a control is,
      // and until 2026-08-19 this pair could not produce it: the only channel
      // carrying the granted value re-encoded it past the four enumerated forms,
      // so deleting ruling 65's sink changed nothing observable and an
      // independent critic deleted it with every item still green.
      const { record, clean } = await scoreItem12("sink-deleted", [SINK_DELETED]);
      try {
        expect(record.outcome).toBe("FAIL");
        const reason = record.reason ?? "";
        expect(reason).toContain("ruling 65's sink did NOT fire");
        // The reader is sent to the leak rather than to a complaint about the
        // channel: the value is PRESENT, and the artefacts holding it are named.
        expect(reason).toContain("the granted value is PRESENT");
        expect(record.observed).not.toContain("and found none");
      } finally {
        clean();
      }
    },
    ARM_BUDGET_MS,
  );

  test(
    "ARM C — the secret is never delivered: blocking, never a pass on an empty scan",
    async () => {
      const { record, clean } = await scoreItem12("never-delivered", [NEVER_DELIVERED]);
      try {
        // Amendment §10's run, reproduced: nothing to find, nothing found. The
        // old item called that containment; this one refuses to.
        expect(record.outcome).toBe("FAIL");
        const reason = record.reason ?? "";
        expect(reason).toContain("ERROR — the worker's receipt does not derive from the granted value");
        expect(reason).toContain("NO-SECRET-IN-ENVIRONMENT");
        // And the scan it would otherwise have called a pass is reported as not
        // attempted, rather than as an absence.
        expect(record.observed).toContain("NOT-RUN — ruling 50's base-tree scan");
        expect(record.observed).not.toContain("and found none");
      } finally {
        clean();
      }
    },
    ARM_BUDGET_MS,
  );

  test(
    "ARM D — the transcript is a constant, so the value never traverses the sink: error naming the MISSING placeholder",
    async () => {
      // `honest.ts`'s transcript put back the way it was: a constant. The
      // granted value never reaches brigadier's writing path, so ruling 65's
      // sink is never handed anything to redact — which is exactly why deleting
      // that sink went unnoticed. Before the placeholder assertion, and with
      // this fixture as it then stood, this arm PASSED.
      const { record, clean } = await scoreItem12("never-traversed", [TRANSCRIPT_IS_A_CONSTANT]);
      try {
        expect(record.outcome).toBe("FAIL");
        const reason = record.reason ?? "";
        expect(reason).toContain("is ABSENT from brigadier's transcript");
        expect(reason).toContain("[redacted]");
        // Absence of the secret is NOT reported as containment here: the scan
        // that would have said "found none" is reported as not attempted.
        expect(record.observed).not.toContain("and found none");
        expect(record.observed).toContain("NOT-RUN — ruling 50's base-tree scan");
      } finally {
        clean();
      }
    },
    ARM_BUDGET_MS,
  );

});

/**
 * The branches the three arms above cannot reach without a fixture that lies in
 * a different way, driven directly.
 *
 * Ruling 51's refusal in particular: `bar/fakes/honest.ts` does not implement
 * the ownership check at all, so no fixture here can produce one. The record
 * shape and the exact refusal sentence are transcribed from
 * `src/integrate/ownership.ts` — nothing under `bar/` imports from `src/` — and
 * the point of asserting on the STRAYED PATH rather than on the outcome is that
 * a reader has to be sent to the plan that under-declared it.
 */
describe("the gate's remaining branches, driven directly", () => {
  const reading = (checks: RecordCheck[] | undefined, status: RecordItem["status"] = "failed"): RunRecord => ({
    runId: "r1",
    integrationRef: "refs/heads/brigadier/r1",
    base: { ref: "refs/brigadier/r1/base", sha: "b".repeat(40) },
    runRoot: "/home/me/.brigadier/runs/r1",
    bindingFilter: "the plan had 1 item(s)",
    workers: 1,
    refusedDelegations: 0,
    items: [{ id: "leaker", number: 1, status, ...(checks === undefined ? {} : { checks }) }],
  });

  const OWNERSHIP_DETAIL =
    "item 1 wrote outside its declared paths and is rejected WHOLE — delivery-proof.txt. None of its " +
    "work is integrated, including the files it did declare: keeping the obedient half would produce a " +
    "tree nobody wrote and nobody reviewed. Its ref is left in place for inspection.";

  const base = {
    itemId: "leaker",
    proofPath: "delivery-proof.txt",
    nonce: "n-1",
    expectedProof: "d162763006839e4bfe20bc46",
  };

  test("ruling 51 rejected the item WHOLE — error, and it names the strayed path", () => {
    const integration = readIntegration(
      reading([{ name: "integrate item 1", outcome: "fail", blocking: true, qualifier: "ownership", detail: OWNERSHIP_DETAIL }]),
      "leaker",
    );
    expect(integration.ownershipRejected).toBe(true);
    expect(integration.strayed).toEqual(["delivery-proof.txt"]);
    const ruling = judgeDelivery({ ...base, integration, proofInTree: undefined });
    expect(ruling.verdict).toBe("error");
    expect(ruling.detail).toContain("delivery-proof.txt");
    expect(ruling.name).toContain("ruling 51 rejected item");
  });

  test("the record does not name the item at all — error, not an absence", () => {
    const integration = readIntegration(
      { ...reading(undefined), items: [] },
      "leaker",
    );
    expect(integration.found).toBe(false);
    expect(judgeDelivery({ ...base, integration, proofInTree: undefined }).verdict).toBe("error");
  });

  test("the derivation never reached the merged tree — error, never a pass (BAR.md's own word)", () => {
    const integration = readIntegration(reading([], "integrated"), "leaker");
    const ruling = judgeDelivery({ ...base, integration, proofInTree: undefined });
    expect(ruling.verdict).toBe("error");
    expect(ruling.name).toContain("the granted secret never reached the worker");
  });

  test("ruling 59: the fixture emits an IDENTITY, not the literal `x`", () => {
    // `src/agent/marker.ts`'s `workerIdentity` parses the tail of
    // `BRIGADIER_WORKER=<run-id>/<item>` and returns null unless it is an
    // integer >= 1 — so the `${runId}/x` this fixture used to emit made a
    // refusing worker report `no-home` and per-item attribution impossible.
    // Transcribed rather than imported, and asserted against the fixture's
    // source so the literal cannot come back unnoticed.
    const source = readFileSync(HONEST, "utf8");
    expect(source).not.toContain("`${options.runId}/x`");
    expect(source).toContain("[WORKER_MARKER]: `${options.runId}/${options.item}`");
    const identity = (value: string): { runId: string; item: number } | null => {
      const slash = value.lastIndexOf("/");
      if (slash <= 0) return null;
      const item = Number(value.slice(slash + 1));
      return Number.isInteger(item) && item >= 1 ? { runId: value.slice(0, slash), item } : null;
    };
    expect(identity("run-abc/x")).toBeNull();
    expect(identity("run-abc/1")).toEqual({ runId: "run-abc", item: 1 });
  });

  test("a hit inside a worker's clone is out of scope; one beside it is not", () => {
    // BAR.md names the round-9 path. The classification is by the product's own
    // directory shape, so `r/<run>/<n>/…` is the worker's and everything else
    // under the run root is brigadier's.
    const runDir = productRunDir();
    expect(isInsideWorkerClone(`${runDir}/run-abc/1/config.json`, runDir)).toBe(true);
    expect(isInsideWorkerClone(`${runDir}/run-abc/1/src/deep/nested.txt`, runDir)).toBe(true);
    expect(isInsideWorkerClone(`${runDir}/run-abc/record.json`, runDir)).toBe(false);
    expect(isInsideWorkerClone(`${runDir}/run-abc/transcripts/full.log`, runDir)).toBe(false);
    expect(isInsideWorkerClone(`${runDir}/run-abc/state/manifest.json`, runDir)).toBe(false);
    expect(isInsideWorkerClone("manifest.json", runDir)).toBe(false);
  });

  test("the derivation is there and derives from the granted value — pass", () => {
    const integration = readIntegration(reading([], "integrated"), "leaker");
    const ruling = judgeDelivery({ ...base, integration, proofInTree: `${base.expectedProof}\n` });
    expect(ruling.verdict).toBe("pass");
  });

  test("the refusal parser survives a wording it cannot read, rather than passing", () => {
    const integration = readIntegration(
      reading([{ name: "integrate item 1", outcome: "fail", blocking: true, qualifier: "ownership", detail: "reworded beyond recognition" }]),
      "leaker",
    );
    expect(integration.ownershipRejected).toBe(true);
    expect(judgeDelivery({ ...base, integration, proofInTree: undefined }).verdict).toBe("error");
  });
});

/**
 * `judgeSink` ITSELF, against readings the product assembled.
 *
 * The arms above drive item 12 end to end and read its rendered result, which
 * settles what the ITEM does. It leaves `judgeSink` — the function that decides
 * ruling 65's redaction verdict — named in no test at all, and a judge nobody
 * has seen return anything but `pass` is indistinguishable from a judge that
 * cannot. That gap stood for three rounds.
 *
 * **The readings are not written here.** Each arm drives `bar/fakes/honest.ts`,
 * item 12 assembles the `SinkReading` from that run's evidence exactly as it
 * does in anger, and `takeSinkReading` hands back THAT struct to be judged
 * again. A control that hand-wrote a reading would prove only that a function
 * branches on its argument — never that the call site at
 * `bar/items/12-secret-not-persisted.ts:427` can produce the state the branch
 * describes, which is precisely the distinction a deleted sink hid behind once.
 *
 * **Seven arms, one edit each, and every blocking branch.** `judgeSink` has six
 * blocking branches and one affirmative one; all seven are driven below, and the
 * last test asserts the seven rulings are PAIRWISE DISTINCT rather than assuming
 * it. Arms A and B of the first `describe` were byte-identical until 2026-08-19
 * and that was the finding, not a defect — so identity is checked here, never
 * taken on trust.
 *
 * `Item12Verdict`'s fourth value, `not-run`, is NOT among the seven and cannot
 * be: no branch of `judgeSink` returns it, and the item reports it for the
 * assertions downstream of a blocking verdict instead. That is asserted against
 * the function's own source rather than left as a claim in a comment.
 */
describe("judgeSink itself, judged on readings the product assembled", () => {
  /** Every ruling this describe has produced, by arm, for the identity check. */
  const SEEN = new Map<string, SinkRuling>();

  /** Verdict, name and detail as one string — what "identical" has to mean. */
  const render = (r: SinkRuling): string => `${r.verdict}\n${r.name}\n${r.detail}`;

  /** How many transcript lines carry ruling 65's placeholder. */
  const withPlaceholder = (r: SinkReading): number =>
    r.transcriptLines.filter((l) => l.includes(r.placeholder)).length;

  /**
   * Drive one arm, take the reading ITEM 12 assembled, and judge that.
   *
   * A reading of `undefined` means the item returned before gate 3 — the arm
   * controlled nothing, and that is an error naming the outcome rather than a
   * quiet skip. `bar/lib/checks.ts` calls the alternative a `SKIPPED` in a
   * note's clothing, and it is no better in a test file.
   */
  async function ruleOn(
    arm: string,
    rewrites: readonly Rewrite[],
  ): Promise<{ reading: SinkReading; ruling: SinkRuling; record: BarResult }> {
    const { record, reading, clean } = await scoreItem12(arm, rewrites);
    try {
      if (reading === undefined) {
        throw new Error(
          `arm "${arm}" never reached judgeSink — item 12 returned ${record.outcome} from an earlier gate ` +
            `(${record.reason ?? "no reason given"}). This arm controls NOTHING as written: re-anchor it on a ` +
            "fixture edit that leaves gates 1 and 2 passing, or the sink judge is again untested.",
        );
      }
      const ruling = judgeSink(reading);
      SEEN.set(arm, ruling);
      return { reading, ruling, record };
    } finally {
      // Judging re-arms the capture slot; drop what this call left there so the
      // next arm cannot inherit it. In `finally` rather than after `judgeSink`
      // because a throwing judge would otherwise leave the slot armed for the
      // next arm to read. Harmless today only because `scoreItem12` pre-clears
      // before every arm — which is a second reader's invariant, not this
      // function's, and this costs one move.
      takeSinkReading();
      clean();
    }
  }

  test(
    "THE CONTROL — one asserted edit to the fixture, and judgeSink's verdict flips pass → fail",
    async () => {
      // ONE edit apart: the stock fixture, and the stock fixture with ruling
      // 65's sink deleted. Both readings are assembled by item 12 out of a real
      // run; nothing below is written by hand.
      const green = await ruleOn("judge-sink-intact", []);
      const red = await ruleOn("judge-sink-deleted", [SINK_DELETED]);

      expect(green.ruling.verdict).toBe("pass");
      expect(red.ruling.verdict).toBe("fail");
      // The blocking verdict is not merely non-pass: it names the LEAK, and the
      // item's assertion at the call site blocks on `verdict === "pass"`.
      expect(red.ruling.name).toContain("ruling 65's sink did NOT fire");
      expect(red.ruling.detail).toContain("came out the other side unchanged");

      // ASSERTED, not assumed. Arms A and B of the first describe were
      // byte-identical until 2026-08-19 while looking like a working control.
      expect(render(red.ruling)).not.toBe(render(green.ruling));

      // And the readings differ in exactly what deleting the sink controls:
      // the placeholder stops standing in the transcript, and the raw value
      // starts being found in brigadier's own artifacts.
      expect(withPlaceholder(green.reading)).toBeGreaterThan(0);
      expect(withPlaceholder(red.reading)).toBe(0);
      expect(green.reading.leaksFound).toEqual([]);
      expect(red.reading.leaksFound.length).toBeGreaterThan(0);

      // Everything else the judge branches on holds on BOTH sides, so the flip
      // cannot be some other branch firing: same file, same placeholder, a
      // reviewer recorded either way, and a transcript that was really read.
      expect(red.reading.leakPath).toBe(green.reading.leakPath);
      expect(red.reading.placeholder).toBe(green.reading.placeholder);
      for (const reading of [green.reading, red.reading]) {
        expect(reading.reviewerAgent).toBeDefined();
        expect(reading.reviewVerdict).toBeDefined();
        expect(reading.reviewVerdict).not.toBe("not-run");
        expect(reading.transcriptLines.length).toBeGreaterThan(0);
        expect(reading.transcriptPath ?? "").toContain("full.log");
      }
    },
    ARM_BUDGET_MS,
  );

  test(
    "BLOCKING — the record does not attest ruling 52's reviewer, so the channel is unproven",
    async () => {
      const { reading, ruling, record } = await ruleOn("judge-sink-no-reviewer", [REVIEWER_UNRECORDED]);
      expect(reading.reviewerAgent).toBeUndefined();
      expect(ruling.verdict).toBe("error");
      expect(ruling.name).toContain("never reached brigadier's writing path");
      expect(ruling.detail).toContain("INSTRUMENT failure");
      // The item blocks on it rather than reporting an absence as containment.
      expect(record.outcome).toBe("FAIL");
    },
    ARM_BUDGET_MS,
  );

  test(
    "BLOCKING — brigadier's transcript is empty, so the sink cannot be shown to have fired",
    async () => {
      const { reading, ruling, record } = await ruleOn("judge-sink-empty-transcript", [TRANSCRIPT_EMPTY]);
      expect(reading.transcriptLines).toEqual([]);
      expect(ruling.verdict).toBe("error");
      expect(ruling.name).toContain("could not be read");
      expect(record.outcome).toBe("FAIL");
    },
    ARM_BUDGET_MS,
  );

  test(
    "BLOCKING — only the doubly-escaped copy travels: the documented limit, reported as one",
    async () => {
      // The pre-2026-08-19 fixture, reproduced. The owner ruled this a limit to
      // RECORD with the fixture fixed and the product untouched, so the arm
      // asserts the judge says exactly that — not "the value never arrived",
      // which would send a reader to the channel when the fault is the encoding.
      const { reading, ruling, record } = await ruleOn("judge-sink-double-escaped", [ONLY_THE_DOUBLY_ESCAPED_COPY]);
      expect(reading.doubleEscapedInTranscript).toBe(true);
      expect(withPlaceholder(reading)).toBe(0);
      expect(reading.leaksFound).toEqual([]);
      expect(ruling.verdict).toBe("error");
      expect(ruling.name).toContain("RE-ENCODED past ruling 65's four forms");
      expect(ruling.detail).toContain("NOT A PRODUCT FAILURE");
      expect(record.outcome).toBe("FAIL");
    },
    ARM_BUDGET_MS,
  );

  test(
    "BLOCKING — the transcript is a constant, so the placeholder is absent and the value is nowhere",
    async () => {
      const { reading, ruling } = await ruleOn("judge-sink-constant", [TRANSCRIPT_IS_A_CONSTANT]);
      expect(withPlaceholder(reading)).toBe(0);
      expect(reading.leaksFound).toEqual([]);
      expect(reading.doubleEscapedInTranscript).toBe(false);
      expect(ruling.verdict).toBe("error");
      expect(ruling.name).toContain("is ABSENT from brigadier's transcript");
      expect(ruling.detail).toContain("proved NOTHING");
    },
    ARM_BUDGET_MS,
  );

  test(
    "BLOCKING — the placeholder stands, but the transcript never names the file it stood in",
    async () => {
      const { reading, ruling } = await ruleOn("judge-sink-unnamed-file", [TRANSCRIPT_RENAMES_THE_LEAK_PATH]);
      expect(withPlaceholder(reading)).toBeGreaterThan(0);
      expect(reading.transcriptLines.filter((l) => l.includes(reading.leakPath))).toEqual([]);
      expect(ruling.verdict).toBe("error");
      expect(ruling.name).toContain("never names");
      expect(ruling.detail).toContain("for some OTHER value");
    },
    ARM_BUDGET_MS,
  );

  test("seven arms, seven DIFFERENT rulings, and no branch answers `not-run`", () => {
    // If an arm above failed, this reports it as a coverage hole rather than
    // passing on the arms that did run.
    expect([...SEEN.keys()].sort()).toEqual([
      "judge-sink-constant",
      "judge-sink-deleted",
      "judge-sink-double-escaped",
      "judge-sink-empty-transcript",
      "judge-sink-intact",
      "judge-sink-no-reviewer",
      "judge-sink-unnamed-file",
    ]);
    // ONE affirmative verdict and six blocking ones — the whole enumeration.
    const verdicts = [...SEEN.values()].map((r) => r.verdict);
    expect(verdicts.filter((v) => v === "pass")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "fail")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "error")).toHaveLength(5);
    // PAIRWISE DISTINCT, by identity. Two arms that render the same bytes are
    // not two arms; that is what happened here before and it looked like health.
    expect(new Set([...SEEN.values()].map(render)).size).toBe(SEEN.size);

    // `not-run` is unreachable from this judge — every gate above it passed by
    // the time it is called, so the premise always held. Asserted against the
    // function's own body so a branch that started answering it would be a red
    // test rather than an unnoticed seventh blocking verdict.
    const source = readFileSync(fileURLToPath(new URL("./item12-delivery.ts", import.meta.url)), "utf8");
    const body = source.slice(source.indexOf("export function judgeSink"));
    const end = body.indexOf("\n}\n");
    expect(end).toBeGreaterThan(0);
    expect(body.slice(0, end)).not.toContain('verdict: "not-run"');
  });
});
