package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import jakarta.servlet.Filter;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.test.annotation.DirtiesContext;

/**
 * A request held up before it reaches the controller, as by a slow network or a busy server: its sender
 * times out and its run ends without ever counting it. When it finally arrives during the next run, it
 * must be recognized as the earlier run's, and must not reach the next run's store or trace.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "lab.timeout-ms=300")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ScenarioRunnerQueuedRequestTest {

    /** No injected faults; the gate below holds ClaimPaid past the read timeout, and it is dead-lettered. */
    static final Scenario QUEUED = new Scenario("queued", 0, "ClaimPaid held before the handler",
            new Scenario.Failures(null, Set.of(), false, null, null, null, null),
            new Scenario.Safeguards(0, "exponential", false, false, false, true, false), Map.of());

    static final AtomicBoolean ARMED = new AtomicBoolean();
    static final CountDownLatch HELD = new CountDownLatch(1);
    static final CountDownLatch RELEASE = new CountDownLatch(1);

    @TestConfiguration
    static class Gate {
        /** Holds the first ClaimPaid POST after the gate is armed until the test releases it. */
        @Bean
        Filter holdClaimPaid() {
            return (request, response, chain) -> {
                HttpServletRequest http = (HttpServletRequest) request;
                if (!"POST".equals(http.getMethod())) {
                    chain.doFilter(request, response);
                    return;
                }
                Buffered buffered = new Buffered(http);
                if (buffered.body.contains("\"ClaimPaid\"") && ARMED.compareAndSet(true, false)) {
                    HELD.countDown();
                    try {
                        RELEASE.await(20, TimeUnit.SECONDS);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
                chain.doFilter(buffered, response);
            };
        }
    }

    @Autowired
    ScenarioRunner runner;

    @Autowired
    RunContext context;

    @Test
    void aRequestQueuedBeforeTheHandlerDoesNotReachTheNextRun() throws Exception {
        ARMED.set(true);
        Map<String, Object> first = runner.run(QUEUED);
        assertThat(HELD.getCount()).as("the gate held ClaimPaid").isZero();
        assertThat(ScenarioRunnerLateDelayTest.record(first).get("applied")).isEqualTo(List.of("E1", "E2"));

        AtomicReference<Object> outcome = new AtomicReference<>();
        Thread second = new Thread(() -> {
            try {
                outcome.set(runner.run(ScenarioRunnerLateDelayTest.stillRunning(2)));
            } catch (Exception | Error failure) {
                outcome.set(failure);
            }
        });
        second.start();
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!context.current().scenario().id().equals("still-running")) {
            assertThat(System.nanoTime()).as("the second run began").isLessThan(deadline);
            Thread.sleep(5);
        }
        RELEASE.countDown();
        second.join(20_000);

        assertThat(outcome.get()).isInstanceOf(Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) outcome.get();
        ScenarioRunnerLateDelayTest.assertUntouched(result);
        List<?> acks = ((List<?>) result.get("trace")).stream()
                .map(row -> (Map<?, ?>) row)
                .filter(row -> "downstream".equals(row.get("actor")) && String.valueOf(row.get("kind")).startsWith("ack"))
                .toList();
        assertThat(acks).as("downstream acks in the second run").hasSize(2);
    }

    /** The request with its body read up front, so the gate can look at it and the controller can still read it. */
    static final class Buffered extends HttpServletRequestWrapper {
        final String body;
        private final byte[] bytes;

        Buffered(HttpServletRequest request) throws IOException {
            super(request);
            bytes = request.getInputStream().readAllBytes();
            body = new String(bytes, StandardCharsets.UTF_8);
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream in = new ByteArrayInputStream(bytes);
            return new ServletInputStream() {
                @Override
                public int read() {
                    return in.read();
                }

                @Override
                public boolean isFinished() {
                    return in.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {
                    throw new UnsupportedOperationException();
                }
            };
        }
    }
}
