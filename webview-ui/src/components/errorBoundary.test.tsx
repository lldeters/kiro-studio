// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState } from '../state';
import { useChat } from '../store';
import { outbox } from '../vscode';
import { ErrorBoundary } from './ErrorBoundary';

let broken = true;
function Fragile() {
  if (broken) throw new Error('lost a part');
  return <p>The chat</p>;
}

beforeEach(() => {
  useChat.setState({ ...initialState });
  outbox.length = 0;
  broken = true;
  // React reports a caught error on the console as well; it is expected here.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('says what went wrong instead of an empty chat, logs it, and shows the chat again', () => {
    render(
      <ErrorBoundary>
        <Fragile />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('The chat ran into an error: lost a part');
    expect(outbox).toEqual([{ type: 'error', message: expect.stringContaining('lost a part') as string }]);

    fireEvent.click(screen.getByRole('button', { name: 'Show the protocol log' }));
    expect(outbox.at(-1)).toEqual({ type: 'command', command: 'kiroStudio.showProtocolLog' });

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Show the chat again' }));
    expect(screen.getByText('The chat')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
