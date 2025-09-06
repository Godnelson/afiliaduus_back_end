export const ENV = {
  STRIPE_SECRET: process.env.STRIPE_SECRET || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  REGION: process.env.FUNCTIONS_REGION || "southamerica-east1",
  PROJECT_ID: process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || ""
};
