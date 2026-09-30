package dev.dflippojr.lab;

import org.springframework.stereotype.Component;

/**
 * The scenario currently being executed. The downstream reads its fault plan and safeguards from
 * here; runs are serialized by {@link ScenarioRunner}, so one run owns this at a time.
 */
@Component
public class RunContext {

    private volatile Scenario scenario;
    private volatile Trace trace;

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
