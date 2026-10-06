# Integration Failure Lab

Break a small healthcare-style integration on purpose, then watch what happens: traces, retries, queue state, and final outcomes. Flip on deduplication, retry limits, or ordering guarantees and run the same failure again.

Try it on [dflippojr.dev](https://dflippojr.dev/#lab), where it's the site's playground.

**Status:** v1 simulation engine and all twelve scenarios built and tested (`npm test`, Node 20+, no dependencies). Browser UI built (`ui/`): a first-visit picker for **Guided** or **Free-form**, animated trace, expected-vs-observed record, and verdict. **v2 (Java 21 / Spring Boot 4.1.1)** in `java/` executes the same scenario files over real HTTP (a delivery queue with read timeouts, retries, and a dead-letter queue posting to an embedded-Tomcat claim-status service with server-side fault injection) and exports traces to `executed/`. Guided mode on the site can replay those recorded runs next to the simulation.

- [Architecture](docs/ARCHITECTURE.md): components, event model, what's simulated vs. executed
- [Scenarios](docs/SCENARIOS.md): the v1 scenario matrix with expected outcomes
- `engine/engine.js`: pure, deterministic simulator: `run(scenario, overrides) -> { trace, record, dlq, dropped, buffered, stats, verdict }`
- `scenarios/*.json`: the scenarios, shared by the engine and the Java/Spring runner in `java/`

## Develop

```sh
npm test          # engine and UI tests
cd java && ./mvnw verify   # executes all twelve scenarios over real HTTP (Java 21)
java -jar target/integration-failure-lab-0.1.0-SNAPSHOT.jar --lab.export-dir=../executed   # from java/, after verify: re-record traces
npm run build     # from the repo root: assemble dist/ (engine, UI, CSS, generated scenarios.js and executed.js)
# the tests fail if dist/ or executed/ drift from their sources, so run npm run build and commit dist/ after changing them
python -m http.server 4180 --directory dist   # open http://127.0.0.1:4180
```

The runner reads scenarios from `../scenarios` relative to where it starts, so run the jar from `java/`.

The website vendors the bundle into `public/lab/` (`node scripts/build.mjs site`, which writes to `../personal-website/public/lab`, so the website checkout must sit next to this repo). The build takes a fixed target name, not a path: `dist` (the default), `site`, or `test` (the git-ignored `dist-test/` the UI tests use); anything else exits with an error. Mount with `mountLab(element, { headingLevel })`: the scenario title is an `h3` by default, for a lab placed under an `h2`; pass the level that fits your page (2-6).

All data is synthetic. No real payers, patients, or PHI.

### CI

GitHub Actions runs two workflows on pushes and pull requests:

- `.github/workflows/test.yml`: `npm test` (Node 22) and `./mvnw -B verify` in `java/` (Java 21).
- `.github/workflows/sonar.yml`: SonarCloud analysis with coverage (lcov from the Node test runner, JaCoCo from the Java module). It runs on pushes to `main` and on pull requests from this repo, and fails when the quality gate fails. Project keys are in `sonar-project.properties`.

Dependabot checks weekly for Maven updates in `/java`, npm updates at `/`, and GitHub Actions updates at `/`, as configured in `.github/dependabot.yml`. The root `package.json` currently has no npm dependencies, so that entry may produce no update PRs. Version updates start when this configuration reaches the default branch.

SonarCloud requires an authorized analysis token named `SONAR_TOKEN` in repository **Actions** secrets for ordinary runs and separately in **Dependabot** secrets for Dependabot PRs (Settings → Secrets and variables → Dependabot → New repository secret). GitHub supplies the appropriate secret store through the same workflow reference; Actions secrets are unavailable to Dependabot-triggered runs. Fork PRs remain excluded. If the token is absent, the SonarCloud workflow emits a notice and a job summary and skips analysis cleanly; this is not a successful analysis or a passing quality gate. The separate test workflow still runs.

Owner verification: ensure the configured SonarCloud project exists with automatic analysis disabled, save the authorized Dependabot `SONAR_TOKEN`, and verify analysis on a `main` push, an ordinary same-repository PR, and at least one real Dependabot PR. Record the workflow and SonarCloud result links for the PR's head commit in issue #16; a missing-token notice does not satisfy that verification.

## License

MIT. See [LICENSE](LICENSE).
