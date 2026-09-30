# Architecture (draft v0)

## Goal

Let a visitor see, in under a minute, why integration reliability is hard and what the standard fixes cost. The visitor picks a failure, runs it, and reads the outcome in plain language. Then they turn on a safeguard and run it again.

## v1 shape: one producer, one queue, one downstream

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

- **v1 is a deterministic simulation in the browser.** It uses a virtual clock with fixed latencies and no randomness, so each scenario replays identically. It's plain JavaScript with no dependencies, so it embeds directly in the static site. The page says clearly that it's simulated.
- **v2 (built 2026-09-30)**: `java/` is a Spring Boot 4.1.1 / Java 21 app. A producer emits the three events on a schedule; a delivery queue posts each to `POST /claims/{id}/events` with the JDK `HttpClient` (read timeout), retries with backoff, treats 422 as non-retryable, and dead-letters or drops what it gives up on. The claim-status controller injects faults server-side (holding a request past the timeout without processing it, or processing it and holding the ack) and applies the same consumer safeguards as the engine. Wall-clock timings are shorter than the simulation's (300 ms timeout, 150 ms backoff base) and every trace records them. `ScenarioRunnerTest` runs all ten scenarios over real HTTP and asserts the same expectations as the JS tests; recorded traces live in `executed/` and ship to the site via `build.mjs`.

## Engine boundaries (so v1 and v2 share scenarios)

- `scenarios/*.json`: failure injections, safeguard settings, and the expected final record.
- `engine`: pure function `run(scenario, settings) -> { trace[], queue[], finalRecord, verdict }`. No DOM access.
- `ui`: renders a trace. It can't tell whether the trace came from the simulator or from a recorded v2 run.

## Decisions made by the agent (revisit freely)

- The browser simulation comes first, and Java/Spring comes second. This follows the career plan: the stack is open, and Spring is a natural fit but not a requirement.
- The claims domain uses the three events above: familiar from EDI work, and duplicates and misordering have obvious costs.
- A virtual clock, not real waiting, so a 30-second retry storm plays in about 3 seconds.
- The repo is private until you decide otherwise, like `personal-website`.

## Decided with Daniel (2026-09-29)

- **v2 stack:** Java/Spring Boot producer and consumer that run the same `scenarios/*.json` and export traces in the engine's trace format.
- **Schema change is in v1** (scenarios 5a/5b).
- **Two modes, chosen at first visit:** a picker offers **Guided** (one scenario at a time with a before/after and a verdict) or **Free-form** (the full control panel). The choice is remembered per browser and can be switched at any time.
