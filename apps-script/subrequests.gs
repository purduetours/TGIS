/**
 * Open sub requests endpoint for the TGIS mobile app (paste into TGIS Backend v3).
 *
 * Wire it into the existing doGet router, before the other `page` checks:
 *
 *   if (e.parameter.page === 'subrequests') return subrequestsResponse_();
 *
 * Returns { subrequests: [{ ts, text, requester, permalink }] } for every Slack
 * message timestamp in SR_PENDING_TS that is not also in SR_PROCESSED_TS.
 *
 * Needs:
 *   - SR_CHANNEL_ID below set to the #subrequests channel ID
 *     (Slack: open the channel → channel name → About → Channel ID, starts with C).
 *   - Bot token scopes: channels:history (groups:history if the channel is private),
 *     users:read. Add them under OAuth & Permissions, reinstall the app, and make
 *     sure the bot is a member of #subrequests.
 *   - A new deployment version (Deploy → Manage deployments → Edit → New version)
 *     so the live /exec URL picks up the change.
 */
const SR_CHANNEL_ID = 'C0000000000'; // TODO: #subrequests channel ID

function subrequestsResponse_() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('SLACK_BOT_TOKEN');
  const split = key => (props.getProperty(key) || '')
    .split(',').map(s => s.trim()).filter(s => s && s !== 'null');

  const processed = new Set(split('SR_PROCESSED_TS'));
  const pending = split('SR_PENDING_TS').filter(ts => !processed.has(ts));

  const cache = CacheService.getScriptCache();
  const out = [];
  pending.forEach(ts => {
    const cacheKey = 'sr_' + ts;
    let item = JSON.parse(cache.get(cacheKey) || 'null');
    if (!item) {
      const hist = slackGet_('conversations.history',
        { channel: SR_CHANNEL_ID, latest: ts, oldest: ts, inclusive: true, limit: 1 }, token);
      const msg = hist.ok && hist.messages && hist.messages.find(m => m.ts === ts);
      if (!msg) return; // deleted, or not in this channel
      const link = slackGet_('chat.getPermalink', { channel: SR_CHANNEL_ID, message_ts: ts }, token);
      item = {
        ts: ts,
        text: resolveMentions_(msg.text || '', token),
        requester: msg.user ? slackName_(msg.user, token) : (msg.username || null),
        permalink: link.ok ? link.permalink : null,
      };
      cache.put(cacheKey, JSON.stringify(item), 6 * 60 * 60); // 6h; message text rarely changes
    }
    out.push(item);
  });

  return ContentService.createTextOutput(JSON.stringify({ subrequests: out }))
    .setMimeType(ContentService.MimeType.JSON);
}

// <@U123> → <@U123|Display Name> so the app can show names.
function resolveMentions_(text, token) {
  return text.replace(/<@([A-Z0-9]+)>/g, (_, id) => '<@' + id + '|' + slackName_(id, token) + '>');
}

function slackName_(userId, token) {
  const cache = CacheService.getScriptCache();
  const key = 'su_' + userId;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = slackGet_('users.info', { user: userId }, token);
  const p = res.ok && res.user ? res.user.profile || {} : {};
  const name = p.display_name || p.real_name || (res.user && res.user.name) || 'someone';
  cache.put(key, name, 24 * 60 * 60);
  return name;
}

function slackGet_(method, params, token) {
  const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  const res = UrlFetchApp.fetch('https://slack.com/api/' + method + '?' + qs, {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  return JSON.parse(res.getContentText());
}
