# Hosted deployment

The hosted edition runs as a Cloudflare Worker with D1 storage. The GitHub repository stores source and runs tests; GitHub Pages cannot run the private API, scheduled jobs, or secret-protected Google/OpenAI calls.

## Deploy from Windows PowerShell

Use Node.js 22 or newer and Python 3.10 or newer.

1. Clone the repository, then open PowerShell in the project folder and enter `hosted`:

   ```powershell
   git clone https://github.com/EmeraldPathways/GMBautoreply.git
   cd GMBautoreply\hosted
   npm install
   npx wrangler login
   ```

2. Create the database and copy its returned ID into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`. Set `PUBLIC_BASE_URL` to the HTTPS Worker URL shown in your Cloudflare account. Keep the configured Worker name and URL aligned.

   ```powershell
   npx wrangler d1 create review-desk
   npx wrangler d1 migrations apply review-desk --remote
   ```

3. Create three values locally. Keep them private, and enter each value only when Wrangler prompts for it:

   ```powershell
   py -c "import secrets; print(secrets.token_urlsafe(32))"
   py -c "import secrets; print(secrets.token_urlsafe(48))"
   py -c "import base64,os; print(base64.b64encode(os.urandom(32)).decode())"
   ```

   Send the first value to `ADMIN_PASSWORD`, the second to `SESSION_SECRET`, and the third to `TOKEN_KEY`:

   ```powershell
   npx wrangler secret put ADMIN_PASSWORD
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put TOKEN_KEY
   ```

4. Request access for your Google Business Profile API project. Enable the Business Profile Account Management, Business Information, Reviews, and Notifications APIs. Create a Google OAuth Web client and register `https://YOUR-WORKER-DOMAIN/oauth/callback` as an authorised redirect URI. Add credentials and the OpenAI key as Worker secrets:

   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put OPENAI_API_KEY
   ```

   The app uses the `business.manage` scope. Google API project approval and an eligible, verified Business Profile are required for live account access. If the OAuth consent screen is in External / Testing, refresh tokens can expire after seven days.

5. Build and deploy:

   ```powershell
   npm run deploy
   ```

   Open the Worker URL, sign in with `ADMIN_PASSWORD`, connect Google, discover locations, enable the locations to manage, and sync reviews. The starter sample flow works before live API credentials are configured.

## Real-time notifications

Pub/Sub is optional; scheduled reconciliation still checks Google every five minutes. For push notifications, create a Google Cloud Pub/Sub topic and grant `mybusiness-api-pubsub@system.gserviceaccount.com` permission to publish to it. Create a push service account and authenticated push subscription that targets `https://YOUR-WORKER-DOMAIN/webhooks/pubsub`. Set its JWT audience to that exact URL and add these secrets:

```powershell
npx wrangler secret put PUBSUB_TOPIC
npx wrangler secret put PUSH_SERVICE_ACCOUNT
npx wrangler secret put PUSH_AUDIENCE
```

Grant the Pub/Sub service agent `roles/iam.serviceAccountTokenCreator` on the push service account. In **Connections**, choose **Enable review notifications**. Before changing any Google account setting, the app checks the current topic and refuses to replace a different one. Google permits one notification topic per account.

## Safeguards and data

- Access is protected by a password and signed, secure, HTTP-only session cookie. The session secret and Google refresh token encryption key are never sent to the browser.
- Google refresh tokens are encrypted in D1 with AES-GCM. Store the encryption key as a Worker secret and keep a recovery copy somewhere secure; losing it prevents token decryption.
- Pub/Sub requests require a valid Google-signed JWT with the configured audience and service account identity.
- Review replies are checked against the current Google review immediately before publishing. Existing replies and changed reviews stop publication.
- Auto-publishing starts only for reviews first observed after opt-in and requires express consent, safe-review checks, business hours, a delay, and a daily cap.
- Google review content is cached for at most 30 days. Analytics are calculated when requested rather than kept as long-term aggregates. OpenAI drafting uses structured output and `store: false`.
- The repository is public. Never commit API keys, OAuth secrets, generated passwords, D1 data, `.dev.vars`, or local `data.sqlite` files.

Google’s current rules require prior specific express consent for automated review replies and limit API content storage to 30 days. Read the [Business Profile API policies](https://developers.google.com/my-business/content/policies), [API prerequisites](https://developers.google.com/my-business/content/prereqs), [review methods](https://developers.google.com/my-business/content/review-data), [notification setup](https://developers.google.com/my-business/content/notification-setup), and [authenticated Pub/Sub push guidance](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions) before connecting an account.

## Verify

From the project root:

```powershell
py -3 -m unittest -v test_server.py
cd hosted
npm test
npm run build
```

The tests use temporary databases and mocked Google/OpenAI responses. They do not publish replies or require live API credentials.
