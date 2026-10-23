// Free-form combinations for differential testing: every scenario a visitor can build, plus the poison
// failure and replayAfterFix that Guided scenarios reach. Pure and seeded, so every run sees the same list.
// combinations() -> [{ id, failures, safeguards }], shaped like scenarios/*.json for engine.run() and the Java runner.
import { DEFAULT_SAFEGUARDS, TIMING } from '../../engine/engine.js';

export const EVENT_TYPES = ['ClaimSubmitted', 'ClaimAccepted', 'ClaimPaid'];
// The Free-form timeout choices in ui/lab.js (TIMEOUT_ATTEMPTS).
const TIMEOUT_ATTEMPTS = { first: [1], two: [1, 2], all: 'all' };
const RETRY_LIMITS = [0, 1, 2, 3, 4, 5];
const BACKOFFS = ['exponential', 'fixed', 'none'];
const TOGGLES = ['idempotency', 'ordering', 'schemaValidation', 'deadLetter', 'replayAfterFix'];
export const SEED = 93;
export const RANDOM_SAMPLE = 150;

const SHORT = { ClaimSubmitted: 'submitted', ClaimAccepted: 'accepted', ClaimPaid: 'paid' };

// Every single-failure setting, grouped by kind: one entry per (kind, target event[, attempts]).
export function failureSettings() {
  const settings = [];
  for (const event of EVENT_TYPES) {
    for (const [name, attempts] of Object.entries(TIMEOUT_ATTEMPTS)) {
      settings.push({ kind: 'timeout', label: `timeout-${SHORT[event]}-${name}`, value: { event, attempts } });
    }
  }
  for (const event of EVENT_TYPES) settings.push({ kind: 'duplicate', label: `ackloss-${SHORT[event]}`, value: { event } });
  for (const event of EVENT_TYPES) settings.push({ kind: 'reorder', label: `reorder-${SHORT[event]}`, value: { event, delayMs: TIMING.reorderDelayMs } });
  for (const event of EVENT_TYPES) settings.push({ kind: 'schemaChange', label: `schema-${SHORT[event]}`, value: { event } });
  for (const event of EVENT_TYPES) settings.push({ kind: 'poison', label: `poison-${SHORT[event]}`, value: { event } });
  return settings;
}

// Every single-safeguard change from DEFAULT_SAFEGUARDS: each other retry limit and backoff, and each toggle flipped.
export function safeguardToggles() {
  const toggles = [];
  for (const n of RETRY_LIMITS) if (n !== DEFAULT_SAFEGUARDS.retryLimit) toggles.push({ retryLimit: n });
  for (const b of BACKOFFS) if (b !== DEFAULT_SAFEGUARDS.backoff) toggles.push({ backoff: b });
  for (const t of TOGGLES) toggles.push({ [t]: !DEFAULT_SAFEGUARDS[t] });
  return toggles;
}

function safeguardLabel(safeguards) {
  const parts = [];
  for (const [k, v] of Object.entries(safeguards)) {
    if (v === DEFAULT_SAFEGUARDS[k]) continue;
    if (k === 'retryLimit') parts.push(`retry${v}`);
    else if (k === 'backoff') parts.push(`backoff-${v}`);
    else parts.push(v ? k : `no-${k}`);
  }
  return parts.length ? parts.join('+') : 'defaults';
}

function combo(settings, safeguards) {
  const failures = {};
  for (const s of settings) failures[s.kind] = s.value;
  const full = { ...DEFAULT_SAFEGUARDS, ...safeguards };
  const label = settings.length ? settings.map(s => s.label).join('+') : 'no-failures';
  return { id: `${label}__${safeguardLabel(full)}`, failures, safeguards: full };
}

// mulberry32: small, fast and reproducible across Node versions.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function combinations({ seed = SEED, sample = RANDOM_SAMPLE } = {}) {
  const settings = failureSettings();
  const toggles = safeguardToggles();
  const out = new Map();
  const add = c => { if (!out.has(c.id)) out.set(c.id, c); };

  // Baselines: no failure under the defaults and under each safeguard change.
  add(combo([], {}));
  for (const t of toggles) add(combo([], t));
  // All pairs of (failure kind x target event) x safeguard change, plus each failure under the defaults.
  for (const s of settings) {
    add(combo([s], {}));
    for (const t of toggles) add(combo([s], t));
  }
  // All pairs of failure settings of different kinds, under the defaults.
  for (let i = 0; i < settings.length; i++) {
    for (let j = i + 1; j < settings.length; j++) {
      if (settings[i].kind !== settings[j].kind) add(combo([settings[i], settings[j]], {}));
    }
  }
  // Seeded 3-way sample: three failure kinds on random targets, with every safeguard drawn at random.
  const random = prng(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const kinds = [...new Set(settings.map(s => s.kind))];
  for (let n = 0; n < sample; n++) {
    const shuffled = [...kinds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const chosen = shuffled.slice(0, 3).map(kind => pick(settings.filter(s => s.kind === kind)));
    const safeguards = { retryLimit: pick(RETRY_LIMITS), backoff: pick(BACKOFFS) };
    for (const t of TOGGLES) safeguards[t] = random() < 0.5;
    add(combo(chosen.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind)), safeguards));
  }
  return [...out.values()];
}
