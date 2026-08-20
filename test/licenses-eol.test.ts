// SPDX-License-Identifier: Apache-2.0
/**
 * The attribution must not be a function of who checked the repository out.
 *
 * The first ever Windows CI run (commit 7ff6431, 2026-08-20) died inside the
 * FIRST command of the build step — `bun run licenses --check` — with both
 * surfaces reported STALE, before `scripts/build.ts` ran at all. The
 * attribution was correct: git-for-windows sets `core.autocrlf=true` at SYSTEM
 * level, so the checker was handed CRLF copies of files it compares byte for
 * byte, and the generator was handed CRLF copies of `LICENSE` and `vendor/*`
 * whose bytes it reprints verbatim into the binary.
 *
 * These tests drive that condition from a machine that is not Windows, by
 * building a fixture repository root whose committed licence texts carry CRLF
 * and asserting the composed components come out identical to the real ones.
 * They also hold the line the fix must not cross: `--check` still compares
 * bytes, and `describeStaleness` explains a line-ending difference without ever
 * explaining away a real one.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, allComponents, normaliseEol, npmComponents, runtimeComponents } from "../scripts/inventory.ts";
import { apacheText, describeStaleness, renderMarkdown, renderTypeScript } from "../scripts/licenses.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "brigadier-eol-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

/** The bytes a `core.autocrlf=true` checkout would have written. */
function asCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/** A repository root exactly like this one, checked out the way Windows checks out. */
function crlfCheckout(): string {
  const vendor = join(fixtureRoot, "vendor");
  cpSync(join(REPO_ROOT, "vendor"), vendor, { recursive: true });
  for (const name of readdirSync(vendor, { withFileTypes: true })) {
    if (!name.isFile()) continue;
    const path = join(vendor, name.name);
    if (name.name.endsWith(".gz")) continue;
    writeFileSync(path, asCrlf(readFileSync(path, "utf8")));
  }
  return fixtureRoot;
}

describe("normaliseEol", () => {
  test("converts CRLF to LF and leaves LF alone", () => {
    expect(normaliseEol("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normaliseEol("a\nb\n")).toBe("a\nb\n");
  });

  test("leaves a lone CR alone — it is content, not a line ending git wrote", () => {
    expect(normaliseEol("a\rb")).toBe("a\rb");
  });

  test("cannot make two different licence texts compare equal", () => {
    // The whole risk of normalising anything in a legal surface. Only line
    // endings move; every other byte, including whitespace, survives.
    expect(normaliseEol("Copyright 2026 A\r\n")).not.toBe(normaliseEol("Copyright 2026 B\r\n"));
    expect(normaliseEol("a  b")).toBe("a  b");
    expect(normaliseEol("a\n\nb")).toBe("a\n\nb");
  });
});

describe("a CRLF checkout composes the same attribution", () => {
  test("vendored licence texts carry no CR, and match the LF checkout byte for byte", () => {
    const windowsish = runtimeComponents(crlfCheckout());
    const here = runtimeComponents(REPO_ROOT);
    expect(windowsish.length).toBe(here.length);
    for (const [i, c] of windowsish.entries()) {
      expect(c.licenseText).not.toContain("\r");
      expect(c.licenseText).toBe(here[i]!.licenseText);
      expect(c.name).toBe(here[i]!.name);
    }
  });

  test("no component this repository ships carries a CR in its licence text", () => {
    // Reaches the npm population too, which comes from node_modules rather than
    // from git — packages do ship CRLF licence files, and one arriving would
    // otherwise change the binary's bytes on the next `bun run licenses`.
    for (const c of allComponents()) expect(c.licenseText).not.toContain("\r");
  });

  test("neither rendered surface contains a CR", () => {
    const components = allComponents();
    expect(renderMarkdown(components)).not.toContain("\r");
    expect(renderTypeScript(components)).not.toContain("\r");
    // `\r` escaped into a JSON string literal reaches the binary just as surely.
    expect(renderTypeScript(components)).not.toContain("\\r");
  });

  test("the committed surfaces are CR-free as committed", () => {
    expect(readFileSync(join(REPO_ROOT, "THIRD-PARTY.md"), "utf8")).not.toContain("\r");
    expect(readFileSync(join(REPO_ROOT, "src", "generated", "licenses.ts"), "utf8")).not.toContain("\r");
  });
});

describe("describeStaleness explains a difference without excusing one", () => {
  test("names the checkout when only the line endings differ", () => {
    const expected = "# Third-party components\n\nApache-2.0\n";
    const why = describeStaleness(expected.replace(/\n/g, "\r\n"), expected);
    expect(why).toContain("only the line endings differ");
    expect(why).toContain(".gitattributes");
  });

  test("says nothing about a real content difference", () => {
    // The failure mode to avoid: a diagnostic that reads a changed dependency as
    // a checkout artifact. Silence here sends the reader to the diff.
    expect(describeStaleness("component A\n", "component B\n")).toBeUndefined();
    // CRLF *and* a content change is a content change.
    expect(describeStaleness("component A\r\n", "component B\n")).toBeUndefined();
  });

  test("reports a missing file as missing", () => {
    expect(describeStaleness("", "anything")).toContain("missing");
  });

  test("is diagnostic only — it never reports two identical texts as differing", () => {
    expect(describeStaleness("same\n", "same\n")).toBeUndefined();
  });
});

describe(".gitattributes pins the bytes the gate compares", () => {
  const attributes = readFileSync(join(REPO_ROOT, ".gitattributes"), "utf8");

  test("every text file checks out LF on every platform", () => {
    expect(attributes).toMatch(/^\* text=auto eol=lf$/m);
  });

  test("the attribution surfaces and their inputs are declared explicitly", () => {
    for (const path of [
      "LICENSE",
      "THIRD-PARTY.md",
      "src/generated/licenses.ts",
      "vendor/bun-LICENSE.md",
      "vendor/javascriptcore-webkit-COPYING.LIB",
      "vendor/tinycc-COPYING",
    ]) {
      expect(attributes).toMatch(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+text eol=lf$`, "m"));
    }
  });

  test("the compressed grammars are never touched by an eol filter", () => {
    expect(attributes).toMatch(/^vendor\/grammars\/\*\.gz\s+binary$/m);
  });
});

describe("the other two call sites that read committed licence text", () => {
  test("a CRLF `LICENSE` produces the same Apache text as this checkout does", () => {
    // `APACHE_TEXT` reaches `src/generated/licenses.ts` and therefore the binary,
    // via `src/cli.ts`'s `import { LICENSES }`. Normalising it and never driving
    // the CRLF case would be a claim rather than a guarantee.
    const root = join(fixtureRoot, "apache");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "LICENSE"), asCrlf(readFileSync(join(REPO_ROOT, "LICENSE"), "utf8")));
    expect(apacheText(root)).not.toContain("\r");
    expect(apacheText(root)).toBe(apacheText(REPO_ROOT));
  });

  test("an npm package shipping a CRLF LICENSE is attributed identically", () => {
    // Packages really do publish CRLF licence files, and node_modules comes from
    // the registry rather than from git — `.gitattributes` cannot reach it, so
    // this call site is the one the normalisation exists for beyond Windows.
    const text = "MIT License\n\nCopyright (c) 2026 CRLF Fixture\n\nPermission is hereby granted.\n";
    const build = (dir: string, licence: string): string => {
      const pkg = join(dir, "node_modules", "crlf-fixture");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "crlf-fixture": "1.0.0" } }));
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "crlf-fixture", version: "1.0.0", license: "MIT" }),
      );
      writeFileSync(join(pkg, "LICENSE"), licence);
      return dir;
    };
    const windowsish = npmComponents(build(join(fixtureRoot, "npm-crlf"), asCrlf(text)));
    const here = npmComponents(build(join(fixtureRoot, "npm-lf"), text));

    expect(windowsish).toHaveLength(1);
    expect(windowsish[0]!.licenseText).not.toContain("\r");
    expect(windowsish[0]!.licenseText).toBe(here[0]!.licenseText);
    // The copyright line is pulled out of that text by regex, so a stray CR would
    // ride into the attribution's holder name where nobody would look for it.
    expect(windowsish[0]!.copyright).toBe("Copyright (c) 2026 CRLF Fixture");
    expect(windowsish[0]!.copyright).toBe(here[0]!.copyright);
  });
});
