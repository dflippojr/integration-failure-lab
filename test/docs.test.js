// Issue #199: the README repeats numbers that the code owns. These tests keep the README's copies equal to the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { combinations } from './differential/combos.mjs';

const root = new URL('../', import.meta.url);
const read = f => readFileSync(new URL(f, root), 'utf8');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json'));
// The engines floor is a bare ">=major.minor" or ">=major.minor.patch".
const floor = pkg.engines.node.match(/^>=(\d+)\.(\d+)(?:\.(\d+))?$/);

test('the README combination total is combinations().length', () => {
  const m = readme.match(/checks a generated subset of it, ([\d,]+) combinations\b/);
  assert.ok(m, 'README states the differential combination total');
  assert.equal(Number(m[1].replaceAll(',', '')), combinations().length);
});

test('the README Node floor is the major and minor of package.json engines.node', () => {
  assert.ok(floor, `engines.node is a >= floor, got ${pkg.engines.node}`);
  const status = readme.split('\n').find(line => line.startsWith('**Status:**'));
  const m = status?.match(/Node (\d+\.\d+)\+/);
  assert.ok(m, 'the README status line states its Node floor');
  assert.equal(m[1], `${floor[1]}.${floor[2]}`);
});

test('.nvmrc satisfies the engines.node floor', () => {
  assert.ok(floor, `engines.node is a >= floor, got ${pkg.engines.node}`);
  const pinned = read('.nvmrc').trim().split('.').map(Number);
  const minimum = [floor[1], floor[2], floor[3] ?? 0].map(Number);
  const cmp = [0, 1, 2].map(i => pinned[i] - minimum[i]).find(d => d !== 0) ?? 0;
  assert.ok(cmp >= 0, `.nvmrc pins ${pinned.join('.')}, below the floor ${minimum.join('.')}`);
});
