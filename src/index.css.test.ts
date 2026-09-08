import { expect, it } from "vitest";
interface Files {
  readFileSync: (path: string, encoding: "utf8") => string;
  readdirSync: (
    path: string,
    options: { withFileTypes: true },
  ) => { name: string; isDirectory: () => boolean }[];
  existsSync: (path: string) => boolean;
}
const fs = (await import(
  /* @vite-ignore */ "node:" + "fs"
)) as unknown as Files;
function sources(path: string): string[] {
  return fs
    .readdirSync(path, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? sources(`${path}/${e.name}`)
        : /\.tsx?$/.test(e.name) && !e.name.includes(".test.")
          ? [`${path}/${e.name}`]
          : [],
    );
}
it("keeps legacy UI dependencies out while allowing installed assistant-ui Elements", () => {
  const dependencies = JSON.parse(
    fs.readFileSync("package.json", "utf8"),
  ).dependencies;
  expect(
    Object.keys(dependencies).filter((name) => /cmdk|prompt-kit/.test(name)),
  ).toEqual([]);
  expect(fs.existsSync("src/components/ui/collapsible.tsx")).toBe(true);
  expect(fs.existsSync("src/components/prompt-kit")).toBe(false);
  const legacy = sources("src").filter((path) =>
    /from\s+["'][^"']*(?:prompt-kit|cmdk)/.test(fs.readFileSync(path, "utf8")),
  );
  expect(legacy).toEqual([]);
});
