// Run git for the build and freshness scripts. git is looked up once, in the absolute PATH entries only, and run by
// that absolute path with a fixed minimal environment, so a relative PATH entry or an inherited variable such as
// GIT_EXEC_PATH or NODE_OPTIONS cannot choose what runs.
import { accessSync, constants, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export function findGit(path = '', platform = process.platform) {
  const name = platform === 'win32' ? 'git.exe' : 'git';
  for (const dir of path.split(delimiter).filter(d => isAbsolute(d))) {
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return file;
      }
    } catch {
      // Not here, or not executable: keep looking.
    }
  }
  return null;
}

// HOME and USERPROFILE find the user's git config, SystemRoot lets git start on Windows, and GIT_DIR and
// GIT_CEILING_DIRECTORIES choose the repository. LC_ALL=C keeps git's messages in one language.
const KEEP = ['HOME', 'USERPROFILE', 'SystemRoot', 'GIT_DIR', 'GIT_CEILING_DIRECTORIES'];
export function gitEnv(git, env = process.env) {
  const kept = Object.fromEntries(KEEP.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
  return { PATH: dirname(git), ...kept, LC_ALL: 'C' };
}

export const gitPath = findGit(process.env.PATH);

// gitRunner(git)(cwd, ...args) returns spawnSync's result; without a git it fails the way a missing binary does.
export const gitRunner = git => (cwd, ...args) => git
  ? spawnSync(git, args, { cwd, encoding: 'utf8', env: gitEnv(git) })
  : { status: null, stdout: '', stderr: 'git was not found in an absolute PATH entry' };

export const runGit = gitRunner(gitPath);
