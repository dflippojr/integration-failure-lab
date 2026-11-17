// Differential test: runs the generated combinations (test/differential/combos.mjs) through the browser
// engine and through the Java runner over real HTTP, then fails on any outcome they disagree on that
// test/differential/known.json does not explain. They are each failure setting under each single safeguard
// change, each pair of failure kinds under the defaults, every four-failure Free-form setting under the
// defaults and with the consumer safeguards on, the longest runs around the retry limit, and a seeded sample of
// three-kind runs; not the whole Free-form space. Needs the runner jar: cd java && ./mvnw -B package -DskipTests
//
//   npm run differential                      all combinations
//   npm run differential -- --only <id> ...   just these (the repro line each mismatch prints)
//   npm run differential -- --workers <1-4>   Java combinations run at a time in the one JVM (default 4)
//   npm run differential -- --scale <f>       Java speed as a fraction of the engine's virtual clock, as --lab.time-scale
//                                             (default 0.25, the runner's own default, so no timing argument; at least 0.005)
//
// Files go to java/target/differential/: combinations.json, engine-outcomes.json and java-outcomes.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { combinations } from '../test/differential/combos.mjs';
import { engineOutcome, compare } from '../test/differential/outcome.mjs';
import { TIMING } from '../engine/engine.js';
import { runJar } from './java-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KNOWN_PATH = join(root, 'test', 'differential', 'known.json');
const OUT_DIR = join(root, 'java', 'target', 'differential');
export const MAX_KNOWN = 3;
// One timing model (#197): the Java runner runs the engine's TIMING at lab.time-scale of its length, 0.25 by default
// (LabProperties.DEFAULT_TIME_SCALE), the scale the shipped recordings use. So at the default scale the differential
// passes no timing arguments and checks the very configuration that records executed/; another --scale reaches the
// runner as --lab.time-scale. Loopback latency stands in for TIMING.latencyMs.
export const TIME_SCALE = 0.25;

// The Java runner plays one reorder delay, TIMING.reorderDelayMs at its scale, whatever a combination asks for.
function checkReorderDelay() {
  const other = combinations().map(c => c.failures.reorder?.delayMs).find(d => d !== undefined && d !== TIMING.reorderDelayMs);
  if (other !== undefined) throw new Error(`The Java runner plays TIMING.reorderDelayMs (${TIMING.reorderDelayMs} ms) at its scale; a combination uses ${other}`);
}

// The engine timings the Java runner scales, in the engine's milliseconds: each property with its values.
function engineJavaTimings() {
  return [
    ['lab.timeout-ms', [TIMING.timeoutMs]],
    ['lab.backoff-base-ms', [TIMING.backoffBaseMs]],
    ['lab.send-at-ms', TIMING.sendAt],
    ['lab.reorder-delay-ms', [TIMING.reorderDelayMs]],
    ['lab.replay-delay-ms', [TIMING.replayAfterMs]],
  ];
}

// The Java runner's arguments for this scale: none at its default, which is already the engine's TIMING at TIME_SCALE.
export function javaTimingArgs(scale = TIME_SCALE) {
  checkReorderDelay();
  return scale === TIME_SCALE ? [] : [`--lab.time-scale=${scale}`];
}

// LabProperties reads a delay of 0 or less as unset and substitutes its default (#179), so a positive timing must still
// round above 0 at this scale. Math.round gives 0 below 0.5, so the smallest accepted scale is 0.5 over the smallest
// positive timing. A send time of 0 is E1's own send time, not a rounding result, so it is exempt.
function checkScale(scale) {
  const timings = engineJavaTimings();
  for (const [name, values] of timings) {
    const zeroed = values.find(v => v > 0 && Math.round(v * scale) === 0);
    if (zeroed !== undefined) {
      const smallest = 0.5 / Math.min(...timings.flatMap(([, all]) => all.filter(v => v > 0)));
      throw new Error(`--scale ${scale} rounds ${name} (${zeroed} ms) to 0 in the Java runner; the smallest accepted scale is ${smallest}`);
    }
  }
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
  checkScale(scale);
  return { only: values.only, workers, scale };
}

// Runs the runner jar's batch mode: combinations in inFile, outcomes to outFile.
function runBatch(inFile, outFile, args) {
  runJar([`--lab.differential-in=${inFile}`, `--lab.differential-out=${outFile}`, ...args]);
}

// Runs the selected combinations on both sides and reports; true when nothing is unexplained or stale.
export function differential({ only, workers = 4, scale = TIME_SCALE } = {},
  { runJava = runBatch, out = OUT_DIR, known = loadKnown(), write = console.log } = {}) {
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
