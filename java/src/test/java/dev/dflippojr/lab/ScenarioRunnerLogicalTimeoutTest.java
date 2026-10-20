package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;

/**
 * Logical timeouts, as the recordings export uses them: an injected delay past the read timeout is still a
 * timeout, and a request the machine holds past the transport bound fails the run instead of being
 * recorded as one.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"lab.timeout-ms=300", "lab.reorder-delay-ms=400"})
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerLogicalTimeoutTest {

    /** Short for the test; held timeout and lost-ack replies (2 x 300 ms) still come back well inside it. */
    static final Duration BOUND = Duration.ofSeconds(1);
    /** How long the armed store holds E1: past the bound. */
    static final long STALL_MS = 1500;

    static final AtomicBoolean ARMED = new AtomicBoolean();

    @Autowired
    ScenarioRunner runner;

    @Autowired
    ScenarioFiles files;

    @Test
    void aDelayPastTheReadTimeoutTimesOut() throws Exception {
        // 3a delays E2's first attempt, here by 400 ms against a 300 ms read timeout.
        Map<String, Object> result = runner.run(scenario("3a-out-of-order"), ScenarioRunner.Timeouts.LOGICAL);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> trace = (List<Map<String, Object>>) result.get("trace");
        List<String> e2 = trace.stream().filter(row -> "E2".equals(row.get("eventId")) && "queue".equals(row.get("actor")))
                .map(row -> row.get("kind") + " " + row.get("attempt")).toList();
        assertThat(e2).as("trace: %s", trace).containsSubsequence("send 1", "timeout 1", "retry-scheduled 1", "send 2");
    }

    @Test
    void aRequestPastTheTransportBoundFailsTheRun() throws Exception {
        ARMED.set(true);
        assertThatThrownBy(() -> runner.run(scenario("1a-transient-timeout"), ScenarioRunner.Timeouts.LOGICAL))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("no answer within the 1000 ms transport bound")
                .hasMessageContaining("not a timeout the scenario injects");
    }

    private Scenario scenario(String id) throws Exception {
        return files.load().stream().filter(s -> s.id().equals(id)).findFirst().orElseThrow();
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class BoundConfiguration {
        @Bean
        @Primary
        ScenarioRunner shortBoundRunner(ClaimStore store, RunContext context, LabProperties props, Environment env) {
            return new ScenarioRunner(store, context, props, env) {
                @Override
                Duration transportBound() {
                    return BOUND;
                }
            };
        }

        @Bean
        @Primary
        ClaimStore stallingStore(RunContext context) {
            return new ClaimStore() {
                @Override
                public Outcome receive(ClaimEvent event, Scenario.Safeguards guards, Trace trace, long runEpoch) {
                    boolean warmUp = context.current().scenario().id().equals("warm-up");
                    if (event.seq() == 1 && !warmUp && ARMED.compareAndSet(true, false)) {
                        try {
                            Thread.sleep(STALL_MS);
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException("Interrupted while stalling E1", interrupted);
                        }
                    }
                    return super.receive(event, guards, trace, runEpoch);
                }
            };
        }
    }
}
