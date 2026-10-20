// Recording drift check: re-records every scenario with the Java runner into a temp directory and compares
// the result with the committed executed/, so the "real run" the site replays is what the current Java code
// does. generatedAt, warmupMs, runtime (JDK build) and each trace row's wall-clock t are left out; everything
// else, including trace order, record, dlq, dropped and buffered, must match. Key order is not compared.
// Needs the runner jar: cd java && ./mvnw -B package -DskipTests
//
//   npm run recordings
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXECUTED = join(root, 'executed');
const JAR = join(root, 'java', 'target', 'integration-failure-lab-0.1.0-SNAPSHOT.jar');
export const RERECORD = 'cd java && ./mvnw -B package -DskipTests && java -jar target/integration-failure-lab-0.1.0-SNAPSHOT.jar --lab.export-dir=../executed';

// Keys sorted at every level, so a recording reads the same whatever order the runner wrote its keys in.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b)).map(k => [k, sorted(value[k])]));
  return value;
}

// An object without the named keys.
function without(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

// The behaviour of one recording (or index.json, which has no wall-clock fields).
export function normalise(recording) {
  if (Array.isArray(recording)) return sorted(recording);
  const rest = without(recording, ['generatedAt', 'warmupMs', 'runtime', 'trace']);
  return sorted(recording.trace ? { ...rest, trace: recording.trace.map(row => without(row, ['t'])) } : rest);
}

// A line diff of two texts (longest common subsequence), with up to `context` unchanged lines around each change.
export function lineDiff(a, b, context = 3) {
  const x = a.split('\n');
  const y = b.split('\n');
  const lcs = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push(`  ${x[i]}`); i++; j++; }
    else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(`- ${x[i++]}`);
    else ops.push(`+ ${y[j++]}`);
  }
  const keep = ops.map((op, k) => ops.slice(Math.max(0, k - context), k + context + 1).some(o => !o.startsWith('  ')));
  if (!keep.includes(true)) return '';
  const out = [];
  ops.forEach((op, k) => {
    if (keep[k]) out.push(op);
    else if (k === 0 || keep[k - 1]) out.push('  ...');
  });
  return out.join('\n');
}

const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const jsonFiles = dir => readdirSync(dir).filter(f => f.endsWith('.json')).sort((a, b) => a.localeCompare(b));

// Compares the committed recordings with fresh ones: a list of { file, problem, fields?, diff? }, empty when they agree.
export function compareRecordings(committedDir, freshDir) {
  const committed = jsonFiles(committedDir);
  const fresh = jsonFiles(freshDir);
  const drift = [];
  for (const file of committed.filter(f => !fresh.includes(f))) drift.push({ file, problem: 'not re-recorded: no scenario writes it any more' });
  for (const file of fresh.filter(f => !committed.includes(f))) drift.push({ file, problem: 'not committed' });
  for (const file of committed.filter(f => fresh.includes(f))) {
    const a = normalise(readJson(committedDir, file));
    const b = normalise(readJson(freshDir, file));
    const fields = Array.isArray(a)
      ? (JSON.stringify(a) === JSON.stringify(b) ? [] : ['index'])
      : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => x.localeCompare(y)).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (fields.length) drift.push({ file, problem: 'behaviour differs', fields, diff: lineDiff(JSON.stringify(a, null, 2), JSON.stringify(b, null, 2)) });
  }
  return drift;
}

export function report(drift, freshDir, write = console.log) {
  for (const d of drift) {
    write(`\nDRIFT executed/${d.file}: ${d.problem}${d.fields ? ` (differs in: ${d.fields.join(', ')})` : ''}`);
    if (d.diff) write(`--- executed/${d.file} (committed)\n+++ ${join(freshDir, d.file)} (re-recorded)\n${d.diff}`);
  }
  if (drift.length) {
    write(`\n${drift.length} recording(s) no longer match what the Java runner does. If the change is intended, re-record and commit:\n  ${RERECORD}`);
    write('then npm run build and commit dist/ (see README "Develop").');
  } else {
    write('\nRecordings match: executed/ is what the current Java runner does, apart from wall-clock timing.');
  }
  return drift.length === 0;
}

// Runs the runner jar's export mode into outDir, from java/ so it finds ../scenarios.
function exportWithJar(outDir) {
  if (!existsSync(JAR)) throw new Error(`No runner jar at ${JAR}; build it with: cd java && ./mvnw -B package -DskipTests`);
  const javaHome = process.env.JAVA_HOME;
  const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const result = spawnSync(java, ['-jar', JAR, `--lab.export-dir=${outDir}`], { cwd: join(root, 'java'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Java runner exited with ${result.status}`);
}

// Re-records into a fresh temp directory, kept when anything drifted so the diff can be inspected; true when nothing did.
export function recordings({ record = exportWithJar, committed = EXECUTED, write = console.log } = {}) {
  const fresh = mkdtempSync(join(tmpdir(), 'ifl-recordings-'));
  write(`Re-recording every scenario into ${fresh}`);
  record(fresh);
  const ok = report(compareRecordings(committed, fresh), fresh, write);
  if (ok) rmSync(fresh, { recursive: true, force: true });
  return ok;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!recordings()) process.exitCode = 1;
}
