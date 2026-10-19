package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * An out-of-order delay longer than the read timeout: the sender gives up on the delayed attempt while
 * the downstream still holds it. The held request belongs to its own run, which must not finish before
 * it is processed, and must not reach the next run's store.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"lab.timeout-ms=300", "lab.reorder-delay-ms=1000"})
class ScenarioRunnerLateDelayTest {

    /** ClaimPaid is delayed past the read timeout, with no retries. */
    static final Scenario LATE = new Scenario("late-delay", 0, "Delay longer than the timeout",
            new Scenario.Failures(null, Set.of(), false, null, "ClaimPaid", null, null),
            new Scenario.Safeguards(0, "exponential", false, false, false, true, false), Map.of());

    /** E1 times out on every attempt, so this run is still going when the earlier run's E3 wakes up. */
    static Scenario stillRunning(int retryLimit) {
        return new Scenario("still-running", 0, "Next run, still active",
                new Scenario.Failures("ClaimSubmitted", Set.of(), true, null, null, null, null),
                new Scenario.Safeguards(retryLimit, "exponential", false, false, false, true, false), Map.of());
    }

    @Autowired
    ScenarioRunner runner;

    @Test
    void aDelayedRequestThatOutlivesItsTimeoutStaysInItsOwnRun() throws Exception {
        Map<String, Object> first = runner.run(LATE);
        Map<String, Object> second = runner.run(stillRunning(2));

        assertUntouched(second);

        // As in the engine, the delayed E3 is dead-lettered by the sender and still applied when it arrives.
        assertThat(ids(first.get("dlq"))).isEqualTo(List.of("E3"));
        assertThat(record(first).get("applied")).as("first trace: %s", first.get("trace")).isEqualTo(List.of("E1", "E2", "E3"));
        assertThat(((Number) record(first).get("paidCents")).longValue()).isEqualTo(12000);
    }

    /** Interrupting the wait for the delayed request ends the run with an error, and the request stays out of the next run. */
    @Test
    void interruptedCleanupFailsTheRunAndKeepsItsRequestOutOfTheNext() throws Exception {
        AtomicReference<Object> outcome = new AtomicReference<>();
        Thread first = new Thread(() -> {
            try {
                outcome.set(runner.run(LATE));
            } catch (Exception | Error failure) {
                outcome.set(failure);
            }
        });
        first.start();
        awaitFrame(first, "awaitIdle");
        first.interrupt();
        first.join(10_000);

        assertThat(outcome.get()).as("an interrupted cleanup must not return a result")
                .isInstanceOf(IllegalStateException.class);
        assertThat(((Throwable) outcome.get()).getMessage()).contains("interrupted");

        assertUntouched(runner.run(stillRunning(2)));
    }

    /** The second run's own E2 and E3 only: no event from an earlier run reached its store. */
    static void assertUntouched(Map<String, Object> second) {
        assertThat(record(second).get("applied")).as("second trace: %s", second.get("trace")).isEqualTo(List.of("E2", "E3"));
        assertThat(((Number) record(second).get("paidCents")).longValue()).isEqualTo(12000);
    }

    /** Waits until the thread is inside the named method. */
    static void awaitFrame(Thread thread, String method) throws InterruptedException {
        long deadline = System.nanoTime() + 10_000_000_000L;
        while (Arrays.stream(thread.getStackTrace()).noneMatch(frame -> frame.getMethodName().equals(method))) {
            assertThat(System.nanoTime()).as("%s reached %s", thread.getName(), method).isLessThan(deadline);
            Thread.sleep(5);
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> record(Map<String, Object> result) {
        return (Map<String, Object>) result.get("record");
    }

    private static List<?> ids(Object entries) {
        return ((List<?>) entries).stream().map(e -> ((Map<?, ?>) e).get("eventId")).toList();
    }
}
