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
// The workflow is read with LF endings so a CRLF checkout (core.autocrlf=true) sees the same text as CI.
const publishJob = text => {
  const ci = text.replace(/\r\n/g, '\n');
  return ci.slice(ci.indexOf('\n  publish:'));
};
const queuesEveryPublish = publish =>
  /concurrency:\n\s+group: lab-bundle\n\s+cancel-in-progress: false\n\s+queue: max\n/.test(publish);

test('the publish job queues every pending publish instead of replacing it', () => {
  const publish = publishJob(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.ok(queuesEveryPublish(publish));
  assert.match(publish, /git merge-base --is-ancestor "\$GITHUB_SHA" "\$current"/);
});

test('the queue check reads LF and CRLF workflows alike, and still fails without queue: max', () => {
  const job = '\n  publish:\n    concurrency:\n      group: lab-bundle\n      cancel-in-progress: false\n      queue: max\n    env:\n';
  const crlf = text => text.replace(/\n/g, '\r\n');
  const without = job.replace('      queue: max\n', '');
  assert.ok(queuesEveryPublish(publishJob(job)));
  assert.ok(queuesEveryPublish(publishJob(crlf(job))));
  assert.ok(!queuesEveryPublish(publishJob(without)));
  assert.ok(!queuesEveryPublish(publishJob(crlf(without))));
});
