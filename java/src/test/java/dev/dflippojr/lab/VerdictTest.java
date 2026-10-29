package dev.dflippojr.lab;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;

import org.junit.jupiter.api.Test;

/** The port of engine/engine.js judge(): same problems, same wording, same order. */
class VerdictTest {

    @Test
    void correctRecordIsOkAndAnEmptyQueueIsNotVisible() {
        Verdict v = Verdict.judge("Paid", 12_000, List.of("E1", "E2", "E3"), List.of(), List.of());
        assertThat(v.ok()).isTrue();
        assertThat(v.visible()).isFalse();
        assertThat(v.problems()).isEmpty();
    }

    @Test
    void duplicatesAndMissingEventsAreReportedInEngineOrder() {
        Verdict v = Verdict.judge("Paid", 24_000, List.of("E1", "E3", "E3"), List.of("E2"), List.of());
        assertThat(v.ok()).isFalse();
        assertThat(v.visible()).isTrue();
        assertThat(v.problems()).containsExactly("ClaimPaid applied 2 times", "ClaimAccepted never applied",
                "paid $240.00 instead of $120.00");
    }

    @Test
    void outOfOrderEmptyStatusAndBufferedEventsUseEngineWording() {
        assertThat(Verdict.judge("Accepted", 12_000, List.of("E1", "E3", "E2"), List.of(), List.of()).problems())
                .containsExactly("applied out of order (ClaimSubmitted → ClaimPaid → ClaimAccepted)", "final status is Accepted, not Paid");
        assertThat(Verdict.judge(null, 0, List.of(), List.of(), List.of("E2", "E3")).problems()).containsExactly(
                "ClaimSubmitted never applied", "ClaimAccepted never applied", "ClaimPaid never applied",
                "final status is empty, not Paid", "paid $0.00 instead of $120.00",
                "ClaimAccepted stuck in the ordering buffer", "ClaimPaid stuck in the ordering buffer");
    }

    @Test
    void anUnknownEventIdThrows() {
        assertThatThrownBy(() -> Verdict.judge("Paid", 12_000, List.of("E9"), List.of(), List.of()))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("Unknown event E9");
        assertThatThrownBy(() -> Verdict.judge("Paid", 12_000, List.of("E1", "E2", "E3", "E9"), List.of(), List.of()))
                .isInstanceOf(IllegalArgumentException.class).hasMessage("Unknown event E9");
    }
}
