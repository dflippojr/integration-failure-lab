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
 * holds the request past the client's read timeout without processing it, and a "lost ack"
 * processes the event and then holds the response so the client never sees it.
 */
@RestController
public class ClaimStatusController {

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
                                        @RequestBody Map<String, Object> body) throws InterruptedException {
        Scenario scenario = run.scenario();
        Trace trace = run.trace();
        ClaimEvent event = fromBody(claimId, body);

        if (scenario.failures().timesOut(event.type(), attempt)) {
            Thread.sleep(props.timeoutMs() * 2);
            return ResponseEntity.status(504).build();
        }
        ClaimStore.Outcome outcome = store.receive(event, scenario.safeguards(), trace);
        if (outcome == ClaimStore.Outcome.REJECT) {
            return ResponseEntity.status(422).build();
        }
        if (scenario.failures().losesAck(event.type(), attempt)) {
            trace.log("downstream", "ack-lost", event, "attempt", attempt);
            Thread.sleep(props.timeoutMs() * 2);
            return ResponseEntity.ok().build();
        }
        trace.log("downstream", "ack", event, "attempt", attempt);
        return ResponseEntity.ok().build();
    }

    @SuppressWarnings("unchecked")
    private static ClaimEvent fromBody(String claimId, Map<String, Object> body) {
        return new ClaimEvent((String) body.get("eventId"), (String) body.get("type"),
                ((Number) body.get("seq")).intValue(), claimId, (String) body.get("status"),
                (Map<String, Object>) body.getOrDefault("payload", Map.of()));
    }
}
