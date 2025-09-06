// For simplicity, we call the handler directly.
// You can swap this to Cloud Tasks later.
import { processFinancialsHandler } from "./process.js";

export async function enqueueProcessFinancials(txId: string) {
  await processFinancialsHandler(txId);
}
