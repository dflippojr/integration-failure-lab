package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class ScenarioTest {

    @Test
    void unsupportedBackoffFailsAtLoadWithTheScenarioAndAllowedValues() {
        // Before validation, this poison scenario hung until the 30 s limit once its first retry computed a backoff.
        Map<String, Object> json = Map.of(
                "id", "unknown-backoff",
                "failures", Map.of("poison", Map.of("event", "ClaimPaid")),
                "safeguards", Map.of("backoff", "bogus"));
        assertThatThrownBy(() -> Scenario.fromMap(json))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Scenario unknown-backoff: Unsupported safeguards.backoff \"bogus\"; expected one of none, fixed, exponential");
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

    @Test
    void missingBackoffIsRejectedWhenConstructedDirectly() {
        assertThatThrownBy(() -> new Scenario.Safeguards(3, null, false, false, false, true, false))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported safeguards.backoff \"null\"");
    }

    @ParameterizedTest
    @ValueSource(strings = {"none", "fixed", "exponential"})
    void supportedBackoffsLoad(String backoff) {
        Scenario scenario = Scenario.fromMap(Map.of("id", "ok", "safeguards", Map.of("backoff", backoff)));
        assertThat(scenario.safeguards().backoffMs(100, 2)).isNotNegative();
    }
}
