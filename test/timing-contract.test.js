// One timing model (#197): the Java runner runs the engine's TIMING at one scale factor, lab.time-scale, and every
// recording in executed/ says which. Each recorded timing must be the engine's value at the recorded scale, so this
// fails when either runtime changes its timings alone. It reads only the committed files, so it needs no Java build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIMING } from '../engine/engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const recordings = readdirSync(join(root, 'executed')).filter(f => f.endsWith('.json') && f !== 'index.json').sort();

// Each recorded timing field with the engine's TIMING value it scales.
const ENGINE = {
  timeoutMs: TIMING.timeoutMs,
  backoffBaseMs: TIMING.backoffBaseMs,
  sendAtMs: TIMING.sendAt,
  reorderDelayMs: TIMING.reorderDelayMs,
  replayDelayMs: TIMING.replayAfterMs,
};

// The timing block a recording made at this scale must carry.
function expectedTiming(timeScale) {
  const scaled = v => Math.round(v * timeScale);
  return Object.fromEntries([
    ...Object.entries(ENGINE).map(([name, value]) => [name, Array.isArray(value) ? value.map(scaled) : scaled(value)]),
    ['timeScale', timeScale],
  ]);
}

test('executed/ holds the twelve recordings', () => {
  assert.equal(recordings.length, 12);
});

for (const file of recordings) {
  test(`executed/${file} timings are the engine's TIMING at its recorded timeScale`, () => {
    const { timing } = JSON.parse(readFileSync(join(root, 'executed', file), 'utf8'));
    assert.equal(typeof timing?.timeScale, 'number', `executed/${file}: timing.timeScale is missing`);
    assert.ok(timing.timeScale > 0, `executed/${file}: timing.timeScale ${timing.timeScale} is not positive`);
    assert.deepEqual(timing, expectedTiming(timing.timeScale));
  });
}

test('the shipped recordings run at a quarter of the engine timings', () => {
  for (const file of recordings) {
    assert.equal(JSON.parse(readFileSync(join(root, 'executed', file), 'utf8')).timing.timeScale, 0.25, file);
  }
});

test('the expected timing block scales every engine timing and rounds like Java Math.round', () => {
  assert.deepEqual(expectedTiming(0.25), {
    timeoutMs: 500, backoffBaseMs: 250, sendAtMs: [0, 25, 50], reorderDelayMs: 125, replayDelayMs: 1250, timeScale: 0.25,
  });
  // 0.005 x 100 = 0.5 rounds up, as Java's Math.round does.
  assert.deepEqual(expectedTiming(0.005).sendAtMs, [0, 1, 1]);
});
