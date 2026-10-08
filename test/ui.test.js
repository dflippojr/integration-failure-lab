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
  focus() {}
  all() { return this.children.flatMap(c => (c instanceof FakeElement ? [c, ...c.all()] : [])); }
  querySelector(sel) { return this.all().find(e => sel.split(',').some(s => (s.trim().startsWith('.') ? e.className.split(' ').includes(s.trim().slice(1)) : e.tagName === s.trim().toUpperCase()))) ?? null; }
  find(pred) { return this.all().filter(pred); }
  text() { return this.children.map(c => (c instanceof FakeElement ? c.text() : String(c))).join(''); }
}

let mountLab, SCENARIOS, EXECUTED;
import { run } from '../engine/engine.js';
before(async () => {
  globalThis.Node = FakeElement;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.window = { matchMedia: () => ({ matches: true }) }; // reduced motion: traces render synchronously
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build.mjs', import.meta.url)), 'test']);
  // Import the source ui/lab.js, not a built copy, so coverage lands on it; see lab-loader.mjs.
  register('./lab-loader.mjs', import.meta.url);
  ({ mountLab } = await import('../ui/lab.js'));
  ({ SCENARIOS } = await import('../dist-test/scenarios.js'));
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
