// Guards against drift: dist/ must equal a fresh build, and executed/ must cover the scenarios.
// The build stamp dist/build.json names a commit, so it is generated and git-ignored rather than compared.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
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
// generatedAt is a recording timestamp, not content. Minified output may drop the key quotes.
const stripStamps = s => s.replace(/"?generatedAt"?:\s*"[^"]*"/g, 'generatedAt:""');
// The build resolves esbuild from its own checkout, so private copies link this repo's node_modules.
const linkModules = dir => symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
const recordingIds = generated => JSON.parse(generated.match(/\bRECORDING_IDS\s*=\s*(\[.*?\])/)[1]);

let tmp;
before(() => {
  // Build in a private copy of the sources so this never races the UI tests' dist-test/ output.
  tmp = mkdtempSync(join(tmpdir(), 'ifl-dist-'));
  mkdirSync(join(tmp, 'scripts'));
  for (const f of ['build.mjs', 'git.mjs', 'scenarios.mjs']) cpSync(join(root, 'scripts', f), join(tmp, 'scripts', f));
  for (const d of ['engine', 'ui', 'scenarios', 'executed']) cpSync(join(root, d), join(tmp, d), { recursive: true });
  linkModules(tmp);
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

test('dist/build.json is generated, git-ignored and never committed', () => {
  const stamp = JSON.parse(readFileSync(join(tmp, 'dist', 'build.json'), 'utf8'));
  assert.deepEqual(Object.keys(stamp), ['gitCommit', 'builtFrom']);
  assert.equal(stamp.builtFrom, 'integration-failure-lab');
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('check-ignore', '-q', 'dist/build.json').status, 0, 'dist/build.json must be git-ignored');
  assert.equal(git('ls-files', 'dist/build.json').stdout, '', 'dist/build.json must not be committed');
});

test('generated SCENARIOS carry only the browser fields, in order sequence', async () => {
  const { SCENARIOS } = await import('../dist/scenarios.js');
  const BROWSER_KEYS = ['id', 'title', 'summary', 'failures', 'safeguards', 'lesson'];
  const bySequence = scenarios.map(({ data }) => data).sort((a, b) => a.order - b.order);
  assert.deepEqual(SCENARIOS.map(scenario => Object.keys(scenario)), bySequence.map(() => BROWSER_KEYS));
  for (const [i, { id, title, summary, failures, safeguards, lesson }] of bySequence.entries()) {
    assert.deepEqual(SCENARIOS[i], { id, title, summary, failures, safeguards, lesson });
  }
});

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

// Returns the message of every failing check for one recording (empty when it matches its scenario).
// rec is an { file, data } entry of executed/; file names the scenario file.
function recordingProblems(rec, scenario, file) {
  const { record, dlq, dropped, buffered } = rec.data;
  const verdict = judge(record, { dlq, dropped, buffered });
  const context = `executed/${rec.file} vs scenarios/${file}`;
  const expect = scenario.expect;
  const problems = [];
  const check = assertion => { try { assertion(); } catch (error) { problems.push(error.message); } };
  for (const [key, value] of Object.entries(expect.record)) {
    check(() => assert.deepEqual(record[key], value, `${context}: record.${key} differs from expect.record.${key}; re-record with the Java runner.`));
  }
  // An independent literal oracle catches order, duplicates and omissions even if judge changes.
  if (expect.ok === true) {
    check(() => assert.deepEqual(record.applied, ['E1', 'E2', 'E3'], `${context}: record.applied must be exactly [E1,E2,E3] for expect.ok=true.`));
  }
  if ('ok' in expect) {
    check(() => assert.equal(verdict.ok, expect.ok, `${context}: judged ok differs from expect.ok; ${verdict.problems.join('; ')}`));
  }
  if ('visible' in expect) {
    check(() => assert.equal(verdict.visible, expect.visible, `${context}: judged visible differs from expect.visible.`));
  }
  for (const [key, entries] of Object.entries({ dlq, dropped })) {
    if (key in expect) {
      check(() => assert.deepEqual(entries.map(entry => entry.eventId), expect[key], `${context}: ${key} differs from expect.${key}.`));
    }
  }
  return problems;
}

for (const { file, data: scenario } of scenarios) {
  test(`recorded replay ${scenario.id} matches its scenario expectations`, () => {
    const rec = recordingByScenarioId.get(scenario.id);
    if (!rec) return; // reported by the coverage test
    const problems = recordingProblems(rec, scenario, file);
    assert.equal(problems.length, 0, problems.join('\n'));
  });
}

test('recorded replay rejects wrong-order, duplicate and missing applied events in 6b', () => {
  const file = '6b-poison-message-replay.json';
  const { data: scenario } = scenarios.find(s => s.file === file);
  const rec = recordings.find(r => r.file === file);
  const mutated = changes => ({ file, data: { ...rec.data, ...changes } });
  assert.deepEqual(recordingProblems(rec, scenario, file), [], 'the committed recording passes');
  const where = `executed/${file} vs scenarios/${file}: `;
  // Change only the applied list: Paid, 12000 cents and an empty DLQ still match.
  for (const applied of [['E1', 'E3', 'E2'], ['E1', 'E2', 'E3', 'E3'], ['E1', 'E3']]) {
    const problems = recordingProblems(mutated({ record: { ...rec.data.record, applied } }), scenario, file);
    const label = applied.join(',');
    assert.ok(problems.some(m => m.startsWith(where + 'record.applied must be exactly [E1,E2,E3]')), `oracle rejects ${label}: ${problems}`);
    assert.ok(problems.some(m => m.startsWith(where + 'judged ok differs')), `judge rejects ${label}: ${problems}`);
    assert.equal(problems.length, 2, `only the applied checks fail for ${label}: ${problems}`);
  }
  // Every other field the scenario pins is checked as well.
  for (const [field, changes] of [
    ['expect.record.status', { record: { ...rec.data.record, status: 'Pending' } }],
    ['expect.record.paidCents', { record: { ...rec.data.record, paidCents: 0 } }],
    ['expect.dlq', { dlq: [{ eventId: 'E2' }] }],
  ]) {
    const problems = recordingProblems(mutated(changes), scenario, file);
    assert.ok(problems.some(m => m.includes(`differs from ${field}`)), `${field} change is rejected: ${problems}`);
  }
});

test('recording manifest contains exactly the actual recording keys', () => {
  const generated = readFileSync(join(tmp, 'dist', 'scenarios.js'), 'utf8');
  const ids = recordingIds(generated);
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
  const ids = recordingIds(generated);
  assert.equal(ids.length, 11);
  assert.ok(!ids.includes(id));
  assert.ok(generated.includes(id), 'the unrecorded scenario remains available to simulate');
});

test('initial static UI graph excludes recordings and stays within the minified byte budget', () => {
  const modules = new Map();
  function visit(file) {
    if (modules.has(file)) return;
    const source = readFileSync(join(root, 'dist', file), 'utf8');
    // Compare Windows CRLF bytes for every module, including generated modules.
    modules.set(file, Buffer.from(source.replace(/\r?\n/g, '\r\n')));
    // Static imports only; minified modules put several statements on one line.
    for (const match of source.matchAll(/(?:^|[;}\s])import\s*[{*\w][^;]*?from\s*['"]\.\/(.+?)['"]/gm)) visit(match[1]);
  }
  visit('lab.js');
  assert.deepEqual([...modules.keys()].sort(), ['engine.js', 'lab.js', 'scenarios.js']);
  const bytes = [...modules.values()];
  // Issue #66 budget: minified totals measure 24,094 raw / 9,320 gzip-9 bytes.
  // Issue #63 (Try this in Free-form) re-baselined it: 24,889 raw / 9,631 gzip-9 bytes.
  // Issue #64 (compare with the previous Free-form run) re-baselined it: 26,372 raw / 10,069 gzip-9 bytes.
  // Issue #126 (refuse scenarios the Java runner can't express) re-baselined it at the owner's decision
  // (option A, 2026-10-22, on the issue): 28,071 raw / 10,748 gzip-9 bytes.
  // Issue #134 (validate safeguard values on both sides) re-baselined it at the owner's decision (2026-10-26, on the
  // issue): 28,404 raw / 10,880 gzip-9 bytes.
  assert.ok(bytes.reduce((sum, b) => sum + b.length, 0) < 28600);
  assert.ok(bytes.reduce((sum, b) => sum + gzipSync(b, { level: 9 }).length, 0) < 10950);
});
