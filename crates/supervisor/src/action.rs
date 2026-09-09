//! The action a lead child returns, the report a worker child returns, and the five gates that
//! decide whether either may be executed.
//!
//! **Pure.** Nothing here spawns a process, touches the store or shells out to git; the only I/O
//! is the `stat` and `readlink` that gate 4 needs to answer *does this path resolve inside the
//! project root*.
//!
//! The action set is **closed and read strictly** — the exact opposite of the store's
//! `from_slug_lossy` convention. The difference is deliberate: an unrecognised *stored* value
//! must degrade safely because the row already exists and refusing it loses history, while an
//! unrecognised *action* must never be executed, because executing it is how a hallucination
//! becomes a commit.
//!
//! The five gates, cheapest first
//! (`docs/research/orchestration-loop.md` §2.4):
//!
//! 1. **Exactly one** fenced `json` block in the child's final text. Zero or two is
//!    malformed, and a child that ends in prose with no block at all is malformed #1, not a
//!    special case.
//! 2. It parses as JSON and `action` is in the closed set.
//! 3. It is schema-valid for that action. **Unknown fields are an error, not ignored.**
//! 4. It survives semantic validation against the world — [`validate`]. This is the half that
//!    catches hallucination and the half that is easy to omit.
//! 5. Reserve. Not here: a `dispatch` that would take utilization past the owner's line is not
//!    malformed, it **parks**, and parking is the loop's business, not the parser's.
//!
//! **An overlapping partition is refused, never repaired.** A harness that reassigns files is
//! making a plan decision with neither a model nor the owner behind it. [`ActionError`]'s message
//! for that case names which two orders collide on which paths, because that sentence goes
//! verbatim into the retry's prompt.
// see docs/research/orchestration-loop.md §§2.3, 2.4, 3.1, 4.1 for the design, and
// docs/plans/w1b-loop-order.md §1 D1 and D2 for the `plan` action, which the design does not have.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Small jobs can use one phase; larger jobs may decompose further.
pub const MIN_PHASES: usize = 1;
/// Most phases a plan may have. **asserted**, a bound on scope rather than a measurement
/// (`docs/plans/w1b-loop-order.md` §1 D1).
pub const MAX_PHASES: usize = 8;
/// Most unknowns a planner may list. Unbounded caller text is a growth path, not a feature.
pub const MAX_UNKNOWNS: usize = 12;
/// Most work orders one `dispatch` may carry. The concurrency cap bites long before this; the
/// bound exists so a runaway payload is refused rather than allocated.
pub const MAX_ORDERS: usize = 16;
/// Most paths one order may declare ownership of.
pub const MAX_OWNED_PATHS: usize = 64;
/// Longest a worker's report summary may be, in characters.
pub const MAX_SUMMARY_CHARS: usize = 400;
/// Longest any short free-text field — a title, a question, a reason — may be, in characters.
pub const MAX_TEXT_CHARS: usize = 1_000;
/// Longest an order's instructions may be, in characters. Generous: this is the work order.
pub const MAX_INSTRUCTIONS_CHARS: usize = 20_000;

/// The closed action set. Anything outside it is [`ActionError::UnknownAction`].
pub const ACTION_SLUGS: &[&str] = &[
    "plan",
    "dispatch",
    "review",
    "verify",
    "merge",
    "replan",
    "ask_owner",
];

// ---------------------------------------------------------------------------------------------
// The action set
// ---------------------------------------------------------------------------------------------

/// One decision a lead or planner child returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// Turn a goal into phases. **Not in `docs/research/orchestration-loop.md`** — it starts from
    /// a plan already existing — and required by `docs/vision.md` §4 step 6, which is why it is
    /// the lead's decision D1 in `docs/plans/w1b-loop-order.md` §1.
    Plan(PlanAction),
    /// Partition work across fresh worker children.
    Dispatch(DispatchAction),
    /// One adversarial child over the collected diffs.
    Review(ReviewAction),
    /// Run the phase's **stored** verify command.
    Verify(VerifyAction),
    /// Merge the phase's order branches into the integration branch.
    Merge(MergeAction),
    /// Change the plan: add, edit or drop phases, each with a reason.
    Replan(ReplanAction),
    /// Stop and put a real question to the owner.
    AskOwner(AskOwnerAction),
}

impl Action {
    /// The slug this action arrived as. Stable, and the same string the closed set holds.
    #[must_use]
    pub fn slug(&self) -> &'static str {
        match self {
            Self::Plan(_) => "plan",
            Self::Dispatch(_) => "dispatch",
            Self::Review(_) => "review",
            Self::Verify(_) => "verify",
            Self::Merge(_) => "merge",
            Self::Replan(_) => "replan",
            Self::AskOwner(_) => "ask_owner",
        }
    }
}

/// A phase as a planner proposed it. Not yet a `PhaseRow`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedPhase {
    /// One line, shown on the plan card.
    pub title: String,
    /// What has to be true for the phase to be finished. Prose, for the worker and the owner.
    pub definition_of_done: String,
    /// The command whose **exit code** settles the phase.
    ///
    /// Required and non-empty. `PhaseRow::verify_command` is an `Option` precisely so the loop
    /// can *see* a phase that cannot go green through a gate rather than fabricate a command for
    /// it — but a planner that returns none has not produced a plan this loop can run, and that
    /// is a validation failure rather than a phase (`docs/plans/w1b-loop-order.md` §1 D1).
    pub verify_command: String,
}

/// Which bin an unknown goes in. A **closed** set, read strictly.
///
/// Mirrors `brigadier_store::plan::UnknownBin`, whose `from_slug_lossy` falls back to `Owner`.
/// The two readings differ on purpose: a stored slug is read lossily because the row already
/// exists and the restrictive fallback is the safe one, while an action's slug is read strictly
/// because an unrecognised action must never be executed. Routing a question to the owner costs
/// a prompt; routing it to a research subagent by mistake costs a model window and an answer
/// nobody asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownBin {
    /// Only the owner can answer it.
    Owner,
    /// The internet can answer it: a research subagent, findings to a file.
    Research,
}

impl UnknownBin {
    /// The slug written to `unknowns.bin`.
    #[must_use]
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Research => "research",
        }
    }
}

/// Something the planner does not know, and who could answer it.
///
/// With the owner away and *"just go"* the only answer available, each of these is written to
/// `unknowns` with `state = skipped` and `skipped_for_just_go = true`, so that when a phase later
/// fails on a question that was waved off the thread can say **which one**
/// (`docs/vision.md` §4 step 5, `docs/plans/w1b-loop-order.md` §1 D2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlannedUnknown {
    /// The question, as the planner would put it to whoever can answer.
    pub question: String,
    /// Who can answer it.
    pub bin: UnknownBin,
}

/// `{"action":"plan", …}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanAction {
    /// Between [`MIN_PHASES`] and [`MAX_PHASES`] phases, in order.
    pub phases: Vec<PlannedPhase>,
    /// What the planner does not know. **Optional, defaulting to empty**: a goal with no genuine
    /// unknowns is a real answer, not a malformed one, and a typo fix should produce none.
    #[serde(default)]
    pub unknowns: Vec<PlannedUnknown>,
}

/// Which model a work order is worth. A closed set, read strictly.
///
/// # The order is the contract
///
/// The tiers are **ordered**, `Haiku < Sonnet < Opus`, and that ordering is what every word like
/// *exceeds*, *mid-tier* and *capped* means in
/// [`Ceiling`](crate::loop_::routing::Ceiling), which is the only thing that decides what a child
/// is started on. The order is given explicitly by [`ModelTier::rank`] and **never by declaration
/// order**: the variants are declared strongest-first because that is how `docs/vision.md` §6
/// reads them out, so a derived `Ord` would say the exact reverse of every clamp that depends on
/// it. Adding a tier means giving it a rank, not placing a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    /// Judgement, design, multi-file reasoning.
    Opus,
    /// A well-specified mechanical edit with a fixed recipe.
    Sonnet,
    /// Lookups, greps, single-file transcription.
    Haiku,
}

impl ModelTier {
    /// Every tier, **weakest first**, which is [`ModelTier::rank`] order.
    pub const ALL: [Self; 3] = [Self::Haiku, Self::Sonnet, Self::Opus];

    /// The strongest tier. Nothing a planner can ask for exceeds it.
    pub const STRONGEST: Self = Self::Opus;

    /// The tier a work order is capped at when the owner picked no model: `docs/vision.md` §6's
    /// *"judgement (lead, grill, review, judge) gets the strong model; work orders get mid-tier"*.
    pub const MID: Self = Self::Sonnet;

    /// The weakest tier, and the ceiling an **unrecognised** model id binds at.
    pub const WEAKEST: Self = Self::Haiku;

    /// Where this tier sits in the order. Higher is stronger, and this function *is* the ordering.
    #[must_use]
    pub fn rank(self) -> u8 {
        match self {
            Self::Haiku => 0,
            Self::Sonnet => 1,
            Self::Opus => 2,
        }
    }

    /// The slug this tier arrived as.
    #[must_use]
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Opus => "opus",
            Self::Sonnet => "sonnet",
            Self::Haiku => "haiku",
        }
    }

    /// The tier a slug names, or `None`. The inverse of [`ModelTier::as_slug`].
    #[must_use]
    pub fn from_slug(slug: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tier| tier.as_slug() == slug)
    }

    /// Which tier a **model id** belongs to, or `None` when this build does not recognise it.
    ///
    /// This is the crux of treating the owner's pick as a ceiling: the pick is an *id*
    /// (`claude-haiku-4-5`, or the CLI's own alias `opus[1m]`) while an order carries a *tier*,
    /// and the two have to be comparable before anything can be clamped.
    ///
    /// The id is lowercased, anything from a `[` on is dropped (`opus[1m]` and `sonnet[1m]` are
    /// the CLI's own aliases and the bracket carries a context window, not a family), a leading
    /// `claude-` is stripped, and the **first** `-`-separated segment that names a family decides.
    /// That reads every id the dock offers (`src-tauri/src/views.rs`, `models()`): the four
    /// full names, the four bare aliases, and the two bracketed ones.
    ///
    /// **`fable` maps to [`ModelTier::STRONGEST`].** Fable sits *above* Opus on the price list and
    /// there is no tier above `Opus` to hold it; mapping it to the top is the honest reading of a
    /// ceiling, because nothing a planner can ask for may exceed it.
    ///
    /// A `None` here does **not** mean "no ceiling" — see
    /// [`Ceiling::new`](crate::loop_::routing::Ceiling::new), which binds an unrecognised pick at
    /// [`ModelTier::WEAKEST`] so that it clamps everything rather than nothing.
    #[must_use]
    pub fn for_model_id(id: &str) -> Option<Self> {
        let lower = id.trim().to_ascii_lowercase();
        let head = lower.split('[').next().unwrap_or(lower.as_str());
        let head = head.strip_prefix("claude-").unwrap_or(head);
        head.split('-').find_map(|segment| match segment {
            "haiku" => Some(Self::Haiku),
            "sonnet" => Some(Self::Sonnet),
            "opus" | "fable" => Some(Self::Opus),
            _ => None,
        })
    }
}

impl Ord for ModelTier {
    /// By [`ModelTier::rank`], never by declaration order.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.rank().cmp(&other.rank())
    }
}

impl PartialOrd for ModelTier {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// One work order in a `dispatch`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Order {
    /// Stable within the phase, and the id the worker's report must come back under.
    pub id: String,
    /// One line for the plan card.
    pub title: String,
    /// The order itself. The worker child is briefed like a stranger, because it is one.
    pub instructions: String,
    /// The paths this order **writes**. Reads are unrestricted: ownership is about writes,
    /// because the waste `docs/vision.md` §6 names is a partitioning failure to be avoided, not
    /// a rule to be enforced.
    ///
    /// Advisory going in and enforced coming out — nothing stops a worker writing outside it, so
    /// the real check is `git diff --name-only base..branch` at the merge
    /// (`docs/research/orchestration-loop.md` §3.2).
    pub owns: Vec<String>,
    /// What this order is worth.
    pub model_tier: ModelTier,
    /// Exact independent provider, limited to registered adapters.
    #[serde(default)]
    pub provider: Option<String>,
    /// Exact worker model; legacy plans may use model_tier instead.
    #[serde(default)]
    pub model: Option<String>,
    /// Independent worker reasoning effort.
    #[serde(default)]
    pub effort: Option<String>,
}

/// `{"action":"dispatch", …}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DispatchAction {
    /// The partition. Pairwise disjoint by path component, and every order owns something.
    pub orders: Vec<Order>,
}

/// `{"action":"review", …}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewAction {
    /// What the adversarial child is to look for.
    pub focus: String,
    /// Which orders' diffs it gets.
    pub orders: Vec<String>,
}

/// `{"action":"verify", …}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyAction {
    /// The phase to gate. Must be the phase the loop is on.
    pub phase_id: String,
    /// The stored verify command, echoed back **verbatim**, or omitted.
    ///
    /// The payload the design names is `phase_id` alone, so this is optional and the harness runs
    /// the stored command either way. When it *is* present it must match the stored command
    /// byte for byte: the lead may not invent one. Wanting a different verify command is a
    /// `replan`, and a `replan` that moves a verify command is a definition-of-done change
    /// (`docs/research/orchestration-loop.md` §2.4 and §10).
    #[serde(default)]
    pub verify_command: Option<String>,
}

/// `{"action":"merge", …}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MergeAction {
    /// The phase whose order branches are being merged.
    pub phase_id: String,
    /// The branches to merge. Optional; when present, every one must be a branch this phase's
    /// orders are actually on.
    #[serde(default)]
    pub branches: Vec<String>,
}

/// A phase added by a `replan`.
///
/// The phase's own fields are spelled out rather than `#[serde(flatten)]`ed: serde's
/// `deny_unknown_fields` is silently inert next to a flattened field, and unknown fields being an
/// error is the point of gate 3.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplanAdd {
    /// One line, shown on the plan card.
    pub title: String,
    /// What has to be true for the phase to be finished.
    pub definition_of_done: String,
    /// The command whose exit code settles it. Required and non-empty, as in a `plan`.
    pub verify_command: String,
    /// Why it is being added. Every plan change carries one.
    pub reason: String,
}

/// A phase changed by a `replan`. Every field but `phase_id` and `reason` is optional; an absent
/// field is left alone.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplanEdit {
    /// Which phase.
    pub phase_id: String,
    /// New title, or leave it.
    #[serde(default)]
    pub title: Option<String>,
    /// New definition of done, or leave it.
    #[serde(default)]
    pub definition_of_done: Option<String>,
    /// New verify command, or leave it. **Moving this is a definition-of-done change**, which is
    /// exactly why it may only happen here and never inside a `verify`.
    #[serde(default)]
    pub verify_command: Option<String>,
    /// Why.
    pub reason: String,
}

/// A phase dropped by a `replan`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplanDrop {
    /// Which phase.
    pub phase_id: String,
    /// Why.
    pub reason: String,
}

/// `{"action":"replan", …}`. All three lists default to empty; at least one must not be.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplanAction {
    /// Phases to add.
    #[serde(default)]
    pub add: Vec<ReplanAdd>,
    /// Phases to change.
    #[serde(default)]
    pub edit: Vec<ReplanEdit>,
    /// Phases to drop.
    #[serde(default)]
    pub drop: Vec<ReplanDrop>,
}

/// `{"action":"ask_owner", …}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AskOwnerAction {
    /// One question, as a real choice.
    pub question: String,
    /// What it is blocking, so the owner can judge whether it is worth answering now.
    pub why_blocked: String,
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

/// What a worker child says it did.
///
/// **A report is a claim, never evidence.** Every field here is re-derived before it is used:
/// `commits` against `git log --format=%H%x00%s base..branch`, `files_changed` against
/// `git diff --name-only base..branch` plus `dirty_count` for the uncommitted remainder
/// (`docs/research/orchestration-loop.md` §4.1).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Report {
    /// The order this answers.
    pub order_id: String,
    /// The worker's claim about how it went. See [`ReportStatus`].
    pub status: ReportStatus,
    /// One paragraph, at most [`MAX_SUMMARY_CHARS`] characters.
    pub summary: String,
    /// Files the worker says it touched. Re-derived from git before use.
    #[serde(default)]
    pub files_changed: Vec<String>,
    /// Commits the worker says it made, `"<sha> <subject>"`. Re-derived from git before use.
    #[serde(default)]
    pub commits: Vec<String>,
    /// What it is stuck on, when `status` is `blocked`.
    #[serde(default)]
    pub blocked_on: Option<String>,
    /// Anything the reviewer should know.
    #[serde(default)]
    pub notes_for_review: Option<String>,
}

/// A worker's own account of how its order went.
///
/// **Stored as the worker's claim and settles nothing.** `done` re-derives to nothing at all: an
/// order is complete only when its report arrived **and** the phase's gate exited 0 — neither
/// alone, ever. This is `docs/vision.md` §8's named failure mode (*agents declaring done
/// prematurely and marking features complete without end-to-end tests*) turned into a type whose
/// documentation refuses to let a reader forget it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    /// The worker believes it finished. Believes.
    Done,
    /// It could not proceed; `blocked_on` says why.
    Blocked,
    /// Some of it landed.
    Partial,
}

impl ReportStatus {
    /// The slug this status arrived as.
    #[must_use]
    pub fn as_slug(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Blocked => "blocked",
            Self::Partial => "partial",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/// Why an action or a report was refused.
///
/// Every message is written to be pasted into the retry's context unchanged: it says what was
/// wrong specifically enough for a fresh window to do better, and it never says "invalid".
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ActionError {
    /// Gate 1: no fenced `json` block at all. A child that ended its turn with prose lands here,
    /// and it is not a special case.
    #[error("no fenced ```json block in the final message; exactly one is required")]
    NoJsonBlock,
    /// Gate 1: more than one fenced `json` block, so which one is the action is a guess.
    #[error("{0} fenced ```json blocks in the final message; exactly one is required")]
    MultipleJsonBlocks(usize),
    /// Gate 2: the block is not JSON, or not a JSON object.
    #[error("the ```json block is not a JSON object: {0}")]
    NotJson(String),
    /// Gate 2: no `action` key, or it is not a string.
    #[error("the ```json block has no string `action` field; expected one of {slugs}", slugs = ACTION_SLUGS.join(", "))]
    MissingAction,
    /// Gate 2: `action` is outside the closed set.
    #[error("`{0}` is not an action; expected one of {slugs}", slugs = ACTION_SLUGS.join(", "))]
    UnknownAction(String),
    /// Gate 3: the payload does not fit the action's schema. `detail` carries serde's own message,
    /// which names the offending field — including an unknown one, because unknown fields are an
    /// error and not ignored.
    #[error("`{action}` payload is not schema-valid: {detail}")]
    Schema {
        /// The action slug the payload claimed.
        action: String,
        /// What serde said.
        detail: String,
    },
    /// Gate 3: a bound was exceeded, or a required field was empty.
    #[error("{0}")]
    Bound(String),
    /// Gate 4: an `owns` path is absolute, or contains `..`, or is empty.
    #[error("order `{order}` claims `{path}`: {why}. Every owned path is project-relative and contains no `..`")]
    PathShape {
        /// The order that claimed it.
        order: String,
        /// The path as written.
        path: String,
        /// What is wrong with it.
        why: String,
    },
    /// Gate 4: an `owns` path resolves outside the project root once symlinks are followed.
    #[error("order `{order}` claims `{path}`, which resolves outside the project root at `{}`", root.display())]
    PathEscapesRoot {
        /// The order that claimed it.
        order: String,
        /// The path as written.
        path: String,
        /// The root it escaped.
        root: PathBuf,
    },
    /// Gate 4: two orders claim overlapping paths.
    ///
    /// **The partition is refused, never repaired.** This message names which two orders collide
    /// on which paths, because that sentence goes into the retry's prompt.
    #[error("orders `{a}` and `{b}` collide: `{a_path}` and `{b_path}` are not disjoint by path component. An overlapping partition is refused, never repaired: re-partition so that no two orders write the same file")]
    OverlappingOwns {
        /// The first order.
        a: String,
        /// Its colliding path.
        a_path: String,
        /// The second order.
        b: String,
        /// Its colliding path.
        b_path: String,
    },
    /// Gate 4: an order owns nothing, so it has no partition to be disjoint from.
    #[error("order `{0}` owns no paths; every order writes something or it is not an order")]
    NoOwnedPaths(String),
    /// Gate 4: the action names a phase that is not the one the loop is on.
    #[error("this action names phase `{named}`, but the loop is on phase `{current}`")]
    PhaseNotCurrent {
        /// The phase the action named.
        named: String,
        /// The phase the loop is actually on.
        current: String,
    },
    /// Gate 4: a `verify` named a command that is not the phase's stored one.
    ///
    /// The lead may not invent a verify command. Wanting a different one is a `replan`.
    #[error("this `verify` names `{named}`, but phase `{phase_id}`'s stored verify command is {stored:?}. The lead may not invent a verify command; wanting a different one is a `replan`")]
    VerifyCommandInvented {
        /// The phase.
        phase_id: String,
        /// What the action named.
        named: String,
        /// What is actually stored.
        stored: Option<String>,
    },
    /// Gate 4: a `merge` named a branch none of this phase's orders is on.
    #[error("this `merge` names branch `{branch}`, which no order in this phase is on")]
    UnknownBranch {
        /// The branch the action named.
        branch: String,
    },
}

// ---------------------------------------------------------------------------------------------
// Gate 1: extraction
// ---------------------------------------------------------------------------------------------

/// Every fenced `json` block in `text`, in order, bodies only.
///
/// Fences of other languages are tracked so that a `json` fence line inside a plain block is
/// not mistaken for an opening fence.
#[must_use]
pub fn json_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut open: Option<(usize, bool)> = None; // (body start offset, is json)
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        let trimmed = line.trim();
        match open {
            None => {
                if let Some(lang) = trimmed.strip_prefix("```") {
                    open = Some((offset, lang.trim().eq_ignore_ascii_case("json")));
                }
            }
            Some((body_start, is_json)) => {
                if trimmed == "```" {
                    if is_json {
                        blocks.push(&text[body_start..line_start]);
                    }
                    open = None;
                }
            }
        }
    }
    blocks
}

/// The one fenced `json` block, or gate 1's refusal.
///
/// # Errors
/// [`ActionError::NoJsonBlock`] for zero, [`ActionError::MultipleJsonBlocks`] for two or more.
pub fn sole_json_block(text: &str) -> Result<&str, ActionError> {
    let blocks = json_blocks(text);
    match blocks.len() {
        1 => Ok(blocks[0]),
        0 => Err(ActionError::NoJsonBlock),
        n => Err(ActionError::MultipleJsonBlocks(n)),
    }
}

// ---------------------------------------------------------------------------------------------
// Gates 2 and 3: parsing
// ---------------------------------------------------------------------------------------------

/// Gates 1 to 3 over a child's final assistant text.
///
/// Gate 4 is [`validate`], which needs the world and is a separate call so that a caller with no
/// world yet — the planner, whose plan does not name paths — can stop here.
///
/// # Errors
/// Every [`ActionError`] variant from [`NoJsonBlock`](ActionError::NoJsonBlock) through
/// [`Bound`](ActionError::Bound).
pub fn parse_action(text: &str) -> Result<Action, ActionError> {
    let block = sole_json_block(text)?;
    let value: serde_json::Value =
        serde_json::from_str(block).map_err(|e| ActionError::NotJson(e.to_string()))?;
    let serde_json::Value::Object(mut map) = value else {
        return Err(ActionError::NotJson("expected a JSON object".to_owned()));
    };
    let slug = match map.remove("action") {
        Some(serde_json::Value::String(s)) => s,
        _ => return Err(ActionError::MissingAction),
    };
    if !ACTION_SLUGS.contains(&slug.as_str()) {
        return Err(ActionError::UnknownAction(slug));
    }
    // `action` was removed above, so the remainder is exactly the payload and every struct below
    // can carry `deny_unknown_fields` without the tag tripping it.
    let rest = serde_json::Value::Object(map);

    let schema = |e: serde_json::Error| ActionError::Schema {
        action: slug.clone(),
        detail: e.to_string(),
    };
    let action = match slug.as_str() {
        "plan" => Action::Plan(serde_json::from_value(rest).map_err(schema)?),
        "dispatch" => Action::Dispatch(serde_json::from_value(rest).map_err(schema)?),
        "review" => Action::Review(serde_json::from_value(rest).map_err(schema)?),
        "verify" => Action::Verify(serde_json::from_value(rest).map_err(schema)?),
        "merge" => Action::Merge(serde_json::from_value(rest).map_err(schema)?),
        "replan" => Action::Replan(serde_json::from_value(rest).map_err(schema)?),
        "ask_owner" => Action::AskOwner(serde_json::from_value(rest).map_err(schema)?),
        // `ACTION_SLUGS` is checked above, so this arm is unreachable; it is a refusal rather
        // than an `unreachable!` because a future slug added to the list and not to this match
        // must not panic the harness.
        other => return Err(ActionError::UnknownAction(other.to_owned())),
    };
    check_bounds(&action)?;
    Ok(action)
}

/// Gates 1 to 3 over a worker child's final assistant text.
///
/// # Errors
/// As [`parse_action`], plus [`ActionError::Bound`] when `summary` is over
/// [`MAX_SUMMARY_CHARS`].
pub fn parse_report(text: &str) -> Result<Report, ActionError> {
    let block = sole_json_block(text)?;
    let report: Report = serde_json::from_str(block).map_err(|e| {
        // A report has no `action` tag to key on, so a shape failure and a syntax failure are
        // told apart by whether serde got as far as the data.
        if e.is_syntax() || e.is_eof() {
            ActionError::NotJson(e.to_string())
        } else {
            ActionError::Schema {
                action: "report".to_owned(),
                detail: e.to_string(),
            }
        }
    })?;
    if report.order_id.trim().is_empty() {
        return Err(ActionError::Bound(
            "a report's `order_id` is empty".to_owned(),
        ));
    }
    let chars = report.summary.chars().count();
    if chars > MAX_SUMMARY_CHARS {
        return Err(ActionError::Bound(format!(
            "a report's `summary` is {chars} characters; at most {MAX_SUMMARY_CHARS} are allowed"
        )));
    }
    Ok(report)
}

/// Gate 3's size and emptiness rules, which need no world.
fn check_bounds(action: &Action) -> Result<(), ActionError> {
    let bound = |m: String| Err(ActionError::Bound(m));
    let text = |field: &str, s: &str, max: usize| -> Result<(), ActionError> {
        if s.trim().is_empty() {
            return Err(ActionError::Bound(format!("`{field}` is empty")));
        }
        let n = s.chars().count();
        if n > max {
            return Err(ActionError::Bound(format!(
                "`{field}` is {n} characters; at most {max} are allowed"
            )));
        }
        Ok(())
    };

    match action {
        Action::Plan(p) => {
            if p.phases.len() < MIN_PHASES || p.phases.len() > MAX_PHASES {
                return bound(format!(
                    "a plan has {} phases; between {MIN_PHASES} and {MAX_PHASES} are allowed",
                    p.phases.len()
                ));
            }
            for (i, phase) in p.phases.iter().enumerate() {
                text(&format!("phases[{i}].title"), &phase.title, MAX_TEXT_CHARS)?;
                text(
                    &format!("phases[{i}].definition_of_done"),
                    &phase.definition_of_done,
                    MAX_INSTRUCTIONS_CHARS,
                )?;
                // The one that is not a formality: a planner that returns no verify command has
                // not produced a plan this loop can run.
                if phase.verify_command.trim().is_empty() {
                    return bound(format!(
                        "phase {i} (`{}`) has an empty `verify_command`; every phase needs a \
                         command whose exit code can settle it",
                        phase.title
                    ));
                }
                text(
                    &format!("phases[{i}].verify_command"),
                    &phase.verify_command,
                    MAX_TEXT_CHARS,
                )?;
            }
            if p.unknowns.len() > MAX_UNKNOWNS {
                return bound(format!(
                    "a plan lists {} unknowns; at most {MAX_UNKNOWNS} are allowed",
                    p.unknowns.len()
                ));
            }
            for (i, u) in p.unknowns.iter().enumerate() {
                text(
                    &format!("unknowns[{i}].question"),
                    &u.question,
                    MAX_TEXT_CHARS,
                )?;
            }
        }
        Action::Dispatch(d) => {
            if d.orders.is_empty() || d.orders.len() > MAX_ORDERS {
                return bound(format!(
                    "a dispatch carries {} orders; between 1 and {MAX_ORDERS} are allowed",
                    d.orders.len()
                ));
            }
            let mut seen: BTreeSet<&str> = BTreeSet::new();
            for (i, order) in d.orders.iter().enumerate() {
                text(&format!("orders[{i}].id"), &order.id, MAX_TEXT_CHARS)?;
                text(&format!("orders[{i}].title"), &order.title, MAX_TEXT_CHARS)?;
                text(
                    &format!("orders[{i}].instructions"),
                    &order.instructions,
                    MAX_INSTRUCTIONS_CHARS,
                )?;
                if !seen.insert(order.id.as_str()) {
                    return bound(format!(
                        "two orders share the id `{}`; ids are how reports come back",
                        order.id
                    ));
                }
                if order.owns.len() > MAX_OWNED_PATHS {
                    return bound(format!(
                        "order `{}` owns {} paths; at most {MAX_OWNED_PATHS} are allowed",
                        order.id,
                        order.owns.len()
                    ));
                }
            }
        }
        Action::Review(r) => {
            text("focus", &r.focus, MAX_INSTRUCTIONS_CHARS)?;
            if r.orders.is_empty() {
                return bound(
                    "a review names no orders; there would be no diff to read".to_owned(),
                );
            }
        }
        Action::Verify(v) => text("phase_id", &v.phase_id, MAX_TEXT_CHARS)?,
        Action::Merge(m) => text("phase_id", &m.phase_id, MAX_TEXT_CHARS)?,
        Action::Replan(r) => {
            if r.add.is_empty() && r.edit.is_empty() && r.drop.is_empty() {
                return bound(
                    "a replan changes nothing; give at least one `add`, `edit` or `drop`"
                        .to_owned(),
                );
            }
            for (i, a) in r.add.iter().enumerate() {
                text(
                    &format!("add[{i}].reason"),
                    &a.reason,
                    MAX_INSTRUCTIONS_CHARS,
                )?;
                text(&format!("add[{i}].title"), &a.title, MAX_TEXT_CHARS)?;
                if a.verify_command.trim().is_empty() {
                    return bound(format!("add[{i}] has an empty `verify_command`"));
                }
            }
            for (i, e) in r.edit.iter().enumerate() {
                text(&format!("edit[{i}].phase_id"), &e.phase_id, MAX_TEXT_CHARS)?;
                text(
                    &format!("edit[{i}].reason"),
                    &e.reason,
                    MAX_INSTRUCTIONS_CHARS,
                )?;
            }
            for (i, d) in r.drop.iter().enumerate() {
                text(&format!("drop[{i}].phase_id"), &d.phase_id, MAX_TEXT_CHARS)?;
                text(
                    &format!("drop[{i}].reason"),
                    &d.reason,
                    MAX_INSTRUCTIONS_CHARS,
                )?;
            }
        }
        Action::AskOwner(a) => {
            text("question", &a.question, MAX_INSTRUCTIONS_CHARS)?;
            text("why_blocked", &a.why_blocked, MAX_INSTRUCTIONS_CHARS)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Gate 4: semantic validation against the world
// ---------------------------------------------------------------------------------------------

/// What gate 4 checks an action against.
///
/// Everything here comes from the store or from the filesystem — never from the child.
#[derive(Clone, Copy, Debug)]
pub struct World<'a> {
    /// The project root. `owns` paths are resolved against it, symlinks and all.
    pub project_root: &'a Path,
    /// The phase the loop is on, when there is one.
    pub current_phase_id: Option<&'a str>,
    /// That phase's **stored** verify command.
    pub verify_command: Option<&'a str>,
    /// The branches this phase's orders are actually on.
    pub order_branches: &'a [String],
}

impl<'a> World<'a> {
    /// A world with nothing but a project root: enough for a `plan` or a `dispatch`.
    #[must_use]
    pub fn at(project_root: &'a Path) -> Self {
        Self {
            project_root,
            current_phase_id: None,
            verify_command: None,
            order_branches: &[],
        }
    }
}

/// Gate 4. Semantic validation against the world — the half that catches hallucination.
///
/// # Errors
/// [`ActionError::PathShape`], [`ActionError::PathEscapesRoot`], [`ActionError::NoOwnedPaths`],
/// [`ActionError::OverlappingOwns`], [`ActionError::PhaseNotCurrent`],
/// [`ActionError::VerifyCommandInvented`] and [`ActionError::UnknownBranch`].
pub fn validate(action: &Action, world: &World<'_>) -> Result<(), ActionError> {
    match action {
        Action::Dispatch(d) => validate_partition(&d.orders, world.project_root),
        Action::Verify(v) => {
            same_phase(&v.phase_id, world)?;
            if let Some(named) = &v.verify_command {
                // Verbatim, byte for byte. A stored `None` with a named command is the same
                // failure: inventing where there is nothing to echo.
                if world.verify_command != Some(named.as_str()) {
                    return Err(ActionError::VerifyCommandInvented {
                        phase_id: v.phase_id.clone(),
                        named: named.clone(),
                        stored: world.verify_command.map(str::to_owned),
                    });
                }
            }
            Ok(())
        }
        Action::Merge(m) => {
            same_phase(&m.phase_id, world)?;
            for branch in &m.branches {
                if !world.order_branches.iter().any(|b| b == branch) {
                    return Err(ActionError::UnknownBranch {
                        branch: branch.clone(),
                    });
                }
            }
            Ok(())
        }
        // A `plan` names no paths and no phase ids — the phases do not exist yet — and `review`,
        // `replan` and `ask_owner` are checked against the store by the loop that applies them.
        Action::Plan(_) | Action::Review(_) | Action::Replan(_) | Action::AskOwner(_) => Ok(()),
    }
}

fn same_phase(named: &str, world: &World<'_>) -> Result<(), ActionError> {
    match world.current_phase_id {
        Some(current) if current == named => Ok(()),
        Some(current) => Err(ActionError::PhaseNotCurrent {
            named: named.to_owned(),
            current: current.to_owned(),
        }),
        // No current phase to compare against: the loop has not started one, and an action that
        // names a phase is out of order. The loop reports it as such rather than this parser.
        None => Ok(()),
    }
}

/// Every `owns` rule: shape, resolution, non-emptiness, and pairwise disjointness.
fn validate_partition(orders: &[Order], project_root: &Path) -> Result<(), ActionError> {
    // (order id, path as written, path components)
    let mut claims: Vec<(&str, &str, Vec<String>)> = Vec::new();
    for order in orders {
        if order.owns.is_empty() {
            return Err(ActionError::NoOwnedPaths(order.id.clone()));
        }
        for path in &order.owns {
            let components = components_of(&order.id, path)?;
            if components.is_empty() {
                return Err(ActionError::PathShape {
                    order: order.id.clone(),
                    path: path.clone(),
                    why: "it names the project root itself".to_owned(),
                });
            }
            resolves_inside(&order.id, path, &components, project_root)?;
            claims.push((&order.id, path, components));
        }
    }

    // Pairwise, **by path component**. A `starts_with` on strings would say `src/a` and `src/ab`
    // collide, which is wrong and is why this compares component vectors instead.
    for (i, (a_id, a_path, a_comps)) in claims.iter().enumerate() {
        for (b_id, b_path, b_comps) in claims.iter().skip(i + 1) {
            if a_id == b_id {
                continue;
            }
            if is_component_prefix(a_comps, b_comps) || is_component_prefix(b_comps, a_comps) {
                return Err(ActionError::OverlappingOwns {
                    a: (*a_id).to_owned(),
                    a_path: (*a_path).to_owned(),
                    b: (*b_id).to_owned(),
                    b_path: (*b_path).to_owned(),
                });
            }
        }
    }
    Ok(())
}

/// Whether `short` is `long`'s prefix by whole components — which includes equality, and which
/// `src/a` is **not** of `src/ab`.
fn is_component_prefix(short: &[String], long: &[String]) -> bool {
    short.len() <= long.len() && short.iter().zip(long).all(|(a, b)| a == b)
}

/// A path's normal components, refusing anything absolute or containing `..`.
fn components_of(order: &str, path: &str) -> Result<Vec<String>, ActionError> {
    let shape = |why: &str| ActionError::PathShape {
        order: order.to_owned(),
        path: path.to_owned(),
        why: why.to_owned(),
    };
    if path.trim().is_empty() {
        return Err(shape("it is empty"));
    }
    let mut out = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(s) => out.push(s.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir => return Err(shape("it contains `..`")),
            Component::RootDir | Component::Prefix(_) => return Err(shape("it is absolute")),
        }
    }
    Ok(out)
}

/// Resolve the path component by component under the project root, following symlinks, and
/// refuse anything that leaves.
///
/// Component by component rather than one `canonicalize` of the whole thing, because the path
/// need not exist yet: an order may own a file it is about to create. A component that does not
/// exist cannot be a symlink and cannot escape; a component that exists is canonicalised and
/// checked; and a **dangling** symlink is refused outright, since where it points cannot be
/// established.
fn resolves_inside(
    order: &str,
    path: &str,
    components: &[String],
    project_root: &Path,
) -> Result<(), ActionError> {
    let escapes = || ActionError::PathEscapesRoot {
        order: order.to_owned(),
        path: path.to_owned(),
        root: project_root.to_owned(),
    };
    let root = std::fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_owned());
    let mut cursor = root.clone();
    for component in components {
        cursor.push(component);
        match std::fs::canonicalize(&cursor) {
            Ok(resolved) => {
                if !resolved.starts_with(&root) {
                    return Err(escapes());
                }
                cursor = resolved;
            }
            Err(_) => {
                // Nothing there. Unless it is a symlink pointing at nothing, in which case where
                // it would resolve to is unknowable and the safe answer is no.
                if std::fs::symlink_metadata(&cursor).is_ok() {
                    return Err(escapes());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ordering is the contract, and it is the **reverse** of declaration order. A derived
    /// `Ord` would make every clamp in the loop run backwards, so this is the test that fails
    /// if someone ever reaches for `#[derive(PartialOrd, Ord)]` here.
    #[test]
    fn tiers_are_ordered_weakest_first_and_never_by_declaration_order() {
        assert!(ModelTier::Haiku < ModelTier::Sonnet);
        assert!(ModelTier::Sonnet < ModelTier::Opus);
        assert!(ModelTier::Opus > ModelTier::Haiku);
        assert_eq!(ModelTier::Opus.min(ModelTier::Haiku), ModelTier::Haiku);
        assert_eq!(ModelTier::Haiku.min(ModelTier::Sonnet), ModelTier::Haiku);
        // Declaration order is Opus, Sonnet, Haiku — strongest first — so a derived `Ord` would
        // answer the opposite of every assertion above.
        assert_eq!(
            ModelTier::ALL,
            [ModelTier::Haiku, ModelTier::Sonnet, ModelTier::Opus]
        );
        let mut ranks: Vec<u8> = ModelTier::ALL.iter().map(|t| t.rank()).collect();
        ranks.dedup();
        assert_eq!(ranks, vec![0, 1, 2], "ranks are distinct and ascending");
        assert_eq!(ModelTier::WEAKEST, ModelTier::Haiku);
        assert_eq!(ModelTier::MID, ModelTier::Sonnet);
        assert_eq!(ModelTier::STRONGEST, ModelTier::Opus);
    }

    #[test]
    fn a_slug_round_trips_through_the_tier_it_names() {
        for tier in ModelTier::ALL {
            assert_eq!(ModelTier::from_slug(tier.as_slug()), Some(tier));
        }
        assert_eq!(
            ModelTier::from_slug("fable"),
            None,
            "not a tier the planner may ask for"
        );
        assert_eq!(
            ModelTier::from_slug("Opus"),
            None,
            "slugs are read strictly"
        );
    }

    /// Every id the run dock offers (`src-tauri/src/views.rs`, `models()`), plus the two
    /// bracketed CLI aliases, plus the shapes that must **not** be read as a family.
    #[test]
    fn every_model_id_the_dock_offers_maps_to_a_tier() {
        for (id, want) in [
            ("claude-haiku-4-5", ModelTier::Haiku),
            ("claude-sonnet-5", ModelTier::Sonnet),
            ("claude-opus-5", ModelTier::Opus),
            // Fable is above Opus on the price list and there is no tier above Opus.
            ("claude-fable-5-1", ModelTier::Opus),
            ("haiku", ModelTier::Haiku),
            ("sonnet", ModelTier::Sonnet),
            ("opus", ModelTier::Opus),
            ("fable", ModelTier::Opus),
            ("opus[1m]", ModelTier::Opus),
            ("sonnet[1m]", ModelTier::Sonnet),
            // The one the owner's 2026-09-05 run was actually billed for.
            ("claude-opus-5[1m]", ModelTier::Opus),
            // Case and whitespace are not what makes an id unrecognised.
            ("  Claude-Haiku-4-5  ", ModelTier::Haiku),
            // A dated id, and the legacy `claude-3-5-sonnet` shape whose family is not first.
            ("claude-haiku-4-5-20251001", ModelTier::Haiku),
            ("claude-3-5-sonnet-20241022", ModelTier::Sonnet),
        ] {
            assert_eq!(ModelTier::for_model_id(id), Some(want), "{id}");
        }
    }

    #[test]
    fn an_id_this_build_does_not_know_maps_to_no_tier() {
        for id in [
            "",
            "  ",
            "gpt-5",
            "claude-9",
            "gemini-3-pro",
            "claude-",
            "opusish",
        ] {
            assert_eq!(ModelTier::for_model_id(id), None, "{id:?}");
        }
    }

    fn fenced(body: &str) -> String {
        format!("Here is the plan.\n\n```json\n{body}\n```\n")
    }

    fn dispatch_json(orders: &str) -> String {
        fenced(&format!(
            r#"{{ "action": "dispatch", "orders": [{orders}] }}"#
        ))
    }

    fn order_json(id: &str, owns: &[&str]) -> String {
        let owns: Vec<String> = owns.iter().map(|p| format!("\"{p}\"")).collect();
        format!(
            r#"{{ "id": "{id}", "title": "t", "instructions": "do it",
                  "owns": [{}], "model_tier": "opus" }}"#,
            owns.join(", ")
        )
    }

    fn plan_json(phases: usize, verify: Option<&str>) -> String {
        let phases: Vec<String> = (0..phases)
            .map(|i| match verify {
                Some(v) => format!(
                    r#"{{ "title": "p{i}", "definition_of_done": "d", "verify_command": "{v}" }}"#
                ),
                None => format!(
                    r#"{{ "title": "p{i}", "definition_of_done": "d", "verify_command": "" }}"#
                ),
            })
            .collect();
        fenced(&format!(
            r#"{{ "action": "plan", "phases": [{}] }}"#,
            phases.join(", ")
        ))
    }

    // ---- gate 1: exactly one fenced json block ----

    /// A child that ends its turn with prose and no block is malformed #1, not a special case.
    #[test]
    fn zero_json_blocks_is_malformed() {
        assert_eq!(
            parse_action("I have finished the phase.").unwrap_err(),
            ActionError::NoJsonBlock
        );
        // A fenced block of some other language is still zero json blocks.
        let other = "```sh\ncargo test\n```\n";
        assert_eq!(parse_action(other).unwrap_err(), ActionError::NoJsonBlock);
    }

    #[test]
    fn two_json_blocks_are_malformed() {
        let text = format!(
            "{}\nand also\n{}",
            fenced(r#"{"action":"ask_owner","question":"q","why_blocked":"w"}"#),
            fenced(r#"{"action":"ask_owner","question":"q2","why_blocked":"w"}"#)
        );
        assert_eq!(
            parse_action(&text).unwrap_err(),
            ActionError::MultipleJsonBlocks(2)
        );
    }

    /// A `json` fence line inside a plain fenced block is text, not an opening fence.
    #[test]
    fn a_json_fence_inside_another_block_is_not_a_block() {
        let text = "```text\n```json\n{\"action\":\"merge\"}\n```\n\n".to_owned()
            + &fenced(r#"{"action":"verify","phase_id":"p1"}"#);
        let action = parse_action(&text).expect("one real block");
        assert_eq!(action.slug(), "verify");
    }

    // ---- gate 2: the closed set ----

    #[test]
    fn an_unknown_action_slug_is_refused_rather_than_degraded() {
        let text = fenced(r#"{"action":"deploy","what":"everything"}"#);
        assert_eq!(
            parse_action(&text).unwrap_err(),
            ActionError::UnknownAction("deploy".to_owned())
        );
    }

    #[test]
    fn a_block_with_no_action_field_is_refused() {
        let text = fenced(r#"{"phase_id":"p1"}"#);
        assert_eq!(parse_action(&text).unwrap_err(), ActionError::MissingAction);
    }

    #[test]
    fn a_block_that_is_not_json_is_refused() {
        let text = fenced("not json at all");
        assert!(matches!(
            parse_action(&text).unwrap_err(),
            ActionError::NotJson(_)
        ));
    }

    // ---- gate 3: schema, unknown fields, bounds ----

    /// Unknown fields are an **error**, not ignored: a field the harness silently drops is a
    /// decision the model thinks it made.
    #[test]
    fn an_unknown_field_is_an_error_and_names_itself() {
        let text = fenced(r#"{"action":"verify","phase_id":"p1","force":true}"#);
        let err = parse_action(&text).unwrap_err();
        let ActionError::Schema { action, detail } = &err else {
            panic!("{err:?}")
        };
        assert_eq!(action, "verify");
        assert!(
            detail.contains("force"),
            "the message must name the field: {detail}"
        );
    }

    #[test]
    fn an_unknown_model_tier_is_refused() {
        let text = dispatch_json(
            r#"{ "id": "o1", "title": "t", "instructions": "i", "owns": ["src/a.rs"],
                 "model_tier": "gpt" }"#,
        );
        assert!(matches!(
            parse_action(&text).unwrap_err(),
            ActionError::Schema { .. }
        ));
    }

    #[test]
    fn empty_and_oversized_plans_are_refused() {
        for n in [0usize, 9, 20] {
            let err = parse_action(&plan_json(n, Some("cargo test"))).unwrap_err();
            assert!(
                matches!(err, ActionError::Bound(_)),
                "{n} phases should be out of bounds, got {err:?}"
            );
        }
        for n in MIN_PHASES..=MAX_PHASES {
            parse_action(&plan_json(n, Some("cargo test")))
                .unwrap_or_else(|e| panic!("{n} phases should be fine: {e}"));
        }
    }

    /// A planner that returns no verify command has not produced a plan this loop can run.
    #[test]
    fn a_plan_phase_with_no_verify_command_is_refused() {
        let err = parse_action(&plan_json(3, None)).unwrap_err();
        let ActionError::Bound(msg) = &err else {
            panic!("{err:?}")
        };
        // The message goes into the retry's prompt, so it says what a verify command is *for*
        // rather than naming a field that is blank.
        assert!(msg.contains("verify_command"), "{msg}");
        assert!(msg.contains("exit code can settle it"), "{msg}");

        // And an omitted field, not merely an empty one.
        let text = fenced(
            r#"{"action":"plan","phases":[
                 {"title":"a","definition_of_done":"d"},
                 {"title":"b","definition_of_done":"d","verify_command":"cargo test"}]}"#,
        );
        assert!(matches!(
            parse_action(&text).unwrap_err(),
            ActionError::Schema { .. }
        ));
    }

    // ---- D2: the unknowns the planner lists ----

    /// Absent is valid and empty. A goal with no genuine unknowns is a real answer.
    #[test]
    fn a_plan_with_no_unknowns_field_is_valid_and_yields_none() {
        let Action::Plan(p) = parse_action(&plan_json(2, Some("cargo test"))).expect("valid")
        else {
            panic!("expected a plan")
        };
        assert!(p.unknowns.is_empty());
    }

    #[test]
    fn a_plan_carries_its_unknowns_with_their_bins() {
        let text = fenced(
            r#"{"action":"plan",
                "phases":[{"title":"a","definition_of_done":"d","verify_command":"cargo test"},
                          {"title":"b","definition_of_done":"d","verify_command":"cargo test"}],
                "unknowns":[{"question":"which database?","bin":"owner"},
                            {"question":"does tauri v2 support X?","bin":"research"}]}"#,
        );
        let Action::Plan(p) = parse_action(&text).expect("valid") else {
            panic!("expected a plan")
        };
        assert_eq!(p.unknowns.len(), 2);
        assert_eq!(p.unknowns[0].bin, UnknownBin::Owner);
        assert_eq!(p.unknowns[1].bin.as_slug(), "research");
    }

    /// Read strictly, and **not** degraded to `owner` the way a stored slug would be.
    #[test]
    fn an_unknown_bin_slug_is_refused_rather_than_falling_back_to_owner() {
        let text = fenced(
            r#"{"action":"plan",
                "phases":[{"title":"a","definition_of_done":"d","verify_command":"cargo test"},
                          {"title":"b","definition_of_done":"d","verify_command":"cargo test"}],
                "unknowns":[{"question":"q","bin":"the_internet"}]}"#,
        );
        let err = parse_action(&text).unwrap_err();
        let ActionError::Schema { detail, .. } = &err else {
            panic!("{err:?}")
        };
        assert!(
            detail.contains("the_internet") || detail.contains("variant"),
            "{detail}"
        );
    }

    #[test]
    fn too_many_unknowns_are_refused() {
        let items: Vec<String> = (0..=MAX_UNKNOWNS)
            .map(|i| format!(r#"{{"question":"q{i}","bin":"owner"}}"#))
            .collect();
        let text = fenced(&format!(
            r#"{{"action":"plan",
                 "phases":[{{"title":"a","definition_of_done":"d","verify_command":"cargo test"}},
                           {{"title":"b","definition_of_done":"d","verify_command":"cargo test"}}],
                 "unknowns":[{}]}}"#,
            items.join(", ")
        ));
        let err = parse_action(&text).unwrap_err();
        let ActionError::Bound(msg) = &err else {
            panic!("{err:?}")
        };
        assert!(msg.contains("unknowns"), "{msg}");
    }

    // ---- gate 4: the world ----

    struct Root(tempfile::TempDir);

    impl Root {
        fn new() -> Self {
            Self(tempfile::tempdir().expect("tempdir"))
        }
        fn path(&self) -> &Path {
            self.0.path()
        }
        fn world(&self) -> World<'_> {
            World::at(self.0.path())
        }
    }

    fn validated(text: &str, world: &World<'_>) -> Result<Action, ActionError> {
        let action = parse_action(text)?;
        validate(&action, world)?;
        Ok(action)
    }

    #[test]
    fn an_absolute_owned_path_is_refused() {
        let root = Root::new();
        let text = dispatch_json(&order_json("o1", &["/etc/passwd"]));
        let err = validated(&text, &root.world()).unwrap_err();
        let ActionError::PathShape { why, .. } = &err else {
            panic!("{err:?}")
        };
        assert_eq!(why, "it is absolute");
    }

    #[test]
    fn a_traversing_owned_path_is_refused() {
        let root = Root::new();
        let text = dispatch_json(&order_json("o1", &["../../etc/passwd"]));
        let err = validated(&text, &root.world()).unwrap_err();
        let ActionError::PathShape { why, .. } = &err else {
            panic!("{err:?}")
        };
        assert_eq!(why, "it contains `..`");

        // And one that would land back inside, which is still refused: `..` never appears in an
        // owned path, because a partition made of them cannot be compared component-wise.
        let text = dispatch_json(&order_json("o1", &["src/../src/a.rs"]));
        assert!(matches!(
            validated(&text, &root.world()).unwrap_err(),
            ActionError::PathShape { .. }
        ));
    }

    /// The check that only a symlink-following resolution catches: the path is relative, has no
    /// `..`, and still lands outside the project.
    #[test]
    fn a_symlink_that_escapes_the_root_is_refused() {
        let root = Root::new();
        let outside = tempfile::tempdir().expect("outside");
        std::fs::create_dir(root.path().join("src")).expect("mkdir src");
        symlink(outside.path(), &root.path().join("src/elsewhere"));

        let text = dispatch_json(&order_json("o1", &["src/elsewhere/a.rs"]));
        let err = validated(&text, &root.world()).unwrap_err();
        assert!(
            matches!(err, ActionError::PathEscapesRoot { .. }),
            "{err:?}"
        );

        // A dangling symlink is refused too: where it would resolve to is unknowable.
        symlink(
            Path::new("/nowhere-at-all-xyz"),
            &root.path().join("src/dangling"),
        );
        let text = dispatch_json(&order_json("o1", &["src/dangling/a.rs"]));
        assert!(matches!(
            validated(&text, &root.world()).unwrap_err(),
            ActionError::PathEscapesRoot { .. }
        ));
    }

    #[test]
    fn a_path_that_does_not_exist_yet_is_fine() {
        let root = Root::new();
        let text = dispatch_json(&order_json("o1", &["crates/new/src/lib.rs"]));
        validated(&text, &root.world()).expect("an order may own a file it is about to create");
    }

    #[test]
    fn an_order_that_owns_nothing_is_refused() {
        let root = Root::new();
        let text = dispatch_json(&order_json("o1", &[]));
        assert_eq!(
            validated(&text, &root.world()).unwrap_err(),
            ActionError::NoOwnedPaths("o1".to_owned())
        );
    }

    #[test]
    fn an_overlapping_partition_names_both_orders_and_both_paths() {
        let root = Root::new();
        let text = dispatch_json(&format!(
            "{}, {}",
            order_json("api", &["src/a.rs", "src/b.rs"]),
            order_json("ui", &["src/c.rs", "src/b.rs"])
        ));
        let err = validated(&text, &root.world()).unwrap_err();
        let ActionError::OverlappingOwns {
            a,
            a_path,
            b,
            b_path,
        } = &err
        else {
            panic!("{err:?}")
        };
        assert_eq!((a.as_str(), a_path.as_str()), ("api", "src/b.rs"));
        assert_eq!((b.as_str(), b_path.as_str()), ("ui", "src/b.rs"));
        // The sentence that goes into the retry's prompt.
        let msg = err.to_string();
        assert!(
            msg.contains("`api`") && msg.contains("`ui`") && msg.contains("src/b.rs"),
            "{msg}"
        );
        assert!(msg.contains("refused, never repaired"), "{msg}");
    }

    /// A directory and a file inside it are the same collision, and this is the case a
    /// component comparison catches and a string comparison also catches.
    #[test]
    fn owning_a_directory_collides_with_owning_a_file_inside_it() {
        let root = Root::new();
        let text = dispatch_json(&format!(
            "{}, {}",
            order_json("a", &["src"]),
            order_json("b", &["src/deep/x.rs"])
        ));
        assert!(matches!(
            validated(&text, &root.world()).unwrap_err(),
            ActionError::OverlappingOwns { .. }
        ));
    }

    /// **The case a `starts_with` on strings gets wrong.** `"src/ab".starts_with("src/a")` is
    /// true and the partition is fine; comparing components says so and comparing strings does
    /// not.
    #[test]
    fn src_a_and_src_ab_do_not_collide() {
        let root = Root::new();
        let text = dispatch_json(&format!(
            "{}, {}",
            order_json("a", &["src/a"]),
            order_json("b", &["src/ab"])
        ));
        validated(&text, &root.world()).expect("`src/a` and `src/ab` are disjoint");
        // The string test that would have failed, spelled out so a future simplification back to
        // it fails here first.
        assert!(
            "src/ab".starts_with("src/a"),
            "this is the trap being avoided"
        );
        assert!(!is_component_prefix(
            &["src".to_owned(), "a".to_owned()],
            &["src".to_owned(), "ab".to_owned()]
        ));
    }

    /// Two paths under one order may overlap all they like; only *different* orders collide.
    #[test]
    fn one_order_may_own_overlapping_paths_of_its_own() {
        let root = Root::new();
        let text = dispatch_json(&order_json("solo", &["src", "src/a.rs"]));
        validated(&text, &root.world()).expect("an order does not collide with itself");
    }

    #[test]
    fn duplicate_order_ids_are_refused() {
        let root = Root::new();
        let text = dispatch_json(&format!(
            "{}, {}",
            order_json("same", &["a.rs"]),
            order_json("same", &["b.rs"])
        ));
        assert!(matches!(
            validated(&text, &root.world()).unwrap_err(),
            ActionError::Bound(_)
        ));
    }

    // ---- gate 4: phases, verify commands and branches ----

    #[test]
    fn a_verify_for_another_phase_is_refused() {
        let root = Root::new();
        let mut world = root.world();
        world.current_phase_id = Some("p2");
        let text = fenced(r#"{"action":"verify","phase_id":"p1"}"#);
        assert_eq!(
            validated(&text, &world).unwrap_err(),
            ActionError::PhaseNotCurrent {
                named: "p1".to_owned(),
                current: "p2".to_owned()
            }
        );
    }

    /// The lead may not invent a verify command. Wanting a different one is a `replan`.
    #[test]
    fn a_verify_must_name_the_stored_command_verbatim() {
        let root = Root::new();
        let mut world = root.world();
        world.current_phase_id = Some("p1");
        world.verify_command = Some("cargo test --workspace");

        let exact = fenced(
            r#"{"action":"verify","phase_id":"p1","verify_command":"cargo test --workspace"}"#,
        );
        validated(&exact, &world).expect("verbatim is fine");

        // One character of difference is an invented command, not a near miss.
        let nearly = fenced(
            r#"{"action":"verify","phase_id":"p1","verify_command":"cargo test  --workspace"}"#,
        );
        assert!(matches!(
            validated(&nearly, &world).unwrap_err(),
            ActionError::VerifyCommandInvented { .. }
        ));

        // Naming one where none is stored is the same failure.
        world.verify_command = None;
        let err = validated(&exact, &world).unwrap_err();
        let ActionError::VerifyCommandInvented { stored, .. } = &err else {
            panic!("{err:?}")
        };
        assert!(stored.is_none());
        assert!(err.to_string().contains("may not invent"), "{err}");

        // And omitting it entirely is allowed: the harness runs the stored command either way.
        world.verify_command = Some("cargo test --workspace");
        validated(&fenced(r#"{"action":"verify","phase_id":"p1"}"#), &world).expect("omitted");
    }

    #[test]
    fn a_merge_may_only_name_this_phases_branches() {
        let root = Root::new();
        let branches = vec!["brigadier/aaa".to_owned(), "brigadier/bbb".to_owned()];
        let mut world = root.world();
        world.current_phase_id = Some("p1");
        world.order_branches = &branches;

        let ok = fenced(
            r#"{"action":"merge","phase_id":"p1","branches":["brigadier/aaa","brigadier/bbb"]}"#,
        );
        validated(&ok, &world).expect("both branches are this phase's");

        let bad =
            fenced(r#"{"action":"merge","phase_id":"p1","branches":["brigadier/aaa","main"]}"#);
        assert_eq!(
            validated(&bad, &world).unwrap_err(),
            ActionError::UnknownBranch {
                branch: "main".to_owned()
            }
        );
    }

    // ---- the other actions ----

    #[test]
    fn review_replan_and_ask_owner_round_trip() {
        let root = Root::new();
        let review = fenced(r#"{"action":"review","focus":"concurrency","orders":["o1","o2"]}"#);
        assert_eq!(
            validated(&review, &root.world()).expect("review").slug(),
            "review"
        );

        let replan =
            fenced(r#"{"action":"replan","drop":[{"phase_id":"p3","reason":"subsumed by p2"}]}"#);
        assert_eq!(
            validated(&replan, &root.world()).expect("replan").slug(),
            "replan"
        );

        // A replan that changes nothing is not a replan.
        let empty = fenced(r#"{"action":"replan"}"#);
        assert!(matches!(
            parse_action(&empty).unwrap_err(),
            ActionError::Bound(_)
        ));

        let ask = fenced(
            r#"{"action":"ask_owner","question":"postgres or sqlite?","why_blocked":"phase 2"}"#,
        );
        assert_eq!(
            validated(&ask, &root.world()).expect("ask_owner").slug(),
            "ask_owner"
        );
    }

    // ---- the report ----

    #[test]
    fn a_report_round_trips_and_its_status_settles_nothing() {
        let text = fenced(
            r#"{"order_id":"o1","status":"done","summary":"did it",
                "files_changed":["src/a.rs"],"commits":["abc def"],
                "blocked_on":null,"notes_for_review":null}"#,
        );
        let report = parse_report(&text).expect("valid report");
        assert_eq!(report.status, ReportStatus::Done);
        assert_eq!(report.status.as_slug(), "done");
        // There is deliberately no `is_complete()` on `ReportStatus`: completeness is the report
        // **and** a gate that exited 0, and it is not this type's to answer.
        assert_eq!(report.commits, vec!["abc def".to_owned()]);
    }

    #[test]
    fn a_report_with_an_over_long_summary_is_refused() {
        let long = "x".repeat(MAX_SUMMARY_CHARS + 1);
        let text = fenced(&format!(
            r#"{{"order_id":"o1","status":"partial","summary":"{long}"}}"#
        ));
        let err = parse_report(&text).unwrap_err();
        let ActionError::Bound(msg) = &err else {
            panic!("{err:?}")
        };
        assert!(msg.contains("summary"), "{msg}");
    }

    #[test]
    fn a_report_with_an_unknown_status_or_field_is_refused() {
        let bad_status = fenced(r#"{"order_id":"o1","status":"mostly","summary":"s"}"#);
        assert!(matches!(
            parse_report(&bad_status).unwrap_err(),
            ActionError::Schema { .. }
        ));

        let bad_field =
            fenced(r#"{"order_id":"o1","status":"done","summary":"s","confidence":0.9}"#);
        let err = parse_report(&bad_field).unwrap_err();
        let ActionError::Schema { detail, .. } = &err else {
            panic!("{err:?}")
        };
        assert!(detail.contains("confidence"), "{detail}");
    }

    #[test]
    fn a_report_needs_exactly_one_block_too() {
        assert_eq!(
            parse_report("all done!").unwrap_err(),
            ActionError::NoJsonBlock
        );
    }

    #[cfg(unix)]
    fn symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    #[cfg(not(unix))]
    fn symlink(_target: &Path, _link: &Path) {
        unimplemented!("the symlink tests are unix-only");
    }
}
