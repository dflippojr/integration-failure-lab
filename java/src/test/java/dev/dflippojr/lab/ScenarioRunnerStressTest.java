package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;

/** Opt into a longer real-HTTP stress check with -Dlab.stress.runs=30 (one run in ordinary CI). */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerStressTest {

    @Autowired
    ScenarioFiles files;

    @Autowired
    ScenarioRunner runner;

    @Test
    void transientTimeoutKeepsInitialEventsInOrder() throws Exception {
        Scenario scenario = files.load().stream().filter(s -> s.id().equals("1a-transient-timeout")).findFirst().orElseThrow();
        int runs = Integer.getInteger("lab.stress.runs", 1);
        assertThat(runs).as("stress runs").isPositive();
        for (int i = 1; i <= runs; i++) {
            Map<String, Object> result = runner.run(scenario);
            Map<?, ?> record = (Map<?, ?>) result.get("record");
            assertThat(record.get("applied")).as("run %s, trace: %s", i, result.get("trace"))
                    .isEqualTo(List.of("E1", "E2", "E3"));
            assertThat(record.get("status")).isEqualTo("Paid");
            assertThat(((Number) record.get("paidCents")).longValue()).isEqualTo(12000);
            assertThat((List<?>) result.get("dlq")).isEmpty();
            assertThat((List<?>) result.get("dropped")).isEmpty();
        }
        System.out.printf("1a-transient-timeout: %d/%d real-HTTP runs passed%n", runs, runs);
    }
}
