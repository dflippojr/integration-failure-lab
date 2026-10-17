// eslint.config.js must ignore what .gitignore ignores: flat-config ESLint does not read .gitignore, and npm test
// itself writes dist-test/, so a generated directory left out of the ignores fails npm run lint on a rerun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ESLint } from 'eslint';

test('ESLint ignores every generated directory that .gitignore lists', async () => {
  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  const dirs = gitignore.split('\n').map(l => l.trim()).filter(l => l.endsWith('/') && !l.startsWith('#'));
  assert.ok(dirs.includes('dist-test/'));
  const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname });
  const linted = [];
  for (const dir of dirs) {
    if (!(await eslint.isPathIgnored(`${dir}generated.js`))) linted.push(dir);
  }
  assert.deepEqual(linted, []);
});
