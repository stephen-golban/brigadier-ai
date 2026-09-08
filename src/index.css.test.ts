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
it("keeps the UI migration boundary free of legacy source and direct dependencies", () => {
  const dependencies = JSON.parse(
    fs.readFileSync("package.json", "utf8"),
  ).dependencies;
  expect(
    Object.keys(dependencies).filter((name) =>
      /radix|cmdk|prompt-kit|shadcn/.test(name),
    ),
  ).toEqual([]);
  expect(fs.existsSync("src/components/ui")).toBe(false);
  expect(fs.existsSync("src/components/prompt-kit")).toBe(false);
  const legacy = sources("src").filter((path) =>
    /from\s+["'][^"']*(?:prompt-kit|components\/ui\/|radix-ui|cmdk)/.test(
      fs.readFileSync(path, "utf8"),
    ),
  );
  expect(legacy).toEqual([]);
});
