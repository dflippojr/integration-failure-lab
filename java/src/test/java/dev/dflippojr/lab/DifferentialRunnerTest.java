package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import tools.jackson.databind.ObjectMapper;

/** The batch mode behind scripts/differential.mjs: combinations in, normalised outcomes out. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class DifferentialRunnerTest {

    @Autowired
    DifferentialRunner differential;

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
}
