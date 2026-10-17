// The normalised outcome both sides of the differential test produce, and the diff between them.
// Timings are left out: the engine runs on a virtual clock and the Java runner on wall-clock ms, so only
// what a run ends with is compared. DifferentialRunner.java writes the same shape.
import { run } from '../../engine/engine.js';

const ids = entries => entries.map(e => e.eventId);

// { record, dlq, dropped, buffered, verdict } with event ids only, or { error } when the scenario is refused.
export function normalise({ record, dlq, dropped, buffered, verdict }) {
  return {
    record: { status: record.status, paidCents: record.paidCents, applied: [...record.applied] },
    dlq: ids(dlq),
    dropped: ids(dropped),
    buffered: ids(buffered),
    verdict: { ok: verdict.ok, visible: verdict.visible, problems: [...verdict.problems] },
  };
}

export function engineOutcome(combination) {
  try {
    return normalise(run(combination));
  } catch (error) {
    return { error: error.message };
  }
}

// Key-order-independent JSON, so outcomes compare equal whatever order each side wrote their fields in.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The top-level fields where two outcomes differ, e.g. ['record', 'verdict'].
export function differingFields(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.filter(k => canonical(a[k]) !== canonical(b[k]));
}

// Splits mismatches into those an owner-decided divergence in known.json explains (it lists the combination id)
// and those nothing explains. A listed id whose outcomes now agree is stale: the divergence is gone for it.
export function compare(combinations, engineOutcomes, javaOutcomes, known = []) {
  const explained = [];
  const unexplained = [];
  const stale = [];
  const knownFor = id => known.find(k => k.combinations.includes(id));
  for (const combination of combinations) {
    const engine = engineOutcomes.get(combination.id);
    const java = javaOutcomes.get(combination.id);
    const entry = knownFor(combination.id);
    if (java === undefined) {
      unexplained.push({ combination, engine, java: { error: 'missing from the Java output' }, fields: ['missing'] });
      continue;
    }
    const fields = differingFields(engine, java);
    if (!fields.length) {
      if (entry) stale.push({ known: entry, id: combination.id });
      continue;
    }
    const mismatch = { combination, engine, java, fields };
    if (entry) explained.push({ ...mismatch, known: entry });
    else unexplained.push(mismatch);
  }
  return { explained, unexplained, stale };
}
