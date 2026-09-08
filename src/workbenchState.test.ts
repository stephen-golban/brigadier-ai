import { beforeEach, expect, it } from "vitest";
import {
  migrateSessionLayouts,
  workspaceKey,
  type ProjectTab,
} from "./workbenchState";
beforeEach(() => localStorage.clear());
it("migrates mixed project tabs into one workspace per session without losing recovery IDs", () => {
  const tab = (
    id: string,
    kind: ProjectTab["kind"],
    sessionId: string | null,
  ): ProjectTab => ({
    id,
    kind,
    path: kind === "session" ? sessionId! : id,
    root: "/repo",
    context: { projectId: "p", sessionId },
  });
  localStorage.setItem(
    "brigadier:project-tabs:v1",
    JSON.stringify({
      p: {
        tabs: [
          tab("session:a", "session", "a"),
          tab("a.ts", "file", "a"),
          tab("session:b", "session", "b"),
          tab("root.ts", "file", null),
          tab("pty", "terminal", "a"),
        ],
        active: "session:b",
      },
    }),
  );
  const migrated = migrateSessionLayouts();
  expect(migrated[workspaceKey("p", "a")].tabs.map((t) => t.id)).toEqual([
    "session:a",
    "a.ts",
    "pty",
  ]);
  expect(migrated[workspaceKey("p", "b")].tabs.map((t) => t.id)).toEqual([
    "session:b",
    "root.ts",
  ]);
  expect(migrated[workspaceKey("p", "b")].active).toBe("session:b");
  expect(localStorage.getItem("brigadier:project-tabs:v1")).not.toBeNull();
});
it("handles corrupt old layouts and keys containing punctuation", () => {
  localStorage.setItem("brigadier:project-tabs:v1", "broken");
  expect(migrateSessionLayouts()).toEqual({});
  expect(workspaceKey("p:s", "a")).not.toBe(workspaceKey("p", "s:a"));
});
