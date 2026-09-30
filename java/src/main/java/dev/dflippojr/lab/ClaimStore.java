package dev.dflippojr.lab;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import org.springframework.stereotype.Component;

/**
 * Downstream claim-status state for claim C-1001, with the consumer-side safeguards. The rules
 * mirror {@code receive()} in engine/engine.js so simulated and executed runs are comparable.
 */
@Component
public class ClaimStore {

    public enum Outcome { ACK, REJECT }

    private String status;
    private long paidCents;
    private final List<String> applied = new ArrayList<>();
    private final Set<String> seen = new HashSet<>();
    private final TreeMap<Integer, ClaimEvent> buffer = new TreeMap<>();
    private int nextSeq = 1;

    public synchronized void reset() {
        status = null;
        paidCents = 0;
        applied.clear();
        seen.clear();
        buffer.clear();
        nextSeq = 1;
    }

    public synchronized Outcome receive(ClaimEvent e, Scenario.Safeguards guards, Trace trace) {
        if (guards.schemaValidation() && "ClaimPaid".equals(e.type()) && !(e.payload().get("paidAmount") instanceof Number)) {
            trace.log("downstream", "reject", e, "note", "schema: missing paidAmount");
            return Outcome.REJECT;
        }
        if (guards.idempotency() && seen.contains(e.eventId())) {
            trace.log("downstream", "dedupe", e, "note", "already seen, skipped");
            return Outcome.ACK;
        }
        if (guards.ordering()) {
            if (e.seq() < nextSeq) {
                trace.log("downstream", "stale", e, "note", "seq " + e.seq() + " already applied, skipped");
                return Outcome.ACK;
            }
            if (e.seq() > nextSeq) {
                seen.add(e.eventId());
                buffer.put(e.seq(), e);
                trace.log("downstream", "buffer", e, "note", "waiting for seq " + nextSeq);
                return Outcome.ACK;
            }
        }
        seen.add(e.eventId());
        apply(e, trace);
        if (guards.ordering()) {
            while (buffer.containsKey(nextSeq)) {
                ClaimEvent next = buffer.remove(nextSeq);
                trace.log("downstream", "release", next, "note", "gap filled, releasing buffered event");
                apply(next, trace);
            }
        }
        return Outcome.ACK;
    }

    private void apply(ClaimEvent e, Trace trace) {
        status = e.status();
        if ("ClaimPaid".equals(e.type())) {
            // Lenient consumer: a missing amount reads as zero, exactly the bug the schema scenario shows.
            Object amount = e.payload().get("paidAmount");
            paidCents += amount instanceof Number n ? n.longValue() : 0;
        }
        applied.add(e.eventId());
        nextSeq = Math.max(nextSeq, e.seq() + 1);
        trace.log("downstream", "apply", e, "status", status, "paidCents", paidCents);
    }

    public synchronized Map<String, Object> record() {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("status", status);
        record.put("paidCents", paidCents);
        record.put("applied", List.copyOf(applied));
        return record;
    }

    public synchronized List<Map<String, Object>> buffered() {
        return buffer.values().stream()
                .map(e -> Map.<String, Object>of("eventId", e.eventId(), "eventType", e.type(), "seq", e.seq()))
                .toList();
    }
}
