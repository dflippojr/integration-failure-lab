// Scenario validation, Node-only (#196): the tests, the build (scripts/scenarios.mjs) and the differential use it.
// scripts/build.mjs does not ship it, because no browser path can give run() a scenario that breaks a rule: Guided runs
// the shipped scenarios, which the build checks here, and Free-form builds its scenario from fixed control values.
// refusal(scenario, overrides?) -> { rule, reason } for the first rule it breaks, or null.
// checkedRun(scenario, overrides?) -> run(scenario, overrides), or throws `Scenario <id>: <reason>` carrying `rule`.
import { run, BACKOFFS, DEFAULT_SAFEGUARDS, EVENT_TYPES, RETRY_LIMITS, TIMING } from './engine.js';

export const FAILURE_KINDS = Object.freeze(['timeout', 'duplicate', 'reorder', 'schemaChange', 'poison']);

// A whole number the Java runner can hold as an int attempt, from 1 to 2^31 - 1 (Scenario.positiveInteger).
export const attemptNumber = n => Number.isInteger(n) && n > 0 && n <= 2 ** 31 - 1;

// The first rule this scenario breaks, or null. Scenario.fromMap checks the same rules in the same order (#198), so both
// runtimes name the same rule: `rule` is a stable id, the field path for a single-field rule (`safeguards.backoff`) and
// SAME_EVENT_RULE for the one cross-field rule. The differential compares that id. `reason` is this runtime's own
// wording, with values as String() shows them; the Java runner words its reasons its own way.
export const SAME_EVENT_RULE = 'failures.poison+schemaChange';

export function refusal(scenario, overrides = {}) {
  const failures = scenario.failures ?? {};
  const safeguards = scenario.safeguards ?? {};
  const guards = { ...DEFAULT_SAFEGUARDS, ...safeguards, ...overrides };
  // String() throws on an object whose own toString is not a function, so objects and lists are spelled out.
  const shown = value => (Array.isArray(value) ? value.map(e => (e == null ? '' : shown(e))).join() : value && typeof value === 'object' ? '[object Object]' : String(value));
  const unsupported = (path, value, expected) => ({ rule: path, reason: `Unsupported ${path} "${shown(value ?? null)}"; expected ${expected}` });
  for (const [path, section] of Object.entries({ failures, safeguards })) {
    if (typeof section !== 'object' || Array.isArray(section)) return unsupported(path, section, 'an object');
  }
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
    return { rule: SAME_EVENT_RULE, reason: `failures.poison and failures.schemaChange cannot target the same event (${failures.poison.event})` };
  }
  if (!BACKOFFS.includes(guards.backoff)) return unsupported('safeguards.backoff', guards.backoff, `one of ${BACKOFFS.join(', ')}`);
  if (!RETRY_LIMITS.includes(guards.retryLimit)) return unsupported('safeguards.retryLimit', guards.retryLimit, 'a whole number from 0 to 5');
  for (const [name, initial] of Object.entries(DEFAULT_SAFEGUARDS)) {
    if (typeof initial === 'boolean' && typeof guards[name] !== 'boolean') return unsupported(`safeguards.${name}`, guards[name], 'true or false');
  }
  return null;
}

// run() for callers that can pass arbitrary input: each refusal is checked before anything is scheduled. The error
// carries the rule id, which the differential compares, and the reason in its message.
export function checkedRun(scenario, overrides = {}) {
  const refused = refusal(scenario, overrides);
  if (refused) throw Object.assign(new Error(`Scenario ${scenario.id}: ${refused.reason}`), { rule: refused.rule });
  return run(scenario, overrides);
}
