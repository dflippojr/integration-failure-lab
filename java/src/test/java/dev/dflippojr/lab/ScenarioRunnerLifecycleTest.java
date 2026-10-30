package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.InstanceOfAssertFactories.THROWABLE;

import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import com.sun.net.httpserver.HttpServer;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.mock.env.MockEnvironment;

/** Each case must end well inside the 30 s scenario limit, so the class timeout proves none waits for it. */
@Timeout(15)
class ScenarioRunnerLifecycleTest {

    /** Keeps every emission queued so a failure path does not depend on HTTP or wall-clock races. */
    private static final List<Long> QUEUED = List.of(86_400_000L, 86_400_040L, 86_400_080L);
    /** Emits only E1, immediately. */
    private static final List<Long> FIRST_ONLY = List.of(0L, 86_400_000L, 86_400_040L);

    @Test
    void synchronousSchedulingFailureStopsWorkersAndQueuedEmissions() throws Exception {
        Harness harness = new Harness(QUEUED, 200) {
            @Override
            void onSchedule(int count, ScheduledThreadPoolExecutor scheduler) {
                if (count == 2) {
                    assertThat(scheduler.getQueue()).hasSize(1);
                    throw new RejectedExecutionException("injected setup failure");
                }
            }
        };
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(RejectedExecutionException.class).hasMessage("injected setup failure"));
        harness.assertStoppedBeforeAnyEmission();
    }

    /**
     * Covers the interrupt path. It does not guard the #53 regression: an InterruptedException from the
     * wait is a checked exception that cleanup always saw, unlike the setup failure above.
     */
    @Test
    void interruptedWaitStopsWorkersAndQueuedEmissions() throws Exception {
        Harness harness = new Harness(QUEUED, 200) {
            @Override
            void afterSchedule(int count) {
                if (count == 3) Thread.currentThread().interrupt();
            }
        };
        harness.run(run -> assertThatThrownBy(run).isInstanceOf(InterruptedException.class));
        harness.assertStoppedBeforeAnyEmission();
    }

    @Test
    void scenarioLimitStopsARunThatNeverSettles() throws Exception {
        Harness harness = new Harness(QUEUED, 200);
        harness.limit = Duration.ofMillis(50);
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Scenario lifecycle did not finish in 50 ms")
                .hasNoCause());
        harness.assertStoppedBeforeAnyEmission();
    }

    @Test
    void producerTaskFailureReachesTheCallerWithItsContext() throws Exception {
        // The first schedule from a worker is E1's producer task queueing its HTTP attempt.
        Harness harness = new Harness(FIRST_ONLY, 200).failWorkerSchedule(1);
        long start = System.nanoTime();
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageStartingWith("Scenario lifecycle: producer emission of E1 (ClaimSubmitted) failed")
                .rootCause().isInstanceOf(IllegalStateException.class).hasMessage("injected task failure"));
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
        harness.assertStopped();
    }

    @Test
    void anEmissionDueBeforeTheRunStartsStillRunsOnAWorker() throws Exception {
        // E1's timer fires, to no effect, while setup is still arming E3's: the timeline has not started yet.
        // Starting it must not run E1's emission on the setup thread, which would escape a worker's failure handling.
        CountDownLatch firstTimerRan = new CountDownLatch(1);
        Harness harness = new Harness(FIRST_ONLY, 200) {
            @Override
            void afterSchedule(int count) {
                if (count == 3) awaitFirstTimer();
            }

            @Override
            void afterTask(int count) {
                if (count == 1) firstTimerRan.countDown();
            }

            private void awaitFirstTimer() {
                try {
                    assertThat(firstTimerRan.await(10, TimeUnit.SECONDS)).as("E1's timer ran").isTrue();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }.failWorkerSchedule(1);
        harness.limit = Duration.ofSeconds(5);
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageStartingWith("Scenario lifecycle: producer emission of E1 (ClaimSubmitted) failed")
                .rootCause().isInstanceOf(IllegalStateException.class).hasMessage("injected task failure"));
        harness.assertStopped();
    }

    @Test
    void deliveryTaskFailureDuringRetryReachesTheCallerWithItsAttempt() throws Exception {
        // Every POST gets a retryable 500; the second worker schedule is the retry timer for attempt 1.
        Harness harness = new Harness(FIRST_ONLY, 500).failWorkerSchedule(2);
        long start = System.nanoTime();
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageStartingWith("Scenario lifecycle: delivery of E1 (ClaimSubmitted) attempt 1 failed")
                .rootCause().hasMessage("injected task failure"));
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
        harness.assertStopped();
    }

    @Test
    void workersThatDoNotStopFailTheRun() throws Exception {
        // Every event settles; only cleanup reports a worker still running.
        Harness harness = new Harness(List.of(0L, 40L, 80L), 200);
        harness.workersDoNotStop = true;
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("delivery workers did not stop")
                .hasNoSuppressedExceptions());
    }

    @Test
    void aRejectedWorkerScheduleWhileRunningFailsTheRun() throws Exception {
        // As in the retry case above, but the scheduler refuses the retry timer while it is still running.
        Harness harness = new Harness(FIRST_ONLY, 500)
                .failWorkerSchedule(2, new RejectedExecutionException("injected rejection"));
        harness.limit = Duration.ofSeconds(5);
        long start = System.nanoTime();
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageStartingWith("Scenario lifecycle: delivery of E1 (ClaimSubmitted) attempt 1 failed")
                .cause().isInstanceOf(RejectedExecutionException.class).hasMessage("injected rejection"));
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
        harness.assertStopped();
    }

    @Test
    void aLaterFailureIsSuppressedUnderTheFirst() throws Exception {
        Harness harness = new Harness(FIRST_ONLY, 500)
                .failWorkerSchedule(2, new RejectedExecutionException("injected rejection"));
        harness.limit = Duration.ofSeconds(5);
        harness.workersDoNotStop = true;
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageStartingWith("Scenario lifecycle: delivery of E1 (ClaimSubmitted) attempt 1 failed")
                .satisfies(failure -> assertThat(failure.getSuppressed()).singleElement(THROWABLE)
                        .isInstanceOf(IllegalStateException.class).hasMessage("delivery workers did not stop")));
    }

    @Test
    void aWorkerScheduleRejectedDuringShutdownIsIgnored() throws Exception {
        // E1's producer task stalls until the run gives up and shuts the scheduler down, then schedules its attempt.
        Harness harness = new Harness(FIRST_ONLY, 200) {
            @Override
            void onSchedule(int count, ScheduledThreadPoolExecutor scheduler) {
                if (Thread.currentThread() != worker.get()) return;
                boolean interrupted = false;
                while (!scheduler.isShutdown()) {
                    try {
                        Thread.sleep(10);
                    } catch (InterruptedException stopping) {
                        interrupted = true;
                    }
                }
                if (interrupted) Thread.currentThread().interrupt();
            }
        };
        harness.limit = Duration.ofMillis(200);
        harness.run(run -> assertThatThrownBy(run)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Scenario lifecycle did not finish in 200 ms")
                .hasNoSuppressedExceptions());
        assertThat(harness.rejected).as("the stalled task's schedule was refused").hasValue(1);
        harness.assertStopped();
    }

    /** A runner on a one-thread scheduler the test can observe, posting to a stub downstream. */
    private static class Harness {
        final AtomicReference<Thread> worker = new AtomicReference<>();
        final List<Long> sendAtMs;
        final int status;
        Duration limit = Duration.ofSeconds(30);
        int failingWorkerSchedule;
        RuntimeException injectedFailure;
        /** Makes the runner's wait for its workers to stop report that they did not, once. */
        boolean workersDoNotStop;
        /** Schedule calls the scheduler itself refused. */
        final AtomicInteger rejected = new AtomicInteger();
        final ScheduledThreadPoolExecutor scheduler;
        boolean terminatedByRunner;
        int queuedAfterRun = -1;
        long completedAfterRun = -1;

        Harness(List<Long> sendAtMs, int status) {
            this.sendAtMs = sendAtMs;
            this.status = status;
            AtomicInteger schedules = new AtomicInteger();
            AtomicInteger workerSchedules = new AtomicInteger();
            this.scheduler = new ScheduledThreadPoolExecutor(1, task -> {
                Thread thread = new Thread(task, "test-delivery-worker");
                worker.set(thread);
                return thread;
            }) {
                @Override
                public ScheduledFuture<?> schedule(Runnable task, long delay, TimeUnit unit) {
                    int count = schedules.incrementAndGet();
                    onSchedule(count, this);
                    if (Thread.currentThread() == worker.get() && !isShutdown()
                            && workerSchedules.incrementAndGet() == failingWorkerSchedule) {
                        throw injectedFailure;
                    }
                    ScheduledFuture<?> future;
                    try {
                        future = super.schedule(() -> {
                            try {
                                task.run();
                            } finally {
                                afterTask(count);
                            }
                        }, delay, unit);
                    } catch (RejectedExecutionException refused) {
                        rejected.incrementAndGet();
                        throw refused;
                    }
                    afterSchedule(count);
                    return future;
                }

                @Override
                public boolean awaitTermination(long timeout, TimeUnit unit) throws InterruptedException {
                    boolean terminated = super.awaitTermination(timeout, unit);
                    if (!workersDoNotStop) return terminated;
                    workersDoNotStop = false;
                    return false;
                }
            };
        }

        Harness failWorkerSchedule(int count) {
            return failWorkerSchedule(count, new IllegalStateException("injected task failure"));
        }

        Harness failWorkerSchedule(int count, RuntimeException failure) {
            failingWorkerSchedule = count;
            injectedFailure = failure;
            return this;
        }

        void onSchedule(int count, ScheduledThreadPoolExecutor scheduler) {
        }

        void afterSchedule(int count) {
        }

        /** The task of the {@code count}th schedule call has run. */
        void afterTask(int count) {
        }

        interface Expectation {
            void check(ThrowingCallable run);
        }

        void run(Expectation expectation) throws Exception {
            var serverExecutor = Executors.newSingleThreadExecutor();
            HttpServer server = null;
            try {
                server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                server.setExecutor(serverExecutor);
                // The warm-up POST must succeed, so only scenario deliveries see the stub's status.
                AtomicInteger posts = new AtomicInteger();
                server.createContext("/claims/", exchange -> {
                    try (exchange) {
                        exchange.getRequestBody().readAllBytes();
                        exchange.sendResponseHeaders(posts.getAndIncrement() == 0 ? 200 : status, -1);
                    }
                });
                server.start();
                LabProperties props = new LabProperties(null, null, 300, 150, sendAtMs, 200, 400, null, null, 0);
                MockEnvironment env = new MockEnvironment()
                        .withProperty("local.server.port", String.valueOf(server.getAddress().getPort()));
                ScenarioRunner runner = new ScenarioRunner(new ClaimStore(), new RunContext(), props, env) {
                    @Override
                    ScheduledExecutorService newDeliveryScheduler() {
                        return scheduler;
                    }

                    @Override
                    Duration scenarioLimit() {
                        return limit;
                    }
                };
                Scenario scenario = Scenario.fromMap(Map.of("id", "lifecycle"));
                try {
                    expectation.check(() -> runner.run(scenario));
                } finally {
                    Thread.interrupted();
                }
                // Capture before this harness's own cleanup can stop anything.
                terminatedByRunner = scheduler.isTerminated();
                queuedAfterRun = scheduler.getQueue().size();
                completedAfterRun = scheduler.getCompletedTaskCount();
            } finally {
                Thread.interrupted();
                scheduler.shutdownNow();
                if (server != null) server.stop(0);
                serverExecutor.shutdownNow();
                assertThat(scheduler.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
                assertThat(serverExecutor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            }
        }

        void assertStopped() throws InterruptedException {
            assertThat(worker.get()).as("delivery worker was created before failure").isNotNull();
            assertThat(terminatedByRunner).as("runner waits for delivery workers to stop").isTrue();
            worker.get().join(1_000);
            assertThat(worker.get().isAlive()).isFalse();
            assertThat(queuedAfterRun).as("pending emissions are removed").isZero();
        }

        void assertStoppedBeforeAnyEmission() throws InterruptedException {
            assertStopped();
            assertThat(completedAfterRun).as("no queued emission ran").isZero();
        }
    }
}
