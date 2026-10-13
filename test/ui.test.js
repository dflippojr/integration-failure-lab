// UI accessibility checks for ui/lab.js, run with freshly generated scenario modules and a minimal fake DOM (no dependencies).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
import { run, judge } from '../engine/engine.js';
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

test('free-form selects each have a distinct label', () => {
  const root = mount(undefined, 'free');
  const selects = root.find(e => e.tagName === 'SELECT' && e.getAttribute('aria-label'));
  const labels = selects.map(s => s.getAttribute('aria-label'));
  assert.ok(labels.length >= 4);
  assert.equal(new Set(labels).size, labels.length, labels.join(', '));
  assert.ok(!labels.includes('Event'));
});

test('the scrolling trace is a named, focusable region', () => {
  const root = mount(undefined, 'guided');
  root.find(e => e.className.includes('ifl-run'))[0].listeners.click();
  const [region] = root.find(e => e.className === 'ifl-trace-scroll');
  assert.equal(region.getAttribute('role'), 'region');
  assert.equal(region.getAttribute('tabindex'), '0');
  assert.equal(region.getAttribute('aria-label'), 'Event trace');
  const [list] = region.children;
  assert.equal(list.tagName, 'OL');
  assert.ok(list.children.length > 0);
});

test('guided and free-form wrap the bar, controls, status and output in one two-pane console, in reading order', () => {
  for (const mode of ['guided', 'free']) {
    const root = mount(undefined, mode);
    assert.equal(root.children.length, 1);
    const [frame] = root.children;
    assert.equal(frame.className, 'ifl-console ifl-panes');
    assert.deepEqual(frame.children.map(c => c.className), ['ifl-bar', 'ifl-body', 'ifl-status', 'ifl-output']);
    const [bar, body, status, output] = frame.children;
    assert.ok(bar.find(e => e.className === 'ifl-link').length, 'the mode switch sits in the title bar');
    assert.ok(body.find(e => e.className.includes('ifl-run')).length, 'Run sits in the controls pane');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-label'), 'Replay status');
    assert.equal(output.hidden, true, 'the output pane stays empty until the first run');
    if (mode === 'guided') clickRun(root);
    else {
      const OriginalFormData = globalThis.FormData;
      const values = { retryLimit: '3', backoff: 'exponential', deadLetter: 'on' };
      globalThis.FormData = class { get(name) { return values[name] ?? null; } };
      try { byClass(body, 'ifl-form').listeners.submit({ preventDefault() {} }); }
      finally { globalThis.FormData = OriginalFormData; }
    }
    assert.equal(output.hidden, false);
    assert.deepEqual(output.children.map(c => c.className || c.tagName), ['ifl-kicker', 'ifl-stats', 'ifl-trace-scroll', 'ifl-verdict ifl-ok', 'ifl-compare', 'ifl-final-state', 'ifl-note']);
    assert.equal(output.find(e => e.className.startsWith('ifl-verdict'))[0].getAttribute('role'), 'status');
  }
});

test('the mode picker keeps the single-column console at any width', () => {
  const root = new FakeElement('div');
  const lab = mountLab(root);
  assert.equal(root.children[0].className, 'ifl-console');
  lab.setMode('guided');
  assert.equal(root.children[0].className, 'ifl-console ifl-panes');
});

test('the two-pane rules key off the lab width, skip print, and touch only the panes', () => {
  const css = readFileSync(fileURLToPath(new URL('../ui/lab.css', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /\.ifl \{[^}]*container: ifl \/ inline-size;/);
  const start = css.indexOf('@media screen {\n  @container ifl (min-width: 810px) {');
  assert.ok(start > 0, 'the panes sit in a screen-only container query on the lab, not a viewport query');
  const block = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...block.matchAll(/[{}]\s*([^{}@]+?)\s*\{/g)].map(m => m[1]);
  assert.ok(selectors.length > 10);
  for (const sel of selectors) for (const part of sel.split(/,(?![^(]*\))/)) assert.match(part.trim(), /^\.ifl-panes\b/, sel);
  for (const area of ['bar', 'body', 'status', 'output']) assert.match(block, new RegExp(`\\.ifl-${area} \\{ grid-area: ${area};`));
  assert.match(block, /grid-template-areas: "bar bar" "body status" "body output";/);
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
  window.matchMedia = () => ({ matches: false });
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
    window.matchMedia = () => ({ matches: true });
  }
}

for (const source of ['sim', 'exec']) {
  for (const id of ['1b', '1c', '6a', '6b']) {
    for (const motion of ['reduced', 'animated']) {
      test(`${id} ${source}: final contents and historical counters with ${motion} playback`, async () => {
        const check = async drain => {
          const root = mount(undefined, 'guided');
          chooseScenario(root, id);
          chooseSource(root, source);
          const scenario = SCENARIOS.find(s => s.id.startsWith(`${id}-`));
          const result = source === 'sim' ? run(scenario) : EXECUTED[scenario.id];
          await clickRun(root);
          if (drain) {
            assert.equal(byClass(root, 'ifl-final-state').hidden, true);
            assert.equal(byClass(root, 'ifl-final-state').children.length, 0);
            drain();
          }
          assertFinal(root, result);
          const parked = byClass(root, 'ifl-stats').children.at(-1);
          assert.equal(parked.children[0], 'Parked / dropped events ');
          assert.equal(parked.children[1].textContent, 1);
          if (id === '6b') assert.equal(result.dlq.length, 0);
        };
        if (motion === 'animated') await animated(check);
        else await check();
      });
    }
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

test('Try this in Free-form saves free mode, fills the form, does not run and focuses the first control', () => animated((drain, timers) => {
  const saved = {};
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: (k, v) => { saved[k] = v; } };
  try {
    const root = mount(undefined, 'guided');
    chooseScenario(root, '2b');
    tryButton(root).listeners.click();
    assert.equal(saved['ifl-mode'], 'free');
    assert.equal(byClass(root, 'ifl-output').hidden, true);
    assert.equal(byClass(root, 'ifl-output').children.length, 0);
    assert.equal(timers.size, 0, 'no playback starts');
    const form = byClass(root, 'ifl-form');
    assert.ok(form);
    const first = form.find(e => ['BUTTON', 'INPUT', 'SELECT'].includes(e.tagName))[0];
    assert.equal(globalThis.__focused, first);
    assert.deepEqual(submitted(form), { ...FREE_FORM_DEFAULTS, duplicate: 'on', idempotency: 'on' });
  } finally { globalThis.localStorage = originalStorage; }
}));

test('1c pre-fill merges the default safeguards it leaves out', () => {
  const root = mount(undefined, 'guided');
  chooseScenario(root, '1c');
  tryButton(root).listeners.click();
  const { deadLetter, ...rest } = FREE_FORM_DEFAULTS;
  assert.deepEqual(submitted(byClass(root, 'ifl-form')), { ...rest, timeout: 'on', timeoutAttempts: 'all', retryLimit: '0' });
});

test('reaching Free-form through the mode switch after a pre-fill shows the defaults', () => {
  const root = mount(undefined, 'guided');
  chooseScenario(root, '4');
  tryButton(root).listeners.click();
  assert.notDeepEqual(submitted(byClass(root, 'ifl-form')), FREE_FORM_DEFAULTS);
  root.find(e => e.tagName === 'BUTTON' && e.text() === 'Switch to guided')[0].listeners.click();
  root.find(e => e.tagName === 'BUTTON' && e.text() === 'Switch to free-form')[0].listeners.click();
  assert.deepEqual(submitted(byClass(root, 'ifl-form')), FREE_FORM_DEFAULTS);
  assert.deepEqual(submitted(byClass(mount(undefined, 'free'), 'ifl-form')), FREE_FORM_DEFAULTS);
});

// Submit the Free-form with these field values, as FormData would read them.
function submitValues(root, values) {
  const OriginalFormData = globalThis.FormData;
  globalThis.FormData = class { get(name) { return values[name] ?? null; } };
  try { byClass(root, 'ifl-form').listeners.submit({ preventDefault() {} }); }
  finally { globalThis.FormData = OriginalFormData; }
}
const compareBox = root => byClass(root, 'ifl-compare');
const compareRows = root => compareBox(root).find(e => e.tagName === 'TBODY')[0].children
  .map(row => [row.children[0].text(), row.children[1].text(), row.children[2].text(), row.children[2].className]);
const ACK_LOST = { ...FREE_FORM_DEFAULTS, duplicate: 'on' };

test('the first Free-form run shows no comparison', () => {
  const root = mount(undefined, 'free');
  submitValues(root, ACK_LOST);
  assert.equal(compareBox(root).hidden, true);
  assert.equal(compareBox(root).children.length, 0);
});

test('turning on idempotency compares one changed setting and the changed outcome with the previous run', () => {
  const root = mount(undefined, 'free');
  submitValues(root, ACK_LOST);
  submitValues(root, { ...ACK_LOST, idempotency: 'on' });
  const box = compareBox(root);
  assert.equal(box.hidden, false);
  assert.equal(box.tagName, 'SECTION');
  assert.equal(box.getAttribute('aria-label'), 'Compared with your previous run');
  assert.equal(headings(box)[0].tagName, 'H4');
  assert.equal(headings(box)[0].text(), 'Compared with your previous run');
  assert.deepEqual(box.find(e => e.tagName === 'LI').map(li => li.text()), ['Idempotent consumer (dedupe on eventId): off → on']);
  const before = run(formScenario(name => ACK_LOST[name] ?? null));
  const after = run(formScenario(name => ({ ...ACK_LOST, idempotency: 'on' })[name] ?? null));
  assert.notEqual(before.verdict.summary, after.verdict.summary);
  assert.deepEqual(box.find(e => e.tagName === 'THEAD')[0].find(e => e.tagName === 'TH').map(th => th.text()), ['Claim C-1001', 'Previous', 'This run']);
  assert.deepEqual(compareRows(root), [
    ['Verdict', before.verdict.summary, after.verdict.summary, 'ifl-diff'],
    ['Status', 'Paid', 'Paid', ''],
    ['Paid', '$240.00', '$120.00', 'ifl-diff'],
    ['Events applied', 'E1 → E2 → E3 → E3', 'E1 → E2 → E3', 'ifl-diff'],
  ]);
  const output = byClass(root, 'ifl-output').children.map(c => c.className);
  assert.ok(output.indexOf('ifl-compare') === output.findIndex(c => c.startsWith('ifl-verdict')) + 1, 'the comparison follows the verdict');
});

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

test('identical settings say so and show identical columns', () => {
  const root = mount(undefined, 'free');
  submitValues(root, ACK_LOST);
  submitValues(root, ACK_LOST);
  const box = compareBox(root);
  assert.equal(box.find(e => e.tagName === 'UL').length, 0);
  assert.equal(box.find(e => e.tagName === 'P')[0].text(), 'Same settings as your previous run.');
  for (const [, was, now, cls] of compareRows(root)) {
    assert.equal(was, now);
    assert.equal(cls, '');
  }
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
