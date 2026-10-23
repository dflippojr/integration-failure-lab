// Guided mode replays either the simulated trace or the recorded Java trace for the same scenario,
// so the two must agree row for row. Only wall-clock time and retry backoff numbers may differ:
// the engine and the Java runner use different timing models (TIMING vs the recording's timing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../engine/engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const scenarios = readdirSync(join(root, 'scenarios')).filter(f => f.endsWith('.json'))
  .map(file => readJson('scenarios', file));

const RETRY_NOTE = /^retry in \d+ ms$/;
function normalise(row) {
  const rest = { ...row };
  delete rest.t;
  return RETRY_NOTE.test(rest.note) ? { ...rest, note: 'retry in <n> ms' } : rest;
}

// Returns why the simulated trace differs from the recorded one, or null when they match.
function traceMismatch(id, simulated, recorded) {
  const sim = simulated.map(normalise);
  const rec = recorded.map(normalise);
  const show = row => row === undefined ? '(no row)' : JSON.stringify(row);
  for (let i = 0; i < Math.max(sim.length, rec.length); i++) {
    if (!isDeepStrictEqual(sim[i], rec[i])) {
      return `${id}: trace row ${i} differs (simulated ${sim.length} rows, executed/${id}.json ${rec.length} rows)\n` +
        `  simulated: ${show(sim[i])}\n  recorded:  ${show(rec[i])}`;
    }
  }
  return null;
}

for (const scenario of scenarios) {
  test(`simulated trace for ${scenario.id} matches executed/${scenario.id}.json`, () => {
    const simulated = run(scenario).trace;
    const recorded = readJson('executed', `${scenario.id}.json`).trace;
    const mismatch = traceMismatch(scenario.id, simulated, recorded);
    assert.ok(mismatch === null, mismatch);
    assert.equal(simulated.length, recorded.length, `${scenario.id}: simulated and recorded traces have different row counts`);
  });
}

test('trace comparison ignores time and backoff numbers but names the first differing row', () => {
  const rows = [
    { t: 0, actor: 'producer', kind: 'send', eventId: 'E1', note: 'retry in 1000 ms' },
    { t: 5, actor: 'downstream', kind: 'release', eventId: 'E2', note: 'gap filled, releasing buffered event' },
    { t: 5, actor: 'downstream', kind: 'apply', eventId: 'E2' },
  ];
  const recorded = rows.map(row => ({ ...row, t: row.t * 4, note: row.note?.replace('1000', '150') }))
    .map(({ note, ...row }) => note === undefined ? row : { ...row, note });
  assert.equal(traceMismatch('x', rows, recorded), null);

  const swapped = [rows[0], rows[2], rows[1]];
  assert.equal(traceMismatch('x', swapped, rows),
    'x: trace row 1 differs (simulated 3 rows, executed/x.json 3 rows)\n' +
    `  simulated: ${JSON.stringify({ actor: 'downstream', kind: 'apply', eventId: 'E2' })}\n` +
    `  recorded:  ${JSON.stringify({ actor: 'downstream', kind: 'release', eventId: 'E2', note: 'gap filled, releasing buffered event' })}`);
  assert.match(traceMismatch('x', rows.slice(0, 2), rows), /^x: trace row 2 differs .*\n {2}simulated: \(no row\)\n/);
  // Only a whole "retry in N ms" note is normalised; other notes with numbers must match exactly.
  assert.match(traceMismatch('x', [{ note: 'retry in 1000 ms later' }], [{ note: 'retry in 150 ms later' }]), /row 0 differs/);
});
