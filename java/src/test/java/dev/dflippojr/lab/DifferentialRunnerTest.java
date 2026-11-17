package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
                "dlq", List.of(), "dropped", List.of(), "buffered", List.of()));
        assertThat(outcomes.get(1).get("outcome")).isEqualTo(Map.of(
                "record", Map.of("status", "Accepted", "paidCents", 0, "applied", List.of("E1", "E2")),
                "dlq", List.of(), "dropped", List.of("E3"), "buffered", List.of()));
        assertThat(outcomes.get(2).get("outcome")).isEqualTo(Map.of("refused", "failures.poison+schemaChange"));
    }

    /** A shared table: test/differential.test.js checks the engine against the same file. */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> table(String name) {
        return json.readValue(Path.of("../test/differential/" + name).toFile(), List.class);
    }

    /**
     * #198: a refusal compares by rule, so each refused combination comes back as {@code {refused: <rule id>}}, the id
     * engine/rules.js gives for it, while the message stays in this runtime's words. The rows that break two rules hold
     * Scenario.refusal to the engine's rule order.
     */
    @Test
    void everyRefusalNamesTheRuleTheEngineNames() throws Exception {
        for (Map<String, Object> row : table("refusals.json")) {
            String id = (String) row.get("id");
            assertThatThrownBy(() -> Scenario.fromMap(row)).as(id).isInstanceOf(Scenario.Refused.class)
                    .hasMessageStartingWith("Scenario " + id + ": ")
                    .extracting(e -> ((Scenario.Refused) e).rule()).isEqualTo(row.get("refused"));
            assertThat(DifferentialRunner.outcome(runner, row)).as(id).isEqualTo(Map.of("refused", row.get("refused")));
        }
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
                "dlq", List.of("E3"), "dropped", List.of(), "buffered", List.of()));
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
                "dlq", List.of(), "dropped", List.of(), "buffered", List.of()));
    }

    @Test
    void everyNonObjectSectionIsRefusedByTheRuleTheEngineNames() throws Exception {
        for (Map<String, Object> row : table("non-object-sections.json")) {
            String id = (String) row.get("id");
            assertThatThrownBy(() -> Scenario.fromMap(row)).as(id).isInstanceOf(Scenario.Refused.class)
                    .hasMessageStartingWith("Scenario " + id + ": Unsupported " + row.get("refused") + " ")
                    .extracting(e -> ((Scenario.Refused) e).rule()).isEqualTo(row.get("refused"));
            assertThat(DifferentialRunner.outcome(runner, row)).as(id).isEqualTo(Map.of("refused", row.get("refused")));
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void aBatchWithNonObjectSectionsStillWritesEveryOtherOutcome() throws Exception {
        List<Map<String, Object>> rows = table("non-object-sections.json");
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
                    .isEqualTo(Map.of("refused", row.get("refused")));
        }
        Map<String, Object> healthy = (Map<String, Object>) outcomes.get(rows.size() / 2).get("outcome");
        assertThat(healthy).containsOnlyKeys("record", "dlq", "dropped", "buffered");
    }

    @Test
    void anyOtherFailureToReadACombinationBecomesItsErrorRatherThanEndingTheBatch() throws Exception {
        // The engine ignores order, so this is not a refusal both sides share: Scenario.fromMap's cast fails on it.
        Map<String, Object> outcome = DifferentialRunner.outcome(runner, Map.of("id", "order-text", "order", "first"));
        assertThat(outcome).containsOnlyKeys("error");
        assertThat((String) outcome.get("error")).startsWith("Scenario order-text could not be read: ");
    }
}
