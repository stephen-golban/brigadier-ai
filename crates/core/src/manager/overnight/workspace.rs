//! The run's own branch and worktree (PLAN.md §10.5), made at Start from the base's committed
//! tip. The user's uncommitted files and the session's own worktree stay out of it; workers'
//! changes land on its branch, and only the user's Merge brings verified work into the base.

use std::path::PathBuf;

use brigadier_git::WorktreeSpec;
use brigadier_providers::Artifact;

use super::super::{SessionManager, blocking, git_error};
use crate::model::{Environment, Setup};
use crate::overnight::{OvernightRun, RunWorkspace};
use crate::{Error, Result};

impl SessionManager {
    /// Makes the run's branch and worktree, or finds them again for a continued run (whose
    /// branch carries over; its worktree may have been removed since).
    pub(crate) async fn prepare_run_workspace(&self, run: &OvernightRun) -> Result<RunWorkspace> {
        let conversation = self.core.conversation(&run.conversation_id)?;
        let Some(Setup::Session {
            repo, environment, ..
        }) = &conversation.setup
        else {
            return Err(Error::Invalid("overnight runs belong to a session".into()));
        };
        let repo = PathBuf::from(repo);
        let project = conversation
            .project_id
            .as_ref()
            .map(|id| id.0.clone())
            .unwrap_or_else(|| "none".into());
        let path = run.workspace.as_ref().map_or_else(
            || {
                self.owned_dir("worktrees", &project)
                    .join(format!("overnight-{}", run.id.short()))
            },
            |workspace| PathBuf::from(&workspace.path),
        );
        self.runtime
            .ledger()
            .record(
                &run_owner(run),
                Artifact::Worktree {
                    repo: repo.to_string_lossy().into_owned(),
                    path: path.to_string_lossy().into_owned(),
                },
            )
            .await?;
        let (base, carried) = match &run.workspace {
            Some(workspace) => (workspace.base.clone(), Some(workspace.clone())),
            None => (base_branch(environment), None),
        };
        let branch = carried
            .as_ref()
            .map(|workspace| workspace.branch.clone())
            .unwrap_or_else(|| run_branch(run));
        let git = self.git.clone();
        let (worktree, name) = (path.clone(), branch.clone());
        let base_commit = blocking(move || {
            let repo = git.open(&repo).map_err(git_error)?;
            let base_commit = repo
                .branch_tip(&base)
                .map_err(git_error)?
                .ok_or_else(|| Error::Invalid(format!("branch {base} does not exist")))?;
            if worktree.exists() {
                let canonical = std::fs::canonicalize(&worktree)
                    .map_err(|err| Error::Invalid(err.to_string()))?;
                let registered = repo.worktrees().map_err(git_error)?.into_iter().find(|item| {
                    item.path == worktree ||
                        std::fs::canonicalize(&item.path).is_ok_and(|path| path == canonical)
                });
                if !registered.is_some_and(|item| item.branch.as_deref() == Some(name.as_str())) {
                    return Err(Error::Invalid(format!(
                        "The run's worktree {} no longer holds branch {name}. Restore that checkout before continuing.",
                        worktree.display()
                    )));
                }
                return Ok(base_commit);
            }
            if let Some(parent) = worktree.parent() {
                std::fs::create_dir_all(parent).map_err(|err| Error::Invalid(err.to_string()))?;
            }
            let spec = match repo.branch_tip(&name).map_err(git_error)? {
                Some(_) => WorktreeSpec::Branch { name },
                None => WorktreeSpec::NewBranch {
                    name,
                    start: base_commit.clone(),
                },
            };
            repo.add_worktree(&worktree, spec).map_err(git_error)?;
            Ok(base_commit)
        })
        .await?;
        Ok(match carried {
            Some(workspace) => RunWorkspace {
                path: path.to_string_lossy().into_owned(),
                ..workspace
            },
            None => RunWorkspace {
                base: base_branch(environment),
                base_commit: base_commit.0,
                branch,
                path: path.to_string_lossy().into_owned(),
            },
        })
    }
}

/// Who owns a run's worktree and evidence in the cleanup ledger.
pub(crate) fn run_owner(run: &OvernightRun) -> String {
    format!("overnight:{}", run.id)
}

/// The branch a run starts from: the session's own branch (the picked branch of a local
/// checkout, a worktree session's branch once it exists, else its base).
fn base_branch(environment: &Environment) -> String {
    match environment {
        Environment::LocalCheckout { branch } => branch.clone(),
        Environment::NewWorktree {
            branch, base, path, ..
        } => {
            if path.is_some() {
                branch.clone()
            } else {
                base.clone()
            }
        }
    }
}

/// `overnight/<date>-<slug>-<short id>`.
fn run_branch(run: &OvernightRun) -> String {
    let date = jiff::Timestamp::from_millisecond(run.started_at_ms.unwrap_or(run.created_at_ms))
        .map(|at| at.to_zoned(jiff::tz::TimeZone::system()).date().to_string())
        .unwrap_or_else(|_| "run".into());
    let slug: String = run
        .name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(5)
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = slug.chars().take(32).collect();
    let slug = slug.trim_end_matches('-');
    let short = run.id.short();
    if slug.is_empty() {
        format!("overnight/{date}-{short}")
    } else {
        format!("overnight/{date}-{slug}-{short}")
    }
}

impl SessionManager {
    /// The branch a run task's work lands on: its run's branch, once Start made it.
    pub(crate) async fn run_target(
        &self,
        conversation_id: &crate::model::ConversationId,
        context: &crate::overnight::RunTaskContext,
    ) -> Result<String> {
        let board = self.core.board(conversation_id).await?;
        board
            .runs
            .get(&context.run_id)
            .and_then(|run| run.workspace.as_ref())
            .map(|workspace| workspace.branch.clone())
            .ok_or_else(|| Error::Invalid("the overnight run has no branch yet".into()))
    }
}
