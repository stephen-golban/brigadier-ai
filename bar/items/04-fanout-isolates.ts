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
 *   ruling 51 — every ref that appeared is one brigadier created, because a
 *   worker can push into the operator's repository through the clone's own
 *   `origin` and removing the remote is a speed bump rather than a boundary;
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
import { gatherRunEvidence, insideTempRoot, proofOfWork } from "../lib/evidence.ts";
import { probeFeature } from "../lib/feature.ts";
import { isolatedPath, plantVendors } from "../lib/fixtures.ts";
import { ensureDir } from "../lib/fs.ts";
import { captureRepo, diffRepo, makeRepo, newRefs } from "../lib/git.ts";
import { combine, noCredentialFreeChecks, type LiveHalf } from "../lib/halves.ts";
import { disjointPlan, token, writePlan } from "../lib/plan.ts";
import { baseEnv } from "../lib/proc.ts";
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
    plantVendors(binDir, [{ id: "codex", version: "1.4.0" }, { id: "qwen", version: "0.21.13" }]);
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
      { env, timeoutMs: 120_000 },
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
    const repo = join(ctx.workdir, "operator-repo");
    await makeRepo(repo, { "README.md": "base\n", "tracked.txt": "committed\n" });
    const uncommittedToken = token("uncommitted");
    const untrackedToken = token("untracked");
    writeFileSync(join(repo, "tracked.txt"), `${uncommittedToken}\n`);
    writeFileSync(join(repo, "untracked.txt"), `${untrackedToken}\n`);
    did.push(`built ${repo} with uncommitted TRACKED (${uncommittedToken}) and UNTRACKED (${untrackedToken}) work`);

    const alphaToken = token("alpha");
    const betaToken = token("beta");
    const readOnlyToken = token("read-only-leak");
    const waveToken = token("wave2");
    const planPath = writePlan(ctx.workdir, {
      version: 1,
      items: [
        { id: "alpha", kind: "write", paths: ["alpha.txt"], prompt: "create alpha.txt", directive: { do: "write", path: "alpha.txt", token: alphaToken } },
        { id: "beta", kind: "write", paths: ["beta.txt"], prompt: "create beta.txt", directive: { do: "write", path: "beta.txt", token: betaToken } },
        {
          id: "reader",
          kind: "read-only",
          paths: ["README.md"],
          prompt: "summarise README.md",
          directive: { do: "write-anyway", path: "leaked.txt", token: readOnlyToken },
        },
        {
          id: "wave2",
          kind: "write",
          paths: ["wave2.txt"],
          dependsOn: ["alpha"],
          prompt: "read alpha.txt and write wave2.txt naming what you saw",
          directive: { do: "read-then-write", read: "alpha.txt", path: "wave2.txt", token: waveToken },
        },
      ],
    });
    did.push(`wrote a four-item plan at ${planPath}: two disjoint writes, one read-only that writes anyway, one dependsOn wave`);

    const before = await captureRepo(repo);
    did.push(
      `captured the operator repository five ways: HEAD=${before.head.slice(0, 12)}, status=${JSON.stringify(before.status.trim())}, ` +
        `refs=${JSON.stringify(before.refs.trim())}, .git/index=${before.indexHash.slice(0, 12)}, tree=${before.treeHash.slice(0, 12)}`,
    );

    const probe = await probeFeature(ctx, ["run", "--plan", planPath, "--repo", repo, "--run-root", runs], {
      env,
      timeoutMs: 300_000,
    });
    did.push(probe.transcript);
    const after = await captureRepo(repo);

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
      const report = `${probe.result.stdout}${probe.result.stderr}`;
      const evidence = await gatherRunEvidence(repo, report);
      const checks = new Checks();

      const expected = new Map([
        ["alpha.txt", alphaToken],
        ["beta.txt", betaToken],
        ["wave2.txt", waveToken],
        // Ruling 33: the owner's uncommitted work reached the workers.
        ["tracked.txt", uncommittedToken],
        ["untracked.txt", untrackedToken],
      ]);
      for (const row of proofOfWork(evidence, { expected, itemIds: ["alpha", "beta", "wave2"] }).rows) {
        checks.expect(row.name, row.ok, row.detail);
      }

      // Ruling 54: the wave saw its prerequisite, proved by the prerequisite's
      // token appearing inside the dependent's file rather than by an ordering
      // claim in a report.
      const wave = evidence.files.get("wave2.txt") ?? "";
      checks.expect(
        "a dependsOn wave SAW its prerequisite's output",
        wave.includes(alphaToken),
        `wave2.txt (from the object store): ${excerpt(wave, 120)} — must contain alpha's token ${alphaToken}`,
      );

      // Ruling 49: the read-only item's directory is never read back.
      const leaked = [...evidence.files.entries()].filter(([, body]) => body.includes(readOnlyToken));
      checks.expect(
        "a read-only worker's writes reach neither the branch nor any report (ruling 49)",
        leaked.length === 0 && !report.includes(readOnlyToken),
        `paths in the merged tree carrying the read-only token: ${leaked.map(([p]) => p).join(", ") || "none"}; token in the report: ${report.includes(readOnlyToken)}`,
      );

      // Ruling 51 and ruling 50.
      const appeared = newRefs(before, after);
      const unexpected = appeared.filter((ref) => !ref.startsWith("refs/heads/brigadier/"));
      checks.expect(
        "every ref that appeared is one brigadier created (ruling 51)",
        unexpected.length === 0,
        `appeared: ${appeared.join(", ") || "none"}; outside refs/heads/brigadier/: ${unexpected.join(", ") || "none"}`,
      );
      checks.expect(
        "the scratch base ref was cleaned up",
        !appeared.some((r) => r.includes("refs/brigadier/base/")),
        `refs after the run: ${after.refs.trim().split("\n").join(" | ")}`,
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
        "the integration branch is visible to `git branch` and survived cleanup",
        appeared.some((r) => r.startsWith("refs/heads/brigadier/")),
        `refs under refs/heads/brigadier/: ${appeared.filter((r) => r.startsWith("refs/heads/brigadier/")).join(", ") || "NONE"}`,
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
      const solo = await ctx.run(["run", "--plan", singlePath, "--repo", soloRepo, "--run-root", runs, "--dry-run"], { env });

      const many = disjointPlan(6, "many");
      const manyPath = writePlan(ctx.workdir, many.plan, "many.json");
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
