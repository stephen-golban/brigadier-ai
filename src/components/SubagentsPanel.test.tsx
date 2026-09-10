import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {SubagentsPanel} from './SubagentsPanel';
import type {SessionRuntime} from '../feedStore';
vi.mock('./ThreadView',()=>({ThreadView:({sessionId, projectId, onFile}:{sessionId:string;projectId:string;onFile:(path:string)=>void})=><div>Conversation {sessionId}<span>Project {projectId}</span><button onClick={()=>onFile("src/worker.ts")}>Open worker file</button></div>}));
vi.mock('./Composer',()=>({Composer:({session}:{session:SessionRuntime})=><div>Message worker {session.sessionId}</div>}));
const peers={origins:{},subagents:{child:'root',grandchild:'child'},titles:{child:'Builder',grandchild:'Reviewer'},closed:['grandchild'],messages:[],requests:[]};
afterEach(()=>{cleanup();localStorage.clear();vi.useRealTimers();});
it('keeps parent visible, opens a nested worker conversation and restores selection',async()=>{
 const sessions={child:{sessionId:'child',status:'running',busy:true,instanceId:'claude-code:default',model:'exact-model'},grandchild:{sessionId:'grandchild',status:'exited',busy:false,instanceId:'codex:default',model:'other-model'}} as unknown as Record<string,SessionRuntime>;
 const props={rootId:'root',projectId:'p',peers,sessions,onFile:vi.fn()};
 const view=render(<><p>Parent conversation stays visible</p><SubagentsPanel {...props}/></>);
 expect(screen.getByText('Active · 1')).toBeVisible();expect(screen.getByText('Done · 1')).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:/Reviewer/}));
 expect(screen.getByText('Conversation grandchild')).toBeVisible();expect(screen.getByText('Parent conversation stays visible')).toBeVisible();
 view.unmount();render(<SubagentsPanel {...props}/>);
 expect(screen.getByText('Conversation grandchild')).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:'Back to subagents'}));
 await userEvent.click(screen.getByRole('button',{name:/^Builder/}));
 expect(screen.queryByText('Message worker child')).not.toBeInTheDocument();
 expect(screen.getByText(/View-only activity/)).toBeVisible();
});

it('uses the selected worker project and workspace for attachments and file links',async()=>{
 const child={sessionId:'child',projectId:'worker-project',cwd:'/worker-worktree',status:'running',busy:false,instanceId:'codex:default',model:'worker-model'} as SessionRuntime;
 const onFile=vi.fn();
 render(<SubagentsPanel rootId="root" projectId="parent-project" peers={peers} sessions={{child}} onFile={onFile}/>);
 await userEvent.click(screen.getByRole('button',{name:/^Builder/}));
 expect(screen.getByText('Project worker-project')).toBeVisible();
 await userEvent.click(screen.getByRole('button',{name:'Open worker file'}));
 expect(onFile).toHaveBeenCalledWith('src/worker.ts',child);
});

it('shows completed live workers awaiting integration and marks only the opened worker read', async()=>{
 const child={sessionId:'child',projectId:'p',status:'running',busy:false,lastTurnId:'done',lastStop:'end-turn',lastEventSeq:104} as SessionRuntime;
 render(<SubagentsPanel rootId="root" projectId="p" peers={peers} sessions={{child}} onFile={vi.fn()}/>);
 expect(screen.getByText('awaiting review')).toBeVisible();
 expect(localStorage.getItem('brigadier:read-sessions')).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:/^Builder/}));
 expect(JSON.parse(localStorage.getItem('brigadier:read-sessions')!)).toEqual({child:104});
});

it('shows requests as status only and retains Stop without a composer or decision controls',async()=>{
 const feed=await import('../feedStore');
 feed.seedApprovals([{session_id:'child',request_id:'worker-permission',opened_at_ms:1,expired:false,resolved:false,kind:{type:'tool-permission',tool_name:'Bash',input_excerpt:'deploy',suggestions:[],tool_call_id:null}}]);
 const {composerApi}=await import('../composerApi');
 const stop=vi.spyOn(composerApi,'stop').mockResolvedValue({} as never);
 render(<SubagentsPanel rootId="root" projectId="p" peers={peers} sessions={{child:{sessionId:'child',status:'running',busy:true} as SessionRuntime}} onFile={vi.fn()}/>);
 await userEvent.click(screen.getByRole('button',{name:/^Builder/}));
 expect(screen.getByText('Waiting for a response in the orchestrator conversation.')).toBeVisible();
 expect(screen.queryByRole('button',{name:'Allow'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Deny'})).toBeNull();
 expect(screen.queryByText(/Message worker/)).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Stop subagent'}));
 expect(stop).toHaveBeenCalledExactlyOnceWith('child');
 stop.mockRestore();feed.seedApprovals([]);
});

import {readSequence,useAttention} from '../attention';
import type {Envelope,Event,FeedBatch} from '../wire';

/*
 * The read marker for the opened worker has to come off the **live** stream, not off the React
 * snapshot. `lastEventSeq` is a `CURSOR_FIELDS` value in `src/feedStore.ts`, folded into the
 * snapshot only on the 500 ms `COUNTER_FLUSH_MS` tick, so a cursor-only advance for the worker
 * being read (a repeated `session-started`, a `turn-aborted` with `busy` already false, a repeated
 * identical `runtime-error`) is invisible to the panel's props. Pre-fix the panel acknowledged the
 * snapshot's stale sequence and had nothing at leave time; the fold then lifted `lastEventSeq`
 * above what was persisted and the badge predicate turned an unread dot on for the worker just
 * read. Same regression as `src/attention.test.ts` "acknowledges the live sequence when leaving a
 * session a cursor-only signal just advanced", against this panel's own nested selection.
 *
 * No `vi.resetModules()`: the store driven here must be the same `feedStore` instance
 * `src/attention.ts` reads the live cursor from, or the cursor it reads belongs to another store.
 */
it('acknowledges the live sequence when leaving a worker a cursor-only signal just advanced',async()=>{
 vi.useFakeTimers();
 const store=await import('../feedStore');
 const id='cursor-child';
 const cursorPeers={origins:{},subagents:{[id]:'root'},titles:{[id]:'Cursor worker'},closed:[] as string[],messages:[],requests:[]};
 let seq=0;
 const signal=(event:Event):Envelope=>({seq:++seq,at:1_000,instance_id:'i',session_id:id,event});
 const push=(...signals:Envelope[])=>{
  store.pushBatch({project_id:'p',rows:[],signals,counters:[]} as FeedBatch);
  vi.advanceTimersByTime(17); // one jsdom rAF period: exactly one drain
 };
 const announce=():Event=>({type:'session-started',provider_session_id:'p1',model:'m',cwd:'/repo',capabilities:[],resume_token:null});

 store.start();
 push(signal(announce()),signal({type:'turn-started',turn_id:'t1'}),
      signal({type:'turn-completed',turn_id:'t1',stop_reason:'end-turn',cost_usd_cumulative:0,
              usage:{input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_creation_tokens:0,context_window:null}}));
 const read=store.getState();
 const stale=read.sessions[id]!.lastEventSeq;

 // The badge is `useAttention`'s, computed over the same sessions `src/App.tsx` hands it; the panel
 // owns only the read marker. Both are rendered so the assertion is the dot the operator would see.
 const Harness=({sessions,open}:{sessions:Record<string,SessionRuntime>;open:boolean})=>{
  const attention=useAttention(sessions,null,[]);
  return <><span>Badge {attention[id]?'unread':'read'}</span>
   {open&&<SubagentsPanel rootId="root" projectId="p" peers={cursorPeers} sessions={sessions} onFile={vi.fn()} requestedId={id}/>}</>;
 };
 const view=render(<Harness sessions={read.sessions} open/>);
 expect(screen.getByText(`Conversation ${id}`)).toBeVisible(); // the worker is open
 expect(readSequence(id)).toBe(stale);
 expect(screen.getByText('Badge read')).toBeVisible();

 push(signal(announce())); // a cursor-only advance for the worker being read
 expect(store.getState()).toBe(read); // no rebuild on this frame: the panel's props still trail
 const live=seq;
 expect(live).toBeGreaterThan(stale);

 view.rerender(<Harness sessions={store.getState().sessions} open={false}/>); // …and the operator leaves
 expect(readSequence(id)).toBe(live); // pre-fix: the snapshot's stale sequence
 expect(JSON.parse(localStorage.getItem('brigadier:read-sessions')!)[id]).toBe(live); // persisted before the switch is observable

 vi.advanceTimersByTime(600); // the COUNTER_FLUSH_MS fold
 const folded=store.getState();
 expect(folded).not.toBe(read);
 view.rerender(<Harness sessions={folded.sessions} open={false}/>);
 expect(screen.getByText('Badge read')).toBeVisible(); // no dot on the worker just read
 store.stop();
});
