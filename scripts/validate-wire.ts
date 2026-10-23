/**
 * Checks which messages of a probe run (`probe-logs/<run>/wire.ndjson`) the ACP SDK's own strict
 * schemas would reject. The SDK drops a rejected `session/update` silently, which is why Kiro Studio
 * diverts notifications around the SDK router (docs/ARCHITECTURE.md, docs/protocol-notes.md section 14).
 *
 *   npm run validate-wire -- probe-logs/<run>/wire.ndjson
 *
 * Exit code 1 if at least one agent message fails validation.
 */
import * as fs from 'node:fs';

interface Schema {
  safeParse(value: unknown): { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };
}
type SchemaModule = Record<string, Schema | undefined>;

// The package does not export its schema module; locate it relative to the public entry point.
const entry = import.meta.resolve('@agentclientprotocol/sdk');
const schemas = (await import(new URL('../schema/zod.gen.js', entry).href)) as SchemaModule;

const RESPONSE_SCHEMAS: Record<string, string> = {
  initialize: 'zInitializeResponse',
  'session/new': 'zNewSessionResponse',
  'session/load': 'zLoadSessionResponse',
  'session/prompt': 'zPromptResponse',
  'session/set_config_option': 'zSetSessionConfigOptionResponse',
  'session/close': 'zCloseSessionResponse',
};

interface WireEntry {
  dir?: string;
  msg?: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };
}

const file = process.argv[2];
if (!file) {
  process.stderr.write('Usage: npm run validate-wire -- <wire.ndjson>\n');
  process.exit(2);
}

const requestMethods = new Map<string | number, string>();
const tally = new Map<string, { ok: number; bad: number }>();
const failures: string[] = [];

const check = (label: string, schemaName: string, value: unknown, where: string) => {
  const schema = schemas[schemaName];
  if (!schema) return;
  const result = schema.safeParse(value);
  const entry = tally.get(label) ?? { ok: 0, bad: 0 };
  if (result.success) entry.ok++;
  else {
    entry.bad++;
    const issue = result.error?.issues[0];
    failures.push(`${where} ${label}: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid'}`);
  }
  tally.set(label, entry);
};

fs.readFileSync(file, 'utf8')
  .split('\n')
  .filter(Boolean)
  .forEach((line, index) => {
    const entry = JSON.parse(line) as WireEntry;
    const msg = entry.msg;
    if (!msg) return;
    const where = `line ${index + 1}`;
    if (entry.dir === 'client→agent' && msg.id !== undefined && msg.method) requestMethods.set(msg.id, msg.method);
    if (entry.dir !== 'agent→client') return;
    if (msg.method === 'session/update' && msg.id === undefined)
      check('session/update', 'zSessionNotification', msg.params, where);
    else if (msg.method === 'session/request_permission')
      check('session/request_permission', 'zRequestPermissionRequest', msg.params, where);
    else if (!msg.method && msg.id !== undefined && 'result' in msg) {
      const method = requestMethods.get(msg.id);
      const schemaName = method ? RESPONSE_SCHEMAS[method] : undefined;
      if (method && schemaName) check(`response ${method}`, schemaName, msg.result, where);
    }
  });

for (const [label, { ok, bad }] of tally)
  process.stdout.write(`${label.padEnd(36)} ok ${String(ok).padStart(4)}   rejected ${bad}\n`);
if (tally.size === 0) process.stdout.write('No validatable agent messages found.\n');
for (const failure of failures.slice(0, 20)) process.stdout.write(`REJECTED ${failure}\n`);
process.exit(failures.length > 0 ? 1 : 0);
