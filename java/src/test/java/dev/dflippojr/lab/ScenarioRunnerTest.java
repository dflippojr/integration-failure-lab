package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * Executes every shared scenario over real HTTP and checks it reaches the same outcome the browser
 * simulation expects (scenarios/*.json "expect"), so the two implementations can't drift apart.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ScenarioRunnerTest {

    @Autowired
    ScenarioFiles files;

    @Autowired
    ScenarioRunner runner;

    @Autowired
    LabProperties props;

    @TestFactory
    Stream<DynamicTest> everyScenarioMatchesItsExpectation() throws Exception {
        List<Scenario> scenarios = files.load();
        assertThat(scenarios).hasSize(12);
        Map<String, List<String>> requiredKinds = Map.of(
                "2a-duplicate", List.of("ack-lost"),
                "2b-duplicate-idempotent", List.of("ack-lost", "dedupe"),
                "3b-out-of-order-buffered", List.of("buffer", "release"),
                "5b-schema-change-validated", List.of("reject", "dead-letter"),
                "6a-poison-message", List.of("reject", "retry-scheduled", "dead-letter"),
                "6b-poison-message-replay", List.of("dead-letter", "replay", "apply"));
        return scenarios.stream().map(s -> DynamicTest.dynamicTest(s.id(), () -> {
            Map<String, Object> result = runner.run(s);
            @SuppressWarnings("unchecked")
            Map<String, Object> expected = (Map<String, Object>) s.expect().get("record");
            @SuppressWarnings("unchecked")
            Map<String, Object> record = (Map<String, Object>) result.get("record");
            assertThat(record.get("status")).as("%s status", s.id()).isEqualTo(expected.get("status"));
            assertThat(((Number) record.get("paidCents")).longValue()).as("%s paidCents", s.id())
                    .isEqualTo(((Number) expected.get("paidCents")).longValue());
            if (s.expect().containsKey("dlq")) {
                assertThat(ids(result.get("dlq"))).as("%s dlq", s.id()).isEqualTo(s.expect().get("dlq"));
            }
            if (s.expect().containsKey("dropped")) {
                assertThat(ids(result.get("dropped"))).as("%s dropped", s.id()).isEqualTo(s.expect().get("dropped"));
            }
            if (Boolean.TRUE.equals(s.expect().get("ok"))) {
                assertThat(record.get("applied")).as("%s applied", s.id()).isEqualTo(List.of("E1", "E2", "E3"));
            }
            List<String> required = requiredKinds.get(s.id());
            if (required != null) {
                assertThat(kinds(result)).as("%s required trace kinds", s.id()).containsAll(required);
            }
            if (s.id().equals("6a-poison-message")) {
                assertThat(kinds(result)).as("%s forbidden trace kinds", s.id()).doesNotContain("replay", "timeout");
            }
            if (s.id().equals("3a-out-of-order")) {
                reorderDelayIsNetworkTimeAfterTheSend(result);
            }
            if (s.id().equals("4-combined")) {
                combinedFailuresDoNotBlockIndependentDeliveries(result);
            }
        }));
    }

    /** Parity with test/engine.test.js: the replay after the producer fix carries the original payload. */
    @Test
    void schemaChangeReplayAfterFixDeliversTheOriginalPayload() throws Exception {
        Scenario scenario = Scenario.fromMap(Map.of(
                "id", "x1-schema-replay",
                "failures", Map.of("schemaChange", Map.of("event", "ClaimPaid")),
                "safeguards", Map.of("schemaValidation", true, "replayAfterFix", true)));
        Map<String, Object> result = runner.run(scenario);
        @SuppressWarnings("unchecked")
        Map<String, Object> record = (Map<String, Object>) result.get("record");
        assertThat(record.get("status")).isEqualTo("Paid");
        assertThat(((Number) record.get("paidCents")).longValue()).isEqualTo(12000L);
        assertThat(record.get("applied")).isEqualTo(List.of("E1", "E2", "E3"));
        assertThat(ids(result.get("dlq"))).isEmpty();
        assertThat(kinds(result)).contains("replay");
    }

    /** Parity with test/engine.test.js (#99): each DLQ entry is replayed replayDelayMs after its own parking. */
    @Test
    void twoDeadLetteredEventsAreEachReplayedAfterTheirOwnDelay() throws Exception {
        Scenario scenario = Scenario.fromMap(Map.of(
                "id", "lead1-drain",
                "failures", Map.of(
                        "timeout", Map.of("event", "ClaimAccepted", "attempts", "all"),
                        "poison", Map.of("event", "ClaimPaid")),
                "safeguards", Map.of("retryLimit", 0, "replayAfterFix", true)));
        Map<String, Object> result = runner.run(scenario);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> trace = (List<Map<String, Object>>) result.get("trace");
        for (String id : List.of("E2", "E3")) {
            long parked = time(trace.get(rowIndex(trace, id, "dead-letter", null)));
            long replayed = time(trace.get(rowIndex(trace, id, "replay", null)));
            assertThat(replayed - parked).as("%s replay delay: %s", id, trace).isGreaterThanOrEqualTo(props.replayDelayMs());
        }
        assertThat(rowIndex(trace, "E3", "replay", null)).isLessThan(rowIndex(trace, "E2", "replay", null));
        assertThat(ids(result.get("dlq"))).isEqualTo(List.of("E2"));
        @SuppressWarnings("unchecked")
        Map<String, Object> record = (Map<String, Object>) result.get("record");
        assertThat(record.get("status")).isEqualTo("Paid");
        assertThat(record.get("applied")).isEqualTo(List.of("E1", "E3"));
    }

    private static long time(Map<String, Object> row) {
        return ((Number) row.get("t")).longValue();
    }

    private static void reorderDelayIsNetworkTimeAfterTheSend(Map<String, Object> result) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> trace = (List<Map<String, Object>>) result.get("trace");
        assertThat(rowIndex(trace, "E2", "emit", null)).isLessThan(rowIndex(trace, "E3", "emit", null));
        assertThat(rowIndex(trace, "E2", "send", 1)).isLessThan(rowIndex(trace, "E3", "send", 1));
        assertThat(rowIndex(trace, "E3", "apply", null)).isLessThan(rowIndex(trace, "E2", "apply", null));
    }

    private static void combinedFailuresDoNotBlockIndependentDeliveries(Map<String, Object> result) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> trace = (List<Map<String, Object>>) result.get("trace");
        int buffered = rowIndex(trace, "E3", "buffer", null);
        int timeout = rowIndex(trace, "E2", "timeout", 1);
        assertThat(buffered).as("E3 arrives independently while E2 waits for timeout: %s", trace)
                .isLessThan(timeout);
        assertThat(rowIndex(trace, "E3", "send", 1)).isLessThan(buffered);
        assertThat(rowIndex(trace, "E2", "send", 2)).isGreaterThan(timeout);
    }

    private static int rowIndex(List<Map<String, Object>> trace, String eventId, String kind, Integer attempt) {
        for (int i = 0; i < trace.size(); i++) {
            Map<String, Object> row = trace.get(i);
            if (eventId.equals(row.get("eventId")) && kind.equals(row.get("kind"))
                    && (attempt == null || attempt.equals(row.get("attempt")))) return i;
        }
        throw new AssertionError("Missing " + eventId + " " + kind + " attempt " + attempt + ": " + trace);
    }

    @SuppressWarnings("unchecked")
    private static List<Object> ids(Object entries) {
        return ((List<Map<String, Object>>) entries).stream().map(e -> e.get("eventId")).toList();
    }

    @SuppressWarnings("unchecked")
    private static List<Object> kinds(Map<String, Object> result) {
        return ((List<Map<String, Object>>) result.get("trace")).stream().map(r -> r.get("kind")).toList();
    }
}
