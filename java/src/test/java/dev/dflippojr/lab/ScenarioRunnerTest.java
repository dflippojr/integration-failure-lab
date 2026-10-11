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

    @TestFactory
    Stream<DynamicTest> everyScenarioMatchesItsExpectation() throws Exception {
        List<Scenario> scenarios = files.load();
        assertThat(scenarios).hasSize(12);
        return scenarios.stream().map(s -> DynamicTest.dynamicTest(s.id(), () -> {
            Map<String, Object> result = runner.run(s);
            @SuppressWarnings("unchecked")
            Map<String, Object> expected = (Map<String, Object>) s.expect().get("record");
            @SuppressWarnings("unchecked")
            Map<String, Object> record = (Map<String, Object>) result.get("record");
            assertThat(record.get("status")).as("status").isEqualTo(expected.get("status"));
            assertThat(((Number) record.get("paidCents")).longValue()).as("paidCents")
                    .isEqualTo(((Number) expected.get("paidCents")).longValue());
            if (s.expect().containsKey("dlq")) {
                assertThat(ids(result.get("dlq"))).as("dlq").isEqualTo(s.expect().get("dlq"));
            }
            if (s.expect().containsKey("dropped")) {
                assertThat(ids(result.get("dropped"))).as("dropped").isEqualTo(s.expect().get("dropped"));
            }
            if (Boolean.TRUE.equals(s.expect().get("ok"))) {
                assertThat(record.get("applied")).as("applied").isEqualTo(List.of("E1", "E2", "E3"));
            }
        }));
    }

    @Test
    void combinedFailuresDoNotBlockIndependentDeliveries() throws Exception {
        Scenario scenario = files.load().stream().filter(s -> s.id().equals("4-combined")).findFirst().orElseThrow();
        Map<String, Object> result = runner.run(scenario);
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

    @Test
    void safeguardsLeaveTheirMarksInTheTrace() throws Exception {
        Map<String, Scenario> byId = files.load().stream().collect(java.util.stream.Collectors.toMap(Scenario::id, s -> s));
        assertThat(kinds(runner.run(byId.get("2a-duplicate")))).contains("ack-lost");
        assertThat(kinds(runner.run(byId.get("2b-duplicate-idempotent")))).contains("ack-lost", "dedupe");
        assertThat(kinds(runner.run(byId.get("3b-out-of-order-buffered")))).contains("buffer", "release");
        assertThat(kinds(runner.run(byId.get("5b-schema-change-validated")))).contains("reject", "dead-letter");
        assertThat(kinds(runner.run(byId.get("6a-poison-message")))).contains("reject", "retry-scheduled", "dead-letter")
                .doesNotContain("replay", "timeout");
        assertThat(kinds(runner.run(byId.get("6b-poison-message-replay")))).contains("dead-letter", "replay", "apply");
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
