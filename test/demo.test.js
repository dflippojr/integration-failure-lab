// The demo clip's tooling stays dev-only and pinned, and the committed clip stays within the README's budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));

test('demo tools are pinned exactly in demo/ and absent from the root install', () => {
  const demo = json('demo/package.json');
  for (const name of ['hyperframes', 'ffmpeg-static', 'gsap']) assert.match(demo.devDependencies[name], /^\d+\.\d+\.\d+$/, name);
  const lock = json('demo/package-lock.json');
  assert.equal(lock.packages['node_modules/hyperframes'].version, demo.devDependencies.hyperframes);
  const root = json('package.json');
  assert.deepEqual(Object.keys(root.devDependencies).sort(), ['@playwright/test', 'esbuild']);
  assert.equal(root.dependencies, undefined);
  assert.equal(root.scripts['demo:render'], 'node demo/render.mjs');
});

test('the shipped bundle does not reference the demo', () => {
  for (const file of readdirSync(new URL('../dist/', import.meta.url))) {
    assert.doesNotMatch(read(`dist/${file}`), /hyperframes|gsap|demo\//i, file);
  }
});

test('the committed clip and poster exist and the clip is at most 5 MB', () => {
  const clip = statSync(new URL('../demo/out/lab-demo.mp4', import.meta.url)).size;
  assert.ok(clip > 100_000 && clip <= 5 * 1024 * 1024, `clip is ${clip} bytes`);
  assert.ok(statSync(new URL('../demo/out/lab-demo-poster.png', import.meta.url)).size > 10_000);
});
