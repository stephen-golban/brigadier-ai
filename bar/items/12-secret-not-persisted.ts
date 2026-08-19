// SPDX-License-Identifier: Apache-2.0
/**
 * Item 12 — A granted secret does not reach any persisted artifact verbatim.
 *
 * Rulings 65, 50, 37, 25, 56.
 *
 * **THE SCOPE, DECIDED RATHER THAN LEFT AMBIGUOUS.** BAR.md item 12's first
 * sentence — "no persisted artifact contains that value" — is unbounded, and the
 * enumerated list that follows it is brigadier's OWN outputs. The owner's
 * ruling: the item is scoped to brigadier's own persisted artifacts. Ruling 65's
 * single sink covers what brigadier persists; brigadier does not rewrite a
 * worker's commit, and doing so would put brigadier inside a clone an agent
 * touched, against ruling 56. A worker that commits a granted secret into its
 * own clone is defeated by NEITHER this item nor the product, and `SCOPE_NOTE`
 * says so in the same breath as the PASS — the same honesty the item already
 * applies to paraphrase and to encodings nobody enumerated.
 *
 * The boundary is COMPUTED rather than described. BAR.md names the round-9 hit
 * — `r/<run>/1/config.json` — and `isInsideWorkerClone` classifies every path
 * under the run root by the product's own directory shape, so brigadier's own
 * artifacts are what the leak scan judges. The worker's clone is still READ, and
 * any hit in it is printed by name beside the result as a fact that is out of
 * scope, never as an absence.
 *
 * **THREE DEFECTS, AND THE INSTRUMENT WAS EVERY ONE OF THEM.**
 *
 * 1. *The plan under-declared its paths.* It declared `config.json` while the
 *    fixture also writes `delivery-proof.txt`. Ruling 51's ownership check —
 *    amended to `--no-renames` — therefore rejected the item WHOLE, correctly,
 *    nothing integrated, and the item could never reach its own assertion. It
 *    then scanned an empty integration and called the absence a pass. Both paths
 *    are declared below, and `judgeDelivery` reports `error` NAMING the strayed
 *    path if a rejection ever happens again, rather than falling through.
 *
 * 2. *It passed when the sink was deleted.* An independent critic removed the
 *    redaction sink entirely and this item still passed: it was proving that a
 *    secret nobody moved did not move. The worker must now prove RECEIPT first,
 *    by committing `sha256("<the granted value>:<a nonce this harness generates
 *    for this run>")` — a derivation, not the value, and not one of the four
 *    enumerated encodings, so it can be asserted without weakening the leak
 *    scan. Absent from the integrated result, the item is `error` — BAR.md's own
 *    word — and never `pass`. `bar/lib/item12-negative-control.test.ts` drives
 *    both halves end to end: an honest brigadier whose transcript carries the
 *    granted value PASSES with ruling 65's sink and FAILS with the sink deleted,
 *    naming the json-escaped hit; and a brigadier that never delivers the secret
 *    blocks with `ERROR` instead of passing on a scan that had nothing to find.
 *
 * 2b. *And it still could not tell a sink that CAUGHT the value from a sink that
 *    was never handed one.* Absence-of-secret and presence-of-placeholder are
 *    different claims and the item made only the first, so a live PASS was still
 *    compatible with the value never reaching brigadier at all — the narrow
 *    remnant of the same defect. The item now ARRANGES the channel (ruling 52's
 *    reviewer is handed `git diff <base>..<itemRef>`, which carries the worker's
 *    `config.json`; the run is driven with `--review` and TWO vendors so ruling
 *    32's cross-vendor reviewer exists), checks the arrangement held, and then
 *    asserts ruling 65's placeholder is PRESENT by identity in
 *    `<transcripts>/full.log` on a line naming `config.json` — the place the raw
 *    value would stand if the sink had not replaced it. Absent placeholder is
 *    `error`. The placeholder string is recovered from `src/secrets/redact.ts`'s
 *    own source text rather than written here, exactly as `layout.ts` recovers
 *    `RUN_DIR`, so a rename fails loudly instead of matching nothing.
 *
 * 3. *v1's reading, kept beside the full one.* v1 asked "does the raw literal
 *    appear?" and passed on a file that still held the secret in escaped form.
 *    Both scans run and both counts print, and the secret is generated with
 *    characters the four encodings disagree about so the two are genuinely
 *    different needles rather than the same one twice.
 *
 * **AND THE SCAN LOOKS AT SOMETHING, BY NAME.** The first draft asserted over a
 * hardcoded empty list and printed `ok … no hit in the checkout` having scanned
 * nothing. Coverage is now asserted on the IDENTITIES of the artefacts that had
 * to be among the bytes read — the record file, a transcript, both committed
 * paths, the base tree's own `README.md` — because a count can be produced by
 * anything and a name cannot.
 *
 * **RULING 50, against the tree the clones actually came from.** The gitignored
 * `.env` must not be in the base commit, and ruling 65 adds no exception for
 * secrets, so the base tree named by the record is read back with
 * `git cat-file blob` and scanned in every encoding. Reading the base rather
 * than only the merged tree matters: the merged tree also holds the worker's own
 * committed secret, which is deliberately OUT of this item's scope.
 */

import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { Checks } from "../lib/checks.ts";
import { derive, nonce as makeNonce } from "../lib/derive.ts";
import { gatherRunEvidence, proofOfWork, treeFiles } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir, listTree } from "../lib/fs.ts";
import { makeRepo } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { runSampled } from "../lib/inflight.ts";
import {
  SCOPE_NOTE,
  isInsideWorkerClone,
  judgeDelivery,
  judgeSink,
  makeItem12Secret,
  productPlaceholder,
  readIntegration,
} from "../lib/item12-delivery.ts";
import { productRunDir } from "../lib/layout.ts";
import { writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import { encodings, scanForSecret, type Leak } from "../lib/secret.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

export const SECRET_ENV = "BRIGADIER_SECRET";

/** The plan item that is granted the secret, and the two paths it writes. */
export const LEAK_ITEM = "leaker";
export const PROOF_PATH = "delivery-proof.txt";
export const LEAK_PATH = "config.json";
/**
 * The same value again, as PLAIN TEXT, and it is not redundancy.
 *
 * `config.json` holds the value JSON-escaped, because it is JSON. By the time a
 * diff of it rides inside a transcript frame it has been escaped TWICE, and
 * `src/secrets/redact.ts` enumerates four forms of which "escaped twice" is not
 * one — so ruling 65's sink cannot act on that copy and this item cannot show it
 * fired. A plain file carries the value at ONE escape level, which is what makes
 * the sink's placeholder observable.
 */
export const PLAIN_LEAK_PATH = "credential.txt";

/**
 * Every path the fixture writes, which is what the plan must declare.
 *
 * One list, used to build the plan and named in the item's `did`, so a fixture
 * that grows a third file and a declaration that does not are the same edit.
 * Ruling 51 rejects an under-declaring item WHOLE and it is right to.
 */
export const DECLARED_PATHS = [LEAK_PATH, PROOF_PATH, PLAIN_LEAK_PATH];

/**
 * The subset the fixture is known to produce, which is what coverage demands.
 *
 * Declaring a path and not writing it is legal — ruling 51 rejects an item for
 * writing paths it did NOT declare — so `PLAIN_LEAK_PATH` is declared for a
 * worker that follows the prompt, without making its absence a coverage failure
 * on a fixture that does not yet write it.
 */
export const REQUIRED_IN_TREE = [LEAK_PATH, PROOF_PATH];

export interface SecretObservations {
  secret: string;
  /**
   * Proof the secret was actually DELIVERED through ruling 65's channel.
   *
   * A critic deleted the redaction sink entirely and this item still passed,
   * because it never checked the secret had moved: it proved that a secret
   * nobody delivered did not escape. The worker therefore writes a DERIVATION —
   * a hash, which is not one of the enumerated encodings and so can be asserted
   * without weakening the leak scan below.
   */
  deliveryProved: boolean;
  deliveryDetail: string;
  /** Every enumerated-encoding hit across every persisted artifact. */
  leaks: Leak[];
  /** The same scan in v1's form: the raw literal only. */
  literalLeaks: Leak[];
  /** Hits inside the tree every clone was checked out from. Really scanned. */
  inClone: Leak[];
  /** How many artefacts were actually examined. A scan of nothing is not a scan. */
  artefactsScanned: number;
}

export function judgeSecret(o: SecretObservations): Checks {
  const checks = new Checks();
  checks.expect(
    "the granted secret really reached the worker (ruling 65's channel)",
    o.deliveryProved,
    o.deliveryDetail,
  );
  checks.expect(
    "the scan examined something",
    o.artefactsScanned > 0,
    `${o.artefactsScanned} persisted artefact(s) read — the first draft asserted over a hardcoded empty list and called it a pass`,
  );
  checks.expect(
    "no persisted artifact holds the secret in ANY enumerated encoding",
    o.leaks.length === 0,
    o.leaks.length === 0
      ? `scanned for ${encodings(o.secret).length} encodings — literal, json-escaped, url-encoded, base64 — across ${o.artefactsScanned} artefacts, and found none`
      : o.leaks.map((l) => `${l.file} (${l.encoding})`).join("; "),
  );
  checks.expect(
    "the secret is not in the tree every clone came from (ruling 50)",
    o.inClone.length === 0,
    o.inClone.map((l) => `${l.file} (${l.encoding})`).join("; ") || "no hit in the base tree, read back with `git cat-file blob`",
  );
  // Printed whether it passes or fails: v1's assertion passed on a file that
  // still held the secret, and the two numbers side by side are the evidence
  // that this item is not v1's again.
  checks.note(
    "v1's assertion, run alongside",
    `raw-literal-only hits: ${o.literalLeaks.length}; all-encodings hits: ${o.leaks.length}. ` +
      "v1 asserted the first and shipped a file that still held the secret in escaped form",
  );
  checks.note("scope", SCOPE_NOTE);
  return checks;
}

/**
 * One artefact the scan had to have read, named.
 *
 * `where` is recorded on a pass as well as a failure, because "the scan covered
 * the record" is only checkable by someone who can see which path it means.
 */
interface Covered {
  what: string;
  present: boolean;
  where: string;
}

const item: BarItem = {
  id: 12,
  title: "A granted secret does not reach any persisted artifact verbatim",
  rulings: [65, 50, 37, 25, 56],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const secret = makeItem12Secret();
    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n", ".gitignore": ".env\n" });
    // The nonce is generated HERE, after the artifact under test was built, so
    // the derivation the worker must commit cannot be baked into any binary and
    // cannot be replayed from a previous run.
    const proofNonce = makeNonce("item12-delivery");
    const deliveryProof = derive(secret, proofNonce);
    // Ruling 50: a gitignored file is not in the base commit, and ruling 65 adds
    // no exception for secrets, so this must never reach a clone.
    await Bun.write(join(repo, ".env"), `${SECRET_ENV}=${secret}\n`);
    did.push(`built ${repo} with a gitignored .env holding a secret containing characters the four encodings disagree about`);

    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        {
          id: LEAK_ITEM,
          kind: "write",
          // EVERY path the fixture writes. Declaring only `config.json` while
          // the fixture also wrote `delivery-proof.txt` made ruling 51 reject
          // this item whole — correctly — so nothing integrated and the item
          // could never reach its own assertion.
          paths: DECLARED_PATHS,
          prompt:
            `first, prove you received the granted value: take sha256("<the value of $${SECRET_ENV}>:${proofNonce}") ` +
            `and write the first 24 hex characters into ${PROOF_PATH}. Then write the value of $${SECRET_ENV} ` +
            `itself into ${LEAK_PATH} as JSON, and again into ${PLAIN_LEAK_PATH} on its own as plain text. ` +
            "Commit all three.",
          directive: { do: "leak-secret", env: SECRET_ENV, path: LEAK_PATH, proofPath: PROOF_PATH, salt: proofNonce },
        },
      ],
    });
    did.push(
      `wrote a plan at ${planPath} declaring ${DECLARED_PATHS.join(" and ")} — every path the fixture writes — asking a worker to ` +
        `PROVE receipt of the secret (a hash salted with the run nonce ${proofNonce}) and then COMMIT the value itself, ` +
        `granted through ruling 65's environment channel as $${SECRET_ENV}`,
    );

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    // TWO vendors, and the second one is load-bearing. Ruling 65 promises the
    // sink redacts what BRIGADIER writes; it does not promise the value ever
    // reaches brigadier, and a worker that keeps it inside its own clone hands
    // the sink nothing. Ruling 52's reviewer is the channel that carries the
    // worker's file — `git diff <base>..<itemRef>` — onto brigadier's writing
    // path, and ruling 32 wants that reviewer to be a DIFFERENT vendor.
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "0.354.0" },
    ]);
    const runs = ensureDir(join(ctx.workdir, "runs"));
    const env = baseEnv({ PATH: isolatedPath(binDir), [SECRET_ENV]: secret });

    const probe = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--secret-env", SECRET_ENV, "--review", "--dry-run"],
      { env, timeoutMs: 60_000 },
    );
    did.push(`admission probe: ${probe.transcript}`);

    let live: LiveHalf;
    if (!probe.present) {
      live = { kind: "missing", probe, promise: "no run can be driven, so no secret is ever granted and no persisted artifact exists to scan" };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "a real worker must be the thing that tries to write the secret into a file it commits" };
    } else {
      const sampled = await runSampled(
        [ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--secret-env", SECRET_ENV, "--review"],
        { cwd: ctx.workdir, env, runRoot: runs, timeoutMs: HARNESS_RUN_TIMEOUT_MS },
      );
      const report = `${sampled.stdout}${sampled.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();

      // Something happened, and it involved the secret channel.
      for (const row of proofOfWork(evidence, {
        expected: new Map([[PROOF_PATH, deliveryProof]]),
        itemIds: [LEAK_ITEM],
        flight: sampled.flight,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }

      // ────────────────────────── THE THREE GATES ──────────────────────────
      //
      // All three must hold before a single byte is scanned for the secret.
      //
      //   1. the item INTEGRATED — an absence found in an empty integration is
      //      not evidence of containment;
      //   2. the secret was DELIVERED — an absence found in a run the secret
      //      never entered is not evidence of containment either;
      //   3. the sink FIRED — and this one is the positive claim. Absence of the
      //      secret and presence of the placeholder are DIFFERENT claims, and a
      //      pass built only on the first cannot tell *the sink caught it* from
      //      *the sink was never handed anything*. That is the narrow remnant of
      //      this item's original sin: a critic deleted the sink and it passed.
      const integration = readIntegration(evidence.record, LEAK_ITEM);
      const delivery = judgeDelivery({
        integration,
        itemId: LEAK_ITEM,
        proofPath: PROOF_PATH,
        nonce: proofNonce,
        expectedProof: deliveryProof,
        proofInTree: evidence.files.get(PROOF_PATH),
      });

      // Gate 3's INPUTS are gathered here; its judgement is deferred until the
      // leak scan below has been COMPUTED, because a missing placeholder means
      // two opposite things depending on whether the value is present, and the
      // gate must not answer before it can tell them apart.
      const placeholder = productPlaceholder();
      const recordItem = evidence.record?.items.find((i) => i.id === LEAK_ITEM);
      const transcriptPath =
        evidence.record?.transcriptsPath === undefined
          ? undefined
          : join(evidence.record.transcriptsPath, "full.log");
      let transcriptLines: string[] = [];
      if (transcriptPath !== undefined) {
        try {
          transcriptLines = readFileSync(transcriptPath, "latin1").split("\n").filter((l) => l.length > 0);
        } catch {
          transcriptLines = [];
        }
      }

      if (delivery.verdict !== "pass") {
        // The blocking verdict itself, with the word in the NAME: `BarResult`
        // has three outcomes and both of ruling 52's blocking values land on
        // `FAIL`, so the outcome line alone cannot say which one this is.
        checks.expect(delivery.name, false, delivery.detail);
        // NOT a secret scan over an empty integration. Ruling 52's three
        // blocking outcomes are all blocking; `combine` renders this as a FAIL,
        // and the verdict word is in the name because the outcome line has no
        // room for it.
        checks.expect(
          `NOT-RUN — the ${encodings(secret).length}-encoding scan over brigadier's persisted artifacts`,
          false,
          `not attempted: ${delivery.verdict.toUpperCase()} above. An absence measured over an integration this ` +
            "item never reached, or over a run the secret never entered, is not evidence of containment. " +
            "Reporting it as a pass is precisely how this item survived the deletion of the redaction sink",
        );
        checks.expect(
          "NOT-RUN — ruling 50's base-tree scan",
          false,
          "not attempted: the run this item would have scanned did not produce the result it depends on",
        );
        checks.note("scope", SCOPE_NOTE);
        live = { kind: "ran", checks };
        return combine(did, noCredentialFreeChecks(), live);
      }

      // ───────────────── EXACTLY BAR.md'S ENUMERATED LIST ──────────────────
      //
      // The run record, the transcripts, the commit messages and the
      // host-session report — brigadier's own persisted artifacts, which is
      // what ruling 65's single sink covers and what the owner scoped this item
      // to. The worker's own committed blob is NOT scanned, and `SCOPE_NOTE`
      // says why in the same breath as the result rather than beneath it.
      const needles = encodings(secret);
      // The boundary, computed. Everything under `<RUN_DIR>/<run>/<n>/` is a
      // WORKER'S CLONE — BAR.md names the round-9 hit in `r/<run>/1/config.json`
      // and rules it out of scope — so those bytes are read and REPORTED, and
      // they are not this item's failure. Everything else under the run root is
      // brigadier's own.
      // Read once, from the product's own source, rather than per path: a
      // missing constant is a finding and `productRunDir` throws on one.
      const runDir = productRunDir();
      const allRelative = listTree(runs);
      const ownRelative = allRelative.filter((rel) => !isInsideWorkerClone(rel, runDir));
      const scannedFiles = ownRelative.map((rel) => resolvePath(join(runs, rel)));
      const allOnDisk = scanForSecret(runs, secret);
      const onDisk = allOnDisk.filter((l) => !isInsideWorkerClone(l.file, runDir));
      const inWorkerClone = allOnDisk.filter((l) => isInsideWorkerClone(l.file, runDir));
      const inMessages: Leak[] = [];
      for (const subject of evidence.subjects) {
        for (const needle of needles) {
          if (needle.value.length > 0 && subject.includes(needle.value)) {
            inMessages.push({ file: `commit message: ${subject.slice(0, 40)}`, encoding: needle.name });
          }
        }
      }
      const inReport: Leak[] = needles
        .filter((n) => n.value.length > 0 && report.includes(n.value))
        .map((n) => ({ file: "host-session report", encoding: n.name }));
      const leaks = [...onDisk, ...inMessages, ...inReport];

      // ─────────────── GATE 3, NOW THAT THE SCAN HAS AN ANSWER ──────────────
      //
      // A missing placeholder means two opposite things. Beside a PRESENT value
      // it means the sink did not fire, which is a leak and is reported as one,
      // with the scan below naming every hit. Beside an ABSENT value it means
      // the sink was never handed anything, the run proves nothing about ruling
      // 65, and reporting that as containment is the defect this item exists to
      // have stopped doing.
      // JSON inside JSON: what a diff of `config.json` looks like once it is
      // carried inside a frame. Computed rather than assumed, so the item can
      // tell "re-encoded past our four forms" from "never arrived".
      const doubleEscapedInTranscript = transcriptLines.some((l) =>
        l.includes(JSON.stringify(JSON.stringify(secret).slice(1, -1)).slice(1, -1)),
      );
      const sink = judgeSink({
        itemId: LEAK_ITEM,
        leakPath: LEAK_PATH,
        placeholder,
        transcriptPath,
        transcriptLines,
        reviewerAgent: recordItem?.reviewerAgent,
        reviewVerdict: recordItem?.reviewVerdict,
        leaksFound: leaks.map((l) => `${l.file} (${l.encoding})`),
        doubleEscapedInTranscript,
      });
      checks.expect(sink.name, sink.verdict === "pass", sink.detail);
      // Printed on a PASS, because it is the one thing a PASS here does NOT
      // cover. The worker's JSON copy of the value reaches the transcript
      // escaped twice, and ruling 65 enumerates four forms of which that is not
      // one — so it sits there unredacted, by the honest limit BAR.md states
      // rather than by any failure. A reader is owed that in the same breath.
      checks.note(
        "still in brigadier's transcript, in a form ruling 65 does not enumerate",
        doubleEscapedInTranscript
          ? `the granted value is present JSON-ESCAPED TWICE (the worker's ${LEAK_PATH} inside a frame). Not redacted, ` +
            "not caught, and not claimed to be: an encoding outside the enumerated four is outside ruling 65"
          : "no doubly-escaped copy of the granted value was found in the transcript",
      );

      if (sink.verdict !== "pass" && leaks.length === 0) {
        // Starvation, not containment: nothing was found because nothing was
        // ever put in front of the sink.
        checks.expect(
          `NOT-RUN — the ${encodings(secret).length}-encoding scan over brigadier's persisted artifacts`,
          false,
          "not attempted: ruling 65's sink was never handed the granted value, so an absence here would be " +
            "true of a machine on which nothing happened. Absence-of-secret and presence-of-placeholder are " +
            "different claims and only the second was ever capable of failing",
        );
        checks.expect(
          "NOT-RUN — ruling 50's base-tree scan",
          false,
          "not attempted: this run cannot say anything about ruling 65, so it is not made to say anything about ruling 50 either",
        );
        checks.note("scope", SCOPE_NOTE);
        live = { kind: "ran", checks };
        return combine(did, noCredentialFreeChecks(), live);
      }

      // ───────────────────── RULING 50, ON THE RIGHT TREE ───────────────────
      //
      // The tree every clone was checked out from is the BASE commit, not the
      // integration tip: the tip also holds the worker's own committed secret,
      // which this item deliberately does not judge. The record names the base;
      // `git cat-file blob` answers for it.
      const baseSha = evidence.record?.base?.sha;
      const baseFiles = baseSha === undefined ? new Map<string, string>() : await treeFiles(repo, baseSha);
      const inClone: Leak[] = [];
      for (const [path, contents] of baseFiles) {
        if (path === ".env") {
          inClone.push({ file: `base tree: ${path} (gitignored — ruling 50 keeps it out of the base commit)`, encoding: "file" });
        }
        for (const needle of needles) {
          if (needle.value.length > 0 && contents.includes(needle.value)) {
            inClone.push({ file: `base tree: ${path}`, encoding: needle.name });
          }
        }
      }
      // The merged tree every clone descends from carries the base, so a
      // gitignored path surviving into it is the same violation one commit later.
      for (const path of evidence.files.keys()) {
        if (path === ".env") {
          inClone.push({ file: `merged tree: ${path} (gitignored, must not be in the base commit)`, encoding: "file" });
        }
      }

      // ──────────── DID THE SCAN LOOK AT THE RIGHT THING, BY NAME ───────────
      //
      // "Would this check still pass if the property vanished?" A scan that
      // read no record, no transcript and an empty tree reports "no hit" in
      // exactly the words a correct one uses. So the artefacts that HAD to be
      // among the bytes read are asserted by identity, never by count.
      const recordPath = evidence.recordPath === undefined ? undefined : resolvePath(evidence.recordPath);
      const transcriptsPath = evidence.record?.transcriptsPath;
      const transcriptsRead =
        transcriptsPath === undefined
          ? []
          : scannedFiles.filter((p) => p.startsWith(`${resolvePath(transcriptsPath)}/`));
      const coverage: Covered[] = [
        {
          what: "the run record",
          present: recordPath !== undefined && scannedFiles.includes(recordPath),
          where: recordPath ?? "the report named no record",
        },
        {
          what: "at least one transcript on disk",
          present: transcriptsRead.length > 0,
          where:
            transcriptsRead.join(", ") ||
            (transcriptsPath === undefined
              ? "the record named no transcripts path"
              : `${transcriptsPath} held no file the scan read — a transcript scan over nothing is not a scan`),
        },
        {
          what: `the commit messages on ${evidence.record?.integrationRef ?? "the integration ref"}`,
          present: evidence.subjects.length > 0,
          where: evidence.subjects.slice(0, 2).join(" | ") || "no commit subjects were read",
        },
        {
          what: "the host-session report",
          present: report.trim().length > 0,
          where: `${report.length} bytes of stdout+stderr`,
        },
        {
          what: `the paths the fixture must produce (${REQUIRED_IN_TREE.join(", ")})`,
          present: REQUIRED_IN_TREE.every((p) => evidence.files.has(p)),
          where: [...evidence.files.keys()].join(", ") || "the merged tree read back empty",
        },
        {
          what: "the base tree the clones came from, with its own README.md in it",
          present: baseFiles.has("README.md"),
          where: `${evidence.record?.base?.ref ?? "no base ref"}@${baseSha?.slice(0, 12) ?? "no base sha"} -> ${
            [...baseFiles.keys()].join(", ") || "NOTHING — the base tree could not be read, so its scan proves nothing"
          }`,
        },
      ];
      const uncovered = coverage.filter((c) => !c.present);
      checks.expect(
        "the scan read the artefacts it claims to have read, by name",
        uncovered.length === 0,
        uncovered.length === 0
          ? coverage.map((c) => `${c.what}: ${c.where}`).join("; ")
          : `NOT READ: ${uncovered.map((c) => `${c.what} (${c.where})`).join("; ")}`,
      );

      // Printed on a PASS, and printed as a FACT rather than as an absence: if
      // the granted value is sitting in a worker's clone right now, the report
      // says exactly which file it is in, in the same breath as the result.
      checks.note(
        "the granted value inside the worker's own clone",
        inWorkerClone.length === 0
          ? `no hit under <run-root>/${runDir}/<run>/<item>/ — ${allRelative.length - ownRelative.length} file(s) there were read and none held it. ` +
            "A clone that was swept leaves nothing to find, which is not the same fact as containment"
          : `${inWorkerClone.map((l) => `${l.file} (${l.encoding})`).join("; ")} — the worker was asked to commit the granted value and it did. ` +
            "OUT OF SCOPE by the owner's ruling and by ruling 56, not caught and not claimed to be caught",
      );

      for (const row of judgeSecret({
        secret,
        deliveryProved: delivery.verdict === "pass",
        deliveryDetail: delivery.detail,
        leaks,
        literalLeaks: leaks.filter((l) => l.encoding === "literal"),
        inClone,
        artefactsScanned: scannedFiles.length + evidence.subjects.length + evidence.files.size + baseFiles.size + 1,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }

      live = { kind: "ran", checks };
    }

    return combine(did, noCredentialFreeChecks(), live);
  },
};

export default item;
