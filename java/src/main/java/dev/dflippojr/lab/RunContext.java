package dev.dflippojr.lab;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.springframework.stereotype.Component;

/**
 * The scenario currently being executed. The downstream reads its fault plan and safeguards from
 * here; runs are serialized by {@link ScenarioRunner}, so one run owns this at a time. Until a run
 * begins, a no-fault scenario with default safeguards applies, so the event endpoint works when the
 * app only serves the downstream.
 *
 * <p>It also counts downstream requests that may still change the store or trace. A delayed request
 * can outlive the client's read timeout, so a run waits for this count to reach zero before it reads
 * its result and lets the next run reset the store.
 */
@Component
public class RunContext {

    private volatile Scenario scenario = Scenario.fromMap(Map.of("id", "manual"));
    private volatile Trace trace = new Trace();
    /** Downstream requests not yet done with the store and trace. Guarded by {@code this}. */
    private int processing;

    void begin(Scenario scenario, Trace trace) {
        this.scenario = scenario;
        this.trace = trace;
    }

    public Scenario scenario() {
        return scenario;
    }

    public Trace trace() {
        return trace;
    }

    synchronized void processingStarted() {
        processing++;
    }

    synchronized void processingFinished() {
        if (--processing == 0) notifyAll();
    }

    /** Waits until no downstream request is processing; false if the limit passed first. */
    synchronized boolean awaitIdle(Duration limit) throws InterruptedException {
        long deadline = System.nanoTime() + limit.toNanos();
        while (processing > 0) {
            long left = deadline - System.nanoTime();
            if (left <= 0) return false;
            TimeUnit.NANOSECONDS.timedWait(this, left);
        }
        return true;
    }
}
