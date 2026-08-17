# Vendored attribution sources

Verbatim upstream license files, kept here because the components they describe are **inside the
shipped binary** and Apache-2.0 §4(a) is owed to whoever receives that binary — which, under ruling
26, is often the binary alone with no repository beside it.

These files are inputs to `scripts/licenses.ts`, which generates `THIRD-PARTY.md` and
`src/generated/licenses.ts` from them. Do not edit them by hand except to replace one wholesale with
a newer upstream copy.

| file | upstream | pinned to |
| --- | --- | --- |
| `bun-LICENSE.md` | <https://github.com/oven-sh/bun/blob/main/LICENSE.md> | **bun 1.3.14** |

## Why Bun's license is here at all

Ruling 5 compiles brigadier with `bun --compile`, which embeds the Bun runtime — and Bun statically
links **JavaScriptCore/WebKit (LGPL-2)** and **tinycc (LGPL-2.1)** alongside ~25 other libraries. So
every signed binary brigadier redistributes carries that whole set, before a single ACP bridge is
vendored. Ruling 47 discharges the attribution half here; the LGPL relink half is ticketed
separately.

`scripts/license-gate.ts` **fails the build if the `bun` building the binary is not the version this
file is pinned to**, so a Bun upgrade cannot silently leave the attribution describing a runtime that
is no longer in the artifact.
