// Deterministic integration-failure simulator. Pure: no DOM, no timers, no randomness.
// run(scenario, overrides?) -> { trace, record, expected, dlq, dropped, buffered, stats, verdict }

export const TIMING = Object.freeze({
  sendAt: [0, 100, 200], // producer emits the three events at these virtual ms
  latencyMs: 50,         // one-way delivery time for a healthy attempt
  timeoutMs: 2000,       // sender gives up waiting for an ack after this long
  backoffBaseMs: 1000,
  replayAfterMs: 5000,   // each dead-lettered message is replayed this long after it was parked (the producer fix has shipped)
  reorderDelayMs: 500,   // the one failures.reorder.delayMs a scenario may use: the Java runner has a single reorder delay
});

export const DEFAULT_SAFEGUARDS = Object.freeze({
  retryLimit: 3,             // retries after the first attempt
  backoff: 'exponential',    // 'none' | 'fixed' | 'exponential'
  idempotency: false,        // dedupe on eventId
  ordering: false,           // buffer ahead-of-sequence events, drop stale ones
  schemaValidation: false,   // reject payloads missing required fields
  deadLetter: true,          // park messages that give up instead of dropping them
  replayAfterFix: false,     // after the producer fix, replay each DLQ entry once, replayAfterMs after it was parked, with a fresh attempt count
});

export const EVENT_TYPES = Object.freeze(['ClaimSubmitted', 'ClaimAccepted', 'ClaimPaid']);
const FAILURE_KINDS = ['timeout', 'duplicate', 'reorder', 'schemaChange', 'poison'];
export const BACKOFFS = Object.freeze(['none', 'fixed', 'exponential']); // Scenario.BACKOFFS order: the refusal text lists them

export const CLAIM_ID = 'C-1001';
const AMOUNT_CENTS = 12000;

export function claimEvents() {
  return [
    { eventId: 'E1', type: 'ClaimSubmitted', seq: 1, claimId: CLAIM_ID, status: 'Submitted', payload: {} },
    { eventId: 'E2', type: 'ClaimAccepted', seq: 2, claimId: CLAIM_ID, status: 'Accepted', payload: {} },
    { eventId: 'E3', type: 'ClaimPaid', seq: 3, claimId: CLAIM_ID, status: 'Paid', payload: { paidAmount: AMOUNT_CENTS } },
  ];
}

export const EXPECTED_RECORD = Object.freeze({ status: 'Paid', paidCents: AMOUNT_CENTS, applied: ['E1', 'E2', 'E3'] });

export function backoffMs(kind, retryNumber) {
  if (kind === 'none') return 0;
  if (kind === 'fixed') return TIMING.backoffBaseMs;
  if (kind === 'exponential') return TIMING.backoffBaseMs * 2 ** (retryNumber - 1);
  throw new Error(`Unknown backoff: ${kind}`);
}

// A whole number the Java runner can hold as an int attempt, from 1 to 2^31 - 1 (Scenario.positiveInteger).
const attemptNumber = n => Number.isInteger(n) && n > 0 && n <= 2 ** 31 - 1;

// Why the Java runner would refuse this scenario (Scenario.fromMap checks the same rules in the same order, with the
// same text), or null. Values are shown as String() shows them, which Scenario.shown mirrors.
function refusal(failures, guards) {
  const unsupported = (path, value, expected) => `Unsupported ${path} "${String(value ?? null)}"; expected ${expected}`;
  for (const kind of FAILURE_KINDS) {
    if (failures[kind] != null && !EVENT_TYPES.includes(failures[kind].event)) {
      return unsupported(`failures.${kind}.event`, failures[kind].event, `one of ${EVENT_TYPES.join(', ')}`);
    }
  }
  const attempts = failures.timeout?.attempts;
  if (failures.timeout != null && attempts !== 'all'
    && !(Array.isArray(attempts) && attempts.length && attempts.every(attemptNumber))) {
    return unsupported('failures.timeout.attempts', attempts, '"all" or a non-empty list of positive integers');
  }
  if (failures.reorder != null && failures.reorder.delayMs !== TIMING.reorderDelayMs) {
    return unsupported('failures.reorder.delayMs', failures.reorder.delayMs, `${TIMING.reorderDelayMs}, the one delay the Java runner takes`);
  }
  // Producer-side payload faults compose differently in each runtime, so a scenario may not stack them on one event.
  if (failures.poison && failures.poison.event === failures.schemaChange?.event) {
    return `failures.poison and failures.schemaChange cannot target the same event (${failures.poison.event})`;
  }
  if (!BACKOFFS.includes(guards.backoff)) return unsupported('safeguards.backoff', guards.backoff, `one of ${BACKOFFS.join(', ')}`);
  // Java holds the retry limit as an int: 4294967297 would wrap to 1 there, and retry for ever here.
  if (guards.retryLimit !== 0 && !attemptNumber(guards.retryLimit)) {
    return unsupported('safeguards.retryLimit', guards.retryLimit, 'a whole number from 0 to 2147483647');
  }
  for (const [name, initial] of Object.entries(DEFAULT_SAFEGUARDS)) {
    if (typeof initial === 'boolean' && typeof guards[name] !== 'boolean') return unsupported(`safeguards.${name}`, guards[name], 'true or false');
  }
  return null;
}

export function run(scenario, overrides = {}) {
  const failures = scenario.failures ?? {};
  const guards = { ...DEFAULT_SAFEGUARDS, ...scenario.safeguards, ...overrides };
  const refused = refusal(failures, guards);
  if (refused) throw new Error(`Scenario ${scenario.id}: ${refused}`);
  const events = claimEvents();
  const byType = Object.fromEntries(events.map(e => [e.type, e]));

  const original = {};
  if (failures.poison) {
    const e = byType[failures.poison.event];
    original[e.eventId] = e.payload;
    e.payload = { paidAmount: '120.00' }; // amount shipped as text: the consumer cannot parse it
  }
  if (failures.schemaChange) {
    const e = byType[failures.schemaChange.event];
    original[e.eventId] ??= e.payload; // replay after the producer fix sends the original, as with poison
    e.payload = { amountPaid: e.payload.paidAmount };
  }

  const trace = [];
  const log = (t, actor, kind, e, extra = {}) =>
    trace.push({ t, actor, kind, eventId: e?.eventId ?? null, eventType: e?.type ?? null, ...extra });

  // Discrete-event loop; ties break by insertion order so runs are reproducible.
  const agenda = [];
  let order = 0;
  const at = (t, fn) => agenda.push({ t, order: order++, fn });

  const record = { status: null, paidCents: 0, applied: [] };
  const seen = new Set();
  const buffer = new Map(); // seq -> event
  let nextSeq = 1;
  const dlq = [];
  const dropped = [];
  const replayed = new Set();
  const stats = { attempts: 0, retries: 0, timeouts: 0, acksLost: 0, deduped: 0, buffered: 0, stale: 0, rejected: 0 };

  const timesOut = (e, attempt) => {
    const f = failures.timeout;
    if (!f || f.event !== e.type) return false;
    return f.attempts === 'all' || f.attempts.includes(attempt);
  };
  const loseAck = (e, attempt) => failures.duplicate?.event === e.type && attempt === 1;
  const extraDelay = (e, attempt) => (failures.reorder?.event === e.type && attempt === 1 ? failures.reorder.delayMs : 0);

  function apply(t, e) {
    const amount = e.payload.paidAmount;
    record.status = e.status;
    if (e.type === 'ClaimPaid') record.paidCents += amount ?? 0; // lenient consumer: missing means zero
    record.applied.push(e.eventId);
    nextSeq = Math.max(nextSeq, e.seq + 1);
    log(t, 'downstream', 'apply', e, { status: record.status, paidCents: record.paidCents });
  }

  function drainBuffer(t) {
    while (buffer.has(nextSeq)) {
      const e = buffer.get(nextSeq);
      buffer.delete(nextSeq);
      log(t, 'downstream', 'release', e, { note: 'gap filled, releasing buffered event' });
      apply(t, e);
    }
  }

  // Returns 'ack', 'reject' (never retry) or 'fail' (processing error, retried). Every non-rejected delivery is acked, including duplicates and buffered events.
  function receive(t, e) {
    if (e.type === 'ClaimPaid' && typeof e.payload.paidAmount === 'string') {
      stats.rejected++;
      log(t, 'downstream', 'reject', e, { note: 'poison: paidAmount is text, cannot be parsed' });
      return 'fail';
    }
    if (guards.schemaValidation && e.type === 'ClaimPaid' && typeof e.payload.paidAmount !== 'number') {
      stats.rejected++;
      log(t, 'downstream', 'reject', e, { note: 'schema: missing paidAmount' });
      return 'reject';
    }
    if (guards.idempotency && seen.has(e.eventId)) {
      stats.deduped++;
      log(t, 'downstream', 'dedupe', e, { note: 'already seen, skipped' });
      return 'ack';
    }
    if (guards.ordering) {
      if (e.seq < nextSeq) {
        stats.stale++;
        log(t, 'downstream', 'stale', e, { note: `seq ${e.seq} already applied, skipped` });
        return 'ack';
      }
      if (e.seq > nextSeq) {
        seen.add(e.eventId);
        buffer.set(e.seq, e);
        stats.buffered++;
        log(t, 'downstream', 'buffer', e, { note: `waiting for seq ${nextSeq}` });
        return 'ack';
      }
    }
    seen.add(e.eventId);
    apply(t, e);
    if (guards.ordering) drainBuffer(t);
    return 'ack';
  }

  function giveUp(t, e, attempt, reason) {
    if (guards.deadLetter) {
      const entry = { eventId: e.eventId, eventType: e.type, reason, attempts: attempt };
      dlq.push(entry);
      log(t, 'queue', 'dead-letter', e, { attempt, note: reason });
      if (guards.replayAfterFix && !replayed.has(e.eventId)) {
        replayed.add(e.eventId);
        at(t + TIMING.replayAfterMs, now => replay(now, entry));
      }
    } else {
      dropped.push({ eventId: e.eventId, eventType: e.type, reason, attempts: attempt });
      log(t, 'queue', 'drop', e, { attempt, note: `${reason}; no dead-letter queue` });
    }
  }

  function scheduleRetry(t, e, attempt) {
    if (attempt <= guards.retryLimit) {
      const wait = backoffMs(guards.backoff, attempt);
      log(t, 'queue', 'retry-scheduled', e, { attempt, note: `retry in ${wait} ms` });
      at(t + wait, now => send(now, e, attempt + 1));
    } else {
      giveUp(t, e, attempt, `retry limit (${guards.retryLimit}) reached`);
    }
  }

  // The producer fix has shipped: take this entry (only) out of the DLQ and deliver the corrected original afresh.
  function replay(t, entry) {
    dlq.splice(dlq.indexOf(entry), 1);
    const e = events.find(x => x.eventId === entry.eventId);
    e.payload = original[e.eventId] ?? e.payload;
    log(t, 'queue', 'replay', e, { note: 'producer fix shipped, replaying from the dead-letter queue' });
    send(t, e, 1);
  }

  function send(t, e, attempt) {
    stats.attempts++;
    if (attempt > 1) stats.retries++;
    log(t, 'queue', 'send', e, { attempt });
    const onTimeout = () => {
      stats.timeouts++;
      log(t + TIMING.timeoutMs, 'queue', 'timeout', e, { attempt });
      scheduleRetry(t + TIMING.timeoutMs, e, attempt);
    };

    if (timesOut(e, attempt)) {
      at(t + TIMING.timeoutMs, onTimeout);
      return;
    }
    const arrival = t + TIMING.latencyMs + extraDelay(e, attempt);
    at(arrival, now => {
      const outcome = receive(now, e);
      if (outcome === 'fail') {
        scheduleRetry(now, e, attempt);
      } else if (outcome === 'reject') {
        giveUp(now, e, attempt, 'rejected as non-retryable');
      } else if (loseAck(e, attempt)) {
        stats.acksLost++;
        log(now, 'downstream', 'ack-lost', e, { attempt });
        at(t + TIMING.timeoutMs, onTimeout);
      } else {
        log(now, 'downstream', 'ack', e, { attempt });
      }
    });
  }

  events.forEach((e, i) => at(TIMING.sendAt[i], now => {
    log(now, 'producer', 'emit', e, { seq: e.seq });
    send(now, e, 1);
  }));

  while (agenda.length) {
    agenda.sort((a, b) => a.t - b.t || a.order - b.order);
    const next = agenda.shift();
    next.fn(next.t);
  }

  // Listed in seq order, the order the buffer drains in (Java's TreeMap matches).
  const buffered = [...buffer.values()].sort((a, b) => a.seq - b.seq).map(e => ({ eventId: e.eventId, eventType: e.type, seq: e.seq }));
  const verdict = judge(record, { dlq, buffered });
  return { trace, record, expected: EXPECTED_RECORD, dlq, dropped, buffered, stats, guards, verdict };
}

export const dollars = cents => `$${(cents / 100).toFixed(2)}`;
const typeOf = id => claimEvents().find(e => e.eventId === id).type;

export function judge(record, { dlq = [], buffered = [] } = {}) {
  const problems = [];
  const counts = record.applied.reduce((m, id) => m.set(id, (m.get(id) ?? 0) + 1), new Map());

  for (const [id, n] of counts) if (n > 1) problems.push(`${typeOf(id)} applied ${n} times`);
  for (const id of EXPECTED_RECORD.applied) if (!counts.has(id)) problems.push(`${typeOf(id)} never applied`);
  const firstSeen = [...new Set(record.applied)];
  if (firstSeen.length === EXPECTED_RECORD.applied.length && firstSeen.join() !== EXPECTED_RECORD.applied.join()) {
    problems.push(`applied out of order (${firstSeen.map(typeOf).join(' → ')})`);
  }
  if (record.status !== EXPECTED_RECORD.status) problems.push(`final status is ${record.status ?? 'empty'}, not ${EXPECTED_RECORD.status}`);
  if (record.paidCents !== EXPECTED_RECORD.paidCents) problems.push(`paid ${dollars(record.paidCents)} instead of ${dollars(EXPECTED_RECORD.paidCents)}`);
  for (const b of buffered) problems.push(`${b.eventType} stuck in the ordering buffer`);

  const ok = problems.length === 0;
  const visible = dlq.length > 0;
  let summary;
  if (ok) summary = 'The claim record is correct.';
  else if (visible) summary = `The record is wrong, but the failure is visible: ${dlq.length === 1 ? '1 message' : `${dlq.length} messages`} in the dead-letter queue.`;
  else summary = 'The record is wrong, and nothing flags it.';
  return { ok, visible, problems, summary };
}

// Safeguard changes worth offering for a run, each checked by rerunning the scenario with only that change.
// A change is offered only when it makes a silent failure visible, or fixes the record or removes a problem without adding one.
export const SAFEGUARD_CHANGES = Object.freeze([
  { safeguard: 'idempotency', value: true },
  { safeguard: 'ordering', value: true },
  { safeguard: 'schemaValidation', value: true },
  { safeguard: 'deadLetter', value: true },
  { safeguard: 'retryLimit', value: 5 },
]);

export function suggestSafeguards(scenario) {
  const before = run(scenario);
  if (before.verdict.ok) return [];
  return SAFEGUARD_CHANGES.filter(({ safeguard, value }) => {
    if (before.guards[safeguard] === value) return false;
    const { verdict } = run(scenario, { [safeguard]: value });
    const { problems } = before.verdict;
    if (!before.verdict.visible && verdict.visible) return true;
    return verdict.problems.every(p => problems.includes(p)) && verdict.problems.length < problems.length;
  });
}
