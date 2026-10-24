import { describe, expect, it } from 'vitest';
import { ApprovalQueue } from '../../src/view/approvalQueue';

const request = (id: number, sessionId = 's1') => ({ session: { id: sessionId }, approval: { id } });

function make(suppressed: string[] = []) {
  const shown: number[] = [];
  const queue = new ApprovalQueue(
    (sessionId) => suppressed.includes(sessionId),
    (entry: ReturnType<typeof request>) => shown.push(entry.approval.id),
  );
  return { queue, shown };
}

describe('ApprovalQueue', () => {
  it('shows one request at a time and the next as soon as the open one is answered', () => {
    const { queue, shown } = make();
    queue.add(request(1));
    queue.add(request(2));
    expect(shown).toEqual([1]);
    queue.settle(1);
    expect(shown).toEqual([1, 2]);
    expect(queue.open?.approval.id).toBe(2);
    queue.settle(2);
    expect(queue.size).toBe(0);
    expect(queue.open).toBeUndefined();
  });

  it('opens nothing by itself after the user closed the picker without an answer', () => {
    const { queue, shown } = make();
    queue.add(request(1));
    queue.add(request(2));
    queue.dismissed(1);
    expect(shown).toEqual([1]);
    expect(queue.size).toBe(2);
    // The status bar or the command brings it back.
    queue.next(true);
    expect(shown).toEqual([1, 1]);
  });

  it('skips the requests the chat asks itself, unless forced', () => {
    const { queue, shown } = make(['shown-in-chat']);
    queue.add(request(1, 'shown-in-chat'));
    expect(shown).toEqual([]);
    queue.add(request(2, 'other'));
    expect(shown).toEqual([2]);
    queue.settle(2);
    expect(shown).toEqual([2]);
    queue.next(true);
    expect(shown).toEqual([2, 1]);
  });

  it('keeps the open picker when another request is settled', () => {
    const { queue, shown } = make();
    queue.add(request(1));
    queue.add(request(2));
    queue.settle(2);
    expect(queue.open?.approval.id).toBe(1);
    expect(shown).toEqual([1]);
    expect(queue.oldest?.approval.id).toBe(1);
  });
});
