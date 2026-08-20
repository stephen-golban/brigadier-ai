# Relinking brigadier against your own LGPL libraries

brigadier ships as one compiled binary. `bun --compile` (ruling 5) embeds the Bun runtime whole,
and Bun statically links two LGPL libraries — **JavaScriptCore (WebKit)** and **tinycc**. Every
brigadier binary therefore redistributes them, and LGPL §6 attaches obligations to that.

This file is the long form. The short form travels inside the artifact: `brigadier licenses --full`
carries both licence texts verbatim, both pinned revisions, the rebuild path, and the per-file
attribution census. That split is deliberate — ruling 26 delivers a bare binary, so a recipient may
have the executable and no repository, and anything that only lives here does not reach them.

Ruling 72 is not legal advice, and neither is this. Counsel's review before the first signed tag
stands regardless of what is written here.

## Status: the source offer is NOT discharged

Stated plainly, because an accurate statement of an open obligation is honest and an inaccurate
statement that it is closed is not.

| obligation | status |
| --- | --- |
| §6, "You must supply a copy of this License" | **done** — both texts are in the binary; `bun run license-gate` fails the build if they are not |
| §6, prominent notice that the Library is used | **done** — `brigadier licenses`, no flag needed |
| §6a, the "work that uses the Library" as source | **not done** — brigadier's own source is Apache-2.0 licensed and the repository is now **publicly readable**: MEASURED against `gh 2.95.0` and `curl 8.7.1` on 2026-08-20, `gh repo view stephen-golban/brigadier-ai --json visibility` reports `PUBLIC` and an unauthenticated GET of `api.github.com/repos/stephen-golban/brigadier-ai` returns **200**. Readable is not offered — see the correction below |
| §6a, the Library's own complete corresponding source | **not done** — see below |
| §6c of LGPL-2.0 / §6d of LGPL-2.1, "equivalent access… from the same place" | **not done** — see below |
| §6, "any data and utility programs needed for reproducing the executable" | **written, not proven** — see below |
| BSD-2/BSD-3 attribution for the non-LGPL majority of WebKit | **done as an enumeration** — see the census |

**CORRECTED 2026-08-20 — the §6a row above asserted something that is no longer true. The earlier
measurement is SUPERSEDED rather than deleted.** Until this date that row read: *"brigadier's own
source is Apache-2.0 licensed but **unpublished**: MEASURED 2026-08-17,
`api.github.com/repos/stephen-golban/brigadier-ai` returns **404** and `package.json` says
`"private": true`"*. That measurement was TRUE ON 2026-08-17; the repository was made public on
2026-08-20. `package.json` does still say `"private": true`, deliberately — that is npm's guard
against `npm publish`, a different question from whether this repository can be read, and neither
this file nor the generated attribution offers it as evidence of either any more. The identical
correction is in `scripts/inventory.ts`, and therefore in `THIRD-PARTY.md` and in the binary; these
two accounts of the same event are meant to stay word for word the same.

**The row's status did NOT change: it is still not done.** A readable repository is not a discharged
§6 offer. §6 attaches to **distribution** of the binary — the source has to reach whoever holds the
binary, from the same place the binary came from — and brigadier still publishes no release
artifacts, so that place still does not exist. What changed on 2026-08-20 is only that this half of
§6a can be fetched at all; whether that discharges anything is a legal reading, and ruling 72 gates
on counsel, not on us.

**Why the source half is not done.** brigadier publishes no release artifacts yet. There is no
"same place as the binary" from which to serve WebKit's and tinycc's corresponding source, and no
mirror under our own control exists. A link to `oven-sh/WebKit` is not a substitute: Qt's published
obligations guidance — READ 2026-08-17,
<https://www.qt.io/licensing/open-source-lgpl-obligations> — puts the requirement as "complete
corresponding source code of the library used with the application or the device built using LGPL,
including all modifications to the library, should be delivered with the application (or
alternatively provide a written offer with instructions on how to get the source code)". Serving it
from somewhere we do not control is not delivering it.

**What that leaves for the first release**, and it is a release step rather than a code change:
publish brigadier's own source, publish source archives of both libraries at exactly the pinned
revisions below as assets beside the binary, and replace the "NOT YET DISCHARGED" paragraph in
`scripts/inventory.ts` with the URLs that serve them. Until then the generated attribution says the
obligation is open — in the file and in the binary, in those words.

**Why "written, not proven" for reproducibility.** §6 requires the shipped form of the "work that
uses the Library" to include "any data and utility programs needed for reproducing the executable
from it". The path below is written out and every command in it is real, but nobody has executed it
end to end and compared the result against a shipped binary. Ruling 72 records that as a bar item
still to be written. Nothing in this repository claims it has been done.

## The pins, and how each one was established

`vendor/pins.json` is the machine-readable copy. `bun run license-gate` re-checks the first link on
every build — the building `bun`'s version and revision against the pins — and cannot check the
rest, which is a network read; those were checked against the primary source on **2026-08-17** and
each is re-checkable by you in under a minute with the commands below.

| what | value | how it was established |
| --- | --- | --- |
| the Bun that builds | `1.3.14` | `bun --version`, MEASURED 2026-08-17 on darwin 25.5.0 arm64 |
| that Bun's source commit | `0d9b296af33f2b851fcbf4df3e9ec89751734ba4` | `bun --revision`, MEASURED 2026-08-17 |
| the tag it corresponds to | `bun-v1.3.14` | GitHub API `repos/oven-sh/bun/git/ref/tags/bun-v1.3.14` resolves to that same commit, READ 2026-08-17 |
| WebKit | `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b` | `WEBKIT_VERSION` in `scripts/build/deps/webkit.ts` at tag `bun-v1.3.14`, READ 2026-08-17 from <https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/scripts/build/deps/webkit.ts>; the commit exists in `oven-sh/WebKit` and is dated 2026-05-12 (GitHub API, READ 2026-08-17) |
| tinycc | `12882eee073cfe5c7621bcfadf679e1372d4537b` | `TINYCC_COMMIT` in `scripts/build/deps/tinycc.ts` at the same tag, READ 2026-08-17; the commit exists in `oven-sh/tinycc` and is dated 2026-01-18 (GitHub API, READ 2026-08-17) |

Verify the chain yourself:

```sh
bun --revision                        # must equal the bun-revision pin
curl -s https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/scripts/build/deps/webkit.ts | grep WEBKIT_VERSION
curl -s https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/scripts/build/deps/tinycc.ts | grep TINYCC_COMMIT
bun run license-gate                  # checks all of the above against vendor/pins.json
```

### What the pins do NOT establish

Recorded because the difference matters and a pin that is trusted further than it was checked is
the failure this repository keeps writing rulings about.

- They are read from the **build recipe** at Bun's tagged commit. They establish which revisions
  that recipe names. They do not prove that the `bun` binary on this machine, which Oven built on
  their own CI, was produced from that recipe with no override — `scripts/build/deps/webkit.ts`
  itself documents a `--webkit-version=<hash>` flag that would change it.
- WebKit is consumed as a **prebuilt tarball** from `oven-sh/WebKit`'s
  `autobuild-<sha>` release, so the sha names the source of the prebuilt, not a local compile that
  can be observed.
- Nothing here reads the shipped `bun` binary and recovers a WebKit revision from it. If you know a
  way to do that, it would upgrade this from "the recipe says so" to "the artifact says so", and it
  is worth doing.
- Bun **patches** tinycc: `patches/tinycc/tcc.h.patch` at tag `bun-v1.3.14`, READ 2026-08-17. The
  corresponding source is the pinned revision **plus that patch**. Bun's prebuilt
  `src/runtime/ffi/libtcc1.a.macos-aarch64` is a compiled artifact checked into their tree; where
  it came from was not established here.

## The rebuild path

```sh
# 1. The library, at exactly the revision this binary was built from.
git clone https://github.com/oven-sh/WebKit.git WebKit
git -C WebKit checkout 5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b
# or, for tinycc:
git clone https://github.com/oven-sh/tinycc.git tinycc
git -C tinycc checkout 12882eee073cfe5c7621bcfadf679e1372d4537b
#    ... and apply Bun's patch, or your rebuild is not the one that shipped:
curl -sO https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/patches/tinycc/tcc.h.patch
git -C tinycc apply ../tcc.h.patch

# 2. Make your changes, then rebuild Bun against them. Bun's own LICENSE.md documents the
#    WebKit route; the build scripts are in oven-sh/bun under scripts/build/deps/.
git clone https://github.com/oven-sh/bun.git && git -C bun checkout bun-v1.3.14
#    BUN_WEBKIT_PATH=/abs/path/to/WebKit  bun run build:local     (from inside the bun checkout)

# 3. Rebuild brigadier with the Bun you just built. brigadier's own source is the other half
#    of §6a; it is Apache-2.0 licensed and in this repository, which has been publicly readable
#    since 2026-08-20 — readable, not offered under §6 (see above).
PATH=/path/to/your/bun/bin:$PATH bun run build
```

Step 2 is upstream's build, not ours, and it is the step most likely to have moved since this was
written. `vendor/bun-LICENSE.md` carries Bun's own instructions verbatim, at the pinned version.

## The attribution census

Ruling 72's second correction: JavaScriptCore is **not uniformly LGPL**, and the flat `LGPL-2`
label this repository used to print understated an obligation that is ours rather than upstream's —
the BSD-licensed majority carries its own attribution requirement.

`vendor/lgpl-census.json` is a file-by-file walk of both libraries at the pinned revisions,
generated rather than typed, and rendered into `THIRD-PARTY.md` and into the binary. MEASURED with
git 2.50.1 (Apple Git-155) and bun 1.3.14 on 2026-08-17, reading the first 8192 bytes of every file:

| tree | files | LGPL | BSD-2 | BSD-3 | other | unclassified |
| --- | --- | --- | --- | --- | --- | --- |
| `Source/JavaScriptCore` | 3785 | 201 | 3264 | 105 | 6 | 209 |
| `Source/WTF` | 1126 | 101 | 690 | 83 | 15 | 237 |
| tinycc (whole tree) | 523 | 28 | 0 | 1 | 7 | 487 |

297 of WebKit's 302 LGPL-headed files say "or (at your option) any later version"; **five do not**,
and for those the version named in the file is the one a recipient gets. Two of the five are
`COPYING.LIB` itself and a docs template; the other three are real source: `WTF/wtf/text/Base64.cpp`
says "the GNU Lesser General Public License (LGPL) version 2 as published by the Free Software
Foundation" with no election, and `WTF/wtf/DateMath.h` and `runtime/JSDateMath.h` are under the
Mozilla tri-licence (MPL 1.1 / GPL 2.0 / LGPL 2.1). READ 2026-08-17. 24 of tinycc's 28 say it.
Three tinycc files carry a plain GPL header rather than a lesser one, and only one of the three —
`lib/libtcc1.c`, the runtime library that is actually linked — carries the linking exception that
makes that unproblematic. The other two (`il-opcodes.h`, `texi2pod.pl`) do not, and whether they
are compiled into anything was not established: this census reads headers, not build graphs.

To reproduce it (about 220 MB of network, a few minutes):

```sh
mkdir WebKit && cd WebKit && git init -q
git remote add origin https://github.com/oven-sh/WebKit.git
git sparse-checkout init --cone && git sparse-checkout set Source/JavaScriptCore Source/WTF
git fetch --filter=blob:none --depth 1 origin 5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b
git checkout FETCH_HEAD && cd ..

bun run licenses --census ./WebKit javascriptcore-webkit \
  5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b Source/JavaScriptCore Source/WTF
bun run licenses --census ./tinycc tinycc 12882eee073cfe5c7621bcfadf679e1372d4537b .
bun run licenses          # re-render THIRD-PARTY.md and src/generated/licenses.ts
git diff                  # a clean diff means the census reproduced
```

The classifier is crude on purpose and its limits are printed wherever its numbers are: it matches
each header against the licences' distinctive wording, in the first 8 KiB only, and it cannot tell
you which files are compiled into the artifact. It is a census, not an opinion about any one file.

## Where the guards are

- `scripts/license-gate.ts` — seven checks, two of them reading the compiled binary's bytes rather
  than the module graph. It fails the build if a licence text the documents claim to ship is not in
  the artifact, if an LGPL library is unpinned or pinned under another library's name, if the Bun
  that is building is not the Bun the revisions were read out of, or if this file and
  `vendor/pins.json` stop naming the same revisions. MEASURED on 2026-08-17, it reports **10
  findings** when pointed at `~/.bun/bin/bun` — a real 60.2 MiB artifact of the same shape that
  carries none of this attribution — and **0** against `dist/brigadier`.
- `test/licenses.test.ts` and `test/relink.test.ts` — the negative controls. Every check is driven
  in both directions, because a guard that always passes looks exactly like a working one.
- `bar/items/10-the-artifact-ships.ts` — the same claims, asserted from outside, against a
  downloaded artifact with no repository beside it.
