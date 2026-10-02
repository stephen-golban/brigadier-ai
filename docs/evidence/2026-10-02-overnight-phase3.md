# Overnight mode · Phase 3 verification evidence (2026-10-02/03)

Step 7 of PLAN.md §10.12: the fresh verifier's review triage, the §10.14 live runs and the §10.15
A/B against the /delegator skill. The artifacts stay outside the repo, under
`~/.claude/delegator/runs/20261002-1329-overnight-mode/workers/` (`w09`, `w10`, `w11`, each
with an `evidence/` folder). Paths below are relative to that folder.

Every live run used a bundled debug app with its own identifier (`ai.brigadier.overnighttest*`),
an isolated `BRIGADIER_DATA_DIR` and throwaway clones in `/tmp/brigadier-overnight-w09/`. The
plan was a small frozen 3-phase `PLAN.md` (sha256 `43a6a0dc…`, `w11/evidence/frozen-PLAN.md`)
with a seeded parse bug and a user-only account ID. The installed app, its daemon and its data
were never touched.

## Review triage

The whole-branch Codex review (`dlg review code --base c2d2756`) had 8 findings, R1–R8. All
were valid and all were fixed; none was rejected. The live runs then found L1–L15; all but L9
and L15 (minor) are fixed. Table: `w11/evidence/review-triage.md`.

## Live acceptance (§10.14)

| Row | Result | Evidence |
|---|---|---|
| Plan input and Start | pass | `w09/evidence/ui-0*`: `/overnight`, plain words, file reference, bare goal (Phase 0) and a normal plan staying normal |
| Main run (60 min, max 2, stop after phase 2) | pass | `w10/evidence/main/`, re-run on final code in `w11/evidence/ab-brigadier3/` |
| Seeded defect caught and fixed | pass | Phase 2 plan review (Codex) or lead found `parse_amount` 1.5 → 105; total 14.35 → 15.25 (`*/evaluation.txt`) |
| Independent block → exact Waiting | pass | One ask for p2-c2; the account ID was never invented (`ab-brigadier*/report-message.md`) |
| Native notification as Brigadier, click opens the session | pass | `w11/evidence/ab-brigadier/05-07*.png`, `w10/evidence/main/05-07*` |
| Short run: dependent block, "stopped early" notification | pass | `w10/evidence/short/04*`, `short2/` |
| Answer + Continue on the same branch | pass | `w10/evidence/short2/`, `w11/evidence/short3/` (phase 2 verified once the user's words reached the checkers) |
| Stop once | pass | `w11/evidence/short3/02*`–`03*`: winding down → report "stopped by you" in about 40 s |
| Merge the verified SHA with later partial commits kept | pass | `w11/evidence/merge-partial/`: main = `a38794c`, run branch keeps 2 unverified commits; Continue still offered |
| Survival: SIGKILL with the app quit, supervised restart, injected gap | pass | `w10/evidence/survival/`: standby took over, gap "22:53–22:56" recorded, no duplicate commit |
| Run cap | pass | `ab-brigadier/timeline.txt`: at most 2 run tasks at once; a third waited for a slot |
| No new settings | pass | `Settings` and settings UI unchanged against `c2d2756` |

A real lid close is left for the user to check in the morning (§10.14).

## A/B against /delegator (§10.15)

Same frozen plan bytes, brief ("Work through PLAN.md phases 1-3 for 60 minutes, max 2 workers,
stop after phase 2."), base `317f849` and clone setup, run sequentially. /delegator ran in its own
cmux tab, run `~/.claude/delegator/runs/20261002-2345-tinyledger-p1-2`.

| | Brigadier (final, 7176dc5) | /delegator |
|---|---|---|
| p1-c1, p1-c2 | met (verified tip `003b11a`) | met |
| p2-c1, p2-c3 | met | met |
| p2-c2 (user-only) | Waiting, not invented | Waiting, not invented |
| Seeded defect | caught and fixed | caught and fixed |
| Phase 3 | not started | not started |
| Where the work went | own run branch; `main` untouched | committed on `main` |
| Checks | per-task review and verify by another vendor; phase verifier, two reviewers and a judge | per-phase Opus verifier and one Codex review |
| Start → report | 14.2 min (+0.9 min proposal) | ~7.5 min |
| Claude tokens (incl. cache) | 1.44M, 28k output | 2.29M, 35k output |
| Codex tokens (incl. cache) | 1.63M, 22k output | 0.12M, 1.2k output |

Sources: `ab-brigadier3/usage.txt` (`turn_usage`, `quota_samples`) and `ab-delegator/usage.txt`
(transcripts deduplicated by message id; Codex rollouts' last cumulative counts).

**Verdict.** Brigadier is at parity or better on criteria met, defect detection, safety (its own
branch) and reporting. It uses fewer Claude tokens. It is not at parity on wall time (about 2×)
or Codex tokens (about 13×). Two avoidable costs were found and fixed, then re-measured:
same-file parallel tasks that needed a merge task (dc706ee), and a fix round for a user-only
criterion (7176dc5). Together they brought the run from 16.9 to 14.2 minutes. The rest of the
gap comes from the checks G4/G13 require, and from the router picking Codex implementers. It
stays an explained regression for the user to accept or rescope.
