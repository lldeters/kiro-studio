// A stand-in for kiro-cli for the integration tests. Behaviour is chosen with FAKE_KIRO_SCENARIO:
//   ready (default)  signed in, V3 available
//   signedout        `whoami` fails
//   old              `acp --help` has no --agent-engine
// `acp` speaks just enough ACP for a session to start and a prompt to be answered.
'use strict';

const path = require('node:path');

const scenario = process.env.FAKE_KIRO_SCENARIO || 'ready';
const args = process.argv.slice(2);

function out(text) {
  process.stdout.write(text + '\n');
}

if (args[0] === '--version') {
  out('kiro-cli 2.33.1');
} else if (args[0] === 'whoami') {
  if (scenario === 'signedout') {
    process.stderr.write('Not logged in\n');
    process.exitCode = 1;
  } else {
    out(JSON.stringify({ accountType: 'Google', provider: 'Google', email: 'tester@example.com' }));
  }
} else if (args[0] === 'acp' && args.includes('--help')) {
  out(
    scenario === 'old'
      ? 'Options:\n  --agent <AGENT>'
      : 'Options:\n  --agent-engine <ENGINE>\n   [possible values: v2, v1, v3]',
  );
} else if (args[0] === 'acp') {
  serve();
} else {
  process.stderr.write('unsupported: ' + args.join(' ') + '\n');
  process.exitCode = 2;
}

function serve() {
  let buffer = '';
  const send = (message) => out(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const configOptions = [
    {
      id: 'autopilot',
      name: 'Autopilot',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Supervised' },
        { value: 'on', name: 'Autopilot' },
      ],
    },
  ];

  let cwd = process.cwd();
  let nextId = 1000;
  const waiting = new Map();
  /** Asks the client (the extension) for something and waits for its answer. */
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });

  const handle = (message) => {
    const { id, method, params } = message;
    if (method === undefined && waiting.has(id)) {
      waiting.get(id)(message);
      waiting.delete(id);
      return undefined;
    }
    switch (method) {
      case 'initialize':
        return send({
          id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true },
              sessionCapabilities: { list: {} },
            },
            agentInfo: { name: 'Kiro CLI', version: '2.33.1' },
          },
        });
      case 'session/new':
        if (params && typeof params.cwd === 'string') cwd = params.cwd;
        return send({ id, result: { sessionId: 'fake-session-1', configOptions } });
      case 'session/list':
        return send({
          id,
          result: {
            sessions: [
              {
                sessionId: 'fake-session-1',
                cwd,
                title: 'Fake session',
                updatedAt: new Date().toISOString(),
                _meta: { kiro: { agentMode: 'vibe', source: 'local', status: 'idle' } },
              },
              {
                sessionId: 'older-session',
                cwd,
                title: 'An older session',
                updatedAt: '2026-01-01T00:00:00.000Z',
                _meta: { kiro: { agentMode: 'vibe', source: 'local', status: 'idle' } },
              },
            ],
          },
        });
      case 'session/load':
        return send({ id, result: { configOptions } });
      case 'session/prompt': {
        const sessionId = params.sessionId;
        const text = (params.prompt || []).map((block) => block.text || '').join('');
        // "WRITE <file> <content>" makes the agent write a file through the client, as Kiro does.
        const write = /^WRITE (\S+) (.*)$/.exec(text);
        if (write) {
          const target = path.join(cwd, write[1]);
          ask('fs/write_text_file', { sessionId, path: target, content: write[2] + '\n' }).then(() =>
            send({ id, result: { stopReason: 'end_turn' } }),
          );
          return undefined;
        }
        send({
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello from the fake agent.' },
            },
          },
        });
        return send({ id, result: { stopReason: 'end_turn' } });
      }
      case 'session/set_config_option':
        return send({ id, result: { configOptions } });
      case 'session/cancel':
        return undefined;
      default:
        if (id !== undefined) send({ id, error: { code: -32601, message: 'Method not found: ' + method } });
        return undefined;
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handle(JSON.parse(line));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
