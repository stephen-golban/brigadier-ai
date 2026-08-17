/**
 * The lane: given a permission request, allow or deny — and say why.
 *
 * MEASURED, and this module exists because of it (#3, #41, ruling 43). The
 * information content of a permission request varies by vendor AND by tool:
 *
 *   Claude   `edit`     full absolute path in `locations`, plus a title
 *   Claude   `execute`  locations EMPTY; an opaque shell string in rawInput
 *   Codex    both       nothing at all — no title, no locations, no rawInput
 *   Copilot  `edit`     full path + title + rawInput.fileName
 *   Copilot  `execute`  locations empty, but a meaningful title
 *   opencode `edit`     full locations, and it only asks when out of cwd
 *   Qwen     anything   never asks; it enforces its own policy silently
 *
 * So `locations.every(inLane)` — the obvious guard — CANNOT FAIL on Codex,
 * because `[].every(...)` is `true`. A lane built that way would wave through
 * exactly the vendor that tells us least.
 *
 * The rule here is therefore inverted: **refuse what cannot be placed.** A
 * request carrying no locatable path is denied, not allowed, and the verdict
 * records that it was denied for lack of evidence rather than because a path
 * was out of lane. Ruling 32's standing rule applies — a weakened check must
 * never render as a pass.
 */

import { Containment } from "./containment.ts";

export type Decision = "allow" | "deny";

export type Reason =
  /** Every path in the request resolves inside the lane. */
  | "in-lane"
  /** At least one path resolves outside the lane. */
  | "out-of-lane"
  /** The request carried no path we could place. Denied by the standing rule. */
  | "unplaceable"
  /** A path is inside the clone's own .git. Decision 34. */
  | "git-internal"
  /** Policy said allow everything. Only for baseline measurement, never for work. */
  | "policy-allow"
  /** Policy said deny everything. */
  | "policy-deny";

export interface Verdict {
  decision: Decision;
  reason: Reason;
  /** The paths the request actually carried, after extraction. May be empty. */
  paths: string[];
}

/** The subset of an ACP permission request the lane needs. Vendor-shaped. */
export interface PermissionRequest {
  toolCall?: {
    toolCallId?: string;
    title?: string | null;
    kind?: string;
    locations?: Array<{ path?: string }> | null;
    rawInput?: Record<string, unknown> | null;
  } | null;
}

export type Policy = "lane" | "allow" | "deny";

/**
 * Pull every path the request carries, from wherever this vendor put it.
 *
 * `locations` is the only structured channel, but Copilot puts the target in
 * `rawInput.fileName` and opencode in `rawInput.filepath`, so a lane that reads
 * only `locations` throws away evidence it was given. Deliberately NOT parsed:
 * `rawInput.command`, an opaque shell string — extracting paths from shell text
 * is a parser with an attacker on the other side, and getting it wrong means
 * allowing a write we could not actually see.
 */
export function extractPaths(request: PermissionRequest): string[] {
  const call = request.toolCall;
  if (!call) return [];

  const paths: string[] = [];
  for (const location of call.locations ?? []) {
    if (location?.path) paths.push(location.path);
  }

  const raw = call.rawInput ?? {};
  for (const key of ["fileName", "filepath", "file_path", "path"]) {
    const value = raw[key];
    if (typeof value === "string" && value) paths.push(value);
  }

  return [...new Set(paths)];
}

export class Lane {
  private readonly containment: Containment;

  constructor(
    root: string,
    private readonly policy: Policy = "lane",
  ) {
    this.containment = new Containment(root);
  }

  get root(): string {
    return this.containment.root;
  }

  decide(request: PermissionRequest): Verdict {
    const paths = extractPaths(request);

    if (this.policy === "allow") return { decision: "allow", reason: "policy-allow", paths };
    if (this.policy === "deny") return { decision: "deny", reason: "policy-deny", paths };

    // The standing rule. An empty path list is not consent.
    if (paths.length === 0) return { decision: "deny", reason: "unplaceable", paths };

    if (paths.some((p) => this.containment.isGitInternal(p))) {
      return { decision: "deny", reason: "git-internal", paths };
    }

    if (!paths.every((p) => this.containment.contains(p))) {
      return { decision: "deny", reason: "out-of-lane", paths };
    }

    return { decision: "allow", reason: "in-lane", paths };
  }
}
