//! The static routing table (Phase 3) and matching its entries against a live model catalog.

use brigadier_providers::{ModelInfo, ProviderKind};

use crate::TaskCategory;

/// A model class, matched against the live catalog by family name, so a renamed or newer
/// model of the same family is picked up without a code change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Tier {
    /// Claude Opus, Codex `*-astra`.
    Strong,
    /// Claude Sonnet, Codex `*-sol` (then the older `*-terra`).
    Balanced,
    /// Claude Haiku, Codex `*-luna`.
    Fast,
}

impl Tier {
    const ALL: [Tier; 3] = [Tier::Strong, Tier::Balanced, Tier::Fast];

    /// Family names, best first. A model belongs to a family when one of the words of its id
    /// (or of the concrete model its alias resolves to) is the family name.
    pub(crate) fn families(self, provider: ProviderKind) -> &'static [&'static str] {
        match (provider, self) {
            (ProviderKind::Claude, Tier::Strong) => &["opus"],
            (ProviderKind::Claude, Tier::Balanced) => &["sonnet"],
            (ProviderKind::Claude, Tier::Fast) => &["haiku"],
            (ProviderKind::Codex, Tier::Strong) => &["astra"],
            (ProviderKind::Codex, Tier::Balanced) => &["sol", "terra"],
            (ProviderKind::Codex, Tier::Fast) => &["luna"],
        }
    }

    /// The tier a model belongs to, if any.
    pub(crate) fn of(provider: ProviderKind, model: &ModelInfo) -> Option<Tier> {
        Tier::ALL.into_iter().find(|tier| {
            tier.families(provider)
                .iter()
                .any(|family| in_family(model, family))
        })
    }
}

/// Which model an entry wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pick {
    Tier(Tier),
    /// The model the CLI marks as its default.
    Default,
}

/// One candidate in a row: a model class and the reasoning effort to run it at.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Entry {
    pub(crate) pick: Pick,
    /// `None`: the model's own default.
    pub(crate) effort: Option<&'static str>,
}

/// The routing of one task category.
pub(crate) struct Row {
    /// Vendor order when both are usable and equally busy.
    pub(crate) order: [ProviderKind; 2],
    pub(crate) claude: &'static [Entry],
    pub(crate) codex: &'static [Entry],
    /// What the task is, for the reason sentence ("for review").
    pub(crate) purpose: &'static str,
    /// Why this class of model, for the reason sentence.
    pub(crate) why: &'static str,
}

impl Row {
    pub(crate) fn entries(&self, provider: ProviderKind) -> &'static [Entry] {
        match provider {
            ProviderKind::Claude => self.claude,
            ProviderKind::Codex => self.codex,
        }
    }
}

const fn tier(tier: Tier, effort: &'static str) -> Entry {
    Entry {
        pick: Pick::Tier(tier),
        effort: Some(effort),
    }
}

const CLAUDE_FIRST: [ProviderKind; 2] = [ProviderKind::Claude, ProviderKind::Codex];
const CODEX_FIRST: [ProviderKind; 2] = [ProviderKind::Codex, ProviderKind::Claude];

/// The table. See the crate docs for the reasoning behind each row.
pub(crate) fn row(category: TaskCategory) -> &'static Row {
    match category {
        TaskCategory::Scout => &SCOUT,
        TaskCategory::Research => &RESEARCH,
        TaskCategory::Implement => &IMPLEMENT,
        TaskCategory::Review => &REVIEW,
        TaskCategory::Merge => &MERGE,
        TaskCategory::Verify => &VERIFY,
        TaskCategory::Chat => &CHAT,
    }
}

const SCOUT: Row = Row {
    order: CODEX_FIRST,
    claude: &[
        tier(Tier::Balanced, "low"),
        Entry {
            pick: Pick::Tier(Tier::Fast),
            effort: None,
        },
    ],
    codex: &[tier(Tier::Fast, "low"), tier(Tier::Balanced, "low")],
    purpose: "scouting",
    why: "a fast model is enough to look around a repo",
};

const RESEARCH: Row = Row {
    order: CODEX_FIRST,
    claude: &[tier(Tier::Balanced, "medium")],
    codex: &[tier(Tier::Fast, "medium"), tier(Tier::Balanced, "low")],
    purpose: "research",
    why: "an efficient model reads and summarizes sources well at moderate cost",
};

const IMPLEMENT: Row = Row {
    order: CLAUDE_FIRST,
    claude: &[tier(Tier::Strong, "medium")],
    codex: &[tier(Tier::Balanced, "medium"), tier(Tier::Strong, "medium")],
    purpose: "implementation",
    why: "a strong coding model",
};

const REVIEW: Row = Row {
    order: CODEX_FIRST,
    claude: &[tier(Tier::Strong, "high"), tier(Tier::Balanced, "high")],
    codex: &[tier(Tier::Strong, "high"), tier(Tier::Balanced, "high")],
    purpose: "review",
    why: "reviews get the vendor's strongest model",
};

const MERGE: Row = Row {
    order: CLAUDE_FIRST,
    claude: &[tier(Tier::Strong, "high")],
    codex: &[tier(Tier::Balanced, "high"), tier(Tier::Strong, "high")],
    purpose: "conflict resolution",
    why: "resolving conflicts needs a strong coding model",
};

const VERIFY: Row = Row {
    order: CODEX_FIRST,
    claude: &[tier(Tier::Balanced, "low")],
    codex: &[tier(Tier::Fast, "medium"), tier(Tier::Balanced, "low")],
    purpose: "verification",
    why: "running the checks and reporting what they showed needs little reasoning",
};

const CHAT: Row = Row {
    order: CLAUDE_FIRST,
    claude: &[Entry {
        pick: Pick::Default,
        effort: None,
    }],
    codex: &[Entry {
        pick: Pick::Default,
        effort: None,
    }],
    purpose: "chat",
    why: "the CLI's default model",
};

// ----- matching the live catalog ----------------------------------------------------------

/// The words of a model id: `gpt-5.6-sol` → `gpt`, `5.6`, `sol`; `opus[1m]` → `opus`, `1m`.
fn words(id: &str) -> impl Iterator<Item = &str> {
    id.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.'))
        .filter(|word| !word.is_empty())
}

fn has_word(id: &str, word: &str) -> bool {
    words(id).any(|candidate| candidate.eq_ignore_ascii_case(word))
}

fn in_family(model: &ModelInfo, family: &str) -> bool {
    has_word(&model.id, family)
        || model
            .resolved
            .as_deref()
            .is_some_and(|r| has_word(r, family))
}

/// Whether a model name (as asked for, without a catalog entry) names a Fable model.
pub(crate) fn names_fable(name: &str) -> bool {
    has_word(name, "fable")
}

/// Fable models are never routed to (the user's rule), whatever the catalog says.
pub(crate) fn is_fable(model: &ModelInfo) -> bool {
    has_word(&model.id, "fable")
        || has_word(&model.display_name, "fable")
        || model
            .resolved
            .as_deref()
            .is_some_and(|resolved| has_word(resolved, "fable"))
}

/// What a model actually is: the concrete model an alias resolves to, else its id. Claude's
/// `default` and `opus[1m]` are the same model.
pub(crate) fn identity(model: &ModelInfo) -> String {
    model
        .resolved
        .as_deref()
        .unwrap_or(&model.id)
        .to_ascii_lowercase()
}

/// The routable models of a catalog: every model except Fable ones, in catalog order (the CLI
/// lists its newest and preferred models first).
pub(crate) fn routable(models: &[ModelInfo]) -> impl Iterator<Item = &ModelInfo> {
    models.iter().filter(|model| !is_fable(model))
}

/// The first routable model of a tier, preferring models whose own id names the family over
/// aliases that merely resolve to it (so `opus[1m]` wins over `default`).
pub(crate) fn find_tier<'m>(
    provider: ProviderKind,
    models: &'m [ModelInfo],
    tier: Tier,
    excluded: Option<&str>,
) -> Option<&'m ModelInfo> {
    let allowed = |model: &&ModelInfo| excluded.is_none_or(|ex| identity(model) != ex);
    for family in tier.families(provider) {
        let by_id = routable(models)
            .filter(allowed)
            .find(|model| has_word(&model.id, family));
        let found = by_id.or_else(|| {
            routable(models)
                .filter(allowed)
                .find(|model| in_family(model, family))
        });
        if found.is_some() {
            return found;
        }
    }
    None
}

/// The CLI's default model, if routable and not excluded.
pub(crate) fn find_default<'m>(
    models: &'m [ModelInfo],
    excluded: Option<&str>,
) -> Option<&'m ModelInfo> {
    routable(models)
        .find(|model| model.is_default && excluded.is_none_or(|ex| identity(model) != ex))
}

/// A model asked for by name: its exact id, a model the name resolves to, or (for a family
/// name like `opus` or `sol`) the first model of that family.
pub(crate) fn find_named<'m>(models: &'m [ModelInfo], name: &str) -> Option<&'m ModelInfo> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    models
        .iter()
        .find(|model| model.id == name)
        .or_else(|| {
            models
                .iter()
                .find(|model| model.id.eq_ignore_ascii_case(name))
        })
        .or_else(|| {
            // An alias other than the CLI's `default` first: `default` follows the user's
            // own CLI setting, the named alias does not.
            let (named, default): (Vec<&ModelInfo>, Vec<&ModelInfo>) =
                models.iter().partition(|model| !model.is_default);
            named.into_iter().chain(default).find(|model| {
                model
                    .resolved
                    .as_deref()
                    .is_some_and(|resolved| resolved.to_ascii_lowercase().starts_with(&lower))
            })
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| model.id.to_ascii_lowercase().starts_with(&lower))
        })
        .or_else(|| {
            models
                .iter()
                .find(|model| !name.contains(['-', '.']) && in_family(model, name))
        })
}

// ----- reasoning effort -------------------------------------------------------------------

/// The highest effort Brigadier ever routes to.
pub(crate) const MAX_EFFORT: &str = "high";

/// Effort levels by strength; `None` for a level Brigadier doesn't know.
fn rank(effort: &str) -> Option<u8> {
    Some(match effort.to_ascii_lowercase().as_str() {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" => 5,
        "max" => 6,
        "ultra" => 7,
        _ => return None,
    })
}

/// The effort to run at: `wanted`, capped at [`MAX_EFFORT`] and at what the model accepts
/// (the strongest accepted level not above it, else the weakest accepted one). `None` when
/// nothing is wanted, the level is unknown, or the model has no effort control. Returns
/// whether the level was lowered.
pub(crate) fn fit_effort(
    model: Option<&ModelInfo>,
    wanted: Option<&str>,
) -> (Option<String>, bool) {
    let Some(wanted) = wanted else {
        return (None, false);
    };
    let Some(wanted_rank) = rank(wanted) else {
        return (None, false);
    };
    let cap = rank(MAX_EFFORT).unwrap_or(u8::MAX);
    let target = wanted_rank.min(cap);
    let Some(model) = model else {
        // No catalog: pass a standard level through, capped.
        let effort = if wanted_rank > cap {
            MAX_EFFORT.to_owned()
        } else {
            wanted.to_ascii_lowercase()
        };
        return (Some(effort), wanted_rank > cap);
    };
    if model.efforts.is_empty() {
        return (None, false);
    }
    let accepted = || {
        model
            .efforts
            .iter()
            .filter_map(|effort| rank(effort).map(|rank| (rank, effort)))
            .filter(|(rank, _)| *rank <= cap)
    };
    let chosen = accepted()
        .filter(|(rank, _)| *rank <= target)
        .max_by_key(|(rank, _)| *rank)
        .or_else(|| accepted().min_by_key(|(rank, _)| *rank));
    match chosen {
        Some((rank, effort)) => (Some(effort.clone()), rank < wanted_rank),
        None => (None, false),
    }
}
