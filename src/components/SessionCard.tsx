import { AgentStatus } from './assistant-ui/elements/agent-status';
import { WorkerSummary } from './WorkerSummary';
import { BackgroundInbox } from './assistant-ui/elements/background-inbox';
import { useEffect, useState } from 'react';
import { useTaskExecutionSettings } from '../taskSettings';
import { Branch, Compare, ExternalLink, File, Folder, SettingsCog, SettingsSlider, Users } from "../icons";
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
    <summary className="thread-context-summary" aria-label="Session context"><SettingsSlider width={18} height={18}/><span>Context</span></summary>
    <aside className="thread-context" aria-label="Session environment">
      <section><h3>Environment · locked for this task</h3>
        <AgentStatus state={session.status==='failed'?'failed':session.busy?'working':session.status==='exited'?'idle':'waiting'} label={session.status==='failed'?'Execution failed':session.busy?'Working':session.status==='exited'?'Stopped':'Ready'}/>
        <Button className="context-row" onClick={()=>navigate(onChanges)}><Compare/><span>Changes</span><span className="change-count"><i className="text-ok not-italic">+{changes.files.reduce((n,f) => n+f.added,0)}</i> <i className="text-error not-italic">−{changes.files.reduce((n,f) => n+f.deleted,0)}</i></span></Button>
        <Button className="context-row" onClick={()=>navigate(onFiles)} title={session.cwd ?? undefined}><Folder/><span>{settings?.workspacePath ? 'Existing worktree' : session.worktreePath ? 'Worktree' : 'Local'} · {session.cwd?.split('/').pop() ?? 'Workspace'}</span></Button>
        <div className="context-row" title={session.branch ?? undefined}><Branch/><span>{session.branch ?? 'No Git branch'}</span></div>
        {settings?.baseBranch && <div className="context-row" title={settings.baseBranch}><Branch/><span>Started from {settings.baseBranch}</span></div>}
        {session.branch && <Button className="context-row" onClick={()=>navigate(onChanges)}><Compare/><span>Commit, push or compare</span><ExternalLink/></Button>}
        <Button className="context-row" onClick={onSettings}><SettingsCog/><span>Session settings</span></Button>
      </section>
      {rows.length > 0 && <section><h3>Subagents</h3><Button className="context-row" onClick={()=>navigate(onSubagents)}><Users/><WorkerSummary rows={rows}/></Button></section>}
      <BackgroundInbox runs={Object.entries(peers.origins).filter(([id,owner])=>owner===session.sessionId&&!peers.subagents?.[id]&&!peers.closed.includes(id)&&sessions[id]&&(sessions[id]!.busy||sessions[id]!.status==='starting'||sessions[id]!.status==='failed'||(sessions[id]!.lastTurnId&&sessions[id]!.lastStop==='end-turn'))).map(([id])=>({id,title:peers.titles[id]??'Created chat',state:sessions[id]!.status==='failed'?'failed':(sessions[id]!.busy||sessions[id]!.status==='starting')?'running':'ready'}))} onCollect={id=>navigate(()=>onSelect(id))}/>
      <section><h3>Sources</h3>
        <Button className="context-row" onClick={()=>navigate(onFiles)}><Folder/><span>Project files</span></Button>
        {[...files.values()].map(a => <Button key={a.id} className="context-row" onClick={() => void viewAttachment(a.id)} title={a.name}><File/><span>{a.name}</span></Button>)}
        {peers.origins[session.sessionId] && <Button className="context-row" onClick={() => onSelect(peers.origins[session.sessionId]!)}><ExternalLink/><span>Source conversation</span></Button>}
        {error && <p role="alert" className="text-error">{error}</p>}
      </section>
    </aside>
  </details>;
}
