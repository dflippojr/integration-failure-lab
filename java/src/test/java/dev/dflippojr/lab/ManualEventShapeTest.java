package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;

import org.assertj.core.api.InstanceOfAssertFactories;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.MediaType;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.web.client.RestClient;

/** Shapes of a manual event body, with no scenario run yet. Its own context: well-formed events here stay in the store. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
// BEFORE_CLASS: a context cached by an earlier class (ScenarioRunnerTest, say) holds that class's runs.
@DirtiesContext(classMode = DirtiesContext.ClassMode.BEFORE_CLASS)
class ManualEventShapeTest {

    @LocalServerPort
    int port;

    @Autowired
    ClaimStore store;

    @Test
    void bodyWithoutSeqIsRejected() {
        assertRejected("""
                {"eventId":"E9","type":"ClaimSubmitted","status":"Submitted","payload":{}}""");
    }

    @Test
    void bodyWithNonIntegerSeqIsRejected() {
        assertRejected("""
                {"eventId":"E9","type":"ClaimSubmitted","seq":"1","status":"Submitted","payload":{}}""");
    }

    @Test
    void bodyWithNonObjectPayloadIsRejected() {
        assertRejected("""
                {"eventId":"E9","type":"ClaimSubmitted","seq":1,"status":"Submitted","payload":"x"}""");
    }

    @Test
    void bodyWithNonStringEventIdIsRejected() {
        assertRejected("""
                {"eventId":5,"type":"ClaimSubmitted","seq":1,"status":"Submitted","payload":{}}""");
    }

    /** The other ways a body can miss the event's shape: each would crash, truncate or store a null. */
    @ParameterizedTest
    @ValueSource(strings = {
        "{\"eventId\":\"E9\",\"type\":\"ClaimSubmitted\",\"seq\":1.5,\"status\":\"Submitted\",\"payload\":{}}",
        "{\"eventId\":\"E9\",\"type\":\"ClaimSubmitted\",\"seq\":3000000000,\"status\":\"Submitted\",\"payload\":{}}",
        "{\"eventId\":\"E9\",\"type\":\"ClaimSubmitted\",\"seq\":1,\"status\":\"Submitted\",\"payload\":null}",
        "{\"eventId\":\"E9\",\"type\":\"ClaimSubmitted\",\"seq\":1,\"status\":\"Submitted\",\"payload\":[]}",
        "{\"type\":\"ClaimSubmitted\",\"seq\":1,\"status\":\"Submitted\",\"payload\":{}}",
        "{\"eventId\":\"E9\",\"seq\":1,\"status\":\"Submitted\",\"payload\":{}}",
        "{\"eventId\":\"E9\",\"type\":5,\"seq\":1,\"status\":\"Submitted\",\"payload\":{}}",
        "{\"eventId\":\"E9\",\"type\":\"ClaimSubmitted\",\"seq\":1,\"payload\":{}}",
        "{\"eventId\":\"E9\",\"type\":\"ClaimSubmitted\",\"seq\":1,\"status\":5,\"payload\":{}}"
    })
    void bodyWithAnyOtherBadFieldIsRejected(String body) {
        assertRejected(body);
    }

    @Test
    void jsonArrayBodyIsRejected() {
        assertRejected("[]");
    }

    @Test
    void nonIntegerAttemptIsRejected() {
        var before = store.record();
        assertThat(post("""
                {"eventId":"E9","type":"ClaimSubmitted","seq":1,"status":"Submitted","payload":{}}""", "one"))
                .isEqualTo(400);
        assertThat(store.record()).isEqualTo(before);
    }

    /** The default for an absent payload; a text paidAmount stays the poison 500, not a shape error. */
    @Test
    void shapeChecksLeaveWellFormedBodiesAlone() {
        assertThat(post("""
                {"eventId":"E2","type":"ClaimAccepted","seq":2,"status":"Accepted"}""", "1")).isEqualTo(200);
        assertThat(store.record().get("applied")).asInstanceOf(InstanceOfAssertFactories.LIST).contains("E2");
        assertThat(post("""
                {"eventId":"E3","type":"ClaimPaid","seq":3,"status":"Paid","payload":{"paidAmount":"x"}}""", "1"))
                .isEqualTo(500);
    }

    private void assertRejected(String body) {
        var before = store.record();
        assertThat(post(body, "1")).isEqualTo(400);
        assertThat(store.record()).isEqualTo(before);
    }

    private int post(String body, String attempt) {
        return RestClient.create("http://127.0.0.1:" + port).post()
                .uri("/claims/C-1001/events")
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Attempt", attempt)
                .body(body)
                .exchange((request, response) -> response.getStatusCode().value());
    }
}
