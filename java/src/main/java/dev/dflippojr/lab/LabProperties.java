package dev.dflippojr.lab;

import java.util.List;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Wall-clock timings for executed runs. They are shorter than the simulation's virtual timings
 * (2 s ack timeout, 1 s backoff base) so a full export takes seconds, and every exported trace
 * records the values it ran with.
 */
@ConfigurationProperties(prefix = "lab")
public record LabProperties(
        String scenariosDir,
        String exportDir,
        long timeoutMs,
        long backoffBaseMs,
        List<Long> sendAtMs,
        long reorderDelayMs) {

    public LabProperties {
        if (scenariosDir == null) scenariosDir = "../scenarios";
        if (timeoutMs <= 0) timeoutMs = 300;
        if (backoffBaseMs <= 0) backoffBaseMs = 150;
        if (sendAtMs == null || sendAtMs.isEmpty()) sendAtMs = List.of(0L, 40L, 80L);
        if (reorderDelayMs <= 0) reorderDelayMs = 200;
    }
}
