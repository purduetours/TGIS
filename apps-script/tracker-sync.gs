/**
 * Tracker → Supabase sync (paste into TGIS Backend v3).
 *
 * The v4 app reads tour counts (career, semester, leaderboard, roster history)
 * from the Supabase `tracker` table. That table was copied from the Tracker
 * sheet once during the migration and nothing has updated it since, so counts
 * froze. This copies the sheet into the table on a timer.
 *
 * Setup:
 *   1. Set TRACKER_SPREADSHEET_ID and TRACKER_SHEET_NAME below (leave the ID ''
 *      if this script is bound to the spreadsheet that has the tracker tab).
 *   2. Run syncTrackerToSupabase once from the editor and read the execution log:
 *      it lists the columns it matched and any it skipped.
 *   3. Run installTrackerSyncTrigger once to keep it running every 15 minutes.
 *
 * Matching: sheet header cells are normalised the same way the table columns
 * are named ("Display Name" → display_name, "Fall 2026" → fall_2026, "Total" →
 * total). Headers with no matching table column are skipped and logged — when a
 * new semester starts, add its column in Supabase (Table Editor → tracker → add
 * column, type int8, default 0) and the next sync fills it.
 *
 * Rows are matched on display_name (must be the same as guides.display_name).
 * Uses the key in the SUPABASE_ANON_KEY property — after security step 3 that
 * is the service_role key, which this needs once step 4 locks the tables.
 */
const TRACKER_SPREADSHEET_ID = '';      // TODO: '' = this script's own spreadsheet
const TRACKER_SHEET_NAME = 'Tracker';   // TODO: exact tab name
const TRACKER_SUPABASE_URL = 'https://eaoxcfziynexsqviltzm.supabase.co';

function syncTrackerToSupabase() {
  const key = PropertiesService.getScriptProperties().getProperty('SUPABASE_ANON_KEY');
  const ss = TRACKER_SPREADSHEET_ID ? SpreadsheetApp.openById(TRACKER_SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TRACKER_SHEET_NAME);
  if (!sheet) throw new Error('No tab named "' + TRACKER_SHEET_NAME + '"');
  const values = sheet.getDataRange().getValues();

  // Header row = first row with a "display name" cell
  const ALIASES = { displayname: 'display_name', firstname: 'first_name', lastname: 'last_name' };
  const norm = h => {
    const n = String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return ALIASES[n] || n;
  };
  const headerIdx = values.findIndex(r => r.some(c => norm(c) === 'display_name'));
  if (headerIdx < 0) throw new Error('No "Display Name" header found in ' + TRACKER_SHEET_NAME);
  const headers = values[headerIdx].map(norm);

  // Columns that exist in the Supabase table
  const sample = sbTracker_('get', 'tracker?select=*&limit=1', key);
  if (!sample.length) throw new Error('tracker table is empty — can\'t read its columns');
  const tableCols = new Set(Object.keys(sample[0]));
  ['id', 'updated_at'].forEach(c => tableCols.delete(c));

  const used = [], skipped = [];
  headers.forEach((h, i) => {
    if (!h) return;
    if (tableCols.has(h) && !used.some(u => u.col === h)) used.push({ col: h, i });
    else skipped.push(values[headerIdx][i]);
  });
  const textCols = new Set(['display_name', 'first_name', 'last_name']);

  const rows = [];
  values.slice(headerIdx + 1).forEach(r => {
    const name = String(r[headers.indexOf('display_name')] || '').trim();
    if (!name) return;
    const row = {};
    used.forEach(({ col, i }) => {
      row[col] = textCols.has(col) ? String(r[i] ?? '').trim() : (Number(r[i]) || 0);
    });
    row.display_name = name;
    if (tableCols.has('updated_at')) row.updated_at = new Date().toISOString();
    rows.push(row);
  });

  // Upsert on display_name (security.sql step 2d adds the unique index this needs)
  for (let k = 0; k < rows.length; k += 200) {
    sbTracker_('post', 'tracker?on_conflict=display_name', key, rows.slice(k, k + 200));
  }
  Logger.log('Synced %s rows. Columns: %s. Skipped headers: %s',
    rows.length, used.map(u => u.col).join(', '), skipped.join(', ') || 'none');
}

function installTrackerSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncTrackerToSupabase')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncTrackerToSupabase').timeBased().everyMinutes(15).create();
}

function sbTracker_(method, path, key, body) {
  const res = UrlFetchApp.fetch(TRACKER_SUPABASE_URL + '/rest/v1/' + path, {
    method: method,
    contentType: 'application/json',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabase ' + res.getResponseCode() + ' on ' + path + ': ' + res.getContentText());
  }
  return method === 'get' ? JSON.parse(res.getContentText()) : null;
}
