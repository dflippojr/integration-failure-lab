// scripts/java-runner.mjs is the one launch of the runner jar; scripts/recordings.mjs and scripts/differential.mjs call it.
import { spawnSync } from 'node:child_process';
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JAR, runJar } from '../scripts/java-runner.mjs';
import { RERECORD } from '../scripts/recordings.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

// Runs fn with the named environment variables set (undefined removes one), then puts every one back.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]]));
  const set = values => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  set(vars);
  try {
    return fn();
  } finally {
    set(saved);
  }
}

describe('the shared runner-jar launch', () => {
  let dir;
  let jar;
  const seenFile = () => join(dir, 'seen.txt');
  // The arguments the fake java recorded: its working directory, then each argument on its own line.
  const seen = () => readFileSync(seenFile(), 'utf8').trimEnd().split('\n');

  // A bin/java that writes its working directory and arguments to seen.txt, then exits with status. It is a Node
  // script, not a shell script, so that it runs on Windows too; viaNode runs it.
  const fakeJava = (binDir, status = 0) => {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'java'),
      // import() rather than require or a static import: the script must run as CommonJS or as ES module, whichever
      // the package.json above the temp directory (if any) makes it.
      `import('node:fs').then(fs => {\n` +
        `  fs.writeFileSync(${JSON.stringify(seenFile())}, [fs.realpathSync(process.cwd()), ...process.argv.slice(2)].join('\\n') + '\\n');\n` +
        `  process.exit(${status});\n` +
        `});\n`,
    );
    return binDir;
  };
  // runJar's spawn for the fake java: runs the java that spawnSync would run (a path as given, a bare name from PATH)
  // with this Node, since Windows can't spawn a script without a shell.
  const viaNode = (command, argv, options) => {
    const file = isAbsolute(command) ? command : process.env.PATH.split(delimiter).map(d => join(d, command)).find(existsSync);
    return spawnSync(process.execPath, [file, ...argv], options);
  };
  const fakeHome = (name, status) => join(fakeJava(join(dir, name, 'bin'), status), '..');

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ifl-java-runner-'));
    jar = join(dir, 'runner.jar');
    writeFileSync(jar, '');
  });
  beforeEach(() => rmSync(seenFile(), { force: true }));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('a missing jar is refused with the build command, before java runs', () => {
    const missing = join(dir, 'missing.jar');
    assert.throws(() => runJar([], { jar: missing, javaHome: fakeHome('refuses', 3), spawn: viaNode }), {
      message: `No runner jar at ${missing}; build it with: cd java && ./mvnw -B package -DskipTests`,
    });
  });

  test('a runner that exits non-zero is reported with its status', () => {
    assert.throws(() => runJar(['--lab.export-dir=/out'], { jar, javaHome: fakeHome('exits3', 3), spawn: viaNode }), {
      message: 'Java runner exited with 3',
    });
  });

  test('the launch is java -jar <jar> <args> in the given order, run from java/', () => {
    runJar(['--lab.export-dir=/out', '--lab.differential-workers=2'], { jar, javaHome: fakeHome('launch'), spawn: viaNode });
    assert.deepEqual(seen(), [realpathSync(join(root, 'java')), '-jar', jar, '--lab.export-dir=/out', '--lab.differential-workers=2']);
  });

  test('a javaHome without bin/java is a spawn failure, and it is thrown', () => {
    assert.throws(() => runJar([], { jar, javaHome: join(dir, 'no-java-here') }), { code: 'ENOENT' });
  });

  test('JAVA_HOME is the java that runs; without it, java comes from PATH', () => {
    withEnv({ JAVA_HOME: fakeHome('from-env') }, () => runJar([], { jar, spawn: viaNode }));
    assert.deepEqual(seen(), [realpathSync(join(root, 'java')), '-jar', jar]);

    const onPath = fakeJava(join(dir, 'path-bin'));
    withEnv({ JAVA_HOME: undefined, PATH: `${onPath}${delimiter}${process.env.PATH}` }, () => runJar(['--x'], { jar, spawn: viaNode }));
    assert.deepEqual(seen(), [realpathSync(join(root, 'java')), '-jar', jar, '--x']);
  });

  test('neither gate script has its own launch: both call the shared runJar', () => {
    for (const script of ['recordings.mjs', 'differential.mjs']) {
      const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /\bJAR\b/, `${script} names the jar`);
      assert.doesNotMatch(source, /spawnSync/, `${script} spawns java`);
      assert.doesNotMatch(source, /No runner jar/, `${script} checks for the jar`);
      assert.match(source, /from '\.\/java-runner\.mjs'/, script);
      assert.match(source, /\brunJar\(/, script);
    }
  });

  test('the default jar is the one the README re-record command builds', () => {
    assert.equal(JAR, join(root, 'java', 'target', 'integration-failure-lab-0.1.0-SNAPSHOT.jar'));
    assert.ok(RERECORD.includes(`target/${basename(JAR)}`), RERECORD);
  });
});
