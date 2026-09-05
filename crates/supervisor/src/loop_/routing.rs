//! The owner's model pick as a **ceiling**, and the only place a child's `--model` is decided.
//!
//! ## Why a ceiling and not a default
//!
//! `docs/vision.md` §6 calls model routing *"the throttle"* and says *"one visible per-session
//! tier is the knob the owner sees"*. A knob that bounds nothing above it is not a throttle, and
//! for one day it bounded nothing: the **planner** chooses each order's
//! [`ModelTier`], that tier reached the CLI unbounded, and a run the
//! owner started with no model pick could decide by itself to spend Opus money on his
//! subscription. The same live end-to-end run, same throwaway repository, same goal, one day
//! apart:
//!
//! ```text
//! 2026-09-04   RUN COST $0.192433   5 sessions, all Haiku
//! 2026-09-05   RUN COST $0.585646   5 sessions, two with context_window 1_000_000
//! ```
//!
//! **3× for identical work** (**measured**, `crates/supervisor/tests/live_loop.rs`).
//!
//! The owner's decision of 2026-09-05, which is what this module implements:
//!
//! > *"your pick is a **ceiling**, not just a default — no pick means judgement gets the strong
//! > model but work orders cap at mid-tier, and picking Haiku means nothing in the run exceeds
//! > Haiku."*
//!
//! So:
//!
//! - **An explicit pick bounds every child** — planner, lead, worker, fixer, reviewer. A planner
//!   asking for a stronger tier is **clamped, not refused**, and the clamp is recorded
//!   ([`Routed::clamp`]) so the thread can say the run was capped.
//! - **No pick keeps role-based routing**, with work orders capped at
//!   [`ModelTier::MID`](crate::action::ModelTier::MID). Judgement still takes the provider default
//!   — the owner's own strong model — which is §6's whole argument: *"judgement calls are a small
//!   share of tokens and carry most of the quality"*.
//!
//! This replaces the reading recorded in [`RunSpec::model`](crate::loop_::RunSpec::model) up to
//! `bf036d6`, under which `Some` was *"honoured literally, by every child"*. That reading made the
//! pick a floor as well as a ceiling: an order the planner tiered `haiku` was billed at whatever
//! the owner had picked, which is the opposite of a throttle.
//!
//! ## The id-to-tier crux, and what an unrecognised pick does
//!
//! The pick is a model **id** (`claude-haiku-4-5`) and an order carries a **tier** (`opus`), so
//! nothing can be clamped until the two are comparable.
//! [`ModelTier::for_model_id`](crate::action::ModelTier::for_model_id) is that mapping.
//!
//! **An id this build does not recognise binds at [`ModelTier::WEAKEST`] rather than widening the
//! ceiling, and the run still starts.** Both halves are deliberate:
//!
//! - Binding at the bottom means every child is clamped to the ceiling, so every child runs on
//!   *exactly the id the owner typed* and no tier can route around it. Treating an unknown id as
//!   "no ceiling" would have let the planner spend freely under a pick the owner made precisely to
//!   stop that — the defect this module exists to remove.
//! - Refusing to start was the other restrictive option and is rejected: model ids turn over every
//!   few months, the dock's list is fixed (`src-tauri/src/views.rs` says so in as many words), and
//!   a harness that will not run at all the week a new model ships is a worse failure than one
//!   that runs everything on the model it was told to use. The unrecognised pick is **recorded on
//!   every order it routes**, so it is visible rather than silent.
//!
//! The one thing an unrecognised pick can do is start a *cheap* order on an *expensive* model —
//! but that model is the one the owner typed, so it is consented spend, and it is exactly what
//! every child did before this module existed.

use crate::action::ModelTier;

/// What one child is started on, and whether anything was capped to get there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Routed {
    /// What goes on `--model`. `None` is the provider default — the owner's own strong model.
    pub model: Option<String>,
    /// The tier actually in force, after the ceiling. Drives the thinking policy too, so a
    /// clamped order does not keep the deliberation budget of the tier it was clamped from.
    pub tier: ModelTier,
    /// One owner-readable line, set **only** when the order's own tier did not survive. Recorded
    /// on the work order's row rather than dropped: a run that quietly spent less than the plan
    /// asked for is still a run whose plan card should say so.
    pub clamp: Option<String>,
}

/// The owner's model pick, read as a ceiling.
///
/// Cheap to clone; one is built per run from [`RunSpec::model`](crate::loop_::RunSpec::model) and
/// is the only thing any call site asks what model to use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ceiling {
    /// The pick, verbatim and trimmed, or `None`.
    pick: Option<String>,
    /// The tier nothing in the run may exceed.
    tier: ModelTier,
    /// Whether [`ModelTier::for_model_id`] read the pick. `false` still bounds — see the module
    /// doc — it just cannot say *how far* the pick is below a tier.
    recognised: bool,
}

impl Ceiling {
    /// Read `pick` as a ceiling.
    ///
    /// `None`, and an all-whitespace string, both mean *no pick*: role-based routing, ceiling at
    /// [`ModelTier::STRONGEST`], and work orders capped at [`ModelTier::MID`] by
    /// [`Ceiling::worker`]. (The empty string is folded in here because the IPC layer already
    /// treats `""` as no pick — `src-tauri/src/commands.rs` filters it — and a second reading of
    /// the same string must not disagree with the first.)
    ///
    /// A pick this build does not recognise binds at [`ModelTier::WEAKEST`], never at the top.
    #[must_use]
    pub fn new(pick: Option<String>) -> Self {
        let Some(id) = pick.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty()) else {
            return Self { pick: None, tier: ModelTier::STRONGEST, recognised: true };
        };
        match ModelTier::for_model_id(&id) {
            Some(tier) => Self { pick: Some(id), tier, recognised: true },
            // The restrictive reading, and the point of this line: an id nobody here knows must
            // clamp everything, never nothing.
            None => Self { pick: Some(id), tier: ModelTier::WEAKEST, recognised: false },
        }
    }

    /// The owner's pick, verbatim, or `None`.
    #[must_use]
    pub fn pick(&self) -> Option<&str> {
        self.pick.as_deref()
    }

    /// The tier nothing in this run exceeds.
    #[must_use]
    pub fn tier(&self) -> ModelTier {
        self.tier
    }

    /// Whether the pick named a model family this build knows.
    #[must_use]
    pub fn recognised(&self) -> bool {
        self.recognised
    }

    /// What a **judgement** call — planner, lead, fixer, reviewer — is started on.
    ///
    /// With a pick, the pick: judgement wants the strongest model it is allowed, and the ceiling
    /// *is* that model. With none, `None` — the provider default, which is the owner's own strong
    /// model and `docs/vision.md` §6's *"judgement gets the strong model"*.
    ///
    /// There is no clamp to record: a judgement call carries no tier of its own, so nothing about
    /// it was capped.
    #[must_use]
    pub fn judgement(&self) -> Option<String> {
        self.pick.clone()
    }

    /// What a **work order** of `tier` is started on, and whether its tier survived.
    ///
    /// Three shapes, and the middle one is the whole change:
    ///
    /// | pick | order tier | started on |
    /// |---|---|---|
    /// | none | `opus` | `sonnet` — capped at mid-tier, **clamped** |
    /// | none | `haiku` | `haiku` |
    /// | `claude-haiku-4-5` | `opus` | `claude-haiku-4-5` — **clamped** |
    /// | `claude-opus-5` | `haiku` | `haiku` — under the ceiling, so it stays cheap |
    /// | `claude-opus-5` | `opus` | `claude-opus-5` — at the ceiling, so the exact id is used |
    /// | unrecognised | any | the pick, **clamped**, whatever the tier said |
    ///
    /// An order at or above the ceiling is started on the pick's **own id** rather than the
    /// ceiling tier's slug, so the owner is billed for the model they named and not for whatever
    /// `opus` happens to alias to that week.
    #[must_use]
    pub fn worker(&self, tier: ModelTier) -> Routed {
        let Some(pick) = self.pick.as_deref() else {
            // No pick: §6's role-based routing, with the work-order lane capped at mid-tier so the
            // planner cannot reach the top on its own say-so.
            let effective = tier.min(ModelTier::MID);
            let clamp = (effective != tier).then(|| {
                format!(
                    "model: order tier `{}` capped at `{}` — with no model picked for the run, \
                     work orders do not exceed mid-tier",
                    tier.as_slug(),
                    effective.as_slug()
                )
            });
            return Routed { model: Some(effective.as_slug().to_owned()), tier: effective, clamp };
        };

        if !self.recognised {
            // Bound, not widened: the pick clamps every order regardless of tier, so it is the
            // model and the tier did not apply. Said out loud on every order rather than once,
            // because the plan card is per order.
            return Routed {
                model: Some(pick.to_owned()),
                tier: self.tier,
                clamp: Some(format!(
                    "model: the run's pick `{pick}` is not a model this build recognises, so it \
                     binds as the ceiling for every child and order tier `{}` did not apply",
                    tier.as_slug()
                )),
            };
        }

        let effective = tier.min(self.tier);
        if effective == self.tier {
            Routed {
                model: Some(pick.to_owned()),
                tier: effective,
                clamp: (tier > self.tier).then(|| {
                    format!(
                        "model: order tier `{}` capped at the run's pick `{pick}` (`{}`)",
                        tier.as_slug(),
                        self.tier.as_slug()
                    )
                }),
            }
        } else {
            // Below the ceiling. A ceiling is not a floor: the order keeps its own cheaper tier.
            Routed { model: Some(effective.as_slug().to_owned()), tier: effective, clamp: None }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ceiling(pick: &str) -> Ceiling {
        Ceiling::new(Some(pick.to_owned()))
    }

    #[test]
    fn no_pick_leaves_judgement_on_the_provider_default() {
        let c = Ceiling::new(None);
        assert_eq!(c.judgement(), None, "the provider default is the owner's strong model");
        assert_eq!(c.tier(), ModelTier::STRONGEST);
        assert!(c.recognised());
        assert_eq!(c.pick(), None);
    }

    /// The defect this module was written for: with no pick, a planner that tiers an order `opus`
    /// used to reach `--model opus` unbounded.
    #[test]
    fn no_pick_caps_a_work_order_at_mid_tier_and_records_the_clamp() {
        let c = Ceiling::new(None);
        let routed = c.worker(ModelTier::Opus);
        assert_eq!(routed.model.as_deref(), Some("sonnet"));
        assert_eq!(routed.tier, ModelTier::Sonnet);
        let clamp = routed.clamp.expect("the cap is recorded, not silent");
        assert!(clamp.contains("opus"), "{clamp}");
        assert!(clamp.contains("sonnet"), "{clamp}");
    }

    #[test]
    fn no_pick_leaves_an_order_at_or_below_mid_tier_alone() {
        let c = Ceiling::new(None);
        for (tier, want) in [(ModelTier::Sonnet, "sonnet"), (ModelTier::Haiku, "haiku")] {
            let routed = c.worker(tier);
            assert_eq!(routed.model.as_deref(), Some(want));
            assert_eq!(routed.tier, tier);
            assert_eq!(routed.clamp, None, "nothing was capped");
        }
    }

    /// The owner's sentence, made a test: *"picking Haiku means nothing in the run exceeds
    /// Haiku."*
    #[test]
    fn a_haiku_pick_clamps_every_lane_to_haiku() {
        let c = ceiling("claude-haiku-4-5");
        assert_eq!(c.tier(), ModelTier::Haiku);
        assert_eq!(c.judgement().as_deref(), Some("claude-haiku-4-5"));
        for tier in ModelTier::ALL {
            let routed = c.worker(tier);
            assert_eq!(routed.model.as_deref(), Some("claude-haiku-4-5"), "{tier:?}");
            assert_eq!(routed.tier, ModelTier::Haiku, "{tier:?}");
            assert_eq!(
                routed.clamp.is_some(),
                tier > ModelTier::Haiku,
                "{tier:?} — a clamp is recorded exactly when one happened"
            );
        }
    }

    /// A ceiling is not a floor. This is the half that differs from the pre-`bf036d6` reading, in
    /// which the pick was honoured literally by every child.
    #[test]
    fn an_order_below_the_ceiling_keeps_its_own_cheaper_tier() {
        let c = ceiling("claude-opus-5");
        assert_eq!(c.worker(ModelTier::Haiku).model.as_deref(), Some("haiku"));
        assert_eq!(c.worker(ModelTier::Haiku).clamp, None);
        assert_eq!(c.worker(ModelTier::Sonnet).model.as_deref(), Some("sonnet"));
        // At the ceiling, the owner's own id rather than the `opus` alias.
        assert_eq!(c.worker(ModelTier::Opus).model.as_deref(), Some("claude-opus-5"));
        assert_eq!(c.worker(ModelTier::Opus).clamp, None, "at the ceiling is not over it");
    }

    #[test]
    fn a_sonnet_pick_clamps_opus_and_leaves_haiku_alone() {
        let c = ceiling("sonnet");
        assert_eq!(c.tier(), ModelTier::Sonnet);
        let clamped = c.worker(ModelTier::Opus);
        assert_eq!(clamped.model.as_deref(), Some("sonnet"));
        assert_eq!(clamped.tier, ModelTier::Sonnet);
        assert!(clamped.clamp.is_some());
        assert_eq!(c.worker(ModelTier::Haiku).model.as_deref(), Some("haiku"));
        assert_eq!(c.worker(ModelTier::Haiku).clamp, None);
    }

    /// The restrictive reading, and the one that must never quietly become "no ceiling".
    #[test]
    fn an_unrecognised_pick_binds_at_the_bottom_rather_than_widening_the_ceiling() {
        let c = ceiling("claude-quokka-9");
        assert!(!c.recognised());
        assert_eq!(c.tier(), ModelTier::WEAKEST, "it clamps everything, never nothing");
        assert_eq!(c.judgement().as_deref(), Some("claude-quokka-9"));
        for tier in ModelTier::ALL {
            let routed = c.worker(tier);
            assert_eq!(
                routed.model.as_deref(),
                Some("claude-quokka-9"),
                "{tier:?} — no tier routes around an unrecognised pick"
            );
            let clamp = routed.clamp.expect("an unrecognised pick is recorded on every order");
            assert!(clamp.contains("claude-quokka-9"), "{clamp}");
            assert!(clamp.contains("not a model this build recognises"), "{clamp}");
        }
    }

    /// The negative control for the test above: an unrecognised pick must not fall back to the
    /// no-pick lane, where a work order would be routed to a *tier slug* the owner never chose.
    #[test]
    fn an_unrecognised_pick_is_not_the_same_as_no_pick() {
        let unknown = ceiling("claude-quokka-9");
        let none = Ceiling::new(None);
        assert_ne!(unknown.worker(ModelTier::Opus).model, none.worker(ModelTier::Opus).model);
        assert_ne!(unknown.judgement(), none.judgement());
    }

    #[test]
    fn an_empty_or_blank_pick_is_no_pick_and_not_an_unrecognised_one() {
        for blank in ["", "   ", "\t\n"] {
            let c = Ceiling::new(Some(blank.to_owned()));
            assert_eq!(c, Ceiling::new(None), "{blank:?}");
            assert!(c.recognised(), "{blank:?} — nothing was named, so nothing failed to parse");
        }
    }

    #[test]
    fn a_pick_is_trimmed_but_otherwise_passed_through_verbatim() {
        let c = ceiling("  claude-haiku-4-5  ");
        assert_eq!(c.pick(), Some("claude-haiku-4-5"));
        assert_eq!(c.judgement().as_deref(), Some("claude-haiku-4-5"));
    }

    /// Fable is above Opus on the price list, so a fable pick bounds nothing a planner can ask
    /// for — and a cheap order still stays cheap under it.
    #[test]
    fn a_fable_pick_is_a_ceiling_at_the_top_tier() {
        let c = ceiling("claude-fable-5-1");
        assert_eq!(c.tier(), ModelTier::STRONGEST);
        assert_eq!(c.worker(ModelTier::Opus).model.as_deref(), Some("claude-fable-5-1"));
        assert_eq!(c.worker(ModelTier::Opus).clamp, None);
        assert_eq!(c.worker(ModelTier::Haiku).model.as_deref(), Some("haiku"));
    }

    /// The exact model the 2026-09-05 run was billed for, read as a ceiling.
    #[test]
    fn the_bracketed_cli_alias_is_read_as_its_family() {
        assert_eq!(ceiling("opus[1m]").tier(), ModelTier::Opus);
        assert_eq!(ceiling("claude-opus-5[1m]").tier(), ModelTier::Opus);
        assert!(ceiling("claude-opus-5[1m]").recognised());
    }

    /// Nothing this type returns may ever exceed the ceiling, whatever the planner asked for.
    #[test]
    fn no_pick_and_no_tier_combination_exceeds_the_ceiling() {
        let picks = [None, Some("claude-haiku-4-5"), Some("sonnet"), Some("opus"), Some("nope-1")];
        for pick in picks {
            let c = Ceiling::new(pick.map(str::to_owned));
            for tier in ModelTier::ALL {
                let routed = c.worker(tier);
                assert!(routed.tier <= c.tier(), "{pick:?}/{tier:?} escaped the ceiling");
                if c.pick().is_none() {
                    assert!(routed.tier <= ModelTier::MID, "{tier:?} escaped the mid-tier cap");
                }
                // A clamp is recorded exactly when the order did not get the tier it asked for.
                assert_eq!(
                    routed.clamp.is_some(),
                    routed.tier != tier || !c.recognised(),
                    "{pick:?}/{tier:?}"
                );
            }
        }
    }
}
