import { describe, expect, it } from 'vitest';
import { Session } from '../../src/acp/sessions';
import { parseSessionNotification } from '../../src/acp/types';
import {
  currentAutonomy,
  optionLabel,
  plainText,
  spokenStatus,
  statusModel,
  type StatusInput,
  type UiState,
} from '../../src/view/statusModel';
import { formatCredits } from '../../src/shared/format';
import { statusTree } from '../../src/view/statusTree';
import { SESSION_ID, sessionResult, u, update } from '../support/kiro';

function session(options: { autopilot?: 'on' | 'off'; model?: boolean } = {}): Session {
  const s = new Session(SESSION_ID);
  s.applySessionResult(sessionResult(SESSION_ID, { autopilot: options.autopilot ?? 'off' }));
  if (options.model !== false) {
    const parsed = parseSessionNotification(
      update(SESSION_ID, u.configUpdate(sessionResultOptions(options.autopilot ?? 'off'))),
    );
    if (parsed) s.apply(parsed.event);
  }
  return s;
}

function sessionResultOptions(autopilot: 'on' | 'off') {
  const result = sessionResult(SESSION_ID, { autopilot }) as { configOptions: Record<string, unknown>[] };
  return [
    ...result.configOptions,
    {
      type: 'select',
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'claude-sonnet-4.5',
      options: [{ value: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }],
    },
  ];
}

const input = (over: Partial<StatusInput>): StatusInput => ({ ui: 'ready', pendingApprovals: 0, ...over });

describe('statusModel', () => {
  it.each<[UiState, RegExp, string]>([
    ['untrusted', /shield/, 'normal'],
    ['checking', /sync~spin/, 'normal'],
    ['cliMissing', /warning.*CLI not found/, 'warning'],
    ['tooOld', /warning.*update needed/, 'warning'],
    ['notSignedIn', /account.*sign in/, 'warning'],
    ['error', /error.*Kiro: error/, 'error'],
  ])('shows the setup state %s', (ui, text, severity) => {
    const model = statusModel(input({ ui }));
    expect(model.text).toMatch(text);
    expect(model.severity).toBe(severity);
    expect(model.command).toBe('kiroStudio.showQuickMenu');
  });

  it('puts questions from Kiro above everything else and points the click at them', () => {
    const model = statusModel(input({ ui: 'cliMissing', pendingApprovals: 2 }));
    expect(model).toMatchObject({
      text: '$(bell) Kiro: 2 waiting for you',
      severity: 'warning',
      command: 'kiroStudio.answerPending',
    });
  });

  it('shows the connection phases once the setup is ready', () => {
    expect(statusModel(input({})).text).toBe('$(comment-discussion) Kiro');
    expect(statusModel(input({ agent: { phase: 'stopped' } })).text).toBe('$(comment-discussion) Kiro');
    expect(statusModel(input({ agent: { phase: 'starting' } })).text).toBe('$(sync~spin) Kiro: connecting…');
    expect(statusModel(input({ agent: { phase: 'reconnecting', attempt: 3 } })).text).toBe(
      '$(sync~spin) Kiro: reconnecting (3)',
    );
    expect(statusModel(input({ agent: { phase: 'failed' } }))).toMatchObject({
      text: '$(error) Kiro: connection failed',
      severity: 'error',
    });
    expect(statusModel(input({ agent: { phase: 'ready' } })).text).toBe('$(check) Kiro');
  });

  it('shows mode, model and context of the active session and what it is doing', () => {
    const s = session();
    const parsed = parseSessionNotification(update(SESSION_ID, u.contextUsage(9.4)));
    if (parsed) s.apply(parsed.event);
    expect(statusModel(input({ agent: { phase: 'ready' }, session: s })).text).toBe(
      '$(check) Kiro · Default · Claude Sonnet 4.5 · 9%',
    );
    s.beginTurn('hi');
    expect(statusModel(input({ agent: { phase: 'ready' }, session: s })).text).toMatch(/^\$\(sync~spin\)/);
    const tooltip = statusModel(input({ agent: { phase: 'ready' }, session: s })).tooltip;
    expect(tooltip).toContain('Supervised');
    expect(tooltip).toContain('Context used: 9%');
  });

  it('says Autopilot in the tooltip when the session runs on it', () => {
    expect(statusModel(input({ agent: { phase: 'ready' }, session: session({ autopilot: 'on' }) })).tooltip).toContain(
      'Autopilot',
    );
  });

  it('leaves out what is not known yet', () => {
    expect(statusModel(input({ agent: { phase: 'ready' }, session: session({ model: false }) })).text).toBe(
      '$(check) Kiro · Default',
    );
  });

  it('translates through the given function', () => {
    const shout = (message: string) => message.toUpperCase();
    expect(statusModel(input({ ui: 'cliMissing' }), shout).text).toContain('KIRO: CLI NOT FOUND');
  });
});

describe('what a screen reader says for the status bar', () => {
  it('drops the icons from the text', () => {
    expect(plainText('$(sync~spin) Kiro')).toBe('Kiro');
    expect(plainText('$(warning) Kiro: 2 questions')).toBe('Kiro: 2 questions');
    expect(plainText('Kiro')).toBe('Kiro');
  });

  it('reads the text and then the tooltip as one sentence', () => {
    expect(spokenStatus({ text: '$(sync~spin) Kiro', tooltip: 'Checking the Kiro CLI…' })).toBe(
      'Kiro. Checking the Kiro CLI…',
    );
    expect(spokenStatus({ text: 'Kiro', tooltip: 'One\nTwo' })).toBe('Kiro. One. Two');
    expect(spokenStatus({ text: '$(check) Kiro', tooltip: '' })).toBe('Kiro');
  });
});

describe('currentAutonomy', () => {
  it('is the one of the session on show, which the toolbar shows, even when the setting says otherwise', () => {
    // Setting Supervised, a session from the list in Autopilot: "switch" must go to Supervised, not to Autopilot.
    expect(currentAutonomy(session({ autopilot: 'on' }), 'supervised')).toBe('autopilot');
    expect(currentAutonomy(session({ autopilot: 'off' }), 'autopilot')).toBe('supervised');
  });

  it('is the setting without a session, or for one that is not connected or has no such option', () => {
    expect(currentAutonomy(undefined, 'autopilot')).toBe('autopilot');
    const lost = session({ autopilot: 'on' });
    lost.markLost('gone');
    expect(currentAutonomy(lost, 'supervised')).toBe('supervised');
    expect(currentAutonomy(new Session(SESSION_ID), 'supervised')).toBe('supervised');
  });
});

describe('optionLabel', () => {
  it('uses the display name of the current value, falling back to the value', () => {
    const s = session();
    expect(optionLabel(s, 'mode')).toBe('Default');
    expect(optionLabel(s, 'model')).toBe('Claude Sonnet 4.5');
    expect(optionLabel(s, 'nope')).toBeUndefined();
  });
});

describe('statusTree', () => {
  it('lists CLI, account, connection and autonomy', () => {
    const nodes = statusTree({
      cli: { path: '/usr/bin/kiro-cli', version: '2.33.1' },
      account: { provider: 'Google', email: 'me@example.com', raw: {} },
      agent: { phase: 'ready' },
      autonomySetting: 'supervised',
      sessions: [],
    });
    expect(nodes.map((n) => [n.id, n.description])).toEqual([
      ['cli', '2.33.1'],
      ['account', 'Google · me@example.com'],
      ['connection', 'Connected'],
      ['autonomy', 'Supervised'],
    ]);
    expect(nodes[0]?.tooltip).toBe('/usr/bin/kiro-cli');
  });

  it('describes a session with its details', () => {
    const s = session();
    const parsed = parseSessionNotification(update(SESSION_ID, u.turnCompletion(0.1)));
    if (parsed) s.apply(parsed.event);
    const nodes = statusTree({
      agent: { phase: 'ready' },
      autonomySetting: 'autopilot',
      sessions: [s],
      activeSessionId: SESSION_ID,
      locale: 'en',
    });
    const sessions = nodes.find((n) => n.id === 'sessions');
    expect(sessions?.description).toBe('1');
    const node = sessions?.children?.[0];
    expect(node).toMatchObject({ id: SESSION_ID, label: 'New Session', description: 'active · idle', icon: 'comment' });
    expect(node?.children?.map((c) => [c.label, c.description])).toEqual([
      ['Agent', 'Default'],
      ['Model', 'Claude Sonnet 4.5'],
      ['Last turn', '0.10 credits'],
    ]);
    expect(nodes.find((n) => n.id === 'autonomy')).toMatchObject({ description: 'Autopilot', icon: 'rocket' });

    const german = statusTree({ autonomySetting: 'autopilot', sessions: [s], locale: 'de' });
    const credits = german.find((n) => n.id === 'sessions')?.children?.[0]?.children?.at(-1);
    expect(credits?.description).toBe('0,10 credits');
  });

  it('formats credits in the language of the window, and survives a tag it does not know', () => {
    expect(formatCredits(0.4217, 'en')).toBe('0.42');
    expect(formatCredits(0.4217, 'de')).toBe('0,42');
    expect(formatCredits(12, 'de')).toBe('12,00');
    expect(() => formatCredits(1, 'not a language tag')).not.toThrow();
  });

  it('marks a lost session and a failed connection', () => {
    const s = session();
    s.markLost('gone');
    const nodes = statusTree({
      agent: { phase: 'reconnecting', attempt: 2 },
      autonomySetting: 'supervised',
      sessions: [s],
    });
    expect(nodes.find((n) => n.id === 'connection')?.description).toBe('Reconnecting (2)');
    expect(nodes.find((n) => n.id === 'sessions')?.children?.[0]).toMatchObject({
      icon: 'warning',
      description: 'lost',
    });
  });

  it('shows "not started" without an agent', () => {
    const nodes = statusTree({ autonomySetting: 'supervised', sessions: [] });
    expect(nodes.find((n) => n.id === 'connection')).toMatchObject({
      description: 'Not started',
      icon: 'circle-outline',
    });
  });
});
