# Transactions Backend (Firebase Functions v2, TypeScript)

Minimal boilerplate to normalize payment events (Stripe/Apple/Google/RevenueCat) into `/transactions` and fan-out to commissions + 20/20/20/40 partner splits.

## Quick start
1) `cd functions && npm i`
2) Set env vars (`STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`).
3) `npm run build`
4) Deploy functions or run emulators.

### Functions exposed
- `stripeWebhook` (HTTPS) — handle Stripe events
- `appleAsn` (HTTPS) — handle App Store Server Notifications v2 (demo parser)
- `revenuecatWebhook` (HTTPS) — handle RevenueCat webhooks
- `processFinancials` (Task) — processes a transaction into commissions & partnerSplits

Replace placeholders (TENANT_UNKNOWN / pricing) with your catalog lookups.
