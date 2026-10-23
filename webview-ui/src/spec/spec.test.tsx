// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpecView } from '../../../src/shared/specProtocol';
import { parseTasks, taskProgress } from '../../../src/workspace/tasks';
import { initialState } from '../state';
import { useChat } from '../store';
import { outbox, saveState } from '../vscode';
import { SpecApp } from './SpecApp';
import { useSpec } from './specStore';

const TASKS =
  '- [x] 1. Set up\n- [ ] 2. Build\n  - [-] 2.1 Core\n    - Wire the parts\n    - _Requirements: 1.1, 2.3_\n  - [ ]* 2.2 Tests\n';

function view(extra: Partial<SpecView> = {}): SpecView {
  const tasks = parseTasks(TASKS);
  return {
    name: 'login',
    documents: [
      { kind: 'requirements', text: '# Requirements\n\nUsers can log in.', truncated: false },
      { kind: 'design', text: '# Design\n\nA login form.', truncated: false },
      { kind: 'tasks', text: TASKS, truncated: false },
    ],
    tasks,
    progress: taskProgress(tasks),
    canAsk: true,
    ...extra,
  };
}

beforeEach(() => {
  useChat.setState({ ...initialState });
  useSpec.setState({ spec: view(), gone: false });
  outbox.length = 0;
  // The tab the previous test chose is remembered by the page.
  saveState(undefined);
});
afterEach(cleanup);

describe('spec view', () => {
  it('shows the name, the progress and the first document', () => {
    render(<SpecApp />);
    expect(screen.getByRole('heading', { name: 'login' })).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByRole('progressbar').getAttribute('aria-label')).toBe('1 of 2 tasks');
    expect(screen.getByText('Users can log in.')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Requirements', 'Design', 'Tasks']);
  });

  it('switches documents with the mouse and the arrow keys', () => {
    render(<SpecApp />);
    fireEvent.click(screen.getByRole('tab', { name: 'Design' }));
    expect(screen.getByText('A login form.')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Design' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Design' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Tasks' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Tasks' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Requirements' }).getAttribute('aria-selected')).toBe('true');
  });

  it('asks the host to open the document file', () => {
    render(<SpecApp />);
    fireEvent.click(screen.getByRole('button', { name: /Open file/ }));
    expect(outbox).toEqual([{ type: 'openDocument', doc: 'requirements' }]);
  });

  it('approves a document, or sends the changes that were asked for', () => {
    render(<SpecApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve and continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request changes…' }));
    const send = screen.getByRole('button', { name: 'Send changes' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What should change?'), { target: { value: 'Add a lockout.' } });
    fireEvent.click(send);
    expect(outbox).toEqual([
      { type: 'approve', doc: 'requirements' },
      { type: 'requestChanges', doc: 'requirements', comment: 'Add a lockout.' },
    ]);
    // The form closes after sending.
    expect(screen.queryByLabelText('What should change?')).toBeNull();
  });

  it('can cancel a change request with Escape', () => {
    render(<SpecApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Request changes…' }));
    fireEvent.keyDown(screen.getByLabelText('What should change?'), { key: 'Escape' });
    expect(screen.queryByLabelText('What should change?')).toBeNull();
    expect(outbox).toEqual([]);
  });

  it('does not offer to approve the task list', () => {
    render(<SpecApp />);
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(screen.queryByRole('button', { name: 'Approve and continue' })).toBeNull();
  });

  describe('tasks', () => {
    beforeEach(() => {
      render(<SpecApp />);
      fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    });

    it('lists the tasks with their state, requirements and optional marker', () => {
      const items = screen.getAllByRole('listitem');
      const text = items.map((item) => item.textContent ?? '');
      expect(text.some((t) => t.includes('Done:') && t.includes('Set up'))).toBe(true);
      expect(
        text.some((t) => t.includes('Working…:') && t.includes('Core') && t.includes('Requirements: 1.1, 2.3')),
      ).toBe(true);
      expect(screen.getByText('optional')).toBeTruthy();
      expect(screen.getByText('Wire the parts')).toBeTruthy();
    });

    it('starts a task by its line and number, and continues one that is under way', () => {
      expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(screen.getAllByRole('button', { name: 'Start' })[0]!);
      expect(outbox).toEqual([
        { type: 'runTask', line: 2, number: '2.1' },
        { type: 'runTask', line: 1, number: '2' },
      ]);
    });

    it('offers no start for a task that is done', () => {
      const done = screen.getAllByRole('listitem').find((item) => item.textContent?.includes('Set up'));
      expect(within(done!).queryByRole('button')).toBeNull();
    });

    it('asks Kiro to update the list', () => {
      fireEvent.click(screen.getByRole('button', { name: /Update tasks/ }));
      expect(outbox).toEqual([{ type: 'updateTasks' }]);
    });
  });

  it('disables the questions to Kiro while Kiro cannot be asked', () => {
    useSpec.setState({ spec: view({ canAsk: false }) });
    render(<SpecApp />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve and continue' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect((screen.getAllByRole('button', { name: 'Start' })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('says so when the task list is empty, or the spec is gone', () => {
    useSpec.setState({ spec: view({ tasks: [], progress: { done: 0, total: 0 } }) });
    render(<SpecApp />);
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks' }));
    expect(screen.getByText('There are no tasks in this file yet.')).toBeTruthy();
    cleanup();
    useSpec.setState({ spec: undefined, gone: true });
    render(<SpecApp />);
    expect(screen.getByText('This spec was deleted.')).toBeTruthy();
  });

  it('says when a document was cut', () => {
    useSpec.setState({
      spec: view({ documents: [{ kind: 'requirements', text: '# R', truncated: true }] }),
    });
    render(<SpecApp />);
    expect(screen.getByText('This document is very long. Open the file to read all of it.')).toBeTruthy();
  });
});

describe('spec store', () => {
  it('takes the strings of the host for the shared components and follows updates', () => {
    useSpec.getState().receive({ type: 'init', strings: { Start: 'Starten' }, spec: view() });
    expect(useChat.getState().strings).toEqual({ Start: 'Starten' });
    useSpec.getState().receive({ type: 'update', spec: view({ name: 'renamed' }) });
    expect(useSpec.getState().spec?.name).toBe('renamed');
    useSpec.getState().receive({ type: 'gone' });
    expect(useSpec.getState()).toMatchObject({ spec: undefined, gone: true });
  });
});
