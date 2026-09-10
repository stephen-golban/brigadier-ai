import { useEffect, useState } from "react";
import { ArrowLeft, Branch, Check, ChevronSmallDown, Desktop, Expand, Folder, Plus } from "../../icons";
import { Popover, navigateItems } from "../controls/overlay";
import { Button } from "../controls/button";
import { SelectMenu } from "../SelectMenu";
import type { ProjectComposerPreferences } from "../../taskSettings";
import type { ComposerWorkspaceOptions } from "../../composerWorkspaceApi";
import type { ProjectView } from "../../wire";
import "./setup-rail.css";

const branchLabelFor = (name: string) => name.replace(/^refs\/(heads|remotes)\//, "");

export function invalidBranchName(name: string): boolean {
  return !name || name === "@" || name.startsWith("-") || name.endsWith(".") ||
    /[\s~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("@{") ||
    name.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"));
}

export function TaskSetupRail({ project, projects, picks, options, disabled, onChange, onSelectProject, onNewProject, onProjectless }: {
  project: ProjectView | null; projects?: ProjectView[]; picks: ProjectComposerPreferences;
  options: ComposerWorkspaceOptions | null; disabled: boolean;
  onChange: (picks: ProjectComposerPreferences) => void; onSelectProject?: (id: string) => void;
  onNewProject?: () => void; onProjectless?: () => void;
}) {
  const [projectOpen, setProjectOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [existing, setExisting] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchView, setBranchView] = useState<"menu" | "new" | "checkout">("menu");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  useEffect(() => { if (disabled) { setProjectOpen(false); setEnvironmentOpen(false); setBranchOpen(false); } }, [disabled]);
  const selectedWorktree = options?.worktrees.find(tree => tree.path === picks.workspacePath);
  const current = picks.workspacePath ? selectedWorktree?.branch ?? null : options?.currentBranch ?? null;
  const environmentLabel = picks.workspacePath ? `Worktree · ${picks.workspacePath.split("/").pop()}` : picks.isolated ? "New worktree" : "Work locally";
  const branchLabel = picks.isolated && !picks.newBranch ? `Branch from: ${picks.baseBranch ? branchLabelFor(picks.baseBranch) : "Current files"}` : picks.newBranch ? `New: ${picks.newBranch}` : picks.baseBranch ? `Checkout: ${branchLabelFor(picks.baseBranch)}` : current ? `Current (${current})` : "Current files";
  const chooseEnvironment = (isolated: boolean, workspacePath: string | null = null) => {
    if (disabled) return;
    onChange({ ...picks, isolated, workspacePath, baseBranch: isolated ? (options?.branches.find(branch => branch.name === "origin/main")?.name ?? options?.currentBranch ?? null) : null, newBranch: null });
    setEnvironmentOpen(false);
  };
  const chooseBranch = (baseBranch: string | null, newBranch: string | null = null) => {
    if (disabled) return;
    onChange({ ...picks, baseBranch, newBranch });
    setBranchOpen(false);
  };
  const branches = options?.branches ?? [];
  const nameError = name && (invalidBranchName(name) ? "Enter a valid Git branch name." : branches.some(branch => !branch.remote && branch.name === name) ? "That branch already exists. Use Checkout instead." : null);
  return <div className="composer-setup-rail" aria-label="Task setup">
    <div className="setup-picker">
      <Popover isOpen={projectOpen && !disabled} onOpenChange={setProjectOpen}>
        <Button className="composer-select" aria-label="Project" disabled={disabled || (!onSelectProject && !onProjectless)}><Folder width={17} height={17}/><span>{project && !project.projectless ? project.name : "Work in a project"}</span><ChevronSmallDown width={14} height={14}/></Button>
        <Popover.Content placement="top start" className="composer-popover setup-popover">
          <Popover.Dialog aria-label="Project">
            <p className="composer-popover-heading">Project</p>
            <div role="listbox" aria-label="Project" onKeyDown={navigateItems}>
              {(projects ?? (project ? [project] : [])).filter(item => !item.projectless).map(item => <button key={item.id} type="button" role="option" aria-selected={project?.id === item.id} className="setup-menu-option" onClick={() => { onSelectProject?.(item.id); setProjectOpen(false); }}><Folder/><span>{item.name}</span>{project?.id === item.id && <Check/>}</button>)}
            </div>
            {onNewProject && <Button className="setup-menu-option" onClick={() => {setProjectOpen(false); onNewProject();}}><Plus/><span>New project</span></Button>}
            {onProjectless && <button type="button" role="option" aria-selected={!!project?.projectless} className="setup-menu-option" onClick={() => {setProjectOpen(false); onProjectless();}}><Folder/><span>Don't work in a project</span>{project?.projectless && <Check/>}</button>}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
    {!!project && !project.projectless && <>

    <div className="setup-picker">
      <Popover isOpen={environmentOpen && !disabled} onOpenChange={open => { setEnvironmentOpen(open); setExisting(false); setQuery(""); }}>
        <Button className="composer-select" aria-label="Environment" title={picks.workspacePath ?? environmentLabel} disabled={disabled || !options}>{picks.isolated || picks.workspacePath ? <Expand width={17} height={17}/> : <Desktop width={17} height={17}/>}<span>{environmentLabel}</span><ChevronSmallDown width={14} height={14} /></Button>
        <Popover.Content placement="top start" className="composer-popover setup-popover">
          <Popover.Dialog aria-label="Task environment">
            {existing ? <>
              <Button className="setup-menu-back" onClick={() => setExisting(false)}><ArrowLeft />Environment</Button>
              <input type="search" data-autofocus="true" aria-label="Search worktrees" placeholder="Find a worktree…" value={query} onChange={event => setQuery(event.target.value)} />
              <div role="listbox" aria-label="Existing worktree" onKeyDown={navigateItems}>
                {options?.worktrees.filter(tree => `${tree.path} ${tree.branch ?? ""} ${tree.activeTaskTitle ?? ""}`.toLowerCase().includes(query.toLowerCase())).map(tree => <button key={tree.path} type="button" role="option" aria-label={`${tree.branch ?? "Detached HEAD"} ${tree.path}${tree.activeTaskTitle ? ` In use by ${tree.activeTaskTitle}` : tree.reason ? ` ${tree.reason}` : ""}`} disabled={!tree.available} aria-selected={picks.workspacePath === tree.path} className="setup-menu-option" onClick={() => chooseEnvironment(false, tree.path)}>
                  <Branch /><span>{tree.branch ?? "Detached HEAD"}<small>{" "}{tree.path}</small>{!tree.available && <small>{" "}{tree.activeTaskTitle ? `In use by ${tree.activeTaskTitle}` : tree.reason ?? "Unavailable"}</small>}</span>{picks.workspacePath === tree.path && <Check />}
                </button>)}
                {!options?.worktrees.length && <p className="composer-popover-heading">No worktrees in this project yet.</p>}
              </div>
            </> : <div role="listbox" aria-label="Environment" onKeyDown={navigateItems}>
              <button type="button" role="option" aria-selected={!picks.isolated && !picks.workspacePath} className="setup-menu-option" onClick={() => chooseEnvironment(false)}><Desktop /><span>Work locally</span>{!picks.isolated && !picks.workspacePath && <Check />}</button>
              <button type="button" role="option" aria-selected={picks.isolated && !picks.workspacePath} disabled={!options?.isGit} className="setup-menu-option" onClick={() => chooseEnvironment(true)}><Expand /><span>New worktree{!options?.isGit && <small>This folder is not a Git repository.</small>}</span>{picks.isolated && !picks.workspacePath && <Check />}</button>
              <button type="button" role="option" aria-selected={!!picks.workspacePath} disabled={!options?.worktrees.length} className="setup-menu-option" onClick={() => setExisting(true)}><Folder /><span>Existing worktree{!options?.worktrees.length && <small>No worktrees in this project yet.</small>}</span>{picks.workspacePath && <Check />}</button>
            </div>}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
    <div className="setup-picker">
      <Popover isOpen={branchOpen && !disabled} onOpenChange={open => {setBranchOpen(open); setBranchView("menu"); setQuery("");}}>
        <Button className="composer-select" aria-label="Branch" title={branchLabel} disabled={disabled || !options?.isGit}><Branch width={17} height={17}/><span>{branchLabel}</span><ChevronSmallDown width={14} height={14}/></Button>
        <Popover.Content placement="top start" className="composer-popover setup-popover">
          <Popover.Dialog aria-label="Starting branch">
            {branchView === "menu" && picks.isolated ? <>
              <input type="search" autoFocus data-autofocus="true" aria-label="Search branches" placeholder="Search branches" value={query} onChange={event => setQuery(event.target.value)} />
              <p className="composer-popover-heading">Branch from:</p>
              <div role="listbox" aria-label="Branch from" onKeyDown={navigateItems}>
                <button type="button" role="option" aria-selected={!picks.baseBranch && !picks.newBranch} className="setup-menu-option" onClick={() => chooseBranch(null)}><Branch/><span>Current files<small>Include uncommitted changes</small></span>{!picks.baseBranch && !picks.newBranch && <Check/>}</button>
                {branches.filter(branch => branch.name.toLowerCase().includes(query.toLowerCase())).map(branch => <button key={branch.name} type="button" role="option" aria-label={`${branchLabelFor(branch.name)} ${branch.remote ? "Remote branch" : "Local branch"}`} aria-selected={picks.baseBranch === branch.name && !picks.newBranch} className="setup-menu-option" onClick={() => chooseBranch(branch.name)}><Branch/><span>{branchLabelFor(branch.name)}</span>{picks.baseBranch === branch.name && !picks.newBranch && <Check/>}</button>)}
                {!branches.some(branch => branch.name.toLowerCase().includes(query.toLowerCase())) && <p className="composer-popover-heading">No matching branches.</p>}
              </div>
              <button type="button" role="option" aria-selected={!!picks.newBranch} className="setup-menu-option" onClick={() => {setName(picks.newBranch ?? "");setStart(picks.baseBranch ?? "");setBranchView("new");}}><Plus/><span>New branch</span></button>
            </> : branchView === "menu" ? <div role="listbox" aria-label="Branch" onKeyDown={navigateItems}>
              <p className="composer-popover-heading">Start from:</p>
              <button type="button" role="option" aria-selected={!picks.baseBranch && !picks.newBranch} className="setup-menu-option" onClick={() => chooseBranch(null)}><Branch /><span>Current: {current ?? "Detached HEAD"}<small>{" "}Preserve current uncommitted files.</small></span>{!picks.baseBranch && !picks.newBranch && <Check />}</button>
              <button type="button" role="option" aria-selected={!!picks.newBranch} className="setup-menu-option" onClick={() => {setName(picks.newBranch ?? "");setStart(picks.baseBranch ?? "");setBranchView("new");}}><Plus /><span>New branch<small>{" "}Name a branch and choose its starting point.</small></span></button>
              <button type="button" role="option" aria-selected={!!picks.baseBranch && !picks.newBranch} className="setup-menu-option" onClick={() => setBranchView("checkout")}><Branch /><span>Checkout<small>{" "}Select an existing branch.</small></span></button>
            </div> : <>
              <Button className="setup-menu-back" onClick={() => setBranchView("menu")}><ArrowLeft />Start from</Button>
              {branchView === "new" ? <form className="setup-branch-form" onSubmit={event => {event.preventDefault(); if (!invalidBranchName(name) && !nameError) chooseBranch(start || null, name);}}>
                <label>Branch name<input autoFocus aria-label="New branch name" value={name} placeholder="feature/my-change" onChange={event => setName(event.target.value)} /></label>
                <label>Starting point<SelectMenu label="Starting point" value={start} onChange={setStart} searchable options={[{value:"",label:`Current (${current ?? "HEAD"})`}, ...branches.map(branch => ({value:branch.name,label:branchLabelFor(branch.name),description:branch.remote ? "Remote branch" : "Local branch"}))]}/></label>
                {nameError && <p role="alert" className="composer-error">{nameError}</p>}
                <p className="composer-popover-heading">Created when you send.</p>
                <Button type="submit" disabled={invalidBranchName(name) || !!nameError}>Use new branch</Button>
              </form> : <>
                <input type="search" data-autofocus="true" aria-label="Search branches" placeholder="Find a branch…" value={query} onChange={event => setQuery(event.target.value)} />
                <div role="listbox" aria-label="Checkout branch" onKeyDown={navigateItems}>{branches.filter(branch => branch.name.toLowerCase().includes(query.toLowerCase())).map(branch => <button key={branch.name} type="button" role="option" aria-label={`${branchLabelFor(branch.name)} ${branch.remote ? "Remote branch" : "Local branch"}`} aria-selected={picks.baseBranch === branch.name && !picks.newBranch} className="setup-menu-option" onClick={() => chooseBranch(branch.name)}><Branch /><span>{branchLabelFor(branch.name)}<small>{" "}{branch.remote ? "Remote branch" : "Local branch"}</small></span>{picks.baseBranch === branch.name && !picks.newBranch && <Check />}</button>)}</div>
              </>}
            </>}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
    </>}
  </div>;
}

/** Once a task starts, its workspace identity is resolved and no longer a setup choice. */
export function ResolvedTaskRail({ project, cwd, branch, isolated, preparing = false }: {
  project: ProjectView | null; cwd: string | null; branch: string | null; isolated: boolean; preparing?: boolean;
}) {
  return <div className="composer-setup-rail" aria-label="Task workspace">
    <span className="setup-picker" title={project?.root_path}><Folder width={17} height={17}/><span>{project?.name ?? "Workspace"}</span></span>
    <span className="setup-picker" title={cwd ?? undefined}>{isolated ? <Expand width={17} height={17}/> : <Desktop width={17} height={17}/>}<span>{preparing ? "Preparing workspace…" : isolated ? "Worktree" : "Local"}</span></span>
    {branch && <span className="setup-picker" title={branch}><Branch width={17} height={17}/><span>{branchLabelFor(branch)}</span></span>}
  </div>;
}
