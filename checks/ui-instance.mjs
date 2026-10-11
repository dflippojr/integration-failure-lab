import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const data = join(root, '.ui-testing');
const handle = join(data, 'instance.json');
const origin = 'http://127.0.0.1:4193';
const command = process.argv[2];
if (!['start', 'serve', 'stop'].includes(command) || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/ui-instance.mjs start|serve|stop (no endpoints or credentials accepted)');
}
for (const [key, value] of Object.entries(process.env)) {
  if (/^UI_TESTING_/.test(key) && !(key === 'UI_TESTING_SYNTHETIC' && value === 'true')) {
    throw new Error('Only UI_TESTING_SYNTHETIC=true is accepted; no credentials or endpoints');
  }
}
function clean() {
  if (!existsSync(data)) return;
  for (const name of readdirSync(data)) unlinkSync(join(data, name));
  rmdirSync(data);
}
async function ownInstance() {
  if (!existsSync(handle)) return null;
  const saved = JSON.parse(readFileSync(handle, 'utf8'));
  const response = await fetch(origin + '/__instance', { signal: AbortSignal.timeout(1000) });
  const live = await response.json();
  if (live.id !== saved.id || live.pid !== saved.pid) throw new Error('Instance ownership mismatch; refusing to stop');
  return live;
}
if (command === 'stop') {
  if (existsSync(handle)) {
    let owned;
    try { owned = await ownInstance(); } catch (error) {
      const saved = JSON.parse(readFileSync(handle, 'utf8'));
      try { process.kill(saved.pid, 0); } catch (probe) {
        if (probe.code === 'ESRCH') { clean(); process.exit(0); }
      }
      throw error;
    }
    await fetch(origin + '/__stop', { method: 'POST', headers: { 'X-Instance': owned.id } });
    for (let i = 0; i < 100 && existsSync(data); i++) await new Promise(r => setTimeout(r, 50));
    if (existsSync(data)) throw new Error('Teardown did not finish');
  }
  console.log('UI instance stopped; disposable data absent');
} else if (command === 'start') {
  if (existsSync(data)) throw new Error('Disposable directory exists; run stop first');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true, windowsHide: true, stdio: 'ignore', cwd: root,
    env: { ...process.env, UI_TESTING_SYNTHETIC: 'true' }
  });
  child.unref();
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const live = await ownInstance(); if (live?.pid === child.pid) { ready = true; break; } } catch { /* wait for owned readiness */ }
    await new Promise(r => setTimeout(r, 50));
  }
  if (!ready) { try { child.kill(); } catch { /* child already exited */ } throw new Error('Disposable startup failed (port occupied or build missing); no existing server reused'); }
  console.log('UI_TESTING_URL=' + origin);
} else {
  if (existsSync(data)) throw new Error('Disposable directory exists; refusing reuse');
  const id = randomUUID();
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
  let created = false;
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; object-src 'none'");
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/__instance') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id, pid: process.pid, synthetic: true })); return; }
    if (req.url === '/__stop' && req.method === 'POST' && req.headers['x-instance'] === id) { res.end('stopping'); server.close(() => { clean(); process.exit(0); }); return; }
    const name = req.url === '/' ? 'index.html' : req.url?.slice(1);
    if (!['index.html','lab.js','lab.css','engine.js','scenarios.js','executed.js','host.css'].includes(name)) { res.writeHead(404); res.end('Not found'); return; }
    res.setHeader('Content-Type', types[name.slice(name.lastIndexOf('.'))]);
    res.end(readFileSync(join(data, name)));
  });
  const shutdown = () => server.close(() => { if (created) clean(); process.exit(0); });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.on('error', error => { if (created) clean(); console.error(error.message); process.exit(1); });
  // Bind first: an occupied port can never be mistaken for our instance.
  server.listen(4193, '127.0.0.1', () => {
    try {
      mkdirSync(data); created = true;
      for (const name of ['index.html','lab.js','lab.css','engine.js','scenarios.js','executed.js']) copyFileSync(join(root, 'dist', name), join(data, name));
      // A host may supply theme tokens; exercise that public embedding interface without editing the app.
      const host = ':root { color-scheme: light; } @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --paper:#18251f; --ink:#e5ece6; --green:#93cba4; --muted:#b1bdb3; --line:#46564a; --panel:#213128; --panel-2:#293c30; --warn:#e5c283; --bad:#f29f90; } body { background:var(--paper); color:var(--ink); } }';
      writeFileSync(join(data, 'host.css'), host);
      const html = readFileSync(join(data,'index.html'),'utf8').replace('</head>', '<link rel="stylesheet" href="host.css"></head>');
      writeFileSync(join(data,'index.html'), html);
      writeFileSync(handle, JSON.stringify({ id, pid: process.pid, origin }));
      console.log('UI_TESTING_URL=' + origin);
    } catch (error) { console.error(error.message); shutdown(); process.exitCode = 1; }
  });
}
