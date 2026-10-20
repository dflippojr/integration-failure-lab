package dev.dflippojr.lab;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

/**
 * With {@code --lab.export-dir=path}, warms up with one discarded run, executes every scenario once,
 * writes {@code <id>.json} plus an {@code index.json}, and exits. Without it, the app just serves the downstream for manual poking.
 */
@Component
public class ExportRunner implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(ExportRunner.class);

    private final ScenarioFiles files;
    private final ScenarioRunner runner;
    private final LabProperties props;
    private final ConfigurableApplicationContext context;

    public ExportRunner(ScenarioFiles files, ScenarioRunner runner, LabProperties props, ConfigurableApplicationContext context) {
        this.files = files;
        this.runner = runner;
        this.props = props;
        this.context = context;
    }

    @Override
    public void run(String... args) throws Exception {
        if (props.exportDir() == null) return;
        export(Path.of(props.exportDir()));
        System.exit(SpringApplication.exit(context, () -> 0));
    }

    /** Records every scenario into {@code out}, after one discarded warm-up run. */
    void export(Path out) throws IOException, InterruptedException {
        List<Scenario> scenarios = files.load();
        // A discarded first run: on a cold JVM the first scenario's requests can be slow enough to pass
        // the read timeout, so the first recording would show timeouts the scenario does not inject.
        runner.run(scenarios.getFirst(), ScenarioRunner.Timeouts.LOGICAL);
        List<Map<String, Object>> index = new ArrayList<>();
        for (Scenario scenario : scenarios) {
            // Logical timeouts: a recording shows the injected faults, not how busy the machine was.
            Map<String, Object> result = runner.run(scenario, ScenarioRunner.Timeouts.LOGICAL);
            files.write(out, scenario.id() + ".json", result);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("scenarioId", scenario.id());
            entry.put("record", result.get("record"));
            index.add(entry);
            log.info("Executed {} -> {}", scenario.id(), result.get("record"));
        }
        files.write(out, "index.json", index);
    }
}
