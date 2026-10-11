package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;

/** Each sample starts a fresh JVM and server; opt into more with -Dlab.stress.runs=30. */
class ScenarioRunnerStressTest {

    @Test
    void transientTimeoutKeepsInitialEventsInOrder() throws Exception {
        int runs = Integer.getInteger("lab.stress.runs", 1);
        assertThat(runs).as("stress runs").isPositive();
        for (int i = 1; i <= runs; i++) {
            Path output = Files.createTempFile("lab-cold-sample-", ".log");
            Process sample = null;
            try {
                sample = new ProcessBuilder(
                        Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                        "-Xmx256m", "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                        ScenarioRunnerStressTest.class.getName(), String.valueOf(i))
                        .redirectErrorStream(true).redirectOutput(output.toFile()).start();
                assertThat(sample.waitFor(45, TimeUnit.SECONDS)).as("cold JVM sample %s finished", i).isTrue();
                String log = Files.readString(output);
                assertThat(sample.exitValue()).as("cold JVM sample %s: %s", i, log).isZero();
                System.out.print(log);
            } finally {
                if (sample != null && sample.isAlive()) sample.destroyForcibly().waitFor();
                Files.deleteIfExists(output);
            }
        }
        System.out.printf("1a-transient-timeout: %d/%d fresh-JVM real-HTTP runs passed%n", runs, runs);
    }

    public static void main(String[] args) throws Exception {
        int i = Integer.parseInt(args[0]);
        try (var context = SpringApplication.run(LabApplication.class,
                "--server.port=0", "--spring.main.banner-mode=off")) {
            ScenarioFiles files = context.getBean(ScenarioFiles.class);
            ScenarioRunner runner = context.getBean(ScenarioRunner.class);
            Scenario scenario = files.load().stream().filter(s -> s.id().equals("1a-transient-timeout")).findFirst().orElseThrow();
            Map<String, Object> result = runner.run(scenario);
            Map<?, ?> record = (Map<?, ?>) result.get("record");
            assertThat(record.get("applied")).as("run %s, trace: %s", i, result.get("trace"))
                    .isEqualTo(List.of("E1", "E2", "E3"));
            assertThat(record.get("status")).isEqualTo("Paid");
            assertThat(((Number) record.get("paidCents")).longValue()).isEqualTo(12000);
            assertThat((List<?>) result.get("dlq")).isEmpty();
            assertThat((List<?>) result.get("dropped")).isEmpty();
            System.out.printf("Cold JVM sample %d: warm-up POST %s ms; applied %s%n",
                    i, result.get("warmupMs"), record.get("applied"));
        }
    }
}
