//! Choosing the provider, model and reasoning effort for each piece of work.
//!
//! Phase 3 routes with a **static table** (docs/PLAN.md §6 Phase 3); capability scores,
//! outcome learning and quota balancing replace it in Phase 5. The orchestrator's own vendor
//! is never an input (§2 principle 3): a request only carries the task category, what each
//! provider can offer right now, an optional pin and, for reviews, the author to avoid.
//!
//! # The table
//!
//! | Category       | Tie order     | Claude                          | Codex                                   |
//! |----------------|---------------|---------------------------------|-----------------------------------------|
//! | Scout          | Codex, Claude | Sonnet low → Haiku              | `*-luna` low → `*-sol` low              |
//! | Research       | Codex, Claude | Sonnet medium                   | `*-luna` medium → `*-sol` low           |
//! | Implement      | Claude, Codex | Opus medium                     | `*-sol` medium → `*-astra` medium       |
//! | Review         | Codex, Claude | Opus high → Sonnet high         | `*-astra` high → `*-sol` high           |
//! | Merge          | Claude, Codex | Opus high                       | `*-sol` high → `*-astra` high           |
//! | Verify         | Codex, Claude | Sonnet low                      | `*-luna` medium → `*-sol` low           |
//! | Chat           | Claude, Codex | the CLI's default model         | the CLI's default model                 |
//!
//! - **Models come from the live catalog.** An entry names a model family (Claude's `opus`,
//!   `sonnet`, `haiku` aliases; Codex's `astra`, `sol`, `luna` lines) and matches the first
//!   model in the CLI's own list whose id has that word (then one whose alias resolves to it),
//!   so `gpt-6-sol` is preferred over `gpt-5.6-sol` and a new `gpt-6.1-sol` is picked up
//!   unchanged. When no entry matches, the CLI's default model is used, then its first model;
//!   with no catalog at all, the CLI's default (`model: None`). A renamed model never breaks
//!   routing.
//! - **Never Fable, never above `high`.** Fable models are filtered out of every catalog and
//!   every pin; efforts are capped at `high` and at what the model accepts.
//! - **Which vendor.** Only usable providers are candidates. A review avoids the vendor that
//!   wrote the change; if that vendor is the only one usable, a *different model* of it
//!   reviews (`cross_vendor: Some(false)`, said in the reason). Otherwise a pinned provider
//!   wins; otherwise the provider with fewer running workers ([`RouteRequest::running`]), so
//!   parallel work spreads across both vendors and their quotas; a tie follows the row order.
//! - **Tie orders.** Write work (implement, merge) starts on Claude and read-only work (scout,
//!   research, verify) on Codex, so in a typical session the two draw on different quotas and
//!   every write lands on a vendor whose change the other one reviews. Opus is Claude's strongest
//!   routable coding model; for Codex, `*-sol` is its coding workhorse and `*-astra` (its
//!   frontier model) is kept for reviews. Claude's scouts use Sonnet at low effort rather than
//!   Haiku, which is a generation older; Haiku is the fallback.
//! - **Chat fallback** ([`fallback`]): after a usage limit, the other vendor's model of the same
//!   class (Opus ↔ `*-astra`, Sonnet ↔ `*-sol`, Haiku ↔ `*-luna`), keeping the effort where the
//!   model accepts it.

mod table;

use brigadier_providers::{ModelInfo, ProviderKind};

use table::{Entry, Pick, Tier};

/// What a piece of work is, for routing. Mirrors the core's task kinds plus plain Chats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskCategory {
    /// Looks around the repository and answers a question.
    Scout,
    /// Reads docs and the web.
    Research,
    /// Changes code; lands as one commit.
    Implement,
    /// Reviews another task's candidate commit or a plan.
    Review,
    /// Resolves conflicts between a task and its target branch.
    Merge,
    /// Runs the project's checks.
    Verify,
    /// A plain conversation with the model (no orchestrator, no workers).
    Chat,
}

impl TaskCategory {
    pub const ALL: [TaskCategory; 7] = [
        TaskCategory::Scout,
        TaskCategory::Research,
        TaskCategory::Implement,
        TaskCategory::Review,
        TaskCategory::Merge,
        TaskCategory::Verify,
        TaskCategory::Chat,
    ];
}

impl std::fmt::Display for TaskCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(table::row(*self).purpose)
    }
}

/// What one provider can offer right now.
#[derive(Debug, Clone, PartialEq)]
pub struct Availability {
    pub provider: ProviderKind,
    /// Installed, logged in and not at a usage limit.
    pub usable: bool,
    /// Its live model catalog, in the CLI's order. Empty when not fetched yet.
    pub models: Vec<ModelInfo>,
}

/// A provider, model or effort asked for by the orchestrator (`delegate_task`) or the user.
/// Every part is optional; what is left out is routed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pin {
    pub provider: Option<ProviderKind>,
    /// A model id from the provider's list, an alias (`opus`) or a family name (`sol`). A model
    /// alone also picks its provider.
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// The model that wrote the change a review is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub provider: ProviderKind,
    /// Its model id; `None` for the CLI's default model.
    pub model: Option<String>,
}

/// One routing question.
#[derive(Debug, Clone)]
pub struct RouteRequest<'a> {
    pub category: TaskCategory,
    pub available: &'a [Availability],
    pub pin: Option<Pin>,
    /// For reviews: route away from this vendor, or at least from this model.
    pub avoid: Option<Author>,
    /// Workers each provider is running now, for spreading parallel work. Missing providers
    /// count as zero; an empty slice makes ties follow the table order.
    pub running: &'a [(ProviderKind, u32)],
}

/// Where the work runs, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub provider: ProviderKind,
    /// The model id to pass to the CLI; `None` for the CLI's default.
    pub model: Option<String>,
    /// The reasoning effort; `None` for the model's default.
    pub effort: Option<String>,
    /// A short sentence for the worker card ("why this model").
    pub reason: String,
    /// For reviews (`avoid` set): whether the reviewer's vendor differs from the author's.
    pub cross_vendor: Option<bool>,
}

/// No provider can take the work.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "no provider can take this {category} work: Claude and Codex are both unavailable (not \
     logged in or at their usage limit)"
)]
pub struct NoRoute {
    pub category: TaskCategory,
}

/// Routes one piece of work. See the crate docs for the table and the rules.
pub fn route(request: &RouteRequest) -> Result<Choice, NoRoute> {
    let row = table::row(request.category);
    let usable: Vec<ProviderKind> = row
        .order
        .into_iter()
        .filter(|provider| find(request.available, *provider).is_some_and(|a| a.usable))
        .collect();
    if usable.is_empty() {
        return Err(NoRoute {
            category: request.category,
        });
    }
    let pin = request.pin.clone().unwrap_or_default();
    let mut notes: Vec<String> = Vec::new();

    // 1. Reviews go to the vendor that did not write the change, when it is usable.
    let mut candidates = usable.clone();
    let mut cross_vendor = None;
    if let Some(author) = &request.avoid {
        let others: Vec<ProviderKind> = usable
            .iter()
            .copied()
            .filter(|provider| *provider != author.provider)
            .collect();
        if others.is_empty() {
            cross_vendor = Some(false);
        } else {
            cross_vendor = Some(true);
            candidates = others;
        }
    }

    // 2. A pinned provider (or the provider of a pinned model), if allowed.
    let pinned = pin.provider.or_else(|| {
        let name = pin.model.as_deref()?;
        ProviderKind::ALL.into_iter().find(|provider| {
            find(request.available, *provider)
                .is_some_and(|a| table::find_named(&a.models, name).is_some())
        })
    });
    let provider = match pinned {
        Some(wanted) if candidates.contains(&wanted) => wanted,
        Some(wanted) => {
            let fallback = pick_by_load(&candidates, request.running);
            if usable.contains(&wanted) {
                notes.push(format!(
                    "{} was asked for, but it wrote the change under review",
                    name(wanted)
                ));
            } else {
                notes.push(format!(
                    "{} was asked for, but it is unavailable (not logged in or at its usage limit)",
                    name(wanted)
                ));
            }
            fallback
        }
        None => {
            let chosen = pick_by_load(&candidates, request.running);
            if let Some(note) = vendor_note(request, &usable, &candidates, chosen, cross_vendor) {
                notes.push(note);
            }
            chosen
        }
    };
    let models = find(request.available, provider)
        .map(|a| a.models.as_slice())
        .unwrap_or_default();

    // 3. The model: a pin for this provider, else the table, never the author's own model when
    //    a review stays with its vendor (unless it is the only model there is).
    let excluded = match (&request.avoid, cross_vendor) {
        (Some(author), Some(false)) => Some(author_identity(author, models)),
        _ => None,
    };
    let wants_model = pin.model.is_some() && pinned.is_none_or(|wanted| wanted == provider);
    let pinned_model = if wants_model {
        pinned_model(models, pin.model.as_deref(), provider, &mut notes)
    } else {
        None
    };
    // A pinned model still runs at the row's effort unless the pin says otherwise.
    let row_effort = row.entries(provider).first().and_then(|entry| entry.effort);
    let unchecked = pin.model.clone().filter(|name| {
        models.is_empty() && pin.provider == Some(provider) && !table::names_fable(name)
    });
    let (info, model_id, entry_effort, model_why) = match (pinned_model, unchecked) {
        (Some(model), _) => (
            Some(model),
            Some(model.id.clone()),
            row_effort,
            "as requested".to_owned(),
        ),
        // No catalog to check the name against: trust the pin.
        (None, Some(name)) => (
            None,
            Some(name),
            row_effort,
            "as requested (unchecked: the model list isn't loaded yet)".to_owned(),
        ),
        (None, None) => {
            let (model, effort, why) = table_model(row, provider, models, excluded.as_deref());
            (model, model.map(|model| model.id.clone()), effort, why)
        }
    };
    if let (Some(author), Some(false)) = (&request.avoid, cross_vendor) {
        let author_model = author.model.as_deref().unwrap_or("its default model");
        let same = info.is_some() && info.map(table::identity) == excluded;
        notes.push(if info.is_none() {
            format!(
                "not a cross-vendor review: {} is the only vendor available",
                name(provider)
            )
        } else if same && pinned_model.is_some() {
            "not a cross-vendor review: the author's own model reviews its change, as requested"
                .to_owned()
        } else if same {
            format!(
                "not a cross-vendor review: {} is the only vendor available and has no other \
                 model, so the author's model reviews its own change",
                name(provider)
            )
        } else {
            format!(
                "not a cross-vendor review: {} is the only vendor available, so a different \
                 model than the author's ({author_model}) reviews",
                name(provider)
            )
        });
    }

    // 4. The effort: the pin's, else the entry's; capped at `high` and at what the model takes.
    let wanted = pin.effort.as_deref().or(entry_effort);
    let (effort, lowered) = table::fit_effort(info, wanted);
    if lowered && pin.effort.is_some() {
        notes.push(format!(
            "effort lowered from {} to {}",
            pin.effort.as_deref().unwrap_or_default(),
            effort.as_deref().unwrap_or("the default")
        ));
    }

    Ok(Choice {
        provider,
        reason: sentence(
            provider,
            model_id.as_deref(),
            effort.as_deref(),
            row.purpose,
            &model_why,
            &notes,
        ),
        model: model_id,
        effort,
        cross_vendor,
    })
}

/// Chat fallback after a usage limit: the other vendor's closest model (same class as `from`'s,
/// else the `category` row's pick), keeping `from`'s effort where the model accepts it.
/// `None` when the other vendor is not usable.
pub fn fallback(
    from: &Choice,
    category: TaskCategory,
    available: &[Availability],
) -> Option<Choice> {
    let to = ProviderKind::ALL
        .into_iter()
        .find(|provider| *provider != from.provider)?;
    let target = find(available, to).filter(|a| a.usable)?;
    let source_models = find(available, from.provider)
        .map(|a| a.models.as_slice())
        .unwrap_or_default();
    let source = match from.model.as_deref() {
        Some(id) => table::find_named(source_models, id),
        None => table::find_default(source_models, None),
    };
    let tier = source
        .and_then(|model| Tier::of(from.provider, model))
        // Not in the catalog (or none loaded): classify the id itself.
        .or_else(|| Tier::of_names(from.provider, from.model.as_deref()?, None));

    let row = table::row(category);
    let (model, effort_wanted, why) = match tier
        .and_then(|tier| table::find_tier(to, &target.models, tier, None).map(|m| (tier, m)))
    {
        Some((_, model)) => {
            let what = from.model.as_deref().unwrap_or("its default model");
            (
                Some(model),
                from.effort.as_deref(),
                format!(
                    "the closest match to {} {what}, which is at its usage limit",
                    name(from.provider)
                ),
            )
        }
        None => {
            let (model, effort, _) = table_model(row, to, &target.models, None);
            (
                model,
                from.effort.as_deref().or(effort),
                format!("{} is at its usage limit", name(from.provider)),
            )
        }
    };
    let (effort, _) = table::fit_effort(model, effort_wanted);
    let model_id = model.map(|model| model.id.clone());
    Some(Choice {
        provider: to,
        reason: sentence(
            to,
            model_id.as_deref(),
            effort.as_deref(),
            row.purpose,
            &why,
            &[],
        ),
        model: model_id,
        effort,
        // Switching vendors flips whether a review is cross-vendor.
        cross_vendor: from.cross_vendor.map(|cross| !cross),
    })
}

// ----- helpers ------------------------------------------------------------------------------

fn find(available: &[Availability], provider: ProviderKind) -> Option<&Availability> {
    available.iter().find(|a| a.provider == provider)
}

/// The short vendor name used in reasons.
fn name(provider: ProviderKind) -> &'static str {
    match provider {
        ProviderKind::Claude => "Claude",
        ProviderKind::Codex => "Codex",
    }
}

/// The candidate with the fewest running workers; ties keep the table order.
fn pick_by_load(candidates: &[ProviderKind], running: &[(ProviderKind, u32)]) -> ProviderKind {
    let load = |provider: ProviderKind| {
        running
            .iter()
            .find(|(kind, _)| *kind == provider)
            .map_or(0, |(_, count)| *count)
    };
    candidates
        .iter()
        .copied()
        .min_by_key(|provider| load(*provider))
        .unwrap_or(candidates[0])
}

/// Why this vendor, when it was not simply pinned.
fn vendor_note(
    request: &RouteRequest,
    usable: &[ProviderKind],
    candidates: &[ProviderKind],
    chosen: ProviderKind,
    cross_vendor: Option<bool>,
) -> Option<String> {
    let other = ProviderKind::ALL.into_iter().find(|p| *p != chosen)?;
    if !usable.contains(&other) {
        return Some(format!(
            "{} is unavailable (not logged in or at its usage limit)",
            name(other)
        ));
    }
    if cross_vendor == Some(true) {
        return Some(format!("{} wrote the change", name(other)));
    }
    let load = |provider: ProviderKind| {
        request
            .running
            .iter()
            .find(|(kind, _)| *kind == provider)
            .map_or(0, |(_, count)| *count)
    };
    if candidates.len() > 1 && load(other) > load(chosen) {
        let count = load(other);
        return Some(format!(
            "{} already runs {count} worker{}",
            name(other),
            if count == 1 { "" } else { "s" }
        ));
    }
    None
}

/// The identity of the author's model, resolved through the catalog when possible.
fn author_identity(author: &Author, models: &[ModelInfo]) -> String {
    let model = match author.model.as_deref() {
        Some(id) => table::find_named(models, id),
        None => table::find_default(models, None),
    };
    match (model, author.model.as_deref()) {
        (Some(model), _) => table::identity(model),
        (None, Some(id)) => id.to_ascii_lowercase(),
        (None, None) => String::new(),
    }
}

/// Resolves a pinned model in this provider's catalog, or explains why it was not used.
fn pinned_model<'m>(
    models: &'m [ModelInfo],
    wanted: Option<&str>,
    provider: ProviderKind,
    notes: &mut Vec<String>,
) -> Option<&'m ModelInfo> {
    let wanted = wanted?;
    match table::find_named(models, wanted) {
        Some(model) if table::is_fable(model) => {
            notes.push(format!(
                "{wanted} was asked for, but Fable models are never used"
            ));
            None
        }
        Some(model) => Some(model),
        None if models.is_empty() => None,
        None => {
            notes.push(format!(
                "{wanted} was asked for, but it is not in {}'s model list",
                name(provider)
            ));
            None
        }
    }
}

/// The row's model for this provider, with its effort and a phrase saying why.
fn table_model<'m>(
    row: &table::Row,
    provider: ProviderKind,
    models: &'m [ModelInfo],
    excluded: Option<&str>,
) -> (Option<&'m ModelInfo>, Option<&'static str>, String) {
    let entries: &[Entry] = row.entries(provider);
    for entry in entries {
        let found = match entry.pick {
            Pick::Tier(tier) => table::find_tier(provider, models, tier, excluded),
            Pick::Default => table::find_default(models, excluded),
        };
        if let Some(model) = found {
            return (Some(model), entry.effort, row.why.to_owned());
        }
    }
    let effort = entries.first().and_then(|entry| entry.effort);
    if let Some(model) = table::find_default(models, excluded) {
        return (
            Some(model),
            effort,
            format!(
                "{}'s default model (no better match in its list)",
                name(provider)
            ),
        );
    }
    if let Some(model) =
        table::routable(models).find(|model| excluded.is_none_or(|ex| table::identity(model) != ex))
    {
        return (
            Some(model),
            effort,
            format!("the first model in {}'s list", name(provider)),
        );
    }
    // Everything left is the excluded model: better the author's model than no review.
    if excluded.is_some() && table::routable(models).next().is_some() {
        return table_model(row, provider, models, None);
    }
    // No catalog yet: the CLI's own default model, at its own default effort.
    (
        None,
        None,
        format!("{}'s model list isn't loaded yet", name(provider)),
    )
}

/// "Codex gpt-6-astra (high) for review: <why>; <notes>."
fn sentence(
    provider: ProviderKind,
    model: Option<&str>,
    effort: Option<&str>,
    purpose: &str,
    why: &str,
    notes: &[String],
) -> String {
    let mut text = String::from(name(provider));
    text.push(' ');
    text.push_str(model.unwrap_or("default model"));
    if let Some(effort) = effort {
        text.push_str(&format!(" ({effort})"));
    }
    text.push_str(&format!(" for {purpose}: {why}"));
    for note in notes {
        text.push_str("; ");
        text.push_str(note);
    }
    text.push('.');
    text
}
