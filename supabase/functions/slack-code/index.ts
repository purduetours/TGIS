// Supabase Edge Function: slack-code
//
// Passwordless sign-in: the TGIS Slack bot DMs a guide a 6-digit code, and the
// app trades the code for a normal Supabase session. Runs alongside "Sign in
// with Slack" for people who don't know their Slack password.
//
//   POST { action: "send",   email }        → { ok: true }               (always, for any email)
//   POST { action: "verify", email, code }  → { token_hash }             (app calls auth.verifyOtp with it)
//
// Secrets (Supabase → Edge Functions → Secrets): SLACK_BOT_TOKEN (same as slack-import).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Slack scopes needed on the bot: users:read, users:read.email, chat:write.
// Table: public.login_codes (supabase/security.sql step 2e).

import { createClient } from "jsr:@supabase/supabase-js@2";

const CODE_TTL_MIN = 10;     // code lifetime
const MAX_ATTEMPTS = 5;      // wrong guesses before the code is dead
const RESEND_AFTER_S = 45;   // minimum gap between codes for one email

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const norm = (email: unknown) => String(email ?? "").trim().toLowerCase();

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Hash with the service key as a pepper so a leaked table row can't be brute-forced offline.
const hashCode = (email: string, code: string) =>
  sha256(`${email}:${code}:${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`);
function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function newCode() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

async function slack(method: string, token: string, body: Record<string, unknown> | null, query = "") {
  const res = await fetch(`https://slack.com/api/${method}${query}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: { action?: string; email?: string; code?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const email = norm(body.email);
  if (!email || !email.includes("@") || email.length > 254) return json({ error: "Enter your email address." }, 400);

  // ── Send a code ────────────────────────────────────────────────────────────
  if (body.action === "send") {
    // Same answer whether or not the email is a guide, so this can't be used to probe the roster.
    const ok = json({ ok: true });

    const { data: existing } = await admin.from("login_codes").select("created_at").eq("email", email).maybeSingle();
    if (existing && Date.now() - new Date(existing.created_at).getTime() < RESEND_AFTER_S * 1000) {
      return json({ error: `Please wait a moment before asking for another code.` }, 429);
    }

    const { data: guide, error: gErr } = await admin.from("guides").select("email, status").ilike("email", email).maybeSingle();
    if (gErr) return json({ error: `Couldn't check that email: ${gErr.message}` }, 500);
    if (!guide || guide.status === "Retired") return ok;

    const token = Deno.env.get("SLACK_BOT_TOKEN");
    if (!token) return json({ error: "SLACK_BOT_TOKEN secret is not set on this function" }, 500);
    const who = await slack("users.lookupByEmail", token, null, `?email=${encodeURIComponent(email)}`);
    if (!who.ok) {
      if (who.error === "users_not_found") return ok;   // guide email isn't on Slack
      return json({ error: `Slack: ${who.error}${who.needed ? ` (needs ${who.needed})` : ""}` }, 502);
    }

    const code = newCode();
    const { error: upErr } = await admin.from("login_codes").upsert({
      email,
      code_hash: await hashCode(email, code),
      expires_at: new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString(),
      attempts: 0,
      created_at: new Date().toISOString(),
    });
    if (upErr) return json({ error: `Couldn't save the code: ${upErr.message}` }, 500);

    const msg = await slack("chat.postMessage", token, {
      channel: who.user.id,
      text: `Your TGIS sign-in code is ${code}. It expires in ${CODE_TTL_MIN} minutes.`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Your *TGIS* sign-in code:\n*${code.slice(0, 3)} ${code.slice(3)}*` } },
        { type: "context", elements: [{ type: "mrkdwn", text: `Expires in ${CODE_TTL_MIN} minutes. If you didn't try to sign in, you can ignore this.` }] },
      ],
    });
    if (!msg.ok) {
      await admin.from("login_codes").delete().eq("email", email);
      return json({ error: `Slack: ${msg.error}${msg.needed ? ` (needs ${msg.needed})` : ""}` }, 502);
    }
    return ok;
  }

  // ── Verify a code ──────────────────────────────────────────────────────────
  if (body.action === "verify") {
    const code = String(body.code ?? "").replace(/\D/g, "");
    const bad = (m = "That code isn't right or has expired. Request a new one.") => json({ error: m }, 400);
    if (code.length !== 6) return bad("Enter the 6-digit code from Slack.");

    const { data: row } = await admin.from("login_codes").select("*").eq("email", email).maybeSingle();
    if (!row || new Date(row.expires_at).getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) return bad();

    await admin.from("login_codes").update({ attempts: row.attempts + 1 }).eq("email", email);
    if (!sameString(await hashCode(email, code), row.code_hash)) {
      return bad(row.attempts + 1 >= MAX_ATTEMPTS ? "Too many tries. Request a new code." : "That code isn't right. Check Slack and try again.");
    }
    await admin.from("login_codes").delete().eq("email", email);

    // Mint a one-time sign-in token for this email (no email is sent). Creates the
    // auth user first if this guide has never signed in before.
    let link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    if (link.error) {
      const created = await admin.auth.admin.createUser({ email, email_confirm: true });
      if (created.error && !/already/i.test(created.error.message)) return json({ error: `Couldn't sign you in: ${created.error.message}` }, 500);
      link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    }
    if (link.error || !link.data?.properties?.hashed_token) return json({ error: `Couldn't sign you in: ${link.error?.message ?? "no token"}` }, 500);
    return json({ token_hash: link.data.properties.hashed_token });
  }

  return json({ error: "Unknown action" }, 400);
});
