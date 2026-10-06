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

- **Producer:** emits a short, fixed sequence of synthetic claim events for one claim: `ClaimSubmitted`, `ClaimAccepted`, `ClaimPaid`. Each carries `eventId`, `claimId`, `seq`, `occurredAt`.
- **Queue / delivery:** at-least-once. On timeout or 5xx it retries with backoff, up to a configurable limit. Messages it gives up on go to a dead-letter queue (DLQ).
- **Downstream:** applies events to a claim record (status, paid amount). This is where duplicates and misordering do damage: double payment, or a claim that ends up "Accepted" after "Paid".
- **Trace log:** one row per hop (send, attempt n, ack, timeout, retry scheduled, DLQ, apply, reject) with a virtual timestamp.

## Visitor controls

| Kind | Control | Default |
| --- | --- | --- |
| Failure | Downstream timeout (which attempt(s) time out) | off |
| Failure | Duplicate delivery (ack lost, message redelivered) | off |
| Failure | Out-of-order delivery (swap two events) | off |
| Failure | Schema change (producer renames `paidAmount` to `amountPaid`) | off |
| Safeguard | Retry limit (0–5) and backoff (none / fixed / exponential) | 3, exponential |
| Safeguard | Idempotency (dedupe on `eventId`) | off |
| Safeguard | Ordering (buffer when `seq` skips; drop stale `seq`) | off |
| Safeguard | Schema validation at the consumer (reject, don't guess) | off |
| Safeguard | Dead-letter queue for messages that give up | on |

## Outputs the visitor sees

1. **Timeline:** each hop on a virtual clock, retries visibly stacking up.
2. **Queue panel:** in-flight, retrying, and DLQ counts.
3. **Final claim record vs. expected record**, with the differences highlighted, for example "paid twice: $240 instead of $120".
4. **One-sentence verdict** plus the tradeoff of the safeguard that fixed it. For example, idempotency needs a dedupe store and a retention window, and buffering for order adds latency.

## Simulated vs. executed

- **The simulation is deterministic and runs in the browser.** It uses a virtual clock with fixed latencies and no randomness, so each scenario replays identically. It's plain JavaScript with no dependencies, so it embeds directly in the static site. The page says clearly that it's simulated.
- **The executed runner** in `java/` is a Spring Boot 4.1.1 / Java 21 app. A producer emits the three events on a schedule; a delivery queue posts each to `POST /claims/{id}/events` with the JDK `HttpClient` (read timeout), retries with backoff, treats 422 as non-retryable, and dead-letters or drops what it gives up on. The claim-status controller injects faults server-side (holding a request past the timeout without processing it, or processing it and holding the ack) and applies the same consumer safeguards as the engine. Wall-clock timings are shorter than the simulation's (300 ms timeout, 150 ms backoff base) and every trace records them. `ScenarioRunnerTest` runs all twelve scenarios over real HTTP and asserts the same expectations as the JS tests; recorded traces live in `executed/` and ship to the site via `build.mjs`.

## Engine boundaries (so the simulator and the Java runner share scenarios)

- `scenarios/*.json`: failure injections, safeguard settings, and the expected final record.
- `engine`: pure function `run(scenario, settings) -> { trace[], queue[], finalRecord, verdict }`. No DOM access.
- `ui`: renders a trace. It can't tell whether the trace came from the simulator or from a recorded Java run.

## Visitor modes

A picker on first visit offers **Guided** (one scenario at a time, with expected vs. observed and a verdict) or **Free-form** (the full control panel). The choice is remembered per browser in `localStorage` (key `ifl-mode`) and can be switched at any time. A separate toggle replays either the simulated run or the recorded Java run (`ifl-source`). Both are in `ui/lab.js`.

## Tests

- `test/engine.test.js`: all twelve scenarios against their `expect` blocks, determinism, and targeted trace assertions.
- `test/ui.test.js`: accessibility structure of the UI (heading levels, labels, focusable trace region).
- `test/build.test.js`: `scripts/build.mjs` accepts only its fixed target names.
- `java/src/test/java/dev/dflippojr/lab/ScenarioRunnerTest.java`: runs all twelve scenarios over real HTTP against the same expectations.

Commands: `npm test` and `cd java && ./mvnw verify`.

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
