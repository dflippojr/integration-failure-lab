package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.List;
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
                .isInstanceOf(Scenario.Refused.class)
                .hasMessage("Scenario x2-poison-schema: failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)")
                .extracting(e -> ((Scenario.Refused) e).rule()).isEqualTo("failures.poison+schemaChange");
    }

    private static final String EVENTS = "expected one of ClaimSubmitted, ClaimAccepted, ClaimPaid";
    private static final String ATTEMPTS = "expected \"all\" or a non-empty list of positive integers";
    private static final String DELAY = "expected 500, the one delay the Java runner takes";
    private static final String RETRY_LIMIT = "expected a whole number from 0 to 5";
    private static final String ON_OFF = "expected true or false";

    /** A scenario refused by {@code rule}, whose reason reads {@code Unsupported <rule> "<value>"; <expected>}. */
    private static Arguments refused(String id, Map<String, Object> json, String rule, String value, String expected) {
        Map<String, Object> scenario = new HashMap<>(json);
        scenario.put("id", id);
        return Arguments.of(id, scenario, rule, "Scenario " + id + ": Unsupported " + rule + " \"" + value + "\"; " + expected);
    }

    private static Arguments refusedFailure(String id, String kind, Map<String, Object> failure, String rule, String value, String expected) {
        return refused(id, Map.of("failures", Map.of(kind, failure)), rule, value, expected);
    }

    private static Arguments refusedSafeguard(String id, String name, Object value, String shown, String expected) {
        Map<String, Object> safeguards = new HashMap<>(); // Map.of takes no null value
        safeguards.put(name, value);
        return refused(id, Map.of("safeguards", safeguards), "safeguards." + name, shown, expected);
    }

    /**
     * Each single-field rule, refused with that field's path as the rule id and a reason in Java's own words: a value reads
     * as String.valueOf shows it (#198). Which rule refuses which input is held to the engine's by
     * test/differential/refusals.json, which DifferentialRunnerTest and test/differential.test.js both read.
     */
    static Stream<Arguments> brokenRules() {
        Map<String, Object> noEvent = new HashMap<>();
        return Stream.of(
                refusedFailure("x-poison-typo", "poison", Map.of("event", "ClaimPayed"), "failures.poison.event", "ClaimPayed", EVENTS),
                refusedFailure("x-timeout-typo", "timeout", Map.of("event", "ClaimPayed", "attempts", "all"), "failures.timeout.event", "ClaimPayed", EVENTS),
                refusedFailure("x-duplicate-none", "duplicate", noEvent, "failures.duplicate.event", "null", EVENTS),
                refusedFailure("x-reorder-typo", "reorder", Map.of("event", "claimAccepted", "delayMs", 500), "failures.reorder.event", "claimAccepted", EVENTS),
                refusedFailure("x-schema-number", "schemaChange", Map.of("event", 3), "failures.schemaChange.event", "3", EVENTS),
                refusedFailure("x-attempts-missing", "timeout", Map.of("event", "ClaimPaid"), "failures.timeout.attempts", "null", ATTEMPTS),
                refusedFailure("x-attempts-empty", "timeout", Map.of("event", "ClaimPaid", "attempts", List.of()), "failures.timeout.attempts", "[]", ATTEMPTS),
                refusedFailure("x-attempts-zero", "timeout", Map.of("event", "ClaimPaid", "attempts", List.of(1, 0)), "failures.timeout.attempts", "[1, 0]", ATTEMPTS),
                refusedFailure("x-attempts-fraction", "timeout", Map.of("event", "ClaimPaid", "attempts", List.of(1.5)), "failures.timeout.attempts", "[1.5]", ATTEMPTS),
                refusedFailure("x-attempts-word", "timeout", Map.of("event", "ClaimPaid", "attempts", "first"), "failures.timeout.attempts", "first", ATTEMPTS),
                // Jackson parses this as a Long, which intValue() used to wrap to attempt 1.
                refusedFailure("x-attempts-huge", "timeout", Map.of("event", "ClaimPaid", "attempts", List.of(4294967297L)), "failures.timeout.attempts", "[4294967297]", ATTEMPTS),
                refusedFailure("x-delay-50", "reorder", Map.of("event", "ClaimAccepted", "delayMs", 50), "failures.reorder.delayMs", "50", DELAY),
                refusedFailure("x-delay-missing", "reorder", Map.of("event", "ClaimAccepted"), "failures.reorder.delayMs", "null", DELAY),
                refusedSafeguard("x-backoff-quiet", "backoff", "bogus", "bogus", "expected one of none, fixed, exponential"),
                // The engine compares the raw value, so ["fixed"] is not "fixed" there either.
                refusedSafeguard("x-backoff-list", "backoff", List.of("fixed"), "[fixed]", "expected one of none, fixed, exponential"),
                refusedSafeguard("x-retry-text", "retryLimit", "3", "3", RETRY_LIMIT),
                refusedSafeguard("x-retry-null", "retryLimit", null, "null", RETRY_LIMIT),
                refusedSafeguard("x-retry-negative", "retryLimit", -1, "-1", RETRY_LIMIT),
                refusedSafeguard("x-retry-fraction", "retryLimit", 1.5, "1.5", RETRY_LIMIT),
                refusedSafeguard("x-retry-tiny", "retryLimit", 0.0001, "1.0E-4", RETRY_LIMIT),
                refusedSafeguard("x-retry-vast", "retryLimit", 1.5e21, "1.5E21", RETRY_LIMIT),
                // Above the most retries the runner can finish inside its run limit.
                refusedSafeguard("x-retry-six", "retryLimit", 6, "6", RETRY_LIMIT),
                refusedSafeguard("x-retry-int-max", "retryLimit", Integer.MAX_VALUE, "2147483647", RETRY_LIMIT),
                // Past the int range: intValue() would wrap 4294967297 to 1 retry.
                refusedSafeguard("x-retry-huge", "retryLimit", 4294967297L, "4294967297", RETRY_LIMIT),
                refusedSafeguard("x-idempotency-text", "idempotency", "false", "false", ON_OFF),
                refusedSafeguard("x-ordering-text", "ordering", "false", "false", ON_OFF),
                refusedSafeguard("x-schemaValidation-text", "schemaValidation", "false", "false", ON_OFF),
                refusedSafeguard("x-deadLetter-text", "deadLetter", "false", "false", ON_OFF),
                refusedSafeguard("x-replayAfterFix-text", "replayAfterFix", "false", "false", ON_OFF),
                refusedSafeguard("x-dedupe-number", "idempotency", 1, "1", ON_OFF),
                refusedSafeguard("x-dedupe-object", "idempotency", Map.of(), "{}", ON_OFF),
                refusedSafeguard("x-dlq-null", "deadLetter", null, "null", ON_OFF),
                refused("x-failures-list", Map.of("failures", List.of("timeout", 1)), "failures", "[timeout, 1]", "expected an object"),
                refused("x-safeguards-number", Map.of("safeguards", 3.5), "safeguards", "3.5", "expected an object"));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("brokenRules")
    void aScenarioThatBreaksARuleIsRefusedWithTheRuleIdAndAReasonInJavasWords(String ignoredId, Map<String, Object> json, String rule, String message) {
        assertThatThrownBy(() -> Scenario.fromMap(json)).isInstanceOf(Scenario.Refused.class).hasMessage(message)
                .extracting(e -> ((Scenario.Refused) e).rule()).isEqualTo(rule);
    }

    @Test
    void nonObjectFailuresAreRefused() {
        assertThatThrownBy(() -> Scenario.fromMap(Map.of("id", "x", "failures", "timeout")))
                .isInstanceOf(Scenario.Refused.class)
                .hasMessageStartingWith("Scenario x: ")
                .extracting(e -> ((Scenario.Refused) e).rule()).isEqualTo("failures");
    }

    @Test
    void wholeNumberRetryLimitsUpToFiveStillLoad() {
        assertThat(Scenario.fromMap(Map.of("id", "ok", "safeguards", Map.of("retryLimit", 2.0))).safeguards().retryLimit()).isEqualTo(2);
        assertThat(Scenario.fromMap(Map.of("id", "ok", "safeguards", Map.of("retryLimit", 5, "deadLetter", false)))
                .safeguards()).isEqualTo(new Scenario.Safeguards(5, "exponential", false, false, false, false, false));
    }

    @Test
    void theShippedReorderDelayAndWholeNumberAttemptsStillLoad() {
        Scenario scenario = Scenario.fromMap(Map.of("id", "ok", "failures", Map.of(
                "reorder", Map.of("event", "ClaimAccepted", "delayMs", 500.0),
                "timeout", Map.of("event", "ClaimPaid", "attempts", List.of(1, 2.0)))));
        assertThat(scenario.failures().delayed("ClaimAccepted", 1)).isTrue();
        assertThat(scenario.failures().timeoutAttempts()).containsExactlyInAnyOrder(1, 2);
    }

    @Test
    void poisonAndSchemaChangeOnDifferentEventsStillLoad() {
        Scenario scenario = Scenario.fromMap(Map.of(
                "id", "ok",
                "failures", Map.of("poison", Map.of("event", "ClaimPaid"), "schemaChange", Map.of("event", "ClaimAccepted"))));
        assertThat(scenario.failures().poisonEvent()).isEqualTo("ClaimPaid");
        assertThat(scenario.failures().schemaChangeEvent()).isEqualTo("ClaimAccepted");
    }

    @Test
    void nullFailuresAndSafeguardsMeanAbsentAsInTheEngine() {
        // engine.js run() reads failures ?? {} and spreads safeguards over the defaults, so null runs with the defaults.
        Scenario defaults = Scenario.fromMap(Map.of("id", "x-null"));
        for (String section : List.of("failures", "safeguards")) {
            Map<String, Object> json = new HashMap<>(); // Map.of takes no null value
            json.put("id", "x-null");
            json.put(section, null);
            assertThat(Scenario.fromMap(json)).as(section).isEqualTo(defaults);
        }
        Map<String, Object> both = new HashMap<>();
        both.put("id", "x-null");
        both.put("failures", null);
        both.put("safeguards", null);
        assertThat(Scenario.fromMap(both)).isEqualTo(defaults);
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
                .isInstanceOf(Scenario.Refused.class)
                .hasMessage(prefix + ": id must be lowercase letters, digits and single hyphens")
                .extracting(e -> ((Scenario.Refused) e).rule()).isEqualTo("id");
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
