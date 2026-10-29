import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { run, backoffMs, judge, suggestSafeguards, SAFEGUARD_CHANGES, EXPECTED_RECORD, TIMING } from '../engine/engine.js';

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
    assert.deepEqual(r, run(s), 'a second run differs');
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

// #99: each DLQ entry is replayed replayAfterMs after it was parked, matching the Java runner.
const parkAndReplayTimes = r => {
  const at = kind => Object.fromEntries(r.trace.filter(t => t.kind === kind).reverse().map(t => [t.eventId, t.t]));
  const parked = at('dead-letter');
  const replayed = at('replay');
  return { parked, replayed };
};

test('two dead-lettered events are each replayed replayAfterMs after their own parking', () => {
  const r = run({
    id: 'lead1-drain',
    failures: { timeout: { event: 'ClaimAccepted', attempts: 'all' }, poison: { event: 'ClaimPaid' } },
    safeguards: { retryLimit: 0, replayAfterFix: true },
  });
  const { parked, replayed } = parkAndReplayTimes(r);
  assert.deepEqual(Object.keys(replayed).sort(), ['E2', 'E3']);
  for (const id of ['E2', 'E3']) assert.equal(replayed[id] - parked[id], TIMING.replayAfterMs, `${id} replay delay`);
  assert.deepEqual(r.trace.filter(t => t.kind === 'replay').map(t => t.eventId), ['E3', 'E2']);
  assert.deepEqual(r.dlq.map(e => e.eventId), ['E2']);
  assert.deepEqual(r.record, { status: 'Paid', paidCents: 12000, applied: ['E1', 'E3'] });
});

test('per-entry replay keeps the DLQ in parking order when both replays time out again', () => {
  const r = run({
    id: 'x3-replay-order',
    failures: {
      timeout: { event: 'ClaimAccepted', attempts: [1] },
      duplicate: { event: 'ClaimSubmitted' },
      reorder: { event: 'ClaimAccepted', delayMs: 500 },
    },
    safeguards: { retryLimit: 0, backoff: 'none', ordering: true, replayAfterFix: true },
  });
  const { parked, replayed } = parkAndReplayTimes(r);
  for (const id of ['E1', 'E2']) assert.equal(replayed[id] - parked[id], TIMING.replayAfterMs, `${id} replay delay`);
  assert.deepEqual(r.dlq.map(e => e.eventId), ['E1', 'E2']);
});

test('poison and a schema change on the same event are rejected when the scenario runs', () => {
  const scenario = { id: 'x2-poison-schema', failures: { poison: { event: 'ClaimPaid' }, schemaChange: { event: 'ClaimPaid' } } };
  assert.throws(() => run(scenario), {
    message: 'Scenario x2-poison-schema: failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)',
  });
});

// Each refusal is checked before anything is scheduled, with the message Scenario.fromMap gives (ScenarioTest).
const refuses = (scenario, message) => assert.throws(() => run(scenario), { message: `Scenario ${scenario.id}: ${message}` });

test('a failure that targets an unknown event type is rejected when the scenario runs', () => {
  const expected = 'expected one of ClaimSubmitted, ClaimAccepted, ClaimPaid';
  refuses({ id: 'x-poison-typo', failures: { poison: { event: 'ClaimPayed' } } }, `Unsupported failures.poison.event "ClaimPayed"; ${expected}`);
  refuses({ id: 'x-timeout-typo', failures: { timeout: { event: 'ClaimPayed', attempts: 'all' } } }, `Unsupported failures.timeout.event "ClaimPayed"; ${expected}`);
  refuses({ id: 'x-duplicate-none', failures: { duplicate: {} } }, `Unsupported failures.duplicate.event "null"; ${expected}`);
  refuses({ id: 'x-reorder-typo', failures: { reorder: { event: 'claimAccepted', delayMs: 500 } } }, `Unsupported failures.reorder.event "claimAccepted"; ${expected}`);
  refuses({ id: 'x-schema-number', failures: { schemaChange: { event: 3 } } }, `Unsupported failures.schemaChange.event "3"; ${expected}`);
});

test('timeout attempts that are neither "all" nor a non-empty list of positive integers are rejected when the scenario runs', () => {
  const expected = 'expected "all" or a non-empty list of positive integers';
  refuses({ id: 'x-attempts-missing', failures: { timeout: { event: 'ClaimPaid' } } }, `Unsupported failures.timeout.attempts "null"; ${expected}`);
  refuses({ id: 'x-attempts-empty', failures: { timeout: { event: 'ClaimPaid', attempts: [] } } }, `Unsupported failures.timeout.attempts ""; ${expected}`);
  refuses({ id: 'x-attempts-zero', failures: { timeout: { event: 'ClaimPaid', attempts: [1, 0] } } }, `Unsupported failures.timeout.attempts "1,0"; ${expected}`);
  refuses({ id: 'x-attempts-fraction', failures: { timeout: { event: 'ClaimPaid', attempts: [1.5] } } }, `Unsupported failures.timeout.attempts "1.5"; ${expected}`);
  refuses({ id: 'x-attempts-word', failures: { timeout: { event: 'ClaimPaid', attempts: 'first' } } }, `Unsupported failures.timeout.attempts "first"; ${expected}`);
  // Past Java's int range: the Java runner would wrap 4294967297 to attempt 1, so neither side takes it.
  refuses({ id: 'x-attempts-huge', failures: { timeout: { event: 'ClaimPaid', attempts: [4294967297] } } }, `Unsupported failures.timeout.attempts "4294967297"; ${expected}`);
});

test('a reorder delay other than 500 ms, including a missing one, is rejected when the scenario runs', () => {
  const expected = 'expected 500, the one delay the Java runner takes';
  refuses({ id: 'x-delay-50', failures: { reorder: { event: 'ClaimAccepted', delayMs: 50 } } }, `Unsupported failures.reorder.delayMs "50"; ${expected}`);
  refuses({ id: 'x-delay-missing', failures: { reorder: { event: 'ClaimAccepted' } } }, `Unsupported failures.reorder.delayMs "null"; ${expected}`);
  assert.equal(run({ id: 'x-delay-500', failures: { reorder: { event: 'ClaimAccepted', delayMs: TIMING.reorderDelayMs } } }).verdict.ok, false);
});

test('an unsupported backoff is rejected when the scenario runs, even when nothing retries', () => {
  const message = 'Unsupported safeguards.backoff "bogus"; expected one of none, fixed, exponential';
  refuses({ id: 'x-backoff-quiet', safeguards: { backoff: 'bogus' } }, message);
  refuses({ id: 'x-backoff-retry', failures: { poison: { event: 'ClaimPaid' } }, safeguards: { backoff: 'bogus' } }, message);
  // A list is not a backoff, even one that String() shows as a supported name.
  refuses({ id: 'x-backoff-list', safeguards: { backoff: ['fixed'] } }, 'Unsupported safeguards.backoff "fixed"; expected one of none, fixed, exponential');
});

test('a retry limit that is not a whole number from 0 to 2^31 - 1 is rejected when the scenario runs', () => {
  const expected = 'expected a whole number from 0 to 2147483647';
  refuses({ id: 'x-retry-text', safeguards: { retryLimit: '3' } }, `Unsupported safeguards.retryLimit "3"; ${expected}`);
  refuses({ id: 'x-retry-null', safeguards: { retryLimit: null } }, `Unsupported safeguards.retryLimit "null"; ${expected}`);
  refuses({ id: 'x-retry-negative', safeguards: { retryLimit: -1 } }, `Unsupported safeguards.retryLimit "-1"; ${expected}`);
  refuses({ id: 'x-retry-fraction', safeguards: { retryLimit: 1.5 } }, `Unsupported safeguards.retryLimit "1.5"; ${expected}`);
  // String() writes these as the Java runner must too: plain decimal from 1e-7 up to 1e21, E-notation outside.
  refuses({ id: 'x-retry-tiny', safeguards: { retryLimit: 0.0001 } }, `Unsupported safeguards.retryLimit "0.0001"; ${expected}`);
  refuses({ id: 'x-retry-tinier', safeguards: { retryLimit: 1e-7 } }, `Unsupported safeguards.retryLimit "1e-7"; ${expected}`);
  refuses({ id: 'x-retry-vast', safeguards: { retryLimit: 1.5e21 } }, `Unsupported safeguards.retryLimit "1.5e+21"; ${expected}`);
  // Past Java's int range: the Java runner would wrap 4294967297 to 1 retry, and with a timeout on every attempt the engine
  // would retry about 4.3 billion times.
  refuses({ id: 'x-retry-huge', safeguards: { retryLimit: 4294967297 } }, `Unsupported safeguards.retryLimit "4294967297"; ${expected}`);
  // Free-form overrides are checked too.
  assert.throws(() => run({ id: 'x-retry-override' }, { retryLimit: '5' }), { message: `Scenario x-retry-override: Unsupported safeguards.retryLimit "5"; ${expected}` });
  assert.equal(run({ id: 'x-retry-max', safeguards: { retryLimit: 2 ** 31 - 1 } }).verdict.ok, true);
});

test('an on/off safeguard that is not true or false is rejected when the scenario runs, in DEFAULT_SAFEGUARDS order', () => {
  for (const name of ['idempotency', 'ordering', 'schemaValidation', 'deadLetter', 'replayAfterFix']) {
    refuses({ id: `x-${name}-text`, safeguards: { [name]: 'false' } }, `Unsupported safeguards.${name} "false"; expected true or false`);
  }
  refuses({ id: 'x-dedupe-number', safeguards: { idempotency: 1 } }, 'Unsupported safeguards.idempotency "1"; expected true or false');
  refuses({ id: 'x-dedupe-fraction', safeguards: { idempotency: 0.0001 } }, 'Unsupported safeguards.idempotency "0.0001"; expected true or false');
  refuses({ id: 'x-dlq-null', safeguards: { deadLetter: null } }, 'Unsupported safeguards.deadLetter "null"; expected true or false');
  // The retry limit comes first, then the on/off safeguards in DEFAULT_SAFEGUARDS order.
  refuses({ id: 'x-several', safeguards: { replayAfterFix: 0, ordering: 'yes', retryLimit: '1' } }, 'Unsupported safeguards.retryLimit "1"; expected a whole number from 0 to 2147483647');
  refuses({ id: 'x-several', safeguards: { replayAfterFix: 0, ordering: 'yes' } }, 'Unsupported safeguards.ordering "yes"; expected true or false');
});

test('a scenario that breaks two rules from different groups is refused for the one checked first', () => {
  // The same cases as rulesBrokenTwice in ScenarioTest.
  const sameEvent = { poison: { event: 'ClaimPaid' }, schemaChange: { event: 'ClaimPaid' } };
  refuses({ id: 'x-event-and-backoff', failures: { poison: { event: 'ClaimPayed' } }, safeguards: { backoff: 'bogus' } },
    'Unsupported failures.poison.event "ClaimPayed"; expected one of ClaimSubmitted, ClaimAccepted, ClaimPaid');
  refuses({ id: 'x-delay-and-same-event', failures: { reorder: { event: 'ClaimAccepted', delayMs: 50 }, ...sameEvent } },
    'Unsupported failures.reorder.delayMs "50"; expected 500, the one delay the Java runner takes');
  refuses({ id: 'x-same-event-and-retry', failures: sameEvent, safeguards: { retryLimit: -1 } },
    'failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)');
  refuses({ id: 'x-backoff-and-retry', safeguards: { backoff: 'bogus', retryLimit: -1 } },
    'Unsupported safeguards.backoff "bogus"; expected one of none, fixed, exponential');
  refuses({ id: 'x-retry-and-toggle', safeguards: { retryLimit: -1, idempotency: 'yes' } },
    'Unsupported safeguards.retryLimit "-1"; expected a whole number from 0 to 2147483647');
  // Spreading [] adds no safeguards, so the event rule still decides (aFailureRefusalStillWinsWhenTheSafeguardsAreNotAnObject).
  refuses({ id: 'x-event-and-list-safeguards', failures: { poison: { event: 'ClaimPayed' } }, safeguards: [] },
    'Unsupported failures.poison.event "ClaimPayed"; expected one of ClaimSubmitted, ClaimAccepted, ClaimPaid');
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

test('the ordering buffer is listed in seq order, not arrival order', () => {
  const r = run({ failures: { reorder: { event: 'ClaimAccepted', delayMs: 500 }, timeout: { event: 'ClaimSubmitted', attempts: [1] } } }, { retryLimit: 0, ordering: true });
  assert.deepEqual(r.buffered.map(b => b.eventId), ['E2', 'E3']);
  assert.deepEqual(r.verdict.problems.filter(p => p.includes('ordering buffer')), ['ClaimAccepted stuck in the ordering buffer', 'ClaimPaid stuck in the ordering buffer']);
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
