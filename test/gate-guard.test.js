// .github/workflows/gate-guard-target.yml posts the gate-guard check the ruleset requires next to gate.
// pull_request_target runs it as it is on main, so a pull request can't rewrite the check that judges it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SHA = '882623c67a5c3bab64da2136e6070a5325440b47';
const read = path => readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), 'utf8');
// Without comment lines, so a key named in a comment doesn't count.
const code = text => text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');

test('the gate guard runs from main under pull_request_target and runs no pull request code', () => {
  const target = code(read('gate-guard-target.yml'));
  const [header, jobs] = target.split('\njobs:\n');
  assert.match(header, /^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, edited, labeled, unlabeled, closed\]\n/m);
  assert.doesNotMatch(target, /\bpull_request:|workflow_dispatch|\bpush:/);
  assert.match(header, /^permissions:\n {2}contents: read\n {2}issues: read\n {2}pull-requests: read\n {2}checks: write\n\n/m);
  assert.match(header, /group: gate-guard-target-\$\{\{ github\.event\.pull_request\.head\.sha \}\}\n {2}cancel-in-progress: true/);
  // One job, which only calls the shared workflow; the script it loads and the workflow are the same reviewed SHA.
  assert.deepEqual([...jobs.matchAll(/^ {2}([\w-]+):$/gm)].map(m => m[1]), ['judge']);
  assert.match(jobs, new RegExp(`^ {4}uses: dflippojr/\\.github/\\.github/workflows/gate-guard-target\\.yml@${SHA}\\n {4}with:\\n {6}guard-ref: ${SHA}\\n`, 'm'));
  for (const unsafe of ['steps:', 'run:', 'actions/checkout', 'secrets', 'self-hosted', 'github.head_ref', 'github.event.pull_request.title']) {
    assert.ok(!jobs.includes(unsafe), unsafe);
  }
});

test('ci stays on pull_request, so no pull request code runs with a write token', () => {
  for (const file of ['ci.yml', 'sonar.yml']) assert.doesNotMatch(read(file), /pull_request_target/, file);
});

test('ci.yml runs the same gate guard, pinned to the same SHA, and gate waits for it', () => {
  const [, jobs] = code(read('ci.yml')).split('\njobs:\n');
  assert.match(jobs, new RegExp(`^ {2}gate-guard:\\n {4}permissions:\\n {6}contents: read\\n {6}issues: read\\n {6}pull-requests: read\\n {4}uses: dflippojr/\\.github/\\.github/workflows/gate-guard\\.yml@${SHA}\\n {4}with:\\n {6}guard-ref: ${SHA}\\n {6}require-owner-label-actor: true\\n`, 'm'));
  assert.match(jobs, /^ {4}needs: \[engine, java, differential, recordings, playwright, gate-guard\]$/m);
});
