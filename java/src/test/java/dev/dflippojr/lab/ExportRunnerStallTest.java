package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.annotation.DirtiesContext;

import tools.jackson.databind.ObjectMapper;

/**
 * The export behind the required recordings check, on a machine that stalls: in every run the first E2 to
 * reach the store is held there past the 300 ms read timeout, as a busy machine or a paused JVM would. The
 * scenario injects no such delay, so the recordings must still be the committed ones, apart from wall-clock
 * timing. A stall is not behaviour.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class ExportRunnerStallTest {

    /** Past the 300 ms read timeout, even for 3a's E2, which is also delayed 200 ms on purpose. */
    static final long STALL_MS = 400;

    @Autowired
    ExportRunner export;

    @Autowired
    ObjectMapper json;

    @Test
    void aStalledHealthyRequestDoesNotChangeTheRecordings(@TempDir Path out) throws Exception {
        export.export(out);

        Path committed = Path.of("..", "executed");
        List<String> names;
        try (var files = Files.list(committed)) {
            names = files.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".json")).sorted().toList();
        }
        try (var files = Files.list(out)) {
            assertThat(files.map(p -> p.getFileName().toString()).sorted().toList()).isEqualTo(names);
        }
        for (String name : names) {
            assertThat(behaviour(out.resolve(name).toFile()))
                    .as("%s re-recorded on a stalling machine", name)
                    .isEqualTo(behaviour(committed.resolve(name).toFile()));
        }
    }

    /** What the recordings check compares (scripts/recordings.mjs): everything but wall-clock fields. */
    private Object behaviour(File file) {
        Object value = json.readValue(file, Object.class);
        if (!(value instanceof Map<?, ?> recording)) return value;
        Map<Object, Object> rest = new LinkedHashMap<>(recording);
        rest.keySet().removeAll(Set.of("generatedAt", "warmupMs", "runtime"));
        rest.computeIfPresent("trace", (k, trace) -> ((List<?>) trace).stream().map(row -> {
            Map<Object, Object> copy = new LinkedHashMap<>((Map<?, ?>) row);
            copy.remove("t");
            return copy;
        }).toList());
        return rest;
    }

    /** Holds the first E2 that reaches the store in each run, the discarded warm-up run included. */
    static class StallingClaimStore extends ClaimStore {
        private final Set<Long> stalled = ConcurrentHashMap.newKeySet();

        @Override
        public Outcome receive(ClaimEvent event, Scenario.Safeguards guards, Trace trace, long runEpoch) {
            if (event.seq() == 2 && stalled.add(runEpoch)) {
                try {
                    Thread.sleep(STALL_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("Interrupted while stalling E2", interrupted);
                }
            }
            return super.receive(event, guards, trace, runEpoch);
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class StallConfiguration {
        @Bean
        @Primary
        StallingClaimStore stallingClaimStore() {
            return new StallingClaimStore();
        }
    }
}
