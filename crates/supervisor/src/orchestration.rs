//! Shared, provider-neutral worker policy. Availability is not a competence benchmark.
#![allow(missing_docs)]
use crate::Supervisor;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    #[default]
    Quality,
    Balanced,
    Economy,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewIntensity {
    #[default]
    RiskBased,
    Always,
    Manual,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Policy {
    pub preset: Preset,
    pub concurrency: usize,
    /// Exact dispatch allowance; provider token/dollar measurements may be delayed or absent.
    pub max_dispatches: u64,
    pub review: ReviewIntensity,
    pub excluded_providers: Vec<String>,
    pub excluded_models: Vec<String>,
    pub profiles: std::collections::BTreeMap<String, Profile>,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            preset: Preset::Quality,
            concurrency: 4,
            max_dispatches: 32,
            review: ReviewIntensity::RiskBased,
            excluded_providers: vec![],
            excluded_models: vec![],
            profiles: Default::default(),
        }
    }
}
impl Policy {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=16).contains(&self.concurrency) || !(1..=10000).contains(&self.max_dispatches) {
            return Err("Concurrency must be 1–16 and task dispatch allowance 1–10000".into());
        }
        if self.profiles.values().any(|p| {
            !(1..=3).contains(&p.quality)
                || !p.usage_weight.is_finite()
                || !(0.0..=1.0).contains(&p.usage_weight)
                || p.context_tokens == 0
        }) {
            return Err("Capability profiles need quality 1–3, usage weight 0–1 and positive context capacity".into());
        }
        Ok(())
    }
    /// Cross-project work cannot widen either owner's constraints.
    pub fn intersect(&self, other: &Self) -> Self {
        let mut p = self.clone();
        p.concurrency = p.concurrency.min(other.concurrency);
        p.max_dispatches = p.max_dispatches.min(other.max_dispatches);
        p.excluded_providers
            .extend(other.excluded_providers.clone());
        p.excluded_models.extend(other.excluded_models.clone());
        p.review = match (&self.review, &other.review) {
            (ReviewIntensity::Always, _) | (_, ReviewIntensity::Always) => ReviewIntensity::Always,
            (ReviewIntensity::RiskBased, _) | (_, ReviewIntensity::RiskBased) => {
                ReviewIntensity::RiskBased
            }
            _ => ReviewIntensity::Manual,
        };
        p
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub profile: Option<Profile>,
    pub provider: String,
    pub model: String,
    pub efforts: Vec<String>,
    pub version: String,
    pub default: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Proposal {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// User-pinned selections cannot fall back; model-proposed preferences can.
    pub minimum_quality: Option<u8>,
    pub context_tokens: u64,
    pub needs_images: bool,
    pub pinned: bool,
    pub workload: String,
    pub reason: String,
    pub avoid_provider: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub provider: String,
    pub model: String,
    pub effort: Option<String>,
    pub reason: String,
    pub version: String,
    pub workload: String,
    pub pinned: bool,
    pub alternatives: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub selection: Selection,
    pub accepted: bool,
    pub elapsed_ms: Option<u64>,
    pub recorded_at: u64,
    /// Verifier command/report, never the builder's self-reported success.
    pub verification: String,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
/// Discover connected account capabilities without sending a model turn. Cache successful catalogs.
pub async fn discover(sup: &Supervisor) -> std::io::Result<()> {
    static DISCOVERY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = DISCOVERY.lock().await;
    for driver in sup.registered_drivers() {
        let instance = driver.instance_id().as_str();
        if driver.kind().as_str() == "codex"
            && brigadier_core::codex::capabilities::models(instance).is_empty()
        {
            if let Some(binary) = driver.describe().binary_path {
                if let Err(error)=brigadier_core::codex::capabilities::refresh(&binary, instance).await {
                    tracing::debug!(%error,instance,"Provider catalog unavailable");
                }
            }
        }
        if driver.kind().as_str() == "claude-code"
            && brigadier_core::claude::capabilities::models(instance).is_empty()
        {
            let cwd = sup
                .data_dir()
                .join("capability-probes")
                .join(uuid::Uuid::new_v4().to_string());
            if let Err(error)=std::fs::create_dir_all(&cwd){tracing::debug!(%error,instance,"Provider probe workspace unavailable");continue;}
            let mut request = brigadier_core::driver::StartSession::new(&cwd);
            request.permission_mode = brigadier_core::driver::PermissionMode::Plan;
            let result = async {
                let handle = driver
                    .start_session(request)
                    .await
                    .map_err(std::io::Error::other)?;
                // start_session completes the initialize handshake; SessionStarted awaits a model turn.
                handle
                    .commands
                    .end_session()
                    .await
                    .map_err(std::io::Error::other)
            }
            .await;
            let _ = std::fs::remove_dir_all(cwd);
            if let Err(error)=result {tracing::debug!(%error,instance,"Provider catalog unavailable");}
        }
    }
    Ok(())
}
/// Only advertised IDs enter the router. Unknown catalogs require discovery, not a guessed default.
pub fn candidates(sup: &Supervisor) -> Vec<Candidate> {
    sup.registered_drivers()
        .into_iter()
        .flat_map(|d| {
            let provider = d.kind().to_string();
            let version = d.describe().version.unwrap_or_default();
            let instance = d.instance_id().to_string();
            let mut result = vec![];
            if provider == "codex" {
                for m in brigadier_core::codex::capabilities::models(&instance) {
                    result.push(Candidate {
                        profile: profile(&m.id),
                        provider: provider.clone(),
                        model: m.id,
                        efforts: m.efforts,
                        version: version.clone(),
                        default: m.is_default,
                    });
                }
            }
            if provider == "claude-code" {
                for m in brigadier_core::claude::capabilities::models(&instance) {
                    let efforts = if m.id.contains("haiku") || m.resolved.contains("haiku") {
                        vec![]
                    } else {
                        ["low", "medium", "high", "xhigh", "max"]
                            .into_iter()
                            .map(str::to_owned)
                            .collect()
                    };
                    result.push(Candidate {
                        profile: profile(if m.resolved.is_empty() {
                            &m.id
                        } else {
                            &m.resolved
                        }),
                        provider: provider.clone(),
                        default: m.id == "default",
                        model: m.id,
                        efforts,
                        version: format!("{version}:{}", m.resolved),
                    });
                }
            }
            result
        })
        .collect()
}
pub fn select(
    policy: &Policy,
    rows: &[Candidate],
    proposal: &Proposal,
    evidence: &[Evidence],
    blocked: impl Fn(&str) -> bool,
    at: u64,
) -> Result<Selection, String> {
    policy.validate()?;
    fn automatic(s: &Option<String>) -> Option<&str> {
        s.as_deref().filter(|s| !s.is_empty() && *s != "auto")
    }
    let requested_model = automatic(&proposal.model);
    let requested_provider = automatic(&proposal.provider);
    let effort = automatic(&proposal.effort);
    // Invalid model/effort is a replan, never a silent downgrade. Availability fallback is separate.
    let proposed: Vec<_> = rows
        .iter()
        .filter(|c| {
            requested_provider.is_none_or(|p| c.provider == p)
                && requested_model.is_none_or(|m| c.model == m)
        })
        .collect();
    if proposed.is_empty() && (requested_model.is_some() || proposal.pinned) {
        return Err("Requested worker configuration is not in the connected catalog; refresh or explicitly replan".into());
    }
    if effort.is_some_and(|e| !proposed.iter().any(|c| c.efforts.iter().any(|v| v == e))) {
        return Err("Requested effort is unsupported by the proposed worker configuration".into());
    }
    let profile_for = |c: &Candidate| {
        policy
            .profiles
            .get(&format!("{}/{}", c.provider, c.model))
            .cloned()
            .or_else(|| c.profile.clone())
    };
    let minimum = proposal
        .minimum_quality
        .unwrap_or(if proposal.workload == "mechanical" {
            1
        } else {
            2
        })
        .max(
            proposed
                .iter()
                .filter(|_| requested_model.is_some())
                .filter_map(|c| profile_for(c).map(|p| p.quality))
                .max()
                .unwrap_or(1),
        );
    let mut ranked: Vec<(&Candidate, f64, usize)> = rows
        .iter()
        .filter(|c| {
            (profile_for(c).is_some_and(|p| {
                p.quality >= minimum
                    && p.context_tokens >= proposal.context_tokens
                    && (!proposal.needs_images || p.vision)
            }) || (proposal.pinned && proposal.context_tokens == 0 && !proposal.needs_images))
                && !policy.excluded_providers.contains(&c.provider)
                && !policy.excluded_models.contains(&c.model)
                && !blocked(&c.provider)
                && (!proposal.pinned
                    || (requested_provider.is_none_or(|p| c.provider == p)
                        && requested_model.is_none_or(|m| c.model == m)))
                && effort.is_none_or(|e| c.efforts.iter().any(|v| v == e))
        })
        .map(|c| {
            let samples: Vec<_> = evidence
                .iter()
                .filter(|e| {
                    e.selection.provider == c.provider
                        && e.selection.model == c.model
                        && e.selection.version == c.version
                        && e.selection.workload == proposal.workload
                        && at.saturating_sub(e.recorded_at) < 30 * 86400
                        && !e.verification.trim().is_empty()
                })
                .collect();
            // Ten neutral pseudo-observations prevent one result permanently capturing a workload.
            let success = (5.0 + samples.iter().filter(|e| e.accepted).count() as f64)
                / (10.0 + samples.len() as f64);
            let measured: Vec<_> = samples.iter().filter_map(|e| e.elapsed_ms).collect();
            let latency =
                measured.iter().map(|ms| *ms as f64).sum::<f64>() / measured.len().max(1) as f64;
            let speed_weight = match policy.preset {
                Preset::Quality => 0.01,
                Preset::Balanced => 0.05,
                Preset::Economy => 0.1,
            };
            let prior_usage = profile_for(c).map_or(1.0, |p| p.usage_weight);
            let score = success - speed_weight * prior_usage
                + if c.default { 0.01 } else { 0.0 }
                + if requested_model == Some(c.model.as_str()) {
                    0.04
                } else {
                    0.0
                }
                + if requested_provider == Some(c.provider.as_str()) {
                    0.02
                } else {
                    0.0
                }
                - if proposal.avoid_provider.as_deref() == Some(c.provider.as_str()) {
                    0.03
                } else {
                    0.0
                }
                - speed_weight * (latency / 600000.0).min(1.0);
            (c, score, samples.len())
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| a.0.provider.cmp(&b.0.provider))
            .then_with(|| a.0.model.cmp(&b.0.model))
    });
    let (chosen,_,count) = ranked.first().ok_or_else(|| if proposal.pinned {"Pinned worker is unavailable or excluded; waiting requires user action or allowance recovery"} else {"No eligible worker: refresh catalogs, connect an allowed provider, or wait for allowance"}.to_owned())?;
    let selected_effort = effort.map(str::to_owned).or_else(|| {
        let preferred = match policy.preset {
            Preset::Quality => "high",
            Preset::Balanced => "medium",
            Preset::Economy => "low",
        };
        chosen
            .efforts
            .iter()
            .find(|e| e.as_str() == preferred)
            .cloned()
    });
    Ok(Selection {
        provider: chosen.provider.clone(),
        model: chosen.model.clone(),
        effort: selected_effort,
        version: chosen.version.clone(),
        workload: proposal.workload.clone(),
        pinned: proposal.pinned,
        reason: format!(
            "{}; {} verified observations in 30 days; {}. {}",
            if *count == 0 {
                "Provisional capability/availability prior"
            } else {
                "Smoothed verified outcome ranking"
            },
            count,
            if requested_provider.is_some_and(|p| p != chosen.provider)
                || requested_model.is_some_and(|m| m != chosen.model)
            {
                "automatic alternative selected"
            } else {
                "eligible configuration selected"
            },
            proposal.reason
        ),
        alternatives: ranked
            .iter()
            .skip(1)
            .take(5)
            .map(|(c, _, _)| format!("{}/{}", c.provider, c.model))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rows() -> Vec<Candidate> {
        ["claude-code", "codex"]
            .into_iter()
            .map(|p| Candidate {
                profile: Some(Profile {
                    quality: 2,
                    usage_weight: 0.5,
                    context_tokens: 200000,
                    vision: true,
                }),
                provider: p.into(),
                model: format!("{p}-model"),
                efforts: vec!["low".into(), "high".into()],
                version: "1".into(),
                default: true,
            })
            .collect()
    }
    #[test]
    fn automatic_fallback_and_pin_have_different_contracts() {
        let p = Proposal {
            provider: Some("claude-code".into()),
            ..Default::default()
        };
        let s = select(
            &Policy::default(),
            &rows(),
            &p,
            &[],
            |p| p == "claude-code",
            now(),
        )
        .unwrap();
        assert_eq!(s.provider, "codex");
        assert!(s.reason.contains("Provisional"));
        assert!(select(
            &Policy::default(),
            &rows(),
            &Proposal { pinned: true, ..p },
            &[],
            |p| p == "claude-code",
            now()
        )
        .is_err());
    }
    #[test]
    fn unsupported_tuple_and_exclusions_fail_closed() {
        let p = Proposal {
            model: Some("codex-model".into()),
            effort: Some("invented".into()),
            ..Default::default()
        };
        assert!(select(&Policy::default(), &rows(), &p, &[], |_| false, now()).is_err());
        let p = Policy {
            excluded_providers: vec!["claude-code".into(), "codex".into()],
            ..Default::default()
        };
        assert!(select(&p, &rows(), &Proposal::default(), &[], |_| false, now()).is_err());
    }
    #[test]
    fn evidence_expires_and_adapter_changes_invalidate_it() {
        let rows = rows();
        let s = select(
            &Policy::default(),
            &rows,
            &Proposal {
                provider: Some("codex".into()),
                ..Default::default()
            },
            &[],
            |_| false,
            now(),
        )
        .unwrap();
        let e = Evidence {
            selection: s,
            accepted: true,
            elapsed_ms: Some(1),
            recorded_at: now(),
            verification: "tests passed".into(),
        };
        assert_eq!(
            select(
                &Policy::default(),
                &rows,
                &Proposal::default(),
                std::slice::from_ref(&e),
                |_| false,
                now()
            )
            .unwrap()
            .provider,
            "codex"
        );
        assert_eq!(
            select(
                &Policy::default(),
                &rows,
                &Proposal::default(),
                &[e],
                |_| false,
                now() + 31 * 86400
            )
            .unwrap()
            .provider,
            "claude-code"
        );
    }
}

/// Journal reservations are written before process effects and survive explicit run continuation.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Journal {
    #[serde(default)]
    pub verified: std::collections::BTreeSet<String>,
    pub calls: Vec<DispatchRecord>,
    pub evidence: Vec<Evidence>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DispatchRecord {
    pub id: String,
    pub task: String,
    pub cwd: String,
    pub selection: Option<Selection>,
}
static JOURNAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn journal(path: &std::path::Path) -> std::io::Result<Journal> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map_err(std::io::Error::other),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Journal::default()),
        Err(e) => Err(e),
    }
}
pub fn reserve(path: &std::path::Path, record: DispatchRecord, limit: u64) -> std::io::Result<()> {
    let _guard = JOURNAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut j = journal(path)?;
    if j.calls.iter().any(|c| c.id == record.id) {
        return Ok(());
    }
    if j.calls.iter().filter(|c| c.task == record.task).count() as u64 >= limit {
        return Err(std::io::Error::other("Task dispatch allowance reached. Increase the allowance in project settings and explicitly continue; work and uncertain effects are retained."));
    }
    j.calls.push(record);
    write_journal(path, &j)
}
fn write_journal(path: &std::path::Path, j: &Journal) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    f.write_all(&serde_json::to_vec(j).map_err(std::io::Error::other)?)?;
    f.sync_all()?;
    std::fs::rename(tmp, path)
}
/// Only a real gate plus independent acceptance calls this; process completion is insufficient.
pub fn verified_workspace(
    path: &std::path::Path,
    task: &str,
    cwd: &str,
    accepted: bool,
    verification: &str,
) -> std::io::Result<()> {
    let _guard = JOURNAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut j = journal(path)?;
    if let Some(selection) = j
        .calls
        .iter()
        .rev()
        .find(|c| {
            c.task == task
                && c.cwd == cwd
                && c.selection.as_ref().is_some_and(|s| s.workload != "review")
        })
        .and_then(|c| c.selection.clone())
    {
        j.evidence.push(Evidence {
            selection,
            accepted,
            elapsed_ms: None,
            recorded_at: now(),
            verification: verification.into(),
        });
        if j.evidence.len() > 2000 {
            j.evidence.drain(..j.evidence.len() - 2000);
        }
    }
    write_journal(path, &j)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub quality: u8,
    pub usage_weight: f64,
    pub context_tokens: u64,
    pub vision: bool,
}
fn profile(id: &str) -> Option<Profile> {
    let id=id.strip_suffix("[1m]").unwrap_or(id);
    static PROFILES: std::sync::OnceLock<std::collections::BTreeMap<String, Profile>> =
        std::sync::OnceLock::new();
    PROFILES
        .get_or_init(|| {
            let value: serde_json::Value =
                serde_json::from_str(include_str!("orchestration/profiles.json"))
                    .expect("bundled profiles are valid");
            serde_json::from_value(value["models"].clone())
                .expect("bundled profiles have valid models")
        })
        .get(id)
        .cloned()
}

/// Conservative shared review trigger, supplemented by the explicit Always setting.
pub fn consequential(paths: &str) -> bool {
    let paths: Vec<_> = paths.lines().filter(|p| !p.is_empty()).collect();
    paths.len() >= 5
        || paths.iter().any(|p| {
            [
                "auth",
                "permission",
                "migration",
                "schema",
                "payment",
                "cancel",
                "session",
                "security",
            ]
            .iter()
            .any(|t| p.to_lowercase().contains(t))
        })
}

/// Persist an explicitly verified result once; repeated UI acknowledgements do not train twice.
pub fn record_verified(
    path: &std::path::Path,
    key: &str,
    evidence: Evidence,
) -> std::io::Result<()> {
    let _guard = JOURNAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut j = journal(path)?;
    if !j.verified.insert(key.into()) {
        return Ok(());
    }
    j.evidence.push(evidence);
    if j.evidence.len() > 2000 {
        j.evidence.drain(..j.evidence.len() - 2000);
    }
    write_journal(path, &j)
}

#[cfg(test)]
mod quality_tests {
    use super::*;
    fn candidate(provider: &str, model: &str, quality: u8) -> Candidate {
        Candidate {
            provider: provider.into(),
            model: model.into(),
            version: "1".into(),
            default: true,
            efforts: vec!["high".into()],
            profile: Some(Profile {
                quality,
                usage_weight: 0.1,
                context_tokens: 200000,
                vision: true,
            }),
        }
    }
    #[test]
    fn availability_does_not_make_a_lower_quality_fallback_eligible() {
        let rows = vec![candidate("a", "strong", 3), candidate("b", "cheap", 1)];
        let p = Proposal {
            provider: Some("a".into()),
            model: Some("strong".into()),
            ..Default::default()
        };
        assert!(select(&Policy::default(), &rows, &p, &[], |p| p == "a", now()).is_err());
    }
    #[test]
    fn unknown_profiles_cannot_win_automatic_dispatch() {
        let mut row = candidate("new", "unknown", 3);
        row.profile = None;
        assert!(select(
            &Policy::default(),
            &[row.clone()],
            &Proposal::default(),
            &[],
            |_| false,
            now()
        )
        .is_err());
        assert!(select(
            &Policy::default(),
            &[row],
            &Proposal {
                pinned: true,
                provider: Some("new".into()),
                model: Some("unknown".into()),
                ..Default::default()
            },
            &[],
            |_| false,
            now()
        )
        .is_ok());
    }
    #[test]
    fn minimum_context_and_image_requirements_are_hard_constraints() {
        let mut row = candidate("a", "limited", 3);
        row.profile.as_mut().unwrap().vision = false;
        assert!(select(
            &Policy::default(),
            &[row.clone()],
            &Proposal {
                needs_images: true,
                ..Default::default()
            },
            &[],
            |_| false,
            now()
        )
        .is_err());
        assert!(select(
            &Policy::default(),
            &[row],
            &Proposal {
                context_tokens: 300000,
                ..Default::default()
            },
            &[],
            |_| false,
            now()
        )
        .is_err());
    }
    #[test]
    fn durable_reservations_do_not_reset_and_human_evidence_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routing.json");
        let r = DispatchRecord {
            id: "one".into(),
            task: "task".into(),
            cwd: "workspace".into(),
            selection: None,
        };
        reserve(&path, r.clone(), 1).unwrap();
        reserve(&path, r, 1).unwrap();
        assert!(reserve(
            &path,
            DispatchRecord {
                id: "two".into(),
                task: "task".into(),
                cwd: "workspace".into(),
                selection: None
            },
            1
        )
        .is_err());
        let s = select(
            &Policy::default(),
            &[candidate("a", "m", 2)],
            &Proposal::default(),
            &[],
            |_| false,
            now(),
        )
        .unwrap();
        let e = Evidence {
            selection: s,
            accepted: true,
            elapsed_ms: None,
            recorded_at: now(),
            verification: "human confirmed check report".into(),
        };
        record_verified(&path, "result", e.clone()).unwrap();
        record_verified(&path, "result", e).unwrap();
        assert_eq!(journal(&path).unwrap().evidence.len(), 1);
    }
}
