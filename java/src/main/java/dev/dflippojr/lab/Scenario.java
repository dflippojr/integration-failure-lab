package dev.dflippojr.lab;

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
    // The engine's TIMING.reorderDelayMs, in its virtual ms. This runner delays by lab.reorder-delay-ms (by default this
    // delay at lab.time-scale), whatever the scenario says, so it refuses any other value rather than run a different
    // delay from the engine's.
    static final int REORDER_DELAY_MS = (int) LabProperties.ENGINE_REORDER_DELAY_MS;
    // The highest of the engine's RETRY_LIMITS: the most retries ScenarioRunner.scenarioLimit() can finish, so both sides refuse more.
    static final int MAX_RETRY_LIMIT = 5;
    // The on/off safeguards and their defaults, in engine.js DEFAULT_SAFEGUARDS order, which is the order they are checked in.
    static final List<Map.Entry<String, Boolean>> TOGGLES = List.of(Map.entry("idempotency", false), Map.entry("ordering", false),
            Map.entry("schemaValidation", false), Map.entry("deadLetter", true), Map.entry("replayAfterFix", false));
    // The id of the one cross-field rule, engine/rules.js SAME_EVENT_RULE. Every other rule's id is the path of its field.
    static final String SAME_EVENT_RULE = "failures.poison+schemaChange";

    /**
     * A scenario that breaks a rule. {@link #rule()} is the rule's id, which engine/rules.js refusal() gives for the same
     * input and the differential compares (#198); the message is this runtime's own wording, after "Scenario &lt;id&gt;: ".
     */
    public static final class Refused extends IllegalArgumentException {
        private final String rule;

        Refused(Object id, String rule, String reason) {
            super("Scenario " + id + ": " + reason);
            this.rule = rule;
        }

        public String rule() {
            return rule;
        }
    }

    /** The first rule a scenario breaks: its id and why. */
    record Refusal(String rule, String reason) {
    }

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
            throw new Refused(id, "id", "id must be lowercase letters, digits and single hyphens");
        }
        return fromMap(json);
    }

    @SuppressWarnings("unchecked")
    public static Scenario fromMap(Map<String, Object> json) {
        Object rawFailures = section(json, "failures");
        Object rawSafeguards = section(json, "safeguards");
        Refusal refused = refusal(rawFailures, rawSafeguards);
        if (refused != null) throw new Refused(json.get("id"), refused.rule(), refused.reason());

        Map<String, Object> f = (Map<String, Object>) rawFailures;
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

        Map<String, Object> g = (Map<String, Object>) rawSafeguards;
        Map<String, Boolean> on = new HashMap<>();
        for (Map.Entry<String, Boolean> toggle : TOGGLES) {
            on.put(toggle.getKey(), (Boolean) g.getOrDefault(toggle.getKey(), toggle.getValue()));
        }
        Safeguards safeguards = new Safeguards(((Number) g.getOrDefault("retryLimit", 3)).intValue(),
                (String) g.getOrDefault("backoff", "exponential"), on.get("idempotency"), on.get("ordering"),
                on.get("schemaValidation"), on.get("deadLetter"), on.get("replayAfterFix"));

        return new Scenario((String) json.get("id"), ((Number) json.getOrDefault("order", 0)).intValue(),
                (String) json.get("title"), failures, safeguards,
                (Map<String, Object>) json.getOrDefault("expect", Map.of()));
    }

    /**
     * The first rule this scenario breaks, or null: engine/rules.js refusal() checks the same rules in the same order, so
     * both name the same rule id (#198). The reasons are each runtime's own; values here read as String.valueOf shows
     * them. Every rule checks the raw JSON value, as the engine does, so {@link #fromMap} only parses values already known
     * to be valid.
     */
    @SuppressWarnings("unchecked")
    static Refusal refusal(Object rawFailures, Object rawSafeguards) {
        if (!(rawFailures instanceof Map)) {
            return unsupported("failures", rawFailures, "an object");
        }
        if (!(rawSafeguards instanceof Map)) {
            return unsupported("safeguards", rawSafeguards, "an object");
        }
        Map<String, Object> f = (Map<String, Object>) rawFailures;
        Map<String, Object> g = (Map<String, Object>) rawSafeguards;
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
        // Every failure that is set has a known event by now.
        Object poisonEvent = field(f.get("poison"), "event");
        if (poisonEvent != null && poisonEvent.equals(field(f.get("schemaChange"), "event"))) {
            return new Refusal(SAME_EVENT_RULE, "failures.poison and failures.schemaChange cannot target the same event (" + poisonEvent + ")");
        }
        // The raw value: ["fixed"] is not "fixed" in the engine either.
        Object backoff = g.getOrDefault("backoff", "exponential");
        if (!(backoff instanceof String name && Safeguards.BACKOFFS.contains(name))) {
            return unsupported("safeguards.backoff", backoff, "one of " + String.join(", ", Safeguards.BACKOFFS));
        }
        Object retryLimit = g.getOrDefault("retryLimit", 3);
        if (!(retryLimit instanceof Number n && (n.doubleValue() == 0 || (positiveInteger(n) && n.doubleValue() <= MAX_RETRY_LIMIT)))) {
            return unsupported("safeguards.retryLimit", retryLimit, "a whole number from 0 to " + MAX_RETRY_LIMIT);
        }
        for (Map.Entry<String, Boolean> toggle : TOGGLES) {
            Object value = g.getOrDefault(toggle.getKey(), toggle.getValue());
            if (!(value instanceof Boolean)) {
                return unsupported("safeguards." + toggle.getKey(), value, "true or false");
            }
        }
        return null;
    }

    /** A failures or safeguards section, with null read as absent: engine.js run() reads {@code failures ?? {}}. */
    private static Object section(Map<String, Object> json, String name) {
        Object value = json.get(name);
        return value == null ? Map.of() : value;
    }

    private static Refusal unsupported(String path, Object value, String expected) {
        return new Refusal(path, "Unsupported " + path + " \"" + value + "\"; expected " + expected);
    }

    private static Object field(Object failure, String name) {
        return failure instanceof Map<?, ?> m ? m.get(name) : null;
    }

    // engine/rules.js attemptNumber(): a whole number from 1 to Integer.MAX_VALUE, for the numbers Jackson parses (2.0 is a
    // whole number there too). The bound keeps intValue() from wrapping 4294967297 to attempt 1.
    private static boolean positiveInteger(Object n) {
        return n instanceof Number num && Double.isFinite(num.doubleValue()) && num.doubleValue() > 0
                && num.doubleValue() <= Integer.MAX_VALUE && num.doubleValue() == Math.rint(num.doubleValue());
    }

    @SuppressWarnings("unchecked")
    private static String eventOf(Object failure) {
        return failure instanceof Map<?, ?> m ? (String) ((Map<String, Object>) m).get("event") : null;
    }
}
