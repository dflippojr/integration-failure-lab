// Module hook for the UI tests. ui/lab.js imports its neighbours as they sit in the built bundle
// (./engine.js, ./scenarios.js, ./executed.js). Resolve them to engine/engine.js and the generated
// modules in dist-test/ so the tests can import the source file.
const LAB = new URL('../ui/lab.js', import.meta.url).href;
const SIBLINGS = {
  './engine.js': new URL('../engine/engine.js', import.meta.url).href,
  './scenarios.js': new URL('../dist-test/scenarios.js', import.meta.url).href,
  './executed.js': new URL('../dist-test/executed.js', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === LAB && Object.hasOwn(SIBLINGS, specifier)) {
    return { url: SIBLINGS[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
