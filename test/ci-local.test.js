// scripts/ci-local.mjs runs every CI job locally, keeps going after a failure and always stops the UI instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, STOP, runGate } from '../scripts/ci-local.mjs';

const pass = name => ({ name, command: 'node -e "process.exit(0)"' });
const fail = name => ({ name, command: 'node -e "process.exit(3)"' });

async function gate(steps, stop = pass('stop')) {
  const lines = [];
  const code = await runGate(steps, stop, line => lines.push(line));
  const summary = lines.slice(lines.indexOf('\nci:local') + 1).map(l => l.trim());
  return { code, lines, summary };
}

test('the steps are the ci.yml jobs before gate, with one Java fork and one Playwright worker', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobs = [...ci.matchAll(/^ {2}(\w+):$/gm)].map(m => m[1]);
  // publish runs after gate, only on main, so ci:local has no step for it.
  assert.deepEqual(STEPS.map(s => s.name).concat('gate', 'publish'), jobs);
  assert.match(STEPS[0].command, /^npm run lint && npm run test:coverage$/);
  assert.match(STEPS[1].command, /mvnw(\.cmd)? -B verify -DforkCount=1$/);
  assert.match(STEPS[2].command, /mvnw(\.cmd)? -B package -DskipTests && cd \.\. && npm run differential$/);
  assert.match(STEPS[3].command, /^npm run test:ui -- --workers=1$/);
  assert.equal(STOP.command, 'npm run ui:stop');
});

test('a green run exits 0 and stops the UI instance last', async () => {
  const { code, lines, summary } = await gate([pass('a'), pass('b')]);
  assert.equal(code, 0);
  assert.deepEqual(lines.filter(l => l.startsWith('\n== ')).map(l => l.split(':')[0].slice(4)), ['a', 'b', 'stop']);
  assert.deepEqual(summary, ['a: success', 'b: success', 'stop: success']);
});

test('a failing step does not stop the later steps or the UI stop, and the run exits 1', async () => {
  const { code, summary } = await gate([fail('a'), pass('b')]);
  assert.equal(code, 1);
  assert.deepEqual(summary, ['a: failure', 'b: success', 'stop: success']);
});

test('a failing UI stop fails the run', async () => {
  const { code, summary } = await gate([pass('a')], fail('stop'));
  assert.equal(code, 1);
  assert.deepEqual(summary, ['a: success', 'stop: failure']);
});

test('Ctrl+C skips the remaining steps but still stops the UI instance', async () => {
  setTimeout(() => process.emit('SIGINT'), 50);
  const { code, summary } = await gate([{ name: 'a', command: 'node -e "setTimeout(() => {}, 500)"' }, pass('b')]);
  assert.equal(code, 1);
  assert.deepEqual(summary, ['a: success', 'b: skipped', 'stop: success']);
  assert.equal(process.listenerCount('SIGINT'), 0);
});
