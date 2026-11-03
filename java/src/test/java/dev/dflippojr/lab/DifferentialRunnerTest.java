package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;

import tools.jackson.databind.ObjectMapper;

/** The batch mode behind scripts/differential.mjs: combinations in, normalised outcomes out. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// Leaves the shared store holding a run's events; ManualEventTest needs a context no run has touched.
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class DifferentialRunnerTest {

    @Autowired
    DifferentialRunner differential;

    @Autowired
    ScenarioRunner runner;

    @Autowired
    ObjectMapper json;

    @TempDir
    Path dir;

    @Test
    @SuppressWarnings("unchecked")
    void writesOneNormalisedOutcomePerCombinationInInputOrderOverRealHttp() throws Exception {
        List<Map<String, Object>> combinations = List.of(
                Map.of("id", "ackloss-paid__idempotency",
                        "failures", Map.of("duplicate", Map.of("event", "ClaimPaid")),
                        "safeguards", Map.of("idempotency", true)),
                Map.of("id", "timeout-paid-all__retry0+no-deadLetter",
                        "failures", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", "all")),
                        "safeguards", Map.of("retryLimit", 0, "deadLetter", false)),
                Map.of("id", "schema-paid+poison-paid__defaults",
                        "failures", Map.of("schemaChange", Map.of("event", "ClaimPaid"), "poison", Map.of("event", "ClaimPaid"))));
        Path in = dir.resolve("in.json");
        Path out = dir.resolve("nested").resolve("out.json");
        json.writeValue(in.toFile(), combinations);

        differential.runBatch(in, out, 2);

        List<Map<String, Object>> outcomes = json.readValue(Files.readString(out), List.class);
        assertThat(outcomes).extracting(o -> o.get("id")).containsExactly(
                "ackloss-paid__idempotency", "timeout-paid-all__retry0+no-deadLetter", "schema-paid+poison-paid__defaults");
        assertThat(outcomes.get(0).get("outcome")).isEqualTo(Map.of(
                "record", Map.of("status", "Paid", "paidCents", 12000, "applied", List.of("E1", "E2", "E3")),
                "dlq", List.of(), "dropped", List.of(), "buffered", List.of(),
                "verdict", Map.of("ok", true, "visible", false, "problems", List.of())));
        assertThat(outcomes.get(1).get("outcome")).isEqualTo(Map.of(
                "record", Map.of("status", "Accepted", "paidCents", 0, "applied", List.of("E1", "E2")),
                "dlq", List.of(), "dropped", List.of("E3"), "buffered", List.of(),
                "verdict", Map.of("ok", false, "visible", false, "problems", List.of(
                        "ClaimPaid never applied", "final status is Accepted, not Paid", "paid $0.00 instead of $120.00"))));
        assertThat((Map<String, Object>) outcomes.get(2).get("outcome")).containsOnlyKeys("error");
        assertThat((String) ((Map<String, Object>) outcomes.get(2).get("outcome")).get("error"))
                .isEqualTo("Scenario schema-paid+poison-paid__defaults: failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)");
    }

    @Test
    void refusedScenariosComeBackAsTheErrorTheEngineGives() throws Exception {
        // The same scenarios and messages as the engineOutcome refusal test in test/differential.test.js.
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "poison-typo",
                "failures", Map.of("poison", Map.of("event", "ClaimPayed")))))
                .isEqualTo(Map.of("error", "Scenario poison-typo: Unsupported failures.poison.event \"ClaimPayed\";"
                        + " expected one of ClaimSubmitted, ClaimAccepted, ClaimPaid"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "timeout-no-attempts",
                "failures", Map.of("timeout", Map.of("event", "ClaimPaid")))))
                .isEqualTo(Map.of("error", "Scenario timeout-no-attempts: Unsupported failures.timeout.attempts \"null\";"
                        + " expected \"all\" or a non-empty list of positive integers"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "reorder-50",
                "failures", Map.of("reorder", Map.of("event", "ClaimAccepted", "delayMs", 50)))))
                .isEqualTo(Map.of("error", "Scenario reorder-50: Unsupported failures.reorder.delayMs \"50\";"
                        + " expected 500, the one delay the Java runner takes"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "backoff-bogus", "safeguards", Map.of("backoff", "bogus"))))
                .isEqualTo(Map.of("error", "Scenario backoff-bogus: Unsupported safeguards.backoff \"bogus\";"
                        + " expected one of none, fixed, exponential"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "backoff-list", "safeguards", Map.of("backoff", List.of("fixed")))))
                .isEqualTo(Map.of("error", "Scenario backoff-list: Unsupported safeguards.backoff \"fixed\";"
                        + " expected one of none, fixed, exponential"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "timeout-huge-attempt",
                "failures", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", List.of(4294967297L))))))
                .isEqualTo(Map.of("error", "Scenario timeout-huge-attempt: Unsupported failures.timeout.attempts \"4294967297\";"
                        + " expected \"all\" or a non-empty list of positive integers"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "idempotency-text", "safeguards", Map.of("idempotency", "false"))))
                .isEqualTo(Map.of("error", "Scenario idempotency-text: Unsupported safeguards.idempotency \"false\"; expected true or false"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-text", "safeguards", Map.of("retryLimit", "3"))))
                .isEqualTo(Map.of("error", "Scenario retry-text: Unsupported safeguards.retryLimit \"3\";"
                        + " expected a whole number from 0 to 5"));
        Map<String, Object> nullRetryLimit = new HashMap<>(); // Map.of takes no null value
        nullRetryLimit.put("retryLimit", null);
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-null", "safeguards", nullRetryLimit)))
                .isEqualTo(Map.of("error", "Scenario retry-null: Unsupported safeguards.retryLimit \"null\";"
                        + " expected a whole number from 0 to 5"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-huge", "safeguards", Map.of("retryLimit", 4294967297L))))
                .isEqualTo(Map.of("error", "Scenario retry-huge: Unsupported safeguards.retryLimit \"4294967297\";"
                        + " expected a whole number from 0 to 5"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-six", "safeguards", Map.of("retryLimit", 6))))
                .isEqualTo(Map.of("error", "Scenario retry-six: Unsupported safeguards.retryLimit \"6\";"
                        + " expected a whole number from 0 to 5"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-fraction", "safeguards", Map.of("retryLimit", 0.0001))))
                .isEqualTo(Map.of("error", "Scenario retry-fraction: Unsupported safeguards.retryLimit \"0.0001\";"
                        + " expected a whole number from 0 to 5"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "idempotency-fraction", "safeguards", Map.of("idempotency", 0.0001))))
                .isEqualTo(Map.of("error", "Scenario idempotency-fraction: Unsupported safeguards.idempotency \"0.0001\"; expected true or false"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "backoff-object", "safeguards", Map.of("backoff", Map.of()))))
                .isEqualTo(Map.of("error", "Scenario backoff-object: Unsupported safeguards.backoff \"[object Object]\";"
                        + " expected one of none, fixed, exponential"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "backoff-null-element",
                "safeguards", Map.of("backoff", Arrays.asList(null, 1)))))
                .isEqualTo(Map.of("error", "Scenario backoff-null-element: Unsupported safeguards.backoff \",1\";"
                        + " expected one of none, fixed, exponential"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "backoff-nested", "safeguards", Map.of("backoff", List.of(List.of(1, 2), 3)))))
                .isEqualTo(Map.of("error", "Scenario backoff-nested: Unsupported safeguards.backoff \"1,2,3\";"
                        + " expected one of none, fixed, exponential"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "timeout-object-attempt",
                "failures", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", List.of(Map.of()))))))
                .isEqualTo(Map.of("error", "Scenario timeout-object-attempt: Unsupported failures.timeout.attempts \"[object Object]\";"
                        + " expected \"all\" or a non-empty list of positive integers"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "idempotency-object", "safeguards", Map.of("idempotency", Map.of()))))
                .isEqualTo(Map.of("error", "Scenario idempotency-object: Unsupported safeguards.idempotency \"[object Object]\"; expected true or false"));
    }

    /**
     * The longest run the refusal accepts, at the runner's default timings: a timeout on every attempt, the longest
     * backoff and a replay that does it all again. The differential's stratum runs the same combination at its own timings.
     */
    @Test
    void theLongestRunTheRetryLimitAllowsFinishesInsideTheRunLimit() throws Exception {
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "timeout-paid-all__retry5+replayAfterFix",
                "failures", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", "all")),
                "safeguards", Map.of("retryLimit", 5, "backoff", "exponential", "replayAfterFix", true)))).isEqualTo(Map.of(
                "record", Map.of("status", "Accepted", "paidCents", 0L, "applied", List.of("E1", "E2")),
                "dlq", List.of("E3"), "dropped", List.of(), "buffered", List.of(),
                "verdict", Map.of("ok", false, "visible", true, "problems", List.of(
                        "ClaimPaid never applied", "final status is Accepted, not Paid", "paid $0.00 instead of $120.00"))));
    }

    @Test
    void nullFailuresAndSafeguardsRunWithTheDefaultsAsInTheEngine() throws Exception {
        // The same scenario and outcome as the engineOutcome null-sections test in test/differential.test.js.
        Map<String, Object> combination = new HashMap<>(); // Map.of takes no null value
        combination.put("id", "null-sections");
        combination.put("failures", null);
        combination.put("safeguards", null);
        assertThat(DifferentialRunner.outcome(runner, combination)).isEqualTo(Map.of(
                "record", Map.of("status", "Paid", "paidCents", 12000L, "applied", List.of("E1", "E2", "E3")),
                "dlq", List.of(), "dropped", List.of(), "buffered", List.of(),
                "verdict", Map.of("ok", true, "visible", false, "problems", List.of())));
    }

    /** One table for both sides: test/differential.test.js checks the engine against this same file. */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> nonObjectSections() {
        return json.readValue(Path.of("../test/differential/non-object-sections.json").toFile(), List.class);
    }

    @Test
    void everyNonObjectSectionIsRefusedWithTheTextTheEngineGives() throws Exception {
        for (Map<String, Object> row : nonObjectSections()) {
            String error = (String) row.get("error");
            assertThatThrownBy(() -> Scenario.fromMap(row)).as((String) row.get("id"))
                    .isInstanceOf(IllegalArgumentException.class).hasMessage(error);
            assertThat(DifferentialRunner.outcome(runner, row)).as((String) row.get("id")).isEqualTo(Map.of("error", error));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void aBatchWithNonObjectSectionsStillWritesEveryOtherOutcome() throws Exception {
        List<Map<String, Object>> rows = nonObjectSections();
        List<Map<String, Object>> combinations = new ArrayList<>(rows);
        combinations.add(rows.size() / 2, Map.of("id", "healthy"));
        Path in = dir.resolve("in.json");
        Path out = dir.resolve("out.json");
        json.writeValue(in.toFile(), combinations);

        differential.runBatch(in, out, 1);

        List<Map<String, Object>> outcomes = json.readValue(Files.readString(out), List.class);
        assertThat(outcomes).extracting(o -> o.get("id")).isEqualTo(combinations.stream().map(c -> c.get("id")).toList());
        for (Map<String, Object> row : rows) {
            assertThat(outcomes.stream().filter(o -> row.get("id").equals(o.get("id"))).findFirst().orElseThrow().get("outcome"))
                    .isEqualTo(Map.of("error", row.get("error")));
        }
        Map<String, Object> healthy = (Map<String, Object>) outcomes.get(rows.size() / 2).get("outcome");
        assertThat(healthy).containsKeys("record", "verdict").doesNotContainKey("error");
    }

    @Test
    void anyOtherFailureToReadACombinationBecomesItsErrorRatherThanEndingTheBatch() throws Exception {
        // The engine ignores order, so this is not a refusal both sides share: Scenario.fromMap's cast fails on it.
        Map<String, Object> outcome = DifferentialRunner.outcome(runner, Map.of("id", "order-text", "order", "first"));
        assertThat(outcome).containsOnlyKeys("error");
        assertThat((String) outcome.get("error")).startsWith("Scenario order-text could not be read: ");
    }
}
