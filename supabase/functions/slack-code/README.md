# slack-code (Supabase Edge Function)

Powers **Get a code in Slack** on the sign-in screen: the TGIS Slack bot DMs the
guide a 6-digit code, and the app trades it for a normal sign-in. "Sign in with
Slack" stays available alongside it.

## Set up (Supabase dashboard)

1. **SQL Editor** → run step **2e** from `supabase/security.sql` (creates the
   `login_codes` table, readable only by the server).
2. **Edge Functions** → **Deploy a new function** → **Via editor** → name it exactly
   `slack-code` → paste `index.ts` → **Deploy**.
3. Open the function's **Details / Settings** and turn **Verify JWT** (a.k.a.
   "Enforce JWT verification") **off**. People aren't signed in yet when they use
   it; the function does its own checks.
4. Secrets: it uses the same `SLACK_BOT_TOKEN` you added for `slack-import`
   (Edge Function secrets are shared across functions), so nothing to add.
5. Slack bot scopes: `users:read`, `users:read.email`, **`chat:write`**. If
   `chat:write` is missing, add it under OAuth & Permissions and reinstall the app.

## Rules

- Codes are 6 digits, stored hashed, expire after 10 minutes, work once, and die
  after 5 wrong tries. A new code can be requested every 45 seconds.
- Codes only go to the Slack account whose email matches a non-retired `guides`
  row. Every other email gets the same "check Slack" response, so the screen can't
  be used to look up who is on the roster.
- The DM comes from the bot whose token is in `SLACK_BOT_TOKEN`.
