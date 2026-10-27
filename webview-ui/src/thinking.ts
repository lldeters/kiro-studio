import type { SessionView } from '../../src/shared/chatProtocol';

/**
 * Whether Kiro works on a turn without showing anything for it: nothing has come since the prompt, or a tool has
 * finished and the next step has not begun. Text that streams, a tool that runs and a question to answer show
 * themselves, so then this is false.
 */
export function waitingForOutput(session: SessionView): boolean {
  if (session.phase !== 'starting' && session.phase !== 'running') return false;
  const last = session.items[session.items.length - 1];
  if (last === undefined) return true;
  switch (last.kind) {
    // After `usage` Kiro has reported what the turn cost; it is about to end.
    case 'assistant':
    case 'thought':
    case 'usage':
      return false;
    case 'tool': {
      const state = session.tools.find((tool) => tool.toolCallId === last.toolCallId)?.state;
      return state === 'done' || state === 'failed';
    }
    default:
      return true;
  }
}
