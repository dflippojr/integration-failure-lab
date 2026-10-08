# Integration Failure Lab

Break a small healthcare-style integration on purpose, then watch what happens: traces, retries, queue state, and final outcomes. Flip on deduplication, retry limits, or ordering guarantees and run the same failure again.

Try it on [dflippojr.dev](https://dflippojr.dev/#lab), where it's the site's playground.

**Status:** v1 simulation engine and all twelve scenarios built and tested (`npm test`, Node 20+, no dependencies). Browser UI built (`ui/`): a first-visit picker for **Guided** or **Free-form**, animated trace, expected-vs-observed record, verdict, and final Dead-letter queue, Dropped messages, and Ordering buffer contents. Each final group shows its count and either entry details or an explicit empty state. Trace counters (including Parked / dropped events) are cumulative history, not current queue occupancy: replay can drain the final DLQ while leaving historical parked events counted. Snapshots appear when playback finishes, including with reduced motion, and clear on a new run or mode, scenario, or source switch. **v2 (Java 21 / Spring Boot 4.1.1)** in `java/` executes the same scenario files over real HTTP (a delivery queue with read timeouts, retries, and a dead-letter queue posting to an embedded-Tomcat claim-status service with server-side fault injection) and exports traces to `executed/`. Guided mode on the site can replay those recorded runs next to the simulation.

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

Guided mode loads `executed.js` only when **Replay real run** is activated. Selecting Executed or restoring a saved `ifl-source=exec` preference does not fetch recordings. A small `RECORDING_IDS` manifest in generated `scenarios.js` comes from actual recording keys, so scenarios without recordings remain simulation-only. Pending loads share one import across mounts and disable repeated Run requests; changing mode, scenario, or source discards the old playback request. Successful imports stay cached. Loading and failures appear in the named **Replay status** region; failures offer **Retry replay**, and simulation remains usable.

The initial static JS graph is now `lab.js ? engine.js, scenarios.js`; `executed.js` is dynamically imported on demand. Offline sizes measured on Windows with Node v24.18.0, unchanged recording fixtures, consistent CRLF line endings for all modules, and each module compressed separately using gzip level 9:

| Initial module | Raw bytes | gzip-9 bytes |
| --- | ---: | ---: |
| lab.js (including loader) | 20,906 | 6,698 |
| engine.js | 10,413 | 3,442 |
| scenarios.js (including manifest) | 8,389 | 1,814 |
| **Total** | **39,708** | **11,954** |

Against issue #26's `5b059c1` baseline (63,161 raw / 12,993 gzip-9), the net reduction is **23,453 raw / 1,039 gzip-9 bytes**, including loader, manifest, and the intervening final-state UI. Against this branch's fresh `origin/main` base `9256893` (64,450 raw / 13,323 gzip-9), the reduction is **24,742 raw / 1,369 gzip-9 bytes**. Deferred `executed.js` remains 26,626 raw / 1,865 gzip-9 bytes with this normalization. These are offline asset sizes, not production transfer or latency measurements.

To reproduce the new totals from the repository root (normalize generated LF and checked-out CRLF consistently):

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {gzipSync} from "node:zlib"; for (const f of ["lab.js","engine.js","scenarios.js"]) { const b=Buffer.from(readFileSync("dist/"+f,"utf8").replace(/\r?\n/g,"\r\n")); console.log(f,b.length,gzipSync(b,{level:9}).length); }'
```

The drift tests also traverse the static imports, check that recordings are absent, and verify both normalized totals remain below the issue baseline.

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
