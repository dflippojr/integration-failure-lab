// The one launch of the Java runner jar, shared by the gate scripts that run it (scripts/recordings.mjs and
// scripts/differential.mjs). The jar's path, the choice of java and the exit check live here; each caller passes
// only its own arguments.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const JAR = join(root, 'java', 'target', 'integration-failure-lab-0.1.0-SNAPSHOT.jar');

// Runs `java -jar <jar> ...args` from java/, so the runner finds ../scenarios. java is JAVA_HOME's bin/java when
// JAVA_HOME is set, otherwise java from PATH. Throws when the jar is missing, when java cannot start, and when the
// runner exits non-zero. spawn stands in for spawnSync in tests: their fake java is a Node script, and Windows can't
// spawn a script without a shell.
export function runJar(args, { jar = JAR, javaHome = process.env.JAVA_HOME, spawn = spawnSync } = {}) {
  if (!existsSync(jar)) throw new Error(`No runner jar at ${jar}; build it with: cd java && ./mvnw -B package -DskipTests`);
  const java = javaHome ? join(javaHome, 'bin', 'java') : 'java';
  const result = spawn(java, ['-jar', jar, ...args], { cwd: join(root, 'java'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Java runner exited with ${result.status}`);
}
