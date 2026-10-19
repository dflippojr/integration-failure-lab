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

    /** STALE: the event belongs to a run that ended before a later run reset the store. */
    public enum Outcome { ACK, REJECT, FAIL, STALE }

    private String status;
    private long paidCents;
    private final List<String> applied = new ArrayList<>();
    private final Set<String> seen = new HashSet<>();
    private final TreeMap<Integer, ClaimEvent> buffer = new TreeMap<>();
    private int nextSeq = 1;
    /** Which run owns the state; each reset starts a new one. */
    private long epoch;

    /** Clears the state for a new run and returns that run's epoch. */
    public synchronized long reset() {
        status = null;
        paidCents = 0;
        applied.clear();
        seen.clear();
        buffer.clear();
        nextSeq = 1;
        return ++epoch;
    }

    /** Applies the event for the run that owns {@code runEpoch}, or drops it if a later run has reset the store. */
    public synchronized Outcome receive(ClaimEvent e, Scenario.Safeguards guards, Trace trace, long runEpoch) {
        if (runEpoch != epoch) return Outcome.STALE;
        if ("ClaimPaid".equals(e.type()) && e.payload().get("paidAmount") instanceof String) {
            trace.log("downstream", "reject", e, "note", "poison: paidAmount is text, cannot be parsed");
            return Outcome.FAIL;
        }
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
