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
import { checkPin, scanForProprietaryMarkers } from "../scripts/license-gate.ts";
import { ALLOWED_LICENSES, PROPRIETARY_MARKERS, extractCopyright, isAllowed, pins } from "../scripts/inventory.ts";

const encode = (s: string) => new TextEncoder().encode(s);

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
