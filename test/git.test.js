// scripts/git.mjs runs git by an absolute path found once on PATH, with a fixed minimal environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { findGit, gitEnv, gitPath, gitRunner } from '../scripts/git.mjs';

test('findGit takes the first git in an absolute PATH entry and skips relative entries', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ifl-git-'));
  try {
    for (const name of ['git', 'git.exe']) {
      writeFileSync(join(tmp, name), '');
      chmodSync(join(tmp, name), 0o755);
    }
    assert.equal(findGit(['.', 'bin', tmp].join(delimiter), 'linux'), join(tmp, 'git'));
    assert.equal(findGit(['', tmp].join(delimiter), 'win32'), join(tmp, 'git.exe'));
    assert.equal(findGit(join(tmp, 'missing'), 'linux'), null);
    assert.equal(findGit(undefined, 'linux'), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('findGit skips a git that is not an executable file', { skip: process.platform === 'win32' }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ifl-git-'));
  try {
    writeFileSync(join(tmp, 'git'), '');
    assert.equal(findGit(tmp, 'linux'), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('gitEnv keeps only the variables git needs, with PATH set to the git directory', () => {
  const env = gitEnv('/opt/git/bin/git', {
    PATH: '/evil:/opt/git/bin', HOME: '/home/lab', GIT_DIR: '/lab/.git', NODE_OPTIONS: '--require evil', GIT_EXEC_PATH: '/evil',
  });
  assert.deepEqual(env, { PATH: dirname('/opt/git/bin/git'), HOME: '/home/lab', GIT_DIR: '/lab/.git', LC_ALL: 'C' });
});

test('gitRunner runs the absolute git, and reports a failure when none was found', () => {
  assert.ok(isAbsolute(gitPath), gitPath);
  const version = gitRunner(gitPath)('.', '--version');
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^git version/);
  const missing = gitRunner(null)('.', 'rev-parse', 'HEAD');
  assert.equal(missing.status, null);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /git was not found/);
});

test('the build and freshness scripts never start git by name', () => {
  for (const script of ['build.mjs', 'site-freshness.mjs']) {
    const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /spawn(Sync)?\(\s*['"]git['"]/, script);
    assert.match(source, /from '\.\/git\.mjs'/, script);
  }
});

// Default concurrency keeps one pending job and cancels it when another arrives, so with A publishing, C pending
// and B arriving, C never publishes. queue: max keeps them all; the ancestry check skips one that arrives late.
test('the publish job queues every pending publish instead of replacing it', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const publish = ci.slice(ci.indexOf('\n  publish:'));
  assert.match(publish, /concurrency:\n\s+group: lab-bundle\n\s+cancel-in-progress: false\n\s+queue: max\n/);
  assert.match(publish, /git merge-base --is-ancestor "\$GITHUB_SHA" "\$current"/);
});
