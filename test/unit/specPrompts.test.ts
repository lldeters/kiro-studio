import { describe, expect, it } from 'vitest';
import {
  canApprove,
  newSpecPrompt,
  reviewPrompt,
  specMode,
  suggestSpecName,
  taskPrompt,
  updateTasksPrompt,
} from '../../src/workspace/specPrompts';
import { parseTasks } from '../../src/workspace/tasks';

describe('spec prompts', () => {
  it('names the mode each workflow runs in', () => {
    expect(specMode('requirements-first')).toBe('spec');
    expect(specMode('design-first')).toBe('spec');
    expect(specMode('quick')).toBe('quick-spec');
    expect(specMode('bugfix')).toBe('bug-fix');
  });

  it('suggests a folder name from the first words of the description', () => {
    expect(suggestSpecName('Add a login page for the admin area, with OAuth')).toBe('login-page-admin-area');
    expect(suggestSpecName('  !!! ')).toBe('');
    expect(suggestSpecName('Größe ändern')).toBe('gr-e-ndern');
  });

  it('starts every workflow with the document it begins with and the folder', () => {
    const description = 'Users can reset their password.';
    expect(newSpecPrompt('requirements-first', 'reset', description)).toMatch(
      /named "reset" in \.kiro\/specs\/reset\/ for this feature:\n\nUsers can reset their password\.\n\nStart with \.kiro\/specs\/reset\/requirements\.md.*stop and let me review/s,
    );
    expect(newSpecPrompt('design-first', 'reset', description)).toContain('Start with .kiro/specs/reset/design.md');
    expect(newSpecPrompt('bugfix', 'crash', 'It crashes.')).toMatch(
      /bugfix spec named "crash".*for this bug.*bugfix\.md/s,
    );
    expect(newSpecPrompt('quick', 'reset', description)).toContain('in one go');
  });

  it('asks for one task, or a task with its sub-tasks, and to stop afterwards', () => {
    const [parent, single] = parseTasks('- [ ] 1. Build\n  - [ ] 1.1 Core\n- [ ] 2. Docs\n');
    const files = ['requirements.md', 'design.md', 'tasks.md'];
    if (!parent || !single) throw new Error('sample did not parse');
    const one = taskPrompt({ spec: 'login', files, task: single });
    expect(one).toContain('Execute task 2 "Docs" of the spec "login"');
    expect(one).toContain('.kiro/specs/login/requirements.md, .kiro/specs/login/design.md, .kiro/specs/login/tasks.md');
    expect(one).toContain('only this task');
    expect(one).toContain('stop so that I can review');
    expect(taskPrompt({ spec: 'login', files, task: parent })).toContain(
      'this task and its sub-tasks, one after the other',
    );
  });

  it('identifies a task without a number by its title and line', () => {
    const [task] = parseTasks('\n- [ ] Write the docs\n');
    if (!task) throw new Error('sample did not parse');
    expect(taskPrompt({ spec: 's', files: ['tasks.md'], task })).toContain(
      'task "Write the docs" (line 2 of .kiro/specs/s/tasks.md)',
    );
  });

  it('asks to bring the task list up to date without losing what is done', () => {
    expect(updateTasksPrompt('login')).toMatch(/keep the state of the tasks that are done/);
  });

  it('approves a document by naming the next one, and does not approve the task list', () => {
    expect(reviewPrompt('login', 'requirements', { type: 'approve' })).toBe(
      'I approve .kiro/specs/login/requirements.md of the spec "login". Continue with .kiro/specs/login/design.md.',
    );
    expect(reviewPrompt('login', 'bugfix', { type: 'approve' })).toContain('Continue with .kiro/specs/login/design.md');
    expect(reviewPrompt('login', 'design', { type: 'approve' })).toContain('Continue with .kiro/specs/login/tasks.md');
    expect(canApprove('tasks')).toBe(false);
    expect(canApprove('design')).toBe(true);
  });

  it('passes the change request on as it was written', () => {
    expect(reviewPrompt('login', 'design', { type: 'changes', comment: '  Use Postgres.  ' })).toBe(
      'Revise .kiro/specs/login/design.md of the spec "login" with these changes:\n\nUse Postgres.\n\nUpdate the file and stop so that I can review it again.',
    );
  });
});
