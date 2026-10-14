package dev.dflippojr.lab;

import java.util.Map;

import org.springframework.stereotype.Component;

/**
 * The scenario currently being executed. The downstream reads its fault plan and safeguards from
 * here; runs are serialized by {@link ScenarioRunner}, so one run owns this at a time. Until a run
 * begins, a no-fault scenario with default safeguards applies, so the event endpoint works when the
 * app only serves the downstream.
 */
@Component
public class RunContext {

    private volatile Scenario scenario = Scenario.fromMap(Map.of("id", "manual"));
    private volatile Trace trace = new Trace();

    void begin(Scenario scenario, Trace trace) {
        this.scenario = scenario;
        this.trace = trace;
    }

    public Scenario scenario() {
        return scenario;
    }

    public Trace trace() {
        return trace;
    }
}
