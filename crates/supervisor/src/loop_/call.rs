//! One disposable model call: spawn, one turn, read the final text, throw the window away.
//!
//! Every child the loop starts is this shape. `docs/vision.md` §1 is the product statement that
//! there is no accumulating session, and §15 item 13 turns it into a rule: **a lead call is never
//! resumed**, because a resumed lead call *is* an accumulating session.
//!
//! The text comes back through
//! [`SessionCommands::final_assistant_text`](brigadier_core::session::SessionCommands::final_assistant_text),
//! which is the only channel that can carry a fenced JSON block: `ItemCompleted.summary` is one
//! bounded line, so a block arrives on the event stream as the single character `{`, and the
//! store's `feed` holds that same line and no body (`docs/research/orchestration-loop.md` §2.2).
//!
//! [`ModelCall`] is a trait because two very different things have to be able to answer it: the
//! real supervised spawn, and a test that must not cost money. Both are held to the same
//! contract, and the interesting half of it is what happens when the child does *not* answer —
//! see [`CallEnd`].

use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use brigadier_core::claude::hook::{policy_for, HookScope};
use brigadier_core::driver::{
    DriverKind, HookOverride, PermissionMode, StartSession, ThinkingPolicy,
};
use brigadier_core::event::{Envelope, Event, SessionId, TurnId};
use brigadier_core::session::FinalTextError;

use crate::loop_::LoopError;
use crate::Supervisor;

/// Where a call's child runs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallCwd {
    /// The project root — the **owner's own checkout** — under
    /// [`brigadier_core::claude::hook::HookScope::Judgement`].
    ///
    /// Used by the planner, lead and fixer-adjacent calls, which read and decide and are told to
    /// write nothing. The gate matters here more than anywhere and it is **not** the permission
    /// mode's to remove: a mode selected in the run dock says what a *worker* may do inside a
    /// worktree brigadier cut and can throw away (`docs/vision.md` §8, §11), and there is no
    /// worktree here. So an unattended lead call that reaches for `Edit` parks in every mode.
    /// What a permissive mode does buy is the thing the flood was made of — `ls`, `grep`, `cat`
    /// stop prompting.
    // see docs/research/permission-modes.md §4.
    ProjectRoot,
    /// A directory the loop already prepared — a worker's worktree, or the per-phase integration
    /// worktree the rung-1 fixer works in. Carries the worker wall for that root.
    Worktree {
        /// The child's `cwd`, which is also the wall's root.
        dir: PathBuf,
        /// The branch checked out there, for the session row.
        branch: Option<String>,
    },
}

/// What to ask for, and how long to wait.
#[derive(Clone, Debug)]
pub struct CallRequest {
    /// Which project the child belongs to.
    pub project_id: String,
    /// A short label for logs and feed lines: `planner`, `lead`, `worker`, `fixer`.
    pub label: &'static str,
    /// Where it runs.
    pub cwd: CallCwd,
    /// The whole prompt, assembled by the harness. Nothing a model wrote in a previous call is
    /// carried forward except as harness-normalised data (`orchestration-loop.md` §2.1).
    pub prompt: String,
    /// No `TurnCompleted` within this → `interrupt`, grace, `kill`.
    pub turn_deadline: Duration,
    /// No envelope of **any** kind within this → the same escalation. Catches a child that is
    /// alive and wedged, which the turn deadline sees only at its end.
    pub quiet_deadline: Duration,
    /// Whether this child reasons. The judgement lane is what opts back in, per spawn.
    pub thinking: ThinkingPolicy,
    /// Model slug, or the provider default.
    pub model: Option<String>,
    /// Exact effort for this call.
    pub effort: Option<String>,
    /// An independently selected registered provider, or the run default.
    pub provider: Option<DriverKind>,
    /// The mode the owner chose for this run.
    ///
    /// It reaches two places, and the second is the one that was missing: the child's
    /// `--permission-mode` flag, **and** the `PreToolUse` policy, via
    /// [`brigadier_core::claude::hook::policy_for`]. Without the second the hook
    /// answers `"ask"` before the CLI ever reads the flag, so the mode changes nothing a human
    /// can see (`docs/research/permission-modes.md` §3).
    pub permission_mode: PermissionMode,
}

/// How a call ended. Only [`CallEnd::Answered`] carries text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallEnd {
    /// A turn completed and its final text was read.
    Answered,
    /// The turn completed but the adapter held no text for it — a driver with no final-text slot,
    /// or a turn that closed without one.
    ///
    /// **Distinct from an empty answer on purpose.** `FinalTextError`'s own doc says why: *"a loop
    /// that reads its next instruction out of a child's final message must be able to tell 'the
    /// child said nothing' from 'this adapter never held that turn'. Returning `""` for both is
    /// how a loop silently does nothing forever."*
    NoText(String),
    /// The turn was aborted.
    Aborted,
    /// The session exited before any turn completed.
    Exited,
    /// No `TurnCompleted` within [`CallRequest::turn_deadline`].
    TurnDeadline,
    /// No envelope at all within [`CallRequest::quiet_deadline`].
    QuietDeadline,
}

impl CallEnd {
    /// Whether the loop got an answer it can try to parse.
    #[must_use]
    pub fn answered(&self) -> bool {
        matches!(self, Self::Answered)
    }

    /// A stable slug, for a feed line or a plan card.
    #[must_use]
    pub fn slug(&self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::NoText(_) => "no_text",
            Self::Aborted => "aborted",
            Self::Exited => "exited",
            Self::TurnDeadline => "turn_deadline",
            Self::QuietDeadline => "quiet_deadline",
        }
    }
}

/// What one call produced.
#[derive(Clone, Debug)]
pub struct CallOutcome {
    /// The session that ran it, when one was started. `None` when the spawn itself failed.
    pub session_id: Option<SessionId>,
    /// The turn's whole final assistant text, when there is one.
    pub text: String,
    /// How it ended.
    pub end: CallEnd,
    /// Whether the child parked on an approval at any point during the call.
    ///
    /// Recorded rather than acted on: `docs/vision.md` §8 says a queued approval parks **one work
    /// order, never the run**, and the deadlines are suspended while it is parked so the harness
    /// cannot kill the exact worker the owner is about to unblock (§15 item 14).
    pub parked: bool,
}

/// One disposable model call.
///
/// A trait so the loop's spine can be driven with no child process and no money spent. The
/// production implementation is [`SupervisedCall`].
pub trait ModelCall: Send + Sync + std::fmt::Debug {
    /// Run one call to completion. Never resumes, never returns a live session.
    fn call<'a>(
        &'a self,
        req: CallRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CallOutcome, LoopError>> + Send + 'a>,
    >;
}

/// The production [`ModelCall`]: a real supervised child, one turn, then killed.
#[derive(Clone, Debug)]
pub struct SupervisedCall {
    sup: Supervisor,
    kind: DriverKind,
    project_root: PathBuf,
    stop: Arc<AtomicBool>,
    policy: Option<(crate::orchestration::Policy, String)>,
}

impl SupervisedCall {
    /// Calls into `project_root` on the driver registered for `kind`.
    #[must_use]
    pub fn new(sup: Supervisor, kind: DriverKind, project_root: PathBuf) -> Self {
        Self {
            sup,
            kind,
            project_root,
            stop: Arc::new(AtomicBool::new(false)),
            policy: None,
        }
    }
}

impl SupervisedCall {
    /// Apply the same worker policy and durable task allowance as conversational delegation.
    pub fn with_policy(mut self, policy: crate::orchestration::Policy, task: String) -> Self {
        self.policy = Some((policy, task));
        self
    }
    /// Share root cancellation with all owned calls.
    pub fn with_stop(mut self, stop: Arc<AtomicBool>) -> Self {
        self.stop = stop;
        self
    }
}

impl ModelCall for SupervisedCall {
    fn call<'a>(
        &'a self,
        req: CallRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CallOutcome, LoopError>> + Send + 'a>,
    > {
        Box::pin(async move { self.run(req).await })
    }
}

impl SupervisedCall {
    async fn run(&self, mut req: CallRequest) -> Result<CallOutcome, LoopError> {
        // Two axes, not one: the mode says how much the owner wants gated, and the scope says
        // what a mistake would cost. A worker's worktree can be thrown away; the project root
        // cannot. `docs/research/permission-modes.md` §4.
        let (dir, branch, scope) = match &req.cwd {
            CallCwd::ProjectRoot => (self.project_root.clone(), None, HookScope::Judgement),
            CallCwd::Worktree { dir, branch } => (
                dir.clone(),
                branch.clone(),
                HookScope::Worker { root: dir.clone() },
            ),
        };

        if let Some((policy, task)) = &self.policy {
            if self.stop.load(Ordering::Acquire) {
                return Ok(CallOutcome {
                    session_id: None,
                    text: String::new(),
                    end: CallEnd::Aborted,
                    parked: false,
                });
            }
            let path = self.sup.data_dir().join("routing-journal.json");
            let worker = matches!(
                req.label,
                "worker"
                    | "fixer"
                    | "reviewer"
                    | "ordinary-repair"
                    | "repair-alternative-a"
                    | "repair-alternative-b"
            );
            if let Err(error) = crate::orchestration::discover(&self.sup).await {
                tracing::debug!(%error,"Worker discovery incomplete");
            }
            let journal = crate::orchestration::journal(&path)?;
            let builder_provider = journal
                .calls
                .iter()
                .rev()
                .filter(|c| c.task == *task)
                .filter_map(|c| c.selection.as_ref())
                .find(|s| s.workload == "implementation")
                .map(|s| s.provider.clone());
            let selection = if worker {
                let proposal = crate::orchestration::Proposal {
                    minimum_quality: None,
                    context_tokens: 0,
                    needs_images: false,
                    provider: req.provider.as_ref().map(ToString::to_string),
                    model: req.model.clone(),
                    effort: req.effort.clone(),
                    pinned: false,
                    workload: if req.label == "reviewer" {
                        "review"
                    } else {
                        "implementation"
                    }
                    .into(),
                    reason: format!("Automatic workflow {}", req.label),
                    avoid_provider: (req.label == "reviewer")
                        .then_some(builder_provider)
                        .flatten(),
                };
                let s = crate::orchestration::select(
                    policy,
                    &crate::orchestration::candidates(&self.sup),
                    &proposal,
                    &journal.evidence,
                    |p| brigadier_core::allowance::blocked_provider(p).is_some(),
                    crate::orchestration::now(),
                )
                .map_err(|e| LoopError::Io(std::io::Error::other(e)))?;
                req.provider = Some(DriverKind::new(&s.provider));
                req.model = Some(s.model.clone());
                req.effort = s.effort.clone();
                req.thinking = ThinkingPolicy::Inherit;
                Some(s)
            } else {
                None
            };
            crate::orchestration::reserve(
                &path,
                crate::orchestration::DispatchRecord {
                    id: uuid::Uuid::new_v4().to_string(),
                    task: task.clone(),
                    cwd: dir.to_string_lossy().into(),
                    selection,
                },
                policy.max_dispatches,
            )?;
        }
        let provider = req.provider.as_ref().unwrap_or(&self.kind);
        while let Some(waiting) = brigadier_core::allowance::blocked_provider(provider.as_str()) {
            if self.stop.load(Ordering::Acquire) {
                return Ok(CallOutcome {
                    session_id: None,
                    text: String::new(),
                    end: CallEnd::Aborted,
                    parked: false,
                });
            }
            // Waiting is backed by the durable account observation. No model substitution and
            // no blind replay of an already-sent turn; this guard runs before spawn only.
            tracing::debug!(provider = %provider, reset_at = ?waiting.reset_at, "waiting for observed allowance");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let mut start = StartSession::new(dir.clone());
        // Initialize idle: a Stop arriving during provider startup must never dispatch the goal.
        start.prompt = None;
        if self.stop.load(Ordering::Acquire) {
            return Ok(CallOutcome {
                session_id: None,
                text: String::new(),
                end: CallEnd::Aborted,
                parked: false,
            });
        }
        start.model = req.model.clone();
        start.effort = req.effort.clone();
        start.thinking = req.thinking;
        start.permission_mode = req.permission_mode.clone();
        let scope = if req.permission_mode == PermissionMode::Plan {
            HookScope::Judgement
        } else {
            scope
        };
        start.hook_policy = HookOverride::new(policy_for(&req.permission_mode, &scope));

        let started = Instant::now();
        let spawned = self
            .sup
            .spawn_in(
                &req.project_id,
                req.provider.as_ref().unwrap_or(&self.kind),
                start,
                dir,
                branch,
            )
            .await?;
        let session_id = spawned.session_id.clone();
        if self.stop.load(Ordering::Acquire) {
            let _ = self.sup.kill(&session_id).await;
            return Ok(CallOutcome {
                session_id: Some(session_id),
                text: String::new(),
                end: CallEnd::Aborted,
                parked: false,
            });
        }
        let sent = {
            let sending = self.sup.send_input(
                &session_id,
                brigadier_core::session::TurnInput::text(req.prompt.clone()),
            );
            tokio::pin!(sending);
            loop {
                tokio::select! {
                    result = &mut sending => break Some(result),
                    _ = tokio::time::sleep(Duration::from_millis(50)) => {
                        if self.stop.load(Ordering::Acquire) { break None; }
                    }
                }
            }
        };
        match sent {
            Some(Ok(_)) => {}
            Some(Err(error)) => {
                let _ = self.sup.kill(&session_id).await;
                return Err(error.into());
            }
            None => {
                // A checkpoint/send interrupted before acknowledgement remains uncertain in
                // its durable journal. Stop kills the provider and never retries the input.
                let _ = self.sup.kill(&session_id).await;
                return Ok(CallOutcome {
                    session_id: Some(session_id),
                    text: String::new(),
                    end: CallEnd::Aborted,
                    parked: false,
                });
            }
        }
        let outcome = self.watch(spawned, &req).await;

        // Always. A one-turn child that answered is finished with, and one that did not is worse:
        // §15 item 13's "lead calls are one turn and disposable" is enforced here and nowhere
        // else. A kill on a session that already exited is a no-op.
        let _ = self.sup.kill(&session_id).await;

        // A call that never answered used to end in **silence**. The child was killed, the window
        // was thrown away, and the only trace was a `tracing` line nobody reads — which is why
        // the owner's first run showed a plan card saying "no phases yet" and nothing anywhere
        // saying the planner had been killed at 120 s. One warning row, naming what ended, how,
        // and after how long. After the kill, so the thread reads in the order it happened.
        if !outcome.end.answered() {
            self.sup
                .warn(
                    &req.project_id,
                    &session_id,
                    format!(
                        "the {} call ended {} after {}s without an answer; its window was \
                         thrown away",
                        req.label,
                        outcome.end.slug(),
                        started.elapsed().as_secs()
                    ),
                )
                .await;
        }
        Ok(outcome)
    }

    /// Watch one call's stream, honouring both clocks and the parking suspension.
    async fn watch(&self, spawned: crate::Spawned, req: &CallRequest) -> CallOutcome {
        let crate::Spawned {
            session_id,
            mut events,
        } = spawned;
        let mut turn: Option<TurnId> = None;
        let mut parked = false;
        let mut parks_open = 0usize;
        let started = Instant::now();
        let mut last_seen = Instant::now();
        // Accumulated time spent parked, subtracted from both clocks. The alternative — pausing
        // and resuming a timer — reads the same and is harder to be sure of.
        let mut parked_for = Duration::ZERO;
        let mut parked_since: Option<Instant> = None;
        // How much of `parked_for` had already accrued when `last_seen` was last reset. Without
        // it the quiet clock would subtract *every* pause this call ever took from a window that
        // began after them, and one resolved approval would suspend the quiet deadline for good.
        let mut parked_before_last_seen = Duration::ZERO;

        let end =
            loop {
                let suspended = parks_open > 0;
                let paused = parked_for + parked_since.map_or(Duration::ZERO, |t| t.elapsed());
                let turn_left = req
                    .turn_deadline
                    .saturating_sub(started.elapsed().saturating_sub(paused));
                let quiet_left = req.quiet_deadline.saturating_sub(
                    last_seen
                        .elapsed()
                        .saturating_sub(paused - parked_before_last_seen),
                );
                let wait = if suspended {
                    Duration::from_millis(50)
                } else {
                    turn_left.min(quiet_left)
                };

                if self.stop.load(Ordering::Acquire) {
                    break CallEnd::Aborted;
                }
                // A short cancellation tick remains active even during parked approvals.
                let next =
                    match tokio::time::timeout(wait.min(Duration::from_millis(50)), events.recv())
                        .await
                    {
                        Ok(next) => next,
                        Err(_) => {
                            if !suspended && (turn_left.is_zero() || quiet_left.is_zero()) {
                                break if turn_left <= quiet_left {
                                    CallEnd::TurnDeadline
                                } else {
                                    CallEnd::QuietDeadline
                                };
                            }
                            continue;
                        }
                    };

                let Some(env) = next else {
                    break CallEnd::Exited;
                };
                last_seen = Instant::now();
                parked_before_last_seen =
                    parked_for + parked_since.map_or(Duration::ZERO, |t| t.elapsed());
                match env.event {
                    Event::TurnStarted { turn_id } => turn = Some(turn_id),
                    Event::TurnCompleted { turn_id, .. } => {
                        turn = Some(turn_id);
                        break CallEnd::Answered;
                    }
                    Event::TurnAborted { .. } => break CallEnd::Aborted,
                    Event::SessionExited { .. } => break CallEnd::Exited,
                    Event::RequestOpened { .. } => {
                        parked = true;
                        parks_open += 1;
                        if parked_since.is_none() {
                            parked_since = Some(Instant::now());
                        }
                    }
                    Event::RequestResolved { .. } => {
                        parks_open = parks_open.saturating_sub(1);
                        if parks_open == 0 {
                            if let Some(since) = parked_since.take() {
                                parked_for += since.elapsed();
                            }
                        }
                    }
                    _ => {}
                }
            };

        let (end, text) = match (&end, &turn) {
            (CallEnd::Answered, Some(turn_id)) => match self.text(&session_id, turn_id).await {
                Ok(text) => (CallEnd::Answered, text),
                Err(why) => (CallEnd::NoText(why.to_string()), String::new()),
            },
            _ => (end, String::new()),
        };
        drain(&mut events);
        CallOutcome {
            session_id: Some(session_id),
            text,
            end,
            parked,
        }
    }

    async fn text(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> Result<String, FinalTextError> {
        match self.sup.commands(session_id) {
            Ok(commands) => commands.final_assistant_text(turn_id.clone()).await,
            // The session's consumer removed it between the terminal event and this read. The
            // text lives in a slot that outlives the adapter's loop, but not one that outlives
            // the live map, so this is the honest answer rather than an empty string.
            Err(_) => Err(FinalTextError::NoCompletedTurn),
        }
    }
}

/// Read whatever is already queued and throw it away, so the mirror does not hold envelopes for
/// a call nobody is watching any more.
fn drain(events: &mut tokio::sync::mpsc::UnboundedReceiver<Envelope>) {
    while events.try_recv().is_ok() {}
}

/// A [`ModelCall`] that answers from a script, counts its spawns, and never costs anything.
///
/// This is how the spine's control flow is proved: the assertions that matter — *two malformed
/// actions spawn no third child*, *a barrier that never resolves spawns nothing*, *a cap of two
/// runs two at a time* — are all counts of calls, and a count is exactly what this records.
#[derive(Debug, Default)]
pub struct ScriptedCall {
    inner: std::sync::Mutex<ScriptState>,
    /// Delay before each answer, so concurrency is observable.
    pub delay: Duration,
}

#[derive(Debug, Default)]
struct ScriptState {
    /// Answers, keyed by label, taken in order; the last is repeated once exhausted.
    answers: std::collections::BTreeMap<&'static str, std::collections::VecDeque<CallOutcome>>,
    calls: Vec<CallRequest>,
    live: usize,
    peak: usize,
}

impl ScriptedCall {
    /// An empty script. Every call it cannot answer ends [`CallEnd::Exited`] with no text.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue one answer for calls carrying `label`.
    #[must_use]
    pub fn answering(self, label: &'static str, text: impl Into<String>) -> Self {
        self.push(
            label,
            CallOutcome {
                session_id: None,
                text: text.into(),
                end: CallEnd::Answered,
                parked: false,
            },
        )
    }

    /// Queue one non-answer for calls carrying `label`.
    #[must_use]
    pub fn ending(self, label: &'static str, end: CallEnd) -> Self {
        self.push(
            label,
            CallOutcome {
                session_id: None,
                text: String::new(),
                end,
                parked: false,
            },
        )
    }

    fn push(self, label: &'static str, outcome: CallOutcome) -> Self {
        self.state()
            .answers
            .entry(label)
            .or_default()
            .push_back(outcome);
        self
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ScriptState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// How many calls have been made, in order.
    #[must_use]
    pub fn calls(&self) -> Vec<CallRequest> {
        self.state().calls.clone()
    }

    /// How many calls were made with `label`.
    #[must_use]
    pub fn count(&self, label: &str) -> usize {
        self.state()
            .calls
            .iter()
            .filter(|c| c.label == label)
            .count()
    }
}

impl ModelCall for ScriptedCall {
    fn call<'a>(
        &'a self,
        req: CallRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CallOutcome, LoopError>> + Send + 'a>,
    > {
        Box::pin(async move {
            let (outcome, delay) = {
                let mut state = self.state();
                state.calls.push(req.clone());
                state.live += 1;
                state.peak = state.peak.max(state.live);
                let queued = state.answers.get_mut(req.label).and_then(|q| {
                    if q.len() > 1 {
                        q.pop_front()
                    } else {
                        q.front().cloned()
                    }
                });
                (
                    queued.unwrap_or(CallOutcome {
                        session_id: None,
                        text: String::new(),
                        end: CallEnd::Exited,
                        parked: false,
                    }),
                    self.delay,
                )
            };
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            self.state().live -= 1;
            Ok(outcome)
        })
    }
}

/// A shared [`ModelCall`].
pub type SharedCall = Arc<dyn ModelCall>;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_scripted_call_answers_in_order_and_repeats_its_last() {
        let script = ScriptedCall::new()
            .answering("lead", "one")
            .answering("lead", "two");
        let req = |label| CallRequest {
            project_id: "p".into(),
            label,
            cwd: CallCwd::ProjectRoot,
            prompt: String::new(),
            turn_deadline: Duration::from_secs(1),
            quiet_deadline: Duration::from_secs(1),
            thinking: ThinkingPolicy::Off,
            model: None,
            effort: None,
            provider: None,
            permission_mode: PermissionMode::Default,
        };
        assert_eq!(script.call(req("lead")).await.expect("call").text, "one");
        assert_eq!(script.call(req("lead")).await.expect("call").text, "two");
        assert_eq!(script.call(req("lead")).await.expect("call").text, "two");
        assert_eq!(script.count("lead"), 3);
        // An unscripted label is an ended session, never a silent empty answer.
        assert_eq!(
            script.call(req("worker")).await.expect("call").end,
            CallEnd::Exited
        );
    }

    #[test]
    fn no_text_is_not_an_empty_answer() {
        assert!(CallEnd::Answered.answered());
        assert!(!CallEnd::NoText("held nothing".into()).answered());
        assert_eq!(CallEnd::NoText(String::new()).slug(), "no_text");
    }
}
