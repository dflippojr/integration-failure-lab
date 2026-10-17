package dev.dflippojr.lab;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Judges an executed run's final state against the correct claim record. A port of {@code judge()} in
 * engine/engine.js, wording included, so the differential test compares verdicts reached independently.
 */
public record Verdict(boolean ok, boolean visible, List<String> problems) {

    static final List<String> EXPECTED_APPLIED = List.of("E1", "E2", "E3");
    static final String EXPECTED_STATUS = "Paid";

    public static Verdict judge(String status, long paidCents, List<String> applied, List<String> dlq, List<String> buffered) {
        List<String> problems = new ArrayList<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        applied.forEach(id -> counts.merge(id, 1, Integer::sum));

        counts.forEach((id, n) -> {
            if (n > 1) problems.add(typeOf(id) + " applied " + n + " times");
        });
        for (String id : EXPECTED_APPLIED) {
            if (!counts.containsKey(id)) problems.add(typeOf(id) + " never applied");
        }
        List<String> firstSeen = List.copyOf(new LinkedHashSet<>(applied));
        if (firstSeen.size() == EXPECTED_APPLIED.size() && !firstSeen.equals(EXPECTED_APPLIED)) {
            problems.add("applied out of order (" + firstSeen.stream().map(Verdict::typeOf).collect(Collectors.joining(" → ")) + ")");
        }
        if (!EXPECTED_STATUS.equals(status)) {
            problems.add("final status is " + (status == null ? "empty" : status) + ", not " + EXPECTED_STATUS);
        }
        if (paidCents != ClaimEvent.AMOUNT_CENTS) {
            problems.add("paid " + dollars(paidCents) + " instead of " + dollars(ClaimEvent.AMOUNT_CENTS));
        }
        for (String id : buffered) problems.add(typeOf(id) + " stuck in the ordering buffer");
        return new Verdict(problems.isEmpty(), !dlq.isEmpty(), List.copyOf(problems));
    }

    public Map<String, Object> asMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("ok", ok);
        map.put("visible", visible);
        map.put("problems", problems);
        return map;
    }

    private static String typeOf(String eventId) {
        return ClaimEvent.sequence().stream().filter(e -> e.eventId().equals(eventId)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown event " + eventId)).type();
    }

    private static String dollars(long cents) {
        return String.format(Locale.ROOT, "$%.2f", cents / 100.0);
    }
}
