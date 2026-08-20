// SPDX-License-Identifier: Apache-2.0
/**
 * The guard on how a file finds its neighbours on disk.
 *
 * `new URL(…, import.meta.url).pathname` returns a URL path, not a filesystem
 * path, and the two only coincide on POSIX under a repository whose absolute
 * path is pure ASCII with no spaces. Two ways they stop coinciding:
 *
 *   - **Percent-encoding, on every platform.** A repository under a directory
 *     containing a space or a non-ASCII character arrives as `%20` / `%C3%AB`,
 *     and every `join` and every spawn below it addresses a path that does not
 *     exist. MEASURED against `bun 1.3.14` on 2026-08-20, twice by two authors
 *     independently, in a directory named `pct dëmo`: reading through the URL
 *     pathname failed with `ENOENT`, and `bun run` of a module addressed that
 *     way failed with `error: Module not found`, while `fileURLToPath` of the
 *     same URL read and ran. `scripts/build.ts` already carries this reasoning
 *     in prose; this is the mechanical half.
 *   - **A drive letter, on Windows.** The pathname is `/D:/a/…` — leading
 *     slash, forward separators. REPORTED from `gates.yml`'s first ever Windows
 *     execution on 2026-08-20 (observed by another author, not by this file):
 *     `error: Module not found "/D:/a/brigadier-ai/…/src/cli.ts"` and
 *     `ENOENT … open '\D:\a\…\assets\plugin\SKILL.md'`. Every subprocess-driven
 *     CLI test was unreachable, so most product surfaces were never exercised
 *     there at all.
 *
 * `fileURLToPath` from `node:url` is the whole answer: it decodes the escapes,
 * drops the leading slash before a drive letter, and returns the platform
 * separator. A hand-rolled `.replace(/^\//, "")` fixes the drive letter and
 * leaves the percent-encoding, which is the half that is already broken here.
 *
 * ## Why this matches an EXPRESSION and not a character window
 *
 * The first draft looked for `import.meta.url` within forty characters of a
 * `.pathname`. A blind critic broke it both ways on 2026-08-20 and was right to:
 * a long argument list or a trailing comment pushed a REAL offender past the
 * window, and a correct `fileURLToPath(import.meta.url)` with an unrelated
 * `new URL(req.url).pathname` on the next line was FALSELY blamed. Both cases
 * are pinned as tests below, so the boundary is measured rather than described.
 *
 * So the scanner asks the structural question instead: does this `.pathname`
 * belong to a `new URL(…)` whose own arguments mention the module URL? Argument
 * lists are matched by balancing parentheses, so they may be any length and
 * wrap over any number of lines; and only whitespace and closing parens may sit
 * between the call and the `.pathname`, so a match can never cross a statement
 * boundary.
 *
 * ## Why this file cannot match itself
 *
 * Strings and comments are blanked before scanning — the same reason
 * `src/secrets/audit.ts` blanks them, reimplemented here rather than imported so
 * that a guard does not share the bugs of the code it guards. That is what makes
 * the offending shapes safe to write out literally in the cases below, and it is
 * stronger than assembling a needle from fragments: a `find:` string quoting the
 * idiom, as `bar/lib/item12-negative-control.test.ts:142` does, is data and is
 * correctly ignored. A test below asserts this file is clean under its own
 * scanner, so the claim is checked and not merely argued.
 *
 * ## The limits, stated rather than left to be discovered
 *
 *   1. **Aliasing is not tracked.** `const u = new URL("..", import.meta.url);`
 *      followed later by `u.pathname` is not caught, and neither is
 *      `const here = import.meta.url; new URL("..", here).pathname`. The scanner
 *      is syntactic; catching these needs a type-aware pass. Both are pinned as
 *      known-miss tests so the boundary moves only deliberately.
 *   2. **Regular-expression literals are not lexed.** A regex containing an
 *      unbalanced quote or parenthesis *inside* a `new URL(…)` argument list
 *      could desynchronise the blanker. No such literal exists in the scanned
 *      tree, and a length-and-line-count invariant below catches gross
 *      desynchronisation, but it is a real hole rather than an impossible one.
 *
 * Ruling 12 makes Windows first class, and ruling 62b asks every check for a
 * negative control — a scanner that reports nothing looks exactly like a clean
 * tree, so every predicate here is run against a source that should trip it.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every directory a file might resolve a sibling path from. `src/` has no such
 * site today, which is the point: covering it costs nothing now and stops the
 * idiom appearing there later. */
const SCANNED = ["src", "test", "bar", "scripts", "vendor", "probes"] as const;

/**
 * String bodies and comments replaced by spaces, with length and every newline
 * preserved so offsets and line numbers still address the original text.
 *
 * Quotes are kept and only the body is blanked, so a blanked string is still a
 * syntactic string; parentheses inside it can no longer confuse the balancer.
 */
export function blankStringsAndComments(source: string): string {
  const out = [...source];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      const stop = nl === -1 ? source.length : nl;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const stop = close === -1 ? source.length : close + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = Math.min(j + 1, source.length);
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/** The module URL itself, however it is spaced. */
const MODULE_URL = /\bimport\s*\.\s*meta\s*\.\s*url\b/;

/** A `new URL(` call opener. The `(` is the last character of the match. */
const NEW_URL_CALL = /\bnew\s+URL\s*\(/g;

/**
 * Only whitespace and closing parens may sit between the call and the property,
 * so `fileURLToPath(new URL(…)).pathname` — also wrong, `.pathname` on a string
 * — is caught, while `join(fileURLToPath(new URL(…)), "src")` is not: the comma
 * ends the run.
 */
const ATTACHED_PATHNAME = /^[\s)]*\.\s*pathname\b/;

/** One-based line numbers where a `.pathname` is taken off a module-relative URL. */
export function pathnameOnModuleUrl(source: string): number[] {
  const code = blankStringsAndComments(source);
  const found: number[] = [];
  NEW_URL_CALL.lastIndex = 0;
  for (let m = NEW_URL_CALL.exec(code); m !== null; m = NEW_URL_CALL.exec(code)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let k = open; k < code.length; k++) {
      if (code[k] === "(") depth += 1;
      else if (code[k] === ")" && --depth === 0) {
        end = k;
        break;
      }
    }
    // An unbalanced call is not evidence of this bug; blame needs a whole expression.
    if (end === -1) continue;
    if (!MODULE_URL.test(code.slice(open, end))) continue;
    if (!ATTACHED_PATHNAME.test(code.slice(end + 1))) continue;
    found.push(code.slice(0, m.index).split("\n").length);
  }
  return found;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

const sources = new Map<string, string>();
for (const dir of SCANNED) {
  for (const file of walk(join(ROOT, dir))) {
    sources.set(relative(ROOT, file).split("\\").join("/"), readFileSync(file, "utf8"));
  }
}

const SELF = "test/path-idiom.test.ts";

describe("no file resolves a filesystem path through a URL pathname", () => {
  test("the scan examined something — a scan of nothing is not a scan", () => {
    // The briefed directories held twenty-three of the twenty-four sites this
    // guard was written for and `vendor/` held the twenty-fourth, so nothing
    // that resolves a sibling path is left outside the scan.
    expect(sources.size).toBeGreaterThan(200);
    for (const dir of SCANNED) {
      expect([dir, [...sources.keys()].some((f) => f.startsWith(`${dir}/`))]).toEqual([dir, true]);
    }
    expect(sources.has(SELF)).toBe(true);
  });

  test("blanking preserves every offset and every line, over the real tree", () => {
    // Cheap invariant against the stated regex-literal hole: a desynchronised
    // blanker almost always changes length or line count first.
    const broken = [...sources]
      .filter(([, s]) => {
        const b = blankStringsAndComments(s);
        return b.length !== s.length || b.split("\n").length !== s.split("\n").length;
      })
      .map(([f]) => f);
    expect(broken).toEqual([]);
  });

  test("over the real tree", () => {
    const offenders = [...sources]
      .map(([file, source]) => [file, pathnameOnModuleUrl(source)] as const)
      .filter(([, lines]) => lines.length > 0)
      .map(([file, lines]) => `${file}:${lines.join(",")}`);
    expect(offenders).toEqual([]);
  });

  test("the scanner does not flag this file, whose cases quote the idiom verbatim", () => {
    expect(pathnameOnModuleUrl(sources.get(SELF) ?? "")).toEqual([]);
  });
});

describe("NEGATIVE CONTROL — the shapes that must trip it", () => {
  test("every shape the tree actually used", () => {
    const bad = [
      `const CLI = new URL("../src/cli.ts", import.meta.url).pathname;`,
      `const REPO = new URL("..", import.meta.url).pathname.replace(/[\\/]$/, "");`,
      `const ROOT = new URL(["..", "..", "src"].join("/"), import.meta.url).pathname;`,
      `const R = fileURLToPath(new URL("..", import.meta.url)).pathname;`,
      `const R = new URL("..", import.meta.url)\n  .pathname;`,
    ];
    expect(bad.map((s) => pathnameOnModuleUrl(s).length)).toEqual([1, 1, 1, 1, 1]);
  });

  test("BOUNDARY — a long argument list and a trailing comment, which the old window MISSED", () => {
    // MEASURED against `bun 1.3.14` on 2026-08-20: the superseded 40-character
    // window returned `false` here. The balancer does not care how long the
    // arguments are, so this is now caught and reported on its opening line.
    const offender = [
      `const ROOT = new URL(`,
      `  ["..", "..", "src", "repo"].join("/"),`,
      `  import.meta.url, // a trailing comment long enough to push the close paren well past forty characters`,
      `).pathname;`,
    ].join("\n");
    expect(pathnameOnModuleUrl(offender)).toEqual([1]);
  });

  test("the line reported is the line a reader must open", () => {
    const source = `const a = 1;\nconst b = 2;\nconst CLI = new URL("../src/cli.ts", import.meta.url).pathname;\n`;
    expect(pathnameOnModuleUrl(source)).toEqual([3]);
  });
});

describe("and the shapes that must NOT trip it", () => {
  test("the correct idiom, and URLs that are meant to stay URLs", () => {
    const ok = [
      `const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));`,
      `const LIB_URL = new URL("./lib/", import.meta.url).href;`,
      `const doc = await Bun.file(new URL("../RELINKING.md", import.meta.url)).text();`,
      `const here = dirname(fileURLToPath(import.meta.url));`,
      `const p = join(fileURLToPath(new URL("..", import.meta.url)), "src");`,
    ];
    expect(ok.map((s) => pathnameOnModuleUrl(s).length)).toEqual([0, 0, 0, 0, 0]);
  });

  test("BOUNDARY — an adjacent request pathname, which the old window FALSELY BLAMED", () => {
    // MEASURED against `bun 1.3.14` on 2026-08-20: the superseded 40-character
    // window returned `true` here and accused correct code. An HTTP request's
    // pathname IS a URL path and is meant to be one; the arguments of the
    // `new URL(…)` it belongs to never mention the module URL.
    const correct = [
      `const here = dirname(fileURLToPath(import.meta.url));`,
      `const p = new URL(req.url).pathname;`,
    ].join("\n");
    expect(pathnameOnModuleUrl(correct)).toEqual([]);
  });

  test("the idiom quoted as data — a string or a comment — is not code", () => {
    const data = [
      `const find = 'new URL("./vendor.ts", import.meta.url).pathname';`,
      `// never write new URL("..", import.meta.url).pathname`,
      `/* new URL("..", import.meta.url).pathname */`,
    ];
    expect(data.map((s) => pathnameOnModuleUrl(s).length)).toEqual([0, 0, 0]);
  });

  test("KNOWN MISS, pinned so the boundary moves only deliberately — aliasing", () => {
    // Limit 1 in this file's header. Neither of these is caught, and both are
    // the same bug. If a future change starts catching them, this test fails and
    // the header is updated with it rather than drifting away from the code.
    const viaUrlAlias = `const u = new URL("..", import.meta.url);\nconst p = u.pathname;`;
    const viaModuleUrlAlias = `const here = import.meta.url;\nconst p = new URL("..", here).pathname;`;
    expect([pathnameOnModuleUrl(viaUrlAlias), pathnameOnModuleUrl(viaModuleUrlAlias)]).toEqual([[], []]);
  });
});
