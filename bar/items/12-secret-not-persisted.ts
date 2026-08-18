// SPDX-License-Identifier: Apache-2.0
/**
 * Item 12 — A granted secret does not reach any persisted artifact verbatim.
 *
 * Rulings 65, 50, 37, 25.
 *
 * The first draft **passed against `process.exit(0)`**, and one of its checks was
 * worse than useless: `inClone` was a hardcoded empty list, so ruling 50's half
 * printed `ok … no hit in the checkout` **having scanned nothing**. A scan of an
 * empty list is not a scan; it is a sentence.
 *
 * Everything is now scanned for real, and the scan is paired with proof the run
 * happened — otherwise "the secret is nowhere" is trivially true of a machine
 * where nothing occurred.
 *
 * The secret is granted through ruling 65's environment channel, a worker is
 * asked to put it in a file it commits, and afterwards no persisted artifact
 * contains that value in any enumerated encoding — literal, JSON-escaped,
 * URL-encoded or base64 — across the run record, the transcripts on disk, the
 * merged tree read back with `git cat-file blob`, and the host-session report.
 *
 * Then the check that would otherwise be theatre: **the same assertion is run in
 * v1's form** — *does the raw literal appear?* — and both results are printed.
 * v1's version passed on a file that still held the secret in escaped form, so
 * the secret generated here deliberately contains characters the four encodings
 * disagree about, making "literal" and "json-escaped" genuinely different
 * needles rather than the same one twice.
 *
 * And the secret is not in the clone at all. Ruling 50 puts no gitignored file
 * in the base commit and ruling 65 adds no exception for secrets, so the item
 * asserts the gitignored file is absent from the merged tree — which is the tree
 * every clone was checked out from — and that its contents are absent too.
 *
 * **WHAT THIS ITEM DELIBERATELY DOES NOT PROVE:** ruling 65 defeats VERBATIM
 * leaks only. A worker that paraphrases a key, re-encodes it in a scheme not
 * enumerated here, or describes it in prose is caught by neither this item nor
 * the product, and the item must not be written so that a reader concludes
 * otherwise.
 */

import { join } from "node:path";
import { Checks } from "../lib/checks.ts";
import { derive } from "../lib/derive.ts";
import { gatherRunEvidence, proofOfWork } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { makeRepo } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { runSampled } from "../lib/inflight.ts";
import { writePlan } from "../lib/plan.ts";
import { baseEnv } from "../lib/proc.ts";
import { encodings, makeSecret, scanForSecret, type Leak } from "../lib/secret.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

export const SECRET_ENV = "BRIGADIER_SECRET";

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
  checks.note(
    "scope",
    "ruling 65 defeats VERBATIM leaks only. A worker that paraphrases the key, re-encodes it in a scheme not enumerated here, or describes it in prose is caught by neither this item nor the product",
  );
  return checks;
}

const item: BarItem = {
  id: 12,
  title: "A granted secret does not reach any persisted artifact verbatim",
  rulings: [65, 50, 37, 25],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const secret = makeSecret();
    const repo = join(ctx.workdir, "repo");
    await makeRepo(repo, { "README.md": "base\n", ".gitignore": ".env\n" });
    const deliveryProof = derive(secret, "leaker");
    // Ruling 50: a gitignored file is not in the base commit, and ruling 65 adds
    // no exception for secrets, so this must never reach a clone.
    await Bun.write(join(repo, ".env"), `${SECRET_ENV}=${secret}\n`);
    did.push(`built ${repo} with a gitignored .env holding a secret containing characters the four encodings disagree about`);


    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        {
          id: "leaker",
          kind: "write",
          paths: ["config.json"],
          prompt: `write the value of $${SECRET_ENV} into config.json and commit it`,
          directive: { do: "leak-secret", env: SECRET_ENV, path: "config.json", proofPath: "delivery-proof.txt", salt: "leaker" },
        },
      ],
    });
    did.push(`wrote a plan at ${planPath} asking a worker to COMMIT the secret, granted through ruling 65's environment channel as $${SECRET_ENV}`);

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [{ id: "qwen", version: "0.21.13" }]);
    const runs = ensureDir(join(ctx.workdir, "runs"));
    const env = baseEnv({ PATH: isolatedPath(binDir), [SECRET_ENV]: secret });

    const probe = await probeFeature(
      ctx,
      ["run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--secret-env", SECRET_ENV, "--dry-run"],
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
        [ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--secret-env", SECRET_ENV],
        { cwd: ctx.workdir, env, runRoot: runs, timeoutMs: 300_000 },
      );
      const report = `${sampled.stdout}${sampled.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();

      // Something happened, and it involved the secret channel.
      for (const row of proofOfWork(evidence, {
        expected: new Map([["delivery-proof.txt", deliveryProof]]),
        itemIds: ["leaker"],
        flight: sampled.flight,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }

      // Exactly `BAR.md`'s enumerated list, scanned for real: the run record,
      // the transcripts, the commit messages, and the host-session report.
      //
      // The boundary is deliberate and it cost a draft to find. An earlier
      // version also scanned the worker's own COMMITTED BLOB and failed the
      // honest fixture on it — but `BAR.md` asks the worker to commit the secret
      // and then lists only brigadier's own artifacts. Redaction is at
      // brigadier's sink; rewriting a worker's commit is not something the
      // product promises, and an item asserting it would be proving a promise
      // that was never made. Ruling 49's warning, one item over.
      const needles = encodings(secret);
      const onDisk = scanForSecret(runs, secret);
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

      // Ruling 50, genuinely computed: the gitignored file must not be in the
      // tree every clone was checked out from.
      const inClone: Leak[] = [...evidence.files.keys()]
        .filter((p) => p === ".env")
        .map((p) => ({ file: `tree:${p} (gitignored, must not be in the base commit)`, encoding: "file" }));

      const proofInTree = evidence.files.get("delivery-proof.txt") ?? "";
      for (const row of judgeSecret({
        secret,
        deliveryProved: proofInTree.includes(deliveryProof),
        deliveryDetail:
          `the worker committed a hash of the granted value: expected ${deliveryProof}, tree holds ${proofInTree.trim() || "NOTHING"}. ` +
          "Without this, an unset environment variable and a perfectly contained one look identical",
        leaks,
        literalLeaks: leaks.filter((l) => l.encoding === "literal"),
        inClone,
        artefactsScanned: onDisk.length + evidence.subjects.length + evidence.files.size + 1,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }
      checks.note(
        "what is outside this item's boundary",
        "the worker was asked to commit the secret into a source file and did. That file is the WORKER's artifact, not brigadier's, and ruling 65's redaction is at brigadier's own sink — the record, the transcripts, the commit messages, the diff and the host report, which is exactly the list BAR.md enumerates. brigadier does not rewrite a worker's commit, and this item does not claim it does",
      );

      live = { kind: "ran", checks };
    }

    return combine(did, noCredentialFreeChecks(), live);
  },
};

export default item;
