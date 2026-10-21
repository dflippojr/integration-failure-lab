// eslint.config.js must ignore what .gitignore ignores: flat-config ESLint does not read .gitignore, and npm test
// itself writes dist-test/, so a generated directory left out of the ignores fails npm run lint on a rerun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('..', import.meta.url));

test('ESLint ignores every generated directory that .gitignore lists', async () => {
  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  const dirs = gitignore.split('\n').map(l => l.trim()).filter(l => l.endsWith('/') && !l.startsWith('#'));
  assert.ok(dirs.includes('dist-test/'));
  const eslint = new ESLint({ cwd: root });
  const linted = [];
  for (const dir of dirs) {
    if (!(await eslint.isPathIgnored(`${dir}generated.js`))) linted.push(dir);
  }
  assert.deepEqual(linted, []);
});

// A file URL's pathname is not a filesystem path: on Windows it is /C:/..., and a space stays %20.
test('ESLint rejects a file URL pathname used as a filesystem path', async () => {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText("export const dir = new URL('..', import.meta.url).pathname;\n", { filePath: 'test/sample.test.js' });
  assert.deepEqual(result.messages.map(m => m.ruleId), ['no-restricted-syntax']);
});
