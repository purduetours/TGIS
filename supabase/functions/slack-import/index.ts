// Supabase Edge Function: slack-import
//
// Lets codirectors/admins find Slack workspace members who have no TGIS account
// and create guides rows for the ones they choose. Called from the Roster page's
// "Import new accounts" button.
//
//   POST { action: "scan" }                      → { members: [...], skipped: {...} }
//   POST { action: "create", accounts: [...] }   → { created: [...] }
//
// Secrets (Supabase → Edge Functions → Secrets): SLACK_BOT_TOKEN.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Slack scopes needed on the bot: users:read, users:read.email.

import { createClient } from "jsr:@supabase/supabase-js@2";

// Keep in sync with ROSTER_ROLES in index.html and get_roster() in security.sql.
const ADMIN_ROLES = ["Codirector", "Admin"];
const ALLOWED_STATUSES = ["Tour Guide", "Manager", "Codirector", "Admin", "Boss"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const norm = (email: unknown) => String(email ?? "").trim().toLowerCase();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // 1. Who is calling? Must be a signed-in Codirector/Admin.
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth, error: authErr } = await admin.auth.getUser(jwt);
  const callerEmail = norm(auth?.user?.email);
  if (authErr || !callerEmail) return json({ error: "Not signed in" }, 401);

  const { data: guides, error: gErr } = await admin.from("guides").select("email, status, username");
  if (gErr) return json({ error: `Couldn't read guides: ${gErr.message}` }, 500);
  const caller = (guides ?? []).find((g) => norm(g.email) === callerEmail);
  if (!caller || !ADMIN_ROLES.includes(caller.status)) return json({ error: "Codirectors and admins only" }, 403);

  const existingEmails = new Set((guides ?? []).map((g) => norm(g.email)).filter(Boolean));
  const existingUsernames = new Set((guides ?? []).map((g) => String(g.username ?? "").toLowerCase()).filter(Boolean));

  let body: { action?: string; accounts?: Record<string, unknown>[] } = {};
  try { body = await req.json(); } catch { /* empty body */ }

  // 2. Scan: Slack members whose email isn't in guides
  if (body.action === "scan") {
    const token = Deno.env.get("SLACK_BOT_TOKEN");
    if (!token) return json({ error: "SLACK_BOT_TOKEN secret is not set on this function" }, 500);

    const members: Record<string, unknown>[] = [];
    let cursor = "";
    do {
      const res = await fetch(`https://slack.com/api/users.list?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const page = await res.json();
      if (!page.ok) return json({ error: `Slack: ${page.error}${page.needed ? ` (needs ${page.needed})` : ""}` }, 502);
      members.push(...page.members);
      cursor = page.response_metadata?.next_cursor ?? "";
    } while (cursor);

    const skipped = { bots: 0, deactivated: 0, guests: 0, noEmail: 0, alreadyInTgis: 0 };
    const missing = [];
    for (const m of members as any[]) {
      if (m.is_bot || m.is_app_user || m.id === "USLACKBOT") { skipped.bots++; continue; }
      if (m.deleted) { skipped.deactivated++; continue; }
      if (m.is_restricted || m.is_ultra_restricted) { skipped.guests++; continue; }
      const email = norm(m.profile?.email);
      if (!email) { skipped.noEmail++; continue; }
      if (existingEmails.has(email)) { skipped.alreadyInTgis++; continue; }
      missing.push({
        slack_id: m.id,
        email,
        full_name: m.profile?.real_name || m.real_name || m.name,
        display_name: m.profile?.display_name || "",
        title: m.profile?.title || "",
        photo: m.profile?.image_192 || m.profile?.image_72 || null,
      });
    }
    missing.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
    return json({ members: missing, skipped });
  }

  // 3. Create: insert the chosen people into guides
  if (body.action === "create") {
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    if (!accounts.length) return json({ error: "No accounts given" }, 400);
    if (accounts.length > 200) return json({ error: "Too many accounts at once" }, 400);

    const rows = [];
    for (const a of accounts) {
      const email = norm(a.email);
      const full_name = String(a.full_name ?? "").trim();
      const display_name = String(a.display_name ?? "").trim();
      const username = String(a.username ?? "").trim().toLowerCase();
      const status = String(a.status ?? "Tour Guide");
      if (!email || !email.includes("@")) return json({ error: `Bad email: ${a.email}` }, 400);
      if (!full_name || !display_name || !username) return json({ error: `Name, display name and username are required (${email})` }, 400);
      if (!ALLOWED_STATUSES.includes(status)) return json({ error: `Unknown role: ${status}` }, 400);
      if (existingEmails.has(email)) return json({ error: `${email} already has a TGIS account` }, 409);
      if (existingUsernames.has(username)) return json({ error: `Username ${username} is already taken` }, 409);
      existingEmails.add(email);
      existingUsernames.add(username);
      rows.push({
        email, full_name, display_name, username, status,
        family: a.family ? String(a.family) : null,
        slack_photo: a.photo ? String(a.photo) : null,
      });
    }

    const { data, error } = await admin.from("guides").insert(rows).select("username, display_name, email");
    if (error) return json({ error: `Couldn't create accounts: ${error.message}` }, 500);
    return json({ created: data });
  }

  return json({ error: "Unknown action" }, 400);
});
