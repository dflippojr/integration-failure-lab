// Guards against drift: dist/ must equal a fresh build, and executed/ must cover the scenarios.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { judge } from '../engine/engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const GENERATED = ['engine.js', 'lab.js', 'lab.css', 'scenarios.js', 'executed.js'];
const norm = s => s.replace(/\r\n/g, '\n');
const readJson = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const scenarios = readdirSync(join(root, 'scenarios')).filter(f => f.endsWith('.json'))
  .map(file => ({ file, data: readJson('scenarios', file) }));
const recordings = readdirSync(join(root, 'executed')).filter(f => f.endsWith('.json') && f !== 'index.json')
  .map(file => ({ file, data: readJson('executed', file) }));
const recordingByScenarioId = new Map();
for (const recording of recordings) {
  if (!recordingByScenarioId.has(recording.data.scenarioId)) {
    recordingByScenarioId.set(recording.data.scenarioId, recording);
  }
}
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
  const ids = scenarios.map(({ data }) => data.id);
  const recordedIds = recordings.map(({ data }) => data.scenarioId);
  for (const id of ids) {
    assert.ok(recordings.some(({ file }) => file.startsWith(`${id}`) || file === `${id}.json`) && recordedIds.includes(id),
      `Scenario ${id} has no executed/${id}-*.json recording.`);
  }
  for (const [i, { file: f }] of recordings.entries()) {
    assert.ok(ids.includes(recordedIds[i]), `executed/${f} is orphaned: no scenario "${recordedIds[i]}".`);
    assert.ok(f.startsWith(recordedIds[i]), `executed/${f} should be named for scenario "${recordedIds[i]}".`);
  }
  assert.equal(new Set(recordedIds).size, recordedIds.length, 'Two recordings share a scenarioId.');
});

for (const { file, data: scenario } of scenarios) {
  test(`recorded replay ${scenario.id} matches its scenario expectations`, () => {
    const rec = recordingByScenarioId.get(scenario.id);
    if (!rec) return; // reported by the coverage test
    const { record, dlq, dropped, buffered } = rec.data;
    const verdict = judge(record, { dlq, dropped, buffered });
    const context = `executed/${rec.file} vs scenarios/${file}`;
    const expect = scenario.expect;
    for (const [key, value] of Object.entries(expect.record)) {
      assert.deepEqual(record[key], value, `${context}: record.${key} differs from expect.record.${key}; re-record with the Java runner.`);
    }
    // An independent literal oracle catches order, duplicates and omissions even if judge changes.
    if (expect.ok === true) {
      assert.deepEqual(record.applied, ['E1', 'E2', 'E3'], `${context}: record.applied must be exactly [E1,E2,E3] for expect.ok=true.`);
    }
    if ('ok' in expect) {
      assert.equal(verdict.ok, expect.ok, `${context}: judged ok differs from expect.ok; ${verdict.problems.join('; ')}`);
    }
    if ('visible' in expect) {
      assert.equal(verdict.visible, expect.visible, `${context}: judged visible differs from expect.visible.`);
    }
    for (const [key, entries] of Object.entries({ dlq, dropped })) {
      if (key in expect) {
        assert.deepEqual(entries.map(entry => entry.eventId), expect[key], `${context}: ${key} differs from expect.${key}.`);
      }
    }
  });
}

test('rebuilt dist rejects wrong-order, duplicate and missing applied events in 6b', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ifl-bad-recording-'));
  try {
    for (const dir of ['scripts', 'engine', 'ui', 'scenarios', 'executed', 'dist']) {
      cpSync(join(tmp, dir), join(fixture, dir), { recursive: true });
    }
    mkdirSync(join(fixture, 'test'));
    cpSync(join(root, 'test', 'dist.test.js'), join(fixture, 'test', 'dist.test.js'));
    cpSync(join(root, 'package.json'), join(fixture, 'package.json'));
    const recordingFile = join(fixture, 'executed', '6b-poison-message-replay.json');
    const recording = JSON.parse(readFileSync(recordingFile, 'utf8'));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // The child is a fresh test runner, not this runner's worker.
    for (const applied of [['E1', 'E3', 'E2'], ['E1', 'E2', 'E3', 'E3'], ['E1', 'E3']]) {
      // Change only the applied list: Paid, 12000 cents and an empty DLQ still match.
      recording.record.applied = applied;
      writeFileSync(recordingFile, JSON.stringify(recording));
      const built = spawnSync(process.execPath, [join(fixture, 'scripts', 'build.mjs'), 'dist'], { encoding: 'utf8' });
      assert.equal(built.status, 0, built.stderr);
      const checked = spawnSync(process.execPath, [
        '--test', '--test-concurrency=1', '--test-reporter=tap',
        '--test-name-pattern=^(dist/|recorded replay )', join(fixture, 'test', 'dist.test.js'),
      ], { encoding: 'utf8', env });
      const output = checked.stdout + checked.stderr;
      assert.equal(checked.status, 1, output);
      assert.match(output, /ok \d+ - dist\/executed\.js is current/);
      assert.match(output, /not ok \d+ - recorded replay 6b-poison-message-replay matches its scenario expectations/);
      assert.ok(output.includes('executed/6b-poison-message-replay.json vs scenarios/6b-poison-message-replay.json: record.applied'), output);
      assert.match(output, /# fail 1\b/);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('recording manifest contains exactly the actual recording keys', () => {
  const generated = readFileSync(join(tmp, 'dist', 'scenarios.js'), 'utf8');
  const ids = JSON.parse(generated.match(/export const RECORDING_IDS = (.*);/)[1]);
  const recordedIds = recordings.map(({ data }) => data.scenarioId);
  assert.deepEqual(ids.sort(), recordedIds.sort());
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
