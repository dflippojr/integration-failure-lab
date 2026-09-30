package dev.dflippojr.lab;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A scenario file from {@code scenarios/*.json}, shared with the browser simulation. Parsed from a
 * plain map so the JSON stays the single source of truth for both implementations.
 */
public record Scenario(String id, int order, String title, Failures failures, Safeguards safeguards, Map<String, Object> expect) {

    public record Failures(String timeoutEvent, Set<Integer> timeoutAttempts, boolean timeoutAll,
                           String duplicateEvent, String reorderEvent, String schemaChangeEvent) {

        public boolean timesOut(String type, int attempt) {
            return type.equals(timeoutEvent) && (timeoutAll || timeoutAttempts.contains(attempt));
        }

        public boolean losesAck(String type, int attempt) {
            return type.equals(duplicateEvent) && attempt == 1;
        }

        public boolean delayed(String type, int attempt) {
            return type.equals(reorderEvent) && attempt == 1;
        }
    }

    public record Safeguards(int retryLimit, String backoff, boolean idempotency, boolean ordering,
                             boolean schemaValidation, boolean deadLetter) {

        public long backoffMs(long base, int retryNumber) {
            return switch (backoff) {
                case "none" -> 0;
                case "fixed" -> base;
                case "exponential" -> base * (1L << (retryNumber - 1));
                default -> throw new IllegalArgumentException("Unknown backoff: " + backoff);
            };
        }

        public Map<String, Object> asMap() {
            return Map.of("retryLimit", retryLimit, "backoff", backoff, "idempotency", idempotency,
                    "ordering", ordering, "schemaValidation", schemaValidation, "deadLetter", deadLetter);
        }
    }

    @SuppressWarnings("unchecked")
    public static Scenario fromMap(Map<String, Object> json) {
        Map<String, Object> f = (Map<String, Object>) json.getOrDefault("failures", Map.of());
        Map<String, Object> timeout = (Map<String, Object>) f.get("timeout");
        Object attempts = timeout == null ? null : timeout.get("attempts");
        Set<Integer> attemptSet = attempts instanceof List<?> list
                ? Set.copyOf(list.stream().map(n -> ((Number) n).intValue()).toList())
                : Set.of();
        Failures failures = new Failures(
                timeout == null ? null : (String) timeout.get("event"),
                attemptSet,
                "all".equals(attempts),
                eventOf(f.get("duplicate")),
                eventOf(f.get("reorder")),
                eventOf(f.get("schemaChange")));

        Map<String, Object> g = (Map<String, Object>) json.getOrDefault("safeguards", Map.of());
        Safeguards safeguards = new Safeguards(
                ((Number) g.getOrDefault("retryLimit", 3)).intValue(),
                (String) g.getOrDefault("backoff", "exponential"),
                (Boolean) g.getOrDefault("idempotency", false),
                (Boolean) g.getOrDefault("ordering", false),
                (Boolean) g.getOrDefault("schemaValidation", false),
                (Boolean) g.getOrDefault("deadLetter", true));

        return new Scenario((String) json.get("id"), ((Number) json.getOrDefault("order", 0)).intValue(),
                (String) json.get("title"), failures, safeguards,
                (Map<String, Object>) json.getOrDefault("expect", Map.of()));
    }

    @SuppressWarnings("unchecked")
    private static String eventOf(Object failure) {
        return failure instanceof Map<?, ?> m ? (String) ((Map<String, Object>) m).get("event") : null;
    }
}
