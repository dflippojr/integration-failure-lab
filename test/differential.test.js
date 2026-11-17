import { test, describe, before, after } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { combinations, failureSettings, safeguardToggles, EVENT_TYPES } from './differential/combos.mjs';
import { engineOutcome, normalise, compare, canonical } from './differential/outcome.mjs';
import { loadKnown, report, javaTimingArgs, parseOptions, differential, refusalCases, MAX_KNOWN, TIME_SCALE } from '../scripts/differential.mjs';
import { run, BACKOFFS, DEFAULT_SAFEGUARDS, RETRY_LIMITS } from '../engine/engine.js';
import { checkedRun, SAME_EVENT_RULE } from '../engine/rules.js';

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

// Characterization (#144): the generated list is fixed, so moving its constants cannot change what the differential runs.
// Regenerate combination-ids.json and the hash only when a change to the list is intended.
test('the generator yields the recorded combinations', () => {
  const ids = JSON.parse(readFileSync(new URL('./differential/combination-ids.json', import.meta.url), 'utf8'));
  assert.deepEqual(all.map(c => c.id), ids);
  assert.equal(createHash('sha256').update(canonical(all)).digest('hex'), '2747eb8d4f035faa73e4083c50b23b16794ab77ee8975dc910cb7f56c13360f9');
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

test('every four-failure Free-form setting runs under the defaults and with the consumer safeguards on', () => {
  const of = kind => failureSettings().filter(s => s.kind === kind);
  const schema = of('schemaChange').find(s => s.value.event === 'ClaimPaid');
  const safeguardSets = [{}, { idempotency: true, ordering: true, schemaValidation: true }].map(t => ({ ...DEFAULT_SAFEGUARDS, ...t }));
  let settings = 0;
  for (const timeout of of('timeout')) {
    for (const duplicate of of('duplicate')) {
      for (const reorder of of('reorder')) {
        const failures = { timeout: timeout.value, duplicate: duplicate.value, reorder: reorder.value, schemaChange: schema.value };
        for (const safeguards of safeguardSets) {
          assert.ok(all.some(c => sameFailures(c, failures) && canonical(c.safeguards) === canonical(safeguards)),
            `${timeout.label}+${duplicate.label}+${reorder.label}+${schema.label} with ${canonical(safeguards)}`);
        }
        settings++;
      }
    }
  }
  assert.equal(settings, 81, '9 timeouts x 3 ack-loss events x 3 delayed events, with the rename on');
  assert.ok(byId.has('timeout-paid-all+ackloss-paid+reorder-paid+schema-paid__idempotency+ordering+schemaValidation'));
});

test('the longest runs around the retry limit are generated under every backoff, and one past it is refused', () => {
  const failures = { timeout: { event: 'ClaimPaid', attempts: 'all' } };
  const generated = safeguards => all.find(c => sameFailures(c, failures) && canonical(c.safeguards) === canonical({ ...DEFAULT_SAFEGUARDS, ...safeguards }));
  assert.deepEqual(RETRY_LIMITS, [0, 1, 2, 3, 4, 5]);
  const most = RETRY_LIMITS.at(-1);
  for (const backoff of BACKOFFS) {
    for (const retryLimit of RETRY_LIMITS) {
      assert.deepEqual(engineOutcome(generated({ retryLimit, backoff })).dlq, ['E3'], `${retryLimit} retries, ${backoff}`);
    }
    assert.deepEqual(engineOutcome(generated({ retryLimit: most, backoff, replayAfterFix: true })).dlq, ['E3'], `replay, ${backoff}`);
    assert.deepEqual(engineOutcome(generated({ retryLimit: most + 1, backoff })), { refused: 'safeguards.retryLimit' });
  }
});

test('every generated run the engine accepts has only finite trace times', () => {
  const ran = all.filter(c => 'record' in engineOutcome(c));
  assert.ok(ran.length > 700, `${ran.length} runs`);
  for (const c of ran) assert.ok(run(c).trace.every(row => Number.isFinite(row.t)), c.id);
});

// #198: no verdict either. judge() derives it from the record, DLQ and buffer compared here, on the engine's side only.
test('the engine outcome keeps ids and leaves timings and the verdict out', () => {
  const c = byId.get('poison-paid__defaults');
  assert.deepEqual(engineOutcome(c), {
    record: { status: 'Accepted', paidCents: 0, applied: ['E1', 'E2'] },
    dlq: ['E3'], dropped: [], buffered: [],
  });
  assert.deepEqual(normalise(run(c)), engineOutcome(c));
});

// #198: a refusal compares by the rule that refused, not by its text, which each runtime words its own way.
test('a refused generated combination comes out as the id of the rule that refused it, and nothing else', () => {
  const sameEvent = c => c.failures.poison !== undefined && c.failures.poison.event === c.failures.schemaChange?.event;
  const tooManyRetries = c => c.safeguards.retryLimit > RETRY_LIMITS.at(-1);
  for (const c of all) {
    const expected = sameEvent(c) ? { refused: SAME_EVENT_RULE } : tooManyRetries(c) ? { refused: 'safeguards.retryLimit' } : undefined;
    if (expected) assert.deepEqual(engineOutcome(c), expected, c.id);
    else assert.deepEqual(Object.keys(engineOutcome(c)), ['record', 'dlq', 'dropped', 'buffered'], c.id);
  }
  assert.ok(all.filter(sameEvent).length >= 3, 'each poison + schema change pair on one event');
  assert.equal(all.filter(tooManyRetries).length, BACKOFFS.length, 'one past the retry limit under each backoff');
});

// One table for both sides: DifferentialRunnerTest.everyRefusalNamesTheRuleTheEngineNames reads this file too. The rows
// that break two rules hold the two runtimes to the same rule order.
test('each refused scenario names the rule the Java runner names, the first one it breaks', () => {
  const rows = JSON.parse(readFileSync(new URL('./differential/refusals.json', import.meta.url), 'utf8'));
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, 'unique ids');
  for (const { refused, ...combination } of rows) {
    assert.deepEqual(engineOutcome(combination), { refused }, combination.id);
  }
});

// Each runtime words its own reasons: the engine's checkedRun() message, as test/engine.test.js pins it.
test('the engine still words its refusal, with the rule id beside it', () => {
  assert.throws(() => checkedRun({ id: 'retry-six', safeguards: { retryLimit: 6 } }), {
    message: 'Scenario retry-six: Unsupported safeguards.retryLimit "6"; expected a whole number from 0 to 5',
    rule: 'safeguards.retryLimit',
  });
});

// Anything else that throws is not a refusal: it keeps its message, as the Java runner's {error} does.
test('an engine outcome that throws without a rule is an error, not a refusal', () => {
  assert.deepEqual(engineOutcome({ id: 'unreadable', get failures() { throw new Error('unreadable'); } }), { error: 'unreadable' });
});

// The same scenario and outcome as DifferentialRunnerTest.nullFailuresAndSafeguardsRunWithTheDefaultsAsInTheEngine.
test('null failures and safeguards run with the defaults, as in the Java runner', () => {
  assert.deepEqual(engineOutcome({ id: 'null-sections', failures: null, safeguards: null }), {
    record: { status: 'Paid', paidCents: 12000, applied: ['E1', 'E2', 'E3'] },
    dlq: [], dropped: [], buffered: [],
  });
});

// One table for both sides: DifferentialRunnerTest reads this file too, so the rules cannot drift apart.
test('every non-object failures or safeguards value is refused by the same rule as in the Java runner', () => {
  const rows = JSON.parse(readFileSync(new URL('./differential/non-object-sections.json', import.meta.url), 'utf8'));
  for (const section of ['failures', 'safeguards']) {
    const types = rows.filter(row => row.id.startsWith(`${section}-`)).map(row => (Array.isArray(row[section]) ? 'array' : typeof row[section]));
    assert.deepEqual([...new Set(types)].sort(), ['array', 'boolean', 'number', 'string'], `${section} covers every non-object JSON type`);
  }
  for (const { refused, ...combination } of rows) {
    assert.deepEqual(engineOutcome(combination), { refused }, combination.id);
  }
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

// #197: the Java runner's defaults are the engine's TIMING at TIME_SCALE, so the differential checks the configuration
// that records executed/ and needs no timing arguments for it; another scale reaches the runner as lab.time-scale.
test('Java runs the engine timing model at its own default scale, with no timing arguments', () => {
  assert.deepEqual(javaTimingArgs(), []);
  assert.deepEqual(javaTimingArgs(TIME_SCALE), []);
  assert.deepEqual(javaTimingArgs(0.5), ['--lab.time-scale=0.5']);
});

test('the differential default scale is the scale the Java runner recorded executed/ with by default', () => {
  const executed = new URL('../executed/', import.meta.url);
  const scales = new Set(readdirSync(executed).filter(f => f.endsWith('.json') && f !== 'index.json')
    .map(f => JSON.parse(readFileSync(new URL(f, executed), 'utf8')).timing.timeScale));
  assert.deepEqual([...scales], [TIME_SCALE]);
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

// #179: a scale that rounds a positive Java timing to 0 would reach LabProperties as unset (its default) or collapse a send time.
test('a scale that rounds a Java timing to 0 is refused, naming the timing and the smallest accepted scale', () => {
  // The smallest positive timing is E2's send time, 100 ms: 100 x 0.005 = 0.5 rounds up to 1, while 100 x 0.00499 rounds to 0.
  assert.equal(parseOptions(['--scale', '0.005']).scale, 0.005);
  assert.throws(() => parseOptions(['--scale', '0.00499']),
    /--scale 0\.00499 rounds lab\.send-at-ms \(100 ms\) to 0 in the Java runner; the smallest accepted scale is 0\.005/);
  assert.throws(() => parseOptions(['--scale', '0.0004']),
    /--scale 0\.0004 rounds lab\.backoff-base-ms \(1000 ms\) to 0 in the Java runner; the smallest accepted scale is 0\.005/);
});

describe('a differential run', () => {
  let out;
  before(() => { out = mkdtempSync(join(tmpdir(), 'ifl-differential-')); });
  after(() => rmSync(out, { recursive: true, force: true }));

  // Stands in for the jar: answers with the engine's own outcomes, after letting the test tamper with them.
  const fakeJava = (tamper = o => o) => (inFile, outFile, args) => {
    assert.deepEqual(args, ['--lab.differential-workers=2']);
    const combos = JSON.parse(readFileSync(inFile, 'utf8'));
    writeFileSync(outFile, JSON.stringify(combos.map(c => ({ id: c.id, outcome: tamper(engineOutcome(c), c) }))));
  };
  const run2 = (options, runJava, known = []) => {
    const lines = [];
    const ok = differential({ workers: 2, ...options }, { runJava, out, known, write: line => lines.push(line) });
    return { ok, text: lines.join('\n') };
  };
  const [first, second] = all;
  const cases = refusalCases();

  test('passes when both sides agree', () => {
    const { ok, text } = run2({}, fakeJava());
    assert.equal(ok, true);
    assert.ok(text.includes(`${all.length} combinations: ${all.length} agree, 0 known divergences, 0 unexplained mismatches.`), text);
    assert.ok(text.includes(`${cases.length} refusal cases: ${cases.length} agree, 0 known divergences, 0 unexplained mismatches.`), text);
    // The default scale passes the Java runner no timing arguments (#197).
    assert.ok(text.startsWith(`Differential test: ${all.length} of ${all.length} combinations and ${cases.length} of ${cases.length} refusal cases; `
      + 'Java --lab.differential-workers=2\n'), text);
    assert.equal(JSON.parse(readFileSync(join(out, 'engine-outcomes.json'), 'utf8')).length, all.length + cases.length);
  });

  // #198: no generated combination breaks two rules, so the shared refusal tables are what can catch a rule-order drift.
  test('runs every refusal table row on both sides, with ids of their own, and fails when the Java rule differs', () => {
    assert.equal(cases.length, 73, '53 rows of refusals.json and 20 of non-object-sections.json');
    assert.equal(new Set([...all, ...cases].map(c => c.id)).size, all.length + cases.length, 'no id is both');
    assert.ok(cases.every(c => !('refused' in c)), 'the expected rule stays out of what the runtimes see');
    const swapped = run2({ only: ['backoff-and-retry'] }, fakeJava((o, c) => (c.id === 'backoff-and-retry' ? { refused: 'safeguards.retryLimit' } : o)));
    assert.equal(swapped.ok, false);
    assert.ok(swapped.text.startsWith(`Differential test: 0 of ${all.length} combinations and 1 of ${cases.length} refusal cases`), swapped.text);
    assert.ok(swapped.text.includes('MISMATCH backoff-and-retry (differs in: refused)'), swapped.text);
    assert.ok(swapped.text.includes('repro:       npm run differential -- --only backoff-and-retry'), swapped.text);
    assert.ok(swapped.text.includes('1 refusal cases: 0 agree, 0 known divergences, 1 unexplained mismatches.'), swapped.text);
    assert.ok(!swapped.text.includes(' combinations: '), 'no summary for an empty group');
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
    assert.ok(subset.text.startsWith(`Differential test: 1 of ${all.length} combinations and 0 of ${cases.length} refusal cases`), subset.text);
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
