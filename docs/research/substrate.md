> **Status (2026-09-02): the Electron recommendation below is OVERRIDDEN.** The owner rejected
> Electron after reading this file, on performance and minimalism grounds. The decision is
> Tauri v2 + Rust core + Node sidecar (see `CLAUDE.md`, "Settled decisions"). The measurements
> and the substrate-independent findings still stand: the renderer is the bottleneck, not the
> engine; coalesce to one UI update per animation frame; virtualize the feed; never render
> markdown per token. Only the final recommendation is dead. Do not reopen it.

# Performance substrate — which shell, and where the cost actually is

## Bottom line
**Electron. React+TS renderer, agent supervision in a `utilityProcess`, `MessagePort` between them,
SQLite for transcripts, virtualized terse feed, rAF coalescing.**
The engine is not the bottleneck. The renderer is. No framework choice fixes the renderer.

## Measured on this machine (Node 24.18.0, darwin 25.5.0, Apple Silicon)
Bench scripts were written to the session scratchpad (ephemeral).

| Case | Result |
|---|---|
| 1 child -> NDJSON over stdout, 200k SDK-shaped events, parsed | **1,474,332 msg/s**, 0.36 us CPU/msg |
| 10 concurrent children, 2M events | **2,683,759 msg/s**, 0.34 us/msg, parent RSS **129 MB** |
| Unix-domain-socket hop, 200k events, both ends | 1,756,800 msg/s, 0.65 us/msg |
| Idle Node process RSS | 43.4 MB |

10 agents at 1,000 events/s each = 10k msg/s = **0.34% of one core**. Spawning, reading, parsing and
persisting the streams is a rounding error.

## Framework numbers (measured by others, N small — indicative)

| | Electron | Tauri v2 | ratatui | Swift/AppKit |
|---|---|---|---|---|
| Binary/installer | 244 MiB | 8.6 MiB (+30-50 MB with a Node sidecar) | ~5-15 MB (asserted) | ~5-20 MB (asserted) |
| RAM, 6 windows | 409 MB | 172 MB | <20 MB (asserted) | unverified |
| Startup | "negligible difference, both under ~500 ms" | same | instant | instant |
| Build (cold) | 15.8 s | 80.9 s | — | — |

Source for cols 1-2: gethopp "Tauri vs Electron", explicitly N=1 on one MacBook Pro. Their own
conclusion: startup was NOT a differentiator.

**RAM under 10 streams is not a framework property.** Ten Claude Code children are 10 x ~150-400 MB
of someone else's Node processes regardless of your shell. Your UI's 200 MB delta is ~10% of total.
"Tauri = the low-memory choice" is misleading here; you cannot get under a gigabyte either way.

## Where the cost lands
### Electron IPC, measured (ZacWalk/electron-bench; Electron 43.2.0, 10,000 msgs, 333-byte payload)

| Path | p50 | p99 | main CPU/10k | per msg |
|---|---|---|---|---|
| `ipcRenderer.invoke` | 0.4 ms | 1.6 ms | 1672 ms | **167 us** |
| `ipcRenderer.send` | 0.7 ms | 2.5 ms | 1062 ms | 106 us |
| `MessagePort` direct | 0.5 ms | 1.0 ms | 375 ms | 37 us |
| **`utilityProcess` via `MessagePort`** | 0.5 ms | 1.0 ms | **140 ms** | **14 us** |
| `iframe.postMessage` | 0.6 ms | 1.1 ms | 62 ms | 6 us |

JSON via MessagePort: 1 KB -> 0.2 ms p50; 64 KB -> 1.5 ms; 1 MB -> 21.5 ms.
At 10k msg/s: naive `invoke` = **167% of a core (broken)**; `utilityProcess`+`MessagePort` = 14% of a
core (fine). **The IPC path you pick inside Electron matters more than Electron-vs-Tauri.**
Blink's postMessage yields after 200 messages or 50 ms, so a flood self-throttles.

### Tauri IPC: genuinely unresolved
No published per-small-message benchmark exists. What exists: a 10 MB round-trip at ~5 ms on macOS
but ~200 ms on Windows, with maintainer FabianLars replying "that 100% used to be better so idk
what's going on there". Maintainer on the ceiling: v2's serialization-free IPC "still uses the fetch
api (without actually hitting the network) so there's a bit of a delay… i believe that we can't
improve it much further." Tauri's docs steer high-throughput streams to **Channels**, not events.
**Picking Tauri for IPC speed at 10k small msgs/s is picking on faith.**

### The real wall: DOM
Appending per token means ~50 layouts/sec on one message, "catastrophic when the message is in a
virtualized list since every layout invalidates the list's height calculations". LibreChat's
markdown-memoization PR (#13576) reports long replies cost **14x more CPU** in the markdown splitter
before the fix. Rendering markdown per token re-parses and re-highlights the whole message every
token. Identical cost in Electron and Tauri — same DOM. Worse on Linux WebKitGTK.

## Mitigations, ranked
1. **Coalesce per animation frame.** 10,000 events/s -> 60 UI updates/s = ~167x fewer IPC crossings
   and renders. Biggest lever; makes framework IPC differences irrelevant.
2. **Virtualize the feed.** web.dev/react-window: DOM nodes from tens of thousands to ~15, render
   "from seconds down to a few milliseconds". Fixed-height terse rows make this easy — an argument
   for keeping the feed terse.
3. **Never render markdown per token.** Memoize completed blocks on their raw source slice; only the
   growing tail re-parses.
4. **Parse off the UI thread.** Buys little (0.34 us/msg); do it to isolate malformed-JSON stalls.
5. **Backpressure.** Cap in-memory scrollback (Crystal caps 50,000 lines/panel), drop deltas for
   non-visible panels, persist to SQLite not React state.

1 and 2 together are worth more than every framework difference combined.

## Hybrid: headless engine + thin UI
Shipped in this exact domain: **OpenAI Codex `app-server`** — long-lived Rust process, JSON-RPC 2.0
as NDJSON over stdio, "the server is the single source of truth and all interfaces are thin
clients"; the TUI is "a thin rendering layer". **Ollama desktop** — Go engine + React frontend.
Unix socket preferred over localhost HTTP (smaller local security surface); setup ~0.1 ms.
Cost is operational, not performance (measured: 1.76M msg/s over the socket): process lifecycle and
orphan cleanup, a versioned protocol you own both ends of, doubled crash/reconnect handling, two log
surfaces, two binaries to sign. Worth it if you want a CLI/TUI/web client later.
**Electron's `utilityProcess` gives the same process isolation with none of that cost.**

## Tauri v2 + Node sidecar: viable, and the cheapest path to a bad week
Official guide exists (`v2.tauri.app/learn/sidecar-nodejs`) and following it verbatim fails with
`Missing script: pkg` (tauri-docs#3442); `pkg`-built Node binaries fail to invoke as sidecars
(tauri#8564). Sidecars must be self-contained single binaries — native `.node` addons
(`node-pty`, `better-sqlite3`) in a pkg/SEA bundle are the classic failure point (**unverified for
these exact deps — test day one if you go this way**). Size: Node sidecar via pkg measured 28 MB
(.deb) vs 7 MB pure Rust; Node SEA baseline ~46-50 MB — so 8.6 MiB becomes ~35-60 MB.
Plus Linux WebKitGTK: tauri#7021, wry#1315, and "webkit2gtk slows to a crawl when there are a lot of
DOM elements" — with virtual scrollers reported as the fix. That is precisely your UI.
Net: **Electron's runtime cost, plus a Rust layer, plus a packaging problem, minus Chromium's
consistency.** You run Node either way — the Agent SDK is npm-only.

## Prior art
- **Crystal/Nimbalyst** — Electron, React 19, node-pty, git worktrees, better-sqlite3, xterm.js,
  per-panel 50k scrollback. Your exact feature set, shipping today.
- **Conductor** (Melty Labs, YC S24) — native macOS SwiftUI. Beautiful, macOS-only, not a
  weeks-long rewrite; SwiftUI `List` is documented as unusable at 10k-30k rows, pushing you to
  AppKit `NSTableView`.
- ratatui — great engine-side story, dead end for "performance as a selling point" to non-terminal
  users.

## The one risk, and the non-negotiable mitigation
**Risk: renderer CPU from per-token React/markdown re-render makes a 400 MB Electron app FEEL slow
no matter how fast the engine is — and users blame Electron.**
Week one, mandatory: engine emits to the renderer at most once per animation frame per project
(coalesced batches, never per-token); the feed is a virtualized list of fixed-height terse rows;
completed blocks memoized on their raw slice; non-visible projects drop to counters-only; scrollback
in SQLite with a hard in-memory cap. Instrument FPS during a 10-agent burn and treat a drop below 60
as a build-breaking regression. That is also the number for the landing page.

## Not checked
No Windows or Linux measurements (all local numbers macOS/Apple Silicon). No first-hand Electron,
Tauri or Swift app built or profiled. No published Tauri benchmark for many small messages exists,
so Electron-vs-Tauri IPC at this message rate is unresolved, not settled. ratatui and Swift memory
figures are blog assertions. node-pty/better-sqlite3 inside a Tauri sidecar bundle untested.
