# Integration Failure Lab

Break a small healthcare-style integration on purpose, then watch what happens: traces, retries, queue state, and final outcomes. Flip on deduplication, retry limits, or ordering guarantees and run the same failure again.

Try it on [dflippojr.dev](https://dflippojr.dev/#lab), where it's the site's playground.

**Status:** v1 simulation engine and all ten scenarios built and tested (`npm test`, Node 20+, no dependencies). Browser UI built (`ui/`): a first-visit picker for **Guided** or **Free-form**, animated trace, expected-vs-observed record, and verdict. **v2 (Java 21 / Spring Boot 4.1.1)** in `java/` executes the same scenario files over real HTTP (a delivery queue with read timeouts, retries, and a dead-letter queue posting to an embedded-Tomcat claim-status service with server-side fault injection) and exports traces to `executed/`. Guided mode on the site can replay those recorded runs next to the simulation.

- [Architecture](docs/ARCHITECTURE.md): components, event model, what's simulated vs. executed
- [Scenarios](docs/SCENARIOS.md): the v1 scenario matrix with expected outcomes
- `engine/engine.js`: pure, deterministic simulator: `run(scenario, overrides) -> { trace, record, dlq, dropped, buffered, stats, verdict }`
- `scenarios/*.json`: the scenarios, shared by the engine and the Java/Spring runner in `java/`
- `executed/*.json`: traces recorded by the Java/Spring runner, replayed next to the simulation

## Develop

```sh
npm test          # engine, UI and build tests
cd java && ./mvnw verify   # executes all ten scenarios over real HTTP (Java 21)
cd java && java -jar target/integration-failure-lab-0.1.0-SNAPSHOT.jar --lab.export-dir=../executed   # re-record traces
npm run build     # assemble dist/ (engine, UI, CSS, generated scenarios.js and executed.js)
python -m http.server 4180 --directory dist   # open http://127.0.0.1:4180
```

Run the jar from `java/`: it reads scenarios from `../scenarios`, and `--lab.export-dir` is relative to that folder too.

The website vendors `dist/` into `public/lab/` (`node scripts/build.mjs ../personal-website/public/lab`). The build only writes inside the folder that holds this repo (so the website checkout must sit next to it) or the OS temp dir; any other target is refused.

### CI

GitHub Actions runs two workflows on pushes and pull requests:

- `test` (`.github/workflows/test.yml`): `npm test` on Node 22 and `./mvnw -B verify` on Java 21.
- `SonarCloud` (`.github/workflows/sonar.yml`): runs the Node tests with coverage (`lcov.info`) and the Java build with JaCoCo coverage, then scans with SonarCloud and fails the check if the quality gate fails. It runs on pull requests and on pushes to `main`, and skips pull requests from forks. Project keys are in `sonar-project.properties`. Mount with `mountLab(element, { headingLevel })`: the scenario title is an `h3` by default, for a lab placed under an `h2`; pass the level that fits your page (2-6).

All data is synthetic. No real payers, patients, or PHI.

## License

MIT. See [LICENSE](LICENSE).
