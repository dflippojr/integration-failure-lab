// scripts/build.mjs only writes inside the folder holding this repo or the OS temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));

test('build refuses a target outside the workspace and temp dir', () => {
  const target = join(parse(build).root, 'ifl-build-escape-test');
  const run = spawnSync(process.execPath, [build, target], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing to write there/);
  assert.equal(existsSync(target), false);
});
