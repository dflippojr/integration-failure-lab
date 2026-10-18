package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.Map;
import java.util.stream.Stream;

import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

class ScenarioTest {

    static Stream<Arguments> unsupportedBackoffs() {
        // Before validation, a poison scenario with an unknown backoff hung until the 30 s limit once its first retry computed a backoff.
        Map<String, Object> json = Map.of(
                "id", "unknown-backoff",
                "failures", Map.of("poison", Map.of("event", "ClaimPaid")),
                "safeguards", Map.of("backoff", "bogus"));
        return Stream.of(
                Arguments.of("bogus via Scenario.fromMap", (ThrowingCallable) () -> Scenario.fromMap(json),
                        "Scenario unknown-backoff: Unsupported safeguards.backoff \"bogus\"; expected one of none, fixed, exponential"),
                Arguments.of("null via the Safeguards constructor",
                        (ThrowingCallable) () -> new Scenario.Safeguards(3, null, false, false, false, true, false),
                        "Unsupported safeguards.backoff \"null\"; expected one of none, fixed, exponential"));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("unsupportedBackoffs")
    void unsupportedBackoffFailsAtLoadWithTheScenarioAndAllowedValues(String ignoredCase, ThrowingCallable load, String message) {
        assertThatThrownBy(load)
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage(message);
    }

    @Test
    void poisonAndSchemaChangeOnTheSameEventAreRejectedAtLoad() {
        Map<String, Object> json = Map.of(
                "id", "x2-poison-schema",
                "failures", Map.of("poison", Map.of("event", "ClaimPaid"), "schemaChange", Map.of("event", "ClaimPaid")));
        assertThatThrownBy(() -> Scenario.fromMap(json))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Scenario x2-poison-schema: failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)");
    }

    @Test
    void poisonAndSchemaChangeOnDifferentEventsStillLoad() {
        Scenario scenario = Scenario.fromMap(Map.of(
                "id", "ok",
                "failures", Map.of("poison", Map.of("event", "ClaimPaid"), "schemaChange", Map.of("event", "ClaimAccepted"))));
        assertThat(scenario.failures().poisonEvent()).isEqualTo("ClaimPaid");
        assertThat(scenario.failures().schemaChangeEvent()).isEqualTo("ClaimAccepted");
    }

    static Stream<Arguments> invalidIds() {
        return Stream.of(
                Arguments.of("../x", "Scenario ../x"),
                Arguments.of("a/b", "Scenario a/b"),
                Arguments.of("A1", "Scenario A1"),
                Arguments.of(null, "Scenario null"));
    }

    @ParameterizedTest(name = "{1}")
    @MethodSource("invalidIds")
    void idsThatCannotNameAnExportFileAreRejectedAtLoad(String id, String prefix) {
        // The id becomes <id>.json in the export directory, so "../x" used to write outside it.
        Map<String, Object> json = new HashMap<>();
        if (id != null) json.put("id", id);
        assertThatThrownBy(() -> Scenario.fromFile(json))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage(prefix + ": id must be lowercase letters, digits and single hyphens");
    }

    @Test
    void aDifferentialCombinationIdIsNotAFileNameSoItStillParses() {
        // Differential combinations stay in memory; only scenarios loaded from files go through the id-shape rule.
        Map<String, Object> combination = Map.of("id", "timeout-paid-all__retry0+no-deadLetter",
                "failures", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", "all")),
                "safeguards", Map.of("retryLimit", 0, "deadLetter", false));
        assertThat(Scenario.fromMap(combination).id()).isEqualTo("timeout-paid-all__retry0+no-deadLetter");
        assertThatThrownBy(() -> Scenario.fromFile(combination)).isInstanceOf(IllegalArgumentException.class);
    }

    static Stream<Arguments> backoffSchedules() {
        return Stream.of(
                Arguments.of("none", new long[] {0, 0, 0}),
                Arguments.of("fixed", new long[] {100, 100}),
                Arguments.of("exponential", new long[] {100, 200, 400}));
    }

    @ParameterizedTest
    @MethodSource("backoffSchedules")
    void supportedBackoffsLoadWithExactSchedules(String backoff, long[] expectedMs) {
        Scenario scenario = Scenario.fromMap(Map.of("id", "ok", "safeguards", Map.of("backoff", backoff)));
        long[] actual = new long[expectedMs.length];
        for (int retry = 1; retry <= expectedMs.length; retry++) {
            actual[retry - 1] = scenario.safeguards().backoffMs(100, retry);
        }
        assertThat(actual).as("%s backoff for retries 1..%d with base 100", backoff, expectedMs.length).containsExactly(expectedMs);
    }
}
