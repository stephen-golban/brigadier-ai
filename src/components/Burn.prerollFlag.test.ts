/**
 * The pre-roll instrument's gate, and only that.
 *
 * `diagnosticPrerollMs` decides whether the burn opens its capture *after* the cold
 * first-project/first-transcript mount instead of over it — the falsifier for
 * `docs/performance/burn-frame-2026-09-11.md` §1. Two things must hold or an acceptance capture
 * silently stops measuring what it claims to: it returns 0 for everything that is not an explicitly
 * enabled burn build, and it returns 0 for every input that is not a positive finite number.
 *
 * `import.meta.env.VITE_BURN` is read inside the function rather than at module scope, so
 * `vi.stubEnv` alone is enough here — no `vi.resetModules()` dance, unlike `perfDiagnostics.test.ts`
 * whose `profiling` constant is evaluated once on import.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { diagnosticPrerollMs } from "./Burn";

afterEach(() => vi.unstubAllEnvs());

describe("diagnosticPrerollMs", () => {
  it("is zero outside an explicitly enabled burn build, whatever the URL says", () => {
    vi.stubEnv("VITE_BURN", "0");
    expect(diagnosticPrerollMs("?burn=auto&preroll=4000")).toBe(0);
  });

  it("is zero in a burn build with no pre-roll in the URL", () => {
    vi.stubEnv("VITE_BURN", "1");
    expect(diagnosticPrerollMs("?burn=auto")).toBe(0);
  });

  it("reads a positive pre-roll in a burn build", () => {
    vi.stubEnv("VITE_BURN", "1");
    expect(diagnosticPrerollMs("?burn=auto&preroll=4000")).toBe(4000);
  });

  it("refuses everything that is not a positive finite number", () => {
    vi.stubEnv("VITE_BURN", "1");
    for (const search of ["?preroll=", "?preroll=abc", "?preroll=0", "?preroll=-1", "?preroll=NaN"])
      expect(diagnosticPrerollMs(search)).toBe(0);
  });

  it("caps a mistyped pre-roll rather than swallowing the whole run", () => {
    vi.stubEnv("VITE_BURN", "1");
    expect(diagnosticPrerollMs("?preroll=999999")).toBe(30_000);
  });
});
