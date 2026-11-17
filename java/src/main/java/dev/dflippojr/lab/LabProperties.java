package dev.dflippojr.lab;

import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Wall-clock timings for executed runs: one timing model with the simulation (#197). By default the runner
 * runs the engine's virtual timings ({@code TIMING} in {@code engine/engine.js}) at {@code lab.time-scale}
 * of their length, 0.25 unless set, so a full export takes seconds: a 500 ms ack timeout, a 250 ms backoff
 * base, sends at 0/25/50 ms, a 125 ms reorder delay and a 1250 ms replay. Each default timing is
 * {@code Math.round(engine value × timeScale)}, the scale {@code npm run differential} checks over its
 * generated combinations. An explicit {@code lab.*-ms} property still wins over its scaled default, so a
 * test can pin its own timings. Every exported trace records the values it ran with and the scale, and
 * {@code test/timing-contract.test.js} checks each recording against {@code TIMING}.
 * {@code differentialIn}/{@code differentialOut} select the differential batch mode
 * ({@link DifferentialRunner}), run on {@code differentialWorkers} workers.
 */
@ConfigurationProperties(prefix = "lab")
public record LabProperties(
        String scenariosDir,
        String exportDir,
        double timeScale,
        long timeoutMs,
        long backoffBaseMs,
        List<Long> sendAtMs,
        long reorderDelayMs,
        long replayDelayMs,
        String differentialIn,
        String differentialOut,
        int differentialWorkers) {

    // The engine's TIMING (engine/engine.js), in its virtual ms. test/timing-contract.test.js fails when these and the
    // engine's drift apart, through the timings each recording in executed/ carries.
    static final long ENGINE_TIMEOUT_MS = 2000;            // TIMING.timeoutMs
    static final long ENGINE_BACKOFF_BASE_MS = 1000;       // TIMING.backoffBaseMs
    static final List<Long> ENGINE_SEND_AT_MS = List.of(0L, 100L, 200L); // TIMING.sendAt
    static final long ENGINE_REORDER_DELAY_MS = 500;       // TIMING.reorderDelayMs
    static final long ENGINE_REPLAY_DELAY_MS = 5000;       // TIMING.replayAfterMs

    /** The scale {@code npm run differential} has checked: the Java runner runs at a quarter of the engine's timings. */
    static final double DEFAULT_TIME_SCALE = 0.25;

    // The shortest positive engine timing (E2's send time): Math.round gives 0 below 0.5 ms, and a timing of 0 or less
    // reads as unset (#179), so a smaller scale cannot keep every scaled timing above 0.
    static final double MIN_TIME_SCALE = 0.5 / ENGINE_SEND_AT_MS.get(1);

    public LabProperties {
        if (scenariosDir == null) scenariosDir = "../scenarios";
        if (timeScale == 0) timeScale = DEFAULT_TIME_SCALE;
        if (!(timeScale >= MIN_TIME_SCALE) || Double.isInfinite(timeScale)) {
            throw new IllegalArgumentException("lab.time-scale must be a finite number of at least " + MIN_TIME_SCALE
                    + ", so every scaled engine timing stays above 0 ms; got " + timeScale);
        }
        if (timeoutMs <= 0) timeoutMs = scaled(ENGINE_TIMEOUT_MS, timeScale);
        if (backoffBaseMs <= 0) backoffBaseMs = scaled(ENGINE_BACKOFF_BASE_MS, timeScale);
        if (sendAtMs == null || sendAtMs.isEmpty()) {
            double scale = timeScale;
            sendAtMs = ENGINE_SEND_AT_MS.stream().map(time -> scaled(time, scale)).toList();
        } else {
            if (sendAtMs.size() != 3 || sendAtMs.stream().anyMatch(time -> time == null)) {
                throw new IllegalArgumentException("lab.send-at-ms must contain exactly three non-null emission times (E1, E2, E3)");
            }
            sendAtMs = List.copyOf(sendAtMs);
        }
        if (reorderDelayMs <= 0) reorderDelayMs = scaled(ENGINE_REORDER_DELAY_MS, timeScale);
        if (replayDelayMs <= 0) replayDelayMs = scaled(ENGINE_REPLAY_DELAY_MS, timeScale);
        if ((differentialIn == null) != (differentialOut == null)) {
            throw new IllegalArgumentException("lab.differential-in and lab.differential-out must be set together");
        }
        if (differentialWorkers == 0) differentialWorkers = 1;
        if (differentialWorkers < 1 || differentialWorkers > 4) {
            throw new IllegalArgumentException("lab.differential-workers must be between 1 and 4");
        }
        if (differentialIn != null && exportDir != null) {
            throw new IllegalArgumentException("lab.export-dir and lab.differential-in select different batch modes; set one");
        }
    }

    /** An engine timing at this scale, rounded half up as the engine's {@code Math.round} does. */
    static long scaled(long engineMs, double timeScale) {
        return Math.round(engineMs * timeScale);
    }
}
