# `vendor/grammars/`

Gzipped tree-sitter WASM, and the script that rebuilds it.

## Why the bytes are here rather than imported from `node_modules`

MEASURED against `bun 1.3.14` on 2026-08-18: `bun build --compile` embeds an
imported file **verbatim** — it does not compress. The seven grammars
`src/repomap/grammars.ts` needs cost **5,515,008 bytes** of binary imported raw.
The binary was **63,611,234 bytes** against a **66,060,288-byte (63 MiB)**
budget, leaving **2,449,054 bytes** of headroom, so the raw packaging was 2.25x
the whole allowance.

The same seven, plus the tree-sitter runtime, gzipped and gunzipped at load
time: **660,480 bytes**, and **809,088** including `web-tree-sitter`'s
JavaScript. A tree-sitter parse table is mostly zero padding, so it compresses
about 8.3x. That is what changed #23's "ten grammars do not fit" into "seven fit
with room left over".

MEASURED again on 2026-08-18 after the slice landed: `dist/brigadier` without
the repo map is **63,759,842 bytes (60.81 MiB)**; the same entry point with
`src/repomap/index.ts` reachable is **64,568,930 (61.58 MiB)**, leaving
**1,491,358 bytes (1.42 MiB)** under the 63 MiB budget. All ten of #23's
grammars would in fact fit gzipped, at about 1.94 MB; the other three are left
out to leave that headroom for the rest of the product rather than because they
cannot be afforded.

## Provenance

Every file here is `gzip -9` of one file from a package that is a **declared
production dependency** in `package.json`, so `scripts/inventory.ts` attributes
it from the manifest and `THIRD-PARTY.md` carries its licence text. Nothing in
this directory is in the binary that the generated attribution has not heard of.

| package | version | licence |
| --- | --- | --- |
| `web-tree-sitter` | 0.25.10 | MIT |
| `@vscode/tree-sitter-wasm` | 0.3.1 | MIT |

The exact npm path each file is a copy of is in `regenerate.ts`, which is also
what rebuilds them:

```
bun run vendor/grammars/regenerate.ts
```

`test/repomap-grammars.test.ts` decompresses every file here and compares it to
its npm source byte for byte. A blob cannot be reviewed in a diff, so that check
is the only thing standing between this directory and a stale grammar.

## What is deliberately absent

`cpp`, `c-sharp` and `ruby`. Gzipped they would cost another 869 KB — two thirds
of the remaining headroom — and `src/repomap/map.ts` reports a repository it
cannot read rather than returning an empty map, so their absence is visible to a
user instead of silent.
