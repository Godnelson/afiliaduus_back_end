import * as admin from "firebase-admin";
import { FieldValue, Timestamp, Firestore } from "firebase-admin/firestore";

let app: admin.app.App | null = null;
export function getApp(): admin.app.App {
  if (!app) {
    app = admin.initializeApp();
  }
  return app;
}

export function getDb(): Firestore {
  return getApp().firestore();
}

export { FieldValue, Timestamp };
