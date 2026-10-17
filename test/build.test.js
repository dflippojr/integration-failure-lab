// scripts/build.mjs only writes to its fixed targets; anything else is refused.
// It stamps build.json with the commit, and scripts/site-freshness.mjs compares a site copy's stamp with main.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = join(root, 'scripts', 'build.mjs');

test('build refuses a target that is not one of its fixed names', () => {
  const target = join(parse(build).root, 'ifl-build-escape-test');
  const run = spawnSync(process.execPath, [build, target], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown target/);
  assert.equal(existsSync(target), false);
});

// A private lab checkout in its own git repository, with the website checkout beside it: <tmp>/lab, <tmp>/personal-website.
let tmp, lab, site;
const git = (...args) => {
  const run = spawnSync('git', ['-c', 'user.name=Lab Test', '-c', 'user.email=lab@test.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], { cwd: lab, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
const commit = message => { git('add', '-A'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
const node = (script, ...args) => spawnSync(process.execPath, [join(lab, 'scripts', script), ...args], { cwd: lab, encoding: 'utf8' });
const stamp = () => JSON.parse(readFileSync(join(site, 'build.json'), 'utf8'));

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ifl-build-'));
  lab = join(tmp, 'lab');
  site = join(tmp, 'personal-website', 'public', 'lab');
  mkdirSync(join(lab, 'scripts'), { recursive: true });
  for (const f of ['build.mjs', 'site-freshness.mjs']) cpSync(join(root, 'scripts', f), join(lab, 'scripts', f));
  for (const d of ['engine', 'ui', 'scenarios', 'executed']) cpSync(join(root, d), join(lab, d), { recursive: true });
  cpSync(join(root, 'package.json'), join(lab, 'package.json'));
  writeFileSync(join(lab, '.gitignore'), 'node_modules\n');
  symlinkSync(join(root, 'node_modules'), join(lab, 'node_modules'), 'junction');
  git('init', '-q', '-b', 'main');
  commit('lab');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test('site build refuses a dirty checkout and writes nothing', () => {
  writeFileSync(join(lab, 'engine', 'engine.js'), `${readFileSync(join(lab, 'engine', 'engine.js'), 'utf8')}// local edit\n`);
  try {
    const run = node('build.mjs', 'site');
    assert.equal(run.status, 1);
    assert.match(run.stderr, /uncommitted changes \([0-9a-f]{40}-dirty\)/);
    assert.equal(existsSync(join(tmp, 'personal-website')), false);
  } finally {
    git('checkout', '--', 'engine/engine.js');
  }
});

test('dist and test builds mark a dirty checkout instead of refusing it', () => {
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(lab, 'scenarios', 'zz-untracked.json'), '{}');
  try {
    for (const [target, dir] of [['dist', 'dist'], ['test', 'dist-test']]) {
      const run = node('build.mjs', target);
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(readFileSync(join(lab, dir, 'build.json'), 'utf8')),
        { gitCommit: `${head}-dirty`, builtFrom: 'integration-failure-lab' });
    }
  } finally {
    for (const p of ['scenarios/zz-untracked.json', 'dist', 'dist-test']) rmSync(join(lab, p), { recursive: true, force: true });
  }
});

test('build outside a git checkout stamps the commit as unknown and refuses the site target', () => {
  const bare = join(tmp, 'bare');
  for (const p of ['scripts', 'engine', 'ui', 'scenarios', 'executed', 'package.json']) cpSync(join(lab, p), join(bare, p), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(bare, 'node_modules'), 'junction');
  // GIT_CEILING_DIRECTORIES stops git from finding a repository above the temporary directory.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: tmp };
  const run = target => spawnSync(process.execPath, [join(bare, 'scripts', 'build.mjs'), target], { encoding: 'utf8', env });
  const site = run('site');
  assert.equal(site.status, 1);
  assert.match(site.stderr, /must run from a git checkout/);
  const dist = run('dist');
  assert.equal(dist.status, 0, dist.stderr);
  assert.equal(JSON.parse(readFileSync(join(bare, 'dist', 'build.json'), 'utf8')).gitCommit, 'unknown');
});

test('site build stamps the clean HEAD, and the freshness check follows main', () => {
  const head = git('rev-parse', 'HEAD');
  const built = node('build.mjs', 'site');
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(stamp(), { gitCommit: head, builtFrom: 'integration-failure-lab' });

  let check = node('site-freshness.mjs', site);
  assert.equal(check.status, 0, check.stdout);
  assert.equal(check.stdout.trim(), `current: built from main at ${head}`);

  writeFileSync(join(lab, 'README.md'), 'docs only\n');
  commit('docs');
  mkdirSync(join(lab, 'dist'));
  writeFileSync(join(lab, 'dist', 'index.html'), '<!doctype html>\n');
  const tip = commit('dist');
  check = node('site-freshness.mjs', site);
  assert.equal(check.status, 1);
  assert.equal(check.stdout.trim(), `stale by 2 commits (1 changed dist/): built from ${head}, main is ${tip}`);

  // An explicit ref is compared instead of main.
  check = node('site-freshness.mjs', site, 'HEAD~1');
  assert.equal(check.status, 1);
  assert.match(check.stdout, /^stale by 1 commit \(0 changed dist\/\)/);
});

test('freshness check reports a commit that is not on main as stale', () => {
  const main = git('rev-parse', 'main');
  git('checkout', '-q', '-b', 'side');
  writeFileSync(join(lab, 'side.txt'), 'side\n');
  const side = commit('side');
  git('checkout', '-q', 'main');
  writeFileSync(join(site, 'build.json'), JSON.stringify({ gitCommit: side, builtFrom: 'integration-failure-lab' }));
  const check = node('site-freshness.mjs', site);
  assert.equal(check.status, 1);
  assert.equal(check.stdout.trim(), `stale: ${side} is not on main (${main})`);
});

test('freshness check treats a missing, unreadable or unstamped build.json as stale', () => {
  const file = join(site, 'build.json');
  for (const [content, message] of [
    [null, /^stale: .*build\.json is missing/],
    ['not json', /^stale: .*build\.json is not JSON/],
    ['null', /^stale: .*was not built from integration-failure-lab/],
    [JSON.stringify({ gitCommit: 'a'.repeat(40), builtFrom: 'elsewhere' }), /was not built from integration-failure-lab/],
    [JSON.stringify({ gitCommit: `${'a'.repeat(40)}-dirty`, builtFrom: 'integration-failure-lab' }), /names no clean commit \(a{40}-dirty\)/],
  ]) {
    rmSync(file, { force: true });
    if (content !== null) writeFileSync(file, content);
    const check = node('site-freshness.mjs', site);
    assert.equal(check.status, 1, `${content}: ${check.stdout}`);
    assert.match(check.stdout, message);
  }
});

test('freshness check exits 2 without a directory or with a ref this checkout cannot resolve', () => {
  const usage = node('site-freshness.mjs');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^Usage:/);
  writeFileSync(join(site, 'build.json'), JSON.stringify({ gitCommit: git('rev-parse', 'HEAD'), builtFrom: 'integration-failure-lab' }));
  const unknown = node('site-freshness.mjs', site, 'origin/no-such-branch');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Cannot resolve origin\/no-such-branch/);
});
