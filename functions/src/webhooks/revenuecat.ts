import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "../shared/firestore.js";
import { writeTransactionAndEnqueue } from "../transactions/writer.js";

function mapRcEvent(t: string): "initial_purchase"|"renewal"|"cancel"|"refund"|"reactivation" {
  if (t.includes("RENEWAL")) return "renewal";
  if (t.includes("CANCELLATION")) return "cancel";
  if (t.includes("UNCANCELLATION")) return "reactivation";
  if (t.includes("REFUND")) return "refund";
  return "initial_purchase";
}

export const revenuecatWebhook = onRequest(async (req, res) => {
  const ev = req.body;
  const productId = ev?.product_id || "PRODUCT_UNKNOWN";
  const appUserId = ev?.app_user_id || "USER_UNKNOWN";
  const eventId = ev?.event_id || `rc:${Date.now()}`;
  const occurredAtMs = (ev?.event_timestamp_ms || Date.now());

  const tx = {
    tenantId: "TENANT_UNKNOWN",
    userUid: appUserId,
    productId,
    platform: (ev?.platform === "ios") ? "ios" : "android",
    event: mapRcEvent(ev?.type || ""),
    storeIds: {},
    monetary: { currency: "brl", grossCents: 990, netAfterFeesCents: 990 },
    occurredAt: Timestamp.fromMillis(occurredAtMs),
    dedupeKey: `rc:event:${eventId}`
  };

  await writeTransactionAndEnqueue(tx as any);
  res.sendStatus(200);
});
