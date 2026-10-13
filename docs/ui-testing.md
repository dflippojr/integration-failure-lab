# UI testing contract

Contract version: 1

## Scope and isolation

Target: integration-failure-lab's standalone browser embedding. Only http://127.0.0.1:4193 is permitted. The server binds loopback, refuses an occupied port and existing instance directory, and copies the six checked-in dist files into a fresh repo-local .ui-testing directory. All twelve scenario fixtures and recorded Java runs are synthetic (claim C-1001). The browser simulator never contacts the Java service. CSP restricts connections/resources to this origin; there are no payments, email, model providers, webhooks, or external integrations. No credentials, secrets, authentication, or production data are needed. The command accepts no credential/endpoint arguments and rejects UI_TESTING_* variables except UI_TESTING_SYNTHETIC=true. Unrelated tool credentials are never consumed by this server.

Requirements: Node >=22, npm, Playwright Test (locked in package-lock.json), GitHub CLI >=2.99 for screenshot uploads and playwright-cli for exploration. Setup: npm ci; npx playwright install chromium webkit. Desktop/Pixel exploration uses installed Edge; WebKit uses Playwright's installed browser. Java checks need Java 21 and the Maven wrapper, with -DforkCount=1.

## Start

From the repository root, in PowerShell or a POSIX shell, run **node checks/ui-instance.mjs start**. It seeds a fresh copy, starts its own background child, waits for ownership-verified readiness and prints UI_TESTING_URL=http://127.0.0.1:4193. Handle: .ui-testing/instance.json contains its unique id, PID and origin. Health: GET /__instance returns the matching id/PID and synthetic:true. No database exists. Background logs are suppressed; use node checks/ui-instance.mjs serve for foreground logs/CI (same isolation/readiness). Partial failure exits nonzero and stops the child; occupied ports are never reused. A stale directory requires teardown before restart.

## Seed and sign-in

No authentication or roles. Read-only synthetic inputs are copied from dist/scenarios.js and dist/executed.js. Deterministic browser reset: clear localStorage, then reload / in a fresh context (or playwright-cli localstorage-clear followed by reload). Reset before each device/theme/orientation. No cookies, auth state, audit store, or server-side writes. Only ifl-mode and ifl-source preferences persist. Scenario selection, form choices and run output deliberately reset on reload; verify these documented defaults rather than expecting entity persistence.

## Journeys

All pages are states at /. Ready signals and flow IDs:

| ID | State/readiness | Actions and outcome | Reload / audit |
| --- | --- | --- | --- |
| J1 | Picker: buttons Guided and Free-form | Tab/Enter each choice; switch between modes; focus moves into new controls | Mode persists; no CRUD or audit |
| J2 | Guided: Scenarios group, h2 scenario title | Select all twelve chips and Previous/Next including disabled endpoints. Run each simulation; wait for Final state. Check verdict, C-1001 expected/observed table and Dead-letter queue / Dropped messages / Ordering buffer counts and details. Changing scenario clears results. | Guided persists, first scenario restored, output cleared; simulation is transient |
| J3 | Guided: Run source group | Executed: Java / Spring; Replay real run; lazy local executed.js request, recorded note and final groups. Switch back to Simulated in browser. Induce unavailable module in a fresh context; Retry replay and simulation stay usable. | Source persists but no recording requested until replay click; no audit |
| J4 | Free-form: Break something / Protect it fieldsets | Run default: Paid, $120.00, 3 applied events, empty final groups. Choose ack loss for ClaimPaid with dedupe off: duplicate payment; enable idempotent consumer and rerun: correct payment. Timeout every attempt: nonempty DLQ; toggle schema rename and validation for visible rejection. Cancel via mode switch: output clears, free form defaults restored. | Free mode persists; choices/output reset; no audit |
| J5 | All three primary states | Keyboard Tab/Shift+Tab/Enter/Space; trace region scrollable and focused; switches/chips retain useful focus | No modal, menu, sheet, deep-link routes, entity CRUD or audit exists |
| J6 | Guided: Try this in Free-form beside Run | Absent on 6a/6b. On 2a it opens Free-form with Ack lost for ClaimPaid checked, no run started, focus on the first control and ifl-mode=free saved. Run: duplicate payment; enable idempotent consumer and rerun: correct payment. Mode switch to guided and back: free-form defaults restored. | Free mode persists; pre-fill is not persisted; no audit |

Use reduced-motion for deterministic completion in lock-in tests; separately check animated playback, cancellation mid-run, and reduced-motion in exploration. Trace/final state readiness is .ifl-final-state:not([hidden]). Expected record comes from engine EXPECTED_RECORD, and scenario-specific outcomes from scenarios/*.json and the matching engine result. Application failures inside the simulator are expected teaching outcomes, not browser defects.

## Theme and layout

The embedded app consumes host CSS tokens; it has no theme switch. The disposable host adds host.css, with explicit light/dark tokens selected by prefers-color-scheme. Confirm matchMedia and computed --ifl-paper: #f6f3eb light / #18251f dark. This exercises the public embedding interface, not a production host's theme.

Primary states: picker, guided controls/results, free-form controls/results. There are no menus/sheets/dialogs. For live resize use the closest applicable state: partly configure the free-form selects/checkboxes, focus a select, shrink 1440 -> 768 -> 375 -> 1440 without reload, check values/focus and functional mode switching. Rotate the same state on phones. There are no text inputs, drag/swipe, PWA, manifest, service worker, fixed navigation or edge-to-edge layout. Browser Back from / leaves the embedding page normally; no internal history routing exists. OS keyboard, notch/safe-area and actual installed-device behavior need real hardware and are outside emulation. Select font size/touch targets remain in scope.

Run desktop 1440x900; iPhone SE 375x667, iPhone 15 393x852, Pixel 7 412x915, iPad Mini 768x1024; light/dark, phone portrait/landscape. Sweep every primary state at 320,360,375,390,414,600,768,820,1024,1280,1440,1920, plus short 1280x600 / 1024x500, 2560 wide and 200% root font-size approximation. Check both pre-run and output states; don't call untested/failed layouts passes.

## Playwright and CI

npm ci; npx playwright install chromium webkit; npm run test:ui -- --workers=1. Config: playwright.config.js. Specs: checks/ui/*.spec.js (outside Node's automatic test discovery). Tests use isolated browser contexts, local-only baseURL, reduced-motion and one worker, with desktop and genuine Pixel 7 phone projects in both themes. webServer runs the foreground serve command with reuseExistingServer:false and verified /__instance readiness. Reports: playwright-report/ and test-results/ (failure screenshots/traces, no authentication artifacts). Always run npm run ui:stop after tests, including failures/cancellation.

This repo is PUBLIC (verified via gh api on 2026-10-11). Existing workflows use ubuntu-latest. UI CI runs on GitHub-hosted ubuntu-latest only, installs locked dependencies/browser dependencies, runs tests with one worker, uploads reports, and invokes teardown with if:always(). Never use a self-hosted runner for this public code. Required checks also include npm test and java/mvnw verify -DforkCount=1.

## Teardown

Phone control regressions: checks/ui/phone-controls.spec.js verifies enabled hit areas (including checkbox labels), all neighboring gaps, select font sizes, focus/selection and Run at phone portrait/landscape sizes and 320px. It also checks the picker count against the scenario manifest and guided progress. The default Chromium phone projects run these checks in CI. For the additional genuine iPhone SE (375x667) and iPhone 15 (393x852) WebKit contexts in both themes, install chromium and webkit and run `npm run test:ui -- --config=playwright.phone.config.js --workers=1`. This extends the default projects; teardown still applies after the run.

From the repository root run **node checks/ui-instance.mjs stop**. It verifies the saved id/PID against /__instance before requesting its own shutdown; never kills a mismatching/unowned server. It removes only the known flat disposable files and directory; safe to repeat and after partial startup. If a saved process no longer exists it removes stale disposable files. Preserve output/ui-pass evidence and reports. Verify .ui-testing absent, owned PID exited and port 4193 unbound. Close owned playwright-cli sessions and delete their session data. Run close-all only when the inventory contains no other worker sessions; otherwise close each owned name and record the exception.
