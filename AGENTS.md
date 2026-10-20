# Agent instructions

integration-failure-lab has two implementations of one model: the JS engine (`engine/engine.js`), which drives the site, and the Java 21 / Spring Boot runner (`java/`), which runs the same scenarios over real loopback HTTP. Both are held to the hand-written `expect` oracle in `scenarios/*.json`. [README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describe the layout.

## How to prove a change works

- **`npm run ci:local` is the full gate.** It runs the five jobs that the `gate` check in `.github/workflows/ci.yml` requires, one after another:
  - `npm run lint && npm run test:coverage`: ESLint's recommended rules (`eslint.config.js`), then `npm test` with the Node coverage floors.
  - `./mvnw -B verify -DforkCount=1` in `java/`, including the JaCoCo line-coverage floor.
  - `./mvnw -B package -DskipTests` in `java/`, then `npm run differential`: every Free-form combination through the engine and the Java runner, failing on any outcome difference that `test/differential/known.json` does not explain.
  - `./mvnw -B package -DskipTests` in `java/`, then `npm run recordings`: re-records every scenario and fails when the committed `executed/` differs from what the Java runner does, apart from wall-clock timing.
  - `npm run test:ui -- --workers=1`.

  It then always runs `npm run ui:stop`, even after a failure or Ctrl+C. Every step runs even when an earlier one fails, and the summary at the end lists each result. It needs `npm ci`, `npx playwright install chromium webkit` and a Java 21 JDK (`JAVA_HOME` must point at a JDK, not a JRE). Keep the parallelism it uses: Java on one fork and Playwright on one worker.
- **UI changes** follow [docs/ui-testing.md](docs/ui-testing.md): the disposable instance, the journeys, the device and theme matrix, and teardown.
- **`gate-guard` is required next to `gate`.** `.github/workflows/gate-guard-target.yml` posts it from `main`, so editing it in a pull request changes nothing until merge. It fails a change that deletes, skips or retries tests, or touches workflows, coverage floors or Sonar config, until the owner applies `gate-change-approved`; a push after that makes the label stale. Never apply that label yourself: say in the PR body that the change needs it.
- **Rebuild and commit `dist/`** with `npm run build` after any change to `engine/`, `ui/` or `scenarios/`. `test/dist.test.js` fails when `dist/` differs from a fresh build.
- **Fill the PR's `## Proof` table** (the shared PR template, dflippojr/.github#13): one row per acceptance criterion, with how it was verified (command, test name) and the evidence (output excerpt, run link, red before and green after). List what you did not verify under `### Not verified`, and any test you deleted or skipped, or config you loosened, under `### Gate changes`.
- **Bug fixes start with a test that fails on `main`.** Write it first, show it red, then fix it.
- **Engine changes keep engine/Java parity.** The JS engine and the Java runner must give the same outcome for the same inputs. Change both together, and re-record `executed/` when the Java runner's behaviour changes (`npm run recordings` fails until you do; README "Recording drift" has the command). Generated combinations beyond the twelve shipped scenarios are tracked in #93 (differential testing).
- **Coverage floors only ever go up.** The Node floors are in the `test:coverage` script in `package.json` and the Java floor is in `java/pom.xml`. Raise a floor when coverage rises; never lower one to make a change pass.
