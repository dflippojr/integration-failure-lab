# Architecture

## Goal

Let a visitor see why integration reliability is hard and what the standard fixes cost. The visitor picks a failure, runs it, and reads the outcome in plain language. Then they turn on a safeguard and run it again.

## Shape: one producer, one queue, one downstream

```
 Producer            Queue / retry loop            Downstream
 (claims intake) ──► (at-least-once delivery) ──► (claim status service)
       │                     │                            │
       └──────────── trace log (every hop, timestamped) ──┘
```

- **Producer:** emits a short, fixed sequence of synthetic claim events for one claim: `ClaimSubmitted`, `ClaimAccepted`, `ClaimPaid`. Each carries `eventId`, `type`, `claimId`, `seq`, `status`, and `payload`.
- **Queue / delivery:** at-least-once. On timeout or 5xx it retries with backoff, up to a configurable limit. Messages it gives up on go to a dead-letter queue (DLQ).
- **Downstream:** applies events to a claim record (status, paid amount). This is where duplicates and misordering do damage: double payment, or a claim that ends up "Accepted" after "Paid".
- **Trace log:** one row per hop (send, attempt n, ack, timeout, retry scheduled, DLQ, apply, reject) with a virtual timestamp.

## Visitor controls

| Kind | Control | Default |
| --- | --- | --- |
| Failure | Downstream timeout (which attempt(s) time out) | off |
| Failure | Duplicate delivery (ack lost, message redelivered) | off |
| Failure | Out-of-order delivery (delay one chosen event by 500 ms so it arrives after the next one) | off |
| Failure | Schema change (producer renames `paidAmount` to `amountPaid`) | off |
| Safeguard | Retry limit (0–5) and backoff (none / fixed / exponential) | 3, exponential |
| Safeguard | Idempotency (dedupe on `eventId`) | off |
| Safeguard | Ordering (buffer when `seq` skips; drop stale `seq`) | off |
| Safeguard | Schema validation at the consumer (reject, don't guess) | off |
| Safeguard | Dead-letter queue for messages that give up | on |
| Safeguard | Replay after the producer fix: each DLQ entry is replayed once, a fixed delay after it was parked, with a fresh attempt count (scenario 6b; not a Free-form control) | off |

## Outputs the visitor sees

1. **Timeline:** each hop on a virtual clock, retries visibly stacking up.
2. **Queue panel:** cumulative counters (attempts, retries, parked / dropped events) while the trace plays, then the final DLQ, dropped and ordering-buffer contents (see below).
3. **Final claim record vs. expected record**, with the differences highlighted, for example "paid twice: $240 instead of $120".
4. **One-sentence verdict** plus the tradeoff of the safeguard that fixed it. For example, idempotency needs a dedupe store and a retention window, and buffering for order adds latency.
5. **Compared with your previous run** (Free-form only): after the second and later Free-form runs finish playing, the settings that changed, worded like the form (for example "Idempotent consumer (dedupe on eventId): off → on"), and a Previous / This run table of verdict, status, paid and events applied with differences highlighted, or "Same settings as your previous run." The UI keeps only the last completed Free-form run, in memory: a run replaced before it finishes is not kept, and switching mode clears it. Guided mode gets the same before/after from its scenario pairs.

## Simulated vs. executed

- **The simulation is deterministic and runs in the browser.** It uses a virtual clock with fixed latencies and no randomness, so each scenario replays identically. It's plain JavaScript with no dependencies, so it embeds directly in the static site. The page says clearly that it's simulated.
- **The executed runner** in `java/` is a Spring Boot 4.1.1 / Java 21 app. Before each scenario, it posts a healthy `ClaimSubmitted` event to `POST /claims/{id}/events` with a separate 10 s read timeout and a no-fault context. This exercises the actual JSON body binding and integer `X-Attempt` conversion; a health GET would leave them cold. Only after that POST completes does it reset the store, install the scenario context, and start the trace clock. The result's `warmupMs` records setup cost without including setup rows in the scenario trace. A four-thread scheduled executor runs the three independent blocking HTTP attempts and producer/retry timers, so an injected timeout or lost ack does not hold up unrelated events. An injected reorder delay is network time, as in the engine: `send` rows mark the start of the HTTP attempt, and the controller holds the delayed request before handling it, so the client's read timeout is already running. The JDK `HttpClient` uses a 300 ms read timeout; retries use a 150 ms backoff base, 422 is non-retryable, and exhausted messages are dead-lettered or dropped. The controller holds injected timeout requests without applying them, or applies events before holding a lost ack, and uses the same consumer safeguards as the engine. Warming removes one-time POST initialization from scenario timing; healthy order relies on the 0/40/80 ms emission spacing and localhost processing, rather than an unconditional transport ordering guarantee. The client and executor are closed after each run. `ScenarioRunnerTest` runs all twelve scenarios over real HTTP against the shared expectations; recorded traces in `executed/` ship to the site through `build.mjs`.

## Engine boundaries (so the simulator and the Java runner share scenarios)

- `scenarios/*.json`: failure injections, safeguard settings, and the expected final record.
- `engine`: pure function `run(scenario, overrides) -> { trace, record, expected, dlq, dropped, buffered, stats, guards, verdict }`. No DOM access.
- `ui`: renders a trace. It can't tell whether the trace came from the simulator or from a recorded Java run.

## Visitor modes

A picker on first visit offers **Guided** (one scenario at a time, with expected vs. observed and a verdict) or **Free-form** (the full control panel). The choice is remembered per browser in `localStorage` (key `ifl-mode`) and can be switched at any time. A separate toggle replays either the simulated run or the recorded Java run (`ifl-source`). Both are in `ui/lab.js`.

From Guided, **Try this in Free-form** opens the current scenario in Free-form with its failures and effective safeguards (`{ ...DEFAULT_SAFEGUARDS, ...scenario.safeguards }`) filled in, so a visitor can change one thing and run it again. It saves `ifl-mode=free` like the mode switch, does not run, and focuses the first control. `toFormValues(scenario)` decides from the scenario data whether the form can express it: poison messages, replay after fix and delays other than 500 ms have no Free-form control, so 6a and 6b do not offer it. Reaching Free-form any other way shows the defaults.

## Tests

- `test/engine.test.js`: all twelve scenarios against their `expect` blocks, determinism, and targeted trace assertions.
- `test/ui.test.js`: accessibility structure of the UI (heading levels, labels, focusable trace region), final queue snapshots, deferred loading of recordings, and the Guided-to-Free-form pre-fill (every expressible scenario reproduces its guided run), and the Free-form comparison with the previous run.
- `test/dist.test.js`: `dist/` matches `npm run build` output, every scenario has exactly one recording, and the initial static import graph excludes recordings and stays under the byte baseline.
- `test/build.test.js`: `scripts/build.mjs` accepts only its fixed target names.
- `java/src/test/java/dev/dflippojr/lab/ScenarioRunnerTest.java`: runs all twelve scenarios over real HTTP against the same expectations and checks that independent deliveries proceed during a timeout.
- `java/src/test/java/dev/dflippojr/lab/ScenarioRunnerOrderingTest.java`: holds the first warm-up POST beyond the scenario read timeout using latches, checks that later events wait for setup, and reports the warm-up duration.
- `java/src/test/java/dev/dflippojr/lab/ScenarioRunnerStressTest.java`: starts a fresh JVM and Spring server for every sample (one by default, opt into 30 with `-Dlab.stress.runs=30`), preserves the original outcome assertions, and closes each server and child process.

Commands: `npm test` and `cd java && ./mvnw -DforkCount=1 verify`. For 30 cold samples: `./mvnw -DforkCount=1 -Dtest=ScenarioRunnerStressTest -Dlab.stress.runs=30 test`.

## Not built

- No timing or load measurements. Nothing here claims how long a visit takes.

## History

Planning notes, kept for context. The sections above describe the current system.

- First drafted on 2026-09-29. The goal then was that a visitor could see the point "in under a minute"; this was never measured.
- The browser simulation came first and Java/Spring second, following the career plan. The stack was open and Spring was a natural fit rather than a requirement.
- The claims domain uses three events (`ClaimSubmitted`, `ClaimAccepted`, `ClaimPaid`) because duplicates and misordering have obvious costs and it is familiar from EDI work.
- A virtual clock, not real waiting, so a 30-second retry storm plays in about 3 seconds.
- Decided with Daniel (2026-09-29): the v2 stack is a Java/Spring Boot producer and consumer that run the same `scenarios/*.json` and export traces in the engine's trace format; the schema change is in v1 (scenarios 5a/5b); Guided/Free-form mode picker. All three are implemented.
- The repo is public and MIT licensed.

### Final queue snapshots

The UI displays the result's final `dlq`, `dropped`, and `buffered` snapshots after
trace playback finishes, in both Guided sources and Free-form simulation. These
are final contents, not live in-flight counts. DLQ and dropped entries include
event ID, type, reason and delivery attempts; buffered entries include ID, type
and sequence. Empty groups explicitly show zero and Empty. The animated trace's
Parked / dropped events counter remains cumulative: a successful replay can leave
one historical parked event and an empty final DLQ.
