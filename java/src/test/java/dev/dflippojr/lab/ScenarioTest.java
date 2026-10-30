package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.math.BigInteger;
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
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Scenario x2-poison-schema: failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)");
    }

    private static final String EVENTS = "expected one of ClaimSubmitted, ClaimAccepted, ClaimPaid";
    private static final String ATTEMPTS = "expected \"all\" or a non-empty list of positive integers";
    private static final String DELAY = "expected 500, the one delay the Java runner takes";

    private static Arguments refused(String id, Map<String, Object> failures, String message) {
        return Arguments.of(id, Map.of("id", id, "failures", failures), "Scenario " + id + ": " + message);
    }

    // The same cases and messages as the refusal tests in test/engine.test.js, so both sides refuse alike.
    static Stream<Arguments> unknownEvents() {
        Map<String, Object> noEvent = new HashMap<>();
        return Stream.of(
                refused("x-poison-typo", Map.of("poison", Map.of("event", "ClaimPayed")), "Unsupported failures.poison.event \"ClaimPayed\"; " + EVENTS),
                refused("x-timeout-typo", Map.of("timeout", Map.of("event", "ClaimPayed", "attempts", "all")), "Unsupported failures.timeout.event \"ClaimPayed\"; " + EVENTS),
                refused("x-duplicate-none", Map.of("duplicate", noEvent), "Unsupported failures.duplicate.event \"null\"; " + EVENTS),
                refused("x-reorder-typo", Map.of("reorder", Map.of("event", "claimAccepted", "delayMs", 500)), "Unsupported failures.reorder.event \"claimAccepted\"; " + EVENTS),
                refused("x-schema-number", Map.of("schemaChange", Map.of("event", 3)), "Unsupported failures.schemaChange.event \"3\"; " + EVENTS));
    }

    static Stream<Arguments> invalidTimeoutAttempts() {
        return Stream.of(
                refused("x-attempts-missing", Map.of("timeout", Map.of("event", "ClaimPaid")), "Unsupported failures.timeout.attempts \"null\"; " + ATTEMPTS),
                refused("x-attempts-empty", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", List.of())), "Unsupported failures.timeout.attempts \"\"; " + ATTEMPTS),
                refused("x-attempts-zero", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", List.of(1, 0))), "Unsupported failures.timeout.attempts \"1,0\"; " + ATTEMPTS),
                refused("x-attempts-fraction", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", List.of(1.5))), "Unsupported failures.timeout.attempts \"1.5\"; " + ATTEMPTS),
                refused("x-attempts-word", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", "first")), "Unsupported failures.timeout.attempts \"first\"; " + ATTEMPTS),
                // Jackson parses this as a Long, which intValue() used to wrap to attempt 1.
                refused("x-attempts-huge", Map.of("timeout", Map.of("event", "ClaimPaid", "attempts", List.of(4294967297L))), "Unsupported failures.timeout.attempts \"4294967297\"; " + ATTEMPTS));
    }

    static Stream<Arguments> unsupportedReorderDelays() {
        return Stream.of(
                refused("x-delay-50", Map.of("reorder", Map.of("event", "ClaimAccepted", "delayMs", 50)), "Unsupported failures.reorder.delayMs \"50\"; " + DELAY),
                refused("x-delay-missing", Map.of("reorder", Map.of("event", "ClaimAccepted")), "Unsupported failures.reorder.delayMs \"null\"; " + DELAY));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("unknownEvents")
    void aFailureThatTargetsAnUnknownEventTypeIsRejectedAtLoad(String ignoredId, Map<String, Object> json, String message) {
        assertThatThrownBy(() -> Scenario.fromMap(json)).isInstanceOf(IllegalArgumentException.class).hasMessage(message);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("invalidTimeoutAttempts")
    void timeoutAttemptsThatAreNeitherAllNorPositiveIntegersAreRejectedAtLoad(String ignoredId, Map<String, Object> json, String message) {
        assertThatThrownBy(() -> Scenario.fromMap(json)).isInstanceOf(IllegalArgumentException.class).hasMessage(message);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("unsupportedReorderDelays")
    void aReorderDelayOtherThan500IncludingAMissingOneIsRejectedAtLoad(String ignoredId, Map<String, Object> json, String message) {
        assertThatThrownBy(() -> Scenario.fromMap(json)).isInstanceOf(IllegalArgumentException.class).hasMessage(message);
    }

    @Test
    void anUnsupportedBackoffIsRejectedAtLoadEvenWhenNothingRetries() {
        assertThatThrownBy(() -> Scenario.fromMap(Map.of("id", "x-backoff-quiet", "safeguards", Map.of("backoff", "bogus"))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Scenario x-backoff-quiet: Unsupported safeguards.backoff \"bogus\"; expected one of none, fixed, exponential");
    }

    @Test
    void aListBackoffIsRejectedAtLoadEvenWhenItsOnlyElementIsSupported() {
        // The engine compares the raw value, so ["fixed"] is not "fixed" there either.
        assertThatThrownBy(() -> Scenario.fromMap(Map.of("id", "x-backoff-list", "safeguards", Map.of("backoff", List.of("fixed")))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Scenario x-backoff-list: Unsupported safeguards.backoff \"fixed\"; expected one of none, fixed, exponential");
    }

    private static final String RETRY_LIMIT = "expected a whole number from 0 to 2147483647";
    private static final String ON_OFF = "expected true or false";

    private static Arguments refusedSafeguard(String id, String name, Object value, String message) {
        Map<String, Object> safeguards = new HashMap<>(); // Map.of takes no null value
        safeguards.put(name, value);
        return Arguments.of(id, Map.of("id", id, "safeguards", safeguards), "Scenario " + id + ": " + message);
    }

    // The same cases and messages as the safeguard refusal tests in test/engine.test.js.
    static Stream<Arguments> unsupportedSafeguards() {
        return Stream.of(
                refusedSafeguard("x-retry-text", "retryLimit", "3", "Unsupported safeguards.retryLimit \"3\"; " + RETRY_LIMIT),
                refusedSafeguard("x-retry-null", "retryLimit", null, "Unsupported safeguards.retryLimit \"null\"; " + RETRY_LIMIT),
                refusedSafeguard("x-retry-negative", "retryLimit", -1, "Unsupported safeguards.retryLimit \"-1\"; " + RETRY_LIMIT),
                refusedSafeguard("x-retry-fraction", "retryLimit", 1.5, "Unsupported safeguards.retryLimit \"1.5\"; " + RETRY_LIMIT),
                refusedSafeguard("x-retry-tiny", "retryLimit", 0.0001, "Unsupported safeguards.retryLimit \"0.0001\"; " + RETRY_LIMIT),
                refusedSafeguard("x-retry-tinier", "retryLimit", 1e-7, "Unsupported safeguards.retryLimit \"1e-7\"; " + RETRY_LIMIT),
                refusedSafeguard("x-retry-vast", "retryLimit", 1.5e21, "Unsupported safeguards.retryLimit \"1.5e+21\"; " + RETRY_LIMIT),
                // Past the int range: intValue() would wrap 4294967297 to 1 retry.
                refusedSafeguard("x-retry-huge", "retryLimit", 4294967297L, "Unsupported safeguards.retryLimit \"4294967297\"; " + RETRY_LIMIT),
                refusedSafeguard("x-idempotency-text", "idempotency", "false", "Unsupported safeguards.idempotency \"false\"; " + ON_OFF),
                refusedSafeguard("x-ordering-text", "ordering", "false", "Unsupported safeguards.ordering \"false\"; " + ON_OFF),
                refusedSafeguard("x-schemaValidation-text", "schemaValidation", "false", "Unsupported safeguards.schemaValidation \"false\"; " + ON_OFF),
                refusedSafeguard("x-deadLetter-text", "deadLetter", "false", "Unsupported safeguards.deadLetter \"false\"; " + ON_OFF),
                refusedSafeguard("x-replayAfterFix-text", "replayAfterFix", "false", "Unsupported safeguards.replayAfterFix \"false\"; " + ON_OFF),
                refusedSafeguard("x-dedupe-number", "idempotency", 1, "Unsupported safeguards.idempotency \"1\"; " + ON_OFF),
                refusedSafeguard("x-dedupe-fraction", "idempotency", 0.0001, "Unsupported safeguards.idempotency \"0.0001\"; " + ON_OFF),
                refusedSafeguard("x-dlq-null", "deadLetter", null, "Unsupported safeguards.deadLetter \"null\"; " + ON_OFF));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("unsupportedSafeguards")
    void aRetryLimitOrOnOffSafeguardOfTheWrongTypeOrRangeIsRejectedAtLoad(String ignoredId, Map<String, Object> json, String message) {
        assertThatThrownBy(() -> Scenario.fromMap(json)).isInstanceOf(IllegalArgumentException.class).hasMessage(message);
    }

    // What node prints for String(x) of the same JSON number: plain decimal from 1e-7 up to 1e21, the shortest digits
    // that read back as the same double, and E-notation with a sign outside that range.
    static Stream<Arguments> numbersAsJavaScriptShowsThem() {
        return Stream.of(
                Arguments.of(0.0001, "0.0001"), Arguments.of(0.000001, "0.000001"), Arguments.of(1e-7, "1e-7"),
                Arguments.of(-1e-7, "-1e-7"), Arguments.of(1.23e-18, "1.23e-18"), Arguments.of(Double.MIN_VALUE, "5e-324"),
                Arguments.of(0.1 + 0.2, "0.30000000000000004"), Arguments.of(4.35, "4.35"), Arguments.of(1278262360055478.75, "1278262360055478.8"), Arguments.of(-1.5, "-1.5"),
                Arguments.of(-0.0, "0"), Arguments.of(2.0, "2"), Arguments.of(1e16, "10000000000000000"),
                Arguments.of(1.2345678901234568e20, "123456789012345680000"), Arguments.of(1e21, "1e+21"),
                Arguments.of(1.5e21, "1.5e+21"), Arguments.of(Double.MAX_VALUE, "1.7976931348623157e+308"),
                Arguments.of(4294967297L, "4294967297"), Arguments.of(new BigInteger("12345678901234567890"), "12345678901234567000"),
                Arguments.of(new BigDecimal("0.0001"), "0.0001"), Arguments.of(Double.POSITIVE_INFINITY, "Infinity"),
                Arguments.of(Double.NaN, "NaN"));
    }

    @ParameterizedTest(name = "{1}")
    @MethodSource("numbersAsJavaScriptShowsThem")
    void aNumberIsShownAsJavaScriptsStringShowsIt(Number value, String shown) {
        assertThat(Scenario.shown(value)).isEqualTo(shown);
    }

    @Test
    void theRetryLimitIsCheckedFirstThenTheOnOffSafeguardsInTheEnginesOrder() {
        assertThatThrownBy(() -> Scenario.fromMap(Map.of("id", "x-several",
                "safeguards", Map.of("replayAfterFix", 0, "ordering", "yes", "retryLimit", "1"))))
                .hasMessage("Scenario x-several: Unsupported safeguards.retryLimit \"1\"; " + RETRY_LIMIT);
        assertThatThrownBy(() -> Scenario.fromMap(Map.of("id", "x-several", "safeguards", Map.of("replayAfterFix", 0, "ordering", "yes"))))
                .hasMessage("Scenario x-several: Unsupported safeguards.ordering \"yes\"; " + ON_OFF);
    }

    private static Arguments brokenTwice(String id, Map<String, Object> failures, Map<String, Object> safeguards, String message) {
        return Arguments.of(id, Map.of("id", id, "failures", failures, "safeguards", safeguards), "Scenario " + id + ": " + message);
    }

    // A scenario that breaks two rules from different groups gets the message of the rule engine.js refusal() checks
    // first. The same cases as the precedence test in test/engine.test.js.
    static Stream<Arguments> rulesBrokenTwice() {
        Map<String, Object> sameEvent = Map.of("poison", Map.of("event", "ClaimPaid"), "schemaChange", Map.of("event", "ClaimPaid"));
        return Stream.of(
                brokenTwice("x-event-and-backoff", Map.of("poison", Map.of("event", "ClaimPayed")), Map.of("backoff", "bogus"),
                        "Unsupported failures.poison.event \"ClaimPayed\"; " + EVENTS),
                brokenTwice("x-delay-and-same-event", Map.of("reorder", Map.of("event", "ClaimAccepted", "delayMs", 50),
                                "poison", Map.of("event", "ClaimPaid"), "schemaChange", Map.of("event", "ClaimPaid")), Map.of(),
                        "Unsupported failures.reorder.delayMs \"50\"; " + DELAY),
                brokenTwice("x-same-event-and-retry", sameEvent, Map.of("retryLimit", -1),
                        "failures.poison and failures.schemaChange cannot target the same event (ClaimPaid)"),
                brokenTwice("x-backoff-and-retry", Map.of(), Map.of("backoff", "bogus", "retryLimit", -1),
                        "Unsupported safeguards.backoff \"bogus\"; expected one of none, fixed, exponential"),
                brokenTwice("x-retry-and-toggle", Map.of(), Map.of("retryLimit", -1, "idempotency", "yes"),
                        "Unsupported safeguards.retryLimit \"-1\"; " + RETRY_LIMIT));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("rulesBrokenTwice")
    void aScenarioThatBreaksTwoRulesGetsTheMessageOfTheOneTheEngineChecksFirst(String ignoredId, Map<String, Object> json, String message) {
        assertThatThrownBy(() -> Scenario.fromMap(json)).isInstanceOf(IllegalArgumentException.class).hasMessage(message);
    }

    @Test
    void aFailureRefusalStillWinsWhenTheSafeguardsAreNotAnObject() {
        // The engine spreads [] into no safeguards and refuses the event, so the failure rules run before the safeguards cast.
        assertThatThrownBy(() -> Scenario.fromMap(Map.of("id", "x-event-and-list-safeguards",
                "failures", Map.of("poison", Map.of("event", "ClaimPayed")), "safeguards", List.of())))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Scenario x-event-and-list-safeguards: Unsupported failures.poison.event \"ClaimPayed\"; " + EVENTS);
    }

    @Test
    void wholeNumberRetryLimitsUpToTheIntMaximumStillLoad() {
        assertThat(Scenario.fromMap(Map.of("id", "ok", "safeguards", Map.of("retryLimit", 2.0))).safeguards().retryLimit()).isEqualTo(2);
        assertThat(Scenario.fromMap(Map.of("id", "ok", "safeguards", Map.of("retryLimit", Integer.MAX_VALUE, "deadLetter", false)))
                .safeguards()).isEqualTo(new Scenario.Safeguards(Integer.MAX_VALUE, "exponential", false, false, false, false, false));
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
