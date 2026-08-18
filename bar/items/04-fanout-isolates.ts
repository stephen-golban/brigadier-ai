// SPDX-License-Identifier: Apache-2.0
/**
 * Item 4 — Fan-out isolates, and integration merges.
 *
 * Rulings 19, 14, 7, 13, 33, 16, 9, 2, 39, 49, 50 — and it carries rulings 51,
 * 54 and 61's halves too, which is why it is the longest item in `BAR.md`.
 *
 * The first draft of this item **passed against a fake that hand-wrote
 * `.git/refs/heads/brigadier/run-0001` — forty hex characters and a newline,
 * pointing at an object that was never created — and printed the word "capped"**.
 * Nothing here reads a ref file any more. The ref is put through `git rev-parse`,
 * `git cat-file -t` and `git fsck --connectivity-only --strict`, and the last of
 * those is the one a hand-written ref cannot survive: it walks from every ref to
 * every object it names, and a broken link is a broken link however confidently
 * it was printed.
 *
 * Then the tree. Each plan item carries a token generated after the binary under
 * test was built, and the item reads those tokens back out of the merged tree
 * with `git cat-file blob`. A liar that produces them has cloned, run a worker,
 * committed and merged — which is the work.
 *
 * The halves this item keeps, each because something would otherwise be quietly
 * false:
 *
 *   ruling 33 repairing ruling 7 — the workers see the owner's uncommitted
 *   TRACKED and UNTRACKED work, so both are in the repository and both must be
 *   in the merged tree;
 *
 *   ruling 49 — a `read-only` item that writes into its own checkout anyway
 *   contributes NOTHING, because the directory is never read back. Not "the
 *   agent could not write": three of five measured vendors give no lane at all,
 *   so an item asserting that would be proving a promise the product does not
 *   make;
 *
 *   ruling 54 — a `dependsOn` wave must SEE its prerequisite's output, which is
 *   checked by the prerequisite's token appearing inside the dependent's file;
 *
 *   ruling 51 — every ref that appeared is one brigadier created FOR THIS RUN,
 *   because a worker can push into the operator's repository through the
 *   clone's own `origin` and removing the remote is a speed bump rather than a
 *   boundary. An earlier draft accepted `refs/heads/brigadier/` and nothing
 *   else, which is half the design: ruling 51 splits the namespace, machinery
 *   into the invisible `refs/brigadier/<run-id>/…` and the DELIVERABLE into the
 *   one visible branch `refs/heads/brigadier/<run-id>`. Accepting only the
 *   visible half marked the product's own machinery as an intruder, so the
 *   check now reads the run id out of the record and asserts BOTH halves —
 *   including the property the split exists for, that `git branch` gains
 *   exactly one entry;
 *
 *   ruling 61 — the run directory is outside every temp root, by `realpath`
 *   rather than lexically, because macOS's `/var` → `/private/var` symlink makes
 *   the lexical check wrong.
 *
 * **One half is not drivable from a harness and is reported rather than faked:**
 * ruling 54 wants the three fan-out filters to produce three DIFFERENT sentences.
 * Two are drivable — the plan's own item count, and an explicit cap — and this
 * item asserts those two differ and each names its own filter. The RAM-bound
 * case cannot be manufactured without constraining the machine, so it is left to
 * a verifier on a memory-constrained box and said so here.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { derive, nonce } from "../lib/derive.ts";
import { gatherRunEvidence, insideTempRoot, isAncestor, objectType, proofOfWork } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantFleet } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { captureRepo, diffRepo, makeRepo, newRefs, plantSeeds } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { runSampled } from "../lib/inflight.ts";
import { disjointPlan, token, writePlan } from "../lib/plan.ts";
import { HARNESS_RUN_TIMEOUT_MS, baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

const item: BarItem = {
  id: 4,
  title: "Fan-out isolates, and integration merges",
  rulings: [19, 14, 7, 13, 33, 16, 9, 2, 39, 49, 50],
  requiresLive: true,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];
    const credentialFree = new Checks();

    const binDir = ensureDir(join(ctx.workdir, "bin"));
    plantFleet(binDir, join(ctx.workdir, "vendor-ledger.tsv"), [
      { id: "qwen", version: "0.21.13" },
      { id: "copilot", version: "1.0.80" },
    ]);
    const env = baseEnv({ PATH: isolatedPath(binDir) });
    const runs = ensureDir(join(ctx.workdir, "runs"));

    // ---- credential-free: a plan whose items collide is REJECTED -----------
    // Ruling 13 is decided at admission and needs no agent, so it is graded on
    // a machine with no credentials rather than deferred into the live half.
    const clashRepo = join(ctx.workdir, "clash-repo");
    await makeRepo(clashRepo, { "README.md": "base\n" });
    const clashPlan = writePlan(
      ctx.workdir,
      {
        version: 1,
        items: [
          { id: "one", kind: "write", paths: ["shared.txt"], prompt: "write shared.txt" },
          { id: "two", kind: "write", paths: ["shared.txt"], prompt: "also write shared.txt" },
        ],
      },
      "clash.json",
    );
    const clashBefore = await captureRepo(clashRepo);
    const clash = await probeFeature(
      ctx,
      ["run", "--plan", clashPlan, "--repo", clashRepo, "--run-root", join(ctx.workdir, "clash-runs")],
      // A REFUSAL is the positive evidence here: a non-zero exit that said
      // something. Judging presence on "exited 0" would mark a correct refusal
      // as a missing feature.
      { env, timeoutMs: 120_000, evidence: (r) => r.code !== 0 && `${r.stdout}${r.stderr}`.trim().length > 0 },
    );
    const clashAfter = await captureRepo(clashRepo);
    did.push(`drove a two-items-one-path plan at ${clashPlan}: ${clash.transcript}`);
    if (clash.present) {
      const clashOutput = `${clash.result.stdout}${clash.result.stderr}`;
      credentialFree.expect(
        "a plan with two items claiming one path is rejected (ruling 13)",
        clash.result.code !== 0 && /shared\.txt/.test(clashOutput),
        `exit ${clash.result.code}; output: ${excerpt(clashOutput, 240)}`,
      );
      credentialFree.expect(
        "the rejected plan created no ref and left the repository alone",
        newRefs(clashBefore, clashAfter).length === 0 && diffRepo(clashBefore, clashAfter).length === 0,
        `refs that appeared: ${newRefs(clashBefore, clashAfter).join(", ") || "none"}; repository drift: ${diffRepo(clashBefore, clashAfter).map((d) => d.field).join(", ") || "none"}`,
      );
    } else {
      credentialFree.expect(
        "a plan with two items claiming one path is rejected (ruling 13)",
        false,
        clash.transcript,
      );
    }

    // ---- the real fan-out --------------------------------------------------
    //
    // Every nonce below lives ONLY in the repository's content, in a different
    // placement each time. Ruling 33 carries the owner's uncommitted TRACKED and
    // UNTRACKED work into each clone; ruling 50 keeps gitignored content out of
    // the base commit entirely. A product that dropped any one of the three
    // yields a wrong derivation, and a forger that reads the working tree gets
    // the gitignored one WRONG in the opposite direction — it must be absent.
    const repo = join(ctx.workdir, "operator-repo");
    await makeRepo(repo, { "README.md": "base\n" });
    const alphaSeed = nonce("alpha-seed");
    const betaSeed = nonce("beta-seed");
    const ignoredSeed = nonce("ignored-seed");
    await plantSeeds(repo, [
      { path: "seeds/alpha.seed", value: alphaSeed, placement: "uncommitted-tracked" },
      { path: "seeds/beta.seed", value: betaSeed, placement: "untracked" },
      { path: "seeds/secret.seed", value: ignoredSeed, placement: "gitignored" },
    ]);
    did.push(
      `built ${repo} with three nonces: one uncommitted-TRACKED, one UNTRACKED (ruling 33) and one GITIGNORED (ruling 50, which must NOT reach a clone)`,
    );

    const readOnlyToken = token("read-only-leak");
    const alphaOut = derive(alphaSeed, "alpha");
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        {
          id: "alpha",
          kind: "write",
          paths: ["alpha.txt"],
          prompt: "derive alpha.txt from seeds/alpha.seed",
          directive: { do: "derive-write", read: "seeds/alpha.seed", path: "alpha.txt", salt: "alpha" },
        },
        {
          id: "beta",
          kind: "write",
          paths: ["beta.txt"],
          prompt: "derive beta.txt from seeds/beta.seed",
          directive: { do: "derive-write", read: "seeds/beta.seed", path: "beta.txt", salt: "beta" },
        },
        {
          id: "reader",
          kind: "read-only",
          paths: ["README.md"],
          prompt: "summarise README.md",
          directive: { do: "write-anyway", path: "leaked.txt", token: readOnlyToken },
        },
        {
          // Ruling 54: the value wave 2 needs existed ONLY in wave 1's
          // integration commit. It is nowhere in the plan and nowhere in the
          // repository, so a forger must chain the derivation in the right
          // order from the right source.
          id: "wave2",
          kind: "write",
          paths: ["wave2.txt"],
          dependsOn: ["alpha"],
          prompt: "read alpha.txt — wave one's output — and derive wave2.txt from it",
          directive: { do: "read-then-write", read: "alpha.txt", path: "wave2.txt", salt: "wave2" },
        },
        {
          // The gitignored nonce. Ruling 50 keeps it out of the base commit, so
          // this derivation must NOT be producible — and its absence is checked.
          id: "ignored",
          kind: "write",
          paths: ["ignored.txt"],
          prompt: "derive ignored.txt from seeds/secret.seed if you can reach it",
          directive: { do: "derive-write", read: "seeds/secret.seed", path: "ignored.txt", salt: "ignored" },
        },
      ],
    });
    did.push(`wrote a five-item plan at ${planPath}: two derivations, one read-only that writes anyway, one dependsOn wave, one reaching for gitignored content`);

    const before = await captureRepo(repo);
    did.push(
      `captured the operator repository five ways: HEAD=${before.head.slice(0, 12)}, status=${JSON.stringify(before.status.trim())}, ` +
        `refs=${JSON.stringify(before.refs.trim())}, .git/index=${before.indexHash.slice(0, 12)}, tree=${before.treeHash.slice(0, 12)}`,
    );

    const probe = await probeFeature(ctx, ["run", "--plan", planPath, "--repo", repo, "--run-root", runs, "--dry-run"], {
      env,
      timeoutMs: 60_000,
    });
    did.push(`admission probe: ${probe.transcript}`);

    let live: LiveHalf;
    if (!probe.present) {
      live = {
        kind: "missing",
        probe,
        promise: "there is no fan-out to isolate and no integration branch to merge into",
      };
    } else if (!ctx.live) {
      live = { kind: "skipped", why: "N clones and N workers require N drivable vendor agents" };
    } else {
      const sampled = await runSampled([ctx.binary, "run", "--plan", planPath, "--repo", repo, "--run-root", runs], {
        cwd: ctx.workdir,
        env,
        runRoot: runs,
        operatorHead: before?.head ?? undefined,
        timeoutMs: HARNESS_RUN_TIMEOUT_MS,
      });
      did.push(
        `ran the plan while sampling: ${sampled.flight.samples} samples, peak ${sampled.flight.peakConcurrentClones} concurrent clones, peak ${sampled.flight.peakMarkedProcesses} marked processes`,
      );
      const report = `${sampled.stdout}${sampled.stderr}`;
      const after = await captureRepo(repo);
      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();

      const expected = new Map([
        ["alpha.txt", alphaOut],
        ["beta.txt", derive(betaSeed, "beta")],
        ["wave2.txt", derive(alphaOut, "wave2")],
      ]);
      for (const row of proofOfWork(evidence, {
        expected,
        itemIds: ["alpha", "beta", "wave2"],
        flight: sampled.flight,
        expectedWorkers: 4,
      }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }

      // Ruling 50: the gitignored nonce never reached a clone, so its derivation
      // cannot exist. A forger reading the working tree produces it and fails
      // here; a product that put gitignored content in the base commit does too.
      const forbidden = derive(ignoredSeed, "ignored");
      const leakedIgnored = [...evidence.files.entries()].filter(([, body]) => body.includes(forbidden));
      checks.expect(
        "gitignored content never reached a clone, so its derivation cannot exist (ruling 50)",
        leakedIgnored.length === 0,
        leakedIgnored.length === 0
          ? "no path in the merged tree carries a derivation of the gitignored nonce"
          : `${leakedIgnored.map(([p]) => p).join(", ")} carries it — either the base commit included gitignored content, or the value was computed from the working tree rather than from a clone`,
      );

      // Ruling 49: the read-only item's directory is never read back.
      const leaked = [...evidence.files.entries()].filter(([, body]) => body.includes(readOnlyToken));
      checks.expect(
        "a read-only worker's writes reach neither the branch nor any report (ruling 49)",
        leaked.length === 0 && !report.includes(readOnlyToken),
        `paths in the merged tree carrying the read-only token: ${leaked.map(([p]) => p).join(", ") || "none"}; token in the report: ${report.includes(readOnlyToken)}`,
      );

      // Ruling 51 and ruling 50, and this is where the item used to misread the
      // design. It accepted `refs/heads/brigadier/` and NOTHING else, so every
      // machinery ref the product legitimately writes read as an intruder. The
      // owned namespace is BOTH halves of ruling 51's split: the invisible
      // `refs/brigadier/<run-id>/…` for machinery, and the one visible branch
      // `refs/heads/brigadier/<run-id>` that is the deliverable. The run id
      // comes out of the record, so "brigadier's namespace" is now this run's
      // namespace rather than any ref that starts with the right eight letters.
      const appeared = newRefs(before, after);
      const runId = evidence.record?.runId;
      const refNameOf = (line: string): string => line.split(/\s+/)[0] ?? "";
      const shaOf = (line: string): string => line.split(/\s+/)[1] ?? "";
      const owned = (line: string): boolean => {
        const ref = refNameOf(line);
        if (runId === undefined) return false;
        return ref === `refs/heads/brigadier/${runId}` || ref.startsWith(`refs/brigadier/${runId}/`);
      };
      const unexpected = appeared.filter((line) => !owned(line));
      checks.expect(
        "every ref that appeared belongs to THIS run, in one of ruling 51's two namespaces",
        runId !== undefined && unexpected.length === 0,
        `run id from the record: ${runId ?? "NONE"}; appeared: ${appeared.map(refNameOf).join(", ") || "none"}; ` +
          `outside refs/brigadier/${runId ?? "<run>"}/ and refs/heads/brigadier/${runId ?? "<run>"}: ${
            unexpected.map(refNameOf).join(", ") || "none"
          }`,
      );
      // Ruling 51's split, asserted as the property that makes it worth having:
      // the machinery must NOT be visible to `git branch`, and the deliverable
      // must be. `refs/heads/` is exactly what `git branch` lists.
      const visible = appeared.map(refNameOf).filter((r) => r.startsWith("refs/heads/"));
      checks.expect(
        "the machinery is invisible to `git branch` and only the deliverable is not (ruling 51)",
        runId !== undefined && visible.length === 1 && visible[0] === `refs/heads/brigadier/${runId}`,
        `refs under refs/heads/ that appeared: ${visible.join(", ") || "NONE"} — the operator's branch list must gain exactly the deliverable`,
      );
      // Ruling 50's scratch base. The previous check looked for the substring
      // `refs/brigadier/base/`, which is not a shape this product ever writes —
      // it was vacuously true and asserted nothing. The base is now read out of
      // the record and confirmed to be a real commit the deliverable descends
      // from, which is what makes `git diff <base>..<itemRef>` re-derivable.
      const base = evidence.record?.base;
      const baseType = base === undefined ? undefined : await objectType(repo, base.sha);
      const baseReached =
        base !== undefined && evidence.refSha !== undefined && (await isAncestor(repo, base.sha, evidence.refSha));
      checks.expect(
        "the scratch base is a real commit the deliverable descends from (ruling 50)",
        base !== undefined && baseType === "commit" && baseReached,
        base === undefined
          ? "the record names no base, so no item's diff can be re-derived from the evidence"
          : `base ${base.ref} -> ${base.sha.slice(0, 12)} (git cat-file -t: ${baseType ?? "no object"}, ancestor of the deliverable: ${baseReached})`,
      );
      const baseLine = appeared.find((line) => refNameOf(line) === base?.ref);
      checks.expect(
        "if the base ref survived the run it is in the invisible namespace, pinned where the record says",
        base === undefined || baseLine === undefined || (owned(baseLine) && shaOf(baseLine) === base.sha),
        baseLine === undefined
          ? `${base?.ref ?? "the base ref"} is not in the operator's ref list — cleaned up, and the commit itself is still reachable`
          : `${baseLine} against the record's ${base?.sha ?? "<none>"}`,
      );
      const drift = diffRepo(before, after).filter((d) => d.field !== "refs");
      checks.expect(
        "the operator's repository is byte-identical afterwards, including after cleanup",
        drift.length === 0,
        drift.length === 0
          ? `HEAD, status, .git/index and the working tree all unchanged (index ${before.indexHash.slice(0, 12)}, tree ${before.treeHash.slice(0, 12)})`
          : drift.map((d) => `${d.field}: ${excerpt(d.before, 60)} -> ${excerpt(d.after, 60)}`).join("; "),
      );
      checks.expect(
        "the integration branch the record NAMES is the one that survived cleanup",
        runId !== undefined &&
          evidence.record?.integrationRef === `refs/heads/brigadier/${runId}` &&
          appeared.some((line) => refNameOf(line) === evidence.record?.integrationRef),
        `record.integrationRef: ${evidence.record?.integrationRef ?? "NONE"}; refs that appeared under refs/heads/: ${
          visible.join(", ") || "NONE"
        }`,
      );

      // Ruling 61, by realpath.
      const runRoot = evidence.record?.runRoot;
      checks.expect(
        "the run directory really existed, outside every temp root (ruling 61)",
        runRoot !== undefined && insideTempRoot(runRoot) === undefined,
        runRoot === undefined ? "no run root in the record" : (insideTempRoot(runRoot) ?? `${runRoot} — resolved with realpath`),
      );

      // Ruling 54's binding filter, driven twice so a constant cannot satisfy it.
      const single = disjointPlan(1, "solo");
      const singlePath = writePlan(ctx.workdir, single.plan, "solo.json");
      const soloRepo = join(ctx.workdir, "solo-repo");
      await makeRepo(soloRepo, { "README.md": "base\n" });
      await plantSeeds(soloRepo, single.seeds);
      const solo = await ctx.run(["run", "--plan", singlePath, "--repo", soloRepo, "--run-root", runs, "--dry-run"], { env });

      const many = disjointPlan(6, "many");
      const manyPath = writePlan(ctx.workdir, many.plan, "many.json");
      await plantSeeds(soloRepo, many.seeds);
      const capped = await ctx.run(
        ["run", "--plan", manyPath, "--repo", soloRepo, "--run-root", runs, "--dry-run", "--max-workers", "2"],
        { env },
      );
      const soloLine = /—\s*(.+?)\s*$/m.exec(solo.stdout)?.[1] ?? "";
      const cappedLine = /—\s*(.+?)\s*$/m.exec(capped.stdout)?.[1] ?? "";
      checks.expect(
        "the two drivable fan-out filters produce two DIFFERENT sentences (ruling 54)",
        soloLine.length > 0 && cappedLine.length > 0 && soloLine !== cappedLine,
        `one-item plan said ${JSON.stringify(soloLine)}; a six-item plan capped at 2 said ${JSON.stringify(cappedLine)}`,
      );
      checks.note(
        "not drivable from a harness",
        "ruling 54's THIRD filter — available RAM — cannot be manufactured without constraining the machine, so this item drives two of three and leaves the RAM-bound sentence to a verifier on a memory-constrained box. Stated rather than faked",
      );

      live = { kind: "ran", checks };
    }

    return combine(did, credentialFree, live);
  },
};

export default item;
