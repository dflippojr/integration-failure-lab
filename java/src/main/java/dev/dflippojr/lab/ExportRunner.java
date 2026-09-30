package dev.dflippojr.lab;

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
 * With {@code --lab.export-dir=path}, executes every scenario once, writes {@code <id>.json} plus an
 * {@code index.json}, and exits. Without it, the app just serves the downstream for manual poking.
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
        Path out = Path.of(props.exportDir());
        List<Map<String, Object>> index = new ArrayList<>();
        for (Scenario scenario : files.load()) {
            Map<String, Object> result = runner.run(scenario);
            files.write(out, scenario.id() + ".json", result);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("scenarioId", scenario.id());
            entry.put("record", result.get("record"));
            index.add(entry);
            log.info("Executed {} -> {}", scenario.id(), result.get("record"));
        }
        files.write(out, "index.json", index);
        System.exit(SpringApplication.exit(context, () -> 0));
    }
}
