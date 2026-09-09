//! Assignment identity, policy decisions and user-authorized orchestration allowances.
use super::*;
use brigadier_supervisor::orchestration::{self, Policy, Proposal, Selection};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Assignment {
    #[serde(default)]
    pub assignment_id: String,
    #[serde(default)]
    pub requirements: Proposal,
    #[serde(default)]
    pub continued_from: Option<String>,
    #[serde(default)]
    pub active_turn: Option<String>,
    #[serde(default)]
    pub active_receipt: Option<String>,
    #[serde(default)]
    pub last_terminal: Option<(String, String)>,
    #[serde(default)]
    pub baseline: Option<String>,
    #[serde(default)]
    pub review_of: Option<ReviewedCandidate>,
    #[serde(default)]
    pub history: Vec<Value>,
    pub objective: String,
    pub criteria: String,
    pub scope: String,
    pub operation: String,
    pub selection: Selection,
    pub state: String,
    pub disposition: String,
    pub revision: u64,
    #[serde(default)]
    pub generation: u64,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub result: Option<String>,
    pub evidence: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Allowance {
    pub receipts: Vec<String>,
    pub extra: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Grant {
    pub payload: Value,
    pub approved: Option<bool>,
}

pub(crate) fn claim(
    data: &mut PeerData,
    root: &str,
    receipt: &str,
    policy: &Policy,
) -> Result<(), AppError> {
    let allowance = data.allowances.entry(root.into()).or_default();
    if allowance.receipts.iter().any(|r| r == receipt) {
        return Ok(());
    }
    if allowance.receipts.len() as u64 >= policy.max_dispatches.saturating_add(allowance.extra) {
        return Err(AppError::new("task_usage_limit", "Task dispatch allowance reached. Work is preserved. Ask the user to increase the allowance or continue with a cheaper plan; Full access does not bypass this limit."));
    }
    allowance.receipts.push(receipt.into());
    Ok(())
}
/// An approval binds exact JSON and identity. Retrying a denied or changed action cannot reuse it.
pub(crate) fn approval(
    data: &mut PeerData,
    caller: &str,
    root: &str,
    key: &str,
    payload: Value,
    action: &str,
) -> Result<bool, AppError> {
    if let Some(grant) = data.grants.get(key) {
        if grant.payload != payload {
            return Err(AppError::invalid_argument(
                "Approval identity was reused for a different action",
            ));
        }
        return match grant.approved {
            Some(true) => Ok(true),
            Some(false) => Err(AppError::new(
                "approval_denied",
                "User declined this action",
            )),
            None => Ok(false),
        };
    }
    data.grants.insert(
        key.into(),
        Grant {
            payload,
            approved: None,
        },
    );
    data.requests.push(ManageRequest {
        id: key.into(),
        from: caller.into(),
        to: root.into(),
        action: action.into(),
        resolved: false,
    });
    Ok(false)
}
pub(crate) async fn route(
    state: &AppState,
    caller: &str,
    project: &str,
    destination: &str,
    v: &Value,
) -> Result<(Policy, Assignment), AppError> {
    if let Err(error) = orchestration::discover(&state.get()?.supervisor).await {
        tracing::debug!(%error,"Worker discovery incomplete");
    }
    let root = snapshot()?.conversation_owner(caller)?.to_owned();
    let root_row = state
        .get()?
        .supervisor
        .session(&SessionId::new(&root))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Task owner is missing"))?;
    let dir = &state.get()?.data_dir;
    let policy = crate::workbench_data::peer_settings(
        dir,
        root_row.project_id.as_deref().unwrap_or(project),
    )?
    .execution_policy()
    .intersect(&crate::workbench_data::peer_settings(dir, project)?.execution_policy())
    .intersect(&crate::workbench_data::peer_settings(dir, destination)?.execution_policy());
    let operation = v["operation"].as_str().unwrap_or("implementation");
    if !["implementation", "research", "review", "competing"].contains(&operation) {
        return Err(AppError::invalid_argument("Unknown assignment operation"));
    }
    let mut proposal = Proposal {
        provider: v["provider"].as_str().map(str::to_owned),
        model: v["model"].as_str().map(str::to_owned),
        effort: v["effort"].as_str().map(str::to_owned),
        minimum_quality: v["minimumQuality"].as_u64().map(|n| n as u8),
        context_tokens: v["contextTokens"].as_u64().unwrap_or(0),
        needs_images: v["needsImages"].as_bool().unwrap_or(false),
        pinned: v["pinned"].as_bool().unwrap_or(false),
        workload: v["workload"].as_str().unwrap_or(operation).into(),
        reason: v["reason"]
            .as_str()
            .unwrap_or("Bounded assignment proposed by the orchestrator")
            .into(),
        avoid_provider: if operation == "review" {
            v["builderProvider"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| root_row.driver_kind.as_ref().map(|k| k.to_string()))
        } else {
            None
        },
    };
    if v["action"] == "reassign" {
        let data = snapshot()?;
        let prior = data
            .assignments
            .get(v["sessionId"].as_str().unwrap_or(""))
            .ok_or_else(|| AppError::invalid_argument("Prior assignment missing"))?;
        proposal.minimum_quality = Some(
            proposal
                .minimum_quality
                .unwrap_or(2)
                .max(prior.requirements.minimum_quality.unwrap_or(2)),
        );
        proposal.context_tokens = proposal
            .context_tokens
            .max(prior.requirements.context_tokens);
        proposal.needs_images |= prior.requirements.needs_images;
    }
    let selection = if v["action"] == "create" {
        Selection {
            provider: proposal.provider.clone().unwrap_or_else(|| {
                root_row
                    .driver_kind
                    .as_ref()
                    .map(ToString::to_string)
                    .unwrap_or_default()
            }),
            model: proposal.model.clone().unwrap_or_else(|| "auto".into()),
            effort: proposal.effort.clone().filter(|e| e != "auto"),
            reason: "Exact conversation selection; no worker routing".into(),
            version: String::new(),
            workload: String::new(),
            pinned: true,
            alternatives: vec![],
        }
    } else {
        orchestration::select(
            &policy,
            &orchestration::candidates(&state.get()?.supervisor),
            &proposal,
            &orchestration::journal(&dir.join("routing-journal.json"))?.evidence,
            |p| brigadier_core::allowance::blocked_provider(p).is_some(),
            orchestration::now(),
        )
        .map_err(|e| AppError::new("worker_routing", e))?
    };
    if let Some(p) = orchestration::candidates(&state.get()?.supervisor)
        .into_iter()
        .find(|c| c.provider == selection.provider && c.model == selection.model)
        .and_then(|c| c.profile)
    {
        proposal.minimum_quality = Some(proposal.minimum_quality.unwrap_or(2).max(p.quality));
    }
    Ok((policy,Assignment{requirements:proposal,assignment_id:uuid::Uuid::new_v4().to_string(),continued_from:None,active_turn:None,active_receipt:None,last_terminal:None,review_of:None,baseline:None,history:vec![],objective:v["prompt"].as_str().unwrap_or("").into(),criteria:v["acceptanceCriteria"].as_str().unwrap_or("Report evidence, checks, artifacts and unresolved requirements against the assignment").into(),scope:v["scope"].as_str().unwrap_or("Isolated task workspace; preserve unrelated work").into(),operation:operation.into(),selection,state:"starting".into(),disposition:"pending".into(),revision:1,generation:1,started_at:orchestration::now(),completed_at:None,result:None,evidence:None}))
}
pub(crate) fn complete(data: &mut PeerData, child: &str, state: &str) {
    if let Some(a) = data.assignments.get_mut(child) {
        // A late terminal signal never erases a durable stopped disposition.
        if a.state == "stopped"
            || a.state == "superseded"
            || a.state == state
            || (state == "stopped" && a.state == "completed")
        {
            return;
        }
        a.revision += 1;
        a.state = state.into();
        a.completed_at = Some(orchestration::now());
        if a.disposition == "pending" {
            a.disposition = if state == "completed" {
                "awaiting-review"
            } else {
                state
            }
            .into();
        }
    }
}
pub(crate) async fn result(state: &AppState, caller: &str, v: &Value) -> Result<Value, AppError> {
    let id = v["sessionId"]
        .as_str()
        .ok_or_else(|| AppError::invalid_argument("Specify sessionId"))?;
    let saved = snapshot()?;
    saved.require_coordination(caller, id)?;
    let candidate = saved
        .assignments
        .get(id)
        .ok_or_else(|| AppError::invalid_argument("Assignment unavailable"))?;
    if matches!(v["disposition"].as_str(), Some("accepted" | "integrated")) {
        let root = saved.conversation_owner(id)?;
        let row = state
            .get()?
            .supervisor
            .session(&SessionId::new(root))
            .await?
            .ok_or_else(|| AppError::invalid_argument("Task owner missing"))?;
        let policy = crate::workbench_data::peer_settings(
            &state.get()?.data_dir,
            row.project_id.as_deref().unwrap_or(""),
        )?
        .execution_policy();
        let target = state
            .get()?
            .supervisor
            .session(&SessionId::new(id))
            .await?
            .ok_or_else(|| AppError::invalid_argument("Candidate missing"))?;
        let policy = policy.intersect(
            &crate::workbench_data::peer_settings(
                &state.get()?.data_dir,
                target.project_id.as_deref().unwrap_or(""),
            )?
            .execution_policy(),
        );
        if review_required(state, id, candidate, &policy).await? {
            let reviewer = v["reviewerSessionId"]
                .as_str()
                .and_then(|id| saved.assignments.get(id))
                .ok_or_else(|| {
                    AppError::new(
                        "review_required",
                        "Independent review is required before accepting this contribution",
                    )
                })?;
            let reviewed = reviewer
                .review_of
                .as_ref()
                .filter(|r| r.session_id == id && r.revision == candidate.generation)
                .ok_or_else(|| {
                    AppError::new(
                        "review_required",
                        "Reviewer must inspect this exact assignment revision",
                    )
                })?;
            if reviewer.state != "completed" || reviewer.operation != "review" {
                return Err(AppError::new(
                    "review_required",
                    "Independent review has not completed",
                ));
            }
            let current = snapshot_candidate(state, id).await?;
            if tree(state, id, &current).await? != tree(state, id, &reviewed.baseline).await? {
                return Err(AppError::new("review_stale","Candidate changed after review. Re-review the changed input before accepting it"));
            }
        }
    }
    change(|data| {
        data.require_coordination(caller, id)?;
        let owner = data.conversation_owner(id)?;
        if caller != id && caller != owner {
            return Err(AppError::invalid_argument(
                "Only the worker or its root may update its assignment",
            ));
        }
        let a = data
            .assignments
            .get_mut(id)
            .ok_or_else(|| AppError::invalid_argument("Assignment is unavailable"))?;
        if v["expectedRevision"].as_u64() != Some(a.revision) {
            return Err(AppError::new(
                "assignment_conflict",
                "Read the current assignment before updating",
            ));
        }
        let status = v["disposition"].as_str().unwrap_or("awaiting-review");
        if a.state != "completed"
            && !(caller == id && status == "awaiting-review" && a.state == "working")
        {
            return Err(AppError::invalid_argument("Only the current worker may submit an active result; judgments require completed work"));
        }
        if caller == id && status != "awaiting-review" {
            return Err(AppError::invalid_argument(
                "A worker cannot accept its own contribution",
            ));
        }
        if ![
            "awaiting-review",
            "accepted",
            "integrated",
            "rejected",
            "needs-revision",
        ]
        .contains(&status)
        {
            return Err(AppError::invalid_argument(
                "Unknown contribution disposition",
            ));
        }
        let evidence = v["evidence"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 16000);
        if ["accepted", "integrated", "rejected"].contains(&status) && evidence.is_none() {
            return Err(AppError::invalid_argument(
                "Record check/review evidence before judging a contribution",
            ));
        }
        a.result = v["result"]
            .as_str()
            .map(|s| s.chars().take(16000).collect())
            .or(a.result.clone());
        a.evidence = evidence.map(str::to_owned).or(a.evidence.clone());
        a.disposition = status.into();
        a.revision += 1;
        // Model judgments are retained but never train routing. Only user-verified acceptance does.
        Ok(json!(a))
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowance_is_durable_idempotent_and_full_access_has_no_escape() {
        let mut d = PeerData::default();
        let p = Policy {
            max_dispatches: 1,
            ..Default::default()
        };
        claim(&mut d, "root", "a", &p).unwrap();
        let mut d: PeerData = serde_json::from_slice(&serde_json::to_vec(&d).unwrap()).unwrap();
        claim(&mut d, "root", "a", &p).unwrap();
        assert!(claim(&mut d, "root", "b", &p).is_err());
    }
    #[test]
    fn approval_binds_exact_action_and_denial() {
        let mut d = PeerData::default();
        assert!(!approval(
            &mut d,
            "worker",
            "root",
            "a",
            json!({"prompt":"one"}),
            "competing implementations"
        )
        .unwrap());
        d.grants.get_mut("a").unwrap().approved = Some(true);
        assert!(approval(
            &mut d,
            "worker",
            "root",
            "a",
            json!({"prompt":"two"}),
            "competing implementations"
        )
        .is_err());
        assert!(approval(
            &mut d,
            "worker",
            "root",
            "a",
            json!({"prompt":"one"}),
            "competing implementations"
        )
        .unwrap());
    }
}

pub(crate) fn stop(ids: &[String]) -> Result<(), AppError> {
    change(|d| {
        for id in ids {
            complete(d, id, "stopped");
        }
        Ok(())
    })
}

impl Assignment {
    pub(crate) fn begin(&mut self, objective: &str) {
        self.history.push(json!({"revision":self.revision,"objective":self.objective,"state":self.state,"disposition":self.disposition,"result":self.result,"evidence":self.evidence}));
        self.revision += 1;
        self.generation += 1;
        self.active_turn = None;
        self.last_terminal = None;
        self.started_at = orchestration::now();
        self.objective = objective.into();
        self.state = "working".into();
        self.disposition = "pending".into();
        self.completed_at = None;
        self.result = None;
        self.evidence = None;
    }
}
/// Reservation and concurrency share one admission rule across initial and follow-up dispatch.
pub(crate) fn admit(
    data: &mut PeerData,
    root: &str,
    target: Option<&str>,
    receipt: &str,
    policy: &Policy,
) -> Result<(), AppError> {
    let internal = target.is_none_or(|id| data.subagents.contains_key(id));
    if internal {
        let active = data
            .assignments
            .iter()
            .filter(|(id, a)| {
                Some(id.as_str()) != target
                    && data.conversation_owner(id).ok() == Some(root)
                    && matches!(a.state.as_str(), "starting" | "working" | "waiting")
            })
            .count();
        if active >= policy.concurrency {
            return Err(AppError::new(
                "worker_limit",
                "Task worker concurrency reached; wait before dispatching more work",
            ));
        }
    }
    let existing = data
        .allowances
        .get(root)
        .is_some_and(|a| a.receipts.iter().any(|r| r == receipt));
    claim(data, root, receipt, policy)?;
    if !existing {
        if let Some(a) = target.and_then(|id| data.assignments.get_mut(id)) {
            a.state = "starting".into();
            a.disposition = "pending".into();
            a.active_turn = None;
            a.active_receipt = Some(receipt.into());
            a.last_terminal = None;
            a.revision += 1;
        }
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Competition {
    #[serde(default)]
    pub requests: Vec<String>,
    baseline: String,
    project: String,
    criteria: String,
    scope: String,
}
pub(crate) async fn competition(
    state: &AppState,
    caller: &str,
    project: &str,
    a: &Assignment,
    v: &Value,
) -> Result<String, AppError> {
    let root = snapshot()?.conversation_owner(caller)?.to_owned();
    let group = v["competitionId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 200)
        .ok_or_else(|| {
            AppError::invalid_argument(
                "Supply the same competitionId for the two isolated attempts",
            )
        })?;
    let key = format!("{root}:{group}");
    if let Some(c) = snapshot()?.competitions.get(&key) {
        if c.project != project || c.criteria != a.criteria || c.scope != a.scope {
            return Err(AppError::invalid_argument(
                "Competing attempts must use the same project, scope and acceptance criteria",
            ));
        }
        return Ok(c.baseline.clone());
    }
    let sup = &state.get()?.supervisor;
    let p = sup
        .project(project)
        .await?
        .ok_or_else(|| AppError::invalid_argument("Project missing"))?;
    let source = sup
        .session(&SessionId::new(caller))
        .await?
        .filter(|r| r.project_id.as_deref() == Some(project))
        .and_then(|r| r.worktree_path.or(r.cwd))
        .unwrap_or_else(|| p.root_path.clone());
    let baseline = brigadier_supervisor::worktree::capture_baseline(
        &p.root_path,
        &source,
        &state.get()?.data_dir.join("worker-inputs"),
    )
    .await?;
    change(|d| {
        d.competitions.insert(
            key,
            Competition {
                requests: vec![],
                baseline: baseline.clone(),
                project: project.into(),
                criteria: a.criteria.clone(),
                scope: a.scope.clone(),
            },
        );
        Ok(())
    })?;
    Ok(baseline)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewedCandidate {
    pub session_id: String,
    pub revision: u64,
    pub baseline: String,
}
async fn git_at(state: &AppState, id: &str, args: &[&str]) -> Result<String, AppError> {
    let row = state
        .get()?
        .supervisor
        .session(&SessionId::new(id))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Candidate missing"))?;
    let cwd = row
        .worktree_path
        .or(row.cwd)
        .ok_or_else(|| AppError::invalid_argument("Candidate workspace missing"))?;
    let git = brigadier_core::worktree::resolve_git()
        .ok_or_else(|| AppError::invalid_argument("Git unavailable"))?;
    let out = tokio::process::Command::new(git)
        .current_dir(cwd)
        .args(args)
        .output()
        .await?;
    if !out.status.success() {
        return Err(AppError::io(String::from_utf8_lossy(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
async fn tree(state: &AppState, id: &str, commit: &str) -> Result<String, AppError> {
    git_at(state, id, &["rev-parse", &format!("{commit}^{{tree}}")]).await
}
pub(crate) async fn snapshot_candidate(state: &AppState, id: &str) -> Result<String, AppError> {
    let sup = &state.get()?.supervisor;
    let row = sup
        .session(&SessionId::new(id))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Candidate missing"))?;
    let project = sup
        .project(row.project_id.as_deref().unwrap_or(""))
        .await?
        .ok_or_else(|| AppError::invalid_argument("Candidate project missing"))?;
    let source = row
        .worktree_path
        .or(row.cwd)
        .ok_or_else(|| AppError::invalid_argument("Candidate workspace missing"))?;
    Ok(brigadier_supervisor::worktree::capture_baseline(
        &project.root_path,
        &source,
        &state.get()?.data_dir.join("worker-inputs"),
    )
    .await?)
}
pub(crate) async fn prepare_review(
    state: &AppState,
    caller: &str,
    v: &Value,
    a: &mut Assignment,
) -> Result<(), AppError> {
    let target = v["reviewOf"].as_str().ok_or_else(|| {
        AppError::invalid_argument(
            "Independent review requires reviewOf naming the candidate worker",
        )
    })?;
    let d = snapshot()?;
    d.require_coordination(caller, target)?;
    if d.conversation_owner(caller)? != d.conversation_owner(target)? {
        return Err(AppError::invalid_argument(
            "Review must belong to the same task",
        ));
    }
    let candidate = d
        .assignments
        .get(target)
        .filter(|a| a.state == "completed")
        .ok_or_else(|| {
            AppError::invalid_argument(
                "Wait for the candidate assignment to finish before independent review",
            )
        })?;
    let baseline = snapshot_candidate(state, target).await?;
    a.baseline = Some(baseline.clone());
    a.criteria = candidate.criteria.clone();
    a.scope = candidate.scope.clone();
    a.review_of = Some(ReviewedCandidate {
        session_id: target.into(),
        revision: candidate.generation,
        baseline,
    });
    Ok(())
}
pub(crate) async fn record_baseline(state: &AppState, id: &str) -> Result<(), AppError> {
    if !snapshot()?.assignments.contains_key(id) {
        return Ok(());
    }
    let baseline = git_at(state, id, &["rev-parse", "HEAD"]).await?;
    change(|d| {
        if let Some(a) = d.assignments.get_mut(id) {
            if a.baseline.is_none() {
                a.baseline = Some(baseline);
            }
        }
        Ok(())
    })
}
async fn review_required(
    state: &AppState,
    id: &str,
    a: &Assignment,
    p: &Policy,
) -> Result<bool, AppError> {
    use brigadier_supervisor::orchestration::ReviewIntensity;
    if a.operation == "review" || a.operation == "research" {
        return Ok(p.review == ReviewIntensity::Always);
    }
    if p.review == ReviewIntensity::Always || a.operation == "competing" {
        return Ok(true);
    }
    if p.review == ReviewIntensity::Manual {
        return Ok(false);
    }
    let Some(base) = &a.baseline else {
        return Ok(true);
    };
    let paths = git_at(state, id, &["diff", "--name-only", base]).await?;
    let untracked = git_at(state, id, &["ls-files", "--others", "--exclude-standard"]).await?;
    Ok(brigadier_supervisor::orchestration::consequential(
        &format!("{paths}\n{untracked}"),
    ))
}

pub(crate) fn terminal(data: &mut PeerData, id: &str, turn: &str, state: &str) {
    if let Some(a) = data.assignments.get_mut(id) {
        a.last_terminal = Some((turn.into(), state.into()));
        if a.active_turn.as_deref() != Some(turn) {
            return;
        }
    }
    complete(data, id, state);
}

/// Delivery acknowledgment, not queue acceptance, starts the next assignment generation.
pub(crate) fn acknowledge(data: &mut PeerData, message: &Message, turn: &str, user_stopped: bool) {
    let Some(a) = data.assignments.get_mut(&message.to) else {
        return;
    };
    if a.state == "superseded"
        || message.error.is_some()
        || a.active_receipt.as_deref() != Some(message.id.as_str())
    {
        a.history.push(json!({"deliveredTurn":turn,"instruction":message.text,"applied":false,"reason":"superseded or cancelled delivery"}));
        return;
    }
    let early = a.last_terminal.clone().filter(|(id, _)| id == turn);
    if user_stopped {
        a.history
            .push(json!({"deliveredTurn":turn,"instruction":message.text,"stopped":true}));
        a.active_turn = Some(turn.into());
        a.state = "stopped".into();
        a.disposition = "stopped".into();
        a.revision += 1;
        return;
    }
    if !message.initial {
        a.begin(&message.text);
    }
    a.active_turn = Some(turn.into());
    a.state = "working".into();
    if let Some((_, state)) = early {
        complete(data, &message.to, &state);
    }
}

#[cfg(test)]
mod transition_tests {
    use super::*;
    fn assignment() -> Assignment {
        serde_json::from_value(json!({"objective":"Implement","criteria":"preserve data","scope":"src","operation":"implementation","selection":{"provider":"codex","model":"test","effort":null,"reason":"test","version":"1","workload":"implementation","pinned":false,"alternatives":[]},"activeReceipt":"new","state":"completed","disposition":"accepted","revision":3,"generation":1,"startedAt":1,"completedAt":2,"result":"old result","evidence":"old check"})).unwrap()
    }
    fn message() -> Message {
        Message {
            id: "new".into(),
            from: "root".into(),
            to: "worker".into(),
            text: "new requirement".into(),
            work: true,
            delivered: false,
            error: None,
            resume: false,
            turn_id: None,
            attachment_ids: vec![],
            attachments: vec![],
            request_id: None,
            attempted: true,
            uncertain: false,
            initial: false,
            completion_seq: None,
        }
    }
    #[test]
    fn stale_result_cannot_cross_acknowledged_generation() {
        let mut d = PeerData::default();
        d.assignments.insert("worker".into(), assignment());
        acknowledge(&mut d, &message(), "next", false);
        let a = &d.assignments["worker"];
        assert_eq!(a.generation, 2);
        assert!(a.revision > 3);
        assert_eq!(a.result, None);
        assert_eq!(a.evidence, None);
        assert_eq!(a.history[0]["result"], "old result");
        terminal(&mut d, "worker", "old", "completed");
        assert_eq!(d.assignments["worker"].state, "working");
        terminal(&mut d, "worker", "next", "completed");
        assert_eq!(d.assignments["worker"].disposition, "awaiting-review");
    }
    #[test]
    fn stop_wins_over_ack_and_late_result() {
        let mut d = PeerData::default();
        d.assignments.insert("worker".into(), assignment());
        acknowledge(&mut d, &message(), "next", true);
        terminal(&mut d, "worker", "next", "completed");
        assert_eq!(d.assignments["worker"].state, "stopped");
        assert_eq!(d.assignments["worker"].disposition, "stopped");
    }
    #[test]
    fn completion_before_send_ack_is_retained() {
        let mut d = PeerData::default();
        d.assignments.insert("worker".into(), assignment());
        terminal(&mut d, "worker", "next", "failed");
        acknowledge(&mut d, &message(), "next", false);
        assert_eq!(d.assignments["worker"].state, "failed");
    }
    #[test]
    fn late_receipts_cannot_change_replacement_or_redirect() {
        let mut d = PeerData::default();
        let mut a = assignment();
        a.state = "superseded".into();
        d.assignments.insert("worker".into(), a);
        acknowledge(&mut d, &message(), "late", false);
        assert_eq!(d.assignments["worker"].state, "superseded");
        let a = d.assignments.get_mut("worker").unwrap();
        a.state = "working".into();
        a.active_receipt = Some("replacement".into());
        acknowledge(&mut d, &message(), "late", false);
        assert_eq!(d.assignments["worker"].state, "working");
        assert_ne!(d.assignments["worker"].active_turn.as_deref(), Some("late"));
        delivery_failed(&mut d, &message(), &AppError::io("cancelled"));
        assert_eq!(d.assignments["worker"].state, "working");
        let mut cancelled = message();
        cancelled.id = "replacement".into();
        cancelled.error = Some("Cancelled".into());
        acknowledge(&mut d, &cancelled, "cancelled-turn", false);
        delivery_failed(&mut d, &cancelled, &AppError::io("cancelled"));
        assert_eq!(d.assignments["worker"].state, "working");
        assert_ne!(
            d.assignments["worker"].active_turn.as_deref(),
            Some("cancelled-turn")
        );
    }
    #[test]
    fn followup_admission_respects_busy_sibling_and_project_intersection() {
        let mut d = PeerData::default();
        d.subagents.insert("worker".into(), "root".into());
        d.subagents.insert("sibling".into(), "root".into());
        d.assignments.insert("worker".into(), assignment());
        let mut busy = assignment();
        busy.state = "working".into();
        d.assignments.insert("sibling".into(), busy);
        let policy = Policy::default().intersect(&Policy {
            concurrency: 1,
            max_dispatches: 1,
            ..Default::default()
        });
        assert!(admit(&mut d, "root", Some("worker"), "one", &policy).is_err());
        assert!(!d.allowances.contains_key("root"));
        complete(&mut d, "sibling", "completed");
        admit(&mut d, "root", Some("worker"), "one", &policy).unwrap();
        assert!(admit(&mut d, "root", Some("worker"), "two", &policy).is_err());
    }
}

/// A delivery error belongs to its admitted receipt, never to a newer execution.
pub(crate) fn delivery_failed(data: &mut PeerData, message: &Message, error: &AppError) {
    let Some(a) = data.assignments.get_mut(&message.to) else {
        return;
    };
    if message.error.is_none()
        && message.attempted
        && a.active_receipt.as_deref() == Some(message.id.as_str())
        && a.state != "stopped"
        && a.state != "superseded"
    {
        a.state = if delivery_uncertain(error, message.attempted) {
            "recovery-required"
        } else {
            "failed"
        }
        .into();
        a.revision += 1;
    }
}
