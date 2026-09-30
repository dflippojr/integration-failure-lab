package dev.dflippojr.lab;

import java.util.List;
import java.util.Map;

/** One synthetic claim event. {@code payload} is what goes over the wire and may break the contract. */
public record ClaimEvent(String eventId, String type, int seq, String claimId, String status, Map<String, Object> payload) {

    public static final String CLAIM_ID = "C-1001";
    public static final int AMOUNT_CENTS = 12_000;

    public static List<ClaimEvent> sequence() {
        return List.of(
                new ClaimEvent("E1", "ClaimSubmitted", 1, CLAIM_ID, "Submitted", Map.of()),
                new ClaimEvent("E2", "ClaimAccepted", 2, CLAIM_ID, "Accepted", Map.of()),
                new ClaimEvent("E3", "ClaimPaid", 3, CLAIM_ID, "Paid", Map.of("paidAmount", AMOUNT_CENTS)));
    }

    public ClaimEvent withPayload(Map<String, Object> newPayload) {
        return new ClaimEvent(eventId, type, seq, claimId, status, newPayload);
    }
}
