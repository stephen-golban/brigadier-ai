// Claude env-vars/model-config, verified 2026-09-05. Alias resolution remains the CLI's job.
export type Effort = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export interface AgentOptions {
  effort?: Effort;
}
export function effortLevels(model: string): Effort[] {
  if (/haiku|sonnet-4-5|opus-4-1|opus-4-0/.test(model)) return [];
  if (/^(claude-)?(sonnet|opus|fable)(-|$)/.test(model))
    return ["auto", "low", "medium", "high", "xhigh", "max"];
  return [];
}
