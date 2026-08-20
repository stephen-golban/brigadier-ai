// SPDX-License-Identifier: Apache-2.0
/**
 * Item 1 — Detection is honest.
 *
 * Rulings 6, 41, 46, 2, 69. `BAR.md`: `brigadier detect` claims only agents that
 * complete BOTH steps and reports the RESOLVED `PATH` entry rather than assuming
 * it is ours; an agent renamed off `PATH` reports `absent`; an agent present but
 * logged out reports `unusable` with the vendor's own remedy text; and a version
 * that has drifted from the profile is reported, graded.
 *
 * The item plants its own ground truth rather than reading the machine's, and
 * that is what makes it checkable by someone who does not trust the author. A
 * real vendor cannot be asked to be logged out on demand, so the states are
 * manufactured: an empty `PATH`, a decoy at a path only this harness knows, and
 * a fake ACP agent that handshakes and then refuses the session. The product's
 * report is then compared against what the harness knows to be true, in that
 * direction — never the product's report against itself.
 *
 * The measured version each agent's profile was built against is read out of
 * `brigadier agents`, not hard-coded here. The artifact is the only thing that
 * knows what it claims, and a number copied into this file would go stale in
 * exactly the way ruling 69 exists to catch.
 *
 * NOTE what cannot be used as a drift signal: MEASURED against copilot 1.0.80,
 * qwen-code 0.21.13, OpenCode 1.18.18 and gemini-cli 0.55.1 on 2026-08-17, all
 * four returned `protocolVersion: 1`. The protocol version discriminates
 * nothing; the agent's own version is the only signal there is.
 */

import { join } from "node:path";
import { Checks, excerpt } from "../lib/checks.ts";
import { plantAgent, plantDecoy } from "../lib/fake-agent.ts";
import { ensureDir, listTree } from "../lib/fs.ts";
import { combine } from "../lib/halves.ts";
import { baseEnv } from "../lib/proc.ts";
import type { BarContext, BarItem, BarResult } from "../types.ts";

export interface DetectRow {
  id?: string;
  availability?: string;
  version?: string;
  remedy?: string;
  resolvedPath?: string;
  milliseconds?: number;
}

/** `brigadier agents` describes its own launch-profile table. This reads it. */
export interface ProfileRow {
  id: string;
  command: string;
  args: string;
  measured: string;
}

export function parseAgentsTable(stdout: string): ProfileRow[] {
  const rows: ProfileRow[] = [];
  let current: Partial<ProfileRow> | undefined;
  for (const line of stdout.split("\n")) {
    const heading = /^(\S+)\s+—\s+/.exec(line);
    if (heading?.[1]) {
      if (current?.id && current.command && current.measured !== undefined) rows.push(current as ProfileRow);
      current = { id: heading[1], args: "" };
      continue;
    }
    if (!current) continue;
    const command = /^\s+command\s+(\S+)\s*(.*)$/.exec(line);
    if (command?.[1]) {
      current.command = command[1];
      current.args = (command[2] ?? "").trim();
      continue;
    }
    const measured = /^\s+measured\s+(.+)$/.exec(line);
    if (measured?.[1]) current.measured = measured[1].trim();
  }
  if (current?.id && current.command && current.measured !== undefined) rows.push(current as ProfileRow);
  return rows;
}

export function parseDetectJson(stdout: string): DetectRow[] {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown;
    return Array.isArray(parsed) ? (parsed as DetectRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * Everything the item saw, so the judgement below is a pure function of it.
 *
 * The split is not tidiness: `AGENTS.md` requires every check to have a negative
 * control showing it can fail, and a judgement tangled up with process spawning
 * can only be falsified by building a broken product. This one can be falsified
 * by handing it a lie.
 */
export interface DetectObservations {
  agent: string;
  measuredVersion: string;
  plantedPath: string;
  driftVersion: string;
  sentinel: string;
  offPath: DetectRow | undefined;
  decoy: DetectRow | undefined;
  loggedOut: DetectRow | undefined;
  loggedOutHuman: string;
  atMeasured: DetectRow | undefined;
  drifted: DetectRow | undefined;
  driftedHuman: string;
  /**
   * Which protocol steps the planted agent recorded having been asked for.
   *
   * The one observation in this item that is not a statement about the product's
   * output. A binary that reports an agent `usable` without spawning it leaves
   * this empty, and correct-looking JSON cannot fill it.
   */
  contactWhenUsable: string[];
  contactWhenOffPath: string[];
}

const DRIFT_SIGNAL = /drift|unverified|no longer verified|measured against/i;
const BLOCKING_SIGNAL = /blocking|blocks|lane assertion/i;

export function judgeDetection(o: DetectObservations): Checks {
  const checks = new Checks();

  // Ruling 6 / v1's defect: an agent renamed off PATH is `absent`, and nothing
  // is invented to stand in for it.
  checks.expect(
    "renamed off PATH reports absent",
    o.offPath?.availability === "absent",
    `PATH held no \`${o.agent}\`; detect said ${JSON.stringify(o.offPath?.availability ?? null)}`,
  );
  checks.expect(
    "absent claims no version",
    o.offPath?.version === undefined,
    `version field: ${JSON.stringify(o.offPath?.version ?? null)}`,
  );
  checks.expect(
    "absent claims no resolved path",
    o.offPath?.resolvedPath === undefined,
    `resolvedPath field: ${JSON.stringify(o.offPath?.resolvedPath ?? null)}`,
  );
  checks.expect(
    "absent names PATH as the reason",
    /path/i.test(o.offPath?.remedy ?? ""),
    `remedy: ${JSON.stringify(o.offPath?.remedy ?? null)}`,
  );

  // Ruling 46: report the entry that RESOLVED, never assume the name is ours.
  // v1 shipped a `brigadier` on a Homebrew tap, so this is not hypothetical.
  checks.expect(
    "a decoy on PATH is not reported usable",
    o.decoy?.availability !== "usable",
    `decoy at ${o.plantedPath} reported as ${JSON.stringify(o.decoy?.availability ?? null)}`,
  );
  checks.expect(
    "the RESOLVED PATH entry is reported verbatim",
    o.decoy?.resolvedPath === o.plantedPath,
    `planted ${o.plantedPath}; detect reported ${JSON.stringify(o.decoy?.resolvedPath ?? null)}`,
  );

  // Ruling 41: two steps. A completed handshake is `present`, not `usable`.
  checks.expect(
    "handshake without a session is unusable, not usable",
    o.loggedOut?.availability === "unusable",
    `agent answered initialize and refused session/new; detect said ${JSON.stringify(o.loggedOut?.availability ?? null)}`,
  );
  checks.expect(
    "the vendor's own remedy text survives into --json",
    (o.loggedOut?.remedy ?? "").includes(o.sentinel),
    `looked for ${JSON.stringify(o.sentinel)} in remedy ${JSON.stringify(excerpt(o.loggedOut?.remedy ?? "", 200))}`,
  );
  checks.expect(
    "the vendor's own remedy text is printed to a human, not swallowed",
    o.loggedOutHuman.includes(o.sentinel),
    `looked for ${JSON.stringify(o.sentinel)} in stdout: ${excerpt(o.loggedOutHuman, 240)}`,
  );

  // Ruling 41's two steps, asserted on the AGENT's own record of being asked
  // rather than on the product's account of having asked. Everything else in
  // this item is a statement about stdout, and stdout is the one thing a liar
  // controls completely.
  checks.expect(
    "the binary really spawned the agent and completed BOTH protocol steps",
    o.contactWhenUsable.includes("initialize") && o.contactWhenUsable.includes("session-new"),
    `the planted agent recorded being asked for: ${o.contactWhenUsable.join(", ") || "NOTHING — no process was ever spawned"}`,
  );
  checks.expect(
    "an agent that is not on PATH is not spawned from somewhere else",
    o.contactWhenOffPath.length === 0,
    `with an empty PATH the planted agent recorded: ${o.contactWhenOffPath.join(", ") || "nothing"}`,
  );

  // The control on the three above: an agent that completes both steps at the
  // version the table was measured against must come back clean. Without this,
  // every assertion here would be satisfied by a product that reports
  // everything as broken.
  checks.expect(
    "an agent completing both steps is usable",
    o.atMeasured?.availability === "usable",
    `stub at the profile's own measured version ${JSON.stringify(o.measuredVersion)}; detect said ${JSON.stringify(o.atMeasured?.availability ?? null)}`,
  );
  checks.expect(
    "the version the agent reported is the version printed",
    o.atMeasured?.version !== undefined && o.measuredVersion.includes(o.atMeasured.version),
    `agent reported ${JSON.stringify(o.atMeasured?.version ?? null)}; profile measured against ${JSON.stringify(o.measuredVersion)}`,
  );

  // Ruling 69: drift is graded by blast radius, and reported rather than
  // refused — agents auto-update, and a product that stops working after every
  // vendor release is not a product.
  const driftedText = `${JSON.stringify(o.drifted ?? null)}\n${o.driftedHuman}`;
  // The planted version string is removed before the drift SIGNAL is looked
  // for. Without this the check passes on the echo of its own input — the first
  // draft planted `99.0.0-bar-drift` and matched /drift/ inside the version it
  // had just supplied, which is a check that cannot fail.
  const withoutEcho = driftedText.split(o.driftVersion).join("<planted-version>");
  checks.expect(
    "a drifted version is reported at all",
    driftedText.includes(o.driftVersion) && DRIFT_SIGNAL.test(withoutEcho),
    `agent reported ${JSON.stringify(o.driftVersion)} against a profile measured at ${JSON.stringify(o.measuredVersion)}; output with the planted version masked: ${excerpt(withoutEcho, 300)}`,
  );
  checks.expect(
    "the drift is graded, with the lane assertion blocking",
    DRIFT_SIGNAL.test(withoutEcho) && BLOCKING_SIGNAL.test(withoutEcho),
    `looked for a grade naming the lane assertion as blocking; output with the planted version masked: ${excerpt(withoutEcho, 300)}`,
  );

  return checks;
}

/** Pick an agent whose command is its own binary — a bridged one is `npx`, which cannot be planted. */
export function plantableAgent(rows: readonly ProfileRow[]): ProfileRow | undefined {
  return rows.find((r) => r.id === "qwen" && r.command !== "npx") ?? rows.find((r) => r.command !== "npx");
}

const item: BarItem = {
  id: 1,
  title: "Detection is honest",
  rulings: [6, 41, 46, 2, 69, 73],
  requiresLive: false,

  async run(ctx: BarContext): Promise<BarResult> {
    const did: string[] = [];

    const agents = await ctx.run(["agents"], { timeoutMs: 30_000 });
    did.push("ran `brigadier agents` to read the artifact's own launch-profile table");
    const profiles = parseAgentsTable(agents.stdout);
    const target = plantableAgent(profiles);
    if (!target) {
      // THIS PATH GOES THROUGH `combine` LIKE EVERY OTHER ONE, and until
      // 2026-08-19 it did not: it returned a bare `BarResult` literal with no
      // `halves` key, the only such return in any of the thirteen items. The
      // outcome was right and the PROVENANCE was missing — a reader of the
      // report could not see which half of item 1 had decided, and the
      // reporting layer had one result it could not describe the way it
      // describes the other twelve.
      //
      // WHICH HALF OWNS THIS FAILURE: the credential-free one. Nothing here has
      // touched a vendor. `brigadier agents` prints the artifact's own
      // launch-profile table, which it knows without an account, and the
      // failure is that the table did not name a profile this harness can plant
      // against. A bare CI machine reaches exactly this state or does not
      // reach it, and a credentialed one would learn nothing more. Routing it
      // through the credential-free half is also what makes it BLOCK: `combine`
      // asks that half first, so this cannot be masked later by a missing
      // credential.
      //
      // WHY THE LIVE HALF IS `none` AND NOT `skipped` OR `missing`:
      //   `skipped` renders "requires real vendor agents … this BLOCKS exactly
      //   as a FAIL does (ruling 48)" and grades the live half `SKIPPED`. That
      //   would state that a credential was the missing ingredient. No
      //   credential was ever needed — item 1 is one of the three items with
      //   `requiresLive: false` — so it would be a false claim about the world,
      //   and it would change the outcome from FAIL to SKIPPED.
      //   `missing` says the ARTIFACT DOES NOT IMPLEMENT the live half, and
      //   wants a `FeatureProbe` to prove it. Item 1 has no live half to be
      //   missing, and no probe was taken; what is absent is this harness's
      //   ground truth, not a product feature.
      //   `none` is the true statement, and it is the SAME statement the
      //   successful path makes at the bottom of this function: everything item
      //   1 proves is checkable without vendor credentials. The premise for
      //   proving it was absent, which is a credential-free FAIL, and the live
      //   half is no more present or absent than it ever is here.
      //
      // The row is an `ERROR —` per the vocabulary in `bar/lib/checks.ts`: a
      // premise broke, so the item never reached any of the twelve assertions
      // `judgeDetection` names. It is `expect(…, false, …)` and never `note`,
      // which stamps `ok: true` and would gate nothing.
      const premise = new Checks();
      premise.expect(
        "ERROR — could not read a plantable agent out of `brigadier agents`, so the item has no ground truth to plant against",
        false,
        `\`brigadier agents\` exit ${agents.code}; parsed ${profiles.length} profile rows; stdout: ${excerpt(agents.stdout, 300)}; stderr: ${excerpt(agents.stderr, 200)}`,
      );
      return combine(did, premise, { kind: "none" });
    }

    const empty = ensureDir(join(ctx.workdir, "empty-path"));
    const binDir = ensureDir(join(ctx.workdir, "bin"));
    const contactDir = join(ctx.workdir, "contact");
    const sentinel = `bar-remedy-${Math.random().toString(36).slice(2, 10)}`;
    // Deliberately contains none of the words the drift signal looks for.
    const driftVersion = "99.0.0-bar-moved";
    const detect = (path: string): Promise<{ stdout: string; stderr: string; code: number | null }> =>
      ctx.run(["detect", target.id, "--timeout", "10000", "--json"], { env: baseEnv({ PATH: path }) });

    // 1. Renamed off PATH. The agent is planted, but nowhere `PATH` can reach —
    //    so nothing may contact it, and the contact directory proves that.
    plantAgent(binDir, target.command, { name: target.id, version: firstVersion(target.measured), contactDir });
    ctx.log(`detecting ${target.id} with an empty PATH`);
    const offPath = parseDetectJson((await detect(empty)).stdout)[0];
    const contactWhenOffPath = listTree(contactDir);
    did.push(`ran \`brigadier detect ${target.id} --json\` with PATH=${empty} (nothing on it)`);

    // 2. A decoy at a path only this harness knows.
    const plantedPath = plantDecoy(binDir, target.command);
    ctx.log(`planted a decoy \`${target.command}\` at ${plantedPath}`);
    const decoy = parseDetectJson((await detect(binDir)).stdout)[0];
    did.push(`planted a non-agent \`${target.command}\` at ${plantedPath} and detected again`);

    // 3. Present, handshakes, refuses the session — the logged-out shape.
    const remedy = `Run \`${target.command} auth login\` to authenticate [${sentinel}]`;
    plantAgent(binDir, target.command, { name: target.id, version: target.measured, sessionError: remedy });
    ctx.log(`planted a fake ACP agent that refuses session/new with ${JSON.stringify(sentinel)}`);
    const loggedOut = parseDetectJson((await detect(binDir)).stdout)[0];
    const loggedOutHumanRun = await ctx.run(["detect", target.id, "--timeout", "10000"], {
      env: baseEnv({ PATH: binDir }),
    });
    did.push(`planted a fake ACP agent whose session/new fails with the vendor-style remedy ${JSON.stringify(sentinel)}`);

    // 4. Both steps complete, at the profile's own measured version — and the
    //    agent records each step it is asked for.
    plantAgent(binDir, target.command, { name: target.id, version: firstVersion(target.measured), contactDir });
    ctx.log(`planted a fake ACP agent that completes both steps at ${firstVersion(target.measured)}`);
    const atMeasured = parseDetectJson((await detect(binDir)).stdout)[0];
    const contactWhenUsable = listTree(contactDir);
    did.push(
      `planted a working fake agent at the profile's measured version ${JSON.stringify(target.measured)} that records every protocol step into ${contactDir}`,
    );

    // 5. Both steps complete, at a version that has drifted.
    plantAgent(binDir, target.command, { name: target.id, version: driftVersion });
    ctx.log(`planted a fake ACP agent reporting ${driftVersion}`);
    const drifted = parseDetectJson((await detect(binDir)).stdout)[0];
    const driftedHumanRun = await ctx.run(["detect", target.id, "--timeout", "10000"], {
      env: baseEnv({ PATH: binDir }),
    });
    did.push(`planted a working fake agent reporting ${driftVersion} and detected in both --json and human form`);

    const checks = judgeDetection({
      agent: target.id,
      measuredVersion: target.measured,
      plantedPath,
      driftVersion,
      sentinel,
      offPath,
      decoy,
      loggedOut,
      loggedOutHuman: `${loggedOutHumanRun.stdout}${loggedOutHumanRun.stderr}`,
      atMeasured,
      drifted,
      driftedHuman: `${driftedHumanRun.stdout}${driftedHumanRun.stderr}`,
      contactWhenUsable,
      contactWhenOffPath,
    });

    // Detection states are planted rather than waited for, so nothing in this
    // item needs a vendor account.
    return combine(did, checks, { kind: "none" });
  },
};

/** `0.69.0 (claude 2.1.233)` — the agent reports the first token, not the annotation. */
export function firstVersion(measured: string): string {
  return measured.split(/\s+/)[0] ?? measured;
}

export default item;
