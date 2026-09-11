import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useAui} from '@assistant-ui/react';
import {TranscriptRuntime} from './TranscriptRuntime';
import MarkdownContent from './MarkdownContent';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('retains unchanged runtime messages through parent renders and running-state updates',()=>{
 let client:ReturnType<typeof useAui>|undefined;
 function Probe(){client=useAui();return null;}
 const props={sessionId:'root',loaded:true,readOnly:false};
 const messages=[{id:'first',role:'assistant' as const,content:'Earlier answer'},{id:'last',role:'assistant' as const,content:'Current answer'}];
 const view=render(<TranscriptRuntime {...props} busy={false} messages={messages}><Probe/><span>First parent render</span></TranscriptRuntime>);
 const first=client!.thread().getState().messages[0];
 view.rerender(<TranscriptRuntime {...props} busy={false} messages={messages}><Probe/><span>Updated parent</span></TranscriptRuntime>);
 expect(client!.thread().getState().messages[0]).toBe(first);
 view.rerender(<TranscriptRuntime {...props} busy messages={messages}><Probe/></TranscriptRuntime>);
 expect(client!.thread().getState().messages[0]).toBe(first);
 expect(client!.thread().getState().messages[1]?.status?.type).toBe('running');
 view.rerender(<TranscriptRuntime {...props} busy={false} messages={[messages[0]!,{...messages[1]!,content:'Finished answer'}]}><Probe/></TranscriptRuntime>);
 expect(client!.thread().getState().messages[0]).toBe(first);
 expect(client!.thread().getState().messages[1]?.content).toEqual([{type:'text',text:'Finished answer'}]);
 expect(client!.thread().getState().messages[1]?.status?.type).toBe('complete');
});
it('renders complete saved text and legitimate repetition even when native animation frames pause',async()=>{
 vi.stubGlobal('requestAnimationFrame',vi.fn(()=>1));
 vi.stubGlobal('cancelAnimationFrame',vi.fn());
 const props={sessionId:'root',loaded:true,readOnly:false};
 const text='NATIVE_REPEAT_0910';
 const view=render(<TranscriptRuntime {...props} busy messages={[{id:'first',role:'assistant',content:'NATIVE_REP'}]}><MarkdownContent text="NATIVE_REP"/></TranscriptRuntime>);
 expect(screen.getByText('NATIVE_REP')).toBeInTheDocument();
 view.rerender(<TranscriptRuntime {...props} busy={false} messages={[{id:'first',role:'assistant',content:text},{id:'second',role:'assistant',content:text}]}><MarkdownContent text={text}/><MarkdownContent text={text}/></TranscriptRuntime>);
 await waitFor(()=>expect(screen.getAllByText(text)).toHaveLength(2));
 expect(screen.queryByText('NATIVE_REP')).not.toBeInTheDocument();
});
it('rejects edits and sends in the actual worker runtime and updates its transcript',()=>{
 let client:ReturnType<typeof useAui>|undefined;
 function Probe(){client=useAui();return null;}
 const props={sessionId:'worker',busy:false,loaded:true,readOnly:true};
 const view=render(<TranscriptRuntime {...props} messages={[{id:'result',role:'assistant',content:'saved result'}]}><Probe/></TranscriptRuntime>);
 expect(client!.thread().getState().messages[0]?.id).toBe('result');
 expect(client!.composer().getState().canSend).toBe(false);
 expect(()=>client!.composer().setText('user input')).toThrow(/readonly/);
 expect(()=>client!.composer().send()).toThrow(/readonly/);
 view.rerender(<TranscriptRuntime {...props} messages={[{id:'updated',role:'assistant',content:'continued result'}]}><Probe/></TranscriptRuntime>);
 expect(client!.thread().getState().messages[0]?.id).toBe('updated');
 expect(client!.composer().getState().canSend).toBe(false);
});
