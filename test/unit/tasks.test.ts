import { describe, expect, it } from 'vitest';
import { flattenTasks, parseTasks, taskAtLine, taskByNumber, taskProgress } from '../../src/workspace/tasks';

/** In the style the descriptions of Kiro's spec workflow give (PLAN.md A19), not a file written by Kiro. */
const SAMPLE = `# Implementation Plan

- [x] 1. Set up the project structure
  - Create the folders for models and services
  - Define the interfaces
  - _Requirements: 1.1, 1.5_

- [ ] 2. Implement the data models
  - [x] 2.1 Create the User model
    - Add validation
    - _Requirements: 2.1_
  - [ ] 2.2 Create the Session model
    - _Requirements: 2.2, 3.4_
  - [ ]* 2.3 Write unit tests for the models
    - _Requirements: 2.1_

- [-] 3. **Wire everything up**
  - Connect the services
`;

describe('parseTasks', () => {
  const tasks = parseTasks(SAMPLE);

  it('nests sub-tasks under the task above them', () => {
    expect(tasks.map((t) => t.number)).toEqual(['1', '2', '3']);
    expect(tasks.map((t) => t.children.length)).toEqual([0, 3, 0]);
  });

  it('reads number, title, status, details and requirements', () => {
    expect(tasks[0]).toMatchObject({
      line: 2,
      number: '1',
      title: 'Set up the project structure',
      status: 'done',
      optional: false,
      details: ['Create the folders for models and services', 'Define the interfaces'],
      requirements: ['1.1', '1.5'],
    });
    expect(tasks[2]).toMatchObject({ title: 'Wire everything up', status: 'inProgress' });
  });

  it('marks optional tasks and keeps the status of the others', () => {
    const optional = taskByNumber(tasks, '2.3');
    expect(optional).toMatchObject({ optional: true, status: 'todo', title: 'Write unit tests for the models' });
    expect(optional?.requirements).toEqual(['2.1']);
  });

  it('finds a task by its line', () => {
    expect(taskAtLine(tasks, 2)?.number).toBe('1');
    expect(taskAtLine(tasks, 0)).toBeUndefined();
  });

  it('flattens parents before their children', () => {
    expect(flattenTasks(tasks).map((t) => t.number)).toEqual(['1', '2', '2.1', '2.2', '2.3', '3']);
  });

  it('nests by indentation when the tasks have no numbers', () => {
    const plain = parseTasks('- [ ] Parent\n  - [x] Child\n    - [ ] Grandchild\n- [ ] Next\n');
    expect(plain.map((t) => t.title)).toEqual(['Parent', 'Next']);
    expect(plain[0]?.children[0]?.children[0]?.title).toBe('Grandchild');
    expect(plain[0]?.number).toBeUndefined();
  });

  it('ignores code fences and lines that are no checkboxes', () => {
    const text = '- [ ] 1. Real\n```\n- [ ] 2. In a fence\n```\n- 3. Not a checkbox\n* [X] 4. Bullet and capital X\n';
    expect(flattenTasks(parseTasks(text)).map((t) => t.title)).toEqual(['Real', 'Bullet and capital X']);
  });

  it('copes with CRLF, tabs and a heading that ends a task', () => {
    const tasks = parseTasks('- [ ] 1. A\r\n\t- [x] 1.1 B\r\n# Notes\r\n  - stray bullet\r\n');
    expect(tasks[0]?.children[0]).toMatchObject({ number: '1.1', status: 'done' });
    expect(tasks[0]?.details).toEqual([]);
  });

  it('reads the requirements line in the variants it may come in', () => {
    const text =
      '- [ ] 1. A\n  - _Requirements: 1.1, 1.5, 3.1_ (comma separated list of related requirements)\n- [ ] 2. B\n  - Requirements: 4.2 and 5\n';
    expect(parseTasks(text).map((t) => t.requirements)).toEqual([
      ['1.1', '1.5', '3.1'],
      ['4.2', '5'],
    ]);
  });

  it('returns nothing for a file without tasks', () => {
    expect(parseTasks('')).toEqual([]);
    expect(parseTasks('just text')).toEqual([]);
  });
});

describe('taskProgress', () => {
  it('counts the tasks without sub-tasks, so that a parent is not counted twice', () => {
    expect(taskProgress(parseTasks(SAMPLE))).toEqual({ done: 2, total: 4 });
  });

  it('lets a spec be complete without its optional tasks, and counts the ones that were done', () => {
    expect(taskProgress(parseTasks('- [x] 1. A\n- [ ]* 2. Optional\n'))).toEqual({ done: 1, total: 1 });
    expect(taskProgress(parseTasks('- [x] 1. A\n- [x]* 2. Optional\n'))).toEqual({ done: 2, total: 2 });
  });

  it('does not count a task in progress as done', () => {
    expect(taskProgress(parseTasks('- [-] 1. A\n- [x] 2. B\n'))).toEqual({ done: 1, total: 2 });
  });
});
