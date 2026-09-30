// Deterministic integration-failure simulator. Pure: no DOM, no timers, no randomness.
// run(scenario, overrides?) -> { trace, record, expected, dlq, dropped, buffered, stats, verdict }

export const TIMING = Object.freeze({
  sendAt: [0, 100, 200], // producer emits the three events at these virtual ms
  latencyMs: 50,         // one-way delivery time for a healthy attempt
  timeoutMs: 2000,       // sender gives up waiting for an ack after this long
  backoffBaseMs: 1000,
});

export const DEFAULT_SAFEGUARDS = Object.freeze({
  retryLimit: 3,             // retries after the first attempt
  backoff: 'exponential',    // 'none' | 'fixed' | 'exponential'
  idempotency: false,        // dedupe on eventId
  ordering: false,           // buffer ahead-of-sequence events, drop stale ones
  schemaValidation: false,   // reject payloads missing required fields
  deadLetter: true,          // park messages that give up instead of dropping them
});

const CLAIM_ID = 'C-1001';
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

export function run(scenario, overrides = {}) {
  const failures = scenario.failures ?? {};
  const guards = { ...DEFAULT_SAFEGUARDS, ...scenario.safeguards, ...overrides };
  const events = claimEvents();
  const byType = Object.fromEntries(events.map(e => [e.type, e]));

  if (failures.schemaChange) {
    const e = byType[failures.schemaChange.event];
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

  // Returns 'ack' or 'reject'. Every non-rejected delivery is acked, including duplicates and buffered events.
  function receive(t, e) {
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
      dlq.push({ eventId: e.eventId, eventType: e.type, reason, attempts: attempt });
      log(t, 'queue', 'dead-letter', e, { attempt, note: reason });
    } else {
      dropped.push({ eventId: e.eventId, eventType: e.type, reason, attempts: attempt });
      log(t, 'queue', 'drop', e, { attempt, note: `${reason}; no dead-letter queue` });
    }
  }

  function send(t, e, attempt) {
    stats.attempts++;
    if (attempt > 1) stats.retries++;
    log(t, 'queue', 'send', e, { attempt });
    const onTimeout = () => {
      stats.timeouts++;
      log(t + TIMING.timeoutMs, 'queue', 'timeout', e, { attempt });
      if (attempt <= guards.retryLimit) {
        const wait = backoffMs(guards.backoff, attempt);
        log(t + TIMING.timeoutMs, 'queue', 'retry-scheduled', e, { attempt, note: `retry in ${wait} ms` });
        at(t + TIMING.timeoutMs + wait, now => send(now, e, attempt + 1));
      } else {
        giveUp(t + TIMING.timeoutMs, e, attempt, `retry limit (${guards.retryLimit}) reached`);
      }
    };

    if (timesOut(e, attempt)) {
      at(t + TIMING.timeoutMs, onTimeout);
      return;
    }
    const arrival = t + TIMING.latencyMs + extraDelay(e, attempt);
    at(arrival, now => {
      const outcome = receive(now, e);
      if (outcome === 'reject') {
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

  const buffered = [...buffer.values()].map(e => ({ eventId: e.eventId, eventType: e.type, seq: e.seq }));
  const verdict = judge(record, { dlq, dropped, buffered });
  return { trace, record, expected: EXPECTED_RECORD, dlq, dropped, buffered, stats, guards, verdict };
}

const dollars = cents => `$${(cents / 100).toFixed(2)}`;
const typeOf = id => claimEvents().find(e => e.eventId === id).type;

export function judge(record, { dlq = [], dropped = [], buffered = [] } = {}) {
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
