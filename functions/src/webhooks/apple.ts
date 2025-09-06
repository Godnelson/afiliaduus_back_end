import { onRequest } from "firebase-functions/v2/https";
import { Timestamp } from "../shared/firestore.js";
import { writeTransactionAndEnqueue } from "../transactions/writer.js";

// Minimal parser (you must implement real JWS verification in production)
function parseAsnPayload(signedPayload: string) {
  const parts = signedPayload.split(".");
  const json = JSON.parse(Buffer.from(parts[1], "base64").toString());
  return json; // { notificationType, data: { signedTransactionInfo, ... } }
}

function mapAppleEvent(type: string): "initial_purchase"|"renewal"|"cancel"|"refund"|"reactivation" {
  if (type.includes("DID_RENEW")) return "renewal";
  if (type.includes("DID_CHANGE_RENEWAL_STATUS") || type.includes("DID_FAIL_TO_RENEW")) return "cancel";
  if (type.includes("REFUND")) return "refund";
  return "initial_purchase";
  }

export const appleAsn = onRequest(async (req, res) => {
  try {
    const { signedPayload } = req.body as { signedPayload: string };
    const p = parseAsnPayload(signedPayload);
    const nt = p?.notificationType || "";
    const transInfo = p?.data?.signedTransactionInfo ? JSON.parse(Buffer.from(p.data.signedTransactionInfo.split(".")[1], "base64").toString()) : null;
    const originalTransactionId = transInfo?.originalTransactionId || "UNKNOWN";
    const productId = transInfo?.productId || "PRODUCT_UNKNOWN";
    const occurredAtMs = Number(transInfo?.purchaseDate || Date.now());

    const tx = {
      tenantId: "TENANT_UNKNOWN",
      userUid: "USER_UNKNOWN",
      productId: productId,
      platform: "ios",
      event: mapAppleEvent(nt),
      storeIds: { ios: { originalTransactionId, transactionId: transInfo?.transactionId } },
      monetary: { currency: "brl", grossCents: 990, netAfterFeesCents: 990 },
      occurredAt: Timestamp.fromMillis(occurredAtMs),
      dedupeKey: `ios:orig:${originalTransactionId}:${occurredAtMs}`
    };

    await writeTransactionAndEnqueue(tx as any);
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.status(400).send("bad request");
  }
});
