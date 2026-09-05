//! Dispatch: one isolated worktree and one child per order, then everything the worker said
//! re-derived from git before any of it is used.
//!
//! ## Two refusals that are the point of this file
//!
//! **A project with no worktree is refused, not fallen back.** `worktree::prepare` answers
//! `Ok(None)` when `git` is missing or the project is not a repository, and
//! `Supervisor::start_session` then leaves the child in the **project root**. That is defensible
//! for a session the owner started and is watching. It is not defensible here: combined with the
//! worker wall's pre-authorization of writes below the worktree root, it would hand an unattended
//! worker write access to the owner's own checkout. So this module answers
//! [`LoopError::NoWorktree`] instead (`docs/plans/w1b-loop-order.md` §7.5).
//!
//! **A report is a claim, never evidence.** Every field a worker returns is re-derived before it
//! is used, and `status: "done"` is re-derived by *nothing* — it is stored as the worker's claim
//! and settles nothing. An order is complete only when its report arrived **and** the phase's gate
//! exited 0. Neither alone, ever (`docs/vision.md` §8, `orchestration-loop.md` §4.1).
//!
//! ## The intent row, and a sharp edge in the store
//!
//! Each order gets a `work_order` intent, opened and **committed** before the worktree is handed
//! to a child, carrying the baseline the postcondition will later be measured against: the base
//! sha at dispatch, and the worktree's `dirty_count` at dispatch.
//!
//! `crates/store/src/intents.rs` holds `work_order` to settling **only** `unknown` — an owner
//! decision of 2026-09-04, enforced at the write. So a row this loop closes on the happy path
//! settles `unknown` too, and it is `IntentOutcome::Acked` that says *the effect's own code path
//! closed this while the process was alive* as opposed to *a postcondition read the world after a
//! restart*. The loop never reads intent rows to make its own decisions; it reads the launch-time
//! [`ReconcileOutcome`](crate::loop_::barrier::ReconcileOutcome) snapshot. See this module's
//! report for the consequence a reconciler has to handle.
// see docs/research/orchestration-loop.md §§3, 4 and docs/research/intent-records.md §4.3.

use std::sync::Arc;
use std::time::SystemTime;

use brigadier_core::driver::ThinkingPolicy;
use brigadier_core::worktree::dirty_count;
use brigadier_store::plan::{PhaseRow, WorkOrderRow, WorkOrderState};
use brigadier_store::{IntentOutcome, IntentRow, IntentState, KnownIntentKind};

use crate::action::{ModelTier, Order, ReportStatus};
use crate::loop_::call::{CallCwd, CallRequest};
use crate::loop_::{git, LoopError, Run};
use crate::worktree::prepare_from;

/// What a phase's dispatch produced.
#[derive(Clone, Debug, Default)]
pub struct Dispatched {
    /// One per order, in the order they were dispatched.
    pub collected: Vec<Collected>,
    /// Orders that wrote outside their declared `owns` set. **Any entry blocks the merge.**
    pub violations: Vec<String>,
}

/// One order, as git says it went — never as the worker said it went.
#[derive(Clone, Debug)]
pub struct Collected {
    /// The order id the lead chose.
    pub order_id: String,
    /// The branch its work is on.
    pub branch: String,
    /// Commits between the phase base and the branch tip, re-derived.
    pub commits: Vec<git::Commit>,
    /// Paths the branch changed, re-derived.
    pub changed: Vec<String>,
    /// Uncommitted entries left in the worktree, over the baseline captured at dispatch.
    pub dirt_delta: i64,
    /// What the worker claimed, if it returned a parseable report. **Read by nothing.** Stored so
    /// the plan card can show what the worker believed, beside what git says happened.
    pub claim: Option<ReportStatus>,
    /// Whether the order parked on an approval at any point.
    pub parked: bool,
}

/// Dispatch every order in `orders`, wait for them all, and re-derive what they did.
///
/// Concurrency is bounded by [`Limits::concurrency`](crate::loop_::Limits::concurrency). Orders
/// beyond the cap wait for a permit; none is dropped.
pub(super) async fn run(
    run: &mut Run,
    phase: &PhaseRow,
    base_sha: &str,
    orders: Vec<Order>,
) -> Result<Dispatched, LoopError> {
    let permits = Arc::new(tokio::sync::Semaphore::new(run.limits.concurrency.max(1)));
    let mut set = tokio::task::JoinSet::new();
    for order in orders {
        let ctx = OrderCtx {
            sup: run.sup.clone(),
            call: Arc::clone(&run.call),
            git: run.git.clone(),
            project_id: run.project.id.clone(),
            project_root: run.project.root_path.clone(),
            phase_id: phase.id.clone(),
            phase_title: phase.title.clone(),
            definition_of_done: phase.definition_of_done.clone(),
            goal: run.goal.clone(),
            base_sha: base_sha.to_owned(),
            turn_deadline: run.limits.worker_turn_deadline,
            quiet_deadline: run.limits.worker_quiet_deadline,
            model: run.model.clone(),
            permission_mode: run.permission_mode.clone(),
        };
        let permits = Arc::clone(&permits);
        set.spawn(async move {
            // A closed semaphore is impossible here: it is dropped with this scope.
            let _permit = permits.acquire_owned().await.expect("the semaphore outlives the set");
            one(ctx, order).await
        });
    }

    let mut out = Dispatched::default();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok((collected, violations))) => {
                out.collected.push(collected);
                out.violations.extend(violations);
            }
            Ok(Err(e)) => return Err(e),
            Err(e) => {
                return Err(LoopError::Io(std::io::Error::other(format!(
                    "a work order's task did not finish: {e}"
                ))))
            }
        }
    }
    out.collected.sort_by(|a, b| a.order_id.cmp(&b.order_id));
    out.violations.sort();
    Ok(out)
}

/// Everything one order's task needs, owned, because it runs on its own task.
struct OrderCtx {
    sup: crate::Supervisor,
    call: crate::loop_::call::SharedCall,
    git: std::path::PathBuf,
    project_id: String,
    project_root: std::path::PathBuf,
    phase_id: String,
    phase_title: String,
    definition_of_done: String,
    goal: String,
    base_sha: String,
    turn_deadline: std::time::Duration,
    quiet_deadline: std::time::Duration,
    /// The run's model pick, or `None` to let the order's own tier decide.
    model: Option<String>,
    /// The run's permission mode, which for a worker reaches the flag but **not** the hook: a
    /// worker is always behind `WorkerWall`, whatever the mode
    /// (`docs/research/permission-modes.md` §5).
    permission_mode: brigadier_core::driver::PermissionMode,
}

async fn one(ctx: OrderCtx, order: Order) -> Result<(Collected, Vec<String>), LoopError> {
    let store = &ctx.sup.inner.store;

    // The isolation, and the refusal. `Ok(None)` is a project with no repository, which for a
    // *loop-dispatched* child is a refusal and not a fallback.
    let prepared = prepare_from(&ctx.project_root, Some(&ctx.base_sha))
        .await?
        .ok_or_else(|| LoopError::NoWorktree(ctx.project_root.clone()))?;
    let worktree = prepared.path.clone();
    let branch = prepared.branch.clone();
    // D7's payoff: the branch point git actually used, resolved before the `add`, not a second
    // reading of a reference that has moved since.
    let base_sha = prepared.base_sha.clone();

    // §4.2's rule, and it is easy to get wrong: `dirty_count` passes `--ignored=matching` and
    // `--untracked-files=all`, so **any** harness file placed inside a worker's worktree counts.
    // The baseline is captured after the checkout exists and before anything is written into it.
    let baseline_dirt = dirty_count(&ctx.git, &worktree).await.unwrap_or(0);

    let intent_id = uuid::Uuid::new_v4().to_string();
    let mut intent =
        IntentRow::new(intent_id.clone(), KnownIntentKind::WorkOrder, SystemTime::now());
    intent.project_id = Some(ctx.project_id.clone());
    intent.subject = Some(worktree.display().to_string());
    intent.baseline = Some(format!("{base_sha} {baseline_dirt}"));
    intent.detail_json = serde_json::json!({
        "order_id": order.id,
        "phase_id": ctx.phase_id,
        "branch": branch,
    })
    .to_string();
    // Awaits the commit itself. A timeout here says the commit did not arrive in time — never
    // that the row was not written — so the answer is to stop, not to dispatch anyway.
    if let Err(e) = store.intent_open(intent).await {
        prepared.roll_back().await;
        return Err(LoopError::Store(e));
    }

    // **The stored id is namespaced by phase.** The lead's `id` is only unique inside its own
    // answer, and `work_orders.id` is the primary key: a second phase that also called its order
    // `o1` would collide with the first phase's row, whose `ON CONFLICT` clause refuses to move
    // `phase_id` or to reopen a finished order. The phase would then read back as having no
    // orders at all and the loop would re-dispatch it forever.
    let row_id = format!("{}/{}", ctx.phase_id, order.id);
    let mut row = WorkOrderRow::new(row_id.clone(), ctx.phase_id.clone(), order.title.clone());
    row.owned_paths_json = serde_json::to_string(&order.owns).unwrap_or_else(|_| "[]".to_owned());
    row.state = WorkOrderState::Dispatched;
    row.worktree_path = Some(worktree.clone());
    row.branch = Some(branch.clone());
    row.dispatched_at = Some(SystemTime::now());
    store.upsert_work_order(row).await?;

    let outcome = ctx
        .call
        .call(CallRequest {
            project_id: ctx.project_id.clone(),
            label: "worker",
            cwd: CallCwd::Worktree { dir: worktree.clone(), branch: Some(branch.clone()) },
            prompt: worker_prompt(&ctx, &order),
            turn_deadline: ctx.turn_deadline,
            quiet_deadline: ctx.quiet_deadline,
            thinking: tier_thinking(order.model_tier),
            // The owner's pick wins; with none, `docs/vision.md` §6's role-based routing does the
            // choosing and the lead's tier finally reaches something. `opus`, `sonnet` and
            // `haiku` are the CLI's own aliases (`docs/research/permission-modes.md` §2).
            model: ctx
                .model
                .clone()
                .or_else(|| Some(order.model_tier.as_slug().to_owned())),
            permission_mode: ctx.permission_mode.clone(),
        })
        .await?;

    // Every claim re-derived. `git log`/`git diff` are run against the **project root**, because
    // refs are shared across every linked worktree of one repository and the worker's checkout
    // may be about to be removed.
    let commits = git::commits(&ctx.git, &ctx.project_root, &base_sha, &branch).await?;
    let changed = git::changed_paths(&ctx.git, &ctx.project_root, &base_sha, &branch).await?;
    let dirt = dirty_count(&ctx.git, &worktree).await.unwrap_or(baseline_dirt);
    let claim = crate::action::parse_report(&outcome.text).ok().map(|r| r.status);

    // §3.2: ownership is advisory going in and enforced coming out. A path outside the set
    // **blocks the merge**; a set that passes proves only that this particular failure did not
    // happen, and never authorizes anything.
    let violations: Vec<String> = changed
        .iter()
        .filter(|path| !owns_covers(&order.owns, path))
        .map(|path| format!("order {} wrote {path}, which it does not own", order.id))
        .collect();

    let state = if outcome.end.answered() {
        WorkOrderState::Reported
    } else {
        WorkOrderState::Failed
    };
    // Bounded, and it is the worker's own words: the store's column is for a report, never a
    // transcript.
    let report = summarise(&outcome.text, &commits, &changed);
    store
        .work_order_finished(row_id, state, Some(report.clone()), SystemTime::now())
        .await?;

    // The close. `work_order` can settle only `unknown`; `Acked` is what distinguishes this from
    // a postcondition that read the world after a restart.
    store
        .intent_close(
            intent_id,
            IntentState::Unknown,
            IntentOutcome::Acked,
            Some(format!(
                "worker ended {}; {} commit(s), {} path(s), dirt {baseline_dirt}->{dirt}",
                outcome.end.slug(),
                commits.len(),
                changed.len()
            )),
            outcome.session_id.clone(),
            SystemTime::now(),
        )
        .await?;

    Ok((
        Collected {
            order_id: order.id,
            branch,
            commits,
            changed,
            dirt_delta: i64::from(dirt) - i64::from(baseline_dirt),
            claim,
            parked: outcome.parked,
        },
        violations,
    ))
}

/// Whether `path` lies inside any of `owns`, **by path component**.
///
/// Never by string prefix. `src/a` and `src/ab` do not collide, and a `starts_with` on strings
/// says they do (`orchestration-loop.md` §2.4). An empty `owns` covers nothing, which is why the
/// validator refuses an order that owns no paths.
#[must_use]
pub fn owns_covers(owns: &[String], path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    owns.iter().any(|owned| {
        let owned: Vec<&str> = owned.split('/').filter(|s| !s.is_empty()).collect();
        !owned.is_empty() && parts.len() >= owned.len() && parts[..owned.len()] == owned[..]
    })
}

/// A worker's whole window: the goal, the phase, the order, and the wall it runs behind.
fn worker_prompt(ctx: &OrderCtx, order: &Order) -> String {
    let owns = order.owns.join("\n  - ");
    format!(
        "You are one worker in an autonomous coding harness. You are alone in a throwaway git\n\
         worktree on branch {branch}; nothing you do here touches anybody else's checkout.\n\
         \n\
         The run's goal:\n\n{goal}\n\
         \n\
         The phase you are part of: {phase}\n\
         Done, for the phase as a whole, when: {dod}\n\
         \n\
         Your order — {title}:\n\n{instructions}\n\
         \n\
         You own these paths for **writing**. Reads are unrestricted; writing anywhere else\n\
         blocks the whole phase's merge:\n  - {owns}\n\
         \n\
         Commit your work on this branch. When you are finished, reply with exactly one fenced\n\
         json block:\n\
         \n\
         ```json\n\
         {{\"order_id\": \"{id}\", \"status\": \"done\", \"summary\": \"...\",\n\
          \"files_changed\": [], \"commits\": []}}\n\
         ```\n\
         \n\
         Your `status` settles nothing. The phase is decided by the exit code of a real verify\n\
         command run against your work merged with everyone else's.\n",
        branch = order.id,
        goal = ctx.goal,
        phase = ctx.phase_title,
        dod = ctx.definition_of_done,
        title = order.title,
        instructions = order.instructions,
        id = order.id,
    )
}

/// Bounded narration of what one order produced, for the `work_orders.report` column.
fn summarise(text: &str, commits: &[git::Commit], changed: &[String]) -> String {
    let claimed = crate::action::parse_report(text)
        .map(|r| r.summary)
        .unwrap_or_else(|_| "(no parseable report)".to_owned());
    let mut out = format!(
        "{} commit(s), {} path(s) changed. Worker said: {claimed}",
        commits.len(),
        changed.len()
    );
    out.truncate(crate::action::MAX_SUMMARY_CHARS * 2);
    out
}

/// Whether a tier reasons. The only two levers the harness has over a worker's window are the
/// model slug and the thinking policy; the model slug is the provider's default in this build.
fn tier_thinking(tier: ModelTier) -> ThinkingPolicy {
    match tier {
        ModelTier::Opus => ThinkingPolicy::Inherit,
        ModelTier::Sonnet | ModelTier::Haiku => ThinkingPolicy::Off,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The component-vs-string-prefix case, which is the one a `starts_with` gets wrong.
    #[test]
    fn ownership_is_by_component_and_never_by_string_prefix() {
        let owns = vec!["src/a".to_owned()];
        assert!(owns_covers(&owns, "src/a"));
        assert!(owns_covers(&owns, "src/a/deep/file.rs"));
        assert!(!owns_covers(&owns, "src/ab/file.rs"), "src/ab is not inside src/a");
        assert!(!owns_covers(&owns, "src/abc"));
        assert!(!owns_covers(&owns, "src"));
        assert!(!owns_covers(&owns, "other/a"));
    }

    #[test]
    fn owning_nothing_covers_nothing() {
        assert!(!owns_covers(&[], "src/a.rs"));
        assert!(!owns_covers(&["".to_owned()], "src/a.rs"));
    }

    #[test]
    fn owning_a_file_covers_exactly_that_file() {
        let owns = vec!["src/lib.rs".to_owned()];
        assert!(owns_covers(&owns, "src/lib.rs"));
        assert!(!owns_covers(&owns, "src/lib.rs.orig"));
    }

    #[test]
    fn a_summary_is_bounded_and_says_what_git_saw_before_what_the_worker_said() {
        let text = format!(
            "```json\n{{\"order_id\":\"o1\",\"status\":\"done\",\"summary\":\"{}\"}}\n```",
            "x".repeat(300)
        );
        let commits = vec![git::Commit { sha: "abc".into(), subject: "s".into() }];
        let out = summarise(&text, &commits, &["src/a.rs".to_owned()]);
        assert!(out.starts_with("1 commit(s), 1 path(s) changed."));
        assert!(out.len() <= crate::action::MAX_SUMMARY_CHARS * 2);
    }

    #[test]
    fn an_unparseable_report_is_recorded_as_one_rather_than_invented() {
        let out = summarise("I finished the work!", &[], &[]);
        assert!(out.contains("(no parseable report)"));
    }
}
