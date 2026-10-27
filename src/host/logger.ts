/** The "Kiro Studio: Protocol" output channel and the protocol log that feeds it. */
import * as vscode from 'vscode';
import { ProtocolLog } from '../util/log';
import { createRedactor, type Redactor } from '../util/redact';
import * as os from 'node:os';
import type { Settings } from './settings';

export interface ProtocolChannel extends vscode.Disposable {
  log: ProtocolLog;
  channel: vscode.OutputChannel;
  /** The log's redactor, also for what Kiro wrote that the chat shows outside the transcript. */
  redactor: Redactor;
}

/** `literals` are values that must never be shown: the keys the user entered for MCP servers. */
export function createProtocolChannel(settings: Settings, literals?: () => readonly string[]): ProtocolChannel {
  const channel = vscode.window.createOutputChannel('Kiro Studio: Protocol');
  const redactor = createRedactor(os.homedir(), literals);
  const log = new ProtocolLog(channel, () => settings.loggingLevel(), redactor);
  return { log, channel, redactor, dispose: () => channel.dispose() };
}
