# Integration Failure Lab

Break a small healthcare-style integration on purpose, then watch what happens: traces, retries, queue state, and final outcomes. Flip on deduplication, retry limits, or ordering guarantees and run the same failure again.

Planned as the signature interactive on [dflippojr.dev](https://dflippojr.dev) (see `personal-website` issue #18).

**Status:** design drafts only. Nothing is built yet.

- [Architecture](docs/ARCHITECTURE.md): components, event model, what's simulated vs. executed
- [Scenarios](docs/SCENARIOS.md): the v1 scenario matrix with expected outcomes

All data is synthetic. No real payers, patients, or PHI.
