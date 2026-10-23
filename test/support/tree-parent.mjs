/* global process, setInterval */
// A stand-in for kiro-cli: starts a child (the "agent server") that ignores SIGTERM, then idles.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  stdio: 'ignore',
});
process.stdout.write(JSON.stringify({ child: child.pid }) + '\n');
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
