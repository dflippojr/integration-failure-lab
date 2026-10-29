// UI accessibility checks for ui/lab.js, run with freshly generated scenario modules and a minimal fake DOM (no dependencies).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.classList = { add: c => { this.className = `${this.className} ${c}`.trim(); } };
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'hidden') this.hidden = true; }
  removeAttribute(k) { delete this.attributes[k]; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  focus() { globalThis.__focused = this; }
  all() { return this.children.flatMap(c => (c instanceof FakeElement ? [c, ...c.all()] : [])); }
  querySelector(sel) { return this.all().find(e => sel.split(',').some(s => (s.trim().startsWith('.') ? e.className.split(' ').includes(s.trim().slice(1)) : e.tagName === s.trim().toUpperCase()))) ?? null; }
  find(pred) { return this.all().filter(pred); }
  text() { return this.children.map(c => (c instanceof FakeElement ? c.text() : String(c))).join(''); }
}

let mountLab, SCENARIOS, EXECUTED, RECORDING_IDS, describe, toFormValues, formScenario;
import { run, judge, DEFAULT_SAFEGUARDS } from '../engine/engine.js';
import { failureSettings, safeguardToggles } from './differential/combos.mjs';
import { canonical } from './differential/outcome.mjs';
before(async () => {
  globalThis.Node = FakeElement;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.window = { matchMedia: () => ({ matches: true }) }; // reduced motion: traces render synchronously
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build.mjs', import.meta.url)), 'test']);
  // Import the source ui/lab.js, not a built copy, so coverage lands on it; see lab-loader.mjs.
  register('./lab-loader.mjs', import.meta.url);
  ({ mountLab, describe, toFormValues, formScenario } = await import('../ui/lab.js'));
  ({ SCENARIOS, RECORDING_IDS } = await import('../dist-test/scenarios.js'));
  ({ EXECUTED } = await import('../dist-test/executed.js'));
  globalThis.__loadRecordings = () => EXECUTED;
});

const mount = (opts, mode) => {
  const root = new FakeElement('div');
  const lab = mountLab(root, opts);
  lab.setMode(mode);
  return root;
};
const headings = root => root.find(e => /^H[1-6]$/.test(e.tagName));

test('scenario title defaults to h3 so it nests under a host h2', () => {
  const [title] = headings(mount(undefined, 'guided'));
  assert.equal(title.tagName, 'H3');
});

test('headingLevel option sets the scenario title level, clamped to 2-6', () => {
  assert.equal(headings(mount({ headingLevel: 2 }, 'guided'))[0].tagName, 'H2');
  assert.equal(headings(mount({ headingLevel: 5 }, 'guided'))[0].tagName, 'H5');
  assert.equal(headings(mount({ headingLevel: 1 }, 'guided'))[0].tagName, 'H2');
  assert.equal(headings(mount({ headingLevel: 9 }, 'guided'))[0].tagName, 'H6');
  assert.equal(headings(mount({ headingLevel: 'x' }, 'guided'))[0].tagName, 'H3');
});

test('scenario chips have descriptive accessible names that start with their visible text', () => {
  const chips = mount(undefined, 'guided').find(e => e.className === 'ifl-chip');
  assert.equal(chips.length, 12);
  for (const chip of chips) {
    const name = chip.getAttribute('aria-label');
    assert.ok(name.startsWith(`${chip.text()}: `), name);
    assert.ok(name.length > chip.text().length + 10, name);
  }
});

const byClass = (root, name) => root.find(e => e.className === name)[0];
const clickRun = root => root.find(e => e.className.includes('ifl-run'))[0].listeners.click();
const chooseScenario = (root, id) => root.find(e => e.className === 'ifl-chip' && e.text() === id)[0].listeners.click();
const chooseSource = (root, source) => root.find(e => e.className === 'ifl-seg' && e.text().startsWith(source === 'sim' ? 'Simulated' : 'Executed'))[0].listeners.click();

function assertFinal(root, result) {
  const panel = byClass(root, 'ifl-final-state');
  assert.equal(panel.hidden, false);
  const groups = panel.find(e => e.tagName === 'SECTION');
  assert.equal(groups.length, 3);
  for (const [i, [name, key]] of [['Dead-letter queue', 'dlq'], ['Dropped messages', 'dropped'], ['Ordering buffer', 'buffered']].entries()) {
    const group = groups[i];
    const entries = result[key];
    assert.equal(group.getAttribute('aria-label'), name);
    assert.equal(headings(group)[0].text(), `${name} (${entries.length})`);
    const items = group.find(e => e.tagName === 'LI');
    assert.equal(items.length, entries.length);
    if (!entries.length) assert.equal(byClass(group, 'ifl-empty').text(), 'Empty');
    else {
      assert.equal(group.children[1].tagName, 'UL');
      for (const [j, entry] of entries.entries()) {
        const fields = items[j].find(e => e.tagName === 'DL')[0].children;
        assert.deepEqual(fields.map(f => f.children.map(c => c.text())), [
          ['Event ID', entry.eventId], ['Event type', entry.eventType],
          ...(key === 'buffered' ? [['Sequence', String(entry.seq)]] : [['Reason', entry.reason], ['Delivery attempts', String(entry.attempts)]]),
        ]);
      }
    }
  }
}

// Advance actual playback callbacks deterministically without waiting on wall time.
async function animated(fn) {
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers = new Map();
  let id = 0;
  globalThis.window.matchMedia = () => ({ matches: false });
  globalThis.setInterval = callback => { timers.set(++id, callback); return id; };
  globalThis.clearInterval = timer => timers.delete(timer);
  const drain = () => {
    for (let ticks = 0; timers.size && ticks < 1000; ticks++) {
      for (const callback of [...timers.values()]) callback();
    }
    assert.equal(timers.size, 0);
  };
  try { await fn(drain, timers); }
  finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    globalThis.window.matchMedia = () => ({ matches: true });
  }
}

test('free-form displays the blocked ordering buffer fixture', () => {
  const root = mount(undefined, 'free');
  const form = byClass(root, 'ifl-form');
  const OriginalFormData = globalThis.FormData;
  const values = { timeout: 'on', timeoutEvent: 'ClaimAccepted', timeoutAttempts: 'all', retryLimit: '3', backoff: 'exponential', deadLetter: 'on', ordering: 'on' };
  globalThis.FormData = class { get(name) { return values[name] ?? null; } };
  try { form.listeners.submit({ preventDefault() {} }); }
  finally { globalThis.FormData = OriginalFormData; }
  const result = run({ failures: { timeout: { event: 'ClaimAccepted', attempts: 'all' } } }, { ordering: true });
  assert.equal(result.dlq[0].eventId, 'E2');
  assert.deepEqual(result.buffered, [{ eventId: 'E3', eventType: 'ClaimPaid', seq: 3 }]);
  assertFinal(root, result);
});

test('rerun clears completed snapshots until the new playback finishes', () => animated(drain => {
  const root = mount(undefined, 'guided');
  chooseScenario(root, '1b');
  chooseSource(root, 'sim');
  clickRun(root);
  drain();
  assert.equal(byClass(root, 'ifl-final-state').hidden, false);
  clickRun(root);
  assert.equal(byClass(root, 'ifl-final-state').hidden, true);
  assert.equal(byClass(root, 'ifl-final-state').children.length, 0);
  drain();
  assertFinal(root, run(SCENARIOS.find(s => s.id.startsWith('1b-'))));
}));

for (const switchKind of ['scenario', 'source', 'mode']) {
  for (const completed of [true, false]) {
    test(`${switchKind} switch clears output and cancels ${completed ? 'completed' : 'active'} playback`, () => animated((drain, timers) => {
      const root = mount(undefined, 'guided');
      chooseScenario(root, '1b');
      chooseSource(root, 'sim');
      clickRun(root);
      if (completed) drain();
      if (switchKind === 'scenario') chooseScenario(root, '6b');
      else if (switchKind === 'source') chooseSource(root, 'exec');
      else root.find(e => e.tagName === 'BUTTON' && e.text() === 'Switch to free-form')[0].listeners.click();
      const output = byClass(root, 'ifl-output');
      assert.equal(output.hidden, true);
      assert.equal(output.children.length, 0);
      assert.equal(timers.size, 0);
    }));
  }
}

test('recorded entry values are rendered as text without HTML injection', async () => {
  const scenario = SCENARIOS.find(s => s.id.startsWith('1b-'));
  const result = EXECUTED[scenario.id];
  const original = result.dlq;
  const markup = '<img src=x onerror=alert(1)>';
  result.dlq = [{ eventId: markup, eventType: markup, reason: markup, attempts: markup }];
  try {
    const root = mount(undefined, 'guided');
    chooseScenario(root, '1b');
    chooseSource(root, 'exec');
    await clickRun(root);
    assertFinal(root, result);
    const panel = byClass(root, 'ifl-final-state');
    assert.equal(panel.find(e => e.tagName === 'IMG').length, 0);
    for (const value of panel.find(e => e.tagName === 'DD')) assert.deepEqual(value.children, [markup]);
  } finally { result.dlq = original; }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function freshLab(load) {
  globalThis.__loadRecordings = load;
  globalThis.__resetRecordings();
  return mountLab;
}
const rootFor = mount => {
  const root = new FakeElement('div');
  mount(root).setMode('guided');
  return root;
};
const replayStatus = root => root.find(e => e.getAttribute('aria-label') === 'Replay status')[0];
const runButton = root => root.find(e => e.className.includes('ifl-run'))[0];

test('recordings load only on executed Run and are shared across reruns and mounts', async () => {
  let imports = 0;
  const mountFresh = await freshLab(() => { imports++; return EXECUTED; });
  const originalStorage = globalThis.localStorage;
  const originalFormData = globalThis.FormData;
  globalThis.localStorage = { getItem: key => key === 'ifl-source' ? 'exec' : 'guided', setItem() {} };
  try {
    const picker = new FakeElement('div');
    globalThis.localStorage = undefined;
    mountFresh(picker);
    assert.ok(byClass(picker, 'ifl-picker'));
    assert.equal(imports, 0, 'fresh mount does not load recordings');
    globalThis.localStorage = { getItem: key => key === 'ifl-source' ? 'exec' : 'guided', setItem() {} };
    const root = new FakeElement('div');
    const lab = mountFresh(root);
    assert.equal(imports, 0, 'saved executed preference must not load recordings');
    chooseSource(root, 'sim');
    await clickRun(root);
    assert.equal(imports, 0);
    lab.setMode('free');
    globalThis.FormData = class { get(name) { return { retryLimit: '3', backoff: 'exponential' }[name] ?? null; } };
    byClass(root, 'ifl-form').listeners.submit({ preventDefault() {} });
    assert.equal(imports, 0);
    lab.setMode(null);
    assert.equal(imports, 0, 'mode picker does not load recordings');
    lab.setMode('guided');
    chooseSource(root, 'exec');
    assert.equal(imports, 0, 'source selection does not load recordings');
    await clickRun(root);
    assert.equal(imports, 1);
    await clickRun(root);
    const second = rootFor(mountFresh);
    await clickRun(second);
    assert.equal(imports, 1, 'successful import persists across mounts');
  } finally {
    globalThis.localStorage = originalStorage;
    globalThis.FormData = originalFormData;
  }
});

for (const change of ['mode', 'scenario', 'source']) {
  for (const fails of [false, true]) {
    test(`pending replay ignores stale ${fails ? 'failure' : 'success'} after ${change} change`, async () => {
      const load = deferred(), started = deferred();
      let imports = 0;
      const mountFresh = await freshLab(() => { imports++; started.resolve(); return load.promise; });
      const root = rootFor(mountFresh);
      chooseSource(root, 'exec');
      const pending = clickRun(root);
      await started.promise;
      assert.equal(runButton(root).getAttribute('disabled'), '');
      const status = replayStatus(root);
      assert.equal(status.hidden, false);
      assert.equal(status.getAttribute('role'), 'status');
      assert.match(status.text(), /Loading recorded replay/);
      await clickRun(root); // Programmatic repeated activation is also guarded.
      assert.equal(imports, 1);
      if (change === 'mode') root.find(e => e.text() === 'Switch to free-form')[0].listeners.click();
      if (change === 'scenario') chooseScenario(root, '6b');
      if (change === 'source') chooseSource(root, 'sim');
      if (fails) load.reject(new Error('offline'));
      else load.resolve(EXECUTED);
      await pending;
      assert.equal(byClass(root, 'ifl-output').hidden, true);
      assert.equal(byClass(root, 'ifl-output').children.length, 0);
      assert.equal(status.hidden, true);
      assert.equal(status.children.length, 0);
      assert.equal(runButton(root).getAttribute('disabled'), null);
      if (!fails && change === 'scenario') {
        await clickRun(root);
        assertFinal(root, EXECUTED[SCENARIOS.find(s => s.id.startsWith('6b-')).id]);
        assert.equal(imports, 1);
      }
    });
  }
}

test('failed import releases controls, offers retry, and leaves simulation usable', async () => {
  const load = deferred(), started = deferred();
  let imports = 0;
  const mountFresh = await freshLab(() => {
    imports++;
    started.resolve();
    return imports === 1 ? load.promise : EXECUTED;
  });
  const root = rootFor(mountFresh);
  chooseSource(root, 'exec');
  const pending = clickRun(root);
  await started.promise;
  load.reject(new Error('offline'));
  await pending;
  assert.equal(runButton(root).getAttribute('disabled'), null);
  assert.equal(byClass(root, 'ifl-output').hidden, true);
  const status = replayStatus(root);
  assert.equal(status.hidden, false);
  assert.match(status.text(), /Recorded replay unavailable.*still simulate/);
  const simulation = rootFor(mountFresh);
  chooseSource(simulation, 'sim');
  await clickRun(simulation);
  assertFinal(simulation, run(SCENARIOS[0]));
  assert.equal(imports, 1);
  await status.find(e => e.text() === 'Retry replay')[0].listeners.click();
  assert.equal(imports, 2);
  assert.equal(status.hidden, true);
  assert.match(root.find(e => e.className === 'ifl-note').at(-1).text(), /Recorded from a real run/);
  assertFinal(root, EXECUTED[SCENARIOS[0].id]);
  chooseSource(root, 'sim');
  await clickRun(root);
  assert.match(root.find(e => e.className === 'ifl-note').at(-1).text(), /Simulated in your browser/);
  assertFinal(root, run(SCENARIOS[0]));
});

test('manifest omissions offer only simulation even with a saved executed preference', async () => {
  let imports = 0;
  const mountFresh = await freshLab(() => { imports++; return EXECUTED; });
  const id = RECORDING_IDS.shift();
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => key === 'ifl-source' ? 'exec' : 'guided', setItem() {} };
  try {
    const root = rootFor(mountFresh);
    assert.equal(byClass(root, 'ifl-source'), undefined);
    assert.match(runButton(root).text(), /Run scenario/);
    await clickRun(root);
    assert.equal(imports, 0);
    assertFinal(root, run(SCENARIOS[0]));
  } finally { RECORDING_IDS.unshift(id); globalThis.localStorage = originalStorage; }
});

for (const motion of ['reduced', 'animated']) {
  test(`all twelve recorded traces, records, verdicts and provenance survive ${motion} playback`, async () => {
    globalThis.__loadRecordings = () => EXECUTED;
    const check = async drain => {
      for (const scenario of SCENARIOS) {
        const root = mount(undefined, 'guided');
        chooseScenario(root, scenario.id.split('-')[0]);
        chooseSource(root, 'exec');
        await clickRun(root);
        if (drain) drain();
        const result = EXECUTED[scenario.id];
        assertFinal(root, result);
        const rows = byClass(root, 'ifl-trace').children;
        assert.deepEqual(rows.map(row => row.children[2].text()), result.trace.map(row => describe(row, result.timing.timeoutMs)));
        const record = byClass(root, 'ifl-record');
        assert.deepEqual(record.children[1].children.map(row => row.children[2].text()), [
          result.record.status, `$${(result.record.paidCents / 100).toFixed(2)}`, result.record.applied.join(' \u2192 ') || 'none',
        ]);
        const verdict = judge(result.record, result);
        assert.equal(byClass(root, 'ifl-verdict-head').text(), verdict.summary);
        const note = root.find(e => e.className === 'ifl-note').at(-1).text();
        assert.ok(note.includes(result.runtime.springBoot));
        assert.ok(note.includes(result.runtime.java.split('+')[0]));
        assert.ok(note.includes(result.runtime.transport));
        assert.ok(note.includes(`${result.timing.timeoutMs} ms ack timeout`));
        assert.ok(note.includes(`${result.timing.backoffBaseMs} ms backoff base`));
        assert.match(note, /Recorded from a real run.*replayed here.*Synthetic data/);
        assert.equal(byClass(root, 'ifl-stats').children[0].children[0], 'Wall-clock time ');
      }
    };
    if (motion === 'animated') await animated(check);
    else await check();
  });
}

test('a new replay and another mount share the pending import without playing the old scenario', async () => {
  const load = deferred(), started = deferred();
  let imports = 0;
  const mountFresh = await freshLab(() => { imports++; started.resolve(); return load.promise; });
  const root = rootFor(mountFresh);
  chooseSource(root, 'exec');
  const old = clickRun(root);
  await started.promise;
  chooseScenario(root, '6b');
  const current = clickRun(root);
  const second = rootFor(mountFresh);
  chooseSource(second, 'exec');
  const otherMount = clickRun(second);
  load.resolve(EXECUTED);
  await Promise.all([old, current, otherMount]);
  assert.equal(imports, 1);
  assertFinal(root, EXECUTED[SCENARIOS.find(s => s.id.startsWith('6b-')).id]);
  assertFinal(second, EXECUTED[SCENARIOS[0].id]);
});

test('an advertised recording missing from the loaded module fails explicitly', async () => {
  const mountFresh = await freshLab(() => ({}));
  const root = rootFor(mountFresh);
  chooseSource(root, 'exec');
  await clickRun(root);
  assert.match(replayStatus(root).text(), /Recorded replay unavailable/);
  assert.equal(byClass(root, 'ifl-output').hidden, true);
  assert.equal(runButton(root).getAttribute('disabled'), null);
});

// Read the rendered form the way a browser would submit it: checked boxes send "on", a select sends its selected option.
function submitted(form) {
  const values = {};
  for (const el of form.all()) {
    const name = el.getAttribute('name');
    if (el.tagName === 'INPUT' && el.getAttribute('checked') !== null) values[name] = 'on';
    if (el.tagName === 'SELECT') {
      const options = el.children;
      values[name] = (options.find(o => o.getAttribute('selected') !== null) ?? options[0]).getAttribute('value');
    }
  }
  return values;
}
function submitForm(root) {
  const values = submitted(byClass(root, 'ifl-form'));
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } };
  try { byClass(root, 'ifl-form').listeners.submit({ preventDefault() {} }); }
  finally { globalThis.FormData = OriginalFormData; }
}
const tryButton = root => root.find(e => e.className === 'ifl-link ifl-try')[0];
const FREE_FORM_DEFAULTS = { timeoutEvent: 'ClaimPaid', timeoutAttempts: 'first', duplicateEvent: 'ClaimPaid', reorderEvent: 'ClaimAccepted', retryLimit: '3', backoff: 'exponential', deadLetter: 'on' };

test('Try this in Free-form shows for exactly the scenarios the form can express', () => {
  const shown = [];
  for (const scenario of SCENARIOS) {
    const root = mount(undefined, 'guided');
    chooseScenario(root, scenario.id.split('-')[0]);
    const button = tryButton(root);
    assert.equal(Boolean(button), toFormValues(scenario) !== null, scenario.id);
    if (button) {
      shown.push(scenario.id.split('-')[0]);
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.text(), 'Try this in Free-form');
      assert.equal(button.getAttribute('type'), 'button');
      assert.ok(byClass(root, 'ifl-actions').children.includes(button), 'the control sits in the scenario actions');
    }
  }
  assert.deepEqual(shown, ['1a', '1b', '1c', '2a', '2b', '3a', '3b', '4', '5a', '5b']);
});

test('scenarios with poison, replay after fix or another delay are not expressible', () => {
  const base = SCENARIOS.find(s => s.id.startsWith('3a-'));
  assert.notEqual(toFormValues(base), null);
  assert.equal(toFormValues({ ...base, failures: { ...base.failures, poison: { event: 'ClaimPaid' } } }), null);
  assert.equal(toFormValues({ ...base, safeguards: { ...base.safeguards, replayAfterFix: true } }), null);
  assert.equal(toFormValues({ ...base, failures: { reorder: { event: 'ClaimAccepted', delayMs: 200 } } }), null);
  assert.equal(toFormValues({ failures: { timeout: { event: 'ClaimPaid', attempts: [2] } } }), null);
  assert.equal(toFormValues({ failures: { schemaChange: { event: 'ClaimAccepted' } } }), null);
  assert.equal(toFormValues({ failures: {}, safeguards: { retryLimit: 6 } }), null);
});

test('null failures and safeguards read as absent, as in the engine', () => {
  assert.deepEqual(toFormValues({ failures: null, safeguards: null }), toFormValues({}));
  const [first] = SCENARIOS;
  const { failures, safeguards } = first;
  Object.assign(first, { failures: null, safeguards: null });
  try {
    const root = mount(undefined, 'guided');
    assert.deepEqual(root.find(e => e.className === 'ifl-tag ifl-tag-fail').map(t => t.text()), ['no failures']);
    assert.ok(byClass(root, 'ifl-link ifl-try'), 'the defaults are expressible in Free-form');
  } finally {
    Object.assign(first, { failures, safeguards });
  }
});

test('the Free-form backoff select lists exponential, fixed, none', () => {
  const form = byClass(mount(undefined, 'free'), 'ifl-form');
  const backoff = form.find(e => e.tagName === 'SELECT' && e.getAttribute('name') === 'backoff')[0];
  assert.deepEqual(backoff.children.map(o => o.getAttribute('value')), ['exponential', 'fixed', 'none']);
  assert.deepEqual(backoff.children.map(o => o.text()), ['exponential', 'fixed', 'none']);
});

// The differential test (scripts/differential.mjs) must reach every value of every Free-form control.
test('the differential generator covers every Free-form control value', () => {
  const form = byClass(mount(undefined, 'free'), 'ifl-form');
  const checkboxes = form.find(e => e.tagName === 'INPUT').map(e => e.getAttribute('name'));
  const settings = failureSettings().map(f => canonical({ [f.kind]: f.value }));
  const safeguardValues = [DEFAULT_SAFEGUARDS, ...safeguardToggles()].flatMap(Object.entries).map(canonical);
  let checked = 0;
  for (const select of form.find(e => e.tagName === 'SELECT')) {
    for (const option of select.children) {
      for (const on of [true, false]) {
        const values = { ...FREE_FORM_DEFAULTS, ...Object.fromEntries(checkboxes.map(n => [n, on ? 'on' : null])),
          [select.getAttribute('name')]: option.getAttribute('value') };
        const { failures, safeguards } = formScenario(name => values[name] ?? null);
        for (const entry of Object.entries(failures)) assert.ok(settings.includes(canonical(Object.fromEntries([entry]))), JSON.stringify(entry));
        for (const entry of Object.entries(safeguards)) assert.ok(safeguardValues.includes(canonical(entry)), JSON.stringify(entry));
        checked++;
      }
    }
  }
  assert.ok(checked >= 2 * (3 * 3 + 3 + 6 + 3), `${checked} form submissions`);
});

const PICK = ['trace', 'record', 'dlq', 'dropped', 'buffered'];
const pick = result => Object.fromEntries(PICK.map(k => [k, result[k]]));

test('every pre-filled Free-form run reproduces its guided simulation', () => {
  for (const scenario of SCENARIOS.filter(s => toFormValues(s))) {
    const root = mount(undefined, 'guided');
    chooseScenario(root, scenario.id.split('-')[0]);
    tryButton(root).listeners.click();
    const values = submitted(byClass(root, 'ifl-form'));
    const expected = run(scenario);
    assert.deepEqual(pick(run(formScenario(name => values[name] ?? null))), pick(expected));
    submitForm(root);
    const rows = byClass(root, 'ifl-trace').children;
    assert.deepEqual(rows.map(row => row.children[2].text()), expected.trace.map(row => describe(row)));
    assertFinal(root, expected);
  }
});

// Submit the Free-form with these field values, as FormData would read them.
function submitValues(root, values) {
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } };
  try { byClass(root, 'ifl-form').listeners.submit({ preventDefault() {} }); }
  finally { globalThis.FormData = OriginalFormData; }
}
const compareBox = root => byClass(root, 'ifl-compare');
const ACK_LOST = { ...FREE_FORM_DEFAULTS, duplicate: 'on' };

test('the comparison heading follows the heading level and every value is text', () => {
  const root = mount({ headingLevel: 6 }, 'free');
  submitValues(root, FREE_FORM_DEFAULTS);
  submitValues(root, { ...FREE_FORM_DEFAULTS, timeout: 'on', timeoutAttempts: 'all', retryLimit: '1', backoff: 'fixed', deadLetter: null });
  assert.equal(headings(compareBox(root))[0].tagName, 'H6');
  assert.deepEqual(compareBox(root).find(e => e.tagName === 'LI').map(li => li.text()), [
    'Downstream times out on: off → ClaimPaid, every attempt', 'Retries: 3 → 1', 'Backoff: exponential → fixed', 'Dead-letter queue: on → off',
  ]);
  for (const cell of compareBox(root).find(e => e.tagName === 'TD' || e.tagName === 'LI')) {
    assert.ok(cell.children.every(c => typeof c === 'string'), 'values are text nodes, never markup');
  }
});

test('an unchecked failure ignores its event select when comparing settings', () => {
  const root = mount(undefined, 'free');
  submitValues(root, FREE_FORM_DEFAULTS);
  submitValues(root, { ...FREE_FORM_DEFAULTS, duplicateEvent: 'ClaimAccepted', timeoutAttempts: 'all' });
  assert.equal(compareBox(root).find(e => e.tagName === 'P')[0].text(), 'Same settings as your previous run.');
});

test('the comparison appears only after animated playback, and an interrupted run does not become the previous run', () => animated(drain => {
  const root = mount(undefined, 'free');
  submitValues(root, ACK_LOST);
  assert.equal(compareBox(root).hidden, true);
  drain();
  submitValues(root, { ...ACK_LOST, idempotency: 'on' });
  assert.equal(compareBox(root).hidden, true, 'hidden while the trace plays');
  assert.equal(compareBox(root).children.length, 0);
  submitValues(root, { ...ACK_LOST, ordering: 'on' });
  assert.equal(compareBox(root).hidden, true);
  drain();
  assert.equal(compareBox(root).hidden, false);
  assert.deepEqual(compareBox(root).find(e => e.tagName === 'LI').map(li => li.text()), ['Ordered consumer (buffer early events): off → on']);
}));

test('a mode switch clears the previous Free-form run', () => animated(drain => {
  const root = mount(undefined, 'free');
  submitValues(root, ACK_LOST);
  drain();
  root.find(e => e.tagName === 'BUTTON' && e.text() === 'Switch to guided')[0].listeners.click();
  root.find(e => e.tagName === 'BUTTON' && e.text() === 'Switch to free-form')[0].listeners.click();
  submitValues(root, { ...ACK_LOST, idempotency: 'on' });
  drain();
  assert.equal(compareBox(root).hidden, true);
  submitValues(root, { ...ACK_LOST, idempotency: 'on' });
  drain();
  assert.equal(compareBox(root).hidden, false);
}));

test('guided runs never show a comparison', () => {
  const root = mount(undefined, 'guided');
  clickRun(root);
  clickRun(root);
  assert.equal(compareBox(root).hidden, true);
});

// Mounts with the given saved preferences and options, without calling setMode, and records what gets saved.
async function mountWith(prefs, opts) {
  let imports = 0;
  const mountFresh = await freshLab(() => { imports++; return EXECUTED; });
  const saved = {};
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => prefs[key] ?? null, setItem: (k, v) => { saved[k] = v; } };
  try {
    const root = new FakeElement('div');
    globalThis.__focused = null;
    const lab = mountFresh(root, opts);
    return { root, lab, saved, imports: () => imports };
  } finally { globalThis.localStorage = originalStorage; }
}
const currentChip = root => root.find(e => e.className === 'ifl-chip' && e.getAttribute('aria-current') === 'step').map(e => e.text());
const kicker = root => byClass(root, 'ifl-kicker').text();

test('scenario option opens Guided on a full or short ID, any case, without saving the mode', () => animated(async (drain, timers) => {
  for (const scenario of ['2a', '2A-DUPLICATE']) {
    const { root, saved, imports } = await mountWith({}, { scenario });
    assert.deepEqual(currentChip(root), ['2a']);
    assert.equal(kicker(root), `Guided · scenario 4 of ${SCENARIOS.length}`);
    assert.equal(headings(root)[0].text(), 'Lost acknowledgement');
    assert.equal(headings(root)[0].tagName, 'H3');
    assert.deepEqual(saved, {}, 'a deep link does not write ifl-mode');
    assert.equal(byClass(root, 'ifl-output').hidden, true);
    assert.equal(timers.size, 0, 'no playback starts');
    assert.equal(imports(), 0, 'no recordings load on mount');
    assert.equal(globalThis.__focused, null, 'focus stays with the host');
  }
}));

test('scenario option overrides a saved free mode; switching mode afterwards saves it', async () => {
  const { root, lab, saved } = await mountWith({ 'ifl-mode': 'free' }, { scenario: '3b' });
  assert.deepEqual(currentChip(root), ['3b']);
  assert.deepEqual(saved, {});
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: (k, v) => { saved[k] = v; } };
  try { lab.setMode('free'); } finally { globalThis.localStorage = originalStorage; }
  assert.equal(saved['ifl-mode'], 'free');
  assert.ok(byClass(root, 'ifl-form'));
});

test('scenario option keeps the saved run source', async () => {
  const exec = await mountWith({ 'ifl-source': 'exec' }, { scenario: '6b' });
  assert.match(runButton(exec.root).text(), /^Replay real run/);
  assert.equal(exec.imports(), 0);
  const sim = await mountWith({}, { scenario: '1a' });
  assert.match(runButton(sim.root).text(), /^Run scenario/);
});

test('an unknown, empty or non-string scenario option behaves like no option', async () => {
  for (const scenario of ['zz', '', 7, null, {}]) {
    const fresh = await mountWith({}, { scenario });
    assert.ok(byClass(fresh.root, 'ifl-picker'), `picker on first visit for ${JSON.stringify(scenario)}`);
    const back = await mountWith({ 'ifl-mode': 'guided' }, { scenario });
    assert.deepEqual(currentChip(back.root), ['1a']);
    assert.deepEqual({ ...fresh.saved, ...back.saved }, {});
  }
});

const tryLine = root => root.find(e => e.className === 'ifl-lesson')[0]?.text();

test('the Try line offers only safeguards that change the run', () => {
  const root = mount(undefined, 'guided');
  chooseScenario(root, '1c');
  tryButton(root).listeners.click();
  submitForm(root);
  assert.equal(tryLine(root), 'Try: turn on the dead-letter queue, so lost messages are at least visible.');
});

test('the Try line offers the ordered consumer when the dead-letter queue holds only an applied message', () => {
  const root = mount(undefined, 'free');
  submitValues(root, { ...FREE_FORM_DEFAULTS, duplicate: 'on', reorder: 'on', retryLimit: '0', deadLetter: 'on' });
  assert.equal(tryLine(root), 'Try: turn on the ordered consumer.');
});
