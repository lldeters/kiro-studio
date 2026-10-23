import { describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BASE64_CHARS,
  WEBVIEW_COMMANDS,
  parseWebviewMessage,
} from '../../src/shared/chatProtocol';

describe('messages from the webview', () => {
  it('accepts every well-formed message', () => {
    const messages = [
      { type: 'ready' },
      { type: 'newSession' },
      { type: 'selectSession', id: 's1' },
      { type: 'closeSession', id: 's1' },
      { type: 'send', sessionId: 's1', text: 'hi', attachments: [] },
      { type: 'cancel', sessionId: 's1' },
      { type: 'answer', sessionId: 's1', approvalId: 3, kind: 'allow_once' },
      { type: 'setConfig', sessionId: 's1', configId: 'model', value: 'auto' },
      { type: 'openFile', path: 'a.ts' },
      { type: 'openFile', path: 'a.ts', line: 4 },
      { type: 'openLink', url: 'https://example.com' },
      { type: 'copy', text: 'x' },
      { type: 'compact', sessionId: 's1' },
      { type: 'pickContext', kind: 'steering' },
      { type: 'command', command: 'kiroStudio.restart' },
    ];
    for (const message of messages) expect(parseWebviewMessage(message)).toEqual(message);
  });

  it('treats a send without attachments as one with none', () => {
    expect(parseWebviewMessage({ type: 'send', sessionId: 's1', text: 'hi' })).toEqual({
      type: 'send',
      sessionId: 's1',
      text: 'hi',
      attachments: [],
    });
  });

  it.each([
    undefined,
    null,
    'ready',
    42,
    [],
    {},
    { type: 7 },
    { type: 'unknown' },
    { type: 'selectSession' },
    { type: 'send', sessionId: 's1' },
    { type: 'send', text: 'hi' },
    { type: 'answer', sessionId: 's1', approvalId: '3', kind: 'allow_once' },
    { type: 'answer', sessionId: 's1', approvalId: 3, kind: 'allow_forever' },
    { type: 'setConfig', sessionId: 's1', configId: 'model' },
    { type: 'pickContext', kind: 'everything' },
    { type: 'command', command: 'workbench.action.terminal.new' },
    { type: 'command', command: 'kiroStudio.debug.sendPrompt' },
    { type: 'copy', text: 'x'.repeat(1_000_001) },
  ])('rejects %j', (message) => {
    expect(parseWebviewMessage(message)).toBeUndefined();
  });

  it('only lets the webview run the whitelisted commands', () => {
    for (const command of WEBVIEW_COMMANDS) expect(parseWebviewMessage({ type: 'command', command })).toBeDefined();
    expect(WEBVIEW_COMMANDS).not.toContain('workbench.action.terminal.new');
  });
});

describe('attachments', () => {
  const send = (attachments: unknown) => parseWebviewMessage({ type: 'send', sessionId: 's1', text: 't', attachments });
  const image = { kind: 'image', mimeType: 'image/png', data: 'AAAA', name: 'a.png' };

  it('accepts files, folders, problems, the git diff and images', () => {
    const attachments = [
      { kind: 'file', path: 'a.ts' },
      { kind: 'folder', path: 'src' },
      { kind: 'problems' },
      { kind: 'gitDiff' },
      image,
    ];
    expect(send(attachments)).toMatchObject({ attachments });
  });

  it('drops extra properties instead of passing them on', () => {
    expect(send([{ kind: 'file', path: 'a.ts', evil: true }])).toMatchObject({
      attachments: [{ kind: 'file', path: 'a.ts' }],
    });
    const parsed = send([{ kind: 'file', path: 'a.ts', evil: true }]);
    expect(parsed && 'attachments' in parsed && parsed.attachments[0]).not.toHaveProperty('evil');
  });

  it.each([
    'not a list',
    [null],
    [{ kind: 'file' }],
    [{ kind: 'file', path: '' }],
    [{ kind: 'secrets' }],
    [{ ...image, mimeType: 'image/svg+xml' }],
    [{ ...image, mimeType: 'text/html' }],
    [{ ...image, data: 42 }],
    [{ ...image, data: 'x'.repeat(MAX_IMAGE_BASE64_CHARS + 1) }],
    [{ ...image, name: undefined }],
  ])('rejects %j', (attachments) => {
    expect(send(attachments)).toBeUndefined();
  });

  it('rejects more attachments than the limit', () => {
    expect(send(Array.from({ length: MAX_ATTACHMENTS }, () => ({ kind: 'problems' })))).toBeDefined();
    expect(send(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ kind: 'problems' })))).toBeUndefined();
  });
});
