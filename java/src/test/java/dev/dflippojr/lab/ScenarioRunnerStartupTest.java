package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.File;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.core.env.Environment;
import org.springframework.test.annotation.DirtiesContext;

import tools.jackson.databind.ObjectMapper;

/**
 * The thread that sets a run up stalls right after it arms E2's 40 ms emission and before it adds E3's, as a
 * busy machine can stall any thread. The 0 ms and 40 ms emission timers still fire. Nothing may run until
 * every emission is on the timeline: in 4-combined, E3's emission at 80 ms comes before E2's timeout at
 * 340 ms, so the export must still be the committed recording, apart from wall-clock timing.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerStartupTest {

    /** How long the stall may last at most; it normally ends within the 40 ms before E2's emission. */
    static final long STALL_LIMIT_SECONDS = 10;

    @Autowired
    ScenarioRunner runner;

    @Autowired
    ScenarioFiles files;

    @Autowired
    ObjectMapper json;

    @Test
    void aStalledSetupDoesNotLetTheTimelineRunAhead(@TempDir Path out) throws Exception {
        Scenario scenario = files.load().stream().filter(s -> s.id().equals("4-combined")).findFirst().orElseThrow();
        files.write(out, "4-combined.json", runner.run(scenario, ScenarioRunner.Timeouts.LOGICAL));

        assertThat(StallingScheduler.outcome).isNotNull();
        assertThat(behaviour(out.resolve("4-combined.json").toFile()))
                .as("4-combined exported while setup stalled (%s)", StallingScheduler.outcome)
                .isEqualTo(behaviour(Path.of("..", "executed", "4-combined.json").toFile()));
    }

    /** What the recordings check compares (scripts/recordings.mjs): everything but wall-clock fields. */
    private Object behaviour(File file) {
        Map<Object, Object> rest = new LinkedHashMap<>((Map<?, ?>) json.readValue(file, Object.class));
        rest.keySet().removeAll(Set.of("generatedAt", "warmupMs", "runtime"));
        rest.computeIfPresent("trace", (k, trace) -> ((List<?>) trace).stream().map(row -> {
            Map<Object, Object> copy = new LinkedHashMap<>((Map<?, ?>) row);
            copy.remove("t");
            return copy;
        }).toList());
        return rest;
    }

    /**
     * Stalls the setup thread, the one that creates the scheduler, after its second timer: E2's emission.
     * It resumes once the delivery workers have done all they can without E3, that is, once E2 has timed
     * out, or once both armed emission timers have fired and emitted nothing.
     */
    static final class StallingScheduler extends ScheduledThreadPoolExecutor {
        static volatile String outcome;

        private final Thread setup = Thread.currentThread();
        private final Trace trace;
        private final Object lock = new Object();
        private int setupTimers;
        /** Setup timers that have fired and returned. Guarded by {@code lock}. */
        private int fired;

        StallingScheduler(Trace trace) {
            super(4);
            this.trace = trace;
        }

        @Override
        public ScheduledFuture<?> schedule(Runnable task, long delay, TimeUnit unit) {
            boolean fromSetup = Thread.currentThread() == setup;
            ScheduledFuture<?> future = super.schedule(() -> {
                try {
                    task.run();
                } finally {
                    synchronized (lock) {
                        if (fromSetup) fired++;
                        lock.notifyAll();
                    }
                }
            }, delay, unit);
            if (fromSetup && ++setupTimers == 2) stall();
            return future;
        }

        private void stall() {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(STALL_LIMIT_SECONDS);
            synchronized (lock) {
                while (true) {
                    if (logged("timeout", "E2")) {
                        outcome = "E2 timed out before E3 was on the timeline";
                        return;
                    }
                    if (fired == 2 && !logged("emit", null)) {
                        outcome = "nothing ran before E3 was on the timeline";
                        return;
                    }
                    long left = deadline - System.nanoTime();
                    if (left <= 0) throw new IllegalStateException("the stall never ended; trace: " + trace.rows());
                    try {
                        TimeUnit.NANOSECONDS.timedWait(lock, left);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException("Interrupted while stalling setup", interrupted);
                    }
                }
            }
        }

        private boolean logged(String kind, String eventId) {
            return trace.rows().stream().anyMatch(row -> kind.equals(row.get("kind"))
                    && (eventId == null || eventId.equals(row.get("eventId"))));
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class StalledSetupConfiguration {
        @Bean
        @Primary
        ScenarioRunner stalledSetupRunner(ClaimStore store, RunContext context, LabProperties props, Environment env) {
            return new ScenarioRunner(store, context, props, env) {
                @Override
                ScheduledExecutorService newDeliveryScheduler() {
                    return new StallingScheduler(context.current().trace());
                }
            };
        }
    }
}
