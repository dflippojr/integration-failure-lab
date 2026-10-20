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
 */
@Component
public class RunContext {

    private volatile Run current = new Run(Scenario.fromMap(Map.of("id", "manual")), new Trace(), 0);

    /** Starts a run that owns the store from {@code epoch}, the value {@link ClaimStore#reset} returned. */
    Run begin(Scenario scenario, Trace trace, long epoch) {
        Run run = new Run(scenario, trace, epoch);
        current = run;
        return run;
    }

    /** The run a request arriving now belongs to, for the whole of that request. */
    public Run current() {
        return current;
    }

    /**
     * How the downstream tells a run's timeline (in {@link ScenarioRunner}) where each of the run's
     * requests is, by the number the runner gave it. The timeline takes its next step only once no
     * request is in transit or being processed, so the order of a run does not depend on the scheduler.
     */
    interface Gate {
        /**
         * The request starts an out-of-order delay. Blocks until the timeline ends the delay and returns 0,
         * or, if the run stops first, returns how much of the delay is left for the caller to sleep.
         */
        long delay(long send, long delayMs) throws InterruptedException;

        /** The request is held so that its sender times out; nothing it does changes the run any more. */
        void held(long send);

        /** The downstream has processed the request and is about to reply. */
        void processed(long send);
    }

    /**
     * One run's scenario, trace and store epoch. It also counts the run's downstream requests that may
     * still change the store or trace. A delayed request can outlive the client's read timeout, so a run
     * waits for this count to reach zero before it reads its result. A request still running when that
     * wait gives up keeps its run's epoch, so the store drops it once the next run has reset the store.
     */
    public static final class Run {
        private final Scenario scenario;
        private final Trace trace;
        private final long epoch;
        /** Requests not yet done with the store and trace. Guarded by {@code this}. */
        private int processing;
        private volatile Gate gate;

        private Run(Scenario scenario, Trace trace, long epoch) {
            this.scenario = scenario;
            this.trace = trace;
            this.epoch = epoch;
        }

        public Scenario scenario() {
            return scenario;
        }

        public Trace trace() {
            return trace;
        }

        public long epoch() {
            return epoch;
        }

        void attach(Gate gate) {
            this.gate = gate;
        }

        /**
         * Waits out an injected out-of-order delay. In a scenario run the run's timeline ends it (see
         * {@link Gate#delay}); outside one, or for a request without its number, it is a plain sleep.
         */
        void delay(Long send, long delayMs) throws InterruptedException {
            Gate current = gate;
            long rest = send != null && current != null ? current.delay(send, delayMs) : delayMs;
            if (rest > 0) Thread.sleep(rest);
        }

        /** The request is held so that its sender times out; see {@link Gate#held}. */
        void held(Long send) {
            Gate current = gate;
            if (send != null && current != null) current.held(send);
        }

        /** The downstream is done with the request; see {@link Gate#processed}. */
        void processed(Long send) {
            Gate current = gate;
            if (send != null && current != null) current.processed(send);
        }

        synchronized void processingStarted() {
            processing++;
        }

        synchronized void processingFinished() {
            if (--processing == 0) notifyAll();
        }

        /** Waits until none of this run's requests is processing; false if the limit passed first. */
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
}
