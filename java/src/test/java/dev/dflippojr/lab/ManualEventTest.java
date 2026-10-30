package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.web.client.RestClient;

/** The app serving the downstream with no scenario run yet, as when --lab.export-dir is absent. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// BEFORE_CLASS: a context cached by an earlier class (ScenarioRunnerTest, say) holds that class's runs.
@DirtiesContext(classMode = DirtiesContext.ClassMode.BEFORE_CLASS)
class ManualEventTest {

    @LocalServerPort
    int port;

    @Autowired
    ClaimStore store;

    @Test
    void eventIsAppliedBeforeAnyScenarioRuns() {
        var response = RestClient.create("http://127.0.0.1:" + port).post()
                .uri("/claims/C-1001/events")
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Attempt", "1")
                .body(Map.of("eventId", "E1", "type", "ClaimSubmitted", "seq", 1,
                        "status", "Submitted", "payload", Map.of()))
                .retrieve().toBodilessEntity();

        assertThat(response.getStatusCode().value()).isEqualTo(200);
        assertThat(store.record().get("applied")).isEqualTo(List.of("E1"));
    }
}
