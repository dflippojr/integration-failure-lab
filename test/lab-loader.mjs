// Module hook for the UI tests. ui/lab.js imports its neighbours as they sit in the built bundle
// (./engine.js, ./scenarios.js, ./executed.js). Resolve them to engine/engine.js and the generated
// modules in dist-test/ so the tests can import the source file.
import { readFile } from 'node:fs/promises';

const LAB = new URL('../ui/lab.js', import.meta.url).href;
const SIBLINGS = {
  './engine.js': new URL('../engine/engine.js', import.meta.url).href,
  './scenarios.js': new URL('../dist-test/scenarios.js', import.meta.url).href,
  './executed.js': new URL('../dist-test/executed.js', import.meta.url).href,
};

let request = 0;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === LAB && Object.hasOwn(SIBLINGS, specifier)) {
    const url = SIBLINGS[specifier] + (specifier === './executed.js' ? `?request=${++request}` : '');
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

// Only the UI's dynamic import is mocked; tests read the unchanged recording fixture directly.
export async function load(url, context, nextLoad) {
  if (url === LAB) {
    // Reset only the module cache between independent tests, without duplicating source URLs
    // in lcov. Preserve source line positions; production receives no test-only reset hook.
    const source = (await readFile(new URL(LAB), 'utf8')).replace('let recordings;',
      'let recordings; globalThis.__resetRecordings = () => { recordings = null; };');
    return { format: 'module', shortCircuit: true, source };
  }
  if (url.startsWith(SIBLINGS['./executed.js'] + '?')) {
    return { format: 'module', shortCircuit: true,
      source: 'export const EXECUTED = await globalThis.__loadRecordings();' };
  }
  return nextLoad(url, context);
}
