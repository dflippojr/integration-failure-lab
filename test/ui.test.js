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
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  focus() {}
  all() { return this.children.flatMap(c => (c instanceof FakeElement ? [c, ...c.all()] : [])); }
  querySelector(sel) { return this.all().find(e => sel.split(',').some(s => e.tagName === s.trim().toUpperCase())) ?? null; }
  find(pred) { return this.all().filter(pred); }
  text() { return this.children.map(c => (c instanceof FakeElement ? c.text() : String(c))).join(''); }
}

let mountLab;
before(async () => {
  globalThis.Node = FakeElement;
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.window = { matchMedia: () => ({ matches: true }) }; // reduced motion: traces render synchronously
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build.mjs', import.meta.url)), 'test']);
  // Import the source ui/lab.js, not a built copy, so coverage lands on it; see lab-loader.mjs.
  register('./lab-loader.mjs', import.meta.url);
  ({ mountLab } = await import('../ui/lab.js'));
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
