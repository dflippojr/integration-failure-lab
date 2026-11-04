// Issue #182: CI runs one exact Node version, pinned in .nvmrc, so a Node release can't move the gzip budget
// in dist.test.js (measured on that version).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pinned = readFileSync(new URL('.nvmrc', root), 'utf8').trim();

test('.nvmrc pins one exact Node version', () => {
  assert.match(pinned, /^\d+\.\d+\.\d+$/);
});

test('every setup-node step reads .nvmrc and names no version of its own', () => {
  const dir = new URL('.github/workflows/', root);
  let steps = 0;
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    const lines = readFileSync(new URL(file, dir), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/uses:\s*actions\/setup-node@/.test(line)) return;
      steps++;
      const indent = line.indexOf('uses:');
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === '') continue;
        if (next.search(/\S/) < indent || /^\s*-\s/.test(next)) break;
        body.push(next.trim());
      }
      const where = `${file}:${i + 1}`;
      assert.ok(body.includes('node-version-file: .nvmrc'), `${where} reads .nvmrc`);
      assert.ok(!body.some((b) => b.startsWith('node-version:')), `${where} sets no node-version`);
    });
  }
  assert.ok(steps > 0, 'found setup-node steps');
});

test('in CI, the running Node is the pinned one', () => {
  // Outside CI (a contributor's own Node) there is nothing to compare against.
  const expected = process.env.GITHUB_ACTIONS === 'true' ? `v${pinned}` : process.version;
  assert.equal(process.version, expected);
});
