import { stripeWebhook } from "./webhooks/stripe.js";
import { appleAsn } from "./webhooks/apple.js";
import { revenuecatWebhook } from "./webhooks/revenuecat.js";
import { processFinancials } from "./transactions/process.js";

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();

export { stripeWebhook, appleAsn, revenuecatWebhook, processFinancials };

const db = admin.firestore();

/** Descobre dados básicos do invite pelo token (sem login) */
export const resolveInvite = functions.https.onCall(async (data, _ctx) => {
    const { token } = data as { token: string };
    if (!token || typeof token !== 'string') {
        throw new functions.https.HttpsError('invalid-argument', 'token required');
    }

    const qs = await db.collectionGroup('invites').where('token', '==', token).limit(1).get();
    if (qs.empty) throw new functions.https.HttpsError('not-found', 'Invite not found');

    const inviteDoc = qs.docs[0];
    const invite = inviteDoc.data();
    const boardRef = inviteDoc.ref.parent.parent!;
    const boardId = boardRef.id;
    const boardSnap = await boardRef.get();
    if (!boardSnap.exists) throw new functions.https.HttpsError('failed-precondition', 'Board missing');

    const board = boardSnap.data() || {};
    const now = admin.firestore.Timestamp.now();
    const expiresAt = invite.expiresAt as admin.firestore.Timestamp | undefined;
    const redeemedAt = invite.redeemedAt as admin.firestore.Timestamp | undefined;

    return {
        boardId,
        boardName: board.name || 'Board',
        role: invite.role || 'member',
        expiresAt: expiresAt ? expiresAt.toMillis() : null,
        redeemed: !!redeemedAt,
        expired: !!(expiresAt && expiresAt.toMillis() < now.toMillis())
    };
});

/** Aceita convite (login obrigatório) e cria membership idempotente */
export const acceptInvite = functions.https.onCall(async (data, ctx) => {
    const uid = ctx.auth?.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required');

    const { token, boardId: providedBoardId } = data as { token: string; boardId?: string; };
    if (!token) throw new functions.https.HttpsError('invalid-argument', 'token required');

    const qs = await db.collectionGroup('invites').where('token', '==', token).limit(1).get();
    if (qs.empty) throw new functions.https.HttpsError('not-found', 'Invite not found');

    const inviteDoc = qs.docs[0];
    const invite = inviteDoc.data();
    const boardRef = inviteDoc.ref.parent.parent!;
    const boardId = boardRef.id;

    if (providedBoardId && providedBoardId !== boardId) {
        throw new functions.https.HttpsError('failed-precondition', 'Invite does not belong to provided board');
    }

    const now = admin.firestore.Timestamp.now();
    const expiresAt = invite.expiresAt as admin.firestore.Timestamp | undefined;
    const redeemedAt = invite.redeemedAt as admin.firestore.Timestamp | undefined;
    if (redeemedAt) {
        if (invite.redeemedBy === uid) return { ok: true, boardId };
        throw new functions.https.HttpsError('failed-precondition', 'Invite already used');
    }
    if (expiresAt && expiresAt.toMillis() < now.toMillis()) {
        throw new functions.https.HttpsError('deadline-exceeded', 'Invite expired');
    }

    const memberRef = db.doc(`boards/${boardId}/members/${uid}`);
    const role = invite.role || 'member';
    await db.runTransaction(async (tx) => {
        const m = await tx.get(memberRef);
        if (!m.exists) {
            tx.set(memberRef, { uid, role, joinedAt: now, boardId });
        }
        tx.update(inviteDoc.ref, { redeemedAt: now, redeemedBy: uid });
    });

    return { ok: true, boardId };
});

/** Delete recursivo de um board (admin/owner) */
export const recursiveDeleteBoard = functions.https.onCall(async (data, ctx) => {
    const uid = ctx.auth?.uid;
    if (!uid) throw new functions.https.HttpsError('unauthenticated', 'Login required');
    const { boardId } = data as { boardId: string };
    if (!boardId) throw new functions.https.HttpsError('invalid-argument', 'boardId required');

    const memberSnap = await db.doc(`boards/${boardId}/members/${uid}`).get();
    const role = memberSnap.get('role');
    if (!memberSnap.exists || !['owner', 'admin'].includes(role)) {
        throw new functions.https.HttpsError('permission-denied', 'Not allowed');
    }

    async function deleteCollection(path: string, batchSize = 300) {
        while (true) {
            const qs = await db.collection(path).limit(batchSize).get();
            if (qs.empty) break;
            const batch = db.batch();
            qs.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
        }
    }

    await deleteCollection(`boards/${boardId}/members`);
    await deleteCollection(`boards/${boardId}/invites`);
    await deleteCollection(`boards/${boardId}/tasks`);
    await deleteCollection(`boards/${boardId}/journals`);
    await db.doc(`boards/${boardId}`).delete();

    return { ok: true };
});
