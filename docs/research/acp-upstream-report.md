# Draft bug report — `claude-agent-acp` drops every session's `rate_limit_event`

**Status: DRAFT. NOT FILED. Nobody has opened this issue.** Upstream was searched on 2026-09-05 and
**nothing matching was found** — see "Is this already known upstream?" at the end of this file. Read
that section before filing: it names the three closed PRs a maintainer would reach for first. It is written to be pasted into
`https://github.com/agentclientprotocol/claude-agent-acp/issues` as-is. **The owner decides whether
it gets filed**; nothing here has been sent anywhere.

**Second thing to state plainly:** the frame-ordering evidence below is read from **recorded
fixtures and from the shipped JavaScript**, not from a live ACP session. Running a live turn costs
money, and **no turn was run**. Everything is a static read.

Package read: `@agentclientprotocol/claude-agent-acp@0.75.0`, Apache-2.0, authored by **Zed
Industries** (not Anthropic), at
`~/.npm/_npx/fa723bcb10ae372a/node_modules/@agentclientprotocol/claude-agent-acp`, installed
2026-09-05. **[measured]** Line numbers below are `dist/acp-agent.js` in that build; there is no
`acp-agent.js.map`, so the corresponding TypeScript source paths were not resolved. **[measured]**

Version note for the reviewer: this repo's earlier brief cited `:4264` / `:1819` / `:2740` / `:3865`
/ `:4014`, and all five match 0.75.0 exactly. Only the reset line differs — it is **`:1975`**, not
`:1974` (`:1974` is the `const resetTurnScratch = () => {` line above it). **[measured]** A copy of
**0.74.0** is also on this disk and has the same defect at `:3878`–`:3886`. **[measured]**

Background for anyone reading this repo rather than the issue tracker:
`docs/research/acp.md:165-201` is where this was first found, and `docs/research/acp.md:577` is the
recommendation that asked for this draft.

---

## The report, ready to paste

### Summary

`rate_limit_event` is forwarded to the client only when a top-level `assistant` message has already
been seen in the current turn, but the CLI emits `rate_limit_event` near the *start* of a session —
before that assistant message — so the rate-limit signal is silently discarded in almost every
session.

### Observed behaviour

`dist/acp-agent.js:4264-4276` (v0.75.0) forwards the CLI's `rate_limit_info` to the client under a
vendor `_meta` key, but only behind a null guard:

```js
case "rate_limit_event": {
    if (lastAssistantTotalUsage !== null) {
        await sendUpdate({
            sessionId: message.session_id,
            update: {
                sessionUpdate: "usage_update",
                used: lastAssistantTotalUsage,
                size: session.contextWindowSize,
                _meta: { "_claude/rateLimit": message.rate_limit_info },
            },
        });
    }
    break;
}
```

`lastAssistantTotalUsage` is a per-turn scratch local of the consumer loop:

- declared `null` at `:1819`;
- reset to `null` by `resetTurnScratch()` (`:1975`, called at `:2041` when a turn ends);
- assigned in exactly three places, all of which require the model to have produced something —
  `:2740` after a compaction boundary, `:3865` from a streaming usage delta, and `:4014` on a
  top-level `assistant` message.

So at the moment a session's `rate_limit_event` arrives, `lastAssistantTotalUsage` is still `null`
and the branch does not run. Nothing else in the file forwards `rate_limit_info`; a `grep` for
`rate_limit_info` returns exactly the one occurrence at `:4272`.

### Evidence that the ordering is the common case, not the rare one

Frame census over 27 recorded `claude` stream-json transcripts captured from CLI 2.1.x
(`crates/claude-spike/fixtures/`), counting 1-based frame positions:

| | |
|---|---|
| transcripts containing at least one `rate_limit_event` | **27 of 27** |
| `rate_limit_event` frames in total | **28** |
| frames arriving **before** the transcript's first top-level `assistant` frame | **26 of 28** |
| position of those 26 | frames **2–5** (the CLI emits it right around `system/init`) |
| the 2 exceptions | one transcript emits it at frame 8 after `assistant` at 6; one emits two events, at 3 and at 8 |

In the 26 cases, the guard is `null` and the event is dropped. Neither of the two exceptions is a
fresh-session first event: both sit immediately before the final `result`.

### Why it matters to a client

A subscription-aware client wants exactly the payload this branch is carrying:
`rate_limit_info` is where `unifiedWindows` lives — the five-hour and weekly usage windows a client
needs in order to back off before it exhausts the user's own quota. ACP has no first-class variant
for account-level rate limits, so `_meta["_claude/rateLimit"]` is the only channel there is, and it
never fires. Because the guard also makes the drop silent, the client cannot distinguish "the CLI
sent no rate-limit information" from "the adapter threw it away".

### Smallest fix

Do not gate the rate-limit forward on turn-local token accounting; the two are unrelated. `used` is
required by `UsageUpdate` (`@agentclientprotocol/sdk`, `used: number`), so give it a fallback rather
than skipping the whole update:

```js
case "rate_limit_event": {
    await sendUpdate({
        sessionId: message.session_id,
        update: {
            sessionUpdate: "usage_update",
            used: lastAssistantTotalUsage ?? session.contextUsedTokens ?? 0,
            size: session.contextWindowSize,
            _meta: { "_claude/rateLimit": message.rate_limit_info },
        },
    });
    break;
}
```

That is a three-line change: delete the `if`, and give `used` a fallback. The cost is that a
session-start event now reports `used: 0` before any token count exists, which is accurate — no
context has been consumed yet — and is strictly better than dropping the window data. If reporting
`0` is unacceptable, the alternative is to emit the rate-limit `_meta` on a notification that does
not carry a token count, but that is a larger change and needs a spec decision.

---

## Notes that stay in this repo (not part of the pasted report)

- **Severity wording.** This repo's earlier brief said the signal is dropped "every time". The
  honest version, from the census above, is **26 of 28 recorded frames**, and **every recorded
  session-start event**. The report above uses the accurate form.
- **A correction to `docs/research/acp.md`, now applied.** `docs/research/acp.md:185` and
  `:194-195` used to state `rate_limit_event` arrives before the first `assistant` frame in **15 of 15**
  recorded sessions, exactly one per session. Re-running the census against the same glob
  (`crates/claude-spike/fixtures/*.ndjson`) confirms 15 transcripts with exactly one event each, but
  in **`s5-resume.ndjson` the event is at frame 8 and the first `assistant` is at frame 6** — after,
  not before. The correct figure for that glob is **14 of 15**. **[measured, 2026-09-05]**
  `acp.md` also does not count `crates/claude-spike/fixtures/spawn-split/`, which adds 12 more
  transcripts and 13 more events, one of which (`spawn-split/off-4.ndjson`) carries **two** events —
  so "exactly 1 per session" is not universal either. **Fixed in `acp.md` on 2026-09-05**, with a
  visible correction note in place: the census there now reads 28 transcripts, 27 carrying events, 28
  events, 26 before the first `assistant` and 2 after. Those figures were re-derived independently
  before being written, and they matched this bullet exactly. **[measured]**
- **A client-side workaround may exist and was not verified.** `dist/acp-agent.js:2563-2564` and
  `:6284` show a per-session `emitRawSDKMessages` flag, set from
  `sessionMeta?.claudeCode?.emitRawSDKMessages`; when set, `:2565` sends raw SDK messages as an ACP
  extension notification named `_claude/sdkMessage` (an `extNotification`, not a `_meta` key). If `rate_limit_event` passes through that path it would reach a
  client regardless of this bug. **Not tested** — it needs a live session. Same open question as
  `docs/research/acp.md:629`.

## Not checked

- ~~**Whether this is already fixed, reported, or intentional upstream.**~~ Checked 2026-09-05; see
  the section below. Not fixed, not filed, and no maintainer statement that it is deliberate.
- **GitHub Discussions** on either repo, and **`zed-industries/zed`'s own tracker**. Neither was
  searched. Zed is the largest downstream client, so a user-visible symptom ("no usage meter until
  the model replies") could be filed there rather than against the adapter.
- **Which commit introduced the guarded block.** None of the three PRs that name `rate_limit_event`
  was merged, so it landed under a commit message that does not mention rate limits. `git blame`
  would need a clone; none was made.
- **A live ACP session.** None was run. No turn, no prompt, no spend.
- The TypeScript source. Only `dist/acp-agent.js` was read; without a `.js.map` the report cites
  build output, which an upstream maintainer may want translated to `src/`.
- Whether `session.contextUsedTokens` is ever populated before the first assistant frame on a
  resumed session — the three assignments found are all mid-turn, so the suggested fallback is
  expected to yield `0` at session start, but resume paths were not traced.
- Whether any ACP client actually reads `_meta["_claude/rateLimit"]` today. The claim that it
  "harms any subscription-aware client" is an inference from the payload's contents, not a survey of
  clients. **[asserted]**

---

## Is this already known upstream? Searched 2026-09-05 — **not found**

**Outcome: NOT FOUND.** No issue, PR, commit, release note or changelog entry describes the
session-start `rate_limit_event` being dropped by the `lastAssistantTotalUsage !== null` guard. The
draft above should therefore be filed as a **new issue**, not a comment on an existing one — but it
should cite the three closed PRs below, because a maintainer will reach for them first.

### The repository, identified from the package rather than guessed

`package.json` `repository.url` is `git+https://github.com/agentclientprotocol/claude-agent-acp.git`
and `bugs.url` is `https://github.com/agentclientprotocol/claude-agent-acp/issues`. **[measured]**
`python3 -c` over `~/.npm/_npx/fa723bcb10ae372a/.../claude-agent-acp/package.json`

`zed-industries/claude-code-acp` is **the same repository, renamed** — not a separate old tracker.
Both names resolve to repository id **1045440192**. **[measured]**
`gh api repos/zed-industries/claude-code-acp --jq .id` → `1045440192`, identical to
`gh api repos/agentclientprotocol/claude-agent-acp --jq .id`. Issue numbering is therefore continuous
and one tracker search covers the whole history.

### Version: 0.75.0 **is** the latest, and the guard is still in it

| | |
|---|---|
| npm `dist-tags.latest` | **0.75.0** — no version newer than the one on this disk **[measured]** |
| versions published | 69 |
| `0.75.0` published | **2026-09-05T08:56:11.799Z** — today **[measured]** |
| `0.74.0` published | 2026-09-04T11:11:03.220Z |
| `0.70.0` published | 2026-08-18T13:16:17Z |

**[measured]** `curl -sS https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp`, HTTP 200,
read for `dist-tags` and `time`. **[documented]** https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp, fetched 2026-09-05.

**The on-disk copy is the published tarball, byte-for-byte.** The registry's
`versions["0.75.0"].dist.integrity` is
`sha512-EPlnY5gJb0LRyKBNmFOjSGBaJj14JqQRzoYh6Ss9QWAj46w91Wv/Dm4jloboBmAiPBErn+Kxerw2BcS8cF8wOw==`
and `~/.npm/_npx/fa723bcb10ae372a/node_modules/.package-lock.json` records the same hash for the
installed package. **[measured]** So every `dist/acp-agent.js` line cited in this report is a line of
the published artifact, and no separate tarball download was needed to prove it.

**The guard is also on `main` today, in TypeScript, not just in the build output.** **[source]**
`src/acp-agent.ts:5866-5878` at commit `a0122dae4c6f0d19a6716561683607dac4f50215`:

```ts
          case "rate_limit_event": {
            if (lastAssistantTotalUsage !== null) {
```

**[documented]** https://github.com/agentclientprotocol/claude-agent-acp/blob/a0122dae4c6f0d19a6716561683607dac4f50215/src/acp-agent.ts#L5866-L5878, fetched 2026-09-05.
That commit is simultaneously `main`'s HEAD and 0.75.0's `gitHead` **[measured]**
(`gh api repos/.../commits/main --jq .sha` and the registry's `versions["0.75.0"].gitHead` are the
same string), so **there is no fix sitting unreleased on `main`**. In the whole 10,780-line source
file, `rate_limit` appears on exactly two lines — 5866 and 5874. **[measured]**
`grep -n 'rate_limit_event\|rate_limit_info\|rateLimit' src/acp-agent.ts`

**How long it has been there:** 0.70.0 (2026-08-18), 0.74.0 and 0.75.0 all carry the guard, at
`dist/acp-agent.js:3336`, `:3879` and `:4265` respectively. **[measured]**
`grep -n 'lastAssistantTotalUsage !== null'` over the three npx-cached copies. Nothing older than
0.70.0 was on disk and no older tarball was downloaded, so the introduction date is **unknown** —
at least 18 days, possibly much longer.

### Where I looked, and what each search returned

All against `repo:agentclientprotocol/claude-agent-acp`, `state=all`, via `gh api search/issues`
(read-only; no `gh auth switch`), 2026-09-05. **[measured]**

| query | hits | anything matching this bug? |
|---|---|---|
| `rate_limit_event` | 3 | no — PR #508, #532, #568, **all closed unmerged** |
| `rate limit` | 27 | no — 20 are dependency bumps |
| `rate_limit_info` | **0** | — |
| `rateLimit` | **0** | — |
| `"_claude/rateLimit"` | **0** | — |
| `unifiedWindows` | **0** | — |
| `lastAssistantTotalUsage` | 5 | no — #656, #596, PR #344, #457, #568 |
| `usage_update` | 33 | no |
| `quota` | 8 | no |
| `"five_hour"` | 1 | no — PR #915 |

Zero of the repository's releases mention the words rate limit, rateLimit or quota in their notes.
**[measured]** `gh api repos/.../releases --paginate --jq 'select(.body|test("rate.limit|rateLimit|quota";"i"))'` returned nothing.
`search/commits?q=repo:...+rate_limit_event` returned 4 commits, all SDK dependency bumps. **[measured]**

The **spec** repo was searched too, since a fix could live there instead:
`repo:agentclientprotocol/agent-client-protocol` returns **0** for `rate limit`, `rateLimit` and
`unifiedWindows`, and 2 for `quota` (#1860, #890 — both about `PromptResponse.usage` semantics).
**[measured]** This independently confirms `docs/research/acp.md`'s finding that ACP has no
account-level rate-limit concept: nobody has even filed for one.

### The four near-misses a maintainer will cite, and why none of them is this

- **PR #508, "Forward dropped SDK events to ACP clients"** — closed **unmerged**, 2026-04-13. It named
  `rate_limit_event` as one of four events the adapter ignores and proposed forwarding it as a
  `_claude/`-namespaced `extNotification`. Maintainer **benbrandt** closed it with *"Let's see if #527
  solves your issue and then we can revisit if not"*. **[documented]**
  https://github.com/agentclientprotocol/claude-agent-acp/pull/508, fetched 2026-09-05.
- **PR #527, "allow clients to opt into receiving raw SDK messages"** — **merged** 2026-04-13, shipped
  in 0.27.0. This is the `emitRawSDKMessages` escape hatch `docs/research/acp.md:41` already found.
  **It is the upstream answer of record to "you drop `rate_limit_event`"** — which matters for the
  draft: the likely first response is "use raw passthrough". The draft should say why an opt-in raw
  firehose is not a substitute for the typed `_meta` channel the adapter already implements.
  **[documented]** https://github.com/agentclientprotocol/claude-agent-acp/pull/527, fetched 2026-09-05.
- **PR #532, "Surface rate_limit_event quota metadata"** — closed **unmerged**, 2026-04-13, *"Closing in
  favor of #527"*. **[documented]** https://github.com/agentclientprotocol/claude-agent-acp/pull/532
- **PR #915, "feat: Add `_claude/usage` extension method for structured rate-limit usage"** — closed
  **unmerged** the same day it opened, 2026-07-25, **withdrawn by its own author**: *"turns out the
  stock adapter already covers our use case. `/usage` is a supported command that returns its report
  as a normal agent message"*. **[documented]**
  https://github.com/agentclientprotocol/claude-agent-acp/pull/915

None of the four describes the null guard dropping a session-start event. #508 and #532 predate or
sit beside the guarded block rather than reporting it.

### One direct precedent for the fix this draft proposes — and it was rejected

**PR #457, "fix: always send valid used value in usage_update notification"** — closed **unmerged**.
Its body names the guard by its exact text: *"Although guarded by `if (lastAssistantTotalUsage !==
null)`, the usage_update was simply skipped"*. **[measured]** `gh api repos/.../pulls/457 --jq .body`,
grepped. It proposed the same `used: 0` fallback this draft's "Smallest fix" proposes — but at the
**other** guard site (`dist/acp-agent.js:3464`, the result path, not `:4265`, the rate-limit path) and
for a different symptom (open issue **#375**, `used=null` rejected as `Invalid params`). Maintainer
**SteffenDE** closed it as an upstream SDK problem rather than an adapter one.

**This is the strongest reason to file carefully.** A `used: 0` fallback has already been argued and
declined once in this repository. The draft above should distinguish itself explicitly: it is not
about schema validity of `used`, it is about a *different payload* — `_meta["_claude/rateLimit"]` —
being discarded as collateral of a guard that only exists to protect `used`. **[asserted]**
The two guard sites are still both present in 0.75.0 **[measured]**, so #457's stated fix is not
running today either.

**[documented]** https://github.com/agentclientprotocol/claude-agent-acp/pull/457 and
https://github.com/agentclientprotocol/claude-agent-acp/issues/564, fetched 2026-09-05.

### The adjacent open feature request

**Issue #625, "Show Claude usage limits in the Agent Panel"** — **open** since 2026-05-03, a request
for Zed to display the five-hour and weekly windows. It asks for the same data this bug withholds but
does not mention the adapter's existing `rate_limit_event` path or the guard. Maintainer benbrandt,
2026-07-02: *"Pretty sure it is behind an api called
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` 😄 so I think we will wait"* — i.e. the
maintainers currently believe the data is not reliably available, which the guarded block at `:5866`
contradicts. **A cross-link from the new issue to #625 is worth including.** **[documented]**
https://github.com/agentclientprotocol/claude-agent-acp/issues/625, fetched 2026-09-05

### Not checked in this upstream pass

- **GitHub Discussions** on either repository. Not searched.
- **`zed-industries/zed`'s own tracker.** Not searched; the symptom could be filed downstream.
- **The commit that introduced the guard.** No clone, no `git blame`.
- **npm versions below 0.70.0.** No older tarball was downloaded, so "at least 18 days" is a floor,
  not the age.
- **Full bodies of every closed issue.** Bodies were read for #625, #532, #915, #457, #564 only.
  GitHub's search does index issue bodies and the exact-term queries above returned zero, so a report
  using those identifiers would have surfaced — but one phrased purely in symptoms ("no usage meter
  at startup") could have been missed. **[asserted]**
- **Whether a live ACP session confirms the drop.** Still not run. No turn, no spend.
