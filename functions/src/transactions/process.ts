import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getDb, FieldValue, Timestamp } from "../shared/firestore.js";
import { roundCents } from "../shared/money.js";

// Minimal settings accessors
async function getSettingsCommission() {
  const db = getDb();
  const snap = await db.doc("settings/commission").get();
  const d = snap.exists ? snap.data() : {};
  return {
    defaults: Object.assign({
      firstPct: 0.30, recurringPct: 0.15, months: 12, cookieTtlDays: 60, minPayoutCents: 20000, holdDays: 14, base: "net"
    }, d?.defaults || {})
  };
}
async function getSettingsPartnership() {
  const db = getDb();
  const snap = await db.doc("settings/partnership").get();
  const d = snap.exists ? snap.data() : {};
  return Object.assign({ shares: [], holdDaysPartners: 14 }, d || {});
}

// Very simple affiliate decision placeholder: take referral saved on user if any
async function decideAffiliateForTransaction(tx: any): Promise<{affiliateId?: string} | null> {
  const db = getDb();
  try {
    const refSnap = await db.doc(`users/${tx.userUid}/referral`).get();
    if (refSnap.exists && refSnap.data()?.affiliateId) return { affiliateId: refSnap.data()?.affiliateId };
  } catch {}
  return null;
}

// Simple recurrence inference: if there exists a previous tx for same user+product+platform, treat as renewal
async function inferRecurrenceAndRate(tx: any, sc: any) {
  // This placeholder returns first purchase always as 1
  const kind = (tx.event === "renewal") ? "recurring" : "first";
  const recurrenceNo = (tx.event === "renewal") ? 2 : 1;
  const rate = (kind === "first") ? sc.defaults.firstPct : sc.defaults.recurringPct;
  return { kind, recurrenceNo, rate };
}

export async function processFinancialsHandler(txId: string) {
  const db = getDb();
  const txRef = db.doc(`transactions/${txId}`);
  const txSnap = await txRef.get();
  if (!txSnap.exists) return;
  const tx = txSnap.data() as any;

  const sc = await getSettingsCommission();
  const sp = await getSettingsPartnership();

  const baseType = (tx.platform === "stripe_web" && sc.defaults.base === "net") ? "net" : "gross";
  const baseCents = baseType === "net" ? (tx.monetary.netAfterFeesCents ?? tx.monetary.grossCents) : tx.monetary.grossCents;
  const netAfterFees = tx.monetary.netAfterFeesCents ?? tx.monetary.grossCents;

  const aff = await decideAffiliateForTransaction(tx);
  const rec = await inferRecurrenceAndRate(tx, sc);
  const affiliateCents = (aff?.affiliateId && rec.rate > 0) ? Math.max(0, roundCents(baseCents * rec.rate)) : 0;
  const baseSoc = Math.max(0, netAfterFees - affiliateCents);

  await db.runTransaction(async (t) => {
    // Commission
    if (aff?.affiliateId && affiliateCents > 0) {
      const cRef = db.collection("commissions").doc();
      t.set(cRef, {
        tenantId: tx.tenantId, affiliateId: aff.affiliateId, userUid: tx.userUid, productId: tx.productId,
        txId, kind: rec.kind, recurrenceNo: rec.recurrenceNo, baseType, baseCents, rate: rec.rate, amountCents: affiliateCents,
        currency: tx.monetary.currency, status: "pending",
        holdUntil: Timestamp.fromMillis(Date.now() + sc.defaults.holdDays * 86400000),
        invoiceId: tx.storeIds?.stripe?.invoiceId, chargeId: tx.storeIds?.stripe?.chargeId, balanceTransactionId: tx.storeIds?.stripe?.balanceTransactionId,
        createdAt: FieldValue.serverTimestamp()
      });
      const balRef = db.doc(`affiliateBalances/${aff.affiliateId}`);
      t.set(balRef, { affiliateId: aff.affiliateId, currency: tx.monetary.currency, pendingCents: 0, availableCents: 0, paidCents: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: True });
      t.update(balRef, { pendingCents: FieldValue.increment(affiliateCents), updatedAt: FieldValue.serverTimestamp() });
    }

    // Partner splits
    const shares = Array.isArray(sp.shares) ? sp.shares : [];
    for (const s of shares) {
      const amount = roundCents(baseSoc * s.pct);
      const psRef = db.collection("partnerSplits").doc();
      t.set(psRef, {
        tenantId: tx.tenantId, partnerId: s.partnerId, userUid: tx.userUid, productId: tx.productId, txId,
        grossCents: tx.monetary.grossCents, stripeFeesCents: tx.monetary.feeCents ?? 0, netAfterFeesCents: netAfterFees,
        affiliateCents, baseSociedadeCents: baseSoc, sharePct: s.pct, amountCents: amount,
        currency: tx.monetary.currency, status: "pending",
        holdUntil: Timestamp.fromMillis(Date.now() + (sp.holdDaysPartners || 14) * 86400000),
        invoiceId: tx.storeIds?.stripe?.invoiceId, chargeId: tx.storeIds?.stripe?.chargeId, balanceTransactionId: tx.storeIds?.stripe?.balanceTransactionId,
        createdAt: FieldValue.serverTimestamp()
      });
      const pbRef = db.doc(`partnerBalances/${s.partnerId}`);
      t.set(pbRef, { partnerId: s.partnerId, currency: tx.monetary.currency, pendingCents: 0, availableCents: 0, paidCents: 0, updatedAt: FieldValue.serverTimestamp() }, { merge: True });
      t.update(pbRef, { pendingCents: FieldValue.increment(amount), updatedAt: FieldValue.serverTimestamp() });
    }
  });
}

export const processFinancials = onTaskDispatched({ region: "southamerica-east1", scheduleRetryConfig: { maxAttempts: 3 } }, async (req) => {
  const { txId } = (req.data as any) || {};
  if (!txId) return;
  await processFinancialsHandler(txId);
});
