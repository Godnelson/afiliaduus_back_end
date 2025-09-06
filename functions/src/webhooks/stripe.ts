import Stripe from "stripe";
import { onRequest } from "firebase-functions/v2/https";
import { ENV } from "../env.js";
import { writeTransactionAndEnqueue } from "../transactions/writer.js";
import { buildTxFromInvoice, buildTxFromCheckoutSession } from "../transactions/normalize.js";

const stripe = new Stripe(ENV.STRIPE_SECRET || "", { apiVersion: "2024-06-20" });

export const stripeWebhook = onRequest({ region: ENV.REGION, secrets: ["STRIPE_WEBHOOK_SECRET"] }, async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event: Stripe.Event;

  try {
    // IMPORTANT: configure rawBody in emulator/hosting for signature verification
    // If raw body isn't enabled, skip verification ONLY in local dev.
    if (ENV.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.rawBody, sig as string, ENV.STRIPE_WEBHOOK_SECRET);
    } else {
      event = req.body as any;
    }
  } catch (e) {
    console.error("Stripe signature verify failed", e);
    res.status(400).send("Bad signature");
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        // Best practice: after invoice is generated, invoice handler will persist with balance_transaction.
        const tx = await buildTxFromCheckoutSession(s);
        await writeTransactionAndEnqueue(tx);
        break;
      }
      case "invoice.payment_succeeded": {
        const inv = event.data.object as Stripe.Invoice;
        // Expand charge.balance_transaction for fees/net
        const expanded = await stripe.invoices.retrieve(inv.id, { expand: ["charge.balance_transaction", "lines.data.price"] });
        const tx = await buildTxFromInvoice(expanded);
        await writeTransactionAndEnqueue(tx);
        break;
      }
      case "charge.refunded":
      case "invoice.payment_failed":
      case "charge.dispute.created":
        // TODO: create refund/cancel Transactions and downstream reversals
        break;
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("stripe webhook error", err);
    res.status(500).send("internal");
  }
});
