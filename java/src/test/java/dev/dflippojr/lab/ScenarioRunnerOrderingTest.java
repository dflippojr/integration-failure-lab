package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.test.annotation.DirtiesContext;

/** Holds the first warm-up POST beyond the scenario timeout, without relying on cold-start timing. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(ScenarioRunnerOrderingTest.GateConfiguration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerOrderingTest {

    @Autowired
    ScenarioRunner runner;

    @Autowired
    GatedClaimStore store;

    @Autowired
    LabProperties props;

    @Test
    void laterInitialEventsCannotOvertakeASlowFirstRequest() throws Exception {
        Scenario scenario = new Scenario("slow-first-request", 0, "Slow first request",
                new Scenario.Failures(null, Set.of(), false, null, null, null, null),
                new Scenario.Safeguards(3, "exponential", false, false, false, true, false), Map.of());
        try (var executor = Executors.newSingleThreadExecutor()) {
            var run = executor.submit(() -> runner.run(scenario));
            boolean overtaken;
            try {
                assertThat(store.firstEntered.await(5, TimeUnit.SECONDS)).as("E1 reached the downstream").isTrue();
                // Hold setup past the scenario timeout; emissions must wait for its completion.
                overtaken = store.laterEntered.await(props.timeoutMs() * 2, TimeUnit.MILLISECONDS);
            } finally {
                store.releaseFirst.countDown();
            }
            Map<String, Object> result = run.get(10, TimeUnit.SECONDS);
            assertThat(overtaken).as("later request arrived before E1 was released; trace: %s", result.get("trace")).isFalse();
            assertThat(((Map<?, ?>) result.get("record")).get("applied")).isEqualTo(List.of("E1", "E2", "E3"));
            assertThat(((Number) result.get("warmupMs")).longValue()).isGreaterThan(props.timeoutMs());
            System.out.printf("Cold POST warm-up: %s ms (scenario timeout: %s ms)%n",
                    result.get("warmupMs"), props.timeoutMs());
            assertThat(((List<?>) result.get("trace")).size()).isEqualTo(12);
        }
    }

    static class GatedClaimStore extends ClaimStore {
        final CountDownLatch firstEntered = new CountDownLatch(1);
        final CountDownLatch releaseFirst = new CountDownLatch(1);
        final CountDownLatch laterEntered = new CountDownLatch(1);

        @Override
        public Outcome receive(ClaimEvent event, Scenario.Safeguards guards, Trace trace, long runEpoch) {
            if (event.seq() == 1) {
                firstEntered.countDown();
                try {
                    if (!releaseFirst.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Test did not release E1");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted while holding E1", interrupted);
                }
            } else {
                laterEntered.countDown();
            }
            return super.receive(event, guards, trace, runEpoch);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class GateConfiguration {
        @Bean
        @Primary
        GatedClaimStore gatedClaimStore() {
            return new GatedClaimStore();
        }
    }
}
