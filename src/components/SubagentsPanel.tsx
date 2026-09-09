import * as feed from "../feedStore";
import { Approvals } from "./Approvals";
import { ArrowLeftIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useState, useEffect, useSyncExternalStore } from 'react';
import type { SessionRuntime } from '../feedStore';
import type { PeerData } from '../peerApi';
import { workerTree } from '../workerTree';
import { markSessionRead } from '../attention';
import { useStoredState } from '../workbenchState';
import { bridge } from '../bridge';
import { errorMessage } from '../workspaceApi';
import { providerIdentity } from './AgentsPanel';
import { Button } from './controls/button';
import { ThreadView } from './ThreadView';
import { Composer } from './Composer';
import './thread-context.css';

export function SubagentsPanel({ rootId, projectId, peers, sessions, onFile, requestedId }: {
  requestedId?: string | null;
  rootId: string | null; projectId: string; peers: PeerData;
  sessions: Record<string, SessionRuntime>; onFile: (path: string, session: SessionRuntime | undefined) => void;
}) {
  const [selection, setSelection] = useStoredState<Record<string, string | null>>('brigadier:worker-panel-selection', {});
  useEffect(()=>{if(rootId && requestedId)setSelection(old=>({...old,[rootId]:requestedId}));},[rootId,requestedId]);
  const [error, setError] = useState('');
  const feedState = useSyncExternalStore(feed.subscribe, feed.getState);
  const rows = rootId ? workerTree(rootId, peers, sessions) : [];
  const selected = rootId ? rows.find(row => row.id === selection[rootId]) : undefined;
  useEffect(() => {
    if (selected?.session && Number.isFinite(selected.session.lastEventSeq)) {
      markSessionRead(selected.id, selected.session.lastEventSeq);
    }
  }, [selected?.id, selected?.session?.lastEventSeq]);
  const selectedProjectId = selected?.session?.projectId ?? projectId;
  const select = (id: string | null) => rootId && setSelection(old => ({...old, [rootId]: id}));
  const report = (e: unknown) => setError(errorMessage(e));
  return <section className="subagents-panel" aria-label="Subagents">
    <header className="subagents-heading">
      {selected ? <Button size="icon" aria-label="Back to subagents" onClick={() => select(null)}><ArrowLeftIcon /></Button> : <UsersThreeIcon size={18} />}
      <span>{selected ? peers.titles[selected.id] ?? `Worker ${selected.id.slice(-6)}` : 'Subagents'}</span>
    </header>
    {error && <p role="alert" className="text-error px-3">{error}</p>}
    {selected ? <>
      <div className="worker-parent-note">From {peers.titles[selected.parent] ?? 'parent task'} · {selected.session ? providerIdentity(selected.session.instanceId).name : 'Provider unknown'} · {selected.session?.model ?? 'Model unknown'}</div>
      <ThreadView requests={<Approvals approvals={feedState.approvals.filter(a=>a.sessionId===selected.id).map(approval=>({approval,projectId:selectedProjectId,projectName:null,elsewhere:false}))} onRespond={(id,request,decision)=>void bridge().respond(id,request,decision).catch(report)} onDismiss={feed.dismissApproval} />} sessionId={selected.id} projectId={selectedProjectId} projectName={null} peers={peers} onFile={path => onFile(path, selected.session)} onSelectSession={id => { if(rows.some(r => r.id === id)) select(id); }} />
      {selected.session ? <div className="worker-composer"><Composer
        key={selected.id} session={selected.session} busy={false}
        onSend={async (id, text, attachments) => { try { await bridge().sendTurn(id, text, attachments); return true; } catch(e) { report(e); return false; } }}
        onInterrupt={id => void bridge().interrupt(id).catch(report)}
        onEnd={id => void bridge().endSession(id).catch(report)} onKill={id => void bridge().kill(id).catch(report)}
        onResume={id => void bridge().resumeSession(id).catch(report)}
        onCleanup={async (id, force) => { try { return await bridge().cleanupWorktree(id, force); } catch(e) { report(e); return null; } }}
      /></div> : <p className="worker-parent-note">Saved conversation. Execution state is unavailable.</p>}
    </> : <div className="subagents-list">
      {(['Active', 'Done'] as const).map(group => {
        const members = rows.filter(row => row.done === (group === 'Done'));
        return <section key={group}><h3>{group} · {members.length}</h3>
          {!members.length && <p>{group === 'Active' ? 'No active subagents' : 'No completed subagents'}</p>}
          {members.map(row => <Button key={row.id} className="subagent-row" style={{paddingLeft: 12 + Math.min(row.depth, 6) * 14}} onClick={() => select(row.id)}>
            <UsersThreeIcon size={18}/><span className="subagent-name">{peers.titles[row.id] ?? `Worker ${row.id.slice(-6)}`}<small>{row.session ? providerIdentity(row.session.instanceId).name : 'Provider unknown'} · {row.session?.model ?? 'Model unknown'}{row.depth > 0 ? ` · from ${peers.titles[row.parent] ?? row.parent.slice(-6)}` : ''}</small></span>
            <small>{row.done ? 'Done' : feedState.approvals.some(a => a.sessionId === row.id && !a.expired) ? 'Needs approval' : !row.session ? 'Unknown' : row.session.status === 'failed' ? 'Needs attention' : row.session.busy ? 'Working' : row.session.status === 'starting' ? 'Starting' : row.awaitingIntegration ? 'Awaiting integration' : 'Waiting'}</small>
          </Button>)}
        </section>;
      })}
    </div>}
  </section>;
}
