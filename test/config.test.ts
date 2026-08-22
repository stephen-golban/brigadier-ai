// SPDX-License-Identifier: Apache-2.0
/**
 * Ruling 18's per-machine layer, and ruling 60's lesson about how it fails.
 *
 * The assertions that matter most here are the two failure directions, because
 * ruling 60 measured both of them shipping in real manifests: `hooks.json`
 * discards EVERY hook on one unrecognised event, and `.lsp.json` COUNTS an
 * unknown key as a server. Both are silent. So an unknown key must warn by name
 * and survive, and a known key with the wrong type must refuse — and a test
 * that only proved the happy path would be indistinguishable from one that
 * proved neither.
 */

import { describe, expect, test } from "bun:test";
import {
  ConfigUnusable,
  DEFAULT_CONFIG,
  DEFAULT_EXPLORATION_FLOOR,
  bridgesPath,
  configHome,
  configPath,
  loadConfig,
  parseConfig,
  resolve,
  type ConfigSource,
} from "../src/config/config.ts";

const PATH = "/home/example/.config/brigadier/config.json";

function source(files: Record<string, string>): ConfigSource {
  return {
    exists: (path) => path in files,
    read: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  };
}

describe("where the file lives", () => {
  test("XDG_CONFIG_HOME wins when it is set and non-empty", () => {
    expect(configHome({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/brigadier/config.json");
  });

  test("an EMPTY XDG_CONFIG_HOME falls back rather than resolving to a bare relative path", () => {
    // The negative control for the check above: `""` is set-but-useless, and a
    // naive `env.XDG_CONFIG_HOME ?? default` treats it as a valid config home
    // and produces `brigadier/config.json` relative to the working directory —
    // which is inside whatever repository brigadier was invoked in, and ruling
    // 37 says nothing brigadier executes may come from there.
    expect(configHome({ XDG_CONFIG_HOME: "" })).not.toBe("");
    expect(configPath({ XDG_CONFIG_HOME: "" }).startsWith("/")).toBe(true);
  });

  test("both files brigadier reads resolve through the same config home", () => {
    const env = { XDG_CONFIG_HOME: "/xdg" };
    expect(configPath(env)).toBe("/xdg/brigadier/config.json");
    expect(bridgesPath(env)).toBe("/xdg/brigadier/bridges.json");
  });
});

describe("an absent file is the normal case", () => {
  test("no file means the defaults, silently, and `present` says so", () => {
    const loaded = loadConfig(PATH, source({}));
    expect(loaded.present).toBe(false);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config).toEqual(DEFAULT_CONFIG);
  });

  test("ruling 71's promise: the defaults are a working configuration", () => {
    // A machine `setup` has never touched must load exactly as though setup had
    // run and changed nothing. Possession on, ambient suppressed (ruling 17),
    // no verify command (D19: never required), plan file not kept (D16).
    expect(DEFAULT_CONFIG.possession.enabled).toBe(true);
    expect(DEFAULT_CONFIG.ambientSuppression).toBe(true);
    expect(DEFAULT_CONFIG.verify.command).toBeUndefined();
    expect(DEFAULT_CONFIG.plan.keep).toBe(false);
    expect(DEFAULT_CONFIG.explorationFloor).toBe(DEFAULT_EXPLORATION_FLOOR);
  });
});

describe("ruling 60's two failure directions, kept apart", () => {
  test("an UNKNOWN key warns by name and does not stop the load", () => {
    const loaded = parseConfig(`{"notARealKey": 1, "ambientSuppression": false}`, PATH);
    expect(loaded.warnings.length).toBe(1);
    expect(loaded.warnings[0]).toContain("notARealKey");
    // The rest of the file still takes effect — this is the `.lsp.json`
    // direction, and the fix is to report it, not to discard the document.
    expect(loaded.config.ambientSuppression).toBe(false);
  });

  test("a TYPO is named with its nearest real key, which is the whole point", () => {
    const loaded = parseConfig(`{"possesion": {"enabled": false}}`, PATH);
    expect(loaded.warnings[0]).toContain("possesion");
    expect(loaded.warnings[0]).toContain("possession");
    // And it did NOT take effect, which is exactly why the warning has to exist.
    expect(loaded.config.possession.enabled).toBe(true);
  });

  test("a distant unknown key gets no suggestion rather than a misleading one", () => {
    const loaded = parseConfig(`{"telemetryEndpoint": "https://example.invalid"}`, PATH);
    expect(loaded.warnings[0]).toContain("telemetryEndpoint");
    expect(loaded.warnings[0]).not.toContain("did you mean");
  });

  test("a KNOWN key with the wrong type REFUSES rather than defaulting", () => {
    expect(() => parseConfig(`{"ambientSuppression": "yes"}`, PATH)).toThrow(ConfigUnusable);
    expect(() => parseConfig(`{"possession": true}`, PATH)).toThrow(ConfigUnusable);
    expect(() => parseConfig(`{"roles": {"builder": "claude"}}`, PATH)).toThrow(ConfigUnusable);
    expect(() => parseConfig(`{"runRoot": ""}`, PATH)).toThrow(ConfigUnusable);
  });

  test("the refusal names the file and the key, because two files live there", () => {
    try {
      parseConfig(`{"plan": {"keep": "always"}}`, PATH);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigUnusable);
      expect((error as ConfigUnusable).path).toBe(PATH);
      expect((error as Error).message).toContain("plan.keep");
    }
  });
});

describe("unreadable and unparseable refuse, because the operator believes it is in force", () => {
  test("invalid JSON refuses", () => {
    expect(() => parseConfig(`{"possession":`, PATH)).toThrow(ConfigUnusable);
  });

  test("a non-object top level refuses", () => {
    expect(() => parseConfig(`[]`, PATH)).toThrow(ConfigUnusable);
    expect(() => parseConfig(`"possession"`, PATH)).toThrow(ConfigUnusable);
  });

  test("a file that exists but cannot be read refuses rather than defaulting", () => {
    const hostile: ConfigSource = {
      exists: () => true,
      read: () => {
        throw new Error("EACCES");
      },
    };
    expect(() => loadConfig(PATH, hostile)).toThrow(ConfigUnusable);
  });
});

describe("`workers` gets the same guard the flag already has", () => {
  test("the values measured breaking the fan-out arithmetic are refused here too", () => {
    // MEASURED against `bun 1.3.14` on 2026-08-20 through `--workers`:
    // `abc` printed `NaN worker(s) in wave 1` and dispatched nothing while
    // reporting success; `2.5` printed `2.5 worker(s)`. The config file reaches
    // the identical `Math.min` chain.
    expect(() => parseConfig(`{"workers": "abc"}`, PATH)).toThrow(ConfigUnusable);
    expect(() => parseConfig(`{"workers": 2.5}`, PATH)).toThrow(ConfigUnusable);
    expect(() => parseConfig(`{"workers": 0}`, PATH)).toThrow(ConfigUnusable);
    expect(parseConfig(`{"workers": 3}`, PATH).config.workers).toBe(3);
  });
});

describe("ruling 52: unconfigured and could-not-run are different things", () => {
  test("an omitted verify command is unconfigured", () => {
    expect(parseConfig(`{}`, PATH).config.verify.command).toBeUndefined();
  });

  test("an EMPTY verify command refuses, because it is neither", () => {
    expect(() => parseConfig(`{"verify": {"command": []}}`, PATH)).toThrow(ConfigUnusable);
  });

  test("a real verify command survives as written, argv-shaped", () => {
    const loaded = parseConfig(`{"verify": {"command": ["bun", "test"]}}`, PATH);
    expect(loaded.config.verify.command).toEqual(["bun", "test"]);
  });
});

describe("ruling 81's exploration floor", () => {
  test("it is a fraction and out-of-range values refuse", () => {
    expect(() => parseConfig(`{"explorationFloor": 1.5}`, PATH)).toThrow(ConfigUnusable);
    expect(() => parseConfig(`{"explorationFloor": -0.1}`, PATH)).toThrow(ConfigUnusable);
    expect(parseConfig(`{"explorationFloor": 0}`, PATH).config.explorationFloor).toBe(0);
  });

  test("zero is permitted and is NOT the default — turning the floor off is the operator's call", () => {
    // Ruling 81 makes the floor mandatory as a mechanism, not as a value an
    // operator may never change. What it forbids is the floor being absent by
    // accident, which is what a default of 0 would be.
    expect(DEFAULT_EXPLORATION_FLOOR).toBeGreaterThan(0);
  });
});

describe("ruling 18's precedence", () => {
  test("flag beats file beats default", () => {
    expect(resolve(1, 2, 3)).toBe(1);
    expect(resolve(undefined, 2, 3)).toBe(2);
    expect(resolve(undefined, undefined, 3)).toBe(3);
  });

  test("`false` and `0` from a file are values, not absences", () => {
    // The reason `resolve` exists at all: `flag || file` is wrong here and
    // looks right, and it is wrong exactly once — on the settings whose whole
    // purpose is to turn something off.
    expect(resolve(undefined, false, true)).toBe(false);
    expect(resolve(undefined, 0, 5)).toBe(0);
    expect(resolve(false, true, true)).toBe(false);
  });
});

describe("a nested key is still a key", () => {
  test("an unknown key INSIDE a known object is warned about by its full path", () => {
    // `{"possession": {"enabld": true}}` is the same operator mistake one level
    // down: the setting does not take effect and, without this, nothing says so.
    const loaded = parseConfig(`{"possession": {"enabld": false}}`, PATH);
    expect(loaded.warnings.length).toBe(1);
    expect(loaded.warnings[0]).toContain("possession.enabld");
    expect(loaded.warnings[0]).toContain("possession.enabled");
    expect(loaded.config.possession.enabled).toBe(true);
  });

  test("every nested object is covered, not just the first one written", () => {
    const loaded = parseConfig(
      `{"roles": {"bulider": []}, "verify": {"cmd": ["x"]}, "plan": {"kept": true}}`,
      PATH,
    );
    const text = loaded.warnings.join("\n");
    expect(text).toContain("roles.bulider");
    expect(text).toContain("verify.cmd");
    expect(text).toContain("plan.kept");
  });

  test("a KNOWN nested key is not warned about", () => {
    expect(parseConfig(`{"possession": {"enabled": false}}`, PATH).warnings).toEqual([]);
  });
});

describe("ruling 85: when brigadier stops to ask", () => {
  const load = (document: Record<string, unknown>) =>
    loadConfig("/c.json", { exists: () => true, read: () => JSON.stringify(document) });

  test("the default is the narrowed one, and it is a value rather than a silence", () => {
    expect(DEFAULT_CONFIG.askBeforeSpending).toBe("unrequested");
    expect(load({}).config.askBeforeSpending).toBe("unrequested");
  });

  test("`always` restores D3 read literally", () => {
    expect(load({ askBeforeSpending: "always" }).config.askBeforeSpending).toBe("always");
  });

  test("a value outside the two is REFUSED, naming both", () => {
    expect(() => load({ askBeforeSpending: "sometimes" })).toThrow(/unrequested or always/);
    // And a boolean is not a policy, however tempting.
    expect(() => load({ askBeforeSpending: true })).toThrow(ConfigUnusable);
  });

  test("it is a KNOWN key, so setting it is not warned about as a typo", () => {
    expect(load({ askBeforeSpending: "always" }).warnings).toEqual([]);
  });
});
