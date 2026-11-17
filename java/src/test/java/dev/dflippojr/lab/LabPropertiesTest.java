package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

class LabPropertiesTest {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner()
            .withUserConfiguration(BindingConfiguration.class);

    @Test
    void omittedPropertiesUseConstructorDefaults() {
        contextRunner.run(context -> {
            assertThat(context).hasNotFailed();
            LabProperties properties = context.getBean(LabProperties.class);
            assertThat(properties.scenariosDir()).isEqualTo("../scenarios");
            // One timing model (#197): the engine's TIMING at a quarter of its length, Math.round(engine value x 0.25).
            assertThat(properties.timeScale()).isEqualTo(0.25);
            assertThat(properties.timeoutMs()).isEqualTo(500);
            assertThat(properties.backoffBaseMs()).isEqualTo(250);
            assertThat(properties.sendAtMs()).containsExactly(0L, 25L, 50L);
            assertThat(properties.reorderDelayMs()).isEqualTo(125);
            assertThat(properties.replayDelayMs()).isEqualTo(1250);
            assertThat(properties.exportDir()).isNull();
        });
    }

    @Test
    void defaultTimingsAreTheEngineTimingsAtTheDefaultScale() {
        LabProperties properties = new LabProperties(null, null, null, 0, 0, null, 0, 0, null, null, 0);
        assertThat(properties.timeoutMs()).isEqualTo(Math.round(LabProperties.ENGINE_TIMEOUT_MS * LabProperties.DEFAULT_TIME_SCALE));
        assertThat(properties.backoffBaseMs()).isEqualTo(Math.round(LabProperties.ENGINE_BACKOFF_BASE_MS * LabProperties.DEFAULT_TIME_SCALE));
        assertThat(properties.sendAtMs()).isEqualTo(LabProperties.ENGINE_SEND_AT_MS.stream()
                .map(time -> Math.round(time * LabProperties.DEFAULT_TIME_SCALE)).toList());
        assertThat(properties.reorderDelayMs()).isEqualTo(Math.round(LabProperties.ENGINE_REORDER_DELAY_MS * LabProperties.DEFAULT_TIME_SCALE));
        assertThat(properties.replayDelayMs()).isEqualTo(Math.round(LabProperties.ENGINE_REPLAY_DELAY_MS * LabProperties.DEFAULT_TIME_SCALE));
        // Scenario refuses any reorder delay but the engine's, which the runner then plays at the scale.
        assertThat((long) Scenario.REORDER_DELAY_MS).isEqualTo(LabProperties.ENGINE_REORDER_DELAY_MS);
    }

    @Test
    void timeScaleScalesEveryDefaultTimingAndRoundsHalfUp() {
        contextRunner.withPropertyValues("lab.time-scale=0.5").run(context -> {
            assertThat(context).hasNotFailed();
            LabProperties properties = context.getBean(LabProperties.class);
            assertThat(properties.timeScale()).isEqualTo(0.5);
            assertThat(properties.timeoutMs()).isEqualTo(1000);
            assertThat(properties.backoffBaseMs()).isEqualTo(500);
            assertThat(properties.sendAtMs()).containsExactly(0L, 50L, 100L);
            assertThat(properties.reorderDelayMs()).isEqualTo(250);
            assertThat(properties.replayDelayMs()).isEqualTo(2500);
        });
        // The smallest scale: E2's 100 ms send time is 0.5 ms, which rounds up to 1, as the engine's Math.round does.
        LabProperties smallest = new LabProperties(null, null, LabProperties.MIN_TIME_SCALE, 0, 0, null, 0, 0, null, null, 0);
        assertThat(smallest.timeScale()).isEqualTo(0.005);
        assertThat(smallest.sendAtMs()).containsExactly(0L, 1L, 1L);
        assertThat(smallest.timeoutMs()).isEqualTo(10);
    }

    @Test
    void explicitTimingsWinOverTheScaledDefaults() {
        contextRunner.withPropertyValues("lab.time-scale=0.5", "lab.timeout-ms=300", "lab.reorder-delay-ms=400").run(context -> {
            assertThat(context).hasNotFailed();
            LabProperties properties = context.getBean(LabProperties.class);
            assertThat(properties.timeoutMs()).isEqualTo(300);
            assertThat(properties.reorderDelayMs()).isEqualTo(400);
            assertThat(properties.backoffBaseMs()).isEqualTo(500);
            assertThat(properties.replayDelayMs()).isEqualTo(2500);
        });
    }

    // An explicit zero is a scale that rounds every timing to 0, not an omitted property (#202 review).
    @ParameterizedTest
    @ValueSource(strings = {"0", "0.0", "-1"})
    void anExplicitZeroOrNegativeTimeScaleFailsWithConfigurationDiagnostics(String scale) {
        contextRunner.withPropertyValues("lab.time-scale=" + scale).run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseInstanceOf(IllegalArgumentException.class)
                    .hasStackTraceContaining("lab.time-scale must be a finite number of at least 0.005");
        });
    }

    @ParameterizedTest
    @ValueSource(doubles = {-0.25, 0.004, Double.NaN, Double.POSITIVE_INFINITY})
    void aTimeScaleThatCannotKeepEveryTimingAboveZeroFailsAtConstruction(double scale) {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new LabProperties(null, null, scale, 0, 0, null, 0, 0, null, null, 0))
                .withMessageStartingWith("lab.time-scale must be a finite number of at least 0.005")
                .withMessageEndingWith("got " + scale);
    }

    @Test
    void explicitPropertiesOverrideEveryDefaultAndBindExportDirectory() {
        contextRunner.withPropertyValues(
                "lab.scenarios-dir=custom-scenarios",
                "lab.time-scale=0.5",
                "lab.timeout-ms=600",
                "lab.backoff-base-ms=250",
                "lab.send-at-ms=10,50,90",
                "lab.reorder-delay-ms=350",
                "lab.replay-delay-ms=700",
                "lab.export-dir=custom-export")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    LabProperties properties = context.getBean(LabProperties.class);
                    assertThat(properties.scenariosDir()).isEqualTo("custom-scenarios");
                    assertThat(properties.timeScale()).isEqualTo(0.5);
                    assertThat(properties.timeoutMs()).isEqualTo(600);
                    assertThat(properties.backoffBaseMs()).isEqualTo(250);
                    assertThat(properties.sendAtMs()).containsExactly(10L, 50L, 90L);
                    assertThat(properties.reorderDelayMs()).isEqualTo(350);
                    assertThat(properties.replayDelayMs()).isEqualTo(700);
                    assertThat(properties.exportDir()).isEqualTo("custom-export");
                });
    }

    @ParameterizedTest
    @MethodSource("invalidOverrides")
    void incompleteOrNullEmissionTimesFailAtConstruction(List<Long> times) {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new LabProperties(null, null, null, 0, 0, times, 0, 0, null, null, 0))
                .withMessageContaining("lab.send-at-ms")
                .withMessageContaining("exactly three non-null emission times");
    }

    static Stream<List<Long>> invalidOverrides() {
        return Stream.of(List.of(0L), List.of(0L, 40L), List.of(0L, 40L, 80L, 120L),
                Arrays.asList(0L, null, 80L));
    }

    @Test
    void incompleteBoundOverrideFailsWithConfigurationDiagnostics() {
        contextRunner.withPropertyValues("lab.send-at-ms=0,40").run(context -> {
            assertThat(context).hasFailed();
            assertThat(context.getStartupFailure()).hasRootCauseInstanceOf(IllegalArgumentException.class)
                    .hasStackTraceContaining("lab.send-at-ms must contain exactly three");
        });
    }

    @Test
    void emptyOverrideUsesDefaultsAndValidOverrideIsCopied() {
        assertThat(new LabProperties(null, null, null, 0, 0, List.of(), 0, 0, null, null, 0).sendAtMs())
                .containsExactly(0L, 25L, 50L);
        List<Long> times = new ArrayList<>(List.of(10L, 50L, 90L));
        LabProperties properties = new LabProperties(null, null, null, 0, 0, times, 0, 0, null, null, 0);
        times.clear();
        assertThat(properties.sendAtMs()).containsExactly(10L, 50L, 90L);
    }

    @Test
    void differentialFilesBindTogetherAndExcludeTheExport() {
        contextRunner.withPropertyValues("lab.differential-in=in.json", "lab.differential-out=out.json").run(context -> {
            assertThat(context).hasNotFailed();
            LabProperties properties = context.getBean(LabProperties.class);
            assertThat(properties.differentialIn()).isEqualTo("in.json");
            assertThat(properties.differentialOut()).isEqualTo("out.json");
        });
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new LabProperties(null, null, null, 0, 0, null, 0, 0, "in.json", null, 0))
                .withMessageContaining("must be set together");
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new LabProperties(null, "export", null, 0, 0, null, 0, 0, "in.json", "out.json", 0))
                .withMessageContaining("set one");
        assertThat(new LabProperties(null, null, null, 0, 0, null, 0, 0, null, null, 0).differentialWorkers()).isEqualTo(1);
    }

    // scripts/differential.mjs parseOptions caps --workers at 4 too: each worker starts its own Spring context and port.
    @ParameterizedTest
    @ValueSource(ints = {-1, 5})
    void differentialWorkersOutsideOneToFourFailAtConstruction(int workers) {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new LabProperties(null, null, null, 0, 0, null, 0, 0, null, null, workers))
                .withMessage("lab.differential-workers must be between 1 and 4");
    }

    @ParameterizedTest
    @ValueSource(ints = {1, 4})
    void differentialWorkersFromOneToFourAreKept(int workers) {
        assertThat(new LabProperties(null, null, null, 0, 0, null, 0, 0, null, null, workers).differentialWorkers()).isEqualTo(workers);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(LabProperties.class)
    static class BindingConfiguration {
    }
}
