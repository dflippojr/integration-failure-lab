// scripts/recordings.mjs re-records executed/ with the Java runner and fails on behavioural drift.
import { test, describe, before, after } from 'node:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { normalise, lineDiff, compareRecordings, report, recordings, EXECUTED, RERECORD } from '../scripts/recordings.mjs';

const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const writeJson = (dir, file, data) => writeFileSync(join(dir, file), JSON.stringify(data, null, 2));
const FILE = '1a-transient-timeout.json';

test('normalising leaves out wall-clock fields and the JDK build, and ignores key order', () => {
  const rec = readJson(EXECUTED, FILE);
  const n = normalise(rec);
  assert.deepEqual(Object.keys(n), ['buffered', 'dlq', 'dropped', 'guards', 'mode', 'record', 'scenarioId', 'timing', 'trace']);
  assert.ok(n.trace.length > 0 && n.trace.every(row => !('t' in row)));
  const reordered = Object.fromEntries(Object.entries(rec).reverse());
  const retimed = { ...reordered, generatedAt: 'later', warmupMs: 1, runtime: { java: 'other' }, trace: rec.trace.map(r => ({ ...r, t: r.t + 7 })) };
  assert.deepEqual(normalise(retimed), n);
  assert.deepEqual(normalise([{ b: 1, a: 2 }]), [{ a: 2, b: 1 }], 'index.json keeps its entries in order');
});

test('the line diff marks removed and added lines and elides distant unchanged ones', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
  const b = ['1', '2', '3', '4', 'X', '6', '7', '8', '9'].join('\n');
  assert.equal(lineDiff(a, b, 1), ['  ...', '  4', '- 5', '+ X', '  6', '  ...'].join('\n'));
  assert.equal(lineDiff('a\nb', 'a\nb\nc'), ['  a', '  b', '+ c'].join('\n'));
  assert.equal(lineDiff('x', 'x'), '');
});

describe('comparing recordings', () => {
  let fresh;
  before(() => { fresh = mkdtempSync(join(tmpdir(), 'ifl-recordings-test-')); });
  after(() => rmSync(fresh, { recursive: true, force: true }));
  const freshCopy = () => {
    rmSync(fresh, { recursive: true, force: true });
    cpSync(EXECUTED, fresh, { recursive: true });
  };

  test('a re-recording that only differs in timing agrees', () => {
    freshCopy();
    const rec = readJson(fresh, FILE);
    writeJson(fresh, FILE, { ...rec, generatedAt: '2030-01-01T00:00:00Z', warmupMs: 999, trace: rec.trace.map(r => ({ ...r, t: r.t * 2 })) });
    assert.deepEqual(compareRecordings(EXECUTED, fresh), []);
  });

  for (const [field, change] of [
    ['record', rec => ({ ...rec, record: { ...rec.record, status: 'Accepted' } })],
    ['dlq', rec => ({ ...rec, dlq: [{ eventId: 'E3' }] })],
    ['dropped', rec => ({ ...rec, dropped: ['E3'] })],
    ['buffered', rec => ({ ...rec, buffered: ['E2'] })],
    ['trace', rec => ({ ...rec, trace: [rec.trace[1], rec.trace[0], ...rec.trace.slice(2)] })],
  ]) {
    test(`a change in ${field} is drift, with a diff`, () => {
      freshCopy();
      writeJson(fresh, FILE, change(readJson(fresh, FILE)));
      const drift = compareRecordings(EXECUTED, fresh);
      assert.deepEqual(drift.map(d => [d.file, d.problem, d.fields]), [[FILE, 'behaviour differs', [field]]]);
      assert.match(drift[0].diff, /^- /m);
      assert.match(drift[0].diff, /^\+ /m);
    });
  }

  test('a different index, a missing recording and an extra one are drift', () => {
    freshCopy();
    writeJson(fresh, 'index.json', readJson(fresh, 'index.json').slice(1));
    rmSync(join(fresh, FILE));
    writeJson(fresh, '9-new.json', {});
    assert.deepEqual(compareRecordings(EXECUTED, fresh).map(d => [d.file, d.problem, d.fields]), [
      [FILE, 'not re-recorded: no scenario writes it any more', undefined],
      ['9-new.json', 'not committed', undefined],
      ['index.json', 'behaviour differs', ['index']],
    ]);
  });
});

test('the report names each drifted file and the re-record command', () => {
  const lines = [];
  assert.equal(report([{ file: FILE, problem: 'behaviour differs', fields: ['record'], diff: '- a\n+ b' }, { file: 'x.json', problem: 'not committed' }],
    '/tmp/fresh', line => lines.push(line)), false);
  const text = lines.join('\n');
  assert.ok(text.includes(`DRIFT executed/${FILE}: behaviour differs (differs in: record)`), text);
  assert.ok(text.includes(`+++ ${join('/tmp/fresh', FILE)} (re-recorded)\n- a\n+ b`), text);
  assert.ok(text.includes('DRIFT executed/x.json: not committed'), text);
  assert.ok(text.includes(`2 recording(s) no longer match what the Java runner does. If the change is intended, re-record and commit:\n  ${RERECORD}`), text);
  assert.equal(report([], '/tmp/fresh', () => {}), true);
});

test('the re-record command is the README one', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(readme.includes(RERECORD), RERECORD);
});

describe('a recordings run', () => {
  // Stands in for the jar: copies the committed recordings, after letting the test tamper with one.
  const fakeJar = (tamper = rec => rec) => out => {
    cpSync(EXECUTED, out, { recursive: true });
    writeJson(out, FILE, tamper(readJson(out, FILE)));
  };
  const run = record => {
    const lines = [];
    const ok = recordings({ record, write: line => lines.push(line) });
    return { ok, text: lines.join('\n'), dir: lines[0].replace('Re-recording every scenario into ', '') };
  };

  test('passes and removes its temp directory when nothing drifted', () => {
    const { ok, text, dir } = run(fakeJar());
    assert.equal(ok, true, text);
    assert.ok(text.includes('Recordings match'), text);
    assert.equal(existsSync(dir), false);
  });

  test('fails and keeps its temp directory for inspection when a recording drifted', () => {
    const { ok, text, dir } = run(fakeJar(rec => ({ ...rec, dropped: ['E1'] })));
    try {
      assert.equal(ok, false);
      assert.ok(text.includes(`DRIFT executed/${FILE}: behaviour differs (differs in: dropped)`), text);
      assert.ok(existsSync(join(dir, FILE)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
