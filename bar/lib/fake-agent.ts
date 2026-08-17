// SPDX-License-Identifier: Apache-2.0
/**
 * Planting an agent — or a decoy — at a path this harness chose.
 *
 * Ruling 46 is the reason the decoy exists at all: v1 inferred installation from
 * a marker file and reported `opencode` present on a machine where it was not on
 * `PATH`, and ruling 46 records that v1 also shipped a `brigadier` on a Homebrew
 * tap, so a name on `PATH` being ours is an assumption rather than a fact. The
 * only way to check that a product reports the RESOLVED entry rather than
 * assuming one is to put something at a path only the harness knows, and see
 * whether that exact string comes back.
 *
 * The wrapper is a shell script rather than a compiled stub so that the agent's
 * identity is a `PATH` lookup and nothing else — which is precisely the thing
 * under test.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, writeScript } from "./fs.ts";
import type { StubConfig } from "./acp-stub.ts";

const STUB = fileURLToPath(new URL("./acp-stub.ts", import.meta.url));

/**
 * Install a fake ACP agent called `name` into `binDir`, and return the exact
 * path it now occupies. That path is the ground truth an item asserts against.
 */
export function plantAgent(binDir: string, name: string, config: StubConfig): string {
  ensureDir(binDir);
  const configPath = join(binDir, `${name}.stub.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return writeScript(
    join(binDir, name),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB)} ${quote(configPath)}\n`,
    `@echo off\r\n${quote(process.execPath)} ${quote(STUB)} ${quote(configPath)}\r\n`,
  );
}

/**
 * Install something that is NOT an agent but answers to the name — a v1
 * `brigadier` on a tap, a shell function, a shim. It must be reported as
 * unusable at the path it actually occupies, never as the vendor's own tool.
 */
export function plantDecoy(binDir: string, name: string): string {
  ensureDir(binDir);
  return writeScript(
    join(binDir, name),
    `#!/bin/sh\necho "this is not ${name}" >&2\nexit 9\n`,
    `@echo off\r\necho this is not ${name} 1>&2\r\nexit /b 9\r\n`,
  );
}

function quote(value: string): string {
  return `"${value.split('"').join('\\"')}"`;
}
