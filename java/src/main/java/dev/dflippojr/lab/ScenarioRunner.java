package dev.dflippojr.lab;

import java.net.http.HttpClient;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import org.springframework.boot.SpringBootVersion;
import org.springframework.core.env.Environment;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Runs one scenario end to end over real HTTP: a producer emits three events, an at-least-once
 * delivery queue posts them to {@link ClaimStatusController} with read timeouts, retries with
 * backoff, and dead-letters what it gives up on. Runs are serialized.
 */
@Component
public class ScenarioRunner {

    private final ClaimStore store;
    private final RunContext context;
    private final LabProperties props;
    private final Environment env;

    public ScenarioRunner(ClaimStore store, RunContext context, LabProperties props, Environment env) {
        this.store = store;
        this.context = context;
        this.props = props;
        this.env = env;
    }

    public synchronized Map<String, Object> run(Scenario scenario) throws InterruptedException {
        try (HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1))
                .version(HttpClient.Version.HTTP_1_1).build()) {
            return run(scenario, http);
        }
    }

    private Map<String, Object> run(Scenario scenario, HttpClient http) throws InterruptedException {
        // Exercise the event endpoint's JSON binding and header conversion before the scenario
        // clock starts. A health GET does not initialize this path. No injected faults apply here.
        context.begin(Scenario.fromMap(Map.of("id", "warm-up")), new Trace());
        store.reset();
        long warmupStart = System.nanoTime();
        postEvent(client(http, Duration.ofSeconds(10)), ClaimEvent.sequence().getFirst(), 1);
        long warmupMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - warmupStart);
        RestClient client = client(http, Duration.ofMillis(props.timeoutMs()));

        Trace trace = new Trace();
        store.reset();
        context.begin(scenario, trace);

        ScheduledExecutorService scheduler = newDeliveryScheduler();
        Delivery delivery;
        boolean finished;
        try {
            delivery = new Delivery(client, scenario, trace, scheduler);
            List<ClaimEvent> events = ClaimEvent.sequence();
            events.forEach(e -> delivery.originals.put(e.eventId(), e));
            for (int i = 0; i < events.size(); i++) {
                ClaimEvent event = producerPayload(events.get(i), scenario.failures());
                scheduler.schedule(() -> {
                    trace.log("producer", "emit", event, "seq", event.seq());
                    delivery.send(event, 1);
                }, props.sendAtMs().get(i), TimeUnit.MILLISECONDS);
            }
            finished = delivery.done.await(30, TimeUnit.SECONDS);
        } finally {
            scheduler.shutdownNow();
        }
        if (!finished) throw new IllegalStateException("Scenario " + scenario.id() + " did not finish in 30 s");

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("scenarioId", scenario.id());
        result.put("mode", "executed");
        result.put("generatedAt", Instant.now().toString());
        result.put("warmupMs", warmupMs);
        result.put("runtime", Map.of("java", Runtime.version().toString(), "springBoot", SpringBootVersion.getVersion(),
                "transport", "HTTP/1.1 on localhost (JDK HttpClient -> embedded Tomcat)"));
        result.put("timing", Map.of("timeoutMs", props.timeoutMs(), "backoffBaseMs", props.backoffBaseMs(),
                "sendAtMs", props.sendAtMs(), "reorderDelayMs", props.reorderDelayMs()));
        result.put("guards", scenario.safeguards().asMap());
        result.put("trace", trace.rows());
        result.put("record", store.record());
        result.put("dlq", List.copyOf(delivery.dlq));
        result.put("dropped", List.copyOf(delivery.dropped));
        result.put("buffered", store.buffered());
        return result;
    }

    ScheduledExecutorService newDeliveryScheduler() {
        // Three independent HTTP attempts plus capacity for emissions and retry timers.
        return Executors.newScheduledThreadPool(4);
    }

    /** The producer side of the schema-change and poison failures: a renamed field, or an amount shipped as text. */
    private static ClaimEvent producerPayload(ClaimEvent event, Scenario.Failures failures) {
        if (event.type().equals(failures.poisonEvent())) {
            Map<String, Object> text = new HashMap<>(event.payload());
            text.put("paidAmount", "120.00");
            return event.withPayload(text);
        }
        if (event.type().equals(failures.schemaChangeEvent())) {
            Map<String, Object> renamed = new HashMap<>(event.payload());
            renamed.put("amountPaid", renamed.remove("paidAmount"));
            return event.withPayload(renamed);
        }
        return event;
    }

    private RestClient client(HttpClient http, Duration readTimeout) {
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(http);
        factory.setReadTimeout(readTimeout);
        return RestClient.builder()
                .baseUrl("http://127.0.0.1:" + env.getRequiredProperty("local.server.port"))
                .requestFactory(factory)
                .build();
    }

    private static void postEvent(RestClient client, ClaimEvent event, int attempt) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("eventId", event.eventId());
        body.put("type", event.type());
        body.put("seq", event.seq());
        body.put("status", event.status());
        body.put("payload", event.payload());
        client.post().uri("/claims/{id}/events", event.claimId())
                .header("X-Attempt", String.valueOf(attempt))
                .body(body).retrieve().toBodilessEntity();
    }

    private final class Delivery {
        final ScheduledExecutorService scheduler;
        final CountDownLatch done = new CountDownLatch(3);
        final List<Map<String, Object>> dlq = Collections.synchronizedList(new ArrayList<>());
        final List<Map<String, Object>> dropped = Collections.synchronizedList(new ArrayList<>());
        final Map<String, ClaimEvent> originals = new ConcurrentHashMap<>();
        private final Set<String> replayed = ConcurrentHashMap.newKeySet();
        private final RestClient client;
        private final Scenario scenario;
        private final Trace trace;

        Delivery(RestClient client, Scenario scenario, Trace trace, ScheduledExecutorService scheduler) {
            this.scheduler = scheduler;
            this.client = client;
            this.scenario = scenario;
            this.trace = trace;
        }

        void send(ClaimEvent event, int attempt) {
            long delay = scenario.failures().delayed(event.type(), attempt) ? props.reorderDelayMs() : 0;
            scheduler.schedule(() -> post(event, attempt), delay, TimeUnit.MILLISECONDS);
        }

        private void post(ClaimEvent event, int attempt) {
            trace.log("queue", "send", event, "attempt", attempt);
            try {
                postEvent(client, event, attempt);
                done.countDown();
            } catch (HttpClientErrorException rejected) {
                giveUp(event, attempt, "rejected as non-retryable");
            } catch (HttpServerErrorException failed) {
                if (failed.getStatusCode().value() != 500) {
                    onTimeout(event, attempt);
                } else {
                    retryOrGiveUp(event, attempt);
                }
            } catch (RestClientException timeoutOrServerError) {
                onTimeout(event, attempt);
            }
        }

        private void onTimeout(ClaimEvent event, int attempt) {
            trace.log("queue", "timeout", event, "attempt", attempt);
            retryOrGiveUp(event, attempt);
        }

        private void retryOrGiveUp(ClaimEvent event, int attempt) {
            Scenario.Safeguards guards = scenario.safeguards();
            if (attempt <= guards.retryLimit()) {
                long wait = guards.backoffMs(props.backoffBaseMs(), attempt);
                trace.log("queue", "retry-scheduled", event, "attempt", attempt, "note", "retry in " + wait + " ms");
                scheduler.schedule(() -> send(event, attempt + 1), wait, TimeUnit.MILLISECONDS);
            } else {
                giveUp(event, attempt, "retry limit (" + guards.retryLimit() + ") reached");
            }
        }

        /** The producer fix has shipped: take the message out of the DLQ and deliver the corrected original afresh. */
        private void replay(ClaimEvent poisoned, Map<String, Object> entry) {
            dlq.remove(entry);
            ClaimEvent fixed = originals.get(poisoned.eventId());
            trace.log("queue", "replay", fixed, "note", "producer fix shipped, replaying from the dead-letter queue");
            send(fixed, 1);
        }

        private void giveUp(ClaimEvent event, int attempt, String reason) {
            Map<String, Object> entry = Map.of("eventId", event.eventId(), "eventType", event.type(), "reason", reason, "attempts", attempt);
            if (scenario.safeguards().deadLetter()) {
                dlq.add(entry);
                trace.log("queue", "dead-letter", event, "attempt", attempt, "note", reason);
                if (scenario.safeguards().replayAfterFix() && replayed.add(event.eventId())) {
                    scheduler.schedule(() -> replay(event, entry), props.replayDelayMs(), TimeUnit.MILLISECONDS);
                    return; // the delivery is not finished until the replay settles
                }
            } else {
                dropped.add(entry);
                trace.log("queue", "drop", event, "attempt", attempt, "note", reason + "; no dead-letter queue");
            }
            done.countDown();
        }
    }
}
