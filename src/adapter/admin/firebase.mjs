import { getApp } from "firebase-admin/app";
import { getFirestore, initializeFirestore } from "firebase-admin/firestore";

export const firestoreSymbol = Symbol();

export function firestore(options) {
  const appName = options?.server?.app || options?.app;
  const databaseId = options?.server?.databaseId;
  const app = getApp(appName);

  if (options?.server?.preferRest) {
    
    if (databaseId) {
      return initializeFirestore(app, {
        databaseId,
        preferRest: options?.server?.preferRest,
      });
    }

    return initializeFirestore(app, {
      preferRest: options?.server?.preferRest,
    });
  } else {
    if (databaseId) {
      return getFirestore(app, databaseId);
    }

    return getFirestore(app);
  }
}
