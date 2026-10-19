package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

/**
 * An out-of-order delay longer than the runner's five-second wait for downstream requests. The run that
 * gave up waiting fails, and its request, when it finally wakes, must not touch the next run's store.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"lab.timeout-ms=300", "lab.reorder-delay-ms=6000"})
class ScenarioRunnerCleanupTimeoutTest {

    @Autowired
    ScenarioRunner runner;

    @Test
    void aRequestOutlivingTheCleanupWaitDoesNotReachTheNextRun() throws Exception {
        assertThatThrownBy(() -> runner.run(ScenarioRunnerLateDelayTest.LATE))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("downstream requests did not finish");

        // Four attempts with backoff keep this run going past the moment the first run's E3 wakes up.
        ScenarioRunnerLateDelayTest.assertUntouched(runner.run(ScenarioRunnerLateDelayTest.stillRunning(3)));
    }
}
