//! The two judgement calls: the **planner** call that turns a goal into phases, and the **lead**
//! call that decides what to do with the phase the run is on.
//!
//! Both are the same machinery — a fresh child, one turn, a single fenced JSON block in its final
//! assistant text, validated strictly, then thrown away. Neither is ever resumed: a resumed lead
//! call is an accumulating session, which is the product being refused (`docs/vision.md` §1,
//! `orchestration-loop.md` §15 item 13).
//!
//! **The planner call is not in the design and is here deliberately.**
//! `orchestration-loop.md` starts from *"one brigadier session = one approved goal + one plan"*
//! and never says who makes the plan; `docs/vision.md` §4 step 6 requires one
//! (`docs/plans/w1b-loop-order.md` §1 D1).
//!
//! **The grill is out of scope for this build.** `docs/vision.md` §4 step 5 sorts unknowns into
//! owner-answerable and research-answerable bins; the owner is away and *"just go"* is the only
//! answer available, so every unknown the planner names is written with `state = skipped` and
//! `skipped_for_just_go = true`. That is what the column is for: *"when a phase later fails on a
//! question that was waved off, the thread can say which one"* (D2).
//!
//! ## Two windows, then stop
//!
//! A malformed answer kills the child and spawns **one** fresh one, whose context gains exactly
//! one line: the validation failure, quoted. On the second consecutive malformed answer the phase
//! blocks. Two independent fresh windows failing the same schema is evidence about the prompt or
//! the plan, not about the window, and a third spawn buys the same answer at the same price
//! (`orchestration-loop.md` §2.4).
// see docs/research/orchestration-loop.md §2 and docs/plans/w1b-loop-order.md §1 D1, D2.

use std::time::SystemTime;

use brigadier_core::driver::ThinkingPolicy;
use brigadier_store::plan::{
    PhaseRow, PhaseState, UnknownBin as StoreBin, UnknownRow, UnknownState,
};

use crate::action::{parse_action, validate, Action, ActionError, PlanAction, UnknownBin, World};
use crate::loop_::call::{CallCwd, CallRequest};
use crate::loop_::{LoopError, Run};

/// How many windows one decision gets. The second is the last.
pub const ATTEMPTS: usize = 2;

/// Ask the planner for a plan, and write it.
///
/// Called only when the plan has a goal and **zero** phases.
pub(super) async fn make_plan(run: &mut Run) -> Result<(), LoopError> {
    let root = run.project.root_path.clone();
    let prompt = planner_prompt(&run.goal, &root.display().to_string());
    let action = ask(run, "planner", prompt, move |text| {
        let action = parse_action(text)?;
        validate(&action, &World::at(&root))?;
        match action {
            Action::Plan(plan) => Ok(plan),
            other => Err(ActionError::UnknownAction(other.slug().to_owned())),
        }
    })
    .await?;
    persist(run, action).await
}

/// Ask the lead what to do with the phase the run is on.
pub(super) async fn lead_call(run: &mut Run, phase: &PhaseRow) -> Result<Action, LoopError> {
    let phases = run.sup.inner.store.phases(&run.plan_id).await?;
    let unknowns = run.sup.inner.store.unknowns(&run.plan_id).await?;
    let prompt = lead_prompt(&run.goal, &phases, phase, &unknowns);
    let root = run.project.root_path.clone();
    let phase_id = phase.id.clone();
    let verify = phase.verify_command.clone();
    ask(run, "lead", prompt, move |text| {
        let action = parse_action(text)?;
        // The semantic half of §2.4, and the half that catches hallucination: a `verify` action
        // must name the phase's **stored** command verbatim, and every `owns` path must resolve
        // inside the project root with pairwise-disjoint sets.
        let world = World {
            project_root: &root,
            current_phase_id: Some(&phase_id),
            verify_command: verify.as_deref(),
            order_branches: &[],
        };
        validate(&action, &world)?;
        Ok(action)
    })
    .await
}

/// One decision, in at most [`ATTEMPTS`] fresh windows.
///
/// `parse` carries the whole of §2.4's five gates: it is [`crate::action`]'s parser and validator,
/// called here rather than reimplemented, so the loop and the unit tests hold the same opinion
/// about what a valid action is.
async fn ask<T, F>(
    run: &mut Run,
    label: &'static str,
    prompt: String,
    parse: F,
) -> Result<T, LoopError>
where
    F: Fn(&str) -> Result<T, ActionError>,
{
    let mut last: Option<ActionError> = None;
    for attempt in 0..ATTEMPTS {
        let prompt = match &last {
            None => prompt.clone(),
            // The retry's context gains one line, and only one. The previous window is gone.
            Some(why) => format!(
                "{prompt}\n\n\
                 A previous attempt at this answer was rejected by the harness. \
                 Its exact complaint was:\n\n    {why}\n\n\
                 Answer again, correcting that.",
            ),
        };
        let outcome = run
            .call
            .call(CallRequest {
                project_id: run.project.id.clone(),
                label,
                cwd: CallCwd::ProjectRoot,
                prompt,
                turn_deadline: run.limits.lead_deadline,
                // Its own clock, and shorter than the turn's. Giving the two the same value made
                // the quiet clock unreachable — it can never expire before the deadline it
                // equals — so a child that was alive and wedged was only ever caught at the end
                // of the whole turn.
                quiet_deadline: run.limits.lead_quiet_deadline,
                // The judgement lane is what opts back into thinking, per spawn
                // (`crates/core/src/driver.rs`).
                thinking: ThinkingPolicy::Inherit,
                // `None` is the provider default, which is `docs/vision.md` §6's *judgement gets
                // the strong model*. An explicit pick is the ceiling, and for a judgement call the
                // ceiling *is* the model (`loop_/routing.rs`).
                model: run.ceiling.judgement(),
                permission_mode: run.permission_mode.clone(),
            })
            .await?;
        if !outcome.end.answered() {
            // Not a parse failure and not retried as one: a deadline or a dead child is a
            // different fact from a bad answer, and blocking on it beats spending a second window
            // on the same silence.
            return Err(LoopError::NoAnswer { label, end: outcome.end.slug().to_owned() });
        }
        match parse(&outcome.text) {
            Ok(value) => return Ok(value),
            Err(why) => {
                tracing::warn!(
                    label,
                    attempt = attempt + 1,
                    error = %why,
                    "the call returned an action the harness will not run"
                );
                last = Some(why);
            }
        }
    }
    Err(LoopError::Action {
        label,
        source: last.expect("the loop ran at least one attempt"),
    })
}

/// Write the planner's answer: the phases, and the unknowns it could not resolve.
async fn persist(run: &mut Run, plan: PlanAction) -> Result<(), LoopError> {
    let store = &run.sup.inner.store;
    for (i, planned) in plan.phases.iter().enumerate() {
        let mut row = PhaseRow::new(
            uuid::Uuid::new_v4().to_string(),
            run.plan_id.clone(),
            u32::try_from(i).unwrap_or(u32::MAX),
            planned.title.clone(),
        );
        row.definition_of_done = planned.definition_of_done.clone();
        // Required and non-empty for every phase: `crates/supervisor/src/action.rs` enforces it
        // at the parse. A planner that returns no verify command has not produced a plan this
        // loop can run, and that is a validation failure, not a phase.
        row.verify_command = Some(planned.verify_command.clone());
        row.state = PhaseState::Pending;
        store.upsert_phase(row).await?;
    }
    let now = SystemTime::now();
    for planned in &plan.unknowns {
        let id = uuid::Uuid::new_v4().to_string();
        let bin = match planned.bin {
            UnknownBin::Owner => StoreBin::Owner,
            UnknownBin::Research => StoreBin::Research,
        };
        store
            .upsert_unknown(UnknownRow::new(
                id.clone(),
                run.plan_id.clone(),
                bin,
                planned.question.clone(),
                now,
            ))
            .await?;
        // D2: the owner is away, "just go" is the only answer available, and the skip is
        // recorded so a later failure can name which question was waved off.
        store
            .unknown_settled(id, UnknownState::Skipped, None, None, true, now)
            .await?;
    }
    // The rows must be on disk before the next tick reads them back: `phases` is a query that
    // runs on the writer thread behind whatever is queued, but `upsert_phase` is fire-and-forget
    // and a crash between here and the first dispatch would lose the plan entirely.
    store.flush().await?;
    tracing::info!(
        plan_id = %run.plan_id,
        phases = plan.phases.len(),
        unknowns = plan.unknowns.len(),
        "plan written"
    );
    Ok(())
}

/// The planner's whole window.
///
/// Everything in it is harness-assembled. Nothing a model wrote in a previous call is carried
/// forward except as normalised data, which is what stops the window accumulating.
#[must_use]
pub fn planner_prompt(goal: &str, project_root: &str) -> String {
    format!(
        "You are planning one run of an autonomous coding harness. You will not write any code.\n\
         \n\
         The project is at {project_root}. Read whatever you need to; write nothing.\n\
         \n\
         The goal, as the owner stated it:\n\
         \n\
         {goal}\n\
         \n\
         Break it into between {min} and {max} phases that run in order. Each phase needs:\n\
         - a short title;\n\
         - a definition of done in the owner's terms;\n\
         - a `verify_command`: a real shell command, runnable from the project root, whose\n\
           **exit code** decides whether the phase passed. It must be non-empty. Nothing else\n\
           settles a phase — not your judgement and not a worker's report.\n\
         \n\
         List anything you do not know under `unknowns`. Nobody is available to answer them; they\n\
         are recorded so a later failure can name which question was waved off.\n\
         \n\
         Reply with exactly one fenced json block and nothing else after it:\n\
         \n\
         ```json\n\
         {{\"action\": \"plan\",\n\
          \"phases\": [{{\"title\": \"...\", \"definition_of_done\": \"...\", \"verify_command\": \"...\"}}],\n\
          \"unknowns\": [{{\"question\": \"...\", \"bin\": \"owner\"}}]}}\n\
         ```\n",
        min = crate::action::MIN_PHASES,
        max = crate::action::MAX_PHASES,
    )
}

/// The lead's whole window: the goal, the plan, the progress, and this phase.
///
/// What is deliberately absent is the point. No thread, no earlier lead call's prose, no worker
/// transcript, and **no verify output** — for a red gate the lead gets the command, the exit code
/// and the reason slug, never the log (`orchestration-loop.md` §§2.1, 6.4).
///
/// One part of §2.1's six is missing and says so rather than being faked: the ~1,500-token recon
/// brief is W1-C's and is not built.
#[must_use]
pub fn lead_prompt(
    goal: &str,
    phases: &[PhaseRow],
    current: &PhaseRow,
    unknowns: &[UnknownRow],
) -> String {
    let mut out = String::new();
    out.push_str(
        "You are the lead of an autonomous coding harness. You decide one thing and stop.\n\nThe goal, as the owner approved it:\n\n",
    );
    out.push_str(goal);
    out.push_str("\n\nThe plan:\n");
    let mut ordered: Vec<&PhaseRow> = phases.iter().collect();
    ordered.sort_by_key(|p| p.ordinal);
    for phase in ordered {
        out.push_str(&format!(
            "  {}. [{}] {} — done when: {} — gate: {}\n",
            phase.ordinal + 1,
            phase.state.as_slug(),
            phase.title,
            phase.definition_of_done,
            phase.verify_command.as_deref().unwrap_or("(none: this phase cannot go green)"),
        ));
    }
    let done: Vec<&PhaseRow> =
        phases.iter().filter(|p| p.state == PhaseState::Green).collect();
    if !done.is_empty() {
        out.push_str("\nAlready committed:\n");
        for phase in done {
            out.push_str(&format!(
                "  {} — {}\n",
                phase.title,
                phase.commit_sha.as_deref().unwrap_or("(no commit recorded)")
            ));
        }
    }
    let waved: Vec<&UnknownRow> = unknowns
        .iter()
        .filter(|u| u.state == UnknownState::Skipped && u.skipped_for_just_go)
        .collect();
    if !waved.is_empty() {
        out.push_str("\nQuestions nobody answered, waved off with \"just go\":\n");
        for unknown in waved {
            out.push_str(&format!("  - {}\n", unknown.question));
        }
    }
    out.push_str(&format!(
        "\nYou are on phase {} — {}.\nDone when: {}\nIts gate is: {}\n",
        current.ordinal + 1,
        current.title,
        current.definition_of_done,
        current.verify_command.as_deref().unwrap_or("(none)"),
    ));
    if let (Some(code), Some(evidence)) = (current.last_exit_code, &current.last_evidence) {
        out.push_str(&format!("\nThe last gate on this phase exited {code}: {evidence}\n"));
    }
    out.push_str(
        "\nDispatch the work as parallel orders with disjoint write ownership. Every order needs\n\
         at least one owned path, and no two orders may own the same path. Ownership is about\n\
         writes; reads are unrestricted.\n\
         \n\
         Reply with exactly one fenced json block and nothing else after it:\n\
         \n\
         ```json\n\
         {\"action\": \"dispatch\",\n\
          \"orders\": [{\"id\": \"o1\", \"title\": \"...\", \"instructions\": \"...\",\n\
                      \"owns\": [\"src/a.rs\"], \"model_tier\": \"opus\"}]}\n\
         ```\n\
         \n\
         If you cannot proceed, answer `{\"action\": \"ask_owner\", \"question\": \"...\",\n\
         \"why_blocked\": \"...\"}` instead. Do not invent a different verify command; changing one\n\
         is a change to what \"done\" means and is not yours to make.\n",
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phase(ordinal: u32, title: &str, state: PhaseState) -> PhaseRow {
        let mut row = PhaseRow::new(format!("ph{ordinal}"), "plan", ordinal, title);
        row.definition_of_done = "it works".to_owned();
        row.verify_command = Some("cargo test".to_owned());
        row.state = state;
        row
    }

    #[test]
    fn the_planner_prompt_names_the_bounds_the_validator_enforces() {
        let prompt = planner_prompt("ship it", "/tmp/p");
        assert!(prompt.contains(&crate::action::MIN_PHASES.to_string()));
        assert!(prompt.contains(&crate::action::MAX_PHASES.to_string()));
        assert!(prompt.contains("/tmp/p"));
        assert!(prompt.contains("ship it"));
        assert!(prompt.contains("```json"));
    }

    /// §6.4's rule, at the one place it is easiest to break: the lead gets the exit code and a
    /// bounded evidence line, and there is nowhere in this function for a log to enter.
    #[test]
    fn the_lead_prompt_carries_an_exit_code_and_never_a_log() {
        let mut current = phase(0, "API routes", PhaseState::Running);
        current.last_exit_code = Some(101);
        current.last_evidence = Some("cargo test --workspace exited 101".to_owned());
        let prompt = lead_prompt("ship it", std::slice::from_ref(&current), &current, &[]);
        assert!(prompt.contains("exited 101"));
        assert!(prompt.contains("cargo test --workspace exited 101"));
        assert!(!prompt.contains("panicked at"), "no output may reach the lead window");
    }

    #[test]
    fn a_phase_with_no_verify_command_is_shown_as_one_that_cannot_go_green() {
        let mut current = phase(0, "docs", PhaseState::Pending);
        current.verify_command = None;
        let prompt = lead_prompt("g", std::slice::from_ref(&current), &current, &[]);
        assert!(prompt.contains("this phase cannot go green"));
    }

    #[test]
    fn waved_off_questions_reach_the_lead_and_answered_ones_do_not() {
        let current = phase(0, "a", PhaseState::Running);
        let mut waved = UnknownRow::new("u1", "plan", StoreBin::Owner, "which database?", SystemTime::UNIX_EPOCH);
        waved.state = UnknownState::Skipped;
        waved.skipped_for_just_go = true;
        let mut answered =
            UnknownRow::new("u2", "plan", StoreBin::Owner, "which port?", SystemTime::UNIX_EPOCH);
        answered.state = UnknownState::Answered;
        let prompt =
            lead_prompt("g", std::slice::from_ref(&current), &current, &[waved, answered]);
        assert!(prompt.contains("which database?"));
        assert!(!prompt.contains("which port?"));
    }

    #[test]
    fn committed_phases_are_listed_by_sha_and_never_by_diff() {
        let mut green = phase(0, "scaffolding", PhaseState::Green);
        green.commit_sha = Some("abc123".to_owned());
        let current = phase(1, "routes", PhaseState::Running);
        let prompt =
            lead_prompt("g", &[green, current.clone()], &current, &[]);
        assert!(prompt.contains("scaffolding — abc123"));
    }
}
