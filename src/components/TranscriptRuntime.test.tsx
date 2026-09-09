import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useAui} from '@assistant-ui/react';
import {TranscriptRuntime} from './TranscriptRuntime';
import MarkdownContent from './MarkdownContent';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
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
