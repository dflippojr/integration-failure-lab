package dev.dflippojr.lab;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What the recordings check compares (scripts/recordings.mjs): a run's export without its wall-clock fields.
 * One definition for every test that compares a run with another run or with a committed recording.
 */
final class RecordingBehaviour {

    private RecordingBehaviour() {
    }

    /** The export, as parsed JSON or as {@link ScenarioRunner#run} returned it, without wall-clock fields. */
    static Object of(Object export) {
        if (!(export instanceof Map<?, ?> recording)) return export;
        Map<Object, Object> rest = new LinkedHashMap<>(recording);
        rest.keySet().removeAll(Set.of("generatedAt", "warmupMs", "runtime"));
        rest.computeIfPresent("trace", (k, trace) -> ((List<?>) trace).stream().map(row -> {
            Map<Object, Object> copy = new LinkedHashMap<>((Map<?, ?>) row);
            copy.remove("t");
            return copy;
        }).toList());
        return rest;
    }
}
