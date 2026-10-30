import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../checks/ui-instance.mjs', import.meta.url));
const data = fileURLToPath(new URL('../.ui-testing/', import.meta.url));
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

test('stop cleans up a crashed instance whose saved PID is alive again', t => {
  assert.equal(existsSync(handle), false, 'run ui:stop before the Node suite');
  t.after(() => invoke(['stop']));
  // Nothing listens on 4193; this test's own live PID stands in for a reused one.
  mkdirSync(data);
  writeFileSync(handle, JSON.stringify({ id: 'stale', pid: process.pid, origin: 'http://127.0.0.1:4193' }));
  writeFileSync(fileURLToPath(new URL('../.ui-testing/index.html', import.meta.url)), 'stale asset');
  assert.match(invoke(['stop']), /disposable data absent/);
  assert.equal(existsSync(data), false);
  assert.ok(invoke(['start']).includes('UI_TESTING_URL=http://127.0.0.1:4193'));
  assert.match(invoke(['stop']), /disposable data absent/);
});

test('the usage message names the script by its real path', () => {
  assert.throws(() => invoke([]), /Usage: node checks\/ui-instance\.mjs start\|serve\|stop/);
});

// A serve killed between mkdir and writing instance.json leaves the directory with no handle.
const seedOrphan = names => {
  mkdirSync(data);
  for (const name of names) writeFileSync(join(data, name), 'orphaned by a killed serve');
};
const failedStop = () => {
  try { invoke(['stop']); } catch (error) { return error; }
  assert.fail('stop exited 0');
};

test('stop removes a handle-less directory of known disposable files when nothing listens', t => {
  assert.equal(existsSync(data), false, 'run ui:stop before the Node suite');
  t.after(() => invoke(['stop']));
  seedOrphan(['index.html', 'lab.js', 'host.css']);
  assert.match(invoke(['stop']), /disposable data absent/);
  assert.equal(existsSync(data), false);
  assert.ok(invoke(['start']).includes('UI_TESTING_URL=http://127.0.0.1:4193'));
  assert.match(invoke(['stop']), /disposable data absent/);
  assert.equal(existsSync(data), false);
});

test('stop leaves a handle-less directory holding an unknown file and fails naming it', t => {
  assert.equal(existsSync(data), false, 'run ui:stop before the Node suite');
  t.after(() => rmSync(data, { recursive: true, force: true }));
  seedOrphan(['lab.js', 'notes.txt']);
  const error = failedStop();
  assert.match(error.stderr, /notes\.txt/);
  assert.doesNotMatch(error.stdout, /disposable data absent/);
  assert.deepEqual(readdirSync(data).sort(), ['lab.js', 'notes.txt']);
});

test('stop removes nothing from a handle-less directory while something answers on the port', async t => {
  assert.equal(existsSync(data), false, 'run ui:stop before the Node suite');
  const unrelated = createServer((_req, res) => { res.writeHead(503); res.end('Not a UI instance'); });
  await new Promise((resolve, reject) => { unrelated.once('error', reject); unrelated.listen(4193, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  seedOrphan(['lab.js']);
  // execFileSync would block this event loop and starve the stand-in server, so run stop asynchronously.
  const result = await new Promise(resolve => execFile(process.execPath, [script, 'stop'], { cwd: root, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ownership/);
  assert.doesNotMatch(result.stdout, /disposable data absent/);
  assert.deepEqual(readdirSync(data), ['lab.js']);
  assert.equal(unrelated.listening, true);
});

// A temp copy of the repo layout lets serve fail or refuse without touching the real .ui-testing.
const copyLayout = assetNames => {
  const tmp = mkdtempSync(join(tmpdir(), 'ui-instance-'));
  mkdirSync(join(tmp, 'checks'));
  mkdirSync(join(tmp, 'dist'));
  copyFileSync(script, join(tmp, 'checks', 'ui-instance.mjs'));
  for (const name of assetNames) copyFileSync(join(root, 'dist', name), join(tmp, 'dist', name));
  return tmp;
};
const serveIn = tmp => spawnSync(process.execPath, [join(tmp, 'checks', 'ui-instance.mjs'), 'serve'], { cwd: tmp, encoding: 'utf8', timeout: 10000 });

test('serve exits 1 and removes the disposable directory when a dist file is missing', t => {
  const tmp = copyLayout(['index.html', 'lab.js', 'lab.css']);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const result = serveIn(tmp);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT.*engine\.js/);
  assert.doesNotMatch(result.stdout, /UI_TESTING_URL/);
  assert.equal(existsSync(join(tmp, '.ui-testing')), false);
});

test('serve refuses an existing disposable directory and leaves it alone', t => {
  const tmp = copyLayout(['index.html', 'lab.js', 'lab.css', 'engine.js', 'scenarios.js', 'executed.js']);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, '.ui-testing'));
  writeFileSync(join(tmp, '.ui-testing', 'notes.txt'), 'left by someone else');
  const result = serveIn(tmp);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Disposable directory exists; refusing reuse/);
  assert.deepEqual(readdirSync(join(tmp, '.ui-testing')), ['notes.txt']);
  assert.equal(readFileSync(join(tmp, '.ui-testing', 'notes.txt'), 'utf8'), 'left by someone else');
});
