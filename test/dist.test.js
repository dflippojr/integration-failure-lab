// Guards against drift: dist/ must equal a fresh build, and executed/ must cover the scenarios.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const GENERATED = ['engine.js', 'lab.js', 'lab.css', 'scenarios.js', 'executed.js'];
const norm = s => s.replace(/\r\n/g, '\n');
const readJson = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
// generatedAt is a recording timestamp, not content.
const stripStamps = s => s.replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt":""');

let tmp;
before(() => {
  // Build in a private copy of the sources so this never races the UI tests' dist-test/ output.
  tmp = mkdtempSync(join(tmpdir(), 'ifl-dist-'));
  mkdirSync(join(tmp, 'scripts'));
  cpSync(join(root, 'scripts', 'build.mjs'), join(tmp, 'scripts', 'build.mjs'));
  for (const d of ['engine', 'ui', 'scenarios', 'executed']) cpSync(join(root, d), join(tmp, d), { recursive: true });
  const run = spawnSync(process.execPath, [join(tmp, 'scripts', 'build.mjs'), 'dist'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

for (const file of GENERATED) {
  test(`dist/${file} is current`, () => {
    const fresh = stripStamps(norm(readFileSync(join(tmp, 'dist', file), 'utf8')));
    const committed = stripStamps(norm(readFileSync(join(root, 'dist', file), 'utf8')));
    assert.ok(fresh === committed, `dist/${file} is stale: run \`npm run build\` and commit dist/.`);
  });
}

test('every scenario has exactly one matching recording, and none are orphaned', () => {
  const ids = readdirSync(join(root, 'scenarios')).filter(f => f.endsWith('.json'))
    .map(f => readJson('scenarios', f).id);
  const recordings = readdirSync(join(root, 'executed')).filter(f => f.endsWith('.json') && f !== 'index.json');
  const recordedIds = recordings.map(f => readJson('executed', f).scenarioId);
  for (const id of ids) {
    assert.ok(recordings.some(f => f.startsWith(`${id}`) || f === `${id}.json`) && recordedIds.includes(id),
      `Scenario ${id} has no executed/${id}-*.json recording.`);
  }
  for (const [i, f] of recordings.entries()) {
    assert.ok(ids.includes(recordedIds[i]), `executed/${f} is orphaned: no scenario "${recordedIds[i]}".`);
    assert.ok(f.startsWith(recordedIds[i]), `executed/${f} should be named for scenario "${recordedIds[i]}".`);
  }
  assert.equal(new Set(recordedIds).size, recordedIds.length, 'Two recordings share a scenarioId.');
});

test("each recorded record matches its scenario's expect.record", () => {
  for (const f of readdirSync(join(root, 'scenarios')).filter(f => f.endsWith('.json'))) {
    const scenario = readJson('scenarios', f);
    const rec = readdirSync(join(root, 'executed')).find(g => g !== 'index.json' && readJson('executed', g).scenarioId === scenario.id);
    if (!rec) continue; // reported by the coverage test
    const recorded = readJson('executed', rec).record;
    for (const [k, v] of Object.entries(scenario.expect.record)) {
      assert.deepEqual(recorded[k], v, `executed/${rec}: record.${k} differs from scenarios/${f} expect.record.${k}; re-record with the Java runner.`);
    }
  }
});

test('recording manifest contains exactly the actual recording keys', () => {
  const generated = readFileSync(join(tmp, 'dist', 'scenarios.js'), 'utf8');
  const ids = JSON.parse(generated.match(/export const RECORDING_IDS = (.*);/)[1]);
  const recordings = readdirSync(join(root, 'executed')).filter(f => f.endsWith('.json') && f !== 'index.json')
    .map(f => readJson('executed', f).scenarioId);
  assert.deepEqual(ids.sort(), recordings.sort());
  assert.ok(!generated.includes('generatedAt'), 'manifest must not contain recording bodies');
});

test('manifest follows recording keys when a future scenario has no recording', () => {
  const recording = readdirSync(join(tmp, 'executed')).find(f => f.endsWith('.json') && f !== 'index.json');
  const id = JSON.parse(readFileSync(join(tmp, 'executed', recording), 'utf8')).scenarioId;
  // Delete only the named recording in this test-owned private copy.
  rmSync(join(tmp, 'executed', recording));
  const built = spawnSync(process.execPath, [join(tmp, 'scripts', 'build.mjs'), 'dist'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const generated = readFileSync(join(tmp, 'dist', 'scenarios.js'), 'utf8');
  const ids = JSON.parse(generated.match(/export const RECORDING_IDS = (.*);/)[1]);
  assert.equal(ids.length, 11);
  assert.ok(!ids.includes(id));
  assert.ok(generated.includes(id), 'the unrecorded scenario remains available to simulate');
});

test('initial static UI graph excludes recordings and beats the issue byte baseline', () => {
  const modules = new Map();
  function visit(file) {
    if (modules.has(file)) return;
    const source = readFileSync(join(root, 'dist', file), 'utf8');
    // Compare Windows CRLF bytes for every module, including generated modules.
    modules.set(file, Buffer.from(source.replace(/\r?\n/g, '\r\n')));
    for (const match of source.matchAll(/^import .* from ['"]\.\/(.+?)['"];$/gm)) visit(match[1]);
  }
  visit('lab.js');
  assert.deepEqual([...modules.keys()].sort(), ['engine.js', 'lab.js', 'scenarios.js']);
  const bytes = [...modules.values()];
  assert.ok(bytes.reduce((sum, b) => sum + b.length, 0) < 63161);
  assert.ok(bytes.reduce((sum, b) => sum + gzipSync(b, { level: 9 }).length, 0) < 12993);
});
