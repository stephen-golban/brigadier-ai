import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import {SubagentsPanel} from './SubagentsPanel';
import type {SessionRuntime} from '../feedStore';
vi.mock('./ThreadView',()=>({ThreadView:({sessionId, projectId, onFile}:{sessionId:string;projectId:string;onFile:(path:string)=>void})=><div>Conversation {sessionId}<span>Project {projectId}</span><button onClick={()=>onFile("src/worker.ts")}>Open worker file</button></div>}));
vi.mock('./Composer',()=>({Composer:({session}:{session:SessionRuntime})=><div>Message worker {session.sessionId}</div>}));
const peers={origins:{},subagents:{child:'root',grandchild:'child'},titles:{child:'Builder',grandchild:'Reviewer'},closed:['grandchild'],messages:[],requests:[]};
afterEach(()=>{cleanup();localStorage.clear();});
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
