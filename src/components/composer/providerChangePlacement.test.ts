import { expect, it } from "vitest";
import { providerChangePlacement } from "./providerChangePlacement";
import type { ExecutionChange } from "../../taskSettings";
import type { ChatItem } from "../../workspaceApi";
const change = (id: string, timestamp: number): ExecutionChange => ({ id, timestamp, provider: "codex", previousProvider: "claude-code", model: null, effort: null });
const user = (id: string, at: number, seq: number): ChatItem => ({ id, at, seq, kind: {type:"user-text"}, session_id:"s", body:"rich **message**", parent_id:null });
it("places changes once before their next saved input and keeps undelivered changes at the live tail", () => {
  const changes = [change("a", 15), change("b", 25)];
  const result = providerChangePlacement(changes, [user("first", 10, 1), user("second", 20, 3)], false);
  expect(result.before.get("second")).toEqual([changes[0]]);
  expect(result.after).toEqual([changes[1]]);
  expect(result.before.has("first")).toBe(false);
});
it("does not attach older or future changes to an unrelated historical page", () => {
  const result = providerChangePlacement([change("before", 5),change("future", 25)], [user("paged", 20, 50)], true);
  expect(result.before.size).toBe(0);
  expect(result.after).toEqual([]);
});
