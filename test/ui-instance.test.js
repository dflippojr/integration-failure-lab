import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../checks/ui-instance.mjs', import.meta.url));
const handle = fileURLToPath(new URL('../.ui-testing/instance.json', import.meta.url));
const invoke = (args, env = process.env) => execFileSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });

// Real subprocess checks exercise the safety boundary rather than mirroring the
// implementation: rejected configuration must not create an instance.
test('disposable UI rejects endpoints and credential configuration before startup', () => {
  assert.throws(() => invoke(['start', 'https://example.invalid']), /no endpoints or credentials accepted/);
  assert.throws(() => invoke(['start'], { ...process.env, UI_TESTING_TOKEN: 'synthetic-for-rejection' }), /no credentials or endpoints/);
});

test('disposable UI verifies ownership, refuses reuse, and tears down idempotently', async t => {
  assert.equal(existsSync(handle), false, 'run ui:stop before the Node suite');
  t.after(() => invoke(['stop']));
  assert.ok(invoke(['start']).includes('UI_TESTING_URL=http://127.0.0.1:4193'));
  const saved = readFileSync(handle, 'utf8');
  const live = await (await fetch('http://127.0.0.1:4193/__instance')).json();
  assert.equal(live.synthetic, true);
  assert.equal(live.id, JSON.parse(saved).id);
  assert.throws(() => invoke(['start']), /Disposable directory exists/);
  assert.equal((await fetch('http://127.0.0.1:4193/')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:4193/scenarios.js')).status, 200);
  assert.equal((await fetch('http://127.0.0.1:4193/not-an-asset')).status, 404);
  // A tampered/stale handle must never stop a process with different ownership.
  writeFileSync(handle, JSON.stringify({ ...JSON.parse(saved), id: 'wrong-owner' }));
  try { assert.throws(() => invoke(['stop']), /Instance ownership mismatch/); }
  finally { writeFileSync(handle, saved); }
  assert.equal((await fetch('http://127.0.0.1:4193/__instance')).status, 200);
  assert.match(invoke(['stop']), /disposable data absent/);
  assert.equal(existsSync(handle), false);
  assert.match(invoke(['stop']), /disposable data absent/);
  await assert.rejects(fetch('http://127.0.0.1:4193/__instance'));
});

test('disposable startup refuses an occupied port without reusing or removing it', async t => {
  const unrelated = createServer((_req, res) => { res.writeHead(503); res.end('Not a UI instance'); });
  await new Promise((resolve, reject) => { unrelated.once('error', reject); unrelated.listen(4193, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  assert.throws(() => invoke(['start']), /Disposable startup failed/);
  assert.equal(existsSync(handle), false);
  assert.equal(unrelated.listening, true);
});
