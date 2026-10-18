package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import tools.jackson.databind.json.JsonMapper;

class ScenarioFilesTest {

    @TempDir
    Path scratch;

    private ScenarioFiles files(Path scenariosDir) {
        return new ScenarioFiles(JsonMapper.builder().build(),
                new LabProperties(scenariosDir.toString(), null, 0, 0, null, 0, 0, null, null, 0));
    }

    @Test
    void aScenarioWithAnEscapingIdFailsToLoad() throws IOException {
        Path scenarios = Files.createDirectories(scratch.resolve("scenarios"));
        Files.writeString(scenarios.resolve("lead4.json"),
                "{ \"id\": \"../lead4-escaped\", \"order\": 2, \"title\": \"lead4\", \"failures\": {}, \"safeguards\": {} }");
        assertThatThrownBy(() -> files(scenarios).load())
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Scenario ../lead4-escaped: id must be lowercase letters, digits and single hyphens");
    }

    @Test
    void writeRefusesNamesThatLeaveTheExportDirectory() {
        Path export = scratch.resolve("export");
        ScenarioFiles files = files(scratch);
        for (String name : new String[] {"../escaped.json", "sub/nested.json", ".."}) {
            assertThatThrownBy(() -> files.write(export, name, Map.of()))
                    .as(name)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageStartingWith("Refusing to write " + name + " outside ");
        }
        assertThat(scratch.resolve("escaped.json")).doesNotExist();
    }

    @Test
    void writeStillWritesPlainNamesIntoTheExportDirectory() throws IOException {
        Path export = scratch.resolve("export");
        files(scratch).write(export, "1a-transient-timeout.json", Map.of("ok", true));
        assertThat(export.resolve("1a-transient-timeout.json")).exists();
    }
}
