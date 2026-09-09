import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {PromptInput} from '../PromptInput';
import type {PeerAttachment} from '../../peerApi';
const native = vi.hoisted(() => ({listeners: new Set<(event: {payload: unknown}) => void>(), invoke: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({isTauri: () => true, invoke: native.invoke}));
vi.mock('@tauri-apps/api/webview', () => ({getCurrentWebview: () => ({onDragDropEvent: async (callback: (event: {payload: unknown}) => void) => {native.listeners.add(callback); return () => native.listeners.delete(callback);}})}));
afterEach(() => {cleanup(); native.listeners.clear(); native.invoke.mockReset(); vi.restoreAllMocks();});
function Input({id}: {id: string}) {
  const [files, setFiles] = useState<PeerAttachment[]>([]);
  return <PromptInput aria-label={id} value="" onText={()=>{}} sessionId={id} attachmentProjectId={`project-${id}`} attachments={files} onAttachments={setFiles}/>;
}
it('routes physical native file paths only to the composer under the drop point', async () => {
  native.invoke.mockResolvedValue({id:'binary',projectId:'project-worker',name:'archive.bin',mediaType:'application/octet-stream',size:4,createdAt:0});
  const view=render(<><Input id="parent"/><Input id="worker"/></>);
  const surfaces=view.container.querySelectorAll('.composer-surface');
  vi.spyOn(surfaces[0]!, 'getBoundingClientRect').mockReturnValue({left:0,right:100,top:0,bottom:100} as DOMRect);
  vi.spyOn(surfaces[1]!, 'getBoundingClientRect').mockReturnValue({left:0,right:100,top:100,bottom:200} as DOMRect);
  vi.spyOn(window,'devicePixelRatio','get').mockReturnValue(2);
  await waitFor(()=>expect(native.listeners.size).toBe(2));
  await act(async()=>{for(const listener of native.listeners)listener({payload:{type:'drop',position:{x:80,y:280},paths:['/tmp/archive.bin']}});});
  await screen.findByRole('button',{name:'Remove attachment archive.bin'});
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith('import_conversation_attachment_path',{projectId:'project-worker',path:'/tmp/archive.bin'});
  expect(surfaces[0]).not.toHaveTextContent('archive.bin');
  expect(surfaces[1]).toHaveTextContent('archive.bin');
});
it('does not attach a late native import response to a newly selected conversation', async () => {
  let resolve: (file: PeerAttachment)=>void=()=>{};
  native.invoke.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const view=render(<Input id="old"/>);
  vi.spyOn(view.container.querySelector('.composer-surface')!, 'getBoundingClientRect').mockReturnValue({left:0,right:1000,top:0,bottom:1000} as DOMRect);
  await waitFor(()=>expect(native.listeners.size).toBe(1));
  await act(async()=>{for(const listener of native.listeners)listener({payload:{type:'drop',position:{x:10,y:10},paths:['/tmp/old.pdf']}});});
  view.rerender(<Input key="new" id="new"/>);
  await act(async()=>resolve({id:'old-file',projectId:'project-old',name:'old.pdf',mediaType:'application/octet-stream',size:4,createdAt:0}));
  expect(screen.queryByRole('button',{name:'Remove attachment old.pdf'})).toBeNull();
});
