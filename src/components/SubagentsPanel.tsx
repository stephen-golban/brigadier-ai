import { SubagentList } from './assistant-ui/elements/subagent-list';
import { BackgroundInbox } from './assistant-ui/elements/background-inbox';
import { AgentHandoff } from './assistant-ui/elements/agent-handoff';
import { WorkerSummary } from './WorkerSummary';
import { AgentStatus } from "./assistant-ui/elements/agent-status";
import * as feed from "../feedStore";
import { ArrowLeftIcon, UsersThreeIcon } from '@phosphor-icons/react';
import { useState, useEffect, useSyncExternalStore } from 'react';
import type { SessionRuntime } from '../feedStore';
import type { PeerData } from '../peerApi';
import { workerTree, workerPresentation } from '../workerTree';
import { markSessionRead } from '../attention';
import { useStoredState } from '../workbenchState';
import { errorMessage } from '../workspaceApi';
import { providerIdentity } from './AgentsPanel';
import { Button } from './controls/button';
import { ThreadView } from './ThreadView';
import { composerApi } from '../composerApi';
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
  const assignment = selected ? peers.assignments?.[selected.id] : undefined;
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
      <div className="worker-parent-note"><AgentStatus {...workerPresentation(selected, feedState.approvals.some(a=>a.sessionId===selected.id&&!a.expired))}/></div>
      {assignment?.continuedFrom && <AgentHandoff from={peers.titles[assignment.continuedFrom]??'Previous worker'} to={peers.titles[selected.id]??'Current worker'} reason={assignment.selection.reason} carried={[assignment.objective,assignment.criteria,assignment.scope]} settled={assignment.state!=='starting'}/>}
      {assignment && <div className="worker-parent-note space-y-2">
        <p>{assignment.objective}</p><p>Acceptance: {assignment.criteria}</p><p>Scope: {assignment.scope}</p>
        <p>Requested: {assignment.selection.provider} / {assignment.selection.model}{assignment.selection.effort ? ` · ${assignment.selection.effort}` : ''}{assignment.selection.pinned ? ' · pinned' : ''}</p>
        <p>{assignment.selection.reason}</p><p>Assignment: {assignment.state} · Contribution: {assignment.disposition}</p>
        {assignment.baseline && <p>Workspace baseline: {assignment.baseline.slice(0,12)}</p>}
        {assignment.result && <p>Result: {assignment.result}</p>}
        {!!assignment.history?.length && <details><summary>Retained assignment history · {assignment.history.length}</summary>{assignment.history.map((h,i)=><p key={i}>{h.objective ?? h.instruction}{h.result ? ` · ${h.result}` : ''}{h.evidence ? ` · ${h.evidence}` : ''}{h.applied === false ? ' · not applied' : ''}</p>)}</details>}
        {assignment.evidence && <p>Evidence: {assignment.evidence}</p>}
        <BackgroundInbox runs={rows.filter(row=>row.awaitingIntegration).map(row=>({id:row.id,title:peers.titles[row.id]??'Worker result',state:'ready',summary:peers.assignments?.[row.id]?.result??undefined}))} onCollect={select}/>
    </div>}
      <div className="worker-parent-note">View-only activity. Send instructions and answer requests in the orchestrator conversation.</div>
      {feedState.approvals.some(a => a.sessionId === selected.id && !a.expired) && <p role="status" className="worker-parent-note">Waiting for a response in the orchestrator conversation.</p>}
      <ThreadView sessionId={selected.id} projectId={selectedProjectId} projectName={null} peers={peers} onFile={path => onFile(path, selected.session)} onSelectSession={id => { if(rows.some(r => r.id === id)) select(id); }} />
      {selected.session && !selected.done && <Button onClick={() => void composerApi.stop(selected.id).catch(report)}>Stop subagent</Button>}
      {!selected.session && <p className="worker-parent-note">Saved activity. Execution state is unavailable.</p>}
    </> : <div className="subagents-list">
      {!!rows.length && <WorkerSummary rows={rows}/>}
      {(['Active', 'Done'] as const).map(group => {
        const members = rows.filter(row => row.done === (group === 'Done'));
        return <section key={group}><h3>{group} · {members.length}</h3>
          {!members.length && <p>{group === 'Active' ? 'No active subagents' : 'No completed subagents'}</p>}
          <SubagentList agents={members.map(row=>({id:row.id,name:peers.titles[row.id]??`Worker ${row.id.slice(-6)}`,model:`${row.session?providerIdentity(row.session.instanceId).name:'Provider unknown'} · ${row.session?.model??'Model unknown'}`,detail:peers.assignments?.[row.id]?.objective,icon:<UsersThreeIcon size={18}/>,...workerPresentation(row,feedState.approvals.some(a=>a.sessionId===row.id&&!a.expired))}))} onSelect={select}/>

        </section>;
      })}
      <BackgroundInbox runs={rows.filter(row=>row.awaitingIntegration).map(row=>({id:row.id,title:peers.titles[row.id]??'Worker result',state:'ready',summary:peers.assignments?.[row.id]?.result??undefined}))} onCollect={select}/>
    </div>}
  </section>;
}
