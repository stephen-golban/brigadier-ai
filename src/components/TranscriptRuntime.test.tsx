import {cleanup,render} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {useAui} from '@assistant-ui/react';
import {TranscriptRuntime} from './TranscriptRuntime';
afterEach(cleanup);
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
