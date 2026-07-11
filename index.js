/**
 * Eloria Care — bKash Tokenized Checkout backend
 * ------------------------------------------------
 * This runs on Firebase Cloud Functions (2nd gen), NOT in the browser.
 * Your bKash app key/secret/username/password live only here, as
 * environment variables — never in any HTML/JS file the browser can see.
 *
 * Flow:
 *  1. Frontend calls createBkashPayment (a "callable" function) with the
 *     cart/buy-now details. This function:
 *       - Grants a bKash auth token
 *       - Saves a "pending_orders" doc in Firestore with the real order
 *         details (so nothing about price/items can be tampered with
 *         by the customer's browser)
 *       - Asks bKash to create a payment session, tagging it with the
 *         pending order's ID
 *       - Returns the bKash checkout URL to the frontend, which redirects
 *         the customer there to actually pay
 *  2. Customer pays on bKash's own hosted page.
 *  3. bKash redirects the browser to bkashCallback (a plain HTTP function)
 *     with a paymentID and status in the URL.
 *  4. bkashCallback executes/confirms the payment with bKash, and — only
 *     if bKash confirms success — turns the pending order into a real
 *     order in the "orders" collection, then redirects the customer back
 *     to the site with a friendly confirmation.
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");

initializeApp();
const db = getFirestore();

// ---- bKash credentials & endpoints come from environment variables. ----
// Set these with (see DEPLOY.md for exact commands):
//   firebase functions:secrets:set BKASH_APP_KEY
//   firebase functions:secrets:set BKASH_APP_SECRET
//   firebase functions:secrets:set BKASH_USERNAME
//   firebase functions:secrets:set BKASH_PASSWORD
// BKASH_BASE_URL is not secret — set it as a plain env var in .env, e.g.:
//   Sandbox:    https://tokenized.sandbox.bka.sh/v1.2.0-beta
//   Production: https://tokenized.pay.bka.sh/v1.2.0-beta
const SECRETS = ["BKASH_APP_KEY", "BKASH_APP_SECRET", "BKASH_USERNAME", "BKASH_PASSWORD"];

function baseUrl() {
  return process.env.BKASH_BASE_URL || "https://tokenized.sandbox.bka.sh/v1.2.0-beta";
}

async function grantBkashToken() {
  const res = await fetch(`${baseUrl()}/tokenized/checkout/token/grant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "username": process.env.BKASH_USERNAME,
      "password": process.env.BKASH_PASSWORD,
    },
    body: JSON.stringify({
      app_key: process.env.BKASH_APP_KEY,
      app_secret: process.env.BKASH_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.id_token) {
    console.error("bKash grant token failed:", data);
    throw new HttpsError("internal", "Could not authenticate with bKash.");
  }
  return data.id_token;
}

// ---- 1. Create a bKash payment session ----
exports.createBkashPayment = onCall({ secrets: SECRETS }, async (request) => {
  const { amount, itemName, uid, items, address } = request.data;

  if (!request.auth || request.auth.uid !== uid) {
    throw new HttpsError("unauthenticated", "You must be signed in to pay.");
  }
  if (!amount || amount <= 0) {
    throw new HttpsError("invalid-argument", "Invalid order amount.");
  }

  // Save the real order details server-side BEFORE sending the customer to
  // bKash, so the amount/items can't be tampered with in the browser.
  const pendingRef = await db.collection("pending_orders").add({
    uid,
    items: items || [{ name: itemName, price: amount, qty: 1 }],
    total: amount,
    address: address || null,
    createdAt: FieldValue.serverTimestamp(),
  });

  const idToken = await grantBkashToken();

  const createRes = await fetch(`${baseUrl()}/tokenized/checkout/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": idToken,
      "X-APP-Key": process.env.BKASH_APP_KEY,
    },
    body: JSON.stringify({
      mode: "0011",
      payerReference: uid,
      callbackURL: `${process.env.BKASH_CALLBACK_URL}?pendingId=${pendingRef.id}`,
      amount: String(amount),
      currency: "BDT",
      intent: "sale",
      merchantInvoiceNumber: pendingRef.id,
    }),
  });
  const createData = await createRes.json();

  if (!createData.bkashURL) {
    console.error("bKash create payment failed:", createData);
    throw new HttpsError("internal", "Could not start bKash checkout.");
  }

  return { bkashURL: createData.bkashURL, pendingId: pendingRef.id };
});

// ---- 2. Handle bKash's redirect after the customer pays ----
exports.bkashCallback = onRequest({ secrets: SECRETS }, async (req, res) => {
  const { paymentID, status, pendingId } = req.query;
  const siteUrl = process.env.SITE_URL || "https://your-site.vercel.app";

  if (status !== "success" || !paymentID) {
    return res.redirect(`${siteUrl}/index.html?payment=cancelled`);
  }

  try {
    const idToken = await grantBkashToken();
    const executeRes = await fetch(`${baseUrl()}/tokenized/checkout/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": idToken,
        "X-APP-Key": process.env.BKASH_APP_KEY,
      },
      body: JSON.stringify({ paymentID }),
    });
    const executeData = await executeRes.json();

    if (executeData.transactionStatus !== "Completed") {
      console.error("bKash execute failed:", executeData);
      return res.redirect(`${siteUrl}/index.html?payment=failed`);
    }

    const pendingDoc = await db.collection("pending_orders").doc(pendingId).get();
    if (!pendingDoc.exists) {
      return res.redirect(`${siteUrl}/index.html?payment=error`);
    }
    const pending = pendingDoc.data();

    await db.collection("orders").add({
      uid: pending.uid,
      items: pending.items,
      total: pending.total,
      address: pending.address,
      paymentMethod: "bkash",
      bkashTrxID: executeData.trxID || null,
      status: "Order Placed",
      createdAt: FieldValue.serverTimestamp(),
    });
    await db.collection("pending_orders").doc(pendingId).delete();

    return res.redirect(`${siteUrl}/index.html?payment=success`);
  } catch (err) {
    console.error("bKash callback error:", err);
    return res.redirect(`${siteUrl}/index.html?payment=error`);
  }
});
