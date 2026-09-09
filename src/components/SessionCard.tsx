import { useEffect, useState } from 'react';
import { useTaskExecutionSettings } from '../taskSettings';
import { GitBranchIcon, GitDiffIcon, SlidersHorizontalIcon, UsersThreeIcon, FolderIcon, GearSixIcon, FileIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import { Button } from './controls/button';
import type { SessionRuntime } from '../feedStore';
import { peerApi, type PeerData } from '../peerApi';
import { useSessionChanges } from '../desktopApi';
import { workerTree } from '../workerTree';
import './thread-context.css';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from '../workspaceApi';
import type { PeerAttachment } from '../peerApi';

export function SessionCard({ session, sessions, peers, onSelect, onChanges, onSettings, onSubagents, onFiles }: {
  session: SessionRuntime; sessions: Record<string, SessionRuntime>; peers: PeerData;
  onSelect: (id: string) => void; onChanges: () => void; onSettings: () => void;
  onSubagents: () => void; onFiles: () => void;
}) {
  const {settings} = useTaskExecutionSettings(session.sessionId);
  const changes = useSessionChanges(session.sessionId);
  const [open, setOpen] = useState(() => window.innerWidth >= 1500);
  const navigate = (action: () => void) => {setOpen(false);action();};
  const rows = workerTree(session.sessionId, peers, sessions);
  const [error, setError] = useState('');
  const [savedSources, setSavedSources] = useState<PeerAttachment[]>([]);
  useEffect(() => {
    let live = true;
    setSavedSources([]);
    if (desktop) void invoke<PeerAttachment[]>('session_sources', {sessionId: session.sessionId}).then(files => { if(live)setSavedSources(files); }, error => { if(live)setError(String(error)); });
    return () => { live = false; };
  }, [session.sessionId, session.busy, session.lastTurnId]);
  const files = new Map([...peers.messages, ...(peers.inputs ?? [])]
    .filter(m => m.to === session.sessionId)
    .flatMap(m => m.attachments ?? []).concat(savedSources).map(a => [a.id, a]));
  const viewAttachment = async (id: string) => {
    if (!session.projectId) return;
    try {
      const attachment = await peerApi.attachment(session.projectId, id);
      const bytes = Uint8Array.from(atob(attachment.base64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], {type: attachment.metadata.mediaType}));
      const link = document.createElement('a'); link.href = url; link.download = attachment.metadata.name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch(e) { setError(String(e)); }
  };
  return <details className="thread-context-wrap" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary className="thread-context-summary" aria-label="Environment and subagents"><SlidersHorizontalIcon size={18}/><span>Context</span></summary>
    <aside className="thread-context" aria-label="Session environment">
      <section><h3>Environment · locked for this task</h3>
        <Button className="context-row" onClick={()=>navigate(onChanges)}><GitDiffIcon/><span>Changes</span><span className="change-count"><i className="text-ok not-italic">+{changes.files.reduce((n,f) => n+f.added,0)}</i> <i className="text-error not-italic">−{changes.files.reduce((n,f) => n+f.deleted,0)}</i></span></Button>
        <Button className="context-row" onClick={()=>navigate(onFiles)} title={session.cwd ?? undefined}><FolderIcon/><span>{settings?.workspacePath ? 'Existing worktree' : session.worktreePath ? 'Worktree' : 'Local'} · {session.cwd?.split('/').pop() ?? 'Workspace'}</span></Button>
        <div className="context-row" title={session.branch ?? undefined}><GitBranchIcon/><span>{session.branch ?? 'No Git branch'}</span></div>
        {settings?.baseBranch && <div className="context-row" title={settings.baseBranch}><GitBranchIcon/><span>Started from {settings.baseBranch}</span></div>}
        {session.branch && <Button className="context-row" onClick={()=>navigate(onChanges)}><GitDiffIcon/><span>Commit, push or compare</span><ArrowSquareOutIcon/></Button>}
        <Button className="context-row" onClick={onSettings}><GearSixIcon/><span>Session settings</span></Button>
      </section>
      <section><h3>Subagents</h3><Button className="context-row" onClick={()=>navigate(onSubagents)}><UsersThreeIcon/><span>{rows.filter(r => !r.done).length} active · {rows.filter(r => r.done).length} done</span></Button></section>
      <section><h3>Sources</h3>
        <Button className="context-row" onClick={()=>navigate(onFiles)}><FolderIcon/><span>Project files</span></Button>
        {[...files.values()].map(a => <Button key={a.id} className="context-row" onClick={() => void viewAttachment(a.id)} title={a.name}><FileIcon/><span>{a.name}</span></Button>)}
        {peers.origins[session.sessionId] && <Button className="context-row" onClick={() => onSelect(peers.origins[session.sessionId]!)}><ArrowSquareOutIcon/><span>Parent conversation</span></Button>}
        {error && <p role="alert" className="text-error">{error}</p>}
      </section>
    </aside>
  </details>;
}
