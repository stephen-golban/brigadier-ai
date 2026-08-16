/**
 * Probe — ticket #5, the Windows portability contract.
 *
 * Runs on any platform so macOS/Linux act as the control column: a claim like
 * "clone --local hardlinks" is only interesting if we can show the same probe
 * reporting the opposite somewhere. Every check prints one `MEASURED` line.
 *
 * Usage: bun portability.ts <scratch-dir>
 */

import { mkdirSync, writeFileSync, statSync, rmSync, existsSync, symlinkSync, readFileSync } from "node:fs";
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
  // A hardlinked object has nlink >= 2 and shares an inode with the parent's copy.
  const packDir = join(src, ".git", "objects");
  const findLoose = (base: string): string | null => {
    const r = sh(process.platform === "win32"
      ? ["cmd", "/c", `dir /s /b "${base}" | findstr /v /c:"info" | findstr /v /c:"pack"`]
      : ["sh", "-c", `find "${base}" -type f -not -path '*/pack/*' -not -path '*/info/*' | head -1`]);
    const first = r.out.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
  };
  const sample = findLoose(packDir);
  if (!sample) {
    say("hardlink-check", "INCONCLUSIVE no loose object found in parent");
  } else {
    const rel = sample.slice(packDir.length + 1);
    const mirror = join(dst, ".git", "objects", rel);
    if (!existsSync(mirror)) {
      say("hardlink-check", `INCONCLUSIVE clone lacks ${rel}`);
    } else {
      const a = statSync(sample);
      const b = statSync(mirror);
      const linked = a.ino === b.ino && a.dev === b.dev && a.nlink >= 2;
      say("hardlink-check",
        `${linked ? "HARDLINKED" : "COPIED"} parent(ino=${a.ino},nlink=${a.nlink}) clone(ino=${b.ino},nlink=${b.nlink})`);
    }
  }
  // Negative control: --no-hardlinks MUST report COPIED, or the check is blind.
  const nl = join(root, "clone-nohard");
  sh(["git", "clone", "--local", "--no-hardlinks", "-q", src, nl]);
  const sample2 = findLoose(join(src, ".git", "objects"));
  if (sample2) {
    const rel = sample2.slice(join(src, ".git", "objects").length + 1);
    const mirror = join(nl, ".git", "objects", rel);
    if (existsSync(mirror)) {
      const a = statSync(sample2), b = statSync(mirror);
      say("hardlink-negctl", `${a.ino === b.ino ? "HARDLINKED(BAD)" : "COPIED(expected)"}`);
    }
  }
}

// ------------------------------------------------------------- 2. MAX_PATH
// Clone paths nest a repo inside a per-run directory, so depth is real.
let deep = root;
for (let i = 0; i < 12; i++) deep = join(deep, "d".repeat(20));
const deepClone = join(deep, "repo");
let mk = { code: 0 as number | null, err: "" };
try { mkdirSync(deep, { recursive: true }); } catch (e: any) { mk = { code: 1, err: String(e.message) }; }
say("deep-path-len", String(deepClone.length));
if (mk.code !== 0) {
  say("deep-mkdir", `FAILED ${mk.err.slice(0, 160)}`);
} else {
  const dc = sh(["git", "clone", "--local", "-q", src, deepClone]);
  say("deep-clone", dc.code === 0 ? `ok at ${deepClone.length} chars` : `FAILED rc=${dc.code} ${dc.err.slice(0, 200)}`);
}

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
  const r = Bun.spawnSync([attempt], { env: withPath, stdout: "pipe", stderr: "pipe" });
  const out = new TextDecoder().decode(r.stdout).trim();
  say(`spawn "${attempt}"`, r.exitCode === 0 ? `rc=0 out=${out}` : `rc=${r.exitCode} err=${new TextDecoder().decode(r.stderr).trim().slice(0, 120)}`);
}
say("PATHEXT", process.env.PATHEXT ?? "(unset)");

console.log("DONE");
