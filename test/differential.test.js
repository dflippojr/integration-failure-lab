import { test, describe, before, after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { combinations, failureSettings, safeguardToggles, EVENT_TYPES } from './differential/combos.mjs';
import { engineOutcome, normalise, compare, canonical } from './differential/outcome.mjs';
import { loadKnown, report, javaTimingArgs, parseOptions, differential, MAX_KNOWN } from '../scripts/differential.mjs';
import { run, DEFAULT_SAFEGUARDS, TIMING } from '../engine/engine.js';

const all = combinations();
const byId = new Map(all.map(c => [c.id, c]));
const sameFailures = (c, failures) => canonical(c.failures) === canonical(failures);

test('the generator yields at least 300 combinations with unique ids', () => {
  assert.ok(all.length >= 300, `${all.length} combinations`);
  assert.equal(byId.size, all.length);
  for (const c of all) assert.match(c.id, /^[a-z0-9+_-]+$/i, 'ids are shell-safe for the repro line');
});

test('the generator is reproducible', () => {
  assert.equal(canonical(combinations()), canonical(all));
  assert.notEqual(canonical(combinations({ seed: 1 })), canonical(all), 'the seed drives the 3-way sample');
});

test('every (failure kind x target event) setting meets every single safeguard change', () => {
  const settings = failureSettings();
  assert.deepEqual([...new Set(settings.map(s => s.kind))], ['timeout', 'duplicate', 'reorder', 'schemaChange', 'poison']);
  for (const kind of ['duplicate', 'reorder', 'schemaChange', 'poison']) {
    assert.deepEqual(settings.filter(s => s.kind === kind).map(s => s.value.event), EVENT_TYPES);
  }
  const toggles = safeguardToggles();
  assert.equal(toggles.length, 5 + 2 + 5, 'other retry limits, other backoffs, each toggle flipped');
  for (const s of settings) {
    for (const t of [{}, ...toggles]) {
      const safeguards = { ...DEFAULT_SAFEGUARDS, ...t };
      assert.ok(all.some(c => sameFailures(c, { [s.kind]: s.value }) && canonical(c.safeguards) === canonical(safeguards)),
        `${s.label} with ${JSON.stringify(t)}`);
    }
  }
});

test('the sample includes 3-way failure combinations and the poison + schema change refusal', () => {
  assert.ok(all.filter(c => Object.keys(c.failures).length === 3).length >= 100);
  assert.ok(all.some(c => c.failures.poison && c.failures.poison.event === c.failures.schemaChange?.event));
});

test('the engine outcome keeps ids and verdict and leaves timings out', () => {
  const c = byId.get('poison-paid__defaults');
  assert.deepEqual(engineOutcome(c), {
    record: { status: 'Accepted', paidCents: 0, applied: ['E1', 'E2'] },
    dlq: ['E3'], dropped: [], buffered: [],
    verdict: { ok: false, visible: true, problems: ['ClaimPaid never applied', 'final status is Accepted, not Paid', 'paid $0.00 instead of $120.00'] },
  });
  assert.deepEqual(normalise(run(c)), engineOutcome(c));
  assert.match(engineOutcome(byId.get('schema-paid+poison-paid__defaults')).error, /cannot target the same event/);
});

test('compare separates agreement, owner-decided divergences, stale entries and unexplained mismatches', () => {
  const [a, b, c, d] = all;
  const ok = { record: { status: 'Paid' }, dlq: [] };
  const engine = new Map([[a.id, ok], [b.id, ok], [c.id, ok], [d.id, ok]]);
  const java = new Map([[a.id, { dlq: [], record: { status: 'Paid' } }], [b.id, { ...ok, dlq: ['E1'] }], [d.id, ok]]);
  const known = [{ issue: 'https://github.com/o/r/issues/1', combinations: [b.id, d.id] }];
  const result = compare([a, b, c, d], engine, java, known);
  assert.deepEqual(result.explained.map(m => [m.combination.id, m.fields, m.known.issue]), [[b.id, ['dlq'], known[0].issue]]);
  assert.deepEqual(result.unexplained.map(m => [m.combination.id, m.fields]), [[c.id, ['missing']]]);
  assert.deepEqual(result.stale, [{ known: known[0], id: d.id }]);

  const lines = [];
  assert.equal(report(result, 4, line => lines.push(line)), false);
  const text = lines.join('\n');
  assert.ok(text.includes(`MISMATCH ${c.id}`), text);
  assert.ok(text.includes(`repro:       npm run differential -- --only ${c.id}`), text);
  assert.ok(text.includes(`STALE ${d.id}: listed under https://github.com/o/r/issues/1`), text);
  assert.ok(text.includes('4 combinations: 2 agree, 1 known divergences (1 by https://github.com/o/r/issues/1), 1 unexplained'), text);
  assert.equal(report({ explained: [], unexplained: [], stale: [] }, 4, () => {}), true);
});

test('Java runs the engine timing model, scaled', () => {
  assert.deepEqual(javaTimingArgs(0.5), [`--lab.timeout-ms=${TIMING.timeoutMs / 2}`, `--lab.backoff-base-ms=${TIMING.backoffBaseMs / 2}`,
    `--lab.send-at-ms=${TIMING.sendAt.map(t => t / 2).join(',')}`, '--lab.reorder-delay-ms=250', `--lab.replay-delay-ms=${TIMING.replayAfterMs / 2}`]);
});

test(`known.json lists at most ${MAX_KNOWN} divergences, each with an issue link and generated combinations`, () => {
  const known = loadKnown();
  assert.ok(known.length <= MAX_KNOWN);
  for (const k of known) for (const id of k.combinations) assert.ok(byId.has(id), `${k.issue} lists unknown combination ${id}`);
});

test('options are validated before anything reaches the JVM', () => {
  assert.deepEqual(parseOptions([]), { only: undefined, workers: 4, scale: 0.25 });
  assert.deepEqual(parseOptions(['--only', 'a', '--only', 'b', '--workers', '2', '--scale', '0.5']), { only: ['a', 'b'], workers: 2, scale: 0.5 });
  assert.throws(() => parseOptions(['--workers', '5']), /--workers must be 1-4/);
  assert.throws(() => parseOptions(['--workers', '2;rm']), /--workers must be 1-4/);
  assert.throws(() => parseOptions(['--scale', '0']), /--scale must be/);
  assert.throws(() => parseOptions(['--jar', 'x']), /Unknown option/);
});

describe('a differential run', () => {
  let out;
  before(() => { out = mkdtempSync(join(tmpdir(), 'ifl-differential-')); });
  after(() => rmSync(out, { recursive: true, force: true }));

  // Stands in for the jar: answers with the engine's own outcomes, after letting the test tamper with them.
  const fakeJava = (tamper = o => o) => (inFile, outFile, args) => {
    assert.deepEqual(args, ['--lab.differential-workers=2', ...javaTimingArgs(0.25)]);
    const combos = JSON.parse(readFileSync(inFile, 'utf8'));
    writeFileSync(outFile, JSON.stringify(combos.map(c => ({ id: c.id, outcome: tamper(engineOutcome(c), c) }))));
  };
  const run2 = (options, runJava, known = []) => {
    const lines = [];
    const ok = differential({ workers: 2, ...options }, { runJava, out, known, write: line => lines.push(line) });
    return { ok, text: lines.join('\n') };
  };
  const [first, second] = all;

  test('passes when both sides agree', () => {
    const { ok, text } = run2({}, fakeJava());
    assert.equal(ok, true);
    assert.ok(text.includes(`${all.length} combinations: ${all.length} agree, 0 known divergences, 0 unexplained mismatches.`), text);
    assert.equal(JSON.parse(readFileSync(join(out, 'engine-outcomes.json'), 'utf8')).length, all.length);
  });

  test('fails on a mismatch and prints its repro', () => {
    const { ok, text } = run2({}, fakeJava((o, c) => (c.id === second.id ? { ...o, dlq: ['E9'] } : o)));
    assert.equal(ok, false);
    assert.ok(text.includes(`MISMATCH ${second.id} (differs in: dlq)`), text);
  });

  test('fails on a known divergence that has gone, unless only a subset ran', () => {
    const known = [{ issue: 'https://github.com/o/r/issues/1', combinations: [first.id] }];
    assert.equal(run2({}, fakeJava(), known).ok, false);
    const subset = run2({ only: [first.id] }, fakeJava(), known);
    assert.equal(subset.ok, true);
    assert.ok(subset.text.startsWith(`Differential test: 1 of ${all.length} combinations`), subset.text);
    assert.throws(() => run2({ only: ['nope'] }, fakeJava()), /Unknown combination id: nope/);
  });
});

test('known.json is refused when it grows past the limit or loses its links', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ifl-known-'));
  const file = join(dir, 'known.json');
  const entry = { issue: 'https://github.com/o/r/issues/1', combinations: ['x'] };
  try {
    const refuses = (value, message) => { writeFileSync(file, JSON.stringify(value)); assert.throws(() => loadKnown(file), message); };
    refuses({}, /must hold an array/);
    refuses([entry, entry, entry, entry], /at most 3 are allowed/);
    refuses([{ ...entry, issue: 'see #1' }], /without an issue link/);
    refuses([{ ...entry, combinations: [] }], /lists no combinations/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
