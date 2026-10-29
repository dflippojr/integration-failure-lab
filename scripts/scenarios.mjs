// The scenario fields the browser gets, and the check that every scenario has a lesson to show.
// Guided mode renders the lesson after every run, so a scenario without one has nothing to show there.
// In its own module, so the tests import it and the check counts toward coverage.
export function browserScenarios(scenarios) {
  const withoutLesson = scenarios.filter(({ lesson }) => typeof lesson !== 'string' || lesson.trim() === '').map(({ id }) => id);
  if (withoutLesson.length) {
    throw new Error(`Scenarios without a non-empty lesson: ${withoutLesson.join(', ')}. Guided mode needs one for every scenario.`);
  }
  // The browser reads only these fields: expect is the test oracle and order is only the sort key.
  return scenarios.map(({ id, title, summary, failures, safeguards, lesson }) => ({ id, title, summary, failures, safeguards, lesson }));
}
