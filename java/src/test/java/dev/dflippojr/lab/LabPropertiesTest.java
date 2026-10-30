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
            assertThat(properties.timeoutMs()).isEqualTo(300);
            assertThat(properties.backoffBaseMs()).isEqualTo(150);
            assertThat(properties.sendAtMs()).containsExactly(0L, 40L, 80L);
            assertThat(properties.reorderDelayMs()).isEqualTo(200);
            assertThat(properties.replayDelayMs()).isEqualTo(400);
            assertThat(properties.exportDir()).isNull();
        });
    }

    @Test
    void explicitPropertiesOverrideEveryDefaultAndBindExportDirectory() {
        contextRunner.withPropertyValues(
                "lab.scenarios-dir=custom-scenarios",
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
                .isThrownBy(() -> new LabProperties(null, null, 0, 0, times, 0, 0, null, null, 0))
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
        assertThat(new LabProperties(null, null, 0, 0, List.of(), 0, 0, null, null, 0).sendAtMs())
                .containsExactly(0L, 40L, 80L);
        List<Long> times = new ArrayList<>(List.of(10L, 50L, 90L));
        LabProperties properties = new LabProperties(null, null, 0, 0, times, 0, 0, null, null, 0);
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
                .isThrownBy(() -> new LabProperties(null, null, 0, 0, null, 0, 0, "in.json", null, 0))
                .withMessageContaining("must be set together");
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new LabProperties(null, "export", 0, 0, null, 0, 0, "in.json", "out.json", 0))
                .withMessageContaining("set one");
        assertThat(new LabProperties(null, null, 0, 0, null, 0, 0, null, null, 0).differentialWorkers()).isEqualTo(1);
    }

    // scripts/differential.mjs parseOptions caps --workers at 4 too: each worker starts its own Spring context and port.
    @ParameterizedTest
    @ValueSource(ints = {-1, 5})
    void differentialWorkersOutsideOneToFourFailAtConstruction(int workers) {
        assertThatIllegalArgumentException()
                .isThrownBy(() -> new LabProperties(null, null, 0, 0, null, 0, 0, null, null, workers))
                .withMessage("lab.differential-workers must be between 1 and 4");
    }

    @ParameterizedTest
    @ValueSource(ints = {1, 4})
    void differentialWorkersFromOneToFourAreKept(int workers) {
        assertThat(new LabProperties(null, null, 0, 0, null, 0, 0, null, null, workers).differentialWorkers()).isEqualTo(workers);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(LabProperties.class)
    static class BindingConfiguration {
    }
}
