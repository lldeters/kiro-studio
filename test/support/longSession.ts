/** A long conversation for performance checks: every turn has a question, thoughts, an answer with code and two tools. */
import { Session } from '../../src/acp/sessions';
import { parseSessionNotification } from '../../src/acp/types';
import { configOptions, u, update } from './kiro';

const ANSWER = (n: number): string =>
  `Turn ${n}: the parser now returns an empty list for blank lines.\n\n` +
  '1. `parseLine` handles blank input\n2. The caller drops the `undefined` check\n\n' +
  '```ts\nexport function parseLine(line: string): Token[] {\n  if (line.trim() === "") return [];\n  return tokenize(line);\n}\n```\n\n' +
  '| File | Change |\n| --- | --- |\n| `src/parser.ts` | blank lines |\n';

export function longSession(turns: number, id = 'sess_long'): Session {
  const session = new Session(id, { cwd: '/ws' });
  session.applySessionResult({ sessionId: id, configOptions: configOptions({ autopilot: 'off', model: 'auto' }) });
  session.title = 'A long session';
  const feed = (...bodies: Record<string, unknown>[]): void => {
    for (const body of bodies) {
      const parsed = parseSessionNotification(update(id, body));
      if (parsed) session.apply(parsed.event);
    }
  };
  for (let n = 1; n <= turns; n++) {
    session.beginTurn(`Question ${n}: why does the parser fail on blank lines?`);
    feed(
      u.thought(`Looking at the parser for turn ${n}.`),
      u.toolCall(`r${n}`, {
        title: 'Read File',
        kind: 'read',
        status: 'completed',
        rawInput: { path: '/ws/src/parser.ts' },
        locations: [{ path: '/ws/src/parser.ts' }],
      }),
      u.toolCall(`w${n}`, {
        title: 'Write File',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: '/ws/src/parser.ts' }],
        content: [
          {
            type: 'diff',
            path: '/ws/src/parser.ts',
            oldText: 'export function parseLine(line: string) {\n  return tokenize(line);\n}\n',
            newText: `export function parseLine(line: string): Token[] {\n  // turn ${n}\n  return tokenize(line);\n}\n`,
          },
        ],
      }),
      u.agent(ANSWER(n), { messageId: `a${n}` }),
    );
  }
  return session;
}
