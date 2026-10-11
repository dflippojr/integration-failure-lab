package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.InetSocketAddress;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.mock.env.MockEnvironment;

@Timeout(15)
class ScenarioRunnerLifecycleTest {

    @Test
    void synchronousSchedulingFailureStopsWorkersAndQueuedEmissions() throws Exception {
        exerciseCleanup(true);
    }

    @Test
    void interruptedWaitStopsWorkersAndQueuedEmissions() throws Exception {
        exerciseCleanup(false);
    }

    private static void exerciseCleanup(boolean rejectSetup) throws Exception {
        AtomicReference<Thread> worker = new AtomicReference<>();
        ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(1, task -> {
            Thread thread = new Thread(task, "test-delivery-worker");
            worker.set(thread);
            return thread;
        }) {
            private int schedules;

            @Override
            public ScheduledFuture<?> schedule(Runnable task, long delay, TimeUnit unit) {
                schedules++;
                if (rejectSetup && schedules == 2) {
                    assertThat(getQueue()).hasSize(1);
                    throw new RejectedExecutionException("injected setup failure");
                }
                ScheduledFuture<?> future = super.schedule(task, delay, unit);
                if (!rejectSetup && schedules == 3) Thread.currentThread().interrupt();
                return future;
            }
        };
        var serverExecutor = Executors.newSingleThreadExecutor();
        HttpServer server = null;
        try {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(serverExecutor);
            server.createContext("/claims/", exchange -> {
                try (exchange) {
                    exchange.getRequestBody().readAllBytes();
                    exchange.sendResponseHeaders(200, -1);
                }
            });
            server.start();
            // Keep emissions queued so neither failure path depends on HTTP or wall-clock races.
            LabProperties props = new LabProperties(null, null, 300, 150,
                    List.of(86_400_000L, 86_400_040L, 86_400_080L), 200, 400);
            MockEnvironment env = new MockEnvironment()
                    .withProperty("local.server.port", String.valueOf(server.getAddress().getPort()));
            ScenarioRunner runner = new ScenarioRunner(new ClaimStore(), new RunContext(), props, env) {
                @Override
                ScheduledExecutorService newDeliveryScheduler() {
                    return scheduler;
                }
            };
            Scenario scenario = Scenario.fromMap(Map.of("id", "setup-failure"));
            try {
                if (rejectSetup) {
                    assertThatThrownBy(() -> runner.run(scenario))
                            .isInstanceOf(RejectedExecutionException.class).hasMessage("injected setup failure");
                } else {
                    assertThatThrownBy(() -> runner.run(scenario)).isInstanceOf(InterruptedException.class);
                }
            } finally {
                Thread.interrupted();
            }
            assertThat(worker.get()).as("delivery worker was created before failure").isNotNull();
            assertThat(scheduler.isShutdown()).as("runner shuts down on failure").isTrue();
            assertThat(scheduler.awaitTermination(5, TimeUnit.SECONDS)).as("delivery workers terminate").isTrue();
            worker.get().join(1_000);
            assertThat(worker.get().isAlive()).isFalse();
            assertThat(scheduler.getQueue()).as("pending emissions are removed").isEmpty();
            assertThat(scheduler.getCompletedTaskCount()).as("no queued emission ran").isZero();
        } finally {
            Thread.interrupted();
            scheduler.shutdownNow();
            if (server != null) server.stop(0);
            serverExecutor.shutdownNow();
            assertThat(scheduler.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
            assertThat(serverExecutor.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }
}
