import { describe, expect, it } from 'vitest';
import { parseInitializeResult, hasExtension, looksLikeKiroV3 } from '../../src/acp/capabilities';
import { parseConfigOptions, parseSessionNotification } from '../../src/acp/types';
import { SESSION_ID, configOptions, initializeResult, u, update } from '../support/kiro';

const parse = (body: Record<string, unknown>) => parseSessionNotification(update(SESSION_ID, body));

describe('parseSessionNotification', () => {
  it('reads message chunks and their identity', () => {
    const parsed = parse(u.agent('Hello', { replayId: 'r-1-say' }));
    expect(parsed?.sessionId).toBe(SESSION_ID);
    expect(parsed?.event).toMatchObject({
      type: 'agent_message_chunk',
      text: 'Hello',
      meta: { replay: false, messageKey: 'r-1-say' },
    });
  });

  it('marks replayed frames and sub-agent frames', () => {
    const replayed = parse(u.user('Hi', { replay: true, messageId: 'm-1', timestamp: 'x' }));
    expect(replayed?.event.meta).toMatchObject({ replay: true, messageKey: 'm-1' });
    const sub = parse(u.agent('x', { agentSubtaskId: 'task-9' }));
    expect(sub?.event.meta.subtaskId).toBe('task-9');
  });

  it('reads a tool call with its preview and locations', () => {
    const event = parse(u.toolCall('t1'))?.event;
    expect(event).toMatchObject({
      type: 'tool_call',
      toolCallId: 't1',
      title: 'Write File',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: '/ws/hello.txt' }],
    });
    expect(event?.meta.kiro.preview).toEqual({ file: '/ws/hello.txt', modifiedContent: 'Hallo' });
  });

  it('keeps absent fields of a partial tool update absent', () => {
    const event = parse(u.toolUpdate('t1', { status: 'completed' }))?.event;
    expect(event).toEqual(expect.objectContaining({ type: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
    expect(event).not.toHaveProperty('content');
    expect(event).not.toHaveProperty('title');
    expect(event).not.toHaveProperty('locations');
  });

  it('reads diff, text and terminal content and keeps unknown content raw', () => {
    const event = parse(
      u.toolUpdate('t1', {
        content: [
          { type: 'diff', path: 'file:///c%3A/ws/a.txt', oldText: '', newText: 'new' },
          { type: 'diff', path: '/ws/b.txt', oldText: null, newText: 'x' },
          { type: 'content', content: { type: 'text', text: 'out' } },
          { type: 'terminal', terminalId: 'term-1' },
          { type: 'diff', path: '/ws/broken' },
          { type: 'hologram' },
        ],
      }),
    )?.event;
    if (event?.type !== 'tool_call_update') throw new Error('unexpected event');
    expect(event.content).toMatchObject([
      { type: 'diff', path: 'file:///c%3A/ws/a.txt', oldText: '', newText: 'new' },
      { type: 'diff', path: '/ws/b.txt', oldText: null, newText: 'x' },
      { type: 'content', text: 'out' },
      { type: 'terminal', terminalId: 'term-1' },
      { type: 'unknown' },
      { type: 'unknown' },
    ]);
  });

  it('turns unknown update types and broken payloads into unknown events without throwing', () => {
    expect(parse({ sessionUpdate: 'plan_update', something: 1 })?.event).toMatchObject({
      type: 'unknown',
      sessionUpdate: 'plan_update',
    });
    expect(parse({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } })?.event.type).toBe('unknown');
    expect(parse({ sessionUpdate: 'tool_call' })?.event.type).toBe('unknown');
    expect(parse({})?.event.type).toBe('unknown');
  });

  it('returns undefined only when the session id is missing', () => {
    expect(parseSessionNotification({ update: u.agent('x') })).toBeUndefined();
    for (const garbage of [null, undefined, 5, 'x', [], [1], {}])
      expect(() => parseSessionNotification(garbage)).not.toThrow();
  });

  it('reads plans, modes and commands', () => {
    expect(
      parse({ sessionUpdate: 'plan', entries: [{ content: 'Do it', status: 'pending', priority: 'high' }] })?.event,
    ).toMatchObject({
      type: 'plan',
      entries: [{ content: 'Do it', status: 'pending', priority: 'high' }],
    });
    expect(parse({ sessionUpdate: 'current_mode_update', currentModeId: 'spec' })?.event).toMatchObject({
      type: 'current_mode_update',
      modeId: 'spec',
    });
    expect(parse(u.commands('context-gatherer'))?.event).toMatchObject({
      type: 'available_commands_update',
      commands: [{ name: 'context-gatherer', hint: 'task to delegate', kiroType: 'custom-agent' }],
    });
  });

  it('reads the Kiro info kinds', () => {
    expect(parse(u.contextUsage(9.4))?.event).toMatchObject({
      info: { kind: 'context_usage', usagePercentage: 9.4, summarizationThreshold: 80 },
    });
    expect(parse(u.turnCompletion(0.1))?.event).toMatchObject({
      info: { kind: 'turn_completion', credits: 0.1, elapsedMs: 4106, usedTools: ['fs_write'], status: 'success' },
    });
    expect(parse(u.turnEnd('cancelled'))?.event).toMatchObject({ info: { kind: 'turn_end', stopReason: 'cancelled' } });
    expect(parse(u.pending('t1'))?.event).toMatchObject({
      info: {
        kind: 'pending_interaction',
        toolCallId: 't1',
        options: [
          { optionId: 'accept', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    });
    expect(parse(u.resolved('t1'))?.event).toMatchObject({
      info: { kind: 'interaction_resolved', selectedOption: 'accept' },
    });
    expect(parse(u.displayError('model gone'))?.event).toMatchObject({
      info: { kind: 'display_error', message: 'model gone' },
    });
    expect(parse(u.title('Fix the build'))?.event).toMatchObject({
      title: 'Fix the build',
      info: { kind: 'focus_update', title: 'Fix the build' },
    });
    expect(
      parse({ sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'brand_new_kind', x: 1 } } })?.event,
    ).toMatchObject({
      info: { kind: 'other', name: 'brand_new_kind' },
    });
  });

  it('reads a pending interaction that only has the flat form', () => {
    const event = parse({
      sessionUpdate: 'session_info_update',
      _meta: {
        kiro: {
          kind: 'pending_interaction',
          toolCallId: 't9',
          options: [{ optionId: 'accept', name: 'Allow', kind: 'allow_once' }],
        },
      },
    })?.event;
    expect(event).toMatchObject({
      info: { kind: 'pending_interaction', toolCallId: 't9', options: [{ optionId: 'accept' }] },
    });
  });

  it('reads context usage that only has the nested form', () => {
    const event = parse({
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'context_usage', contextUsage: { usagePercentage: 1.75, summarizationThreshold: 80 } } },
    })?.event;
    expect(event).toMatchObject({ info: { usagePercentage: 1.75 } });
  });
});

describe('parseConfigOptions', () => {
  it('reads select options with their values and Kiro metadata', () => {
    const options = parseConfigOptions(configOptions({ model: 'auto', effort: 'high' }));
    expect(options.map((o) => o.id)).toEqual(['mode', 'model', 'effortLevel', 'memoryReflection', 'autopilot']);
    const model = options.find((o) => o.id === 'model');
    expect(model).toMatchObject({ category: 'model', currentValue: 'auto' });
    expect(model?.values.find((v) => v.value === 'claude-opus-5.5')?.meta).toMatchObject({
      hasEffort: true,
      effortLevels: ['low', 'medium', 'high'],
    });
    expect(options.find((o) => o.id === 'autopilot')).toMatchObject({
      currentValue: 'on',
      values: [{ value: 'on' }, { value: 'off' }],
    });
  });

  it('skips entries without an id and values without a value', () => {
    expect(
      parseConfigOptions([{ name: 'x' }, { id: 'a', options: [{ name: 'no value' }, { value: 'v' }] }, 5, null]),
    ).toEqual([expect.objectContaining({ id: 'a', values: [expect.objectContaining({ value: 'v', name: 'v' })] })]);
    expect(parseConfigOptions('nope')).toEqual([]);
  });
});

describe('parseInitializeResult', () => {
  it('reads what Kiro 2.33.1 advertised', () => {
    const caps = parseInitializeResult(initializeResult());
    expect(caps).toMatchObject({
      protocolVersion: 1,
      loadSession: true,
      prompt: { image: true, audio: false, embeddedContext: true },
      mcp: { http: true, sse: true },
      session: { list: true, close: true, delete: true, fork: true, forkAtMessage: true, resume: false },
      kiro: {
        checkpoints: true,
        replayMarking: true,
        sessionListScopes: ['workspace', 'user'],
        autoCompactionThreshold: { min: 0, max: 80, default: 80 },
      },
      authMethods: [{ id: 'aws-builder-id', name: 'AWS Builder ID' }],
    });
    expect(caps.kiro.logDir).toBe('/home/me/.kiro/logs/20261023T155659765');
    expect(caps.kiro.logChannels).toEqual([
      { name: 'kiro', filePath: '/home/me/.kiro/logs/20261023T155659765/kiro.log' },
    ]);
    expect(hasExtension(caps, '_kiro/session/context')).toBe(true);
    expect(hasExtension(caps, '_kiro/mcp/resetServer')).toBe(false);
    expect(looksLikeKiroV3(caps)).toBe(true);
  });

  it('treats a missing or odd result as "nothing offered" and never throws', () => {
    for (const garbage of [undefined, null, 7, 'x', [], {}, { agentCapabilities: 5 }]) {
      const caps = parseInitializeResult(garbage);
      expect(caps.loadSession).toBe(false);
      expect(caps.session.fork).toBe(false);
      expect(hasExtension(caps, '_kiro/session/context')).toBe(false);
      expect(looksLikeKiroV3(caps)).toBe(false);
    }
  });
});
