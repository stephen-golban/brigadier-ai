# Local macOS app update — 2026-09-11

Read-only packaging research for the approved startup-loader update. No app replacement or source change was performed by this research task.

## Verified facts

- Installed `tauri-cli 2.11.4` accepts `build --bundles app` and builds in release mode, running `build.beforeBuildCommand` first. This repository sets that command to `npm run build`, which runs TypeScript and Vite, and uses `../dist` as frontend output. Sources: local `node_modules/.bin/tauri build --help`, [configuration](/Users/stephen/Development/brigadier-ai/src-tauri/tauri.conf.json), [package scripts](/Users/stephen/Development/brigadier-ai/package.json), [Tauri distribution guide](https://v2.tauri.app/distribute/).
- Tauri accepts the ad-hoc signing identity `-` through `APPLE_SIGNING_IDENTITY` or `bundle.macOS.signingIdentity`. This provides signing without an Apple-authenticated identity; it does not imply notarization or universal Gatekeeper acceptance. [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).
- `codesign --force --deep --sign -` would recursively replace signatures, but the installed macOS `codesign(1)` marks `--deep` deprecated for signing since macOS 13. Apple recommends signing nested code from the inside out and reserves deep signing for temporary repairs. Prefer Tauri-managed signing. `codesign --verify --deep --strict --verbose=2` is appropriate for recursively checking the final bundle. Sources: local `man codesign`; [Apple signing guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).
- `ditto` preserves resource forks and metadata by default, but merges into an existing destination directory. Therefore copying directly over an old app can retain stale contents. Sources: local Apple `man ditto`, DESCRIPTION. Recommendation inferred from that behavior: copy to a fresh staging path, verify it, move the old app to a backup, then move the staged app to the installed location.
- At inspection, `/Applications/Brigadier.app` existed and `codesign -dvv` showed a linker-generated ad-hoc executable signature with no sealed resources. The build output existed at `target/release/bundle/macos/Brigadier.app` and contained one executable, its plist, icon, and resource signature. These are observations of existing artifacts, not validation of the forthcoming build.

## Practical procedure

1. Build the approved source revision with `APPLE_SIGNING_IDENTITY=- npm run tauri -- build --bundles app`. Confirm the CLI's reported output path; this repository currently uses `target/release/bundle/macos/Brigadier.app`.
2. Run `codesign --verify --deep --strict --verbose=2` against that bundle. If signing was not applied, this inspected single-executable bundle can be signed with `codesign --force --sign -` and checked again; use explicit inside-out signing if nested code is added.
3. Use `ditto` to copy the new bundle to a unique, absent staging path in `/Applications`; verify the staged signature before replacing the current installation.
4. Quit Brigadier gracefully through the available CUA native-app interface. Preserve `/Applications/Brigadier.app` at a unique backup path, then rename the verified staged bundle to `/Applications/Brigadier.app`. Restore the backup if replacement fails. This changes the app bundle only, not app data.
5. Verify the installed bundle signature and compare its executable hash with the built artifact. Relaunch and inspect the app through CUA, following the tool's exposed app API rather than AppleScript. CUA operation details must be read from its runtime documentation by the executing agent.

Keep unrelated working-tree edits out of the loader commit. The install should be built from the intended source state, and a local research note is not evidence that any build, signing, replacement, or launch check has passed.
