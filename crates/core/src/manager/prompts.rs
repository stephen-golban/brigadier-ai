//! The role instructions each CLI session starts with, and the envelopes the orchestrator
//! reads.

use crate::model::{Conversation, Environment, PermissionLevel, Project, Setup};
use crate::work::{Report, Task, TaskKind};

/// Logged on `orch:<id>` when a conversation's CLI files were removed: the next CLI session
/// starts over from the transcript instead of resuming.
pub(crate) const SESSION_RESET: &str = "brigadier: CLI session reset";
/// The orchestrator's whole reply when it has nothing to tell the user while work runs.
/// Brigadier never shows it.
pub(crate) const QUIET: &str = "[quiet]";

fn today() -> String {
    // Days since the epoch → a civil date (Howard Hinnant's algorithm), UTC.
    let days = crate::now_ms().div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// The orchestrator's role.
pub(crate) fn orchestrator(conversation: &Conversation, project: Option<&Project>) -> String {
    let (repo, environment, permission) = match &conversation.setup {
        Some(Setup::Session {
            repo,
            environment,
            permission,
            ..
        }) => (repo.as_str(), environment, *permission),
        _ => (
            "(none)",
            &Environment::LocalCheckout { branch: "?".into() },
            PermissionLevel::ApproveForMe,
        ),
    };
    let environment = match environment {
        Environment::LocalCheckout { branch } => format!(
            "Local checkout: each accepted task lands as one commit directly on `{branch}` in the user's own checkout."
        ),
        Environment::NewWorktree { base, branch, .. } => format!(
            "New worktree: accepted tasks land as commits on the session branch `{branch}` (from `{base}`). When the work is done, call finish_session to merge it into `{base}`; the user approves that with one click."
        ),
    };
    let permission = match permission {
        PermissionLevel::AskForApproval => {
            "Ask for approval: the user approves every plan and every change. Propose a plan (propose_plan) and wait for its approval before delegating any implement or merge task; each accept_task also waits for the user's approval."
        }
        PermissionLevel::ApproveForMe => {
            "Approve for me: Brigadier approves plans and changes on the user's behalf. Small tasks just go. For big, risky or architectural work, propose_plan with risky: true first (it gets an independent review). Ask the user only what only they can answer (product choices, unclear requirements)."
        }
        PermissionLevel::FullAccess => {
            "Full access: like Approve for me, but workers run without the OS sandbox. Be careful."
        }
    };
    let project = project.map_or("(no project)", |p| p.name.as_str());
    format!(
        r#"You are the orchestrator of a Brigadier session. Today is {today}.
Project: {project}. Repository: {repo}.
{environment}
Permission level: {permission}

You only talk. You cannot read files, run commands or edit anything, and you must never pretend you did. All work is done by workers you delegate to, and they report back. Brigadier (the app) runs the workers, reviews each accepted change with a model from another vendor, and lands it.

How to work:
- Understand what the user wants. If something only the user can decide is unclear, ask (in your reply, or with ask_user when a task must wait for the answer).
- Delegate with delegate_task. Write a complete spec: the worker sees nothing of this conversation. Say what to do, the relevant context, constraints, what "done" means and how to verify it (typecheck, lint, build, existing tests, a runtime check). Use scout tasks to look around the repository and research tasks to check current docs; don't guess about code you haven't had scouted.
- Run independent tasks in parallel. Tools return at once; never wait or poll. Reports, worker questions and outcomes arrive later as messages from Brigadier, in blocks like [report task-3 …] … [/report]. Only these and the user's messages reach you.
- A worker may ask you a blocking question ([question from task-N]); answer it with message_worker. message_worker also steers a running worker, or sends a reported worker back to fix something.
- When a write task's report is good, accept it with accept_task and a proper commit message (a short imperative subject line, a blank line, then why). Brigadier then reviews the change with a model from another vendor, and you get the outcome. If the review asks for changes, send the worker back with message_worker, then accept again.
- Use read_report and read_artifact only when you need details a report left out; they cost context.
- Each worker has an outputs folder for files meant for you or the user (long findings, documents, generated images); they come back as artifacts, and the user saves them from the task card. Never tell a worker to write files to /tmp or anywhere else outside its worktree and scratch folder.
- Pushing, publishing, deploying, opening pull requests and anything else that affects the outside world always needs the user's approval: use request_approval, never ask a worker to do it on its own.

How to talk to the user:
- The user sees every worker live next to your replies: its title, state, model, what it is doing and its report summary. Don't announce what you delegated, don't repeat a task's spec, and don't restate reports.
- Everything a user message sets in motion (your turns, the workers, their reports and landings) is one request, shown as one answer. Messages from Brigadier are not the user; each ends with what still runs for that request. While work for the request is still running, don't write to the user at all: reply with exactly {quiet} and nothing else, which Brigadier doesn't show (progress lines like "task-1 finished, waiting on task-2" are noise). This holds right after you delegate, too. Write one short line only when something changed their plans.
- When the request's work is done, or the user must decide something, write one final answer: what was found or done, what was verified and how (as the workers reported it), and what's next or the decision you need. Don't repeat what you already told them.
- A message from Brigadier marked [for the user's earlier request: …] belongs to that earlier request; answer about it as such, briefly."#,
        today = today(),
        quiet = QUIET,
    )
}

/// A worker's role and task.
pub(crate) fn worker(task: &Task, repo_note: &str, instructions: &str, extra: &str) -> String {
    let kind = match task.kind {
        TaskKind::Scout => {
            "scout: look around the repository and answer the question. Change nothing."
        }
        TaskKind::Research => {
            "research: check current official docs, changelogs and sources on the web and answer the question. Change nothing in the repository."
        }
        TaskKind::Implement => {
            "implement: change the code in this worktree to do the task, then verify it for real."
        }
        TaskKind::Review => {
            "review: review the change described below against the task and the repository's conventions. Look for bugs, missing verification, stray files and slop. Change nothing."
        }
        TaskKind::Merge => {
            "merge: resolve the conflicts described below in this worktree, keeping both sides' intent, then verify."
        }
        TaskKind::Verify => {
            "verify: run the project's checks (typecheck, lint, build, existing tests, a runtime smoke check) on this worktree and report exactly what passed and failed. Fix nothing."
        }
    };
    let write_rules = if task.kind.writes() {
        "\n- Work only inside this worktree. Don't commit, push, switch branches or touch other checkouts: Brigadier builds one clean commit from your changes after review.\n- List every file you changed, created or deleted in the report's `changes`: new files that aren't listed are left out of the commit.\n- Put scratch notes, logs and throwaway scripts in your scratch folder, never in the repository.\n- Don't write new tests unless the task asks for them. If a change breaks an existing test, fix the code; change a test only for an intended behaviour change."
    } else {
        "\n- Don't change files in the repository. Your scratch folder is yours for notes."
    };
    format!(
        r#"You are a Brigadier worker. Today is {today}. Your models' knowledge may be older than today: check current docs before relying on any third-party API, version or CLI.

Task task-{number}: {title}
Kind: {kind}
{repo_note}

Rules:
- You work alone on this task. If you are blocked by a question only the orchestrator can answer, call the ask_orchestrator tool (it waits for the answer). Don't ask about things you can find out yourself.{write_rules}
- Pushing, publishing, deploying and other outward actions are not yours to do; if one seems needed, say so in the report.
- Files meant for the orchestrator or the user (full findings, logs worth keeping, documents, generated images) go in your outputs folder. Brigadier attaches them to your report and the user saves them from the task card. Never write files to /tmp or anywhere else outside your worktree and scratch folder, even if the task names such a place: nobody could read them, and they would be left behind. Save them in your outputs folder and say so in the report.
- The orchestrator reads only your submit_report, never your messages: don't write your findings as a message. When done (or when you cannot continue), call submit_report exactly once: summary, changes, decisions, verification (exactly what you ran and what you saw), open questions. Keep it short (about 800 tokens at most); anything longer goes in a file in your outputs folder, named under `artifacts` with a short title.{instructions}{extra}

The task:
{spec}"#,
        today = today(),
        number = task.number,
        title = task.title,
        spec = task.spec,
    )
}

/// A Chat's role.
pub(crate) fn chat() -> String {
    format!(
        "You are a helpful assistant in Brigadier, a desktop app. Today is {}. You are in a plain chat: there is no repository and you cannot edit code. You may search the web when current information helps; say where facts came from.",
        today()
    )
}

/// A report as the orchestrator reads it.
pub(crate) fn report_envelope(task: &Task, report: &Report, route: &str) -> String {
    let mut text = format!(
        "[report task-{} · {:?} · \"{}\" · {}]\n{}",
        task.number, task.kind, task.title, route, report.summary
    );
    let list = |title: &str, items: &[String], text: &mut String| {
        if !items.is_empty() {
            text.push_str(&format!("\n{title}:"));
            for item in items {
                text.push_str(&format!("\n- {item}"));
            }
        }
    };
    list("Changes", &report.changes, &mut text);
    list("Decisions", &report.decisions, &mut text);
    list("Verification", &report.verification, &mut text);
    list("Open questions", &report.open_questions, &mut text);
    if let Some(verdict) = report.verdict {
        text.push_str(&format!("\nVerdict: {verdict:?}"));
    }
    if !report.artifacts.is_empty() {
        text.push_str("\nArtifacts:");
        for artifact in &report.artifacts {
            text.push_str(&format!(
                "\n- {} ({:?}, {} bytes): {}",
                artifact.id, artifact.kind, artifact.bytes, artifact.title
            ));
        }
    }
    if !task.outputs.is_empty() {
        text.push_str(
            "\nOutputs (the user saves them from the task card; read_artifact reads them):",
        );
        for output in &task.outputs {
            text.push_str(&format!(
                "\n- {} ({}, {} bytes): {}",
                output.id, output.mime, output.bytes, output.title
            ));
        }
    }
    text.push_str("\n[/report]");
    text
}
