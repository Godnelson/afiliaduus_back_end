import { stripeWebhook } from "./webhooks/stripe.js";
import { appleAsn } from "./webhooks/apple.js";
import { revenuecatWebhook } from "./webhooks/revenuecat.js";
import { processFinancials } from "./transactions/process.js";
import { Resend } from "resend";
import { z } from "zod";
import crypto from "crypto";

import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { onCall } from "firebase-functions/v2/https";

admin.initializeApp();

export { stripeWebhook, appleAsn, revenuecatWebhook, processFinancials };

const db = admin.firestore();

const INVITE_TTL_DAYS = 7;

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

function now() { return admin.firestore.Timestamp.now(); }
function tsPlusDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return admin.firestore.Timestamp.fromDate(d);
}
function normalizeEmail(email: string) { return email.trim().toLowerCase(); }

async function isBoardAdmin(boardId: string, uid: string) {
  const snap = await db.doc(`boards/${boardId}/members/${uid}`).get();
  return snap.exists && ["owner","admin"].includes((snap.data() as any)?.role);
}

// --------- 3.1 createInvite (callable) ----------
export const createInvite = onCall({ cors: true, region: "southamerica-east1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new functions.https.HttpsError("unauthenticated", "login primeiro");

  const schema = z.object({
    boardId: z.string().min(1),
    email: z.string().email(),
    role: z.enum(["admin","member"]).default("member"),
  });
  const { boardId, email, role } = schema.parse(req.data);

  if (!(await isBoardAdmin(boardId, uid))) {
    throw new functions.https.HttpsError("permission-denied", "Sem permissão");
  }

  const token = crypto.randomBytes(24).toString("hex");
  const inviteRef = db.collection(`boards/${boardId}/invites`).doc();

  await inviteRef.set({
    email: normalizeEmail(email),
    role,
    invitedBy: uid,
    token,
    status: "pending",
    createdAt: now(),
    expireAt: tsPlusDays(INVITE_TTL_DAYS),
  });

  return { inviteId: inviteRef.id };
});

// --------- 3.2 Disparo de e-mail ao criar invite ----------
export const onInviteCreatedSendEmail = onDocumentCreated(
  {
    document: "boards/{boardId}/invites/{inviteId}",
    region: "southamerica-east1",
    secrets: ["RESEND_API_KEY", "APP_BASE_URL"],
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    if (data.status !== "pending") return;

    const resend = new Resend(process.env.RESEND_API_KEY as string);
    const boardId = event.params.boardId;
    const appBase = process.env.APP_BASE_URL as string;

    // Link de aceite: web -> app
    const acceptUrl = `${appBase}/invite?token=${encodeURIComponent(data.token)}&board=${encodeURIComponent(boardId)}`;

    const html = `
      <div style="font-family:Arial,sans-serif">
        <h2>Você foi convidado para um board</h2>
        <p><b>Board:</b> ${boardId}</p>
        <p><b>Papel:</b> ${data.role}</p>
        <p>Convite expira em ${INVITE_TTL_DAYS} dias.</p>
        <p><a href="${acceptUrl}" style="background:#000;color:#fff;padding:12px 18px;text-decoration:none;border-radius:8px">Aceitar convite</a></p>
        <p>Se o botão não funcionar, copie e cole no navegador:<br>${acceptUrl}</p>
      </div>
    `;

    await resend.emails.send({
      from: "Convites <convite@seu-dominio.com>",
      to: data.email,
      subject: "Convite para participar do board",
      html,
    });
  }
);

// --------- 3.3 acceptInvite (callable) ----------
export const acceptInvite = onCall({ cors: true, region: "southamerica-east1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new functions.https.HttpsError("unauthenticated", "Faça login para aceitar o convite.");

  const schema = z.object({
    boardId: z.string().min(1),
    token: z.string().min(10),
  });
  const { boardId, token } = schema.parse(req.data);

  // Busca invite por token (index sugerido abaixo)
  const q = await db.collection(`boards/${boardId}/invites`)
                    .where("token", "==", token).limit(1).get();
  if (q.empty) throw new functions.https.HttpsError("not-found", "Convite inválido.");

  const inviteSnap = q.docs[0];
  const invite = inviteSnap.data() as any;

  if (invite.status !== "pending") {
    throw new functions.https.HttpsError("failed-precondition", "Convite não está mais pendente.");
  }
  if (invite.expireAt.toMillis() < Date.now()) {
    await inviteSnap.ref.update({ status: "expired" });
    throw new functions.https.HttpsError("deadline-exceeded", "Convite expirado.");
  }

  // Idempotência + transação
  await db.runTransaction(async (tx) => {
    const memberRef = db.doc(`boards/${boardId}/members/${uid}`);
    const memberSnap = await tx.get(memberRef);
    if (memberSnap.exists) {
      // já é membro -> só marca o invite como accepted
      tx.update(inviteSnap.ref, { status: "accepted", acceptedAt: now(), acceptedBy: uid });
      return;
    }
    tx.set(memberRef, { role: invite.role, joinedAt: now() });
    tx.update(inviteSnap.ref, { status: "accepted", acceptedAt: now(), acceptedBy: uid });
  });

  return { ok: true };
});

// --------- 3.4 revokeInvite (opcional) ----------
export const revokeInvite = onCall({ cors: true, region: "southamerica-east1" }, async (req) => {
  const uid = req.auth?.uid;
  if (!uid) throw new functions.https.HttpsError("unauthenticated", "login");

  const schema = z.object({
    boardId: z.string().min(1),
    inviteId: z.string().min(1),
  });
  const { boardId, inviteId } = schema.parse(req.data);

  if (!(await isBoardAdmin(boardId, uid))) {
    throw new functions.https.HttpsError("permission-denied", "Sem permissão");
  }

  const ref = db.doc(`boards/${boardId}/invites/${inviteId}`);
  await ref.update({ status: "revoked" });
  return { ok: true };
});
function onDocumentCreated(arg0: { document: string; region: string; secrets: string[]; }, arg1: (event: any) => Promise<void>) {
    throw new Error("Function not implemented.");
}

