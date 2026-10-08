// Browser UI for the integration failure lab. Mount with mountLab(element, { headingLevel }).
// headingLevel (2-6, default 3) sets the scenario title's heading so it nests under the host page's outline.
// Uses the pure engine; everything runs client-side on a virtual clock.
import { run, judge, DEFAULT_SAFEGUARDS, EXPECTED_RECORD, TIMING } from './engine.js';
import { SCENARIOS } from './scenarios.js';
import { EXECUTED } from './executed.js';

const MODE_KEY = 'ifl-mode';
const SOURCE_KEY = 'ifl-source';
const EVENT_TYPES = ['ClaimSubmitted', 'ClaimAccepted', 'ClaimPaid'];
const dollars = cents => `$${(cents / 100).toFixed(2)}`;
const secs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 ? 2 : 0)} s` : `${ms} ms`);

function readPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: choice lasts for this page view */ }
}

const SIM_NOTE = `Simulated in your browser with synthetic data on a virtual clock (${TIMING.timeoutMs / 1000} s ack timeout, ${TIMING.latencyMs} ms delivery). Not a real payer or claims system.`;

function executedResult(id) {
  const x = EXECUTED[id];
  if (!x) return null;
  const verdict = judge(x.record, { dlq: x.dlq, dropped: x.dropped, buffered: x.buffered });
  const note = `Recorded from a real run: Spring Boot ${x.runtime.springBoot} on Java ${x.runtime.java.split('+')[0]}, ${x.runtime.transport}. `
    + `Shorter wall-clock timings (${x.timing.timeoutMs} ms ack timeout, ${x.timing.backoffBaseMs} ms backoff base), replayed here. Synthetic data.`;
  return { ...x, expected: EXPECTED_RECORD, verdict, note };
}
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function describe(row, timeoutMs = TIMING.timeoutMs) {
  const e = row.eventType;
  switch (row.kind) {
    case 'emit': return `Producer emits ${e} (seq ${row.seq})`;
    case 'send': return row.attempt === 1 ? `Queue delivers ${e}` : `Queue retries ${e} (attempt ${row.attempt})`;
    case 'timeout': return `No ack for ${e} within ${secs(timeoutMs)}`;
    case 'retry-scheduled': return `Backing off: ${row.note}`;
    case 'dead-letter': return `${e} parked in the dead-letter queue (${row.note})`;
    case 'drop': return `${e} dropped (${row.note})`;
    case 'apply': return `Claim updated: status ${row.status}, paid ${dollars(row.paidCents)}`;
    case 'ack': return `Ack for ${e} received`;
    case 'ack-lost': return `${e} was applied, but its ack was lost`;
    case 'dedupe': return `${e} already seen: skipped`;
    case 'stale': return `${e} is stale: skipped`;
    case 'buffer': return `${e} arrived early: buffered (${row.note})`;
    case 'release': return `${e} released from the buffer`;
    case 'replay': return `Operator replays ${e} from the dead-letter queue (${row.note})`;
    case 'reject': return `${e} rejected (${row.note})`;
    default: return `${row.kind} ${e ?? ''}`;
  }
}

const TONE = {
  timeout: 'warn', 'retry-scheduled': 'warn', 'ack-lost': 'bad', 'dead-letter': 'bad', drop: 'bad', reject: 'bad', replay: 'guard',
  apply: 'good', dedupe: 'guard', stale: 'guard', buffer: 'guard', release: 'guard',
};

function failureTags(f = {}) {
  const tags = [];
  if (f.timeout) tags.push(`${f.timeout.event} times out ${f.timeout.attempts === 'all' ? 'on every attempt' : `on attempt ${f.timeout.attempts.join(' and ')}`}`);
  if (f.duplicate) tags.push(`ack lost for ${f.duplicate.event}`);
  if (f.reorder) tags.push(`${f.reorder.event} delayed ${f.reorder.delayMs} ms`);
  if (f.poison) tags.push(`${f.poison.event}: amount shipped as text (poison message)`);
  if (f.schemaChange) tags.push(`${f.schemaChange.event}: paidAmount renamed`);
  return tags.length ? tags : ['no failures'];
}

function guardTags(g) {
  const s = { ...DEFAULT_SAFEGUARDS, ...g };
  return [
    s.retryLimit ? `${s.retryLimit} retries, ${s.backoff} backoff` : 'no retries',
    s.deadLetter ? 'dead-letter queue' : 'no dead-letter queue',
    s.idempotency && 'idempotent consumer',
    s.ordering && 'ordered consumer',
    s.schemaValidation && 'schema validation',
    s.replayAfterFix && 'replay after fix',
  ].filter(Boolean);
}

export function mountLab(root, { headingLevel = 3 } = {}) {
  const level = Math.min(6, Math.max(2, Math.trunc(Number(headingLevel)) || 3));
  root.classList.add('ifl');
  root.replaceChildren();
  const state = { mode: readPref(MODE_KEY), source: readPref(SOURCE_KEY) === 'exec' ? 'exec' : 'sim', index: 0, playing: null };

  const header = h('div', { class: 'ifl-bar' });
  const body = h('div', { class: 'ifl-body' });
  const output = h('div', { class: 'ifl-output', hidden: true });
  root.append(header, body, output);

  function setMode(mode) {
    state.mode = mode;
    savePref(MODE_KEY, mode);
    render();
    body.querySelector('button, input, select')?.focus();
  }

  // Re-rendering replaces the clicked control, so move focus to its replacement instead of losing it to <body>.
  function refocus(...selectors) {
    for (const sel of selectors) {
      const el = body.querySelector(sel);
      if (el) { el.focus(); return; }
    }
  }

  function renderPicker() {
    header.replaceChildren(h('p', { class: 'ifl-kicker' }, 'How do you want to explore?'));
    const card = (mode, title, text) => h('button', { type: 'button', class: 'ifl-pick', onclick: () => setMode(mode) },
      h('strong', {}, title), h('span', {}, text));
    body.replaceChildren(h('div', { class: 'ifl-picker' },
      card('guided', 'Guided', 'Walk through ten failures one at a time. Each shows what broke and which safeguard fixes it.'),
      card('free', 'Free-form', 'Pick the failures and the safeguards yourself, then see what happens to the claim.'),
    ));
    output.hidden = true;
  }

  function modeSwitch() {
    const other = state.mode === 'guided' ? 'free' : 'guided';
    return h('button', { type: 'button', class: 'ifl-link', onclick: () => setMode(other) },
      `Switch to ${other === 'guided' ? 'guided' : 'free-form'}`);
  }

  function renderGuided() {
    const s = SCENARIOS[state.index];
    header.replaceChildren(
      h('p', { class: 'ifl-kicker' }, `Guided · scenario ${state.index + 1} of ${SCENARIOS.length}`),
      modeSwitch(),
    );
    const chips = h('div', { class: 'ifl-chips', role: 'group', 'aria-label': 'Scenarios' },
      SCENARIOS.map((sc, i) => h('button', {
        type: 'button', class: 'ifl-chip', 'aria-current': i === state.index ? 'step' : null,
        'aria-label': `${sc.id.split('-')[0]}: ${sc.title}`, title: sc.title,
        onclick: () => { state.index = i; render(); refocus('.ifl-chip[aria-current]'); },
      }, sc.id.split('-')[0])));
    const step = (by, cls) => () => { state.index += by; render(); refocus(`.${cls}:not([disabled])`, '.ifl-chip[aria-current]'); };
    const prev = h('button', { type: 'button', class: 'ifl-link ifl-prev', disabled: state.index === 0, onclick: step(-1, 'ifl-prev') }, '← Previous');
    const next = h('button', { type: 'button', class: 'ifl-link ifl-next', disabled: state.index === SCENARIOS.length - 1, onclick: step(1, 'ifl-next') }, 'Next →');
    body.replaceChildren(
      chips,
      h(`h${level}`, { class: 'ifl-title' }, s.title),
      h('p', { class: 'ifl-summary' }, s.summary),
      h('div', { class: 'ifl-tags' },
        h('span', { class: 'ifl-tag-label' }, 'Failures'), failureTags(s.failures).map(t => h('span', { class: 'ifl-tag ifl-tag-fail' }, t))),
      h('div', { class: 'ifl-tags' },
        h('span', { class: 'ifl-tag-label' }, 'Safeguards'), guardTags(s.safeguards).map(t => h('span', { class: 'ifl-tag' }, t))),
      sourceToggle(s.id),
      h('div', { class: 'ifl-actions' },
        h('button', { type: 'button', class: 'button ifl-run', onclick: () => runGuided(s) },
          state.source === 'exec' && EXECUTED[s.id] ? 'Replay real run ' : 'Run scenario ', h('span', { 'aria-hidden': 'true' }, '→')),
        h('span', { class: 'ifl-nav' }, prev, next)),
    );
    output.hidden = true;
  }

  function runGuided(s) {
    const exec = state.source === 'exec' ? executedResult(s.id) : null;
    if (exec) play(exec, s.lesson, exec.note);
    else play(run(s), s.lesson, SIM_NOTE);
  }

  function sourceToggle(id) {
    if (!EXECUTED[id]) return null;
    const option = (value, label) => h('button', {
      type: 'button', class: 'ifl-seg', 'aria-pressed': String(state.source === value),
      onclick: () => { state.source = value; savePref(SOURCE_KEY, value); render(); refocus('.ifl-seg[aria-pressed="true"]'); },
    }, label);
    return h('div', { class: 'ifl-source', role: 'group', 'aria-label': 'Run source' },
      h('span', { class: 'ifl-tag-label' }, 'Engine'),
      option('sim', 'Simulated in browser'),
      option('exec', 'Executed: Java / Spring'));
  }

  function renderFree() {
    header.replaceChildren(h('p', { class: 'ifl-kicker' }, 'Free-form'), modeSwitch());
    const eventSelect = (name, selected, label) => h('select', { name, 'aria-label': label },
      EVENT_TYPES.map(t => h('option', { value: t, selected: t === selected }, t)));
    const check = (name, label, checked = false) => h('label', { class: 'ifl-check' },
      h('input', { type: 'checkbox', name, checked }), h('span', {}, label));

    const form = h('form', { class: 'ifl-form', onsubmit: ev => { ev.preventDefault(); play(fromForm(form), null, SIM_NOTE); } },
      h('fieldset', {}, h('legend', {}, 'Break something'),
        h('div', { class: 'ifl-row' }, check('timeout', 'Downstream times out on'), eventSelect('timeoutEvent', 'ClaimPaid', 'Event that times out'),
          h('select', { name: 'timeoutAttempts', 'aria-label': 'Which attempts time out' },
            h('option', { value: 'first' }, 'the first attempt'),
            h('option', { value: 'two' }, 'the first two attempts'),
            h('option', { value: 'all' }, 'every attempt'))),
        h('div', { class: 'ifl-row' }, check('duplicate', 'Ack lost for'), eventSelect('duplicateEvent', 'ClaimPaid', 'Event whose ack is lost')),
        h('div', { class: 'ifl-row' }, check('reorder', 'Delay'), eventSelect('reorderEvent', 'ClaimAccepted', 'Event to delay'), h('span', {}, 'by 500 ms')),
        h('div', { class: 'ifl-row' }, check('schemaChange', 'Producer renames paidAmount on ClaimPaid'))),
      h('fieldset', {}, h('legend', {}, 'Protect it'),
        h('div', { class: 'ifl-row' },
          h('label', { class: 'ifl-inline' }, 'Retries ',
            h('select', { name: 'retryLimit' }, [0, 1, 2, 3, 4, 5].map(n => h('option', { value: n, selected: n === 3 }, n)))),
          h('label', { class: 'ifl-inline' }, 'Backoff ',
            h('select', { name: 'backoff' }, ['exponential', 'fixed', 'none'].map(b => h('option', { value: b }, b))))),
        check('deadLetter', 'Dead-letter queue', true),
        check('idempotency', 'Idempotent consumer (dedupe on eventId)'),
        check('ordering', 'Ordered consumer (buffer early events)'),
        check('schemaValidation', 'Validate the payload schema')),
      h('div', { class: 'ifl-actions' }, h('button', { type: 'submit', class: 'button ifl-run' }, 'Run ', h('span', { 'aria-hidden': 'true' }, '→'))),
    );
    body.replaceChildren(form);
    output.hidden = true;
  }

  function fromForm(form) {
    const f = new FormData(form);
    const on = name => f.get(name) === 'on';
    const failures = {};
    if (on('timeout')) {
      const a = f.get('timeoutAttempts');
      failures.timeout = { event: f.get('timeoutEvent'), attempts: a === 'all' ? 'all' : a === 'two' ? [1, 2] : [1] };
    }
    if (on('duplicate')) failures.duplicate = { event: f.get('duplicateEvent') };
    if (on('reorder')) failures.reorder = { event: f.get('reorderEvent'), delayMs: 500 };
    if (on('schemaChange')) failures.schemaChange = { event: 'ClaimPaid' };
    return run({ failures }, {
      retryLimit: Number(f.get('retryLimit')), backoff: f.get('backoff'), deadLetter: on('deadLetter'),
      idempotency: on('idempotency'), ordering: on('ordering'), schemaValidation: on('schemaValidation'),
    });
  }

  function play(result, lesson, note) {
    if (state.playing) clearInterval(state.playing);
    output.hidden = false;
    const list = h('ol', { class: 'ifl-trace' });
    // The trace scrolls, so its container must be reachable and named for keyboard and screen reader users.
    const scroller = h('div', { class: 'ifl-trace-scroll', role: 'region', 'aria-label': 'Event trace', tabindex: '0' }, list);
    const counters = { attempts: 0, retries: 0, timeouts: 0, parked: 0 };
    const counterEls = Object.fromEntries(Object.keys(counters).map(k => [k, h('strong', {}, '0')]));
    const clock = h('span', { class: 'ifl-clock' }, '0 ms');
    const stats = h('div', { class: 'ifl-stats' },
      h('span', {}, result.timing ? 'Wall-clock time ' : 'Virtual time ', clock),
      h('span', {}, 'Attempts ', counterEls.attempts),
      h('span', {}, 'Retries ', counterEls.retries),
      h('span', {}, 'Timeouts ', counterEls.timeouts),
      h('span', {}, 'Parked / dropped events ', counterEls.parked));
    const verdictBox = h('div', { class: 'ifl-verdict', role: 'status' });
    const finalState = h('div', { class: 'ifl-final-state', hidden: true });
    output.replaceChildren(
      h('p', { class: 'ifl-kicker' }, 'Trace'),
      stats, scroller, verdictBox, finalState,
      h('p', { class: 'ifl-note' }, note));

    const rows = result.trace;
    const addRow = row => {
      if (row.kind === 'send') { counters.attempts++; if (row.attempt > 1) counters.retries++; }
      if (row.kind === 'timeout') counters.timeouts++;
      if (row.kind === 'dead-letter' || row.kind === 'drop') counters.parked++;
      for (const k of Object.keys(counters)) counterEls[k].textContent = counters[k];
      clock.textContent = secs(row.t);
      list.append(h('li', { class: `ifl-${row.actor} ifl-${TONE[row.kind] ?? 'plain'}` },
        h('span', { class: 'ifl-t' }, secs(row.t)),
        h('span', { class: 'ifl-actor' }, row.actor),
        h('span', { class: 'ifl-msg' }, describe(row, result.timing?.timeoutMs))));
      scroller.scrollTop = scroller.scrollHeight;
    };
    const finish = () => {
      state.playing = null;
      renderVerdict(verdictBox, result, lesson);
      renderFinalState(finalState, result);
    };

    if (reducedMotion()) { rows.forEach(addRow); finish(); return; }
    let i = 0;
    const step = Math.max(40, Math.min(160, 2800 / rows.length));
    state.playing = setInterval(() => {
      if (i < rows.length) addRow(rows[i++]);
      else { clearInterval(state.playing); finish(); }
    }, step);
    output.scrollIntoView?.({ block: 'nearest' });
  }

  function renderFinalState(box, result) {
    const field = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
    const group = (name, entries, buffered = false) => h('section', { class: 'ifl-final-group', 'aria-label': name },
      h(`h${Math.min(6, level + 1)}`, {}, name, ' (', entries.length, ')'),
      entries.length ? h('ul', {}, entries.map(entry => h('li', {}, h('dl', {},
        field('Event ID', entry.eventId), field('Event type', entry.eventType),
        buffered ? field('Sequence', entry.seq) : [field('Reason', entry.reason), field('Delivery attempts', entry.attempts)],
      )))) : h('p', { class: 'ifl-empty' }, 'Empty'),
    );
    box.replaceChildren(
      h('p', { class: 'ifl-kicker' }, 'Final state'),
      h('p', { class: 'ifl-note' }, 'Snapshots after the run. Trace counters above count historical events.'),
      group('Dead-letter queue', result.dlq),
      group('Dropped messages', result.dropped),
      group('Ordering buffer', result.buffered, true),
    );
    box.hidden = false;
  }

  function renderVerdict(box, result, lesson) {
    const { record, expected, verdict } = result;
    const cell = (a, b, fmt = x => x) => h('td', { class: a === b ? '' : 'ifl-diff' }, fmt(a ?? '—'));
    const applied = r => r.applied.length ? r.applied.join(' → ') : 'none';
    box.className = `ifl-verdict ${verdict.ok ? 'ifl-ok' : verdict.visible ? 'ifl-visible' : 'ifl-silent'}`;
    box.replaceChildren(...[
      h('p', { class: 'ifl-verdict-head' }, verdict.summary),
      verdict.problems.length ? h('ul', {}, verdict.problems.map(p => h('li', {}, p))) : null,
      h('table', { class: 'ifl-record' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Claim C-1001'), h('th', {}, 'Expected'), h('th', {}, 'Observed'))),
        h('tbody', {},
          h('tr', {}, h('th', {}, 'Status'), h('td', {}, expected.status), cell(record.status, expected.status)),
          h('tr', {}, h('th', {}, 'Paid'), h('td', {}, dollars(expected.paidCents)), cell(record.paidCents, expected.paidCents, dollars)),
          h('tr', {}, h('th', {}, 'Events applied'), h('td', {}, applied(expected)), cell(applied(record), applied(expected))))),
      lesson ? h('p', { class: 'ifl-lesson' }, h('strong', {}, 'Lesson: '), lesson) : null,
      !lesson && !verdict.ok ? hint(result) : null,
    ].filter(Boolean));
  }

  function hint({ verdict, guards, dlq }) {
    const tips = [];
    const has = text => verdict.problems.some(p => p.includes(text));
    if (has('times') && !guards.idempotency) tips.push('turn on the idempotent consumer');
    if ((has('out of order') || has('final status')) && !guards.ordering && !dlq.length) tips.push('turn on the ordered consumer');
    if (has('paid $0.00') && !dlq.length && !guards.schemaValidation) tips.push('validate the payload schema, so the bad message fails loudly');
    if (has('never applied') && !dlq.length && !guards.deadLetter) tips.push('turn on the dead-letter queue, so lost messages are at least visible');
    if (has('never applied') && guards.retryLimit < 3) tips.push('allow more retries');
    if (has('stuck in the ordering buffer')) tips.push('an ordered consumer needs a timeout for gaps that never fill; this demo leaves it stuck on purpose');
    if (!tips.length) return null;
    return h('p', { class: 'ifl-lesson' }, h('strong', {}, 'Try: '), tips.join('; '), '.');
  }

  function render() {
    output.replaceChildren();
    output.hidden = true;
    if (state.playing) { clearInterval(state.playing); state.playing = null; }
    if (state.mode === 'guided') renderGuided();
    else if (state.mode === 'free') renderFree();
    else renderPicker();
  }

  render();
  return { setMode };
}
