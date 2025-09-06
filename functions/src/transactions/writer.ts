import { getDb, FieldValue } from "../shared/firestore.js";
import { acquireTxKey } from "../shared/idempotency.js";
import type { Transaction } from "./types.js";
import { enqueueProcessFinancials } from "./downstream.js";

export async function writeTransactionAndEnqueue(tx: Transaction) {
  const db = getDb();
  const txIdMaybe = await acquireTxKey(tx.dedupeKey);
  if (!txIdMaybe) return;
  const txId = txIdMaybe;

  await db.runTransaction(async (t) => {
    const ref = db.doc(`transactions/${txId}`);
    const snap = await t.get(ref);
    if (snap.exists) return;
    t.set(ref, { ...tx, createdAt: FieldValue.serverTimestamp() });
  });

  await enqueueProcessFinancials(txId);
}
