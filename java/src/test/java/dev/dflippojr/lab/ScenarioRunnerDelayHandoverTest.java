package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;

/**
 * The downstream thread that waits out an out-of-order delay stalls right after the timeline stops waiting
 * for its request, as a busy machine can stall any thread. E2 is delayed to 240 ms on the timeline and E1
 * times out at 300 ms, so the end of E2's delay must run first. Whatever the stall does, the run must
 * be the one an unstalled machine gives.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerDelayHandoverTest {

    /** How long the stall may last at most; it ends as soon as the timeline has shown what it does without the thread. */
    static final long STALL_LIMIT_SECONDS = 10;

    static final AtomicBoolean stalling = new AtomicBoolean();
    static volatile String outcome;

    @Autowired
    ScenarioRunner runner;

    @ParameterizedTest
    @EnumSource(ScenarioRunner.Timeouts.class)
    void aStalledDelayDoesNotLetTheTimelinePassItsEnd(ScenarioRunner.Timeouts timeouts) throws Exception {
        Scenario scenario = Scenario.fromMap(Map.of("id", "delay-and-timeout",
                "failures", Map.of("timeout", Map.of("event", "ClaimSubmitted", "attempts", List.of(1)),
                        "reorder", Map.of("event", "ClaimAccepted", "delayMs", 500)),
                "safeguards", Map.of("retryLimit", 3, "backoff", "exponential", "idempotency", true,
                        "ordering", true, "deadLetter", true)));

        stalling.set(false);
        Object unstalled = RecordingBehaviour.of(runner.run(scenario, timeouts));
        outcome = null;
        stalling.set(true);
        Object stalled = RecordingBehaviour.of(runner.run(scenario, timeouts));

        assertThat(outcome).as("the delay was handed over and the thread stalled").isNotNull();
        assertThat(stalled).as("%s timeouts, delay stalled (%s)", timeouts, outcome).isEqualTo(unstalled);
    }

    /**
     * Stalls the first thread that hands a delay over until the timeline has shown what it does without it: it
     * ended the delay (release is done), or it timed E1 out, which is due after the end of E2's delay.
     */
    static final class StallingScheduler extends ScheduledThreadPoolExecutor {
        private final Trace trace;
        private final Object lock = new Object();

        StallingScheduler(Trace trace) {
            super(4);
            this.trace = trace;
        }

        @Override
        public ScheduledFuture<?> schedule(Runnable task, long delay, TimeUnit unit) {
            return super.schedule(() -> {
                try {
                    task.run();
                } finally {
                    changed();
                }
            }, delay, unit);
        }

        void changed() {
            synchronized (lock) {
                lock.notifyAll();
            }
        }

        void stall(CompletableFuture<Boolean> release) {
            release.thenRun(this::changed);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(STALL_LIMIT_SECONDS);
            synchronized (lock) {
                while (true) {
                    if (release.isDone()) {
                        outcome = "the timeline ended the delay";
                        return;
                    }
                    if (trace.rows().stream().anyMatch(row -> "timeout".equals(row.get("kind")) && "E1".equals(row.get("eventId")))) {
                        outcome = "E1 timed out before the delay ended";
                        return;
                    }
                    long left = deadline - System.nanoTime();
                    if (left <= 0) throw new IllegalStateException("the stall never ended; trace: " + trace.rows());
                    try {
                        TimeUnit.NANOSECONDS.timedWait(lock, left);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("Interrupted while stalling", interrupted);
                    }
                }
            }
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class StalledDelayConfiguration {
        @Bean
        @Primary
        ScenarioRunner stalledDelayRunner(ClaimStore store, RunContext context, LabProperties props, Environment env) {
            return new ScenarioRunner(store, context, props, env) {
                private volatile StallingScheduler scheduler;

                @Override
                ScheduledExecutorService newDeliveryScheduler() {
                    scheduler = new StallingScheduler(context.current().trace());
                    return scheduler;
                }

                @Override
                void delayHandedOver(long send, CompletableFuture<Boolean> release) {
                    if (stalling.compareAndSet(true, false)) scheduler.stall(release);
                }
            };
        }
    }
}
