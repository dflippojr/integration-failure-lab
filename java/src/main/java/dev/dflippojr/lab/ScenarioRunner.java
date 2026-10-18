package dev.dflippojr.lab;

import java.net.http.HttpClient;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
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

    private static final long QUIESCE_SECONDS = 5;

    /** How a run decides that a request timed out. */
    public enum Timeouts {
        /** When the read timeout really expires. Normal runs and the differential use this. */
        REAL,
        /**
         * On the run's logical timeline, from the injected faults alone: a request times out when the
         * downstream holds it for a timeout or lost-ack fault, or delays it to or past the read timeout.
         * Requests still go over real HTTP, waited for up to {@link ScenarioRunner#transportBound()}; one with
         * no answer by then fails the run as an infrastructure failure rather than recording a timeout. The
         * recordings export uses this, so a stalled machine cannot record a timeout the scenario does not
         * inject, and the comparison with {@code executed/} can stay exact.
         */
        LOGICAL
    }

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

    public Map<String, Object> run(Scenario scenario) throws InterruptedException {
        return run(scenario, Timeouts.REAL);
    }

    public synchronized Map<String, Object> run(Scenario scenario, Timeouts timeouts) throws InterruptedException {
        Duration connect = timeouts == Timeouts.LOGICAL ? transportBound() : Duration.ofSeconds(1);
        try (HttpClient http = HttpClient.newBuilder().connectTimeout(connect)
                .version(HttpClient.Version.HTTP_1_1).build()) {
            return run(scenario, timeouts, http);
        }
    }

    private Map<String, Object> run(Scenario scenario, Timeouts timeouts, HttpClient http) throws InterruptedException {
        // Exercise the event endpoint's JSON binding and header conversion before the scenario
        // clock starts. A health GET does not initialize this path. No injected faults apply here.
        RunContext.Run warmup = context.begin(Scenario.fromMap(Map.of("id", "warm-up")), new Trace(), store.reset());
        long warmupStart = System.nanoTime();
        postEvent(client(http, Duration.ofSeconds(10)), ClaimEvent.sequence().getFirst(), 1, warmup.epoch(), 1);
        long warmupMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - warmupStart);
        RestClient client = client(http, timeouts == Timeouts.LOGICAL ? transportBound() : Duration.ofMillis(props.timeoutMs()));

        Trace trace = new Trace();
        RunContext.Run run = context.begin(scenario, trace, store.reset());

        ScheduledExecutorService scheduler = newDeliveryScheduler();
        Delivery delivery = new Delivery(client, scenario, timeouts, trace, run, scheduler);
        run.attach(delivery);
        try {
            List<ClaimEvent> events = ClaimEvent.sequence();
            events.forEach(e -> delivery.originals.put(e.eventId(), e));
            for (int i = 0; i < events.size(); i++) {
                ClaimEvent event = producerPayload(events.get(i), scenario.failures());
                long sendAt = props.sendAtMs().get(i);
                delivery.at(sendAt, sendAt, event, "producer emission of " + describe(event), () -> {
                    trace.log("producer", "emit", event, "seq", event.seq());
                    delivery.send(event, 1);
                });
            }
            delivery.start();
            delivery.await(scenarioLimit());
        } catch (InterruptedException | RuntimeException failure) {
            delivery.thrown(failure);
            throw failure;
        } finally {
            quiesce(scheduler, delivery, run);
        }
        delivery.rethrowFailure();

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("scenarioId", scenario.id());
        result.put("mode", "executed");
        result.put("generatedAt", Instant.now().toString());
        result.put("warmupMs", warmupMs);
        // LinkedHashMap rather than Map.of, whose iteration order changes from one JVM to the next.
        Map<String, Object> runtime = new LinkedHashMap<>();
        runtime.put("transport", "HTTP/1.1 on localhost (JDK HttpClient -> embedded Tomcat)");
        runtime.put("java", Runtime.version().toString());
        runtime.put("springBoot", SpringBootVersion.getVersion());
        result.put("runtime", runtime);
        Map<String, Object> timing = new LinkedHashMap<>();
        timing.put("timeoutMs", props.timeoutMs());
        timing.put("backoffBaseMs", props.backoffBaseMs());
        timing.put("sendAtMs", props.sendAtMs());
        timing.put("reorderDelayMs", props.reorderDelayMs());
        result.put("timing", timing);
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

    /** The overall bound for a run that neither settles every event nor fails. */
    Duration scenarioLimit() {
        return Duration.ofSeconds(30);
    }

    /**
     * With logical timeouts, how long a request may go without an answer before the run fails as an
     * infrastructure failure: far past any injected hold, and no part of a scenario's behaviour.
     */
    Duration transportBound() {
        return Duration.ofSeconds(10);
    }

    /**
     * Drops queued emissions, interrupts in-flight work and waits a bounded time for it, so failures
     * from tasks that were already running are recorded before the caller sees the outcome. Then waits
     * for the downstream to finish requests the client gave up on, such as an out-of-order delay longer
     * than the read timeout, so they land in this run. If that wait runs out or is interrupted, the run
     * fails, and a request still running is dropped by the store once the next run has reset it.
     */
    private void quiesce(ScheduledExecutorService scheduler, Delivery delivery, RunContext.Run run) {
        scheduler.shutdownNow();
        delivery.stop();
        try {
            if (!scheduler.awaitTermination(QUIESCE_SECONDS, TimeUnit.SECONDS)) {
                delivery.fail(new IllegalStateException("delivery workers did not stop"));
            }
            if (!run.awaitIdle(Duration.ofSeconds(QUIESCE_SECONDS))) {
                delivery.fail(new IllegalStateException("downstream requests did not finish"));
            }
        } catch (InterruptedException interrupted) {
            // Events may still be in flight, so the run must not return a result.
            delivery.fail(new IllegalStateException("cleanup was interrupted", interrupted));
            Thread.currentThread().interrupt();
        }
    }

    private static String describe(ClaimEvent event) {
        return event.eventId() + " (" + event.type() + ")";
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

    /**
     * Posts one attempt, tagged with the epoch of the run that sent it, so the downstream can tell a request
     * that arrives after its run has ended, even one held up before it reached the handler.
     */
    private static void postEvent(RestClient client, ClaimEvent event, int attempt, long runEpoch, long send) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("eventId", event.eventId());
        body.put("type", event.type());
        body.put("seq", event.seq());
        body.put("status", event.status());
        body.put("payload", event.payload());
        client.post().uri("/claims/{id}/events", event.claimId())
                .header("X-Attempt", String.valueOf(attempt))
                .header(ClaimStatusController.RUN_HEADER, String.valueOf(runEpoch))
                .header(ClaimStatusController.SEND_HEADER, String.valueOf(send))
                .body(body).retrieve().toBodilessEntity();
    }

    /**
     * One step of a run on its logical timeline: a producer emission, a retry, a replay, the end of an
     * out-of-order delay, or what the sender does with an answer or a timeout. Steps run in order of their
     * logical due time, then event, then creation.
     */
    private static final class Step {
        static final Comparator<Step> ORDER = Comparator.<Step>comparingLong(s -> s.due)
                .thenComparingInt(s -> s.seq).thenComparingLong(s -> s.created);

        long due;
        final int seq;
        /** Creation number: the last tie-breaker. */
        final long created;
        final String what;
        Runnable task;
        /** Its wall-clock time has come, or, for an answer, the answer is in. */
        boolean ready;

        Step(long due, int seq, long created, String what, Runnable task) {
            this.due = due;
            this.seq = seq;
            this.created = created;
            this.what = what;
            this.task = task;
        }
    }

    /** One HTTP attempt, by the number the runner gave it. */
    private static final class Request {
        final long at;
        final ClaimEvent event;
        final int attempt;
        /** When it was sent, by the wall clock. */
        final long sentNanos = System.nanoTime();
        /** What the sender does next: due at the timeout until the answer is in. */
        final Step answer;
        long delayMs;
        CompletableFuture<Boolean> release;
        /** In transit or being processed, so the timeline must wait for it. */
        boolean moving = true;
        boolean answered;
        boolean released;
        boolean processed;

        Request(long at, ClaimEvent event, int attempt, Step answer) {
            this.at = at;
            this.event = event;
            this.attempt = attempt;
            this.answer = answer;
        }
    }

    /**
     * The at-least-once delivery queue. Its steps run on a logical timeline: each runs once its wall-clock
     * time has come, every step due before it has run, and no request is in transit or being processed,
     * that is, each has its answer or is held by an injected fault. So a slow healthy request is never
     * overtaken, timers cannot fire out of order, and a run's trace order does not depend on the scheduler;
     * only the injected faults reorder deliveries. Read timeouts stay real: a request that has no answer
     * by then times out, as one held in transit by a slow network does. With {@link Timeouts#LOGICAL} they
     * are judged on the timeline instead (see {@link #timeOut}).
     */
    private final class Delivery implements RunContext.Gate {
        final ScheduledExecutorService scheduler;
        final List<Map<String, Object>> dlq = Collections.synchronizedList(new ArrayList<>());
        final List<Map<String, Object>> dropped = Collections.synchronizedList(new ArrayList<>());
        final Map<String, ClaimEvent> originals = new ConcurrentHashMap<>();
        private final Set<String> replayed = ConcurrentHashMap.newKeySet();
        private final RestClient client;
        private final Scenario scenario;
        private final Timeouts timeouts;
        private final Trace trace;
        private final RunContext.Run run;
        /** Steps not yet run. Guarded by {@code this}, as are the fields up to {@code primary}. */
        private final TreeSet<Step> timeline = new TreeSet<>(Step.ORDER);
        private final Map<Long, Request> requests = new HashMap<>();
        private long sends;
        private long steps;
        /** Requests in transit or being processed. */
        private int moving;
        /** Every producer emission is on the timeline; until then no step runs (see {@link #start}). */
        private boolean started;
        private boolean draining;
        private boolean stopped;
        /** The logical time of the step running now; only the thread running it uses this. */
        private long now;
        /** Events not yet applied, dead-lettered without a pending replay, or dropped. */
        private int unsettled = 3;
        /** The first failure of the run; later ones are attached to it as suppressed. */
        private Exception primary;

        Delivery(RestClient client, Scenario scenario, Timeouts timeouts, Trace trace, RunContext.Run run,
                 ScheduledExecutorService scheduler) {
            this.scheduler = scheduler;
            this.client = client;
            this.scenario = scenario;
            this.timeouts = timeouts;
            this.trace = trace;
            this.run = run;
        }

        /**
         * Schedules work whose unexpected failure ends the run. Futures are not kept: each task reports
         * into this delivery, which {@link #await} watches, so nothing is lost to an unobserved future.
         */
        void schedule(String what, Runnable task, long delayMs) {
            scheduler.schedule(() -> guard(what, task), delayMs, TimeUnit.MILLISECONDS);
        }

        /** Runs work whose unexpected failure ends the run, on whichever thread got to it. */
        private void guard(String what, Runnable task) {
            try {
                task.run();
            } catch (RejectedExecutionException refused) {
                if (!scheduler.isShutdown()) fail(taskFailure(what, refused));
            } catch (RuntimeException | Error unexpected) {
                fail(taskFailure(what, unexpected));
            }
        }

        private IllegalStateException taskFailure(String what, Throwable cause) {
            return new IllegalStateException("Scenario " + scenario.id() + ": " + what + " failed: " + cause, cause);
        }

        /**
         * Adds a step for the event at logical time {@code due}, in ms from the start of the run, that becomes
         * ready {@code waitMs} from now. The logical time orders steps; the wait keeps wall-clock timing.
         */
        void at(long due, long waitMs, ClaimEvent event, String what, Runnable task) {
            Step step;
            synchronized (this) {
                step = new Step(due, event.seq(), ++steps, what, task);
                timeline.add(step);
            }
            ready(step, waitMs);
        }

        /** Makes the step ready {@code waitMs} from now. */
        private void ready(Step step, long waitMs) {
            schedule(step.what, () -> {
                synchronized (this) {
                    step.ready = true;
                }
                drain();
            }, waitMs);
        }

        /**
         * Lets the timeline run, once every producer emission is on it. Their timers are armed as they are
         * added, so a setup thread stalled part way could otherwise let the workers run later steps, such as
         * a timeout, before an emission due earlier exists.
         */
        void start() {
            synchronized (this) {
                started = true;
            }
            drain();
        }

        /** Runs the steps that may run now, one at a time, on whichever thread got here. */
        private void drain() {
            while (true) {
                Step next;
                synchronized (this) {
                    if (!started || draining || stopped || moving > 0 || timeline.isEmpty() || !timeline.first().ready) return;
                    next = timeline.pollFirst();
                    now = next.due;
                    draining = true;
                }
                try {
                    guard(next.what, next.task);
                } finally {
                    synchronized (this) {
                        draining = false;
                    }
                }
            }
        }

        /** Posts at once: an out-of-order delay is network time, held by the downstream after the read timeout starts. */
        void send(ClaimEvent event, int attempt) {
            String what = "delivery of " + describe(event) + " attempt " + attempt;
            long id;
            synchronized (this) {
                id = ++sends;
                Step answer = new Step(now + props.timeoutMs(), event.seq(), ++steps, what, null);
                timeline.add(answer);
                requests.put(id, new Request(now, event, attempt, answer));
                moving++;
            }
            schedule(what, () -> post(event, attempt, id), 0);
        }

        private void moving(Request request, boolean moving) {
            if (request.moving != moving) {
                request.moving = moving;
                this.moving += moving ? 1 : -1;
            }
        }

        /**
         * The sender has its answer, or gave up waiting: {@code next} runs as a step at the logical time the
         * answer came, that is, when the request was sent or its delay ended, or at the timeout.
         */
        private void answered(long id, boolean timedOut, Runnable next) {
            synchronized (this) {
                Request request = requests.get(id);
                // Its logical timeout has been taken already; the late real answer changes nothing.
                if (request.answered) return;
                request.answered = true;
                timeline.remove(request.answer);
                if (!timedOut) request.answer.due = request.at + request.delayMs;
                request.answer.task = next;
                request.answer.ready = true;
                timeline.add(request.answer);
                // The downstream still processes a delayed request its sender gave up on, once the delay ends.
                moving(request, request.released && !request.processed);
            }
            drain();
        }

        /**
         * With logical timeouts, the request has timed out on the timeline: its sender gives up at the read
         * timeout, logically and, unless the machine is already late, by the wall clock too, whatever its real
         * answer does. Guarded by {@code this}.
         */
        private void timeOut(Request request) {
            request.answered = true;
            request.answer.task = () -> onTimeout(request.event, request.attempt);
            long waited = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - request.sentNanos);
            try {
                ready(request.answer, Math.max(0, props.timeoutMs() - waited));
            } catch (RejectedExecutionException stopping) {
                // The run is over; nothing waits for this answer.
            }
        }

        /** With logical timeouts, the request got no answer within the transport bound: the run fails. */
        private void unanswered(long id, RestClientException cause) {
            synchronized (this) {
                if (requests.get(id).answered) return;
            }
            fail(new IllegalStateException("Scenario " + scenario.id() + ": request " + id + " had no answer within the "
                    + transportBound().toMillis() + " ms transport bound. The machine or the downstream stalled;"
                    + " that is an infrastructure failure, not a timeout the scenario injects", cause));
        }

        @Override
        public long delay(long send, long delayMs) throws InterruptedException {
            long parked = System.nanoTime();
            Request request;
            CompletableFuture<Boolean> release = new CompletableFuture<>();
            synchronized (this) {
                request = requests.get(send);
                if (request == null || stopped) return delayMs;
                request.delayMs = delayMs;
                request.release = release;
                moving(request, false);
                if (timeouts == Timeouts.LOGICAL && delayMs >= props.timeoutMs()) timeOut(request);
            }
            try {
                at(request.at + delayMs, delayMs, request.event, "end of the delay of request " + send, () -> {
                    synchronized (this) {
                        request.released = true;
                        moving(request, true);
                    }
                    release.complete(true);
                });
            } catch (RejectedExecutionException stopping) {
                release.complete(false);
            }
            drain();
            boolean released;
            try {
                released = release.get();
            } catch (ExecutionException impossible) {
                throw new IllegalStateException(impossible);
            }
            // The run stopped first: the downstream waits out the rest of the delay on its own.
            return released ? 0 : Math.max(0, delayMs - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - parked));
        }

        @Override
        public void held(long send) {
            synchronized (this) {
                Request request = requests.get(send);
                if (request == null) return;
                request.processed = true;
                moving(request, false);
                if (timeouts == Timeouts.LOGICAL && !stopped) timeOut(request);
            }
            drain();
        }

        @Override
        public void processed(long send) {
            synchronized (this) {
                Request request = requests.get(send);
                if (request == null) return;
                request.processed = true;
                if (request.answered) moving(request, false);
            }
            drain();
        }

        /** Stops the timeline once the run is over; delayed requests then wait out their delays on their own. */
        void stop() {
            List<CompletableFuture<Boolean>> releases = new ArrayList<>();
            synchronized (this) {
                stopped = true;
                requests.values().forEach(r -> {
                    if (r.release != null) releases.add(r.release);
                });
            }
            releases.forEach(release -> release.complete(false));
        }

        /** Waits until every event settles, a task fails, the limit passes, or the caller is interrupted. */
        synchronized void await(Duration limit) throws InterruptedException {
            long deadline = System.nanoTime() + limit.toNanos();
            while (primary == null && unsettled > 0) {
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    throw new IllegalStateException("Scenario " + scenario.id() + " did not finish in " + limit.toMillis() + " ms");
                }
                TimeUnit.NANOSECONDS.timedWait(this, left);
            }
            rethrowFailure();
        }

        /**
         * Makes the exception the run is throwing primary: a task failure surfaced by {@link #await}, or the
         * caller's own setup, interrupt or timeout exception, which keeps any earlier task failure as suppressed.
         */
        synchronized void thrown(Exception thrown) {
            if (primary != null && primary != thrown) thrown.addSuppressed(primary);
            primary = thrown;
        }

        /** Records a task or shutdown failure. The first one wins; later ones are attached to it as suppressed. */
        synchronized void fail(Exception cause) {
            if (primary == null) {
                primary = cause;
                notifyAll();
            } else if (primary != cause) {
                primary.addSuppressed(cause);
            }
        }

        /** Throws a recorded task failure, including one recorded after every event had settled. */
        synchronized void rethrowFailure() {
            if (primary instanceof RuntimeException failure) throw failure;
        }

        private synchronized void settled() {
            if (--unsettled == 0) notifyAll();
        }

        private void post(ClaimEvent event, int attempt, long id) {
            trace.log("queue", "send", event, "attempt", attempt);
            try {
                postEvent(client, event, attempt, run.epoch(), id);
                answered(id, false, this::settled);
            } catch (HttpClientErrorException rejected) {
                answered(id, false, () -> giveUp(event, attempt, "rejected as non-retryable"));
            } catch (HttpServerErrorException failed) {
                if (failed.getStatusCode().value() != 500) {
                    answered(id, true, () -> onTimeout(event, attempt));
                } else {
                    answered(id, false, () -> retryOrGiveUp(event, attempt));
                }
            } catch (RestClientException timeoutOrServerError) {
                // shutdownNow interrupts in-flight sends: that is cancellation, not a delivery timeout.
                if (Thread.currentThread().isInterrupted() || scheduler.isShutdown()) return;
                if (timeouts == Timeouts.LOGICAL) {
                    unanswered(id, timeoutOrServerError);
                } else {
                    answered(id, true, () -> onTimeout(event, attempt));
                }
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
                at(now + wait, wait, event, "retry of " + describe(event) + " attempt " + (attempt + 1), () -> send(event, attempt + 1));
            } else {
                giveUp(event, attempt, "retry limit (" + guards.retryLimit() + ") reached");
            }
        }

        /**
         * The producer fix has shipped: take this entry (only) out of the DLQ and deliver the corrected original afresh.
         * Each entry has its own timer, replayDelayMs after it was parked, as in engine/engine.js.
         */
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
                    at(now + props.replayDelayMs(), props.replayDelayMs(), event, "replay of " + describe(event), () -> replay(event, entry));
                    return; // the delivery is not finished until the replay settles
                }
            } else {
                dropped.add(entry);
                trace.log("queue", "drop", event, "attempt", attempt, "note", reason + "; no dead-letter queue");
            }
            settled();
        }
    }
}
