#!/usr/bin/env node
// scripts/cli-drift.mjs — drift detector for the Claude Code CLI's argv surface.
//
// ============================ READ THIS FIRST ============================
// THIS SCRIPT MUST NEVER COST MONEY. It runs exactly two kinds of command:
//     claude --version
//     claude [<subcommand>] --help
// It never starts a session, never sends a prompt, never touches the API.
// Do not add `-p`, `--print`, a prompt argument, `--resume`, or anything that
// spawns a turn. A detector that spends tokens is a detector nobody runs, and
// this one exists precisely because the last CLI break was silent.
// =========================================================================
//
// Why it exists: over eleven months the CLI's stdio control protocol did not
// move, but argv did — `--resume <id>` became `--resume=<id>` with no notice.
// `claude --help` shows `-r, --resume [value]`; an optional-argument flag means
// the old spelling fails SILENTLY instead of erroring. See docs/research/cli-drift.md.
//
// Usage:
//   node scripts/cli-drift.mjs             compare against the committed snapshots; exit 1 on any difference
//   node scripts/cli-drift.mjs --update    rewrite the snapshots from this machine (review, then commit)
//   node scripts/cli-drift.mjs --help
//
// Env:
//   CLAUDE_BIN         path to the claude binary            (default: `claude` from PATH)
//   CLAUDE_AGENT_SDK   @anthropic-ai/claude-agent-sdk dir   (default: auto-resolve; optional)
//
// Exit codes: 0 = no drift (or --update wrote the files), 1 = drift, 2 = could not run.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGV_SNAPSHOT = path.join(HERE, 'cli-drift.argv.snapshot');
const SDK_SNAPSHOT = path.join(HERE, 'cli-drift.sdk.snapshot');
const HELP_TIMEOUT_MS = 15000;

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
    .filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

// ---------------------------------------------------------------- normalise

const HOME = os.homedir();

function normaliseText(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // ANSI
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~'))
    .map((l) => l.replace(/\/Users\/[^/\s]+/g, '~'))
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n');
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- run claude

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function runClaude(argv) {
  return execFileSync(CLAUDE_BIN, argv, {
    encoding: 'utf8',
    timeout: HELP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COLUMNS: '80', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

// ---------------------------------------------------------------- parse help
//
// A commander help is parsed into entries keyed by canonical name, so that an
// ARITY change (`--resume <value>` -> `--resume [value]`) shows up as a change
// to one entry rather than as an unrelated add+remove pair.

const OPTION_TERM = /^((?:-[A-Za-z0-9], )?--[A-Za-z0-9][A-Za-z0-9-]*(?:, --[A-Za-z0-9][A-Za-z0-9-]*)*|-[A-Za-z0-9])((?: (?:<[^>]*>|\[[^\]]*\]))?)/;
const COMMAND_TERM = /^([a-z][a-z0-9-]*(?:\|[a-z][a-z0-9-]*)*)((?:\s+(?:<[^>]*>|\[[^\]]*\]))*)/;

function parseHelp(raw) {
  const text = normaliseText(raw);
  const lines = text.split('\n');
  const usage = [];
  const entries = [];
  let section = null;
  let pending = null;

  const flush = () => {
    if (!pending) return;
    const body = collapse(pending.text);
    const kind = pending.section;
    let key = null, flags = '', argspec = '', desc = body;
    if (kind === 'opt') {
      const m = OPTION_TERM.exec(body);
      if (m) {
        flags = m[1];
        argspec = m[2].trim();
        desc = body.slice(m[0].length).trim();
        const longs = flags.split(', ').filter((f) => f.startsWith('--'));
        key = longs.length ? longs[longs.length - 1] : flags;
      }
    } else if (kind === 'cmd') {
      const m = COMMAND_TERM.exec(body);
      if (m) {
        flags = m[1];
        argspec = collapse(m[2]);
        desc = body.slice(m[0].length).trim();
        key = m[1].split('|')[0];
      }
    } else if (kind === 'arg') {
      const m = /^(\S+)/.exec(body);
      if (m) { key = m[1]; flags = m[1]; desc = body.slice(m[0].length).trim(); }
    }
    if (key) entries.push({ kind, key, flags, argspec, desc });
    pending = null;
  };

  for (const line of lines) {
    if (/^Usage:/.test(line)) { flush(); section = null; usage.push(collapse(line)); continue; }
    const head = /^([A-Z][A-Za-z ]*):\s*$/.exec(line);
    if (head) {
      flush();
      const name = head[1].toLowerCase();
      section = name === 'options' ? 'opt' : name === 'commands' ? 'cmd' : name === 'arguments' ? 'arg' : null;
      continue;
    }
    if (!section) { flush(); continue; }
    if (/^ {2}\S/.test(line)) { flush(); pending = { section, text: line.trim() }; continue; }
    if (/^ {3,}\S/.test(line) && pending) { pending.text += ' ' + line.trim(); continue; }
    if (line.trim() === '') continue;
    flush();
  }
  flush();

  // Safety net for anything the parser does not model (hand-rolled helps, prose
  // flags listed outside an Options: section): a digest of the whole normalised body.
  const bodyDigest = sha(lines.map(collapse).filter(Boolean).join('\n'));
  return { usage, entries, bodyDigest };
}

// ---------------------------------------------------------------- argv snapshot

function buildArgvSnapshot() {
  let version;
  try {
    version = collapse(normaliseText(runClaude(['--version'])));
  } catch (e) {
    console.error(`cli-drift: cannot run \`${CLAUDE_BIN} --version\`: ${e.message}`);
    process.exit(2);
  }

  const rootHelp = parseHelp(runClaude(['--help']));
  const subcommands = rootHelp.entries.filter((e) => e.kind === 'cmd').map((e) => e.key).sort();

  const out = [];
  out.push('# claude CLI argv surface — snapshot');
  out.push('# generated by scripts/cli-drift.mjs; regenerate with `node scripts/cli-drift.mjs --update`');
  out.push('# built from `claude --version` and `claude [<sub>] --help` only. No session, no prompt, no spend.');
  out.push('');
  out.push(`cli-version\t${version}`);
  out.push('');

  const emit = (label, parsed) => {
    out.push(`## ${label}`);
    for (const u of parsed.usage) out.push(`usage\t${u}`);
    out.push(`body-digest\t${parsed.bodyDigest}`);
    const order = { arg: 0, opt: 1, cmd: 2 };
    const sorted = [...parsed.entries].sort((a, b) =>
      (order[a.kind] - order[b.kind]) || a.key.localeCompare(b.key));
    for (const e of sorted) {
      out.push(`${e.kind}\t${e.key}\tflags=${e.flags}\targ=${e.argspec}\t:: ${e.desc}`);
    }
    out.push('');
  };

  emit('claude', rootHelp);
  for (const sub of subcommands) {
    let parsed;
    try {
      parsed = parseHelp(runClaude([sub, '--help']));
    } catch (e) {
      out.push(`## claude ${sub}`);
      out.push(`unavailable\t${e.code || e.signal || 'error'}`);
      out.push('');
      console.error(`cli-drift: \`${CLAUDE_BIN} ${sub} --help\` did not produce help (${e.message.split('\n')[0]})`);
      continue;
    }
    emit(`claude ${sub}`, parsed);
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

// ---------------------------------------------------------------- sdk snapshot

function resolveSdkDir() {
  const fromEnv = process.env.CLAUDE_AGENT_SDK;
  if (fromEnv) {
    const dir = fromEnv.endsWith('.mjs') ? path.dirname(fromEnv) : fromEnv;
    if (fs.existsSync(path.join(dir, 'sdk.mjs'))) return { dir, how: 'CLAUDE_AGENT_SDK' };
    return { dir: null, why: `CLAUDE_AGENT_SDK=${fromEnv} has no sdk.mjs` };
  }
  try {
    const req = createRequire(path.join(HERE, '..', 'package.json'));
    const pkg = req.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    return { dir: path.dirname(pkg), how: 'node resolution from the repo' };
  } catch { /* fall through */ }
  // The SDK is not a dependency of this repo (the harness speaks the protocol
  // directly), so the usual place a copy exists on a dev box is the npx cache.
  const npx = path.join(os.homedir(), '.npm', '_npx');
  let best = null;
  try {
    for (const d of fs.readdirSync(npx)) {
      const p = path.join(npx, d, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
      if (!fs.existsSync(path.join(p, 'sdk.mjs'))) continue;
      const v = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8')).version;
      const num = v.split('.').map(Number);
      if (!best || num[0] * 1e6 + num[1] * 1e3 + num[2] > best.rank) {
        best = { dir: p, rank: num[0] * 1e6 + num[1] * 1e3 + num[2], v };
      }
    }
  } catch { /* no npx cache */ }
  if (best) return { dir: best.dir, how: `~/.npm/_npx scan (highest version: ${best.v})` };
  return { dir: null, why: 'not a dependency of this repo and no copy found in ~/.npm/_npx' };
}

function uniqSorted(it) { return [...new Set(it)].sort(); }

function buildSdkSnapshot() {
  const r = resolveSdkDir();
  if (!r.dir) return { text: null, why: r.why };

  const pkg = JSON.parse(fs.readFileSync(path.join(r.dir, 'package.json'), 'utf8'));
  const mjs = fs.readFileSync(path.join(r.dir, 'sdk.mjs'), 'utf8');
  const dtsPath = path.join(r.dir, 'sdk.d.ts');
  const dts = fs.existsSync(dtsPath) ? fs.readFileSync(dtsPath, 'utf8') : '';
  let manifestVersion = 'absent';
  try {
    manifestVersion = JSON.parse(fs.readFileSync(path.join(r.dir, 'manifest.json'), 'utf8')).version || 'absent';
  } catch { /* older SDKs have no manifest */ }

  // Flags as they are actually pushed onto argv. The quote class covers template
  // literals, which is how `--resume=${id}` is spelled — the exact shape of the
  // only breaking change observed in eleven months.
  const flagRe = /["'`](--[A-Za-z][A-Za-z0-9._-]*=?)/g;
  const subRe = /subtype\s*:\s*["'`]([a-z_]+)["'`]/g;
  const grab = (re, src) => { const o = []; let m; re.lastIndex = 0; while ((m = re.exec(src))) o.push(m[1]); return o; };

  const out = [];
  out.push('# @anthropic-ai/claude-agent-sdk control-protocol surface — snapshot');
  out.push('# generated by scripts/cli-drift.mjs; regenerate with `node scripts/cli-drift.mjs --update`');
  out.push('# read from sdk.mjs / sdk.d.ts on disk. Nothing is executed. sdk.mjs is the source of truth');
  out.push('# (docs/research/cli-protocol.md §3: the .d.ts union is a curated subset of the wire).');
  out.push('');
  out.push(`sdk-version\t${pkg.version}`);
  out.push(`manifest-cli-version\t${manifestVersion}`);
  out.push(`mjs-permission-prompt-stdio-sentinel\t${/--permission-prompt-tool["'`],\s*["'`]stdio/.test(mjs) ? 'present' : 'ABSENT'}`);
  out.push('');
  for (const f of uniqSorted(grab(flagRe, mjs))) out.push(`mjs-argv-flag\t${f}`);
  out.push('');
  for (const s of uniqSorted(grab(subRe, mjs))) out.push(`mjs-subtype\t${s}`);
  out.push('');
  for (const s of uniqSorted(grab(subRe, dts))) out.push(`dts-subtype\t${s}`);
  return { text: out.join('\n') + '\n', how: r.how, version: pkg.version };
}

// ---------------------------------------------------------------- diff report

function reportArgvDiff(oldText, newText) {
  const parse = (text) => {
    const sections = new Map();
    const meta = new Map();
    let cur = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('## ')) { cur = line.slice(3); sections.set(cur, new Map()); continue; }
      if (line.startsWith('#') || line.trim() === '') continue;
      const [kind, ...rest] = line.split('\t');
      if (!cur) { meta.set(kind, rest.join('\t')); continue; }
      const s = sections.get(cur);
      if (kind === 'usage') {
        s.set(`usage[${s.size}]`, rest.join('\t'));
      } else if (kind === 'body-digest' || kind === 'unavailable') {
        s.set(kind, rest.join('\t'));
      } else {
        s.set(`${kind} ${rest[0]}`, { flags: (rest[1] || '').replace(/^flags=/, ''), arg: (rest[2] || '').replace(/^arg=/, ''), desc: (rest[3] || '').replace(/^:: /, '') });
      }
    }
    return { sections, meta };
  };

  const a = parse(oldText), b = parse(newText);
  const surface = [], prose = [];

  for (const [k, v] of b.meta) {
    const o = a.meta.get(k);
    if (o !== v) surface.push(`  ${k}: ${o === undefined ? '(absent)' : o}  ->  ${v}`);
  }

  const names = uniqSorted([...a.sections.keys(), ...b.sections.keys()]);
  for (const name of names) {
    const oldS = a.sections.get(name), newS = b.sections.get(name);
    if (!oldS) { surface.push(`  + new help page: \`${name}\``); continue; }
    if (!newS) { surface.push(`  - help page gone: \`${name}\``); continue; }
    const keys = uniqSorted([...oldS.keys(), ...newS.keys()]);
    for (const key of keys) {
      const o = oldS.get(key), n = newS.get(key);
      if (o === undefined) { surface.push(`  + ${name}: ${key}` + (typeof n === 'object' ? ` ${n.flags} ${n.arg}` : ` = ${n}`)); continue; }
      if (n === undefined) { surface.push(`  - ${name}: ${key}` + (typeof o === 'object' ? ` ${o.flags} ${o.arg}` : ` = ${o}`)); continue; }
      if (typeof o === 'string' || typeof n === 'string') {
        if (o !== n) surface.push(`  ~ ${name}: ${key}: ${o}  ->  ${n}`);
        continue;
      }
      if (o.flags !== n.flags) surface.push(`  ~ ${name}: ${key}: spelling ${o.flags}  ->  ${n.flags}`);
      if (o.arg !== n.arg) surface.push(`  ! ${name}: ${key}: ARITY ${o.arg || '(none)'}  ->  ${n.arg || '(none)'}`);
      if (o.desc !== n.desc) prose.push(`  ~ ${name}: ${key}\n      was: ${o.desc}\n      now: ${n.desc}`);
    }
  }
  return { surface, prose };
}

function reportLineDiff(oldText, newText) {
  const clean = (t) => t.split('\n').filter((l) => l && !l.startsWith('#'));
  const o = new Set(clean(oldText)), n = new Set(clean(newText));
  const out = [];
  for (const l of clean(oldText)) if (!n.has(l)) out.push(`  - ${l.replace(/\t/g, ' ')}`);
  for (const l of clean(newText)) if (!o.has(l)) out.push(`  + ${l.replace(/\t/g, ' ')}`);
  return out;
}

// ---------------------------------------------------------------- main

const argvText = buildArgvSnapshot();
const sdk = buildSdkSnapshot();

if (UPDATE) {
  fs.writeFileSync(ARGV_SNAPSHOT, argvText);
  console.log(`cli-drift: wrote ${path.relative(process.cwd(), ARGV_SNAPSHOT)}`);
  if (sdk.text) {
    fs.writeFileSync(SDK_SNAPSHOT, sdk.text);
    console.log(`cli-drift: wrote ${path.relative(process.cwd(), SDK_SNAPSHOT)} (SDK ${sdk.version}, via ${sdk.how})`);
  } else {
    console.log(`cli-drift: SDK snapshot NOT written — ${sdk.why}`);
    console.log('cli-drift: the argv snapshot alone is still a valid gate; see docs/research/cli-drift.md.');
  }
  console.log('cli-drift: review the diff before committing. A snapshot accepted without reading it is not a gate.');
  process.exit(0);
}

let drift = false;

if (!fs.existsSync(ARGV_SNAPSHOT)) {
  console.error(`cli-drift: no snapshot at ${ARGV_SNAPSHOT}. Run with --update to create it.`);
  process.exit(2);
}
const oldArgv = fs.readFileSync(ARGV_SNAPSHOT, 'utf8');
if (oldArgv !== argvText) {
  drift = true;
  const { surface, prose } = reportArgvDiff(oldArgv, argvText);
  console.error('cli-drift: ARGV SURFACE DRIFT');
  if (surface.length) {
    console.error('\n  --- flags, arity and commands (this is the part that breaks spawning) ---');
    for (const l of surface) console.error(l);
  }
  if (prose.length) {
    console.error('\n  --- help text only (no argv change; review, then accept) ---');
    for (const l of prose) console.error(l);
  }
  if (!surface.length && !prose.length) {
    console.error('  snapshot bytes differ but no parsed entry changed — inspect the file by hand:');
    for (const l of reportLineDiff(oldArgv, argvText).slice(0, 40)) console.error(l);
  }
}

if (!sdk.text) {
  console.error(`\ncli-drift: SDK type surface NOT checked — ${sdk.why}`);
  console.error('cli-drift: carrying on with the argv check only (set CLAUDE_AGENT_SDK to point at a copy).');
} else if (!fs.existsSync(SDK_SNAPSHOT)) {
  console.error(`\ncli-drift: no SDK snapshot at ${SDK_SNAPSHOT}. Run with --update to create it.`);
  drift = true;
} else {
  const oldSdk = fs.readFileSync(SDK_SNAPSHOT, 'utf8');
  if (oldSdk !== sdk.text) {
    drift = true;
    console.error(`\ncli-drift: SDK CONTROL-PROTOCOL SURFACE DRIFT (read SDK ${sdk.version} via ${sdk.how})`);
    for (const l of reportLineDiff(oldSdk, sdk.text)) console.error(l);
  }
}

if (drift) {
  console.error('\ncli-drift: FAIL. If the change is a real, reviewed CLI/SDK upgrade, accept it with:');
  console.error('  node scripts/cli-drift.mjs --update   # then commit the snapshot with the upgrade');
  process.exit(1);
}

console.log(`cli-drift: OK — argv surface matches ${path.basename(ARGV_SNAPSHOT)}`
  + (sdk.text ? `, SDK ${sdk.version} matches ${path.basename(SDK_SNAPSHOT)}.` : ' (SDK surface not checked).'));
process.exit(0);
