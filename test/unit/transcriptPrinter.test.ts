import { describe, expect, it } from 'vitest';
import { Session } from '../../src/acp/sessions';
import { parseSessionNotification } from '../../src/acp/types';
import { TranscriptPrinter } from '../../src/view/transcriptPrinter';
import { SESSION_ID, u, update } from '../support/kiro';

function setup() {
  const session = new Session(SESSION_ID);
  let text = '';
  const printer = new TranscriptPrinter({ append: (s) => (text += s) });
  const apply = (body: Record<string, unknown>) => {
    const parsed = parseSessionNotification(update(SESSION_ID, body));
    if (parsed) session.apply(parsed.event);
    printer.sync(session);
  };
  return { session, printer, apply, output: () => text };
}

describe('TranscriptPrinter', () => {
  it('prints streaming text once, as it grows', () => {
    const { session, printer, apply, output } = setup();
    session.beginTurn('Say hello');
    printer.sync(session);
    apply(u.agent('Hel'));
    apply(u.agent('lo'));
    printer.sync(session);
    expect(output()).toBe('> Say hello\nKiro: Hello');
  });

  it('prints a tool call again only when its status changes', () => {
    const { apply, printer, session, output } = setup();
    apply(u.toolCall('t1'));
    apply(u.toolUpdate('t1', { status: 'pending' }));
    apply(u.toolUpdate('t1', { status: 'pending' }));
    apply(u.toolUpdate('t1', { status: 'completed' }));
    printer.sync(session);
    expect(output().split('\n').filter(Boolean)).toEqual([
      '* Write File [edit]: in_progress /ws/hello.txt',
      '* Write File [edit]: pending /ws/hello.txt',
      '* Write File [edit]: completed /ws/hello.txt',
    ]);
  });

  it('puts a message that continues after a tool call on a fresh line', () => {
    const { apply, output } = setup();
    apply(u.agent('Working'));
    apply(u.toolCall('t1'));
    apply(u.agent(' on it'));
    expect(output()).toBe('Kiro: Working\n* Write File [edit]: in_progress /ws/hello.txt\nKiro:  on it');
  });

  it('prints notices, replayed messages and open questions', () => {
    const { apply, session, printer, output } = setup();
    apply(u.user('Earlier', { replay: true, messageId: 'm1' }));
    session.addNotice('warning', 'Lost the connection');
    session.addApproval({ title: 'Write File', resource: 'a.txt', type: 'tool_approval', files: [], options: [] });
    printer.sync(session);
    printer.sync(session);
    expect(output()).toBe('[replay] > Earlier\n[warning] Lost the connection\n? waiting for you: Write File (a.txt)\n');
  });
});
