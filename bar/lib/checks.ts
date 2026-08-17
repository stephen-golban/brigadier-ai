// SPDX-License-Identifier: Apache-2.0
/**
 * A sub-check accumulator, and the reason an item is not one big boolean.
 *
 * Every `BAR.md` item is several assertions wearing one heading — item 1 alone
 * carries "absent when off PATH", "reports the RESOLVED entry", "unusable
 * carries the vendor's own remedy" and "drift is reported". Collapsing them to a
 * single pass/fail would produce exactly the report ruling 52 forbids: fewer
 * CHECKS rather than fewer items, so a reader cannot tell which promise broke.
 *
 * So each sub-check records the bytes it saw whether it passed or failed. A
 * check that only speaks up on failure cannot be audited by someone who does not
 * trust the author, which is `BAR.md`'s first rule.
 */

export interface Check {
  name: string;
  ok: boolean;
  /** What was actually seen. Recorded on a pass as well as a failure. */
  detail: string;
}

export class Checks {
  readonly rows: Check[] = [];

  /**
   * Record one assertion.
   *
   * `detail` is not optional, and that is on purpose: an assertion that cannot
   * say what it saw is an assertion nobody can re-derive.
   */
  expect(name: string, ok: boolean, detail: string): boolean {
    this.rows.push({ name, ok, detail });
    return ok;
  }

  /** Record something worth reporting that is not itself a pass/fail gate. */
  note(name: string, detail: string): void {
    this.rows.push({ name: `${name} (note)`, ok: true, detail });
  }

  get failures(): Check[] {
    return this.rows.filter((r) => !r.ok);
  }

  get passed(): boolean {
    return this.failures.length === 0;
  }

  /** Every row, one per line, with its bytes. This becomes `BarResult.observed`. */
  render(): string {
    return this.rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`).join("\n");
  }

  /** Which assertions failed. This becomes `BarResult.reason`. */
  reason(): string | undefined {
    const failed = this.failures;
    if (failed.length === 0) return undefined;
    return failed.map((r) => `${r.name} — ${r.detail}`).join("; ");
  }
}

/** Trim a captured stream for a one-line observation without hiding that it was trimmed. */
export function excerpt(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat === "" ? "<empty>" : flat;
  return `${flat.slice(0, limit)}… (${flat.length} chars total)`;
}
