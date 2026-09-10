# Striped-disc logo pipeline

Checked 2026-09-10 for the selected striped-disc logo implementation.

## Documented behavior

- Tauri v2 `tauri icon [INPUT] --output <OUTPUT>` accepts a square SVG or PNG source and generates platform icons. The existing SVG-to-temporary-directory approach matches this interface. [Tauri CLI](https://v2.tauri.app/reference/cli/#icon)
- Tauri documents ICNS for macOS, ICO for Windows, and PNG for Linux. Its desktop defaults live in `src-tauri/icons`; bundle configuration can specify other paths. [Tauri app icons](https://v2.tauri.app/develop/icons/)
- SVG `use` instances inherit styles from their host `use` element. Outer-document selectors do not directly match the cloned descendants, and presentation attributes are cloned with the referenced geometry. Keep theme color inherited rather than relying on selectors reaching inside the external SVG. [SVG 2 style scoping and inheritance](https://www.w3.org/TR/SVG2/struct.html#UseStyleInheritance)
- `fill="currentColor"` obtains its paint from `color`, and fill is inherited. A reusable group can therefore follow the surrounding interface color, while an enclosing group with an explicit `color` sets the generated icon's mark color. [SVG 2 color and fill](https://www.w3.org/TR/SVG2/painting.html#ColorProperty)

## Inspected repository source

These observations describe the files before the striped-disc replacement, not an API guarantee:

- `src/components/BrandMark.tsx` uses a 256-square viewBox and references `/brand/fold.svg#mark` through external `use`.
- `public/brand/fold.svg` provides a direct `<g id="mark" fill="currentColor">` with paths.
- `scripts/generate-brand.mjs` extracts everything beginning at the first indented `<g` through the closing SVG tag. It embeds that markup in an icon composition, supplies `color="#f2f5ff"`, calls Tauri icon generation, then replaces only filenames already present in `src-tauri/icons`.

## Implementation recommendation

Retain a self-contained `g#mark` containing simple filled paths or rectangles, with `fill="currentColor"`, and update both component and generator to the chosen master filename. No masks are needed for this geometry. Avoiding mask/clip definitions in the logo itself also avoids dependencies outside the extracted group; this is a recommendation derived from the inspected generator, not a claim that SVG masks are unsupported. The existing app-icon background clip can remain separate.

Verify the external-use mark in the app's light and dark themes and inspect generated small icons, since the narrow stripe spacing is a visual constraint that API documentation cannot validate.
