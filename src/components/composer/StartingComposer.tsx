import type { SessionStartup } from "../../sessionStartup";
import type { ProjectView } from "../../wire";
import { PromptInput } from "../PromptInput";
import { ComposerActions } from "../assistant-ui/elements/composer";
import { PermissionControl } from "./ExecutionControls";
import { ResolvedTaskRail } from "./TaskSetupRail";

export function StartingComposer({ startup, project }: { startup: SessionStartup; project: ProjectView | null }) {
  return <>
    <ResolvedTaskRail project={project} cwd={startup.args.workspacePath ?? project?.root_path ?? null} branch={startup.args.newBranch ?? startup.args.baseBranch ?? null} isolated={!!startup.args.isolated || !!startup.args.workspacePath} preparing={!startup.error}/>
    <PromptInput value="" onText={() => {}} disabled aria-label="Message" placeholder={startup.error ? "Resolve setup to continue this task" : "Starting session…"} rows={2}>
      <ComposerActions className="composer-main-actions">
        <PermissionControl value={startup.args.composerPermission ?? "approve"} onChange={() => {}} disabled/>
        <span className="composer-control-spacer"/>
        <span className="composer-control">{startup.args.model ?? "Auto"}</span>
        {!startup.error && <span className="composer-spinner" aria-label="Preparing task"/>}
      </ComposerActions>
    </PromptInput>
  </>;
}
