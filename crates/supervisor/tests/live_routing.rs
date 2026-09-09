//! Small held-out routing comparison. Opt-in: real connected accounts, read-only tasks.
//! This exercises execution and measures acceptance/latency; it cannot establish general quality.
use brigadier_core::{
    claude::{ClaudeDriver, ClaudeDriverConfig},
    codex::{CodexDriver, CodexDriverConfig},
    driver::{DriverKind, PermissionMode, ThinkingPolicy},
};
use brigadier_store::Store;
use brigadier_supervisor::{
    loop_::call::{CallCwd, CallRequest, ModelCall, SupervisedCall},
    orchestration::{self, Policy},
    Supervisor, SupervisorConfig, VecSink,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::test]
#[ignore = "Live connected accounts; explicitly authorized acceptance experiment"]
async fn held_out_routing_and_cross_provider_execution() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    for args in [
        vec!["init", "-q", "-b", "main"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Brigadier test"],
        vec!["config", "commit.gpgsign", "false"],
        vec!["commit", "--allow-empty", "-qm", "initial"],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .status()
            .unwrap()
            .success());
    }
    let store = Store::open(dir.path()).unwrap();
    let sup = Supervisor::new(SupervisorConfig::new(
        store.handle().clone(),
        store.run_id().to_owned(),
        dir.path().to_owned(),
        Arc::new(VecSink::new()),
    ));
    sup.register_driver(Arc::new(
        ClaudeDriver::probe(ClaudeDriverConfig::new("claude-code:routing-live"))
            .await
            .unwrap(),
    ));
    sup.register_driver(Arc::new(
        CodexDriver::probe(CodexDriverConfig::new("codex:routing-live"))
            .await
            .unwrap(),
    ));
    orchestration::discover(&sup).await.unwrap();
    let catalog = orchestration::candidates(&sup);
    eprintln!("CATALOG {}", serde_json::to_string(&catalog).unwrap());
    let project = sup.add_project(root.clone()).await.unwrap();
    let tasks=[
        ("Boundary review","Review this function: fn permitted(used:u32,limit:u32)->bool { used <= limit }. Requirement: admission is allowed only when used is strictly below limit. Return only JSON with a boolean defect key and a replacement key containing the correct expression (or null if no change is needed). Do not use tools.",serde_json::json!({"defect":true,"replacement":"used < limit"})),
        ("Independent data reasoning","Start with active assignments A and B. B completes but is rejected. C starts. A is stopped. Count active executions and completed executions (stopped counts as done, rejected is done). Return only JSON with active and done integer keys. Do not use tools.",serde_json::json!({"active":1,"done":2})),
    ];
    let mut observations = vec![];
    for (task_name, prompt, expected) in tasks {
        // Root selection and provider defaults are fixed baselines; heuristic chooses a light model.
        for (label, provider, model, routed) in [
            ("root-exact", "claude-code", Some("haiku"), false),
            ("provider-default", "codex", None, false),
            (
                "light-strong-heuristic",
                "claude-code",
                Some("sonnet"),
                false,
            ),
            ("adaptive", "codex", None, true),
        ] {
            eprintln!("RUN {task_name}: {label}");
            let task = format!("{task_name}-{label}");
            let call = SupervisedCall::new(sup.clone(), DriverKind::new(provider), root.clone())
                .with_policy(Policy::default(), task.clone());
            let started = Instant::now();
            let outcome = call
                .call(CallRequest {
                    project_id: project.id.clone(),
                    label: if routed { "worker" } else { "baseline" },
                    cwd: CallCwd::ProjectRoot,
                    prompt: prompt.into(),
                    turn_deadline: Duration::from_secs(60),
                    quiet_deadline: Duration::from_secs(30),
                    thinking: ThinkingPolicy::Inherit,
                    model: model.map(str::to_owned),
                    effort: None,
                    provider: None,
                    permission_mode: PermissionMode::Plan,
                })
                .await
                .unwrap();
            let accepted = serde_json::from_str::<serde_json::Value>(outcome.text.trim())
                .ok()
                .as_ref()
                == Some(&expected);
            let session = sup
                .session(outcome.session_id.as_ref().unwrap())
                .await
                .unwrap()
                .unwrap();
            observations.push(serde_json::json!({"task":task_name,"policy":label,"selectedRootProvider":provider,"observedProvider":session.instance_id,"observedModel":session.model,"accepted":accepted,"elapsedMs":started.elapsed().as_millis(),"output":outcome.text,"usage":null}));
        }
    }
    // Explicit eligibility constraints drive both cross-provider directions through production routing.
    for (root_provider, worker_provider) in [("claude-code", "codex"), ("codex", "claude-code")] {
        let policy = Policy {
            excluded_providers: vec![root_provider.into()],
            ..Default::default()
        };
        let call = SupervisedCall::new(sup.clone(), DriverKind::new(root_provider), root.clone())
            .with_policy(policy, format!("cross-{root_provider}"));
        let outcome = call
            .call(CallRequest {
                project_id: project.id.clone(),
                label: "worker",
                cwd: CallCwd::ProjectRoot,
                prompt: "Reply with only BRIGADIER_ROUTED_OK. Do not use tools.".into(),
                turn_deadline: Duration::from_secs(60),
                quiet_deadline: Duration::from_secs(30),
                thinking: ThinkingPolicy::Inherit,
                model: None,
                effort: None,
                provider: None,
                permission_mode: PermissionMode::Plan,
            })
            .await
            .unwrap();
        let session = sup
            .session(outcome.session_id.as_ref().unwrap())
            .await
            .unwrap()
            .unwrap();
        assert!(session
            .instance_id
            .as_ref()
            .is_some_and(|id| id.as_str().starts_with(worker_provider)));
        assert!(outcome.text.contains("BRIGADIER_ROUTED_OK"));
        observations.push(serde_json::json!({"task":"cross-provider","root":root_provider,"worker":session.instance_id,"model":session.model,"accepted":true}));
    }
    if let Ok(path) = std::env::var("BRIGADIER_ROUTING_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&observations).unwrap()).unwrap();
    }
    eprintln!(
        "OBSERVATIONS {}",
        serde_json::to_string_pretty(&observations).unwrap()
    );
    // Baseline failures are measured outcomes, not infrastructure failures.
    assert!(observations.iter().filter(|v|v["policy"]=="adaptive").all(|v| v["accepted"] == true));
    sup.shutdown_with(Duration::from_secs(2)).await;
}
