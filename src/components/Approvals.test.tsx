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
