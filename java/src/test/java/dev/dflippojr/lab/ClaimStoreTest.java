package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

/** The consumer rules of engine/engine.js receive(), called directly: no Spring context, no HTTP. */
class ClaimStoreTest {

    static final List<ClaimEvent> EVENTS = ClaimEvent.sequence();
    static final ClaimEvent E1 = EVENTS.get(0);
    static final ClaimEvent E2 = EVENTS.get(1);
    static final ClaimEvent E3 = EVENTS.get(2);

    final ClaimStore store = new ClaimStore();
    final Trace trace = new Trace();

    static Scenario.Safeguards guards(boolean idempotency, boolean ordering) {
        return Scenario.fromMap(Map.of("failures", Map.of(),
                "safeguards", Map.of("idempotency", idempotency, "ordering", ordering))).safeguards();
    }

    /** The trace row without its wall-clock stamp. */
    static Map<String, Object> row(Map<String, Object> traced) {
        return Map.of("actor", traced.get("actor"), "kind", traced.get("kind"), "eventId", traced.get("eventId"),
                "note", String.valueOf(traced.get("note")));
    }

    static Map<String, Object> row(String kind, String eventId, String note) {
        return Map.of("actor", "downstream", "kind", kind, "eventId", eventId, "note", note);
    }

    @Test
    void aRedeliveredEventIsSkippedAsStaleUnderOrdering() {
        Scenario.Safeguards guards = guards(false, true);
        long epoch = store.reset();
        for (ClaimEvent e : EVENTS) assertThat(store.receive(e, guards, trace, epoch)).isEqualTo(ClaimStore.Outcome.ACK);

        assertThat(store.receive(E3, guards, trace, epoch)).isEqualTo(ClaimStore.Outcome.ACK);

        assertThat(store.record()).isEqualTo(Map.of("status", "Paid", "paidCents", 12_000L, "applied", List.of("E1", "E2", "E3")));
        assertThat(row(trace.rows().getLast())).isEqualTo(row("stale", "E3", "seq 3 already applied, skipped"));
    }

    @Test
    void anEventAheadOfSequenceIsBufferedThenReleased() {
        Scenario.Safeguards guards = guards(false, true);
        long epoch = store.reset();
        store.receive(E1, guards, trace, epoch);

        assertThat(store.receive(E3, guards, trace, epoch)).isEqualTo(ClaimStore.Outcome.ACK);

        assertThat(store.buffered()).isEqualTo(List.of(Map.of("eventId", "E3", "eventType", "ClaimPaid", "seq", 3)));
        assertThat(store.record().get("applied")).isEqualTo(List.of("E1"));
        assertThat(trace.rows()).extracting(ClaimStoreTest::row).contains(row("buffer", "E3", "waiting for seq 2"));

        assertThat(store.receive(E2, guards, trace, epoch)).isEqualTo(ClaimStore.Outcome.ACK);

        assertThat(store.buffered()).isEmpty();
        assertThat(store.record()).isEqualTo(Map.of("status", "Paid", "paidCents", 12_000L, "applied", List.of("E1", "E2", "E3")));
        assertThat(trace.rows()).extracting(ClaimStoreTest::row)
                .contains(row("release", "E3", "gap filled, releasing buffered event"));
    }

    @Test
    void withoutOrderingARedeliveryIsPaidTwice() {
        Scenario.Safeguards guards = guards(false, false);
        long epoch = store.reset();
        for (ClaimEvent e : EVENTS) store.receive(e, guards, trace, epoch);

        assertThat(store.receive(E3, guards, trace, epoch)).isEqualTo(ClaimStore.Outcome.ACK);

        assertThat(store.record()).isEqualTo(Map.of("status", "Paid", "paidCents", 24_000L, "applied", List.of("E1", "E2", "E3", "E3")));
    }

    @Test
    void aStaleEpochIsDroppedUntouched() {
        Scenario.Safeguards guards = guards(false, true);
        long ended = store.reset();
        long current = store.reset();
        store.receive(E1, guards, trace, current);
        Map<String, Object> record = store.record();
        List<Map<String, Object>> rows = trace.rows();

        assertThat(store.receive(E2, guards, trace, ended)).isEqualTo(ClaimStore.Outcome.STALE);

        assertThat(store.record()).isEqualTo(record);
        assertThat(trace.rows()).isEqualTo(rows);
    }
}
