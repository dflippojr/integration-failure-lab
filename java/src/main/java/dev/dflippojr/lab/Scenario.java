package dev.dflippojr.lab;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.HashMap;
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

    static final List<String> EVENT_TYPES = ClaimEvent.sequence().stream().map(ClaimEvent::type).toList();
    static final List<String> FAILURE_KINDS = List.of("timeout", "duplicate", "reorder", "schemaChange", "poison");
    // The engine's TIMING.reorderDelayMs, in its virtual ms. This runner delays by lab.reorder-delay-ms, whatever the
    // scenario says, so it refuses any other value rather than run a different delay from the engine's.
    static final int REORDER_DELAY_MS = 500;
    // The on/off safeguards and their defaults, in engine.js DEFAULT_SAFEGUARDS order, which is the order they are checked in.
    static final List<Map.Entry<String, Boolean>> TOGGLES = List.of(Map.entry("idempotency", false), Map.entry("ordering", false),
            Map.entry("schemaValidation", false), Map.entry("deadLetter", true), Map.entry("replayAfterFix", false));

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
        // Check the raw value, as the engine does: shown() would turn ["fixed"] into "fixed".
        Object backoff = g.getOrDefault("backoff", "exponential");
        if (!(backoff instanceof String name && Safeguards.BACKOFFS.contains(name))) {
            throw new IllegalArgumentException("Scenario " + json.get("id") + ": "
                    + unsupported("safeguards.backoff", backoff, "one of " + String.join(", ", Safeguards.BACKOFFS)));
        }
        // Then the retry limit and the on/off safeguards, as engine.js refusal() does. intValue() would wrap 4294967297 to 1.
        Object retryLimit = g.getOrDefault("retryLimit", 3);
        if (!(retryLimit instanceof Number n && (n.doubleValue() == 0 || positiveInteger(n)))) {
            throw new IllegalArgumentException("Scenario " + json.get("id") + ": "
                    + unsupported("safeguards.retryLimit", retryLimit, "a whole number from 0 to " + Integer.MAX_VALUE));
        }
        Map<String, Boolean> on = new HashMap<>();
        for (Map.Entry<String, Boolean> toggle : TOGGLES) {
            Object value = g.getOrDefault(toggle.getKey(), toggle.getValue());
            if (!(value instanceof Boolean b)) {
                throw new IllegalArgumentException("Scenario " + json.get("id") + ": "
                        + unsupported("safeguards." + toggle.getKey(), value, "true or false"));
            }
            on.put(toggle.getKey(), b);
        }
        Safeguards safeguards = new Safeguards(n.intValue(), name, on.get("idempotency"), on.get("ordering"),
                on.get("schemaValidation"), on.get("deadLetter"), on.get("replayAfterFix"));

        return new Scenario((String) json.get("id"), ((Number) json.getOrDefault("order", 0)).intValue(),
                (String) json.get("title"), failures, safeguards,
                (Map<String, Object>) json.getOrDefault("expect", Map.of()));
    }

    /**
     * Why the engine would refuse these failures (engine.js refusal() checks the same rules in the same order, with the
     * same text), or null. The same-event and safeguards rules come last, in {@link #fromMap}.
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

    // engine.js attemptNumber(): a whole number from 1 to Integer.MAX_VALUE, for the numbers Jackson parses (2.0 is a
    // whole number there too). The bound keeps intValue() from wrapping 4294967297 to attempt 1.
    private static boolean positiveInteger(Object n) {
        return n instanceof Number num && Double.isFinite(num.doubleValue()) && num.doubleValue() > 0
                && num.doubleValue() <= Integer.MAX_VALUE && num.doubleValue() == Math.rint(num.doubleValue());
    }

    /** A JSON value as JavaScript's String() shows it, so a refusal reads the same on both sides. */
    static String shown(Object value) {
        return switch (value) {
            case null -> "null";
            // The engine holds every JSON number as a double, so 12345678901234567890 reads 12345678901234567000 there too.
            case Number n -> numberShown(n.doubleValue());
            case List<?> list -> String.join(",", list.stream().map(e -> e == null ? "" : shown(e)).toList());
            case Map<?, ?> ignored -> "[object Object]";
            default -> value.toString();
        };
    }

    /**
     * JavaScript's Number::toString: the fewest significant digits that read back as x (the closest such digits when
     * there are several, the even ones on a tie), in plain decimal from 1e-7 up to 1e21 and in E-notation with a sign
     * outside that range. Double.toString differs in notation and, for some doubles, in digits: 4.9E-324 where
     * JavaScript writes 5e-324.
     */
    private static String numberShown(double x) {
        if (!Double.isFinite(x)) {
            return Double.toString(x); // NaN, Infinity and -Infinity are spelled the same on both sides
        }
        if (x == 0) {
            return "0"; // -0 too
        }
        if (x < 0) {
            return "-" + numberShown(-x);
        }
        // Double.toString's digits: the shortest that read back as x, but never fewer than two (4.9E-324). Rounding them
        // finds the same k digits as rounding x itself, since no shorter decimal lies between the two.
        BigDecimal shortest = BigDecimal.valueOf(x);
        BigDecimal digits = null;
        for (int k = 1; digits == null; k++) {
            // The nearest k digits first (the even ones on a tie, as the spec says), then the other neighbour.
            for (RoundingMode mode : List.of(RoundingMode.HALF_EVEN, RoundingMode.FLOOR, RoundingMode.CEILING)) {
                BigDecimal candidate = shortest.round(new MathContext(k, mode));
                if (digits == null && candidate.doubleValue() == x) {
                    digits = candidate.stripTrailingZeros();
                }
            }
        }
        String s = digits.unscaledValue().toString();
        int k = s.length();
        int n = k - digits.scale(); // x is 0.s times 10^n
        if (k <= n && n <= 21) {
            return s + "0".repeat(n - k);
        }
        if (0 < n && n <= 21) {
            return s.substring(0, n) + "." + s.substring(n);
        }
        if (-6 < n && n <= 0) {
            return "0." + "0".repeat(-n) + s;
        }
        String exponent = (n - 1 < 0 ? "e-" : "e+") + Math.abs(n - 1);
        return k == 1 ? s + exponent : s.charAt(0) + "." + s.substring(1) + exponent;
    }

    @SuppressWarnings("unchecked")
    private static String eventOf(Object failure) {
        return failure instanceof Map<?, ?> m ? (String) ((Map<String, Object>) m).get("event") : null;
    }
}
