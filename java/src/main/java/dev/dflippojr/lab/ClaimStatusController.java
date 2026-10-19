package dev.dflippojr.lab;

import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * The downstream claim-status service. Faults are injected here, on the server side: a "timeout"
 * holds the request past the client's read timeout without processing it, a "lost ack"
 * processes the event and then holds the response so the client never sees it, and an
 * out-of-order delay holds the request before processing it, like a slow network: the client's
 * read timeout is already running, as the engine's ack timeout runs from the send. A delayed
 * request is counted in its {@link RunContext.Run} until it is processed, so its run waits for it,
 * and the store drops it if a later run has reset the store in the meantime. The runner tags each
 * request with its run's epoch, so a request held up before it reached this handler, which its run
 * never counted, is dropped too when it arrives after its run has ended.
 */
@RestController
public class ClaimStatusController {

    /** The epoch of the run that sent a request; absent when the event comes from outside a run. */
    static final String RUN_HEADER = "X-Run";

    private final ClaimStore store;
    private final RunContext run;
    private final LabProperties props;

    public ClaimStatusController(ClaimStore store, RunContext run, LabProperties props) {
        this.store = store;
        this.run = run;
        this.props = props;
    }

    @GetMapping("/health")
    public String health() {
        return "ok";
    }

    @PostMapping("/claims/{claimId}/events")
    public ResponseEntity<Void> receive(@PathVariable String claimId,
                                        @RequestHeader("X-Attempt") int attempt,
                                        @RequestHeader(name = RUN_HEADER, required = false) Long runEpoch,
                                        @RequestBody Map<String, Object> body) throws InterruptedException {
        RunContext.Run owner = run.current();
        if (runEpoch != null && runEpoch != owner.epoch()) {
            // Its run has ended; no client is waiting for this reply.
            return ResponseEntity.status(409).build();
        }
        Reply reply;
        owner.processingStarted();
        try {
            reply = process(fromBody(claimId, body), attempt, owner);
        } finally {
            owner.processingFinished();
        }
        // Holding a timeout or lost ack changes nothing, so the run need not wait for it.
        Thread.sleep(reply.holdMs());
        return ResponseEntity.status(reply.status()).build();
    }

    /** What to send back, and how long to hold it first. */
    private record Reply(int status, long holdMs) {
    }

    private Reply process(ClaimEvent event, int attempt, RunContext.Run owner) throws InterruptedException {
        Scenario scenario = owner.scenario();
        Trace trace = owner.trace();
        if (scenario.failures().delayed(event.type(), attempt)) {
            Thread.sleep(props.reorderDelayMs());
        }
        if (scenario.failures().timesOut(event.type(), attempt)) {
            return new Reply(504, props.timeoutMs() * 2);
        }
        ClaimStore.Outcome outcome = store.receive(event, scenario.safeguards(), trace, owner.epoch());
        if (outcome == ClaimStore.Outcome.STALE) {
            // Its run has ended and a later run owns the store; no client is waiting for this reply.
            return new Reply(409, 0);
        }
        if (outcome == ClaimStore.Outcome.FAIL) {
            return new Reply(500, 0);
        }
        if (outcome == ClaimStore.Outcome.REJECT) {
            return new Reply(422, 0);
        }
        if (scenario.failures().losesAck(event.type(), attempt)) {
            trace.log("downstream", "ack-lost", event, "attempt", attempt);
            return new Reply(200, props.timeoutMs() * 2);
        }
        trace.log("downstream", "ack", event, "attempt", attempt);
        return new Reply(200, 0);
    }

    @SuppressWarnings("unchecked")
    private static ClaimEvent fromBody(String claimId, Map<String, Object> body) {
        return new ClaimEvent((String) body.get("eventId"), (String) body.get("type"),
                ((Number) body.get("seq")).intValue(), claimId, (String) body.get("status"),
                (Map<String, Object>) body.getOrDefault("payload", Map.of()));
    }
}
