//! Plan review: every plan of two or more steps, or marked risky, is checked by a reviewer
//! from another vendor than the orchestrator's before Brigadier approves it on the user's
//! behalf (two reviewers on different models for a risky plan, and both must approve). Built
//! in, always on.
//!
//! A plan's review is a gate round (`Plan.gate`), like a change's, decided once every
//! reviewer has a result:
//!
//! - **Approved:** the plan is approved (`PlanApprover::Review`); the reviewers' notes go to
//!   the orchestrator with the decision.
//! - **Changes asked:** the findings are numbered F1, F2, … and the plan is `Revising`. The
//!   orchestrator proposes the revision with `revises` and an answer to each finding; the
//!   revision is always reviewed again, with the findings and the answers in view.
//! - **Still not right after [`PLAN_ROUNDS`] rounds:** nothing is approved; the orchestrator
//!   asks the user or rescopes the work.
//! - **No result** (a reviewer failed or was stopped): the plan is turned down, and the
//!   orchestrator may propose it again.
//!
//! Under "Ask for approval" the user's card shows at once and the review runs beside it: its
//! findings and notes show on the card, and the user decides.

use brigadier_providers::ProviderKind;
use brigadier_router::Author;

use super::SessionManager;
use super::conversation::Envelope;
use super::gates::{outcome_of, review_result};
use crate::model::{CardId, ConversationId, Setup};
use crate::work::{
    Finding, FindingResponse, Gate, GateLink, GateMember, GateOutcome, GateOwner, GateResult,
    GateRole, InjectionKind, Plan, PlanApprover, PlanState, PlanStep, Report, Task, TaskKind,
};
use crate::{Error, Result, now_ms};

/// Review rounds one plan goes through (the first, and one revision) before the orchestrator
/// asks the user or rescopes.
pub(crate) const PLAN_ROUNDS: u32 = 2;

impl SessionManager {
    /// The orchestrator's model: a plan's reviewers come from another vendor.
    fn orchestrator_author(&self, id: &ConversationId) -> Result<Author> {
        Ok(match self.core.conversation(id)?.setup {
            Some(Setup::Session { orchestrator, .. }) => Author {
                provider: orchestrator.provider,
                model: orchestrator.model,
            },
            _ => Author {
                provider: ProviderKind::Claude,
                model: None,
            },
        })
    }

    /// Opens review round `round` of a stored plan with `reviewers` reviewers. `decides`: the
    /// review decides the plan (it goes `InReview`); otherwise the user does, and the review
    /// only informs them. Returns the reviewers.
    pub(crate) async fn open_plan_gate(
        &self,
        plan: &Plan,
        round: u32,
        reviewers: usize,
        decides: bool,
    ) -> Result<Vec<Task>> {
        let held = self.gates.lock().await;
        let board = self.core.board(&plan.conversation_id).await?;
        let previous = plan
            .revises
            .as_ref()
            .and_then(|id| board.plans.get(id))
            .cloned();
        let spec = review_spec(plan, previous.as_ref(), round);
        let author = self.orchestrator_author(&plan.conversation_id)?;
        let owner = GateOwner::Plan {
            plan_id: plan.id.clone(),
        };
        let mut members: Vec<GateMember> = Vec::new();
        let mut started: Vec<Task> = Vec::new();
        let mut checking: Vec<Author> = Vec::new();
        let opened: Result<()> = async {
            for index in 0..reviewers {
                let review = self
                    .create_task(
                        &plan.conversation_id,
                        if index == 0 {
                            format!("Review plan: {}", plan.title)
                        } else {
                            format!("Second review of plan: {}", plan.title)
                        },
                        TaskKind::Review,
                        spec.clone(),
                        None,
                        Some(author.clone()),
                        checking.clone(),
                        Some(GateLink {
                            owner: owner.clone(),
                            round,
                            role: GateRole::Review,
                        }),
                        None,
                        Vec::new(),
                        None,
                        None,
                        Vec::new(),
                    )
                    .await?;
                checking.push(Author {
                    provider: review.route.choice.provider,
                    model: review.route.choice.model.clone(),
                });
                members.push(GateMember {
                    task_id: review.id.clone(),
                    role: GateRole::Review,
                    result: None,
                    avoid: Vec::new(),
                });
                started.push(review);
            }
            Ok(())
        }
        .await;
        // The plan as it is now: the user may have decided it meanwhile.
        let stored = match opened {
            Ok(()) => match self.core.board(&plan.conversation_id).await {
                Ok(board) => board
                    .plans
                    .get(&plan.id)
                    .cloned()
                    .ok_or_else(|| Error::NotFound(format!("plan {}", plan.id))),
                Err(err) => Err(err),
            },
            Err(err) => Err(err),
        };
        let stored = match stored {
            Ok(mut stored) if is_open(&stored.state) => {
                stored.gate = Some(Gate {
                    round,
                    commit: None,
                    members,
                    outcome: None,
                    relanding: false,
                    retry: false,
                    findings: Vec::new(),
                });
                if decides && let Some(first) = started.first() {
                    stored.state = PlanState::InReview {
                        task_id: first.id.clone(),
                    };
                }
                self.store_plan(&stored).await
            }
            Ok(_) => Err(Error::Invalid("the plan was decided meanwhile".into())),
            Err(err) => Err(err),
        };
        drop(held);
        if let Err(err) = stored {
            // Nothing half-started keeps running. Stopped outside the lock: a stopped
            // reviewer's missing result is recorded under it.
            for member in started {
                let _ = Box::pin(self.stop_task(member.id)).await;
            }
            return Err(err);
        }
        Ok(started)
    }

    /// A plan's reviewer reported, or (`failed`, with why) failed or was stopped first.
    pub(crate) async fn plan_member_done(
        &self,
        member: &Task,
        plan_id: &CardId,
        link: &GateLink,
        failed: Option<&str>,
    ) {
        let result = match (failed, &member.report) {
            (None, Some(report)) => review_result(report),
            (None, None) => return,
            (Some(reason), _) => GateResult::NoResult {
                reason: format!(
                    "The reviewer (task-{}) gave no result: {reason}",
                    member.number
                ),
            },
        };
        let envelope = {
            let _held = self.gates.lock().await;
            let Ok(board) = self.core.board(&member.conversation_id).await else {
                return;
            };
            let Some(mut plan) = board.plans.get(plan_id).cloned() else {
                return;
            };
            let Some(mut gate) = plan.gate.clone() else {
                return;
            };
            // A result of an older or closed round, or for a plan already decided.
            if gate.round != link.round || gate.outcome.is_some() || !is_open(&plan.state) {
                return;
            }
            let Some(slot) = gate
                .members
                .iter_mut()
                .find(|known| known.task_id == member.id)
                .filter(|slot| slot.result.is_none())
            else {
                return;
            };
            slot.result = Some(result);
            let decided = gate
                .members
                .iter()
                .all(|m| m.result.is_some())
                .then(|| outcome_of(&gate.members));
            let mut reviewers = Vec::new();
            for known in &gate.members {
                if let Ok(task) = self
                    .task_by_id(&member.conversation_id, &known.task_id)
                    .await
                {
                    reviewers.push(task);
                }
            }
            if decided == Some(GateOutcome::Failed) {
                gate.findings = number_findings(&gate.members);
            }
            gate.outcome = decided.clone();
            plan.gate = Some(gate.clone());
            // Under "Ask for approval" the user decides: the review only shows on the card.
            let decides = matches!(plan.state, PlanState::InReview { .. });
            // What it decided on the user's behalf, and why ("Decided for you").
            let mut decision: Option<(String, String)> = None;
            let envelope = match decided {
                None => None,
                Some(GateOutcome::Passed) => {
                    plan.review_notes = reviewers
                        .iter()
                        .filter_map(|t| t.report.as_ref())
                        .flat_map(review_notes)
                        .collect();
                    decides.then(|| {
                        plan.state = PlanState::Approved {
                            by: PlanApprover::Review,
                        };
                        plan.decided_at_ms = Some(now_ms());
                        decision = Some((
                            format!("Approved the plan \u{201c}{}\u{201d}", plan.title),
                            match plan.review_notes.len() {
                                0 => "An independent review from another vendor approved it.".to_owned(),
                                notes => format!(
                                    "An independent review from another vendor approved it, with {notes} note{}.",
                                    if notes == 1 { "" } else { "s" }
                                ),
                            },
                        ));
                        approved_text(&plan, &reviewers)
                    })
                }
                Some(GateOutcome::Failed) if decides => {
                    let listed = findings_list(&gate.findings, &reviewers);
                    let found = gate
                        .findings
                        .iter()
                        .map(|f| format!("{}: {}", f.id, f.text))
                        .collect::<Vec<_>>()
                        .join(" ");
                    if gate.round < PLAN_ROUNDS {
                        decision = Some((
                            format!(
                                "Sent the plan \u{201c}{}\u{201d} back for revision",
                                plan.title
                            ),
                            format!("Its independent review asked for changes. {found}"),
                        ));
                        plan.state = PlanState::Revising;
                        Some(format!(
                            "[plan review] The independent review (round {} of {PLAN_ROUNDS}) asked for changes to the plan \"{}\" (id {}), so it is not approved:\n{listed}\n[/plan review] Revise it: call propose_plan with the revised steps, revises: \"{}\", and responses with one line per finding: \"F1 accepted: what you changed\" or \"F2 declined: why\". The revision is reviewed again; don't start write tasks before it is approved.",
                            gate.round, plan.title, plan.id, plan.id
                        ))
                    } else {
                        decision = Some((
                            format!("Did not approve the plan \u{201c}{}\u{201d}", plan.title),
                            format!(
                                "It still had problems after {PLAN_ROUNDS} review rounds; the orchestrator asks you or makes it smaller. {found}"
                            ),
                        ));
                        plan.state = PlanState::Rejected {
                            message: Some(format!(
                                "Not approved after {PLAN_ROUNDS} review rounds."
                            )),
                        };
                        plan.decided_at_ms = Some(now_ms());
                        Some(format!(
                            "[plan review] The revised plan \"{}\" still has problems after the last review round ({} of {PLAN_ROUNDS}), so it is not approved:\n{listed}\n[/plan review] Don't revise it again on your own: ask the user how to proceed (ask_user), or rescope the work into a smaller plan.",
                            plan.title, gate.round
                        ))
                    }
                }
                Some(GateOutcome::NoResult | GateOutcome::Unverified) if decides => {
                    let reasons = gate
                        .members
                        .iter()
                        .filter_map(|m| match &m.result {
                            Some(GateResult::NoResult { reason }) => Some(format!("- {reason}")),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    decision = Some((
                        format!("Did not approve the plan \u{201c}{}\u{201d}", plan.title),
                        format!(
                            "Its independent review could not run. {}",
                            reasons
                                .lines()
                                .map(|line| line.trim_start_matches("- "))
                                .collect::<Vec<_>>()
                                .join(" ")
                        ),
                    ));
                    plan.state = PlanState::Rejected {
                        message: Some(format!("The review could not run.\n{reasons}")),
                    };
                    plan.decided_at_ms = Some(now_ms());
                    Some(format!(
                        "[decision] The independent review of the plan \"{}\" could not run, so it is not approved:\n{reasons}\nPropose it again.",
                        plan.title
                    ))
                }
                Some(_) => None,
            };
            if let Err(err) = self.store_plan(&plan).await {
                tracing::warn!(plan = %plan.id, error = %err, "could not record a plan review");
                return;
            }
            envelope.map(|text| (plan, text, decision))
        };
        if let Some((plan, text, decision)) = envelope {
            if let Some((what, why)) = decision {
                self.decided_for_plan(&plan, what, why).await;
            }
            self.deliver_for(
                &plan.conversation_id,
                Envelope {
                    kind: InjectionKind::Decision,
                    label: "plan review".into(),
                    task_id: Some(member.id.clone()),
                    text,
                },
                plan.request_id.clone(),
            )
            .await;
        }
    }

    /// Changes a plan as it is stored now, under the gate lock so a review result can't race
    /// the change. A review round still open on a plan that is no longer open is closed, and
    /// its reviewers stop.
    pub(crate) async fn change_plan(
        &self,
        conversation_id: &ConversationId,
        plan_id: &CardId,
        change: impl FnOnce(&mut Plan) -> Result<()>,
    ) -> Result<Plan> {
        let (plan, moot) = {
            let _held = self.gates.lock().await;
            let board = self.core.board(conversation_id).await?;
            let before = board
                .plans
                .get(plan_id)
                .cloned()
                .ok_or_else(|| Error::NotFound(format!("plan {plan_id}")))?;
            let mut plan = before.clone();
            change(&mut plan)?;
            let mut moot = Vec::new();
            if !is_open(&plan.state)
                && let Some(gate) = plan.gate.as_mut()
                && gate.outcome.is_none()
            {
                gate.outcome = Some(GateOutcome::Superseded);
                moot = gate
                    .members
                    .iter()
                    .filter(|m| m.result.is_none())
                    .map(|m| m.task_id.clone())
                    .collect();
            }
            if plan != before {
                self.store_plan(&plan).await?;
            }
            (plan, moot)
        };
        for member in moot {
            // Boxed: stopping a reviewer records its missing result, which reaches this plan.
            let _ = Box::pin(self.stop_task(member)).await;
        }
        Ok(plan)
    }

    /// After a restart: a plan's review round whose reviewers were stopped runs again, so the
    /// plan doesn't wait for results that never come.
    pub(crate) async fn rerun_plan_reviews(&self, conversation_id: &ConversationId) {
        let Ok(board) = self.core.board(conversation_id).await else {
            return;
        };
        for plan in board.plans.values() {
            let (round, reviewers) = match (&plan.gate, &plan.state) {
                (Some(gate), PlanState::Proposed | PlanState::InReview { .. })
                    if gate.outcome.is_none() =>
                {
                    (gate.round, gate.members.len().max(1))
                }
                // Reviewed before plans had a gate.
                (None, PlanState::InReview { .. }) => (1, if plan.risky { 2 } else { 1 }),
                _ => continue,
            };
            let decides = matches!(plan.state, PlanState::InReview { .. });
            if let Err(err) = self.open_plan_gate(plan, round, reviewers, decides).await {
                tracing::warn!(plan = %plan.id, error = %err, "could not review a plan again");
                if decides {
                    let reason = err.to_string();
                    let _ = self
                        .change_plan(conversation_id, &plan.id, |p| {
                            p.state = PlanState::Rejected {
                                message: Some(format!("The review could not run: {reason}")),
                            };
                            p.decided_at_ms = Some(now_ms());
                            Ok(())
                        })
                        .await;
                    self.deliver_for(
                        conversation_id,
                        Envelope {
                            kind: InjectionKind::Decision,
                            label: "plan review".into(),
                            task_id: None,
                            text: format!(
                                "[decision] Brigadier restarted while the plan \"{}\" was in review, and its review could not run again ({reason}), so it is not approved. Propose it again.",
                                plan.title
                            ),
                        },
                        plan.request_id.clone(),
                    )
                    .await;
                }
            }
        }
    }

    /// Who a plan's reviewer must not be, for a hand-off to another model: the orchestrator,
    /// and the models of the round's other reviewers.
    pub(crate) async fn plan_gate_avoid(
        &self,
        member: &Task,
        plan_id: &CardId,
        round: u32,
    ) -> (Option<Author>, Vec<Author>) {
        let author = self.orchestrator_author(&member.conversation_id).ok();
        let mut others = Vec::new();
        if let Ok(board) = self.core.board(&member.conversation_id).await
            && let Some(gate) = board
                .plans
                .get(plan_id)
                .and_then(|plan| plan.gate.as_ref())
                .filter(|gate| gate.round == round)
        {
            for other in gate.members.iter().filter(|m| m.task_id != member.id) {
                if let Some(other) = board.tasks.get(&other.task_id) {
                    others.push(Author {
                        provider: other.route.choice.provider,
                        model: other.route.choice.model.clone(),
                    });
                }
            }
        }
        (author, others)
    }
}

/// Whether a plan waits for a decision a review can inform.
fn is_open(state: &PlanState) -> bool {
    matches!(state, PlanState::Proposed | PlanState::InReview { .. })
}

/// How many reviewers check a new plan; none approves it at once (under "Approve for me").
/// `revising`: it revises a plan whose review asked for changes, so it is always reviewed
/// again. `after_approved`: it follows an approved plan of the same request, and whether it
/// adds or changes steps of it.
pub(crate) fn plan_reviewers(
    steps: usize,
    risky: bool,
    revising: bool,
    after_approved: Option<bool>,
) -> usize {
    if risky {
        2
    } else if revising {
        1
    } else {
        match after_approved {
            Some(changed) => usize::from(changed),
            None => usize::from(steps >= 2),
        }
    }
}

/// A step as compared between plans: its title and detail, in lower case with single spaces.
fn step_key(step: &PlanStep) -> String {
    let text = format!("{} {}", step.title, step.detail.as_deref().unwrap_or(""));
    text.split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether `after` has a step `before` doesn't (new, or changed in title or detail). Dropping
/// or reordering steps changes nothing material.
pub(crate) fn adds_or_changes_steps(before: &[PlanStep], after: &[PlanStep]) -> bool {
    let known: std::collections::HashSet<String> = before.iter().map(step_key).collect();
    after.iter().any(|step| !known.contains(&step_key(step)))
}

/// A failed round's findings, numbered F1, F2, … across its reviewers, in order.
pub(crate) fn number_findings(members: &[GateMember]) -> Vec<Finding> {
    members
        .iter()
        .filter_map(|member| match &member.result {
            Some(GateResult::Failed { findings }) => Some((member, findings)),
            _ => None,
        })
        .flat_map(|(member, findings)| {
            findings
                .iter()
                .map(|text| text.trim())
                .filter(|text| !text.is_empty())
                .map(move |text| (member.task_id.clone(), text.to_owned()))
        })
        .enumerate()
        .map(|(index, (by, text))| Finding {
            id: format!("F{}", index + 1),
            text,
            by,
        })
        .collect()
}

/// The revision's answer to each finding, from lines like "F1 accepted: what changed" or
/// "F2 declined: why". Every finding needs exactly one answer, and a decline its reason.
pub(crate) fn parse_responses(
    lines: &[String],
    findings: &[Finding],
) -> std::result::Result<Vec<FindingResponse>, String> {
    const FORM: &str = "\"F1 accepted: what you changed\" or \"F2 declined: why\"";
    let mut responses: Vec<FindingResponse> = Vec::new();
    for line in lines.iter().flat_map(|text| text.lines()) {
        let line = line.trim().trim_start_matches(['-', '*', ' ']);
        if line.is_empty() {
            continue;
        }
        let (id, rest) = line
            .split_once(|c: char| c.is_whitespace() || c == ':')
            .ok_or_else(|| format!("\"{line}\" is not a response: write {FORM}"))?;
        let id = id.trim().to_uppercase();
        let finding = findings
            .iter()
            .find(|finding| finding.id == id)
            .ok_or_else(|| {
                format!(
                    "\"{line}\" answers no finding of the review (they are {})",
                    ids(findings)
                )
            })?;
        let rest = rest.trim_start_matches([':', ' ', '\t']);
        let lower = rest.to_lowercase();
        let (accepted, word) = ["accepted", "accept", "declined", "decline"]
            .iter()
            .find(|word| lower.starts_with(*word))
            .map(|word| (word.starts_with("accept"), word.len()))
            .ok_or_else(|| format!("\"{line}\" neither accepts nor declines {id}: write {FORM}"))?;
        let note = rest[word..]
            .trim_start_matches([':', '-', ' ', '\t', '—', '–'])
            .trim()
            .to_owned();
        if !accepted && note.is_empty() {
            return Err(format!("{id} is declined without a reason: say why"));
        }
        if responses.iter().any(|known| known.id == id) {
            return Err(format!("{id} is answered twice"));
        }
        responses.push(FindingResponse {
            id,
            finding: finding.text.clone(),
            accepted,
            note,
        });
    }
    let unanswered: Vec<&str> = findings
        .iter()
        .filter(|finding| !responses.iter().any(|r| r.id == finding.id))
        .map(|finding| finding.id.as_str())
        .collect();
    if !unanswered.is_empty() {
        return Err(format!(
            "every finding of the review needs a response; unanswered: {}. Add one line each: {FORM}",
            unanswered.join(", ")
        ));
    }
    responses.sort_by_key(|r| r.id[1..].parse::<u32>().unwrap_or(u32::MAX));
    Ok(responses)
}

fn ids(findings: &[Finding]) -> String {
    if findings.is_empty() {
        return "none".into();
    }
    findings
        .iter()
        .map(|finding| finding.id.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// What a reviewer that approved noted for carrying the plan out.
fn review_notes(report: &Report) -> Vec<String> {
    report
        .open_questions
        .iter()
        .chain(&report.risks)
        .map(|note| note.trim().to_owned())
        .filter(|note| !note.is_empty())
        .collect()
}

/// The steps of a plan, numbered.
fn steps_text(steps: &[PlanStep]) -> String {
    let mut text = String::new();
    for (index, step) in steps.iter().enumerate() {
        text.push_str(&format!("{}. {}", index + 1, step.title));
        if let Some(detail) = &step.detail {
            text.push_str(&format!(" — {detail}"));
        }
        text.push('\n');
    }
    text
}

/// What a plan's reviewer reads. A revision's reviewer also sees the plan it revises, that
/// review's findings and the orchestrator's answer to each.
fn review_spec(plan: &Plan, previous: Option<&Plan>, round: u32) -> String {
    let mut spec = "Review this plan before it is carried out. Check it against the repository (read-only): is it sound, complete, and the simplest thing that works? Are there risks, missing steps or wrong assumptions?\n".to_owned();
    if let Some(previous) = previous {
        spec.push_str(&format!(
            "\nThis is review round {round} of {PLAN_ROUNDS}, the last. The orchestrator revised the plan after the earlier review asked for changes.\n\nThe plan before: {}\n{}",
            previous.title,
            steps_text(&previous.steps)
        ));
        spec.push_str("\nThe earlier review's findings and the orchestrator's answers:\n");
        for response in &plan.responses {
            spec.push_str(&format!(
                "- {}: {}\n  {}: {}\n",
                response.id,
                response.finding,
                if response.accepted {
                    "Accepted"
                } else {
                    "Declined"
                },
                response.note
            ));
        }
        spec.push_str("Check that each accepted finding is really fixed in the revised steps and that each decline is sound. Ask for changes only for problems that still matter.\n\nThe revised plan: ");
    } else {
        spec.push_str("\nPlan: ");
    }
    spec.push_str(&format!("{}\n{}", plan.title, steps_text(&plan.steps)));
    spec.push_str("\nEnd with submit_report and a verdict: approve (with any notes for carrying it out in open_questions), or requestChanges with each problem the plan must fix as its own line in open_questions; Brigadier numbers them as findings the orchestrator must answer one by one.");
    spec
}

/// Who reviewed: "task-4 (Claude opus) and task-5 (Codex gpt-5)".
fn reviewers_text(reviewers: &[Task]) -> String {
    reviewers
        .iter()
        .map(|task| {
            format!(
                "task-{} ({})",
                task.number,
                super::workers::route_label(task)
            )
        })
        .collect::<Vec<_>>()
        .join(" and ")
}

/// A round's findings for the orchestrator, one line each with its id and reviewer.
fn findings_list(findings: &[Finding], reviewers: &[Task]) -> String {
    findings
        .iter()
        .map(|finding| {
            let by = reviewers
                .iter()
                .find(|task| task.id == finding.by)
                .map(|task| format!(" (task-{})", task.number))
                .unwrap_or_default();
            format!("{}{by}: {}", finding.id, finding.text)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn approved_text(plan: &Plan, reviewers: &[Task]) -> String {
    let mut text = format!(
        "[decision] The plan \"{}\" was reviewed by {} and approved on the user's behalf. Go ahead, and pass each step's number as `step` when you delegate it.",
        plan.title,
        reviewers_text(reviewers)
    );
    if !plan.review_notes.is_empty() {
        text.push_str("\nThe reviewers' notes, to weigh as you carry it out:");
        for note in &plan.review_notes {
            text.push_str(&format!("\n- {note}"));
        }
    }
    text
}

/// What the user's decision on a plan tells the orchestrator about its review.
pub(crate) fn review_for_decision(plan: &Plan) -> String {
    let mut text = String::new();
    if let Some(gate) = &plan.gate
        && !gate.findings.is_empty()
    {
        text.push_str("\nThe independent review's findings, which the user saw:");
        for finding in &gate.findings {
            text.push_str(&format!("\n- {}: {}", finding.id, finding.text));
        }
    }
    if !plan.review_notes.is_empty() {
        text.push_str("\nThe independent review approved it, with these notes:");
        for note in &plan.review_notes {
            text.push_str(&format!("\n- {note}"));
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::work::TaskId;

    fn step(title: &str, detail: Option<&str>) -> PlanStep {
        PlanStep {
            title: title.into(),
            detail: detail.map(Into::into),
            task_id: None,
        }
    }

    fn finding(id: &str, text: &str) -> Finding {
        Finding {
            id: id.into(),
            text: text.into(),
            by: TaskId("r".into()),
        }
    }

    fn lines(text: &[&str]) -> Vec<String> {
        text.iter().map(|line| (*line).to_owned()).collect()
    }

    #[test]
    fn who_gets_reviewed() {
        // A single step goes at once; two or more get one reviewer; risky gets two.
        assert_eq!(plan_reviewers(1, false, false, None), 0);
        assert_eq!(plan_reviewers(2, false, false, None), 1);
        assert_eq!(plan_reviewers(1, true, false, None), 2);
        assert_eq!(plan_reviewers(5, true, true, None), 2);
        // A revision after a failed round is always reviewed again, even of one step.
        assert_eq!(plan_reviewers(1, false, true, None), 1);
        // After an approved plan, only a revision that adds or changes steps.
        assert_eq!(plan_reviewers(3, false, false, Some(false)), 0);
        assert_eq!(plan_reviewers(1, false, false, Some(true)), 1);
    }

    #[test]
    fn new_or_changed_steps_are_material() {
        let before = [
            step("Add the API", Some("in api.rs")),
            step("Wire the UI", None),
        ];
        // Spacing and case, dropped and reordered steps change nothing material.
        assert!(!adds_or_changes_steps(
            &before,
            &[
                step("wire  the ui", None),
                step("Add the API", Some("In api.rs "))
            ]
        ));
        assert!(!adds_or_changes_steps(
            &before,
            &[step("Wire the UI", None)]
        ));
        assert!(adds_or_changes_steps(
            &before,
            &[
                step("Add the API", Some("in server.rs")),
                step("Wire the UI", None)
            ]
        ));
        assert!(adds_or_changes_steps(
            &before,
            &[
                step("Add the API", Some("in api.rs")),
                step("Migrate the data", None)
            ]
        ));
    }

    #[test]
    fn findings_are_numbered_across_reviewers() {
        let member = |id: &str, result| GateMember {
            task_id: TaskId(id.into()),
            role: GateRole::Review,
            result: Some(result),
            avoid: Vec::new(),
        };
        let findings = number_findings(&[
            member(
                "a",
                GateResult::Failed {
                    findings: vec!["No rollback step".into(), "  ".into()],
                },
            ),
            member("b", GateResult::Passed),
            member(
                "c",
                GateResult::Failed {
                    findings: vec!["Step 2 misses the migration".into()],
                },
            ),
        ]);
        assert_eq!(
            findings,
            vec![
                Finding {
                    id: "F1".into(),
                    text: "No rollback step".into(),
                    by: TaskId("a".into())
                },
                Finding {
                    id: "F2".into(),
                    text: "Step 2 misses the migration".into(),
                    by: TaskId("c".into())
                },
            ]
        );
    }

    #[test]
    fn responses_answer_each_finding() {
        let findings = [finding("F1", "No rollback"), finding("F2", "Too broad")];
        let responses = parse_responses(
            &lines(&[
                "- f2 declined: the scope is what the user asked for",
                "F1 accepted: added step 4, a rollback",
            ]),
            &findings,
        )
        .expect("parsed");
        assert_eq!(
            responses,
            vec![
                FindingResponse {
                    id: "F1".into(),
                    finding: "No rollback".into(),
                    accepted: true,
                    note: "added step 4, a rollback".into(),
                },
                FindingResponse {
                    id: "F2".into(),
                    finding: "Too broad".into(),
                    accepted: false,
                    note: "the scope is what the user asked for".into(),
                },
            ]
        );
        // Several lines in one string, and "F1: accepted" read the same.
        let joined = parse_responses(
            &lines(&["F1: accepted\nF2 decline - not needed"]),
            &findings,
        )
        .expect("parsed");
        assert!(joined[0].accepted && !joined[1].accepted);
        assert_eq!(joined[1].note, "not needed");
    }

    #[test]
    fn an_unanswered_or_bad_response_is_refused() {
        let findings = [finding("F1", "No rollback"), finding("F2", "Too broad")];
        let err = parse_responses(&lines(&["F1 accepted: done"]), &findings).unwrap_err();
        assert!(err.contains("unanswered: F2"), "{err}");
        let err = parse_responses(&lines(&["F1 accepted", "F2 declined"]), &findings).unwrap_err();
        assert!(err.contains("without a reason"), "{err}");
        let err = parse_responses(&lines(&["F3 accepted: x"]), &findings).unwrap_err();
        assert!(err.contains("answers no finding"), "{err}");
        let err = parse_responses(&lines(&["F1 maybe later"]), &findings).unwrap_err();
        assert!(err.contains("neither accepts nor declines"), "{err}");
        let err = parse_responses(
            &lines(&["F1 accepted", "F1 declined: no", "F2 accepted"]),
            &findings,
        )
        .unwrap_err();
        assert!(err.contains("twice"), "{err}");
    }
}
