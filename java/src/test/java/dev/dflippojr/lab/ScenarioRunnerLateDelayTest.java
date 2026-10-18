package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.Set;

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

    @Autowired
    ScenarioRunner runner;

    @Test
    void aDelayedRequestThatOutlivesItsTimeoutStaysInItsOwnRun() throws Exception {
        Scenario late = new Scenario("late-delay", 0, "Delay longer than the timeout",
                new Scenario.Failures(null, Set.of(), false, null, "ClaimPaid", null, null),
                new Scenario.Safeguards(0, "exponential", false, false, false, true, false), Map.of());
        // E1 times out on every attempt, so this run is still going when the first run's E3 wakes up.
        Scenario next = new Scenario("still-running", 0, "Next run, still active",
                new Scenario.Failures("ClaimSubmitted", Set.of(), true, null, null, null, null),
                new Scenario.Safeguards(2, "exponential", false, false, false, true, false), Map.of());

        Map<String, Object> first = runner.run(late);
        Map<String, Object> second = runner.run(next);

        assertThat(record(second).get("applied")).as("second trace: %s", second.get("trace")).isEqualTo(List.of("E2", "E3"));
        assertThat(((Number) record(second).get("paidCents")).longValue()).isEqualTo(12000);

        // As in the engine, the delayed E3 is dead-lettered by the sender and still applied when it arrives.
        assertThat(ids(first.get("dlq"))).isEqualTo(List.of("E3"));
        assertThat(record(first).get("applied")).as("first trace: %s", first.get("trace")).isEqualTo(List.of("E1", "E2", "E3"));
        assertThat(((Number) record(first).get("paidCents")).longValue()).isEqualTo(12000);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> record(Map<String, Object> result) {
        return (Map<String, Object>) result.get("record");
    }

    private static List<?> ids(Object entries) {
        return ((List<?>) entries).stream().map(e -> ((Map<?, ?>) e).get("eventId")).toList();
    }
}
