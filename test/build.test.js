// scripts/build.mjs only writes to its fixed targets; anything else is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const build = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));

test('build refuses a target that is not one of its fixed names', () => {
  const target = join(parse(build).root, 'ifl-build-escape-test');
  const run = spawnSync(process.execPath, [build, target], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown target/);
  assert.equal(existsSync(target), false);
});
