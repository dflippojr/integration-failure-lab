package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
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
                        + " expected a whole number from 0 to 2147483647"));
        Map<String, Object> nullRetryLimit = new HashMap<>(); // Map.of takes no null value
        nullRetryLimit.put("retryLimit", null);
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-null", "safeguards", nullRetryLimit)))
                .isEqualTo(Map.of("error", "Scenario retry-null: Unsupported safeguards.retryLimit \"null\";"
                        + " expected a whole number from 0 to 2147483647"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-huge", "safeguards", Map.of("retryLimit", 4294967297L))))
                .isEqualTo(Map.of("error", "Scenario retry-huge: Unsupported safeguards.retryLimit \"4294967297\";"
                        + " expected a whole number from 0 to 2147483647"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "retry-fraction", "safeguards", Map.of("retryLimit", 0.0001))))
                .isEqualTo(Map.of("error", "Scenario retry-fraction: Unsupported safeguards.retryLimit \"0.0001\";"
                        + " expected a whole number from 0 to 2147483647"));
        assertThat(DifferentialRunner.outcome(runner, Map.of("id", "idempotency-fraction", "safeguards", Map.of("idempotency", 0.0001))))
                .isEqualTo(Map.of("error", "Scenario idempotency-fraction: Unsupported safeguards.idempotency \"0.0001\"; expected true or false"));
    }

    @Test
    void nullFailuresAndSafeguardsRunWithTheDefaultsAsInTheEngine() throws Exception {
        // The same scenario and outcome as the engineOutcome null-sections test in test/differential.test.js.
        Map<String, Object> combination = new HashMap<>(); // Map.of takes no null value
        combination.put("id", "null-sections");
        combination.put("failures", null);
        combination.put("safeguards", null);
        assertThat(DifferentialRunner.outcome(runner, combination)).isEqualTo(Map.of(
                "record", Map.of("status", "Paid", "paidCents", 12000, "applied", List.of("E1", "E2", "E3")),
                "dlq", List.of(), "dropped", List.of(), "buffered", List.of(),
                "verdict", Map.of("ok", true, "visible", false, "problems", List.of())));
    }
}
