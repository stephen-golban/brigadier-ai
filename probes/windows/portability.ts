/**
 * Probe — ticket #5, the Windows portability contract.
 *
 * Runs on any platform so macOS/Linux act as the control column: a claim like
 * "clone --local hardlinks" is only interesting if we can show the same probe
 * reporting the opposite somewhere. Every check prints one `MEASURED` line.
 *
 * Usage: bun portability.ts <scratch-dir>
 */

import { mkdirSync, writeFileSync, statSync, rmSync, existsSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = Bun.argv[2];
if (!root) { console.error("usage: bun portability.ts <scratch-dir>"); process.exit(2); }
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const sh = (cmd: string[], cwd?: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode,
    out: new TextDecoder().decode(r.stdout).trim(),
    err: new TextDecoder().decode(r.stderr).trim(),
  };
};
const say = (k: string, v: string) => console.log(`MEASURED  ${k.padEnd(26)} ${v}`);

say("platform", `${process.platform} ${process.arch}`);
say("git", sh(["git", "--version"]).out);
say("bun", Bun.version);

// ---------------------------------------------------------------- source repo
// A repo big enough that a hardlink-vs-copy difference is visible in bytes.
const src = join(root, "src-repo");
mkdirSync(src, { recursive: true });
sh(["git", "init", "-q", "-b", "main"], src);
sh(["git", "config", "user.email", "probe@example.invalid"], src);
sh(["git", "config", "user.name", "probe"], src);
for (let i = 0; i < 200; i++) {
  writeFileSync(join(src, `f${i}.txt`), "x".repeat(20_000) + i);
}
sh(["git", "add", "-A"], src);
sh(["git", "commit", "-qm", "base"], src);

// ------------------------------------------------- 1. does --local hardlink?
const dst = join(root, "clone-local");
const t0 = performance.now();
const cl = sh(["git", "clone", "--local", "-q", src, dst]);
const cloneMs = performance.now() - t0;
if (cl.code !== 0) {
  say("clone--local", `FAILED rc=${cl.code} ${cl.err.slice(0, 200)}`);
} else {
  say("clone--local", `ok in ${cloneMs.toFixed(0)}ms`);
  // A hardlinked object shares an inode with the parent's copy and has nlink>=2.
  //
  // Getting a *sample object* to compare is where the earlier versions of this
  // check went wrong. Walking `.git/objects` found nothing on two of three
  // runners — git had already packed — and "no loose object found" renders
  // identically to "git did not hardlink", which is the exact failure the map
  // warns about. So ask git for the object list instead of guessing, and fall
  // back to the packfile, which is what actually gets hardlinked once packed.
  const objRoot = (repo: string) => join(repo, ".git", "objects");
  const sampleObjects = (): Array<[string, string]> => {
    const pairs: Array<[string, string]> = [];
    // Loose objects, named by git rather than discovered by walking.
    const shas = sh(["git", "rev-list", "--objects", "--all"], src).out
      .split(/\r?\n/).map((l) => l.trim().split(" ")[0]).filter((s) => /^[0-9a-f]{40}$/.test(s));
    for (const sha of shas) {
      const rel = join(sha.slice(0, 2), sha.slice(2));
      const a = join(objRoot(src), rel);
      const b = join(objRoot(dst), rel);
      if (existsSync(a) && existsSync(b)) pairs.push([a, b]);
      if (pairs.length >= 3) break;
    }
    if (pairs.length > 0) return pairs;
    // Packed: compare the packfiles themselves.
    const packSrc = join(objRoot(src), "pack");
    const packDst = join(objRoot(dst), "pack");
    try {
      for (const name of readdirSync(packSrc)) {
        if (!name.endsWith(".pack")) continue;
        const a = join(packSrc, name);
        const b = join(packDst, name);
        if (existsSync(b)) pairs.push([a, b]);
      }
    } catch { /* no pack dir */ }
    return pairs;
  };

  const pairs = sampleObjects();
  if (pairs.length === 0) {
    say("hardlink-check", "INCONCLUSIVE no object present in BOTH parent and clone");
  } else {
    const [a0, b0] = pairs[0];
    const a = statSync(a0);
    const b = statSync(b0);
    const linked = a.ino === b.ino && a.dev === b.dev && a.nlink >= 2;
    say("hardlink-check",
      `${linked ? "HARDLINKED" : "COPIED"} via ${a0.endsWith(".pack") ? "packfile" : "loose object"} ` +
      `parent(ino=${a.ino},nlink=${a.nlink}) clone(ino=${b.ino},nlink=${b.nlink})`);
  }
  // Negative control: --no-hardlinks MUST report COPIED, or the check is blind.
  const nl = join(root, "clone-nohard");
  sh(["git", "clone", "--local", "--no-hardlinks", "-q", src, nl]);
  // Re-derive the sample: a clone can trigger `gc --auto` in the source, which
  // packs the loose object the first pass picked and makes it vanish mid-probe.
  const ctlPairs = sampleObjects().filter(([a]) => existsSync(a));
  let done = false;
  for (const [a0] of ctlPairs) {
    const rel = a0.slice(objRoot(src).length + 1);
    const mirror = join(objRoot(nl), rel);
    if (!existsSync(mirror)) continue;
    const a = statSync(a0), b = statSync(mirror);
    say("hardlink-negctl", a.ino === b.ino ? "HARDLINKED(BAD — check is blind)" : "COPIED(expected)");
    done = true;
    break;
  }
  if (!done) say("hardlink-negctl", "INCONCLUSIVE no shared object between source and control clone");
}

// ------------------------------------------------------------- 2. MAX_PATH
// Clone paths nest a repo inside a per-run directory, so depth is real.
// One data point only tells you it broke somewhere below that; walk it up so
// the contract can state an actual budget.
let lastMkdirOk = 0;
let lastCloneOk = 0;
let firstCloneFail = 0;
let firstFailErr = "";
for (let depth = 1; depth <= 16; depth++) {
  let deep = join(root, "deep");
  for (let i = 0; i < depth; i++) deep = join(deep, "d".repeat(20));
  const deepClone = join(deep, "repo");
  try { mkdirSync(deep, { recursive: true }); } catch { break; }
  lastMkdirOk = deep.length;
  const dc = sh(["git", "clone", "--local", "-q", src, deepClone]);
  if (dc.code === 0) {
    lastCloneOk = deepClone.length;
  } else {
    firstCloneFail = deepClone.length;
    firstFailErr = dc.err.replace(/\s+/g, " ").slice(0, 120);
    break;
  }
}
say("deep-mkdir-max-ok", `${lastMkdirOk} chars`);
say("deep-clone-max-ok", `${lastCloneOk} chars`);
say("deep-clone-first-fail", firstCloneFail ? `${firstCloneFail} chars — ${firstFailErr}` : "none up to depth 16");

// ----------------------------------------------------------------- 3. CRLF
// What does core.autocrlf do to a `git diff base..head` handed to a reviewer?
for (const mode of ["false", "true", "input"]) {
  const r2 = join(root, `crlf-${mode}`);
  mkdirSync(r2, { recursive: true });
  sh(["git", "init", "-q", "-b", "main"], r2);
  sh(["git", "config", "user.email", "probe@example.invalid"], r2);
  sh(["git", "config", "user.name", "probe"], r2);
  sh(["git", "config", "core.autocrlf", mode], r2);
  writeFileSync(join(r2, "a.txt"), "one\ntwo\nthree\n");
  sh(["git", "add", "-A"], r2);
  sh(["git", "commit", "-qm", "base"], r2);
  const base = sh(["git", "rev-parse", "HEAD"], r2).out;
  // A worker edits the file with its own platform's line endings.
  writeFileSync(join(r2, "a.txt"), process.platform === "win32" ? "one\r\ntwo\r\nCHANGED\r\n" : "one\ntwo\nCHANGED\n");
  sh(["git", "add", "-A"], r2);
  sh(["git", "commit", "-qm", "edit"], r2);
  const d = sh(["git", "diff", `${base}..HEAD`], r2);
  const changed = d.out.split(/\r?\n/).filter((l) => /^[+-][^+-]/.test(l)).length;
  const bytesOnDisk = readFileSync(join(r2, "a.txt")).length;
  const blob = sh(["git", "cat-file", "-p", "HEAD:a.txt"], r2).out;
  say(`crlf autocrlf=${mode}`,
    `diff-lines=${changed} worktree-bytes=${bytesOnDisk} blob-has-CR=${/\r/.test(blob)}`);
}

// ------------------------------------------------------------- 4. symlinks
// Decision 7 and the secrets ticket both depend on what replaces them.
const linkTarget = join(root, "target.txt");
writeFileSync(linkTarget, "hello");
const linkPath = join(root, "link.txt");
try {
  symlinkSync(linkTarget, linkPath);
  say("symlink-create", `ok (unprivileged=${process.platform !== "win32" ? "n/a" : "yes"})`);
} catch (e: any) {
  say("symlink-create", `FAILED ${e.code ?? ""} ${String(e.message).slice(0, 120)}`);
}
const sl = sh(["git", "config", "--get", "core.symlinks"], src);
say("git core.symlinks", sl.out || "(unset — git decides at init)");

// ----------------------------------------------- 5. executable resolution
// Decision 6 spawns every candidate agent to handshake it; on Windows the
// agent is usually a .cmd shim, and whether Bun.spawn finds it matters.
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });
if (process.platform === "win32") {
  writeFileSync(join(binDir, "probetool.cmd"), "@echo HELLO-FROM-CMD\r\n");
  writeFileSync(join(binDir, "probeps.ps1"), "Write-Output 'HELLO-FROM-PS1'\r\n");
} else {
  writeFileSync(join(binDir, "probetool"), "#!/bin/sh\necho HELLO-FROM-SH\n", { mode: 0o755 });
}
const withPath = { ...process.env, PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
for (const attempt of process.platform === "win32"
  ? ["probetool", "probetool.cmd", "probeps.ps1"]
  : ["probetool"]) {
  // A throw is itself a result here — decision 6 spawns every candidate agent,
  // and on Windows an agent is often a shim Bun may refuse to exec.
  try {
    const r = Bun.spawnSync([attempt], { env: withPath, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(r.stdout).trim();
    say(`spawn "${attempt}"`, r.exitCode === 0 ? `rc=0 out=${out}` : `rc=${r.exitCode} err=${new TextDecoder().decode(r.stderr).trim().slice(0, 120)}`);
  } catch (e: any) {
    say(`spawn "${attempt}"`, `THREW ${e.code ?? ""} ${String(e.message).slice(0, 120)}`);
  }
}
say("PATHEXT", process.env.PATHEXT ?? "(unset)");

console.log("DONE");
