import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); });

describe("recoverable navigation data", () => {
  it("preserves a trashed note across reload and restores its exact content", async () => {
    const { workbenchApi } = await import("./workbenchApi");
    const { navigationApi } = await import("./navigationApi");
    await workbenchApi.saveNote({ id: "note", title: "Ideas", content: "Unfinished work", projectId: null, alwaysInclude: true, revision: 0, language: "markdown" });
    const plan = await navigationApi.preview("note", "note");
    await navigationApi.move(plan);
    expect((await workbenchApi.load()).notes).toEqual([]);
    vi.resetModules();
    const reloaded = await import("./navigationApi");
    const notes = await import("./workbenchApi");
    const entry = (await reloaded.navigationApi.load()).trash[0]!;
    expect(entry.id).toBe("note");
    expect((await notes.workbenchApi.load()).notes).toEqual([]);
    await reloaded.navigationApi.restore(entry);
    expect((await notes.workbenchApi.load()).notes[0]).toMatchObject({id:"note", content:"Unfinished work", alwaysInclude:true});
    await reloaded.navigationApi.move(await reloaded.navigationApi.preview("note", "note"));
    await reloaded.navigationApi.purge(entry);
    expect((await reloaded.navigationApi.load()).trash).toEqual([]);
    expect((await notes.workbenchApi.load()).notes).toEqual([]);
  });
  it("requires restoring the parent project before a separately trashed session", async () => {
    const project = {kind:"project",id:"p",title:"Project",projectId:"p",sessionIds:["s"],trashedAt:1};
    const session = {kind:"session" as const,id:"s",title:"Session",projectId:"p",sessionIds:["s"],trashedAt:1};
    localStorage.setItem("brigadier:navigation:v1",JSON.stringify({projectColors:{p:"blue"},pinnedSessions:["s"],trash:[project,session]}));
    const {navigationApi,isTrashed} = await import("./navigationApi");
    await expect(navigationApi.restore(session)).rejects.toThrow("Restore the parent project first");
    let data = await navigationApi.restore({...project, kind:"project"});
    expect(isTrashed(data,"session","s")).toBe(true);
    data = await navigationApi.restore(session);
    expect(isTrashed(data,"session","s")).toBe(false);
    expect(data.pinnedSessions).toEqual(["s"]);
    expect(data.projectColors).toEqual({p:"blue"});
  });
  it("does not overwrite corrupt navigation metadata", async () => {
    localStorage.setItem("brigadier:navigation:v1", "broken");
    const {navigationApi} = await import("./navigationApi");
    await expect(navigationApi.customize("pin","s","pinned")).rejects.toThrow();
    expect(localStorage.getItem("brigadier:navigation:v1")).toBe("broken");
  });
});
