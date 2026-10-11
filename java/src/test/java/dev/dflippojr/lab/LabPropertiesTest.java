package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
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

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(LabProperties.class)
    static class BindingConfiguration {
    }
}
