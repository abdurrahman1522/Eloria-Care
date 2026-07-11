# Deploying the bKash Payment Backend

This connects your real bKash merchant account to the "Buy Now → bKash"
option on your site. It requires a few one-time setup steps on your own
computer (I can't run these from here — they need your logged-in Firebase
CLI session).

## Before you start

- Your Firebase project must be on the **Blaze (pay-as-you-go) plan**.
  Go to Firebase Console → click the plan name (bottom-left) → upgrade.
  You still won't be charged unless usage is very high — Cloud Functions
  has a generous free tier.
- You'll need **Node.js** installed on your computer (v18 or newer):
  https://nodejs.org
- You'll need your **bKash merchant credentials**: app key, app secret,
  username, and password (from bKash's merchant/developer portal).

## Step 1 — Install the Firebase CLI

```
npm install -g firebase-tools
firebase login
```

This opens a browser window to log into the same Google account you use
for Firebase.

## Step 2 — Get the project files in place

Put these files/folders (all included in this delivery) into one folder
on your computer:
```
your-project-folder/
  firebase.json
  .firebaserc
  functions/
    index.js
    package.json
    .env.example
```

Inside that folder, install the function's dependencies:
```
cd functions
npm install
cd ..
```

## Step 3 — Set your bKash credentials as secrets

These are encrypted by Firebase and never appear in your code or in this
chat. Run each command — it'll prompt you to paste the value:

```
firebase functions:secrets:set BKASH_APP_KEY
firebase functions:secrets:set BKASH_APP_SECRET
firebase functions:secrets:set BKASH_USERNAME
firebase functions:secrets:set BKASH_PASSWORD
```

## Step 4 — Set the non-secret config

Copy `functions/.env.example` to `functions/.env`, and edit the values:
- `BKASH_BASE_URL` — leave as the sandbox URL for testing first
- `SITE_URL` — your real Vercel URL (e.g. `https://eloria-care.vercel.app`)
- `BKASH_CALLBACK_URL` — leave the placeholder for now; you'll fix this in Step 6

## Step 5 — First deploy

```
firebase deploy --only functions
```

This will print two URLs when it finishes, one for each function, like:
```
✔ functions[createBkashPayment(us-central1)] Successful create operation.
✔ functions[bkashCallback(us-central1)] Successful create operation.
Function URL (bkashCallback): https://us-central1-eloria-care.cloudfunctions.net/bkashCallback
```

## Step 6 — Fix the callback URL, then redeploy

Copy the exact `bkashCallback` URL Firebase just printed, paste it into
`functions/.env` as `BKASH_CALLBACK_URL`, then run:
```
firebase deploy --only functions
```
one more time so the function picks up the corrected value.

## Step 7 — Test it

1. Open your live site, sign in, go to any product, click **Buy Now**.
2. Choose **bKash**, confirm.
3. You should land on bKash's sandbox payment page. Use bKash's sandbox
   test wallet numbers (check your bKash merchant portal for these) to
   simulate a payment.
4. After paying, you should be redirected back to your site with a
   "Payment successful" message, and a new order should appear in
   Firestore's `orders` collection with `paymentMethod: "bkash"`.

## Step 8 — Go live

Once sandbox testing works end to end:
1. Change `BKASH_BASE_URL` in `functions/.env` to the production URL
   (commented out in `.env.example`).
2. Ask bKash to switch your merchant credentials from sandbox to live
   (this is a step on bKash's side, not something I can do).
3. Re-run `firebase deploy --only functions`.

## If something goes wrong

Check the function logs:
```
firebase functions:log
```

Common issues:
- **"Could not authenticate with bKash"** → double-check the 4 secrets
  are set correctly (`firebase functions:secrets:access BKASH_APP_KEY` to view).
- **Redirect loop or blank page after payment** → `BKASH_CALLBACK_URL`
  doesn't match what Firebase actually deployed; re-check Step 6.
- **CORS-looking errors in the browser console** → make sure your site's
  actual domain is what's calling the function; callable functions handle
  CORS automatically as long as you're using the Firebase SDK (which the
  site already does).
