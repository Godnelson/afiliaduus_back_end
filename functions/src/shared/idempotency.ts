import { getDb, FieldValue } from "./firestore.js";

// Creates a lock document at /txKeys/{dedupeKey}. Returns a txId (doc id) if acquired or existing.
export async function acquireTxKey(dedupeKey: string): Promise<string | null> {
  const db = getDb();
  const keyRef = db.doc(`txKeys/${dedupeKey}`);
  let newTxId: string | null = null;
  await db.runTransaction(async (t) => {
    const snap = await t.get(keyRef);
    if (snap.exists) {
      newTxId = (snap.get("txId") as string) || null;
      return;
    }
    newTxId = db.collection("transactions").doc().id;
    t.set(keyRef, { txId: newTxId, createdAt: FieldValue.serverTimestamp() });
  });
  return newTxId;
}
