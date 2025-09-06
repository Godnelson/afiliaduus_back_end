import type Stripe from "stripe";
import { Timestamp } from "../shared/firestore.js";
import type { Transaction } from "./types.js";

function sumFeeDetails(details?: Array<{amount:number}>): number {
  return (details || []).reduce((s, d) => s + (d.amount||0), 0);
}

export async function buildTxFromInvoice(inv: Stripe.Invoice): Promise<Transaction> {
  const charge = inv.charge as Stripe.Charge;
  const bt: any = charge && (charge as any).balance_transaction;
  const gross = bt?.amount ?? Math.round((inv.amount_paid || 0));
  const fee = (bt?.fee ?? 0) + sumFeeDetails(bt?.fee_details);
  const net = gross - fee;
  const occurredAtMs = (inv.status_transitions?.paid_at ? inv.status_transitions.paid_at*1000 : Date.now());

  return {
    tenantId: (inv.metadata as any)?.tenant_id || "TENANT_UNKNOWN",
    userUid:  (inv.metadata as any)?.user_uid || "USER_UNKNOWN",
    productId: inv.lines?.data?.[0]?.price?.id || "PRODUCT_UNKNOWN",
    platform: "stripe_web",
    event: inv.billing_reason === "subscription_cycle" ? "renewal" : "initial_purchase",
    storeIds: { stripe: {
      checkoutSessionId: (inv.metadata as any)?.checkout_session_id,
      invoiceId: inv.id, chargeId: charge?.id, balanceTransactionId: bt?.id
    }},
    monetary: { currency: (inv.currency as any) || "brl", grossCents: gross, feeCents: fee, netAfterFeesCents: net },
    occurredAt: Timestamp.fromMillis(occurredAtMs),
    dedupeKey: `invoice:${inv.id}`
  };
}

export async function buildTxFromCheckoutSession(s: Stripe.Checkout.Session): Promise<Transaction> {
  const currency = (s.currency as any) || "brl";
  const gross = Math.round((s.amount_total || 0));
  // fee/net only known after invoice/charge → here we use gross as placeholder
  return {
    tenantId: (s.metadata as any)?.tenant_id || "TENANT_UNKNOWN",
    userUid:  (s.metadata as any)?.user_uid || "USER_UNKNOWN",
    productId: (s.metadata as any)?.product_id || "PRODUCT_UNKNOWN",
    platform: "stripe_web",
    event: "initial_purchase",
    storeIds: { stripe: { checkoutSessionId: s.id } },
    monetary: { currency, grossCents: gross, netAfterFeesCents: gross },
    occurredAt: Timestamp.fromMillis(Date.now()),
    dedupeKey: `checkout:${s.id}`
  };
}
