// Report whether a site's vendored copy of the lab is current with main.
// Usage: node scripts/site-freshness.mjs <lab-dir> [ref]   (ref defaults to main)
//   <lab-dir> is the vendored bundle, for example ../personal-website/public/lab; only its build.json is read.
// Exits 0 when build.json names ref's commit, 1 when the copy is stale (behind ref, not on ref, unstamped or
// missing build.json), and 2 on a usage error. Commits are resolved in this checkout, so fetch ref first.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runGit } from './git.mjs';

const root = resolve(import.meta.dirname, '..');
const [dir, ref = 'main'] = process.argv.slice(2);
if (!dir) {
  console.error('Usage: node scripts/site-freshness.mjs <lab-dir> [ref]');
  process.exit(2);
}
const git = (...args) => runGit(root, ...args);
const stale = message => {
  console.log(message);
  process.exit(1);
};

const stampFile = join(dir, 'build.json');
if (!existsSync(stampFile)) stale(`stale: ${stampFile} is missing, so the copy predates stamped builds`);
let stamp;
try {
  stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
} catch (error) {
  stale(`stale: ${stampFile} is not JSON (${error.message})`);
}
const { gitCommit, builtFrom } = stamp ?? {};
if (builtFrom !== 'integration-failure-lab') stale(`stale: ${stampFile} was not built from integration-failure-lab`);
if (!/^[0-9a-f]{40}$/.test(gitCommit)) stale(`stale: ${stampFile} names no clean commit (${gitCommit})`);

const tip = git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
if (tip.status !== 0) {
  console.error(`Cannot resolve ${ref} in ${root}; fetch it first.`);
  process.exit(2);
}
const main = tip.stdout.trim();
if (git('merge-base', '--is-ancestor', gitCommit, main).status !== 0) {
  stale(`stale: ${gitCommit} is not on ${ref} (${main})`);
}
const count = (...paths) => Number(git('rev-list', '--count', `${gitCommit}..${main}`, '--', ...paths).stdout.trim());
const behind = count();
if (behind > 0) {
  stale(`stale by ${behind} commit${behind === 1 ? '' : 's'} (${count('dist')} changed dist/): built from ${gitCommit}, ${ref} is ${main}`);
}
console.log(`current: built from ${ref} at ${main}`);
