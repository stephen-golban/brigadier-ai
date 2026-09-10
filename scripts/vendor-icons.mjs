#!/usr/bin/env node
/**
 * Vendors icons out of `@openai/apps-sdk-ui` into `src/icons/`.
 *
 * Why vendor at all: the package publishes its 745 icons behind exactly one entry point,
 * `@openai/apps-sdk-ui/components/Icon`, and that barrel's relative re-exports carry no file
 * extension, so Node's ESM resolver cannot load it (upstream issue #39, reproduced in
 * `docs/research/apps-sdk-ui-icons.md` §8). Vitest and any Node-side tooling therefore cannot
 * import it at all; the browser bundle can, but pays the 745-module barrel. The icons are MIT and
 * import nothing but `react/jsx-runtime`, so copying the handful we use costs ~20 KB of source and
 * removes the barrel, the `tailwindcss@^4` peer and the ESM defect in one move.
 *
 * How it works: each `dist/es/components/Icon/svg/<Name>.js` is a single arrow function whose body
 * is a `_jsx`/`_jsxs` call tree. Rather than regex the markup, this script executes that body with
 * `_jsx`/`_jsxs` bound to a shim that returns a plain `{ type, props }` tree, then prints the tree
 * back out as JSX. The markup is therefore the package's own, element for element and attribute for
 * attribute — no transcription step to get wrong.
 *
 * Input:  `src/icons/manifest.json` — a sorted array of apps-sdk-ui export names.
 * Output: `src/icons/<Name>.tsx` per entry, plus a regenerated `src/icons/index.ts`.
 *
 * Three deliberate departures from the upstream source:
 *   - `data-icon="<kebab-name>"` on every root, before `{...props}` so a caller can still override
 *     it. Tests target that instead of a library's own class name, which is what made
 *     `WorkTrace.test.tsx`'s `.lucide-check` assertion break on a library swap.
 *   - `aria-hidden="true"` on every root, also before `{...props}`. These glyphs are decorative at
 *     almost every call site, which is what the hand-written modules they replaced all carried; the
 *     handful of sites that give an icon a `role`/`aria-label` override it through the spread.
 *   - a `SVGProps<SVGSVGElement>` type annotation, since upstream ships `.js` plus a `.d.ts`.
 *
 * Run: `npm run vendor:icons`. Requires the devDependency to be installed.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src", "icons");
const pkgDir = join(root, "node_modules", "@openai", "apps-sdk-ui");
const svgDir = join(pkgDir, "dist", "es", "components", "Icon", "svg");

const pkgVersion = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
const names = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
  throw new Error("src/icons/manifest.json must be an array of icon export names");
}
const sorted = [...names].sort();
if (sorted.join("\0") !== names.join("\0")) {
  throw new Error("src/icons/manifest.json must be sorted; run it through .sort()");
}

/** `ObjectIcon.tsx` is the one module whose filename differs from its export name (upstream #22). */
const moduleFor = (name) => (name === "Object" ? "ObjectIcon" : name);

/** `ArrowRotateCcw` -> `arrow-rotate-ccw`; digits stay glued to the word they follow. */
const kebab = (name) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();

/**
 * The jsx-runtime shim: build a plain tree instead of a React element.
 *
 * `key` is jsx-runtime's third argument. It is named and ignored on purpose rather than left off
 * the parameter list, so a keyed child cannot be silently dropped by an arity mismatch: nothing in
 * the generated JSX needs a key (every tree is static and printed literally), and no icon module in
 * the manifest passes one today. If one ever does, the key is deliberately not carried through.
 */
const h = (type, props, key) => {
  void key;
  return { type, props: props ?? {} };
};

function elementOf(name) {
  const file = join(svgDir, `${moduleFor(name)}.js`);
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    throw new Error(`no such icon in @openai/apps-sdk-ui@${pkgVersion}: ${name} (${file})`);
  }
  const body = src
    .replace(/^import\s.*$/gm, "")
    .replace(/^export\s+default\s+\w+\s*;?\s*$/gm, "");
  const local = /const\s+(\w+)\s*=/.exec(body)?.[1];
  if (!local) throw new Error(`unrecognised icon module shape: ${file}`);
  // eslint-disable-next-line no-new-func -- the input is a file inside our own node_modules.
  const build = new Function("_jsx", "_jsxs", `${body}\nreturn ${local};`)(h, h);
  const el = build({});
  if (el?.type !== "svg") throw new Error(`${name} does not have an <svg> root`);
  return el;
}

function attrValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  return `{${JSON.stringify(value)}}`;
}

function serialise(node, indent) {
  const pad = "  ".repeat(indent);
  const { children, ...attrs } = node.props;
  const attrText = Object.entries(attrs)
    .map(([key, value]) => ` ${key}=${attrValue(value)}`)
    .join("");
  const kids = children == null ? [] : Array.isArray(children) ? children : [children];
  if (kids.length === 0) return `${pad}<${node.type}${attrText} />`;
  const inner = kids.map((kid) => serialise(kid, indent + 1)).join("\n");
  return `${pad}<${node.type}${attrText}>\n${inner}\n${pad}</${node.type}>`;
}

const header = (name) => `/**
 * Vendored from \`@openai/apps-sdk-ui\` ${pkgVersion} (MIT, Copyright 2025 OpenAI) —
 * \`dist/es/components/Icon/svg/${moduleFor(name)}.js\`. Licence in \`src/icons/LICENSE.md\`.
 *
 * Generated by \`scripts/vendor-icons.mjs\` (\`npm run vendor:icons\`). Do not edit by hand.
 */
`;

// Clear out stale components so a name dropped from the manifest cannot linger.
for (const file of readdirSync(outDir)) {
  if (file.endsWith(".tsx")) rmSync(join(outDir, file));
}

for (const name of names) {
  const el = elementOf(name);
  const { children, ...attrs } = el.props;
  const attrText = Object.entries(attrs)
    .map(([key, value]) => ` ${key}=${attrValue(value)}`)
    .join("");
  const kids = children == null ? [] : Array.isArray(children) ? children : [children];
  const inner = kids.map((kid) => serialise(kid, 2)).join("\n");
  const root = `  <svg${attrText} data-icon="${kebab(name)}" aria-hidden="true" {...props}`;
  const body = kids.length === 0 ? `${root} />` : `${root}>\n${inner}\n  </svg>`;
  const component = name === "Object" ? "ObjectIcon" : name;
  writeFileSync(
    join(outDir, `${component}.tsx`),
    `${header(name)}import type { SVGProps } from "react";

const ${component} = (props: SVGProps<SVGSVGElement>) => (
${body}
);

export default ${component};
`,
  );
}

const indexHeader = `/**
 * The app's icon set: ${names.length} glyphs vendored from \`@openai/apps-sdk-ui\` ${pkgVersion}
 * (MIT, Copyright 2025 OpenAI). Licence and attribution in \`src/icons/LICENSE.md\`.
 *
 * Generated by \`scripts/vendor-icons.mjs\` (\`npm run vendor:icons\`) from \`src/icons/manifest.json\`.
 * Do not edit by hand — add the name to the manifest and re-run instead.
 *
 * Every icon renders at \`1em\` and inherits \`currentColor\`, so size it with a \`size-*\` class, a
 * \`font-size\`, or explicit \`width\`/\`height\`. Each carries \`data-icon="<kebab-name>"\` on its root,
 * which is what tests should target, and \`aria-hidden="true"\`, since a glyph is decorative unless the
 * call site says otherwise — both sit before \`{...props}\`, so a call site can override either.
 */
import type { ComponentType, SVGProps } from "react";

/** Any icon in this set, for props and lookup tables that hold one. */
export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;
`;

writeFileSync(
  join(outDir, "index.ts"),
  `${indexHeader}\n${names
    .map((name) => {
      const component = name === "Object" ? "ObjectIcon" : name;
      return `export { default as ${component} } from "./${component}";`;
    })
    .join("\n")}\n`,
);

console.log(`vendored ${names.length} icons from @openai/apps-sdk-ui@${pkgVersion} into src/icons/`);
