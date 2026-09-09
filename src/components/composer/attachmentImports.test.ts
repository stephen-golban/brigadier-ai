import { expect, it, vi } from "vitest";
import { attachmentImports } from "./attachmentImports";

it("persists exact bytes and stable import identity across repository reloads and isolates scopes", async () => {
  // Node's Blob supports structuredClone; jsdom's File is not cloneable by Node's clone implementation.
  const nodeBufferModule = "node:buffer";
  const { Blob: StandardsBlob } = await import(nodeBufferModule);
  const source = "😀\r\n  const literal = `source`;\r\n";
  const file = new StandardsBlob([source]) as unknown as Blob;
  await attachmentImports.save({id:"durable-import",scope:"project:session",name:"paste.txt",size:file.size,file,error:"Import interrupted"});
  expect(await attachmentImports.load("other:session")).toEqual([]);
  vi.resetModules();
  const restored = (await import("./attachmentImports")).attachmentImports;
  const [item] = await restored.load("project:session");
  expect(item).toMatchObject({id:"durable-import",name:"paste.txt",error:"Import interrupted"});
  expect(await item!.file!.text()).toBe(source);
  await restored.remove("durable-import");
  expect(await restored.load("project:session")).toEqual([]);
});

it("persists native-path retries and imported receipts without losing their stable IDs", async () => {
  const metadata = {id:"saved-file",projectId:"project",name:"image.png",size:10,mediaType:"image/png",createdAt:1};
  await attachmentImports.save({id:"native-import",scope:"project:session",path:"/tmp/image.png",name:"image.png",size:10,metadata});
  const [item] = await attachmentImports.load("project:session");
  expect(item).toMatchObject({id:"native-import",path:"/tmp/image.png",metadata});
  await attachmentImports.remove("native-import");
});
