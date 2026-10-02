# Review Desk

Google Business Profile review replies in your voice. The local app is designed for a Windows desktop; a separately deployable Worker adds private online access, persistent storage, scheduled review checks, and optional Pub/Sub notifications.

## Run locally on Windows

1. Extract or clone the project.
2. Open PowerShell in the project folder.
3. Run `py -3 -m pip install -r requirements.txt`, then `py -3 server.py`.
4. Open <http://127.0.0.1:8080> and choose **Load sample reviews**.

The local service only listens on your computer. It creates `data.sqlite` and, after Google sign-in, `local-secrets.json`. Keep both private. Do not expose the local server to a network.

## Main features

1. Google sign-in with expiring OAuth state and PKCE.
2. Account and location discovery with per-location controls.
3. Review sync that preserves drafts and detects outside edits or replies.
4. Structured AI drafts based on business facts, response style, and owner examples.
5. A response library that learns from owner-approved wording without retaining customer review text in learned examples.
6. Complaint and sensitive wording triage before replies can be approved or published.
7. Automation modes for off, draft-only, or publishing with express consent.
8. Business hours, timezone, weekday, delay, and daily publishing cap controls.
9. Search and filters by status, location, and rating, plus sample workflow.
10. Recent insights, themes, staff mentions, response times, and activity history.

Automatic publishing checks the live Google review immediately before sending. It stops if the review changed or another reply already exists. Turning automation on excludes reviews already in the inbox.

## Connect Google and OpenAI locally

Google requires an approved Business Profile API project and eligible verified profiles. See [Google API prerequisites](https://developers.google.com/my-business/content/prereqs), [OAuth setup](https://developers.google.com/my-business/content/implement-oauth), and [review methods](https://developers.google.com/my-business/content/review-data).

1. Enable the Google My Business API, Account Management API, Business Information API, and Business Profile Notifications API in your Google Cloud project.
2. Create an OAuth Web client and add `http://127.0.0.1:8080/oauth/callback` as an authorised redirect URI.
3. Set keys in PowerShell before starting the server:

   ```powershell
   $env:GOOGLE_CLIENT_ID = 'YOUR_CLIENT_ID'
   $env:GOOGLE_CLIENT_SECRET = 'YOUR_CLIENT_SECRET'
   $env:OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY'
   py -3 server.py
   ```

4. In **Connections**, sign in, discover locations, enable the locations you want, and sync reviews.

Google OAuth apps in External / Testing can issue refresh tokens that expire after seven days. Google may reject API calls until the project is approved. No live API calls are included in the test suite.

## Online deployment

Use the [hosted deployment guide](hosted/README.md) for Cloudflare Worker setup. GitHub stores the source and runs automated checks; GitHub Pages alone cannot run the authenticated backend or scheduled jobs. A Sites project could not be created during this publish attempt because the account had reached its current hosting limit.

## Data and policy

The app caches Google review content temporarily for no more than 30 days. OpenAI is called only when drafting and the request sets `store: false`. Google requires specific express consent before automated replies. Review current [Business Profile API policies](https://developers.google.com/my-business/content/policies) before use.

## Tests

Run local tests from the project root:

```powershell
py -3 -m unittest -v test_server.py
```

Run Worker tests and regenerate its embedded UI from `hosted`:

```powershell
cd hosted
npm install
npm test
npm run build
```
