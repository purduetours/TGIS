# slack-import (Supabase Edge Function)

Powers the **Import new accounts** button on the Roster page. It finds Slack
workspace members whose email isn't in `guides`, and creates `guides` rows for
the ones a codirector/admin picks.

Only signed-in guides whose `guides.status` is **Codirector** or **Admin** can
use it (same list as `ROSTER_ROLES` in `index.html` and `get_roster()` in
`supabase/security.sql`).

## Deploy (Supabase dashboard, no command line needed)

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via editor**.
2. Name it exactly `slack-import`.
3. Replace the starter code with the contents of `index.ts` in this folder → **Deploy**.
4. Edge Functions → **Secrets** → add `SLACK_BOT_TOKEN` = the bot token from your
   Slack app (OAuth & Permissions → Bot User OAuth Token, starts with `xoxb-`).
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.
5. Leave **Verify JWT** on (the default) — the app sends the signed-in user's token.

The Slack bot needs the `users:read` and `users:read.email` scopes.

To update it later, open the function in the dashboard, paste the new `index.ts`,
and deploy again. (With the Supabase CLI: `supabase functions deploy slack-import`.)

## What it skips when scanning

Bots and apps, deactivated accounts, guests (single/multi-channel), members with
no email, and anyone whose email already matches a `guides` row.

## What "create" writes

`email`, `full_name`, `display_name`, `username`, `status`, `family`,
`slack_photo`. Other columns are left empty for the census / roster sync to fill.
