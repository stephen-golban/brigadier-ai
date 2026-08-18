// SPDX-License-Identifier: Apache-2.0
/**
 * Negative controls for the licence gate.
 *
 * Ruling 47 makes a build-time gate the thing standing between a proprietary
 * dependency and a signed, redistributed binary. The gate's failure mode is
 * legal rather than functional — nothing goes red, no user reports it — so the
 * only way to know it works is to prove it FAILS when it should.
 *
 * This repo's standing rule, from v1: a guard that always passes looks
 * identical to a working one. Every check below is driven in both directions.
 */

import { describe, expect, test } from "bun:test";
import {
  checkAttributionCarried,
  checkDocPins,
  checkDocumentAgreesWithBinary,
  checkLgplPins,
  checkPin,
  checkRevisionPin,
  containsText,
  escapeNonAscii,
  fingerprintsFor,
  isSearchableNeedle,
  scanForProprietaryMarkers,
} from "../scripts/license-gate.ts";
import {
  ALLOWED_LICENSES,
  PROPRIETARY_MARKERS,
  allComponents,
  extractCopyright,
  isAllowed,
  pins,
  type Component,
} from "../scripts/inventory.ts";

const encode = (s: string) => new TextEncoder().encode(s);

/**
 * A component shaped like the real LGPL ones, for driving the guards.
 *
 * Built rather than read so that each negative control can break exactly one
 * thing. The real components are asserted against separately, at the bottom.
 */
function lgplFixture(overrides: Partial<Component> = {}): Component {
  return {
    name: "javascriptcore-webkit",
    version: "oven-sh/WebKit@5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    license: "LGPL-2.0-or-later",
    licenseText: [
      "brigadier's notice for JavaScriptCore (WebKit) — written by brigadier, not by upstream.",
      "the revision this copy was built from: oven-sh/WebKit@5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
      "THE SOURCE OFFER — STATUS: NOT YET DISCHARGED",
      "GNU LIBRARY GENERAL PUBLIC LICENSE, Version 2, June 1991 — verbatim, as it appears upstream",
      "This library is free software; you can redistribute it and/or modify it under the terms",
      "of the GNU Library General Public License as published by the Free Software Foundation.",
    ].join("\n"),
    copyright: "Copyright (C) 1991 Free Software Foundation, Inc.",
    origin: "runtime",
    reason: "statically linked by `bun --compile`",
    pinKey: "javascriptcore-webkit",
    lgpl: {
      library: "JavaScriptCore (WebKit)",
      upstream: "https://github.com/oven-sh/WebKit",
      licenceFile: "Source/JavaScriptCore/COPYING.LIB",
      licenceName: "GNU LIBRARY GENERAL PUBLIC LICENSE, Version 2, June 1991",
      samePlaceClause: "§6c of LGPL-2.0",
    },
    ...overrides,
  };
}

const REAL_PINS = {
  bun: "1.3.14",
  "bun-revision": "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
  "javascriptcore-webkit": "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
} as Record<string, string>;

describe("the proprietary-marker scan", () => {
  test("passes clean bytes", () => {
    const clean = encode("brigadier — an ACP hub\nsome ordinary compiled content\n");
    expect(scanForProprietaryMarkers(clean)).toEqual([]);
  });

  // The negative control, one per marker: plant it and prove the gate goes red.
  for (const marker of PROPRIETARY_MARKERS) {
    test(`FAILS when ${JSON.stringify(marker.slice(0, 40))} is planted`, () => {
      const planted = encode(`some preceding bytes ${marker} some trailing bytes`);
      const findings = scanForProprietaryMarkers(planted);
      expect(findings.length).toBe(1);
      expect(findings[0]?.check).toBe("markers");
      expect(findings[0]?.detail).toContain(marker);
    });
  }

  test("finds a marker embedded in non-UTF-8 binary noise", () => {
    // A real compiled binary is not valid UTF-8. If the scan decoded with a
    // fatal or lossy decoder it could miss a marker sitting next to arbitrary
    // bytes — which is the only place it will ever actually sit.
    const noise = new Uint8Array(512);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 37) % 256;
    const marker = encode(PROPRIETARY_MARKERS[0]);
    const planted = new Uint8Array(noise.length + marker.length + noise.length);
    planted.set(noise, 0);
    planted.set(marker, noise.length);
    planted.set(noise, noise.length + marker.length);

    expect(scanForProprietaryMarkers(planted).length).toBe(1);
  });

  test("reports every marker present, not just the first", () => {
    const planted = encode(PROPRIETARY_MARKERS.join(" "));
    expect(scanForProprietaryMarkers(planted).length).toBe(PROPRIETARY_MARKERS.length);
  });
});

describe("the licence allowlist", () => {
  test("admits the permissive licences the bundled components actually use", () => {
    // MEASURED 2026-08-17: the two ACP bridges and their transitive set.
    for (const license of ["Apache-2.0", "MIT", "BSD-3-Clause", "ISC"]) {
      expect(isAllowed(license)).toBe(true);
    }
  });

  test("FAILS the proprietary declaration the Claude Agent SDK actually carries", () => {
    // MEASURED against @anthropic-ai/claude-agent-sdk 0.3.232 on 2026-08-17:
    // npm reports `SEE LICENSE IN README.md`; LICENSE.md is one line reserving
    // all rights. This is the exact string the gate must reject.
    expect(isAllowed("SEE LICENSE IN README.md")).toBe(false);
  });

  test("FAILS copyleft and undeclared licences", () => {
    for (const license of ["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "BUSL-1.1", "UNDECLARED", ""]) {
      expect(isAllowed(license)).toBe(false);
    }
  });

  test("the allowlist is permissive-only by construction", () => {
    for (const license of ALLOWED_LICENSES) {
      expect(license).not.toContain("GPL");
    }
  });
});

describe("the toolchain pin", () => {
  test("passes when the building bun matches the vendored attribution", () => {
    // Read the pin rather than hardcoding it, so this test does not go stale
    // the moment the pin is deliberately moved.
    const pinned = pins()["bun"];
    expect(pinned).toBeDefined();
    expect(checkPin(pinned as string)).toEqual([]);
  });

  test("FAILS when bun moves and the vendored licence copy does not", () => {
    const findings = checkPin("0.0.0-not-a-real-version");
    expect(findings.length).toBe(1);
    expect(findings[0]?.check).toBe("pin");
    expect(findings[0]?.detail).toContain("vendor/bun-LICENSE.md");
  });
});

describe("copyright extraction", () => {
  // #4's table recorded the Claude bridge as "Apache text, unmodified" and so
  // missed that it carries Zed's copyright — there are TWO third-party holders
  // in ruling 4's binary. Reading the line is what stops that recurring.
  test("finds the holder in each bridge's real licence header", () => {
    expect(extractCopyright("\n   Apache License\n\n   Copyright 2025 Zed Industries, Inc. and contributors\n")).toBe(
      "Copyright 2025 Zed Industries, Inc. and contributors",
    );
    expect(extractCopyright("   Copyright 2025 JetBrains s.r.o.\n\n   Licensed under...")).toBe(
      "Copyright 2025 JetBrains s.r.o.",
    );
  });

  test("finds a © form as well as the word", () => {
    expect(extractCopyright("© Anthropic PBC. All rights reserved.")).toBeUndefined();
    expect(extractCopyright("© 2025 Anthropic PBC. All rights reserved.")).toContain("Anthropic PBC");
  });

  test("returns undefined rather than guessing when there is no notice", () => {
    expect(extractCopyright("Permission is hereby granted, free of charge...")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ruling 72's guards. Same standard as the block above: every one is driven in
// both directions, because the failure these prevent is legal rather than
// functional — nothing goes red, no user reports it, and the defect ships
// signed. The specific defect they were written against was MEASURED on
// 2026-08-17: `brigadier licenses --full` carried 0 hits for "GNU Lesser" and 0
// for "GNU Library General Public" while `strings dist/brigadier` carried 879
// for "JavaScriptCore".
// ---------------------------------------------------------------------------

describe("the bun revision pin", () => {
  test("passes when the building bun is the commit the LGPL revisions were read from", () => {
    const pinned = pins()["bun-revision"];
    expect(pinned).toMatch(/^[0-9a-f]{40}$/);
    expect(checkRevisionPin(pinned as string)).toEqual([]);
  });

  test("FAILS when bun is a different build of the same version number", () => {
    // The whole point of this check: `bun --version` can match while the source
    // commit does not, and the WebKit and tinycc revisions were read out of ONE
    // commit's build scripts.
    const findings = checkRevisionPin("1111111111111111111111111111111111111111");
    expect(findings.length).toBe(1);
    expect(findings[0]?.check).toBe("revision");
    expect(findings[0]?.detail).toContain("scripts/build/deps");
  });
});

describe("the LGPL library pins", () => {
  test("passes for the real components against the real pins", () => {
    expect(checkLgplPins(allComponents(), pins())).toEqual([]);
  });

  test("FAILS when a statically-linked LGPL library is not pinned at all", () => {
    const findings = checkLgplPins([lgplFixture()], { bun: "1.3.14" });
    expect(findings.some((f) => f.detail.includes("an unpinned source offer is not an offer"))).toBe(true);
  });

  test("FAILS when the pin names a DIFFERENT library than the one it pins", () => {
    // bar/items/10 records the bar's own first draft passing on a 40-hex that
    // belonged to a Tigerbeetle URL. A pin under the wrong name looks like
    // diligence and pins nothing.
    const findings = checkLgplPins([lgplFixture({ pinKey: "tinycc" })], {
      tinycc: "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    });
    expect(findings.some((f) => f.detail.includes("a pin must name the library it pins"))).toBe(true);
  });

  test("FAILS when the pin is not a revision", () => {
    const findings = checkLgplPins([lgplFixture()], { "javascriptcore-webkit": "latest" });
    expect(findings.some((f) => f.detail.includes("not a 40-character revision"))).toBe(true);
  });

  test("FAILS when the component's version does not carry its own pin", () => {
    const findings = checkLgplPins([lgplFixture({ version: "oven-sh/WebKit@main" })], REAL_PINS);
    expect(findings.some((f) => f.detail.includes("does not carry its pin"))).toBe(true);
  });

  test("FAILS when the inventory has stopped listing any LGPL library at all", () => {
    // The silent version of this defect: someone deletes the components rather
    // than the obligation, and every other check goes quiet with them.
    const findings = checkLgplPins([], REAL_PINS);
    expect(findings.length).toBe(1);
    expect(findings[0]?.detail).toContain("has stopped describing the binary");
  });
});

describe("the attribution the binary actually carries", () => {
  const fixture = lgplFixture();
  const carrying = Buffer.from(`prefix ${fixture.licenseText} suffix`, "utf8");

  test("passes when the bytes carry every fingerprint", () => {
    expect(checkAttributionCarried(carrying, [fixture])).toEqual([]);
  });

  test("FAILS when the LGPL body is missing from the binary", () => {
    // The measured defect, reproduced: everything about the licence is present
    // except the licence.
    const withoutBody = Buffer.from(
      fixture.licenseText.split("\n").filter((l) => !l.startsWith("This library is free software")).join("\n"),
      "utf8",
    );
    const findings = checkAttributionCarried(withoutBody, [fixture]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.detail.includes("licence body"))).toBe(true);
  });

  test("FAILS when the pinned revision is absent from the binary", () => {
    const withoutPin = Buffer.from(fixture.licenseText.replace(/[0-9a-f]{40}/g, "REDACTED"), "utf8");
    expect(checkAttributionCarried(withoutPin, [fixture]).some((f) => f.detail.includes("pinned revision"))).toBe(true);
  });

  test("FAILS when a component ships no attribution text at all", () => {
    // A non-LGPL component with an empty licence file: nothing to fingerprint,
    // which without this branch would pass by having nothing to look for.
    const { lgpl, pinKey, ...rest } = lgplFixture();
    void lgpl;
    void pinKey;
    const empty: Component = { ...rest, name: "silent", licenseText: "" };
    const findings = checkAttributionCarried(carrying, [empty]);
    expect(findings.some((f) => f.detail.includes("ships no attribution text at all"))).toBe(true);
  });

  test("an empty licence text yields a fingerprint that cannot be satisfied", () => {
    // Belt and braces: if the sampling ever produced zero fingerprints for a
    // component with no text, the check would pass by finding nothing.
    const fingerprints = fingerprintsFor(lgplFixture({ licenseText: "" }));
    expect(fingerprints.some((f) => f.needle.includes("missing entirely"))).toBe(true);
  });

  test("every fingerprint is searchable in a compiled artifact", () => {
    for (const c of allComponents()) {
      for (const fingerprint of fingerprintsFor(c)) {
        expect({ label: fingerprint.label, searchable: isSearchableNeedle(fingerprint.needle) }).toEqual({
          label: fingerprint.label,
          searchable: true,
        });
      }
    }
  });
});

describe("searching a compiled artifact for text", () => {
  // MEASURED against `bun build --compile` 1.3.14 on 2026-08-17: the bundler
  // escapes non-ASCII in string literals, so `dist/brigadier` contains
  // `LGPL’d` and not the UTF-8 bytes of `LGPL’d`. The first draft of the
  // gate reported the licence missing from a binary that contained it.
  test("finds text stored as raw UTF-8", () => {
    expect(containsText(Buffer.from("xx LGPL’d library yy", "utf8"), "LGPL’d library")).toBe(true);
  });

  test("finds the same text stored in the escaped form the compiler emits", () => {
    expect(containsText(Buffer.from("xx LGPL\\u2019d library yy", "utf8"), "LGPL’d library")).toBe(true);
  });

  test("does not find text that is absent in either form", () => {
    expect(containsText(Buffer.from("xx nothing to see yy", "utf8"), "LGPL’d library")).toBe(false);
  });

  test("escapes only what is not ASCII", () => {
    expect(escapeNonAscii("plain ASCII")).toBe("plain ASCII");
    expect(escapeNonAscii("a — b")).toBe("a \\u2014 b");
  });

  test("rejects needles a JSON-encoded manifest would not contain verbatim", () => {
    expect(isSearchableNeedle('he said "hello" to the compiler and it agreed')).toBe(false);
    expect(isSearchableNeedle("\tindented with a tab, which JSON escapes")).toBe(false);
    expect(isSearchableNeedle("too short")).toBe(false);
    expect(isSearchableNeedle("a line long enough to be worth searching for")).toBe(true);
  });
});

describe("the document and the binary agree", () => {
  const revision = "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b";

  test("passes when every revision the document names is in the artifact", () => {
    const markdown = `pinned to \`${revision}\``;
    expect(checkDocumentAgreesWithBinary(markdown, Buffer.from(`... ${revision} ...`, "utf8"))).toEqual([]);
  });

  test("FAILS on a claim present in the document and absent from the binary", () => {
    // Ruling 26 delivers a bare binary. A pin only the repository knows about
    // is a promise made to the wrong audience — and this is the exact shape of
    // the defect this slice was sent to fix.
    const findings = checkDocumentAgreesWithBinary(`pinned to \`${revision}\``, Buffer.from("no pins here", "utf8"));
    expect(findings.length).toBe(1);
    expect(findings[0]?.check).toBe("carried");
    expect(findings[0]?.detail).toContain(revision);
  });
});

describe("RELINKING.md and the pins", () => {
  test("passes against the committed document", async () => {
    const doc = await Bun.file(new URL("../RELINKING.md", import.meta.url)).text();
    expect(checkDocPins(doc, pins())).toEqual([]);
  });

  test("FAILS when a pin is documented nowhere", () => {
    const findings = checkDocPins("no revisions in this document", REAL_PINS);
    expect(findings.some((f) => f.detail.includes("RELINKING.md never mentions"))).toBe(true);
  });

  test("FAILS when the document names a revision nothing pins", () => {
    const findings = checkDocPins("checkout 532c8b70b9142c17e07737ab6d3da68d7500cbca", {
      "javascriptcore-webkit": "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    });
    expect(findings.some((f) => f.detail.includes("not pinned in vendor/pins.json"))).toBe(true);
  });
});

describe("the generated attribution cannot trip the gate that reads it", () => {
  test("no component's shipped text contains a proprietary marker", () => {
    // Not hypothetical: WebKit carries `Copyright (C) 2026 Anthropic PBC.` in 8
    // files (MEASURED 2026-08-17), and the marker is the `©` form of very
    // nearly that string. The census normalises `©` to `(c)` for this reason.
    for (const c of allComponents()) {
      expect(scanForProprietaryMarkers(encode(c.licenseText))).toEqual([]);
    }
  });
});
