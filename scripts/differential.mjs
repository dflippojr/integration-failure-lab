// Differential test: runs every Free-form combination through the browser engine and through the Java
// runner over real HTTP, then fails on any outcome they disagree on that test/differential/known.json does
// not explain. Needs the runner jar: cd java && ./mvnw -B package -DskipTests
//
//   npm run differential                      all combinations
//   npm run differential -- --only <id> ...   just these (the repro line each mismatch prints)
//   npm run differential -- --workers <1-4>   Java combinations run at a time in the one JVM (default 4)
//   npm run differential -- --scale <f>       Java speed as a fraction of the engine's virtual clock (default 0.25)
//
// Files go to java/target/differential/: combinations.json, engine-outcomes.json and java-outcomes.json.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { combinations } from '../test/differential/combos.mjs';
import { engineOutcome, compare } from '../test/differential/outcome.mjs';
import { TIMING } from '../engine/engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KNOWN_PATH = join(root, 'test', 'differential', 'known.json');
const JAR = join(root, 'java', 'target', 'integration-failure-lab-0.1.0-SNAPSHOT.jar');
const OUT_DIR = join(root, 'java', 'target', 'differential');
export const MAX_KNOWN = 3;
// The Java runner's defaults are not proportional to the engine's virtual clock (its replay comes 1.3 ack
// timeouts after parking, the engine's 2.5), which reorders outcomes on its own. The differential run gives
// Java the engine's timing model at this fraction of its speed instead, so both sides share one timing
// semantics and only behaviour can differ. Loopback latency stands in for TIMING.latencyMs.
export const TIME_SCALE = 0.25;

export function javaTimingArgs(scale = TIME_SCALE) {
  const ms = v => Math.round(v * scale);
  const reorder = new Set(combinations().flatMap(c => (c.failures.reorder ? [c.failures.reorder.delayMs] : [])));
  if (reorder.size !== 1) throw new Error(`The Java runner takes one reorder delay; combinations use ${[...reorder].join(', ')}`);
  return [
    `--lab.timeout-ms=${ms(TIMING.timeoutMs)}`,
    `--lab.backoff-base-ms=${ms(TIMING.backoffBaseMs)}`,
    `--lab.send-at-ms=${TIMING.sendAt.map(ms).join(',')}`,
    `--lab.reorder-delay-ms=${ms([...reorder][0])}`,
    `--lab.replay-delay-ms=${ms(TIMING.replayAfterMs)}`,
  ];
}

// Owner-decided divergences: at most MAX_KNOWN, each with an issue link and the exact combination ids it
// explains, so it can never hide a new mismatch. The file only ever shrinks.
export function loadKnown(path = KNOWN_PATH) {
  const known = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(known)) throw new Error(`${path} must hold an array`);
  if (known.length > MAX_KNOWN) throw new Error(`${path} lists ${known.length} known divergences; at most ${MAX_KNOWN} are allowed`);
  for (const k of known) {
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/.test(k.issue ?? '')) throw new Error(`Known divergence without an issue link: ${JSON.stringify(k)}`);
    if (!Array.isArray(k.combinations) || !k.combinations.length) throw new Error(`Known divergence ${k.issue} lists no combinations`);
  }
  return known;
}

export function report({ explained, unexplained, stale }, total, write = console.log) {
  for (const m of unexplained) {
    write(`\nMISMATCH ${m.combination.id} (differs in: ${m.fields.join(', ')})`);
    write(`  combination: ${JSON.stringify({ failures: m.combination.failures, safeguards: m.combination.safeguards })}`);
    write(`  engine:      ${JSON.stringify(m.engine)}`);
    write(`  java:        ${JSON.stringify(m.java)}`);
    write(`  repro:       npm run differential -- --only ${m.combination.id}`);
  }
  for (const { known, id } of stale) write(`\nSTALE ${id}: listed under ${known.issue} but both sides agree now; remove it from test/differential/known.json`);
  const perIssue = new Map();
  for (const m of explained) perIssue.set(m.known.issue, (perIssue.get(m.known.issue) ?? 0) + 1);
  const byIssue = [...perIssue].map(([issue, n]) => `${n} by ${issue}`);
  write(`\n${total} combinations: ${total - explained.length - unexplained.length} agree, `
    + `${explained.length} known divergences${byIssue.length ? ` (${byIssue.join(', ')})` : ''}, ${unexplained.length} unexplained mismatches.`);
  return unexplained.length === 0 && stale.length === 0;
}

// Command-line options, validated: ids must name generated combinations, and only numbers reach the JVM.
export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      only: { type: 'string', multiple: true },
      workers: { type: 'string', default: '4' },
      scale: { type: 'string', default: String(TIME_SCALE) },
    },
  });
  const workers = Number(values.workers);
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error(`--workers must be 1-4, not ${values.workers}`);
  const scale = Number(values.scale);
  if (!(scale > 0 && scale <= 1)) throw new Error(`--scale must be a number in (0, 1], not ${values.scale}`);
  return { only: values.only, workers, scale };
}

// Runs the runner jar's batch mode: combinations in inFile, outcomes to outFile.
function runJar(inFile, outFile, args) {
  if (!existsSync(JAR)) throw new Error(`No runner jar at ${JAR}; build it with: cd java && ./mvnw -B package -DskipTests`);
  const javaHome = process.env.JAVA_HOME;
  const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const result = spawnSync(java, ['-jar', JAR, `--lab.differential-in=${inFile}`, `--lab.differential-out=${outFile}`, ...args],
    { cwd: join(root, 'java'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Java runner exited with ${result.status}`);
}

// Runs the selected combinations on both sides and reports; true when nothing is unexplained or stale.
export function differential({ only, workers = 4, scale = TIME_SCALE } = {},
  { runJava = runJar, out = OUT_DIR, known = loadKnown(), write = console.log } = {}) {
  const all = combinations();
  let selected = all;
  if (only) {
    const wanted = new Set(only);
    selected = all.filter(c => wanted.has(c.id));
    const missing = [...wanted].filter(id => !selected.some(c => c.id === id));
    if (missing.length) throw new Error(`Unknown combination id: ${missing.join(', ')}`);
  }
  const javaArgs = [`--lab.differential-workers=${workers}`, ...javaTimingArgs(scale)];
  write(`Differential test: ${selected.length} of ${all.length} combinations; Java ${javaArgs.join(' ')}`);

  mkdirSync(out, { recursive: true });
  const inFile = join(out, 'combinations.json');
  const outFile = join(out, 'java-outcomes.json');
  writeFileSync(inFile, JSON.stringify(selected, null, 2));
  const engine = new Map(selected.map(c => [c.id, engineOutcome(c)]));
  writeFileSync(join(out, 'engine-outcomes.json'), JSON.stringify(selected.map(c => ({ id: c.id, outcome: engine.get(c.id) })), null, 2));
  runJava(inFile, outFile, javaArgs);
  const java = new Map(JSON.parse(readFileSync(outFile, 'utf8')).map(e => [e.id, e.outcome]));

  const result = compare(selected, engine, java, known);
  // A subset run cannot tell whether a known divergence is stale.
  if (only) result.stale = [];
  return report(result, selected.length, write);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!differential(parseOptions(process.argv.slice(2)))) process.exitCode = 1;
}
