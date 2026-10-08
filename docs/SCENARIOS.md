# Scenario matrix

The expected record for every scenario is: claim `C-1001`, status `Paid`, paid amount `$120.00`, three events applied exactly once in order.

## Built scenarios

| # | Failure injected | Safeguards | Expected observed outcome | Lesson |
| --- | --- | --- | --- | --- |
| 1a | Downstream times out on attempts 1–2 of `ClaimPaid` | Retry limit 3, exponential backoff | Delivered on attempt 3; final record correct; about 7 s of virtual delay | Retries with backoff absorb transient failures. |
| 1b | Same, but the downstream stays down for 5 attempts | Retry limit 3 | `ClaimPaid` goes to the DLQ; the record stays `Accepted` and unpaid, but the DLQ shows it | A retry limit trades completeness for bounded load. Somebody has to watch the DLQ. |
| 1c | Same as 1b | Retry limit 0 (fire and forget) | Event silently lost; no DLQ entry | With no retries, a hiccup becomes data loss. |
| 2a | Ack for `ClaimPaid` lost, so the queue redelivers it | Idempotency off | `ClaimPaid` applied twice; paid amount `$240.00` | At-least-once delivery means duplicates will happen. |
| 2b | Same as 2a | Idempotency on (dedupe by `eventId`) | Second delivery recognized and skipped; record correct | Idempotency fixes it, at the cost of a dedupe store and a retention window. |
| 3a | `ClaimAccepted` delayed past `ClaimPaid` (arrives out of order) | Ordering off | Final status `Accepted` after payment; record wrong | Last-write-wins is wrong when events can arrive late. |
| 3b | Same as 3a | Ordering on (buffer until `seq` gap fills) | `ClaimPaid` held until `ClaimAccepted` arrives; record correct; extra latency shown | Ordering guarantees add latency and need a timeout for gaps that never fill. |
| 4 | Combined: timeout on `ClaimAccepted` + retry makes it arrive after `ClaimPaid` + ack lost on `ClaimPaid` | All safeguards on | Correct record; trace shows each safeguard firing | Real incidents are combinations of failures. |
| 5a | Producer renames `paidAmount` to `amountPaid` on `ClaimPaid` | Schema validation off | Consumer reads a missing amount as zero; status `Paid` but paid `$0.00` | Lenient parsing turns a contract break into bad data. |
| 5b | Same as 5a | Schema validation on | `ClaimPaid` rejected as non-retryable and sent to the DLQ; status stays `Accepted`, loudly | Fail at the boundary; a rejected message is fixable, a wrong record may not be noticed. |
| 6a | Poison message: the producer ships `ClaimPaid` with the amount as text, so the consumer fails on every delivery | Retry limit 3, DLQ, no replay | Four failed attempts, then `ClaimPaid` sits in the DLQ; status stays `Accepted` and unpaid, visibly | Retrying a message that can never work only delays the failure; the DLQ holds it but nothing repairs the record. |
| 6b | Same as 6a | Replay after the producer fix | The fix ships 5 s after the DLQ fills and `ClaimPaid` is replayed with a fresh attempt count; the DLQ drains and the record is correct | Separate "retry later" from "never going to work": park it, fix the cause, replay. |

## Acceptance criteria for v1

Scenario files are `scenarios/<id>-*.json`. Tests: `npm test` and `cd java && ./mvnw verify`.

- [x] Every scenario above replays identically, with engine unit tests asserting the final record and the key trace rows. Covered by `test/engine.test.js` (an expectation test and a determinism test per scenario, plus trace assertions for 1a, 1b, 2a, 2b, 3a, 3b, 4, 5b, 6a, 6b). The Java runner asserts the same records in `ScenarioRunnerTest.java`.
- [x] Each run shows expected vs. observed and a one-sentence verdict. `judge` in `engine/engine.js` produces the verdict (tested in `test/engine.test.js`); `ui/lab.js` renders the comparison table. The rendered table itself has no automated test.
- [ ] Works with a keyboard: partly automated. `test/ui.test.js` checks control labels and that the trace region is focusable; full keyboard operation is manual.
- [ ] Works at 390 px width: manual. `ui/lab.css` has a `max-width: 640px` rule, but no test checks the layout.
- [ ] Respects `prefers-reduced-motion` by showing the timeline without animation: implemented in `ui/lab.js`, not covered by a test.
- [x] Labeled "Simulated in your browser with synthetic data." The note is `SIM_NOTE` in `ui/lab.js`, which extends that wording with the timing; no test asserts the text.
