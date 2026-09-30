package dev.dflippojr.lab;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Thread-safe trace in the same row format as the browser engine, stamped with real elapsed ms. */
public final class Trace {

    private final long startNanos = System.nanoTime();
    private final List<Map<String, Object>> rows = new ArrayList<>();

    public synchronized void log(String actor, String kind, ClaimEvent event, Object... extras) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("t", (System.nanoTime() - startNanos) / 1_000_000);
        row.put("actor", actor);
        row.put("kind", kind);
        row.put("eventId", event == null ? null : event.eventId());
        row.put("eventType", event == null ? null : event.type());
        for (int i = 0; i + 1 < extras.length; i += 2) row.put((String) extras[i], extras[i + 1]);
        rows.add(row);
    }

    public synchronized List<Map<String, Object>> rows() {
        return List.copyOf(rows);
    }
}
