// The whole CI gate on this machine: the engine, java, differential and playwright jobs of .github/workflows/ci.yml,
// in turn, with Java on one fork and Playwright on one worker. Every step runs even after another fails,
// so one run shows everything that is red; Ctrl+C skips the remaining steps. The disposable UI instance
// is always stopped afterwards. Exits 1 unless every step, and the stop, succeeded.
// Usage: npm run ci:local
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
// An explicit relative path: cmd.exe skips the current directory when NoDefaultCurrentDirectoryInExePath is set.
const mvnw = process.platform === 'win32' ? String.raw`.\mvnw.cmd` : './mvnw';

export const STEPS = [
  { name: 'engine', command: 'npm run test:coverage', cwd: root },
  { name: 'java', command: `${mvnw} -B verify -DforkCount=1`, cwd: join(root, 'java') },
  { name: 'differential', command: `${mvnw} -B package -DskipTests && cd .. && npm run differential`, cwd: join(root, 'java') },
  { name: 'playwright', command: 'npm run test:ui -- --workers=1', cwd: root },
];
export const STOP = { name: 'ui:stop', command: 'npm run ui:stop', cwd: root };

function run({ name, command, cwd }, log) {
  log(`\n== ${name}: ${command}`);
  return new Promise(done => {
    spawn(command, { cwd, shell: true, stdio: 'inherit' })
      .on('error', () => done({ name, result: 'failure' }))
      .on('close', code => done({ name, result: code === 0 ? 'success' : 'failure' }));
  });
}

export async function runGate(steps = STEPS, stop = STOP, log = console.log) {
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  const results = [];
  for (const step of steps) {
    results.push(interrupted ? { name: step.name, result: 'skipped' } : await run(step, log));
  }
  results.push(await run(stop, log));
  process.off('SIGINT', onInterrupt);
  log('\nci:local');
  for (const { name, result } of results) log(`  ${name}: ${result}`);
  return results.every(r => r.result === 'success') ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runGate();
