package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.test.annotation.DirtiesContext;

/**
 * A healthy E1 that takes longer than the emission gap to reach the store, as on a busy machine. Later
 * emissions must wait for it, so a recording's order does not depend on the scheduler.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "lab.timeout-ms=600")
@Import(ScenarioRunnerSlowArrivalTest.SlowStoreConfiguration.class)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerSlowArrivalTest {

    /** Longer than the 40 ms gap before E2 and shorter than the read timeout, so E1 still succeeds. */
    static final long HOLD_MS = 200;

    @Autowired
    ScenarioRunner runner;

    @Autowired
    ScenarioFiles files;

    @Autowired
    SlowClaimStore store;

    @Test
    void aSlowHealthyFirstEventIsNotOvertaken() throws Exception {
        // 1c: E1 and E2 are healthy; only E3 times out. Under load it was recorded Submitted with [E2, E1].
        Scenario scenario = files.load().stream().filter(s -> s.id().equals("1c-fire-and-forget")).findFirst().orElseThrow();
        Map<String, Object> result = runner.run(scenario);
        assertThat(store.overtaken).as("E2 or E3 reached the store while E1 was held; trace: %s", result.get("trace")).isFalse();
        assertThat(((Map<?, ?>) result.get("record")).get("applied")).isEqualTo(List.of("E1", "E2"));
        assertThat(((Map<?, ?>) result.get("record")).get("status")).isEqualTo("Accepted");
    }

    static class SlowClaimStore extends ClaimStore {
        /** The warm-up POST is the first E1; the scenario's E1 is the second. */
        private final AtomicInteger firsts = new AtomicInteger();
        private final CountDownLatch laterEntered = new CountDownLatch(1);
        private final AtomicBoolean holding = new AtomicBoolean();
        volatile boolean overtaken;

        @Override
        public Outcome receive(ClaimEvent event, Scenario.Safeguards guards, Trace trace, long runEpoch) {
            if (event.seq() == 1 && firsts.incrementAndGet() == 2) {
                holding.set(true);
                try {
                    overtaken = laterEntered.await(HOLD_MS, TimeUnit.MILLISECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted while holding E1", interrupted);
                } finally {
                    holding.set(false);
                }
            } else if (event.seq() > 1 && holding.get()) {
                laterEntered.countDown();
            }
            return super.receive(event, guards, trace, runEpoch);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class SlowStoreConfiguration {
        @Bean
        @Primary
        SlowClaimStore slowClaimStore() {
            return new SlowClaimStore();
        }
    }
}
