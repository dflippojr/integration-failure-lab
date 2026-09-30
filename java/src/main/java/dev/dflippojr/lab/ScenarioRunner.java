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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import org.springframework.boot.SpringBootVersion;
import org.springframework.core.env.Environment;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
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
        RestClient client = client();
        client.get().uri("/health").retrieve().toBodilessEntity(); // warm the connection so run timings are fair

        Trace trace = new Trace();
        store.reset();
        context.begin(scenario, trace);

        Delivery delivery = new Delivery(client, scenario, trace);
        List<ClaimEvent> events = ClaimEvent.sequence();
        for (int i = 0; i < events.size(); i++) {
            ClaimEvent event = producerPayload(events.get(i), scenario.failures());
            delivery.scheduler.schedule(() -> {
                trace.log("producer", "emit", event, "seq", event.seq());
                delivery.send(event, 1);
            }, props.sendAtMs().get(i), TimeUnit.MILLISECONDS);
        }
        boolean finished = delivery.done.await(30, TimeUnit.SECONDS);
        delivery.scheduler.shutdownNow();
        if (!finished) throw new IllegalStateException("Scenario " + scenario.id() + " did not finish in 30 s");

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("scenarioId", scenario.id());
        result.put("mode", "executed");
        result.put("generatedAt", Instant.now().toString());
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

    /** The producer side of the schema-change failure: it ships a renamed field. */
    private static ClaimEvent producerPayload(ClaimEvent event, Scenario.Failures failures) {
        if (event.type().equals(failures.schemaChangeEvent())) {
            Map<String, Object> renamed = new HashMap<>(event.payload());
            renamed.put("amountPaid", renamed.remove("paidAmount"));
            return event.withPayload(renamed);
        }
        return event;
    }

    private RestClient client() {
        JdkClientHttpRequestFactory factory = new JdkClientHttpRequestFactory(
                HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).version(HttpClient.Version.HTTP_1_1).build());
        factory.setReadTimeout(Duration.ofMillis(props.timeoutMs()));
        return RestClient.builder()
                .baseUrl("http://127.0.0.1:" + env.getRequiredProperty("local.server.port"))
                .requestFactory(factory)
                .build();
    }

    private final class Delivery {
        final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(8);
        final CountDownLatch done = new CountDownLatch(3);
        final List<Map<String, Object>> dlq = Collections.synchronizedList(new ArrayList<>());
        final List<Map<String, Object>> dropped = Collections.synchronizedList(new ArrayList<>());
        private final RestClient client;
        private final Scenario scenario;
        private final Trace trace;

        Delivery(RestClient client, Scenario scenario, Trace trace) {
            this.client = client;
            this.scenario = scenario;
            this.trace = trace;
        }

        void send(ClaimEvent event, int attempt) {
            trace.log("queue", "send", event, "attempt", attempt);
            long delay = scenario.failures().delayed(event.type(), attempt) ? props.reorderDelayMs() : 0;
            scheduler.schedule(() -> post(event, attempt), delay, TimeUnit.MILLISECONDS);
        }

        private void post(ClaimEvent event, int attempt) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("eventId", event.eventId());
            body.put("type", event.type());
            body.put("seq", event.seq());
            body.put("status", event.status());
            body.put("payload", event.payload());
            try {
                client.post().uri("/claims/{id}/events", event.claimId())
                        .header("X-Attempt", String.valueOf(attempt))
                        .body(body)
                        .retrieve()
                        .toBodilessEntity();
                done.countDown();
            } catch (HttpClientErrorException rejected) {
                giveUp(event, attempt, "rejected as non-retryable");
            } catch (RestClientException timeoutOrServerError) {
                onTimeout(event, attempt);
            }
        }

        private void onTimeout(ClaimEvent event, int attempt) {
            trace.log("queue", "timeout", event, "attempt", attempt);
            Scenario.Safeguards guards = scenario.safeguards();
            if (attempt <= guards.retryLimit()) {
                long wait = guards.backoffMs(props.backoffBaseMs(), attempt);
                trace.log("queue", "retry-scheduled", event, "attempt", attempt, "note", "retry in " + wait + " ms");
                scheduler.schedule(() -> send(event, attempt + 1), wait, TimeUnit.MILLISECONDS);
            } else {
                giveUp(event, attempt, "retry limit (" + guards.retryLimit() + ") reached");
            }
        }

        private void giveUp(ClaimEvent event, int attempt, String reason) {
            Map<String, Object> entry = Map.of("eventId", event.eventId(), "eventType", event.type(), "reason", reason, "attempts", attempt);
            if (scenario.safeguards().deadLetter()) {
                dlq.add(entry);
                trace.log("queue", "dead-letter", event, "attempt", attempt, "note", reason);
            } else {
                dropped.add(entry);
                trace.log("queue", "drop", event, "attempt", attempt, "note", reason + "; no dead-letter queue");
            }
            done.countDown();
        }
    }
}
