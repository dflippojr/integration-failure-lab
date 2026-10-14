import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { run, backoffMs, judge, suggestSafeguards, SAFEGUARD_CHANGES, EXPECTED_RECORD } from '../engine/engine.js';

const dir = new URL('../scenarios/', import.meta.url);
const scenarios = readdirSync(dir)
  .filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
  .sort((a, b) => a.order - b.order);

const kinds = (result, eventId) => result.trace.filter(r => r.eventId === eventId).map(r => r.kind);

test('there are twelve scenarios', () => {
  assert.equal(scenarios.length, 12);
});

for (const s of scenarios) {
  test(`scenario ${s.id} matches its expectation`, () => {
    const r = run(s);
    assert.equal(r.verdict.ok, s.expect.ok, r.verdict.problems.join('; '));
    if ('visible' in s.expect) assert.equal(r.verdict.visible, s.expect.visible);
    for (const [k, v] of Object.entries(s.expect.record)) assert.equal(r.record[k], v, k);
    if (s.expect.dlq) assert.deepEqual(r.dlq.map(d => d.eventId), s.expect.dlq);
    if (s.expect.dropped) assert.deepEqual(r.dropped.map(d => d.eventId), s.expect.dropped);
  });

  test(`scenario ${s.id} is deterministic`, () => {
    assert.deepEqual(run(s), run(s));
  });
}

const byId = id => scenarios.find(s => s.id === id);

test('1a delivers the payment on attempt 3 after ~7 s of virtual time', () => {
  const r = run(byId('1a-transient-timeout'));
  const apply = r.trace.find(t => t.kind === 'apply' && t.eventId === 'E3');
  assert.equal(apply.t, 7250);
  assert.deepEqual(kinds(r, 'E3').filter(k => k === 'timeout').length, 2);
  assert.equal(r.stats.retries, 2);
});

test('1b dead-letters after exactly 1 + retryLimit attempts', () => {
  const r = run(byId('1b-outage-with-dlq'));
  assert.equal(r.dlq[0].attempts, 4);
  assert.equal(r.stats.attempts, 3 + 3);
});

test('2a applies the payment twice because the ack was lost', () => {
  const r = run(byId('2a-duplicate'));
  assert.deepEqual(r.record.applied, ['E1', 'E2', 'E3', 'E3']);
  assert.ok(kinds(r, 'E3').includes('ack-lost'));
  assert.ok(r.verdict.problems.includes('ClaimPaid applied 2 times'));
});

test('2b dedupes the redelivered payment', () => {
  const r = run(byId('2b-duplicate-idempotent'));
  assert.equal(r.stats.deduped, 1);
  assert.deepEqual(r.record.applied, EXPECTED_RECORD.applied);
});

test('3a flags out-of-order application', () => {
  const r = run(byId('3a-out-of-order'));
  assert.deepEqual(r.record.applied, ['E1', 'E3', 'E2']);
  assert.ok(r.verdict.problems.some(p => p.startsWith('applied out of order')));
});

test('3b buffers the payment until the acceptance arrives', () => {
  const r = run(byId('3b-out-of-order-buffered'));
  assert.deepEqual(kinds(r, 'E3').slice(0, 4), ['emit', 'send', 'buffer', 'ack']);
  assert.ok(kinds(r, 'E3').includes('release'));
  assert.deepEqual(r.buffered, []);
});

test('4 fires the retry, buffer, and dedupe safeguards', () => {
  const r = run(byId('4-combined'));
  assert.ok(r.stats.retries >= 1);
  assert.equal(r.stats.buffered, 1);
  assert.equal(r.stats.deduped, 1);
});

test('5b rejects without retrying', () => {
  const r = run(byId('5b-schema-change-validated'));
  assert.equal(r.stats.rejected, 1);
  assert.equal(r.dlq[0].attempts, 1);
  assert.equal(r.dlq[0].reason, 'rejected as non-retryable');
});

test('6a retries a poison message to the limit, then parks it for good', () => {
  const r = run(byId('6a-poison-message'));
  assert.equal(r.dlq[0].attempts, 4);
  assert.equal(r.dlq[0].reason, 'retry limit (3) reached');
  assert.equal(r.stats.timeouts, 0);
  assert.ok(!kinds(r, 'E3').includes('replay'));
  assert.deepEqual(r.record.applied, ['E1', 'E2']);
});

test('6b replays the parked message with a fresh attempt count and drains the DLQ', () => {
  const r = run(byId('6b-poison-message-replay'));
  assert.deepEqual(r.dlq, []);
  assert.deepEqual(r.record, EXPECTED_RECORD);
  const sends = r.trace.filter(t => t.kind === 'send' && t.eventId === 'E3').map(t => t.attempt);
  assert.deepEqual(sends, [1, 2, 3, 4, 1]);
  assert.ok(kinds(r, 'E3').indexOf('replay') > kinds(r, 'E3').indexOf('dead-letter'));
});

test('a schema-changed ClaimPaid is replayed with the producer fix, matching the Java runner', () => {
  const r = run({
    id: 'x1-schema-replay',
    failures: { schemaChange: { event: 'ClaimPaid' } },
    safeguards: { schemaValidation: true, replayAfterFix: true },
  });
  assert.deepEqual(r.record, EXPECTED_RECORD);
  assert.deepEqual(r.dlq, []);
  assert.ok(kinds(r, 'E3').indexOf('replay') > kinds(r, 'E3').indexOf('dead-letter'));
  assert.equal(r.verdict.ok, true);
});

test('poison and a schema change on the same event are rejected when the scenario runs', () => {
  const scenario = { id: 'x2-poison-schema', failures: { poison: { event: 'ClaimPaid' }, schemaChange: { event: 'ClaimPaid' } } };
  assert.throws(() => run(scenario), {
    message: 'Scenario x2-poison-schema: failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)',
  });
});

test('overrides replace scenario safeguards (free-form mode)', () => {
  const r = run(byId('2a-duplicate'), { idempotency: true });
  assert.equal(r.verdict.ok, true);
});

test('ordering without the missing event leaves the payment stuck in the buffer', () => {
  const r = run(byId('1b-outage-with-dlq'), { ordering: true });
  assert.equal(r.verdict.ok, false);
});

test('a permanent gap in sequence is reported as stuck', () => {
  const r = run({ failures: { timeout: { event: 'ClaimAccepted', attempts: 'all' } } }, { ordering: true });
  assert.deepEqual(r.buffered.map(b => b.eventId), ['E3']);
  assert.ok(r.verdict.problems.includes('ClaimPaid stuck in the ordering buffer'));
});

test('backoff schedules', () => {
  assert.deepEqual([1, 2, 3].map(n => backoffMs('exponential', n)), [1000, 2000, 4000]);
  assert.deepEqual([1, 2].map(n => backoffMs('fixed', n)), [1000, 1000]);
  assert.equal(backoffMs('none', 3), 0);
  assert.throws(() => backoffMs('bogus', 1));
});

test('judge accepts only the expected record', () => {
  assert.equal(judge({ ...EXPECTED_RECORD, applied: [...EXPECTED_RECORD.applied] }).ok, true);
  assert.equal(judge({ status: 'Paid', paidCents: 12000, applied: ['E1', 'E3'] }).ok, false);
});

// Every Free-form combination the form can express (exponential backoff only).
function* freeFormScenarios() {
  const events = ['ClaimSubmitted', 'ClaimAccepted', 'ClaimPaid'];
  const timeouts = [null, ...events.flatMap(event => [[1], [1, 2], 'all'].map(attempts => ({ event, attempts })))];
  const each = [null, ...events.map(event => ({ event }))];
  for (const timeout of timeouts) for (const duplicate of each) for (const reorderEvent of each)
    for (const schemaChange of [null, { event: 'ClaimPaid' }]) for (const retryLimit of [0, 1, 2, 3, 4, 5])
      for (let bits = 0; bits < 16; bits++) {
        const failures = {};
        if (timeout) failures.timeout = timeout;
        if (duplicate) failures.duplicate = duplicate;
        if (reorderEvent) failures.reorder = { ...reorderEvent, delayMs: 500 };
        if (schemaChange) failures.schemaChange = schemaChange;
        yield { failures, safeguards: {
          retryLimit, backoff: 'exponential', deadLetter: !!(bits & 1), idempotency: !!(bits & 2), ordering: !!(bits & 4), schemaValidation: !!(bits & 8),
        } };
      }
}

test('every suggested safeguard changes the verdict, and a safeguard that fixes the run is always suggested', () => {
  let shown = 0;
  const seen = new Set();
  for (const scenario of freeFormScenarios()) {
    const before = run(scenario);
    const tips = suggestSafeguards(scenario);
    if (before.verdict.ok) { assert.deepEqual(tips, []); continue; }
    for (const { safeguard, value } of tips) {
      const after = run(scenario, { [safeguard]: value }).verdict;
      const fewer = after.problems.length < before.verdict.problems.length && after.problems.every(p => before.verdict.problems.includes(p));
      assert.ok(fewer || (!before.verdict.visible && after.visible), `${safeguard} does not help ${JSON.stringify(scenario)}`);
      shown++;
      seen.add(safeguard);
    }
    for (const { safeguard, value } of SAFEGUARD_CHANGES) {
      if (run(scenario, { [safeguard]: value }).verdict.ok) {
        assert.ok(tips.some(t => t.safeguard === safeguard), `${safeguard} fixes ${JSON.stringify(scenario)} but is not suggested`);
      }
    }
  }
  assert.ok(shown > 0);
  assert.deepEqual([...seen].sort(), SAFEGUARD_CHANGES.map(c => c.safeguard).sort());
});

test('suggestions for the scenarios', () => {
  const tips = id => suggestSafeguards(byId(id)).map(t => t.safeguard);
  assert.deepEqual(tips('1c-fire-and-forget'), ['deadLetter']);
  assert.deepEqual(tips('2a-duplicate'), ['idempotency', 'ordering']); // ordering drops the stale redelivery too
  assert.deepEqual(tips('3a-out-of-order'), ['ordering']);
  assert.deepEqual(tips('5a-schema-change'), ['schemaValidation']);
  assert.deepEqual(tips('2b-duplicate-idempotent'), []);
});

test('ordering is suggested when the dead-letter queue holds only an applied message', () => {
  const scenario = {
    failures: { duplicate: { event: 'ClaimPaid' }, reorder: { event: 'ClaimAccepted', delayMs: 500 } },
    safeguards: { retryLimit: 0 },
  };
  assert.equal(run(scenario).dlq.length, 1);
  assert.deepEqual(suggestSafeguards(scenario), [{ safeguard: 'ordering', value: true }]);
});
