package dev.dflippojr.lab;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.springframework.stereotype.Component;

import tools.jackson.databind.ObjectMapper;

/** Loads {@code scenarios/*.json} and writes exported traces. */
@Component
public class ScenarioFiles {

    private final ObjectMapper json;
    private final LabProperties props;

    public ScenarioFiles(ObjectMapper json, LabProperties props) {
        this.json = json;
        this.props = props;
    }

    @SuppressWarnings("unchecked")
    public List<Scenario> load() throws IOException {
        try (Stream<Path> files = Files.list(Path.of(props.scenariosDir()))) {
            return files.filter(p -> p.toString().endsWith(".json"))
                    .map(p -> Scenario.fromMap(json.readValue(p.toFile(), Map.class)))
                    .sorted(Comparator.comparingInt(Scenario::order))
                    .toList();
        }
    }

    public void write(Path dir, String name, Object value) throws IOException {
        Files.createDirectories(dir);
        json.writerWithDefaultPrettyPrinter().writeValue(dir.resolve(name).toFile(), value);
    }
}
