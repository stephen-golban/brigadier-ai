#!/usr/bin/env node
/**
 * vendor-codex-ui-kit.mjs — vendor a chosen subset of JaminZhou/codex-ui-kit (MIT)
 * into a destination directory, carrying only the CSS those components use.
 *
 * Node built-ins only. No dependencies, no install step.
 *
 *   node vendor-codex-ui-kit.mjs \
 *     --components CommandExecution,FileChange,TurnDuration \
 *     --dest ./vendored-preview
 *
 * Options
 *   --commit <sha>          pinned source commit (default below)
 *   --components <a,b,c>    allow-list of component basenames under src/components
 *                           (also accepts paths relative to src/, e.g. internal/inert)
 *   --dest <dir>            destination directory (required)
 *   --source <path>         local clone to read from (default: ./codex-ui-kit next to this script)
 *   --remote                ignore the local clone; fetch every file from raw.githubusercontent
 *                           at --commit
 *   --var-prefix <p>        replacement for the `--codex-ui-` custom-property prefix
 *                           (default `--bg-`)
 *   --class-prefix <p>      replacement for the `codex-ui-` class prefix (default `bg-`)
 *   --follow-imports        also vendor local modules the allow-listed files import
 *                           (transitively). Off by default: unresolved imports are
 *                           reported, not silently pulled in.
 *   --dry-run               compute and report, write nothing
 *
 * What it does
 *   1. copies each allow-listed component file
 *   2. collects every `codex-ui-*` token that appears in those files
 *   3. slices src/styles.css by class prefix, brace-aware, recursing into
 *      @media / @container / @supports / @layer, and pulls in the @keyframes the
 *      kept declarations reference
 *   4. copies src/tokens.css whole
 *   5. renames `--codex-ui-` and `codex-ui-` prefixes in every output
 *   6. prepends an ATTRIBUTION block (MIT text, copyright, the not-affiliated-with-
 *      OpenAI notice, source commit) to every file it writes
 *   7. prints the byte size of the extracted CSS
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_COMMIT = "9f3af2c3a6386d4ea05f8b3f2c1051ae1a50789d";
const REPO = "JaminZhou/codex-ui-kit";
const COPYRIGHT = "Copyright (c) 2026 JaminZhou";
const NOT_AFFILIATED =
  "This is an unofficial, independently developed open-source project for the " +
  "public Codex ecosystem. It is not affiliated with, sponsored by, or endorsed " +
  "by OpenAI. Codex and OpenAI are trademarks of OpenAI.";
const MIT_TEXT = `MIT License

${COPYRIGHT}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// ---------------------------------------------------------------- argv

function parseArgs(argv) {
  const opts = {
    commit: DEFAULT_COMMIT,
    components: [],
    dest: null,
    source: path.join(HERE, "codex-ui-kit"),
    remote: false,
    varPrefix: "--bg-",
    classPrefix: "bg-",
    followImports: false,
    dryRun: false,
    includeOpenaiAssets: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--commit": opts.commit = next(); break;
      case "--components": opts.components = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--dest": opts.dest = next(); break;
      case "--source": opts.source = next(); break;
      case "--remote": opts.remote = true; break;
      case "--var-prefix": opts.varPrefix = next(); break;
      case "--class-prefix": opts.classPrefix = next(); break;
      case "--follow-imports": opts.followImports = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--include-openai-assets": opts.includeOpenaiAssets = true; break;
      case "-h": case "--help": usage(); process.exit(0); break;
      default: fail(`unknown option ${a}`);
    }
  }
  if (!opts.dest) fail("--dest is required");
  if (opts.components.length === 0) fail("--components is required (comma-separated allow-list)");
  return opts;
}

function usage() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const doc = text.slice(text.indexOf("/**"), text.indexOf("*/") + 2);
  console.log(doc);
}

function fail(msg) {
  console.error(`vendor-codex-ui-kit: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------- source access

function makeReader(opts) {
  if (!opts.remote) {
    const root = path.resolve(opts.source);
    if (!fs.existsSync(root)) fail(`local clone not found at ${root} (pass --source, or --remote)`);
    return {
      kind: "local",
      root,
      async read(rel) {
        const p = path.join(root, rel);
        if (!fs.existsSync(p)) return null;
        return fs.readFileSync(p, "utf8");
      },
    };
  }
  const base = `https://raw.githubusercontent.com/${REPO}/${opts.commit}/`;
  return {
    kind: "remote",
    root: base,
    async read(rel) {
      const res = await fetch(base + rel);
      if (!res.ok) return null;
      return await res.text();
    },
  };
}

// ---------------------------------------------------------------- CSS slicing

/**
 * Split a CSS body into top-level blocks. Brace-aware, string- and
 * comment-aware, so a `{` inside `content: "{"` does not open a block.
 * Returns [{ kind: "at"|"rule", prelude, body, raw }].
 */
function splitBlocks(css) {
  const out = [];
  let i = 0;
  let start = 0;
  let depth = 0;
  let preludeEnd = -1;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    // comments
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // strings
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n) {
        if (css[i] === "\\") { i += 2; continue; }
        if (css[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "{") {
      if (depth === 0) preludeEnd = i;
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      if (depth === 0) {
        const prelude = css.slice(start, preludeEnd).trim();
        const body = css.slice(preludeEnd + 1, i - 1);
        out.push({
          kind: prelude.startsWith("@") ? "at" : "rule",
          prelude,
          body,
          raw: css.slice(start, i),
        });
        start = i;
      }
      continue;
    }
    if (c === ";" && depth === 0) {
      // a statement at top level: @import, @charset, a stray declaration
      const stmt = css.slice(start, i + 1).trim();
      if (stmt) out.push({ kind: "stmt", prelude: stmt, body: "", raw: stmt });
      i++;
      start = i;
      continue;
    }
    i++;
  }
  return out;
}

/** Split a selector list on top-level commas (respecting (), [], strings). */
function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === '"' || c === "'") {
      const q = c;
      buf += c;
      i++;
      while (i < prelude.length) {
        buf += prelude[i];
        if (prelude[i] === "\\") { buf += prelude[++i] ?? ""; i++; continue; }
        if (prelude[i] === q) { i++; break; }
        i++;
      }
      i--;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (c === "," && depth === 0) { parts.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

const CLASS_TOKEN = /\.((?:[\w-]|\\.)+)/g;

/** Does this single selector reference a class the kept components use? */
function selectorWanted(sel, wanted) {
  CLASS_TOKEN.lastIndex = 0;
  let m;
  let sawPrefixed = false;
  while ((m = CLASS_TOKEN.exec(sel)) !== null) {
    const cls = m[1];
    if (!cls.startsWith("codex-ui-")) continue;
    sawPrefixed = true;
    for (const w of wanted) {
      if (cls === w || cls.startsWith(w)) return true;
    }
  }
  // A selector with no codex-ui-* class at all (e.g. `:root`, `@keyframes` inner
  // steps, a bare element rule) is kept — it is global scaffolding, not another
  // component's styling. A selector that IS codex-ui-prefixed but matches nothing
  // wanted belongs to a component we are not vendoring.
  return !sawPrefixed;
}

const ANIMATION_DECL = /animation(?:-name)?\s*:\s*([^;}]+)/g;
const IDENT = /[A-Za-z_-][\w-]*/g;

function collectAnimationNames(cssText, into) {
  ANIMATION_DECL.lastIndex = 0;
  let m;
  while ((m = ANIMATION_DECL.exec(cssText)) !== null) {
    IDENT.lastIndex = 0;
    let id;
    while ((id = IDENT.exec(m[1])) !== null) into.add(id[0]);
  }
}

/**
 * Extract the rules the wanted classes need.
 * Returns { css, keptRules, droppedRules, keyframes }.
 */
function extractCss(css, wanted) {
  const stats = { kept: 0, dropped: 0, keyframes: 0, atKept: 0 };
  const animations = new Set();
  const keyframeBlocks = new Map(); // name -> raw

  const walk = (blocks) => {
    const out = [];
    for (const b of blocks) {
      if (b.kind === "stmt") {
        // @import pulls in a whole external stylesheet; never carry one silently.
        if (/^@import/i.test(b.prelude)) {
          out.push(`/* dropped by vendor script: ${b.prelude.replace(/\*\//g, "*\\/")} */`);
          continue;
        }
        out.push(b.raw);
        continue;
      }
      if (b.kind === "at") {
        const name = (b.prelude.match(/^@([\w-]+)/) || [])[1]?.toLowerCase();
        if (name === "keyframes" || name?.endsWith("keyframes")) {
          const kfName = b.prelude.replace(/^@[\w-]+\s+/, "").trim();
          keyframeBlocks.set(kfName, b.raw);
          continue; // decided later, by reference
        }
        if (name === "media" || name === "container" || name === "supports" || name === "layer" || name === "scope") {
          const inner = walk(splitBlocks(b.body));
          if (inner.trim()) {
            stats.atKept++;
            out.push(`${b.prelude} {\n${inner}\n}`);
          }
          continue;
        }
        // @font-face, @property, @page … keep as-is
        out.push(b.raw);
        continue;
      }
      // plain rule
      const sels = splitSelectors(b.prelude).filter((s) => selectorWanted(s, wanted));
      if (sels.length === 0) { stats.dropped++; continue; }
      stats.kept++;
      collectAnimationNames(b.body, animations);
      out.push(`${sels.join(",\n")} {${b.body}}`);
    }
    return out.join("\n");
  };

  let body = walk(splitBlocks(css));

  // pull in referenced keyframes (one pass is enough: keyframe bodies do not
  // declare further animations in this kit; a second pass is cheap insurance)
  const kf = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, raw] of keyframeBlocks) {
      if (animations.has(name) && !kf.includes(raw)) {
        kf.push(raw);
        collectAnimationNames(raw, animations);
      }
    }
  }
  stats.keyframes = kf.length;
  if (kf.length) body += "\n\n" + kf.join("\n");
  return { css: body, stats };
}

// ---------------------------------------------------------------- rename + attribution

function rename(text, opts) {
  // custom properties first: `--codex-ui-x` would otherwise be rewritten by the
  // class rule into `--<classPrefix>x`, which is a different name.
  return text
    .split("--codex-ui-").join(opts.varPrefix)
    .split("codex-ui-").join(opts.classPrefix);
}

function attribution(sourceRel, opts) {
  return [
    "/*",
    " * Vendored from codex-ui-kit — https://github.com/" + REPO,
    ` * Source file:   ${sourceRel}`,
    ` * Source commit: ${opts.commit}`,
    ` * Token/class prefixes renamed: --codex-ui- -> ${opts.varPrefix}, codex-ui- -> ${opts.classPrefix}`,
    " *",
    ` * ${NOT_AFFILIATED}`,
    " *",
    ...MIT_TEXT.split("\n").map((l) => (l ? ` * ${l}` : " *")),
    " */",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- imports

const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;

function localImports(source, relPath) {
  const out = [];
  IMPORT_FROM.lastIndex = 0;
  let m;
  while ((m = IMPORT_FROM.exec(source)) !== null) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const clean = spec.replace(/\?.*$/, "");
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), clean));
    out.push({ spec, resolved });
  }
  return out;
}

function candidatePaths(resolvedNoExt) {
  const base = resolvedNoExt.replace(/\.(js|jsx|mjs)$/, "");
  return [`${base}.tsx`, `${base}.ts`, `${base}.svg`, base];
}

// ---------------------------------------------------------------- main

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const reader = makeReader(opts);

  // resolve the allow-list to repo-relative paths under src/
  const queue = [];
  for (const c of opts.components) {
    const rel = c.includes("/") ? `src/${c}` : `src/components/${c}`;
    queue.push(rel);
  }

  const files = new Map(); // relPath -> source text
  const missing = [];
  const unresolvedImports = [];
  const refusedAssets = [];
  const seen = new Set();

  // src/assets/subagents/*.svg were captured from a running OpenAI Codex Desktop
  // build. src/assets/subagents/README.md: "The upstream artwork remains
  // copyright OpenAI. No ownership is claimed, and these observed assets are not
  // relicensed under the repository's MIT license." The kit's own SOURCES.md
  // also says "Do not ship OpenAI or Codex logos, fonts, sounds, illustrations,
  // or other brand assets." They are refused unless explicitly asked for.
  const isOpenAiAsset = (rel) => rel.startsWith("src/assets/");

  while (queue.length) {
    const wantedRel = queue.shift();
    if (seen.has(wantedRel)) continue;
    seen.add(wantedRel);

    let found = null;
    for (const cand of candidatePaths(wantedRel)) {
      const text = await reader.read(cand);
      if (text !== null) { found = { rel: cand, text }; break; }
    }
    if (!found) { missing.push(wantedRel); continue; }
    if (isOpenAiAsset(found.rel) && !opts.includeOpenaiAssets) {
      refusedAssets.push(found.rel);
      continue;
    }
    files.set(found.rel, found.text);

    for (const imp of localImports(found.text, found.rel)) {
      let exists = false;
      for (const cand of candidatePaths(imp.resolved)) {
        if (seen.has(cand) || files.has(cand)) { exists = true; break; }
        const t = await reader.read(cand);
        if (t !== null) { exists = true; if (opts.followImports) queue.push(cand); break; }
      }
      if (!exists) continue;
      if (!opts.followImports) unresolvedImports.push(`${found.rel} -> ${imp.spec}`);
    }
  }

  if (missing.length) {
    console.error("not found in source:");
    for (const m of missing) console.error("  " + m);
    process.exit(1);
  }

  // classes used by the kept files
  const wanted = new Set();
  for (const text of files.values()) {
    for (const m of text.matchAll(/codex-ui-[\w-]+/g)) wanted.add(m[0]);
  }

  const stylesRaw = await reader.read("src/styles.css");
  if (stylesRaw === null) fail("src/styles.css not found in source");
  const tokensRaw = await reader.read("src/tokens.css");
  if (tokensRaw === null) fail("src/tokens.css not found in source");

  const { css: slicedCss, stats } = extractCss(stylesRaw, wanted);
  const outStyles = rename(slicedCss, opts).trim() + "\n";
  const outTokens = rename(tokensRaw, opts).trim() + "\n";

  const stylesBytes = Buffer.byteLength(outStyles, "utf8");
  const tokensBytes = Buffer.byteLength(outTokens, "utf8");
  const sourceStylesBytes = Buffer.byteLength(stylesRaw, "utf8");

  if (!opts.dryRun) {
    fs.mkdirSync(opts.dest, { recursive: true });
    for (const [rel, text] of files) {
      const outPath = path.join(opts.dest, path.relative("src", rel));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const isText = /\.(tsx?|jsx?|css|svg)$/.test(rel);
      const body = isText ? rename(text, opts) : text;
      const head = /\.svg$/.test(rel) ? "" : attribution(rel, opts);
      fs.writeFileSync(outPath, head + body);
    }
    fs.writeFileSync(
      path.join(opts.dest, "styles.css"),
      attribution("src/styles.css (sliced by class prefix)", opts) + outStyles,
    );
    fs.writeFileSync(
      path.join(opts.dest, "tokens.css"),
      attribution("src/tokens.css", opts) + outTokens,
    );
    fs.writeFileSync(path.join(opts.dest, "LICENSE"), MIT_TEXT + "\n\n" + NOT_AFFILIATED + "\n");
  }

  // ------------------------------------------------------------ report
  const line = (k, v) => console.log(k.padEnd(30) + v);
  console.log(`vendor-codex-ui-kit — ${reader.kind} source, commit ${opts.commit}`);
  line("components requested", opts.components.length);
  line("files copied", files.size);
  for (const rel of files.keys()) console.log("    " + rel);
  line("codex-ui-* tokens used", wanted.size);
  line("css rules kept", stats.kept);
  line("css rules dropped", stats.dropped);
  line("at-rule blocks kept", stats.atKept);
  line("@keyframes carried", stats.keyframes);
  line("source styles.css bytes", sourceStylesBytes);
  line("EXTRACTED CSS BYTES", stylesBytes);
  line("tokens.css bytes", tokensBytes);
  line("extracted + tokens bytes", stylesBytes + tokensBytes);
  line("share of source styles.css", ((stylesBytes / sourceStylesBytes) * 100).toFixed(2) + "%");
  if (refusedAssets.length) {
    console.log("\n!! REFUSED — OpenAI-copyright assets, NOT MIT (src/assets/subagents/README.md).");
    console.log("   The importing component will not compile until you supply your own artwork.");
    for (const a of refusedAssets) console.log("    " + a);
    console.log("   Pass --include-openai-assets only if you have decided to ship them anyway.");
  }
  if (unresolvedImports.length) {
    console.log("\nlocal imports NOT vendored (pass --follow-imports to include):");
    for (const u of [...new Set(unresolvedImports)]) console.log("    " + u);
  }
  if (opts.dryRun) console.log("\n(dry run — nothing written)");
  else console.log(`\nwritten to ${path.resolve(opts.dest)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
