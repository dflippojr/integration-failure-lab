// The scenario fields the browser gets, and the checks that every scenario can ship.
// Guided mode renders the lesson after every run, so a scenario without one has nothing to show there.
// The shipped engine does not validate (#196), so a scenario the Java runner would refuse fails the build here instead,
// with the rule's text from engine/rules.js.
// In its own module, so the tests import it and the checks count toward coverage.
import { refusal } from '../engine/rules.js';

export function browserScenarios(scenarios) {
  const withoutLesson = scenarios.filter(({ lesson }) => typeof lesson !== 'string' || lesson.trim() === '').map(({ id }) => id);
  if (withoutLesson.length) {
    throw new Error(`Scenarios without a non-empty lesson: ${withoutLesson.join(', ')}. Guided mode needs one for every scenario.`);
  }
  for (const scenario of scenarios) {
    const refused = refusal(scenario);
    if (refused) throw new Error(`Scenario ${scenario.id}: ${refused}`);
  }
  // The browser reads only these fields: expect is the test oracle and order is only the sort key.
  return scenarios.map(({ id, title, summary, failures, safeguards, lesson }) => ({ id, title, summary, failures, safeguards, lesson }));
}
