// SPDX-License-Identifier: Apache-2.0
/**
 * Planting vendors on a `PATH` the harness owns.
 *
 * Every item that needs agents gives the binary under test a `PATH` containing
 * only what this harness put there, for two reasons that both come from
 * `BAR.md`. The machine the authoritative run happens on is deliberately hostile
 * but ordinary, and an item whose result depends on which vendors the operator
 * happens to have installed is not reproducible. And item 6's whole subject is a
 * SINGLE-vendor machine, which cannot be waited for.
 *
 * A product discovers agents by resolving names on `PATH` — ruling 46 is that it
 * must report the entry it RESOLVED rather than assume the name is ours — so a
 * planted vendor is not a shortcut around the product's discovery. It is the
 * product's discovery, pointed at something the harness can predict.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, writeScript } from "./fs.ts";
import type { VendorConfig } from "../fakes/vendor.ts";

const VENDOR = fileURLToPath(new URL("../fakes/vendor.ts", import.meta.url));

function quote(value: string): string {
  return `"${value.split('"').join('\\"')}"`;
}

/**
 * Install one fixture vendor called `id`, and return its path.
 *
 * The config lives beside the executable under `<id>.vendor.json`, which is the
 * convention `bar/fakes/honest.ts` reads. A real product would find its own
 * configuration; the fixture needs somewhere deterministic.
 */
export function plantVendor(binDir: string, config: VendorConfig): string {
  ensureDir(binDir);
  const configPath = join(binDir, `${config.id}.vendor.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return writeScript(
    join(binDir, config.id),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(VENDOR)} ${quote(configPath)} "$@"\n`,
    `@echo off\r\n${quote(process.execPath)} ${quote(VENDOR)} ${quote(configPath)} %*\r\n`,
  );
}

export function plantVendors(binDir: string, configs: readonly VendorConfig[]): string[] {
  return configs.map((config) => plantVendor(binDir, config));
}

export interface PlantedFleet {
  paths: string[];
  /** Every vendor invocation lands here. The product has no way to write it. */
  ledger: string;
}

/**
 * Plant a fleet that signs a ledger.
 *
 * The ledger is the answer to "the record says two different vendors ran". A
 * record is the product's account of itself and a forger writes it; a ledger
 * line is a file that a process had to exist to append to. Item 5 passed on two
 * strings in a record without either vendor running, and this is what closes it.
 */
export function plantFleet(binDir: string, ledger: string, configs: readonly VendorConfig[]): PlantedFleet {
  return { paths: plantVendors(binDir, configs.map((c) => ({ ...c, ledger }))), ledger };
}

/**
 * A `PATH` holding only the planted vendors, plus what any program needs to
 * exist at all.
 *
 * `git` is the reason this is not just `binDir`: the product must be able to run
 * git, and a harness that made that impossible would be measuring its own
 * sabotage rather than the product.
 */
export function isolatedPath(binDir: string): string {
  const separator = process.platform === "win32" ? ";" : ":";
  const essentials =
    process.platform === "win32"
      ? (process.env["PATH"] ?? "").split(separator).filter((d) => /system32|git/i.test(d))
      : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [binDir, ...essentials].join(separator);
}

/**
 * A `brigadier` shim on the worker's `PATH`, so "the worker did not orchestrate"
 * can be asserted on an artefact rather than on a variable.
 *
 * Ruling 57 is explicit that the assertion must be on the EFFECT. Asserting
 * `BRIGADIER_WORKER` is set proves only that a variable exists — the exact
 * *check that reports success when the thing it checks did not happen* shape v1
 * kept shipping. This shim records every invocation, so a worker that really
 * did call `brigadier run` leaves bytes behind that no report can un-write.
 */
export function plantBrigadierShim(binDir: string, ledger: string, real: string): string {
  ensureDir(binDir);
  // `$BRIGADIER_WORKER` is recorded alongside the argv, and that is the whole
  // point. An orchestrator invoking `brigadier` on ITSELF also lands in this
  // ledger, so a line without the worker marker proves nothing about a worker
  // having tried to delegate — which is how a forger satisfied ruling 59 by
  // calling its own name once.
  return writeScript(
    join(binDir, "brigadier"),
    `#!/bin/sh\necho "worker=\${BRIGADIER_WORKER:-none} argv: $@" >> ${quote(ledger)}\nexec ${quote(real)} "$@"\n`,
    `@echo off\r\necho worker=%BRIGADIER_WORKER% argv: %* >> ${quote(ledger)}\r\n${quote(real)} %*\r\n`,
  );
}
