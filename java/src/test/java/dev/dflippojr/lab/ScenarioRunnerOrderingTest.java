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

/** Reproduces a slow first event on the real HTTP path without relying on cold-start timing. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "lab.timeout-ms=2000")
@Import(ScenarioRunnerOrderingTest.GateConfiguration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerOrderingTest {

    @Autowired
    ScenarioRunner runner;

    @Autowired
    GatedClaimStore store;

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
                // E2 and E3 become due at 40/80 ms while E1 is held before application.
                overtaken = store.laterEntered.await(250, TimeUnit.MILLISECONDS);
            } finally {
                store.releaseFirst.countDown();
            }
            Map<String, Object> result = run.get(10, TimeUnit.SECONDS);
            assertThat(overtaken).as("later request arrived before E1 was released; trace: %s", result.get("trace")).isFalse();
            assertThat(((Map<?, ?>) result.get("record")).get("applied")).isEqualTo(List.of("E1", "E2", "E3"));
        }
    }

    static class GatedClaimStore extends ClaimStore {
        final CountDownLatch firstEntered = new CountDownLatch(1);
        final CountDownLatch releaseFirst = new CountDownLatch(1);
        final CountDownLatch laterEntered = new CountDownLatch(1);

        @Override
        public Outcome receive(ClaimEvent event, Scenario.Safeguards guards, Trace trace) {
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
            return super.receive(event, guards, trace);
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
