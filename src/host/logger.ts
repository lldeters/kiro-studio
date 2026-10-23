/** The "Kiro Studio: Protocol" output channel and the protocol log that feeds it. */
import * as vscode from 'vscode';
import { ProtocolLog } from '../util/log';
import { createRedactor } from '../util/redact';
import * as os from 'node:os';
import type { Settings } from './settings';

export interface ProtocolChannel extends vscode.Disposable {
  log: ProtocolLog;
  channel: vscode.OutputChannel;
}

export function createProtocolChannel(settings: Settings): ProtocolChannel {
  const channel = vscode.window.createOutputChannel('Kiro Studio: Protocol');
  const log = new ProtocolLog(channel, () => settings.loggingLevel(), createRedactor(os.homedir()));
  return { log, channel, dispose: () => channel.dispose() };
}
