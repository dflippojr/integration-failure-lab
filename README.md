# Integration Failure Lab

Break a small healthcare-style integration on purpose, then watch what happens: traces, retries, queue state, and final outcomes. Flip on deduplication, retry limits, or ordering guarantees and run the same failure again.

Planned as the signature interactive on [dflippojr.dev](https://dflippojr.dev) (see `personal-website` issue #18).

**Status:** v1 simulation engine and all ten scenarios built and tested (`npm test`, Node 20+, no dependencies). Browser UI next; the Java/Spring v2 is not started.

- [Architecture](docs/ARCHITECTURE.md): components, event model, what's simulated vs. executed
- [Scenarios](docs/SCENARIOS.md): the v1 scenario matrix with expected outcomes
- `engine/engine.js`: pure, deterministic simulator: `run(scenario, overrides) -> { trace, record, dlq, dropped, buffered, stats, verdict }`
- `scenarios/*.json`: the scenarios, shared with the future Java/Spring runner

All data is synthetic. No real payers, patients, or PHI.
