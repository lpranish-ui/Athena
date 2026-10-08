// Start the local API + Expo web without changing .env or using hosted credentials.
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const apiPort = Number(process.env.ATHENA_LOCAL_API_PORT || 8787);
const webPort = Number(process.env.ATHENA_LOCAL_WEB_PORT || 8081);
if (![apiPort, webPort].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) || apiPort === webPort) {
  throw new Error('Choose distinct local ports between 1024 and 65535.');
}
const database = spawnSync('docker', ['compose', 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (database.error || database.status !== 0) { console.error('Start Docker Desktop, then run npm run local again.'); process.exit(1); }
const apiEnv = { ...process.env, NODE_ENV: 'development', PORT: String(apiPort),
  DATABASE_URL: 'postgresql://athena:athena-local-development@127.0.0.1:5434/athena',
  JWT_SECRET: crypto.randomBytes(48).toString('hex'), DEEPSEEK_API_KEY: '', RESEND_API_KEY: '', AUTH_EMAIL_FROM: '', AUTH_PUBLIC_URL: '' };
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
function run(args, env) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', () => stop(1));
  child.on('exit', (code) => { if (!stopping) stop(code || 0); });
  return child;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
run(['--watch', 'server/src/index.js'], apiEnv);
(async () => {
  let ready = false;
  for (let attempt = 0; attempt < 45 && !stopping; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready || stopping) { console.error('Local API could not start.'); stop(1); return; }
  console.log(`Local Athena: http://localhost:${webPort} — local data; AI generation and account emails disabled.`);
  run([path.join(root, 'node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', String(webPort), '--clear'], {
    ...process.env, EXPO_NO_DOTENV: '1', EXPO_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
  });
})().catch(() => stop(1));
