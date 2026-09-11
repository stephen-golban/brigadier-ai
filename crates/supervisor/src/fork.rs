//! Fork a provider conversation while keeping its parent and workspace intact.
use super::*;

impl Supervisor {
    /// Copy conversation history into an idle child with an independently owned Git worktree.
    pub async fn fork_session(
        &self,
        source: &SessionId,
        env: BTreeMap<String, String>,
    ) -> Result<SessionId, SupervisorError> {
        self.fork_session_in(source, env, true).await
    }

    /// Fork into either a new worktree or the parent's directory without taking ownership
    /// of the parent's worktree (cleanup of a same-directory child must never remove it).
    pub async fn fork_session_in(
        &self,
        source: &SessionId,
        env: BTreeMap<String, String>,
        new_worktree: bool,
    ) -> Result<SessionId, SupervisorError> {
        let _lifecycle = self.inner.lifecycle.read().await;
        self.require_session_available(source)?;
        let record = self
            .session(source)
            .await?
            .ok_or(SupervisorError::NoSuchSession)?;
        let token = record.resume_token.clone().ok_or_else(|| {
            SupervisorError::NotResumable(
                "This session has no saved provider conversation to fork".into(),
            )
        })?;
        if self.inner.store.rewind_pending(source.to_string()).await? {
            return Err(SupervisorError::NotResumable(
                "Resolve the pending rewind before forking".into(),
            ));
        }
        let kind = record
            .driver_kind
            .clone()
            .ok_or_else(|| SupervisorError::NotResumable("The session has no provider".into()))?;
        if kind.as_str() != brigadier_core::claude::CLAUDE_CODE {
            return Err(SupervisorError::NotResumable(
                "This provider does not support conversation forks".into(),
            ));
        }
        let project = self
            .project(
                record
                    .project_id
                    .as_deref()
                    .ok_or(SupervisorError::NoSuchProject)?,
            )
            .await?
            .ok_or(SupervisorError::NoSuchProject)?;
        let driver = self
            .driver(&kind)
            .ok_or_else(|| SupervisorError::NoDriver(kind.clone()))?;
        let source_dir = record
            .cwd
            .clone()
            .unwrap_or_else(|| project.root_path.clone());
        self.workspace_writable(&source_dir).await?;
        let base = if let Some(git) = brigadier_core::worktree::resolve_git() {
            if brigadier_core::worktree::is_repo(&git, &source_dir).await {
                Some(worktree::resolve_commit(&git, &source_dir, "HEAD").await?)
            } else {
                None
            }
        } else {
            None
        };
        let prepared = if new_worktree {
            worktree::prepare_from(&project.root_path, base.as_deref()).await?
        } else {
            None
        };
        if let Some(tree) = &prepared {
            if let Err(error) = self
                .seed_worktree(source_dir.clone(), tree.path.clone())
                .await
            {
                tree.clone().roll_back().await;
                return Err(error);
            }
        }
        // Keep the source stable while the CLI copies its transcript and we copy display history.
        let _source_lease = match brigadier_core::checkpoint::WorkspaceLease::writer_as(&source_dir, source.as_str())
        {
            Ok(lease) => lease,
            Err(error) => {
                if let Some(tree) = prepared {
                    tree.roll_back().await;
                }
                return Err(SupervisorError::InvalidArgument(error.to_string()));
            }
        };
        let cwd = prepared
            .as_ref()
            .map(|tree| tree.path.clone())
            .unwrap_or(source_dir);
        let id = SessionId::new(uuid::Uuid::new_v4().to_string());
        let start_seq = record.last_event_seq;
        let mut req = ResumeSession::new(token, cwd.clone());
        req.fork = true;
        req.resumed = Some(Resumed {
            session_id: id.clone(),
            start_seq,
        });
        req.model = record.model.clone();
        req.effort = record.effort.clone();
        req.permission_mode = brigadier_core::driver::PermissionMode::from(
            record.permission_mode.as_deref().unwrap_or("default"),
        );
        req.thinking = if record.thinking.as_deref() == Some("inherit") {
            brigadier_core::driver::ThinkingPolicy::Inherit
        } else {
            brigadier_core::driver::ThinkingPolicy::Off
        };
        let scope = if prepared.is_some() {
            brigadier_core::claude::hook::HookScope::Worker { root: cwd.clone() }
        } else {
            brigadier_core::claude::hook::HookScope::Interactive { root: cwd.clone() }
        };
        req.hook_policy = brigadier_core::driver::HookOverride::new(
            brigadier_core::claude::hook::policy_for(&req.permission_mode, &scope),
        );
        req.mcp = project.mcp;
        req.env_overrides = env;
        // No initial prompt: forking opens an idle conversation, never sends work.
        let handle = match driver.resume_session(req).await {
            Ok(handle) => handle,
            Err(error) => {
                if let Some(tree) = prepared {
                    tree.roll_back().await;
                }
                return Err(error.into());
            }
        };
        let mut row = SessionRow::new(id.clone());
        row.project_id = Some(project.id.clone());
        row.instance_id = Some(handle.instance_id.clone());
        row.driver_kind = Some(kind);
        row.cwd = Some(cwd.clone());
        row.worktree_path = prepared.as_ref().map(|tree| tree.path.clone());
        row.branch = prepared.as_ref().map(|tree| tree.branch.clone());
        row.model = record.model;
        row.effort = record.effort;
        row.permission_mode = record.permission_mode;
        row.thinking = record.thinking;
        row.status = Some(SessionStatus::Starting);
        row.started_at = Some(SystemTime::now());
        let persist = async {
            self.inner.store.upsert_session(row).await?;
            self.inner
                .store
                .fork_chat_history(source.to_string(), id.to_string(), start_seq)
                .await
        }
        .await;
        if let Err(error) = persist {
            let _ = handle.commands.kill().await;
            let _ = self.inner.store.delete_session(id.clone()).await;
            if let Some(tree) = prepared {
                tree.roll_back().await;
            }
            return Err(error.into());
        }
        self.install(
            &driver,
            handle,
            Install {
                writer_lease: None,
                project_id: project.id,
                cwd,
                start_seq,
                base: Accrued::default(),
                tap: None,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brigadier_core::driver::{BoxFuture, DriverError, DriverInfo};
    use brigadier_core::event::{ItemId, ItemKind};
    use brigadier_store::Store;
    struct ForkDriver {
        inner: ReplayDriver,
        seen: Arc<Mutex<Vec<ResumeSession>>>,
        fail: bool,
    }
    impl ProviderDriver for ForkDriver {
        fn kind(&self) -> DriverKind {
            self.inner.kind()
        }
        fn instance_id(&self) -> &InstanceId {
            self.inner.instance_id()
        }
        fn describe(&self) -> DriverInfo {
            self.inner.describe()
        }
        fn start_session(
            &self,
            req: StartSession,
        ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
            self.inner.start_session(req)
        }
        fn resume_session(
            &self,
            req: ResumeSession,
        ) -> BoxFuture<'_, Result<SessionHandle, DriverError>> {
            lock(&self.seen).push(req.clone());
            if self.fail {
                return Box::pin(async { Err(DriverError::Protocol("fork refused".into())) });
            }
            self.inner.resume_session(req)
        }
    }
    async fn rig(
        fail: bool,
    ) -> (
        tempfile::TempDir,
        Store,
        Supervisor,
        String,
        SessionId,
        Arc<Mutex<Vec<ResumeSession>>>,
    ) {
        brigadier_core::checkpoint::WorkspaceLease::isolate_registry_for_tests();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap()
                .status
                .success());
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "Test"]);
        std::fs::write(root.join("context.txt"), "original").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "initial"]);
        let store = Store::open(&dir.path().join("data")).unwrap();
        let sup = Supervisor::new(SupervisorConfig::new(
            store.handle().clone(),
            store.run_id().to_owned(),
            dir.path().join("data"),
            Arc::new(VecSink::new()),
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let inner = ReplayDriver::new(vec![Event::item_completed(
            ItemId::new("parent-message"),
            ItemKind::AssistantText,
            "Inherited context",
            None,
        )])
        .with_kind(DriverKind::new(brigadier_core::claude::CLAUDE_CODE))
        .with_rate(200.0)
        .with_max_cycles(Some(1));
        let kind = inner.kind();
        sup.register_driver(Arc::new(ForkDriver {
            inner,
            seen: seen.clone(),
            fail,
        }));
        let project = sup.add_project(root.clone()).await.unwrap().id;
        let parent = sup
            .start_project_session(&project, &kind, StartSession::new(&root), false)
            .await
            .unwrap();
        for _ in 0..100 {
            if !sup.is_live(&parent) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut resumable = SessionRow::new(parent.clone());
        resumable.resume_token = Some("provider-parent".into());
        resumable.provider_session_id = Some("provider-parent".into());
        store.handle().upsert_session(resumable).await.unwrap();
        store.handle().flush().await.unwrap();
        std::fs::write(root.join("context.txt"), "unsaved working copy").unwrap();
        (dir, store, sup, project, parent, seen)
    }
    #[tokio::test]
    async fn fork_preserves_parent_and_copies_history_and_working_files() {
        let (_dir, store, sup, _project, parent, seen) = rig(false).await;
        let before = sup.session(&parent).await.unwrap().unwrap();
        let child = sup.fork_session(&parent, BTreeMap::new()).await.unwrap();
        assert_ne!(child, parent);
        let request = lock(&seen)[0].clone();
        assert!(request.fork);
        assert_eq!(request.token, before.resume_token.clone().unwrap());
        assert!(request.prompt.is_none());
        assert_eq!(request.resumed.as_ref().unwrap().session_id, child);
        assert_eq!(request.resumed.unwrap().start_seq, before.last_event_seq);
        let row = sup.session(&child).await.unwrap().unwrap();
        let root = row.worktree_path.unwrap();
        assert_ne!(Some(root.clone()), before.cwd);
        assert_eq!(
            std::fs::read_to_string(root.join("context.txt")).unwrap(),
            "unsaved working copy"
        );
        let history = store
            .handle()
            .chat_items(child.to_string(), 0)
            .await
            .unwrap();
        assert!(history.iter().any(|item| item.body == "Inherited context"));
        assert_eq!(sup.session(&parent).await.unwrap().unwrap(), before);
        sup.shutdown().await;
    }
    #[tokio::test]
    async fn same_directory_fork_copies_history_without_owning_parent_worktree() {
        let (_dir, store, sup, _project, parent, seen) = rig(false).await;
        let before = sup.session(&parent).await.unwrap().unwrap();
        let _terminal =
            brigadier_core::checkpoint::WorkspaceLease::terminal(before.cwd.as_ref().unwrap())
                .unwrap();
        let child = sup
            .fork_session_in(&parent, BTreeMap::new(), false)
            .await
            .unwrap();
        let row = sup.session(&child).await.unwrap().unwrap();
        assert_eq!(row.cwd, before.cwd);
        assert!(row.worktree_path.is_none());
        assert!(row.branch.is_none());
        assert!(lock(&seen)[0].fork);
        assert!(lock(&seen)[0].prompt.is_none());
        assert!(store
            .handle()
            .chat_items(child.to_string(), 0)
            .await
            .unwrap()
            .iter()
            .any(|item| item.body == "Inherited context"));
        assert_eq!(sup.session(&parent).await.unwrap().unwrap(), before);
        sup.shutdown().await;
    }
    #[tokio::test]
    async fn failed_fork_rolls_back_its_worktree_and_preserves_parent() {
        let (_dir, _store, sup, project, parent, seen) = rig(true).await;
        let before = sup.session(&parent).await.unwrap().unwrap();
        assert!(sup.fork_session(&parent, BTreeMap::new()).await.is_err());
        assert_eq!(lock(&seen).len(), 1);
        assert_eq!(sup.session(&parent).await.unwrap().unwrap(), before);
        let root = sup
            .project(&project)
            .await
            .unwrap()
            .unwrap()
            .root_path
            .join(worktree::WORKTREES_SUBDIR);
        assert!(!root.exists() || std::fs::read_dir(root).unwrap().next().is_none());
        sup.shutdown().await;
    }
}
