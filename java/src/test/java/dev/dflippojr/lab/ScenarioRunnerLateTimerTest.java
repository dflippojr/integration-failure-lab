package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;

/**
 * A starved scheduler fires E1's emission timer after E2's, as on a busy machine. The run must still emit
 * and deliver in the order of the scenario's timeline, so a recording does not depend on the scheduler.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerLateTimerTest {

    /** Later than E2's emission at 40 ms, and well inside the read timeout. */
    static final long LATE_MS = 150;

    @Autowired
    ScenarioRunner runner;

    @Autowired
    ScenarioFiles files;

    @Test
    void aLateFirstTimerDoesNotReorderEmissions() throws Exception {
        Scenario scenario = files.load().stream().filter(s -> s.id().equals("5a-schema-change")).findFirst().orElseThrow();
        Map<String, Object> result = runner.run(scenario);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> trace = (List<Map<String, Object>>) result.get("trace");
        List<Object> emitted = trace.stream().filter(row -> "emit".equals(row.get("kind"))).map(row -> row.get("eventId")).toList();
        assertThat(emitted).as("trace: %s", trace).isEqualTo(List.of("E1", "E2", "E3"));
        assertThat(((Map<?, ?>) result.get("record")).get("applied")).isEqualTo(List.of("E1", "E2", "E3"));
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class LateTimerConfiguration {
        @Bean
        @Primary
        ScenarioRunner lateFirstTimerRunner(ClaimStore store, RunContext context, LabProperties props, Environment env) {
            return new ScenarioRunner(store, context, props, env) {
                @Override
                ScheduledExecutorService newDeliveryScheduler() {
                    AtomicInteger schedules = new AtomicInteger();
                    return new ScheduledThreadPoolExecutor(4) {
                        @Override
                        public ScheduledFuture<?> schedule(Runnable task, long delay, TimeUnit unit) {
                            // The first timer a run schedules is E1's emission.
                            long late = schedules.incrementAndGet() == 1 ? LATE_MS : 0;
                            return super.schedule(task, unit.toMillis(delay) + late, TimeUnit.MILLISECONDS);
                        }
                    };
                }
            };
        }
    }
}
