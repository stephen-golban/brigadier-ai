import { useEffect, useState } from "react";
import { CheckIcon, FolderIcon, GitBranchIcon, LaptopIcon, ArrowsOutSimpleIcon, PlusIcon, CaretDownIcon, ArrowLeftIcon } from "@phosphor-icons/react";
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

export function TaskSetupRail({ project, projects, picks, options, disabled, onChange, onSelectProject }: {
  project: ProjectView | null; projects?: ProjectView[]; picks: ProjectComposerPreferences;
  options: ComposerWorkspaceOptions | null; disabled: boolean;
  onChange: (picks: ProjectComposerPreferences) => void; onSelectProject?: (id: string) => void;
}) {
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [existing, setExisting] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchView, setBranchView] = useState<"menu" | "new" | "checkout">("menu");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  useEffect(() => { if (disabled) { setEnvironmentOpen(false); setBranchOpen(false); } }, [disabled]);
  const selectedWorktree = options?.worktrees.find(tree => tree.path === picks.workspacePath);
  const current = picks.workspacePath ? selectedWorktree?.branch ?? null : options?.currentBranch ?? null;
  const environmentLabel = picks.workspacePath ? `Worktree · ${picks.workspacePath.split("/").pop()}` : picks.isolated ? "New worktree" : "Work locally";
  const branchLabel = picks.newBranch ? `New: ${picks.newBranch}` : picks.baseBranch ? `Checkout: ${branchLabelFor(picks.baseBranch)}` : current ? `Current (${current})` : "Current files";
  const chooseEnvironment = (isolated: boolean, workspacePath: string | null = null) => {
    if (disabled) return;
    onChange({ ...picks, isolated, workspacePath, baseBranch: null, newBranch: null });
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
    <div className="setup-picker"><FolderIcon size={17} /><SelectMenu placement="top start" label="Project" value={project?.id ?? ""} disabled={disabled || !onSelectProject} onChange={id => onSelectProject?.(id)} options={(projects ?? (project ? [project] : [])).map(p => ({ value: p.id, label: p.name }))} searchable /></div>
    <div className="setup-picker">
      {picks.isolated || picks.workspacePath ? <ArrowsOutSimpleIcon size={17} /> : <LaptopIcon size={17} />}
      <Popover isOpen={environmentOpen && !disabled} onOpenChange={open => { setEnvironmentOpen(open); setExisting(false); setQuery(""); }}>
        <Button className="composer-select" aria-label="Environment" title={picks.workspacePath ?? environmentLabel} disabled={disabled || !options}><span>{environmentLabel}</span><CaretDownIcon size={14} /></Button>
        <Popover.Content placement="top start" className="composer-popover setup-popover">
          <Popover.Dialog aria-label="Task environment">
            {existing ? <>
              <Button className="setup-menu-back" onClick={() => setExisting(false)}><ArrowLeftIcon />Environment</Button>
              <input type="search" aria-label="Search worktrees" placeholder="Find a worktree…" value={query} onChange={event => setQuery(event.target.value)} />
              <div role="listbox" aria-label="Existing worktree" onKeyDown={navigateItems}>
                {options?.worktrees.filter(tree => `${tree.path} ${tree.branch ?? ""} ${tree.activeTaskTitle ?? ""}`.toLowerCase().includes(query.toLowerCase())).map(tree => <button key={tree.path} type="button" role="option" aria-label={`${tree.branch ?? "Detached HEAD"} ${tree.path}${tree.activeTaskTitle ? ` In use by ${tree.activeTaskTitle}` : tree.reason ? ` ${tree.reason}` : ""}`} disabled={!tree.available} aria-selected={picks.workspacePath === tree.path} className="setup-menu-option" onClick={() => chooseEnvironment(false, tree.path)}>
                  <GitBranchIcon /><span>{tree.branch ?? "Detached HEAD"}<small>{" "}{tree.path}</small>{!tree.available && <small>{" "}{tree.activeTaskTitle ? `In use by ${tree.activeTaskTitle}` : tree.reason ?? "Unavailable"}</small>}</span>{picks.workspacePath === tree.path && <CheckIcon />}
                </button>)}
                {!options?.worktrees.length && <p className="composer-popover-heading">No worktrees in this project yet.</p>}
              </div>
            </> : <div role="listbox" aria-label="Environment" onKeyDown={navigateItems}>
              <button type="button" role="option" aria-selected={!picks.isolated && !picks.workspacePath} className="setup-menu-option" onClick={() => chooseEnvironment(false)}><LaptopIcon /><span>Work locally<small>{" "}Use the project checkout as it stands.</small></span>{!picks.isolated && !picks.workspacePath && <CheckIcon />}</button>
              <button type="button" role="option" aria-selected={picks.isolated && !picks.workspacePath} disabled={!options?.isGit} className="setup-menu-option" onClick={() => chooseEnvironment(true)}><ArrowsOutSimpleIcon /><span>New worktree<small>{" "}{options?.isGit ? "Create an isolated workspace when you send." : "This folder is not a Git repository."}</small></span>{picks.isolated && !picks.workspacePath && <CheckIcon />}</button>
              <button type="button" role="option" aria-selected={!!picks.workspacePath} disabled={!options?.worktrees.length} className="setup-menu-option" onClick={() => setExisting(true)}><FolderIcon /><span>Existing worktree<small>{" "}{options?.worktrees.length ? "Choose a workspace belonging to this project." : "No worktrees in this project yet."}</small></span>{picks.workspacePath && <CheckIcon />}</button>
            </div>}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
    <div className="setup-picker"><GitBranchIcon size={17} />
      <Popover isOpen={branchOpen && !disabled} onOpenChange={open => {setBranchOpen(open); setBranchView("menu"); setQuery("");}}>
        <Button className="composer-select" aria-label="Branch" title={branchLabel} disabled={disabled || !options?.isGit}><span>{branchLabel}</span><CaretDownIcon size={14}/></Button>
        <Popover.Content placement="top start" className="composer-popover setup-popover">
          <Popover.Dialog aria-label="Starting branch">
            {branchView === "menu" ? <div role="listbox" aria-label="Branch" onKeyDown={navigateItems}>
              <p className="composer-popover-heading">Start from:</p>
              <button type="button" role="option" aria-selected={!picks.baseBranch && !picks.newBranch} className="setup-menu-option" onClick={() => chooseBranch(null)}><GitBranchIcon /><span>Current: {current ?? "Detached HEAD"}<small>{" "}Preserve current uncommitted files.</small></span>{!picks.baseBranch && !picks.newBranch && <CheckIcon />}</button>
              <button type="button" role="option" aria-selected={!!picks.newBranch} className="setup-menu-option" onClick={() => {setName(picks.newBranch ?? "");setStart(picks.baseBranch ?? "");setBranchView("new");}}><PlusIcon /><span>New branch<small>{" "}Name a branch and choose its starting point.</small></span></button>
              <button type="button" role="option" aria-selected={!!picks.baseBranch && !picks.newBranch} className="setup-menu-option" onClick={() => setBranchView("checkout")}><GitBranchIcon /><span>Checkout<small>{" "}Select an existing branch.</small></span></button>
            </div> : <>
              <Button className="setup-menu-back" onClick={() => setBranchView("menu")}><ArrowLeftIcon />Start from</Button>
              {branchView === "new" ? <form className="setup-branch-form" onSubmit={event => {event.preventDefault(); if (!invalidBranchName(name) && !nameError) chooseBranch(start || null, name);}}>
                <label>Branch name<input autoFocus aria-label="New branch name" value={name} placeholder="feature/my-change" onChange={event => setName(event.target.value)} /></label>
                <label>Starting point<SelectMenu label="Starting point" value={start} onChange={setStart} searchable options={[{value:"",label:`Current (${current ?? "HEAD"})`}, ...branches.map(branch => ({value:branch.name,label:branchLabelFor(branch.name),description:branch.remote ? "Remote branch" : "Local branch"}))]}/></label>
                {nameError && <p role="alert" className="composer-error">{nameError}</p>}
                <p className="composer-popover-heading">Created when you send.</p>
                <Button type="submit" disabled={invalidBranchName(name) || !!nameError}>Use new branch</Button>
              </form> : <>
                <input type="search" aria-label="Search branches" placeholder="Find a branch…" value={query} onChange={event => setQuery(event.target.value)} />
                <div role="listbox" aria-label="Checkout branch" onKeyDown={navigateItems}>{branches.filter(branch => branch.name.toLowerCase().includes(query.toLowerCase())).map(branch => <button key={branch.name} type="button" role="option" aria-label={`${branchLabelFor(branch.name)} ${branch.remote ? "Remote branch" : "Local branch"}`} aria-selected={picks.baseBranch === branch.name && !picks.newBranch} className="setup-menu-option" onClick={() => chooseBranch(branch.name)}><GitBranchIcon /><span>{branchLabelFor(branch.name)}<small>{" "}{branch.remote ? "Remote branch" : "Local branch"}</small></span>{picks.baseBranch === branch.name && !picks.newBranch && <CheckIcon />}</button>)}</div>
              </>}
            </>}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  </div>;
}
