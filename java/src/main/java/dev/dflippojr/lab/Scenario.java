package dev.dflippojr.lab;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * A scenario file from {@code scenarios/*.json}, shared with the browser simulation. Parsed from a
 * plain map so the JSON stays the single source of truth for both implementations.
 */
public record Scenario(String id, int order, String title, Failures failures, Safeguards safeguards, Map<String, Object> expect) {

    // The id names the exported trace file, so it must not carry path separators or "..".
    static final Pattern ID_SHAPE = Pattern.compile("[a-z0-9]++(?:-[a-z0-9]++)*+");

    static final List<String> EVENT_TYPES = List.of("ClaimSubmitted", "ClaimAccepted", "ClaimPaid");
    static final List<String> FAILURE_KINDS = List.of("timeout", "duplicate", "reorder", "schemaChange", "poison");
    // The engine's TIMING.reorderDelayMs, in its virtual ms. This runner delays by lab.reorder-delay-ms, whatever the
    // scenario says, so it refuses any other value rather than run a different delay from the engine's.
    static final int REORDER_DELAY_MS = 500;

    public record Failures(String timeoutEvent, Set<Integer> timeoutAttempts, boolean timeoutAll,
                           String duplicateEvent, String reorderEvent, String schemaChangeEvent,
                           String poisonEvent) {

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
                             boolean schemaValidation, boolean deadLetter, boolean replayAfterFix) {

        static final List<String> BACKOFFS = List.of("none", "fixed", "exponential");

        public Safeguards {
            // Reject here rather than inside a scheduled retry, where the failure would surface late.
            if (backoff == null || !BACKOFFS.contains(backoff)) {
                throw new IllegalArgumentException("Unsupported safeguards.backoff \"" + backoff
                        + "\"; expected one of " + String.join(", ", BACKOFFS));
            }
        }

        public long backoffMs(long base, int retryNumber) {
            return switch (backoff) {
                case "none" -> 0;
                case "fixed" -> base;
                case "exponential" -> base * (1L << (retryNumber - 1));
                default -> throw new IllegalArgumentException("Unknown backoff: " + backoff);
            };
        }

        public Map<String, Object> asMap() {
            // A fixed key order, so a re-recorded executed/ file only differs where behaviour does.
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("retryLimit", retryLimit);
            map.put("backoff", backoff);
            map.put("idempotency", idempotency);
            map.put("ordering", ordering);
            map.put("schemaValidation", schemaValidation);
            map.put("deadLetter", deadLetter);
            map.put("replayAfterFix", replayAfterFix);
            return map;
        }
    }

    /**
     * A scenario from {@code scenarios/*.json}, whose id names its exported trace file. In-memory scenarios, such as
     * the differential test's combinations ({@code timeout-paid-all__retry0+no-deadLetter}), use {@link #fromMap}.
     */
    public static Scenario fromFile(Map<String, Object> json) {
        Object id = json.get("id");
        if (!(id instanceof String s && ID_SHAPE.matcher(s).matches())) {
            throw new IllegalArgumentException("Scenario " + id + ": id must be lowercase letters, digits and single hyphens");
        }
        return fromMap(json);
    }

    @SuppressWarnings("unchecked")
    public static Scenario fromMap(Map<String, Object> json) {
        Map<String, Object> f = (Map<String, Object>) json.getOrDefault("failures", Map.of());
        String refused = refusal(f);
        if (refused != null) throw new IllegalArgumentException("Scenario " + json.get("id") + ": " + refused);
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
                eventOf(f.get("schemaChange")),
                eventOf(f.get("poison")));

        if (failures.poisonEvent() != null && failures.poisonEvent().equals(failures.schemaChangeEvent())) {
            throw new IllegalArgumentException("Scenario " + json.get("id")
                    + ": failures.poison and failures.schemaChange cannot target the same event (" + failures.poisonEvent() + ")");
        }

        Map<String, Object> g = (Map<String, Object>) json.getOrDefault("safeguards", Map.of());
        Safeguards safeguards;
        try {
            safeguards = new Safeguards(
                    ((Number) g.getOrDefault("retryLimit", 3)).intValue(),
                    shown(g.getOrDefault("backoff", "exponential")),
                    (Boolean) g.getOrDefault("idempotency", false),
                    (Boolean) g.getOrDefault("ordering", false),
                    (Boolean) g.getOrDefault("schemaValidation", false),
                    (Boolean) g.getOrDefault("deadLetter", true),
                    (Boolean) g.getOrDefault("replayAfterFix", false));
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException("Scenario " + json.get("id") + ": " + invalid.getMessage(), invalid);
        }

        return new Scenario((String) json.get("id"), ((Number) json.getOrDefault("order", 0)).intValue(),
                (String) json.get("title"), failures, safeguards,
                (Map<String, Object>) json.getOrDefault("expect", Map.of()));
    }

    /**
     * Why the engine would refuse these failures (engine.js refusal() checks the same rules in the same order, with the
     * same text), or null. The safeguards.backoff rule comes last, from the {@link Safeguards} constructor.
     */
    private static String refusal(Map<String, Object> f) {
        for (String kind : FAILURE_KINDS) {
            Object failure = f.get(kind);
            if (failure != null && !(field(failure, "event") instanceof String event && EVENT_TYPES.contains(event))) {
                return unsupported("failures." + kind + ".event", field(failure, "event"), "one of " + String.join(", ", EVENT_TYPES));
            }
        }
        Object timeout = f.get("timeout");
        Object attempts = field(timeout, "attempts");
        if (timeout != null && !"all".equals(attempts)
                && !(attempts instanceof List<?> list && !list.isEmpty() && list.stream().allMatch(Scenario::positiveInteger))) {
            return unsupported("failures.timeout.attempts", attempts, "\"all\" or a non-empty list of positive integers");
        }
        Object reorder = f.get("reorder");
        if (reorder != null && !(field(reorder, "delayMs") instanceof Number delay && delay.doubleValue() == REORDER_DELAY_MS)) {
            return unsupported("failures.reorder.delayMs", field(reorder, "delayMs"), REORDER_DELAY_MS + ", the one delay the Java runner takes");
        }
        return null;
    }

    private static String unsupported(String path, Object value, String expected) {
        return "Unsupported " + path + " \"" + shown(value) + "\"; expected " + expected;
    }

    private static Object field(Object failure, String name) {
        return failure instanceof Map<?, ?> m ? m.get(name) : null;
    }

    // JavaScript's Number.isInteger(n) && n > 0, for the numbers Jackson parses (500.0 is a whole number there too).
    private static boolean positiveInteger(Object n) {
        return n instanceof Number num && Double.isFinite(num.doubleValue()) && num.doubleValue() > 0
                && num.doubleValue() == Math.rint(num.doubleValue());
    }

    /** A JSON value as JavaScript's String() shows it, so a refusal reads the same on both sides. */
    static String shown(Object value) {
        return switch (value) {
            case null -> "null";
            case Double d when Double.isFinite(d) && d == Math.rint(d) && Math.abs(d) < 1e15 -> Long.toString(d.longValue());
            case List<?> list -> String.join(",", list.stream().map(e -> e == null ? "" : shown(e)).toList());
            case Map<?, ?> ignored -> "[object Object]";
            default -> value.toString();
        };
    }

    @SuppressWarnings("unchecked")
    private static String eventOf(Object failure) {
        return failure instanceof Map<?, ?> m ? (String) ((Map<String, Object>) m).get("event") : null;
    }
}
