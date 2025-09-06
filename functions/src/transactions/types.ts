import { Timestamp } from "../shared/firestore.js";

export type Currency = 'brl'|'usd'|'eur';
export type Platform = 'stripe_web'|'ios'|'android';
export type TxEvent = 'initial_purchase'|'renewal'|'refund'|'cancel'|'reactivation';

export interface Transaction {
  id?: string;
  tenantId: string;
  userUid: string;
  productId: string;
  platform: Platform;
  event: TxEvent;
  storeIds?: {
    ios?: { originalTransactionId: string; transactionId?: string };
    android?: { purchaseToken: string; orderId?: string; subscriptionId?: string };
    stripe?: { checkoutSessionId?: string; invoiceId?: string; chargeId?: string; balanceTransactionId?: string };
  };
  monetary: {
    currency: Currency;
    grossCents: number;
    feeCents?: number;
    netAfterFeesCents?: number;
  };
  occurredAt: Timestamp;
  dedupeKey: string;
  createdAt?: Timestamp;
}
