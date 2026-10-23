/**
 * Every message the chat webview shows. The host translates them (`vscode.l10n.t`) and sends the translations with
 * the `init` message; the webview looks a message up by its English text and falls back to it. `{0}` is replaced by
 * the first argument, `{1}` by the second.
 *
 * Add a message here before using it in `webview-ui`; a unit test checks that nothing is missing.
 */
export const UI_MESSAGES = [
  // Header and tabs
  'New session',
  'Close session',
  'The connection to this session was lost.',
  // Setup and connection states
  'Kiro Studio does not run in untrusted workspaces.',
  'Trust this workspace',
  'Checking the Kiro CLI…',
  'The Kiro CLI was not found.',
  'Set the Kiro CLI path…',
  'Open the install guide',
  'The Kiro CLI is too old. Run "kiro-cli update" in a terminal, then check again.',
  'Check again',
  'You are not signed in to Kiro.',
  'Sign in',
  'The Kiro CLI could not be checked.',
  'Show the protocol log',
  'Connecting to Kiro… the first start can take a while.',
  'The connection to Kiro was lost. Trying to reconnect ({0}).',
  'The Kiro CLI keeps stopping.',
  'Restart the connection',
  'No session yet.',
  'Start a session to talk to Kiro.',
  // Transcript
  'You',
  'Kiro',
  'Thinking',
  // Composer
  'Ask Kiro…',
  'Send',
  'Stop',
  'Enter sends, Shift+Enter adds a line, Esc stops.',
  'Stopping…',
  'Waiting for your answer',
] as const;

export type UiMessage = (typeof UI_MESSAGES)[number];
