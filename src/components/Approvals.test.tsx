import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {Approvals, type ApprovalRow} from './Approvals';
const row: ApprovalRow = {
  projectId: 'project', projectName: 'Native test', elsewhere: false,
  approval: {requestId: 'mcp-request', sessionId: 'codex-session', openedAtMs: 1, expired: false,
    kind: {type: 'tool-permission', tool_name: 'MCP · brigadier',
      input_excerpt: JSON.stringify({message:'Allow the brigadier MCP server to run tool "task_checkpoint"?',description:'Read or update the task checkpoint',arguments:{}}),
      suggestions: [], tool_call_id: null}},
};
afterEach(cleanup);
it('shows the actual MCP confirmation and sends a single-request Allow without permission persistence',()=>{
  const respond=vi.fn();
  render(<Approvals approvals={[row]} onRespond={respond} onDismiss={vi.fn()}/>);
  expect(screen.getByText('MCP · brigadier')).toBeVisible();
  expect(screen.getByText('Allow the brigadier MCP server to run tool "task_checkpoint"?')).toBeVisible();
  expect(screen.getByText('Read or update the task checkpoint')).toBeVisible();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Allow'}));
  expect(respond).toHaveBeenCalledExactlyOnceWith('codex-session','mcp-request',{type:'allow',updated_input:null,updated_permissions:[]});
});
it('keeps Deny explicit and removes an approval when its Stop resolution arrives',()=>{
  const respond=vi.fn();
  const view=render(<Approvals approvals={[row]} onRespond={respond} onDismiss={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:'Deny'}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm deny'}));
  expect(respond).toHaveBeenCalledExactlyOnceWith('codex-session','mcp-request',{type:'deny',reason:'Denied by operator',interrupt:false});
  view.rerender(<Approvals approvals={[]} onRespond={respond} onDismiss={vi.fn()}/>);
  expect(screen.queryByRole('button',{name:'Allow'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Deny'})).toBeNull();
});
it('never allows a restored expired MCP approval',()=>{
  render(<Approvals approvals={[{...row,approval:{...row.approval,expired:true}}]} onRespond={vi.fn()} onDismiss={vi.fn()}/>);
  expect(screen.queryByRole('button',{name:'Allow'})).toBeNull();
  expect(screen.getByRole('button',{name:'Dismiss'})).toBeVisible();
});

it('keeps the card while a decision is pending and supports retry after a rejected response', async () => {
  const { waitFor } = await import('@testing-library/react');
  let reject!: (error: Error) => void;
  const respond = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
  render(<Approvals approvals={[row]} onRespond={respond} onDismiss={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  expect(respond).toHaveBeenCalledTimes(1);
  reject(new Error('Provider disconnected'));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('Your decision has not been confirmed');
  expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  expect(document.getElementById('approval-mcp-request')).toBeInTheDocument();
  expect(screen.queryByText('Approved')).toBeNull();
});

it('folds only persisted resolved decisions and keeps permission separate from execution success', async () => {
  const { ApprovalResolution } = await import('./Approvals');
  const history = {request_id:'confirmed',session_id:'codex-session',opened_at_ms:1,kind:row.approval.kind,expired:false,resolved:false,decision:{type:'allow' as const,updated_input:null,updated_permissions:[]}};
  const view = render(<ApprovalResolution approval={history} />);
  expect(screen.queryByText(/Approved/)).toBeNull();
  view.rerender(<ApprovalResolution approval={{...history,resolved:true}} />);
  fireEvent.click(screen.getByText('Approved · MCP · brigadier'));
  expect(screen.getByText(/See the action above for its execution result/)).toBeVisible();
  expect(screen.queryByText('Succeeded')).toBeNull();
});

it('renders an expired receipt without inventing a denial or approval', async () => {
  const { ApprovalResolution } = await import('./Approvals');
  render(<ApprovalResolution approval={{request_id:'expired',session_id:'s',opened_at_ms:1,kind:row.approval.kind,expired:true,resolved:true,decision:null}} />);
  fireEvent.click(screen.getByText('Expired · MCP · brigadier'));
  expect(screen.getByText(/No approval decision was recorded/)).toBeVisible();
  expect(screen.queryByText(/Denied/)).toBeNull();
  expect(screen.queryByText(/Approved/)).toBeNull();
});

it('routes a worker card to the orchestrator while preserving its exact provider request',()=>{
 const respond=vi.fn(), focus=vi.fn();
 render(<Approvals approvals={[{...row,conversationId:'root',subagentTitle:'Reviewer'}]} onRespond={respond} onDismiss={vi.fn()} onFocus={focus}/>);
 fireEvent.click(screen.getByText('Subagent request · Reviewer'));
 expect(focus).toHaveBeenCalledWith('project','root');
 fireEvent.click(screen.getByRole('button',{name:'Allow'}));
 expect(respond).toHaveBeenCalledExactlyOnceWith('codex-session','mcp-request',{type:'allow',updated_input:null,updated_permissions:[]});
});
