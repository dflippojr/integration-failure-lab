package dev.dflippojr.lab;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

import tools.jackson.databind.ObjectMapper;

/**
 * With {@code --lab.differential-in=combos.json --lab.differential-out=outcomes.json}, runs every
 * combination in the file over real HTTP exactly as {@link ScenarioRunner} runs a scenario, writes each
 * normalised outcome and exits. scripts/differential.mjs diffs the file against the browser engine.
 * {@code --lab.differential-workers=n} (1-4) runs n combinations at a time in this JVM: each extra worker
 * is its own application context, with its own claim store, run context and loopback port.
 */
@Component
public class DifferentialRunner implements CommandLineRunner {

    private static final Logger log = LoggerFactory.getLogger(DifferentialRunner.class);

    private final ScenarioRunner runner;
    private final ScenarioFiles files;
    private final ObjectMapper json;
    private final LabProperties props;
    private final ConfigurableApplicationContext context;

    public DifferentialRunner(ScenarioRunner runner, ScenarioFiles files, ObjectMapper json, LabProperties props,
                              ConfigurableApplicationContext context) {
        this.runner = runner;
        this.files = files;
        this.json = json;
        this.props = props;
        this.context = context;
    }

    @Override
    public void run(String... args) throws Exception {
        if (props.differentialIn() == null) return;
        runBatch(Path.of(props.differentialIn()), Path.of(props.differentialOut()), props.differentialWorkers());
        System.exit(SpringApplication.exit(context, () -> 0));
    }

    /** Runs each combination in {@code in} (a JSON array of scenario objects) and writes {@code [{id, outcome}]} to {@code out}. */
    @SuppressWarnings("unchecked")
    public void runBatch(Path in, Path out, int workers) throws Exception {
        List<Map<String, Object>> combinations = json.readValue(in.toFile(), List.class);
        Map<String, Object>[] outcomes = new Map[combinations.size()];
        long start = System.nanoTime();
        List<ConfigurableApplicationContext> extra = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(workers);
        try {
            List<ScenarioRunner> runners = new ArrayList<>(List.of(runner));
            for (int i = 1; i < workers; i++) {
                ConfigurableApplicationContext worker = new SpringApplicationBuilder(LabApplication.class)
                        .logStartupInfo(false).run(timingArgs());
                extra.add(worker);
                runners.add(worker.getBean(ScenarioRunner.class));
            }
            AtomicInteger next = new AtomicInteger();
            List<Future<Void>> running = new ArrayList<>();
            for (ScenarioRunner each : runners) {
                running.add(pool.submit(() -> {
                    for (int i = next.getAndIncrement(); i < outcomes.length; i = next.getAndIncrement()) {
                        Map<String, Object> entry = new LinkedHashMap<>();
                        entry.put("id", combinations.get(i).get("id"));
                        entry.put("outcome", outcome(each, combinations.get(i)));
                        outcomes[i] = entry;
                    }
                    return null;
                }));
            }
            for (Future<Void> worker : running) {
                try {
                    worker.get();
                } catch (ExecutionException failed) {
                    throw failed.getCause() instanceof Exception cause ? cause : failed;
                }
            }
        } finally {
            pool.shutdownNow();
            extra.forEach(ConfigurableApplicationContext::close);
        }
        Path dir = out.toAbsolutePath().getParent();
        files.write(dir, out.getFileName().toString(), Arrays.asList(outcomes));
        log.info("Ran {} combinations on {} workers in {} s -> {}", outcomes.length, workers,
                (System.nanoTime() - start) / 1_000_000_000, out);
    }

    /** The extra workers run with this context's timings, and without a batch of their own. */
    private String[] timingArgs() {
        return new String[] {
            "--lab.scenarios-dir=" + props.scenariosDir(),
            "--lab.timeout-ms=" + props.timeoutMs(),
            "--lab.backoff-base-ms=" + props.backoffBaseMs(),
            "--lab.send-at-ms=" + props.sendAtMs().stream().map(String::valueOf).collect(Collectors.joining(",")),
            "--lab.reorder-delay-ms=" + props.reorderDelayMs(),
            "--lab.replay-delay-ms=" + props.replayDelayMs(),
        };
    }

    /** The normalised outcome, or {@code {error}} when the combination is refused or the run fails. */
    static Map<String, Object> outcome(ScenarioRunner runner, Map<String, Object> combination) throws InterruptedException {
        Scenario scenario;
        try {
            scenario = Scenario.fromMap(combination);
        } catch (IllegalArgumentException refused) {
            return Map.of("error", refused.getMessage());
        }
        try {
            return normalise(runner.run(scenario));
        } catch (RuntimeException failed) {
            log.warn("Combination {} failed", scenario.id(), failed);
            return Map.of("error", "run failed: " + failed.getMessage());
        }
    }

    /** {@code {record, dlq, dropped, buffered, verdict}} with event ids only; the same shape as test/differential/outcome.mjs. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> normalise(Map<String, Object> result) {
        Map<String, Object> record = (Map<String, Object>) result.get("record");
        List<String> applied = (List<String>) record.get("applied");
        List<String> dlq = ids(result.get("dlq"));
        List<String> buffered = ids(result.get("buffered"));
        String status = (String) record.get("status");
        long paidCents = ((Number) record.get("paidCents")).longValue();

        Map<String, Object> normalised = new LinkedHashMap<>();
        Map<String, Object> outRecord = new LinkedHashMap<>();
        outRecord.put("status", status);
        outRecord.put("paidCents", paidCents);
        outRecord.put("applied", applied);
        normalised.put("record", outRecord);
        normalised.put("dlq", dlq);
        normalised.put("dropped", ids(result.get("dropped")));
        normalised.put("buffered", buffered);
        normalised.put("verdict", Verdict.judge(status, paidCents, applied, dlq, buffered).asMap());
        return normalised;
    }

    @SuppressWarnings("unchecked")
    private static List<String> ids(Object entries) {
        return ((List<Map<String, Object>>) entries).stream().map(e -> (String) e.get("eventId")).toList();
    }
}
