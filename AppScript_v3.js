/**
 * TGIS BACKEND — v3
 * 
 * WHAT'S NEW vs the original:
 *   - doGet: now returns fullLeaderboard (ALL guides, not just top 10)
 *     AND an adminView branch that returns the full tracker grid + counted tours log
 *   - NEW: autoCountCompletedTours() — time-triggered every 30 min,
 *     reads Tours tab, counts concluded tours, writes to Tracker
 *   - NEW: doPost handles admin actions (specialRequest, manualAdjust, rollover)
 *   - PRESERVED 100%: all original doGet logic, field names, response shape
 *
 * ONBOARDING SCRIPT IS SEPARATE — do not merge, leave that deployment alone.
 */

const SHEET_ID = '15Hq5veHVvxfgFNm4pRtxUZYfw1RhgG04le2RuCCCubY';

// ─── TOUR TYPE CONFIG ─────────────────────────────────────────────────────────
// start: [hour24, minute], duration: minutes until tour is considered concluded
const TOUR_CONFIG = {
  '9DV':  { start: [9,  30], duration: 105 }, // Daily Visit
  '0DV':  { start: [10, 30], duration: 105 }, // Daily Visit
  '0GV':  { start: [10, 30], duration: 105 }, // Group Visit
  '1DV':  { start: [13, 30], duration: 105 }, // Daily Visit
  '2DV':  { start: [14, 30], duration: 105 }, // Daily Visit
  '8PA':  { start: [8,  15], duration:  60 }, // Program Academic (loop only)
  '1PA':  { start: [13, 30], duration:  60 }, // Program Academic (loop only)
  '2PA':  { start: [14, 30], duration:  60 }, // Program Academic (loop only)
  '1PF':  { start: [13, 30], duration: 105 }, // Program Full Day
  'EPF':  { start: [11, 15], duration: 105 }, // Program Full Day (11am)
};

// Symbols that still count (guide gave the tour but has a status flag)
// * = pending drop (tour happened, just trying to hand it off for future)
// + = picked up (gave someone else's tour, counts for them)
// ` = not given — do NOT count
// ~ = trailing decoration only, strip it
const SKIP_SYMBOLS = ['`']; // tours with backtick = not given, don't count


// ════════════════════════════════════════════════════════════════════════════
//  doGet  — ORIGINAL LOGIC PRESERVED, new fields added
// ════════════════════════════════════════════════════════════════════════════
function doGet(e) {
  try {
    const ss       = SpreadsheetApp.openById(SHEET_ID);
    const userName = e.parameter.user;

    // ── 1. Guide Profile (unchanged) ────────────────────────────────────────
    const guideSheet = ss.getSheetByName("TourGuides");
    const guideData  = guideSheet.getDataRange().getValues();
    guideData.shift(); // Remove headers

    let userProfile = null;
    guideData.forEach(row => {
      if (row[0] === userName) {
        userProfile = {
          username:    row[0],
          displayName: row[1],
          fullName:    row[2],
          status:      row[4]
        };
      }
    });
    if (!userProfile) throw new Error("User not found in TourGuides");

    // ── 2. Tracker Stats (unchanged logic, now returns ALL guides) ───────────
    const trackerSheet   = ss.getSheetByName("Tracker");
    const trackerData    = trackerSheet.getDataRange().getValues();
    const trackerHeaders = trackerData.shift();

    const totalColIdx    = trackerHeaders.indexOf("TOTAL");
    const currentSemIdx  = totalColIdx - 1;
    const currentSemName = trackerHeaders[currentSemIdx];

    const fullLeaderboard = trackerData.map(row => {
      const history = [];
      for (let i = 3; i < totalColIdx; i++) {
        if (trackerHeaders[i]) {
          history.push({ semester: trackerHeaders[i], count: row[i] || 0 });
        }
      }
      return {
        displayName:   row[0],
        semesterTotal: row[currentSemIdx] || 0,
        careerTotal:   row[totalColIdx]   || 0,
        history:       history
      };
    }).sort((a, b) => b.careerTotal - a.careerTotal);

    const userStats = fullLeaderboard.find(g =>
      g.displayName === userProfile.displayName
    );
    const userRank = fullLeaderboard.findIndex(g =>
      g.displayName === userProfile.displayName
    ) + 1;

    // ── 3. Tours tab (unchanged) ─────────────────────────────────────────────
    const toursSheet   = ss.getSheetByName("Tours");
    const toursRawData = toursSheet.getDataRange().getValues();
    toursRawData.shift();

    const allTours = toursRawData.map(row => ({
      date:  row[0],
      guide: row[1],
      type:  row[2],
      time:  row[3]
    })).filter(t => t.guide);

    // ── 4. Build base response (same shape as original) ──────────────────────
    const results = {
      profile:             userProfile,
      stats:               userStats,
      rank:                userRank,
      currentSemesterName: currentSemName,
      leaderboard:         fullLeaderboard.slice(0, 10), // top-10 for app leaderboard widget
      fullLeaderboard:     fullLeaderboard,              // ALL guides — used by admin + history
      tours:               allTours,
      lastUpdated:         new Date().toLocaleString()
    };

    // ── 5. Admin-only extras ─────────────────────────────────────────────────
    if (e.parameter.admin === 'true') {
      const isAdmin = ['Codirector', 'Manager'].includes(userProfile.status);
      if (!isAdmin) throw new Error("ACCESS_DENIED");

      // Full tracker grid rows (all guides, all semester columns, read-only for past sems)
      const trackerGrid = trackerData.map(row => {
        const semCols = {};
        for (let i = 3; i <= totalColIdx; i++) {
          semCols[trackerHeaders[i]] = row[i] || 0;
        }
        return {
          displayName: row[0],
          firstName:   row[1] || '',
          lastName:    row[2] || '',
          semesters:   semCols,   // { "Spring 2023": 10, "Summer 2023": 0, ... "TOTAL": 56 }
          currentSem:  row[currentSemIdx] || 0,
          careerTotal: row[totalColIdx]   || 0
        };
      });

      // Semester column names (past only, for read-only history view)
      const semesterCols = [];
      for (let i = 3; i < totalColIdx; i++) {
        if (trackerHeaders[i]) semesterCols.push(trackerHeaders[i]);
      }

      // CountedTours log for this semester
      let countedLog = [];
      try {
        const ctSheet = ss.getSheetByName("CountedTours");
        if (ctSheet && ctSheet.getLastRow() > 1) {
          const ctData = ctSheet.getDataRange().getValues();
          ctData.shift(); // headers
          countedLog = ctData
            .filter(r => r[0]) // uid must exist
            .map(r => ({
              uid:          r[0],
              guide:        r[1],
              type:         r[2],
              date:         r[3],
              countedAt:    r[4],
              isSpecial:    r[5] === true || r[5] === 'TRUE'
            }));
        }
      } catch(ex) { /* CountedTours sheet doesn't exist yet */ }

      // Special requests log
      let specialRequests = [];
      try {
        const srSheet = ss.getSheetByName("SpecialRequests");
        if (srSheet && srSheet.getLastRow() > 1) {
          const srData = srSheet.getDataRange().getValues();
          srData.shift();
          specialRequests = srData
            .filter(r => r[0])
            .map(r => ({
              date:    r[0], guide:   r[1], type:    r[2],
              count:   r[3], notes:   r[4], addedBy: r[5], addedAt: r[6]
            }));
        }
      } catch(ex) {}

      // Admin action log
      let adminLog = [];
      try {
        const logSheet = ss.getSheetByName("AdminLog");
        if (logSheet && logSheet.getLastRow() > 1) {
          const logData = logSheet.getDataRange().getValues();
          logData.shift();
          adminLog = logData.filter(r => r[0]).map(r => ({
            timestamp: r[0], by: r[1], action: r[2], detail: r[3]
          }));
        }
      } catch(ex) {}

      results.adminData = {
        trackerGrid,
        semesterCols,       // past semester names for history popup
        currentSemName,
        countedLog,
        specialRequests,
        adminLog
      };
    }

    return ContentService.createTextOutput(JSON.stringify(results))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({ error: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  doPost  — admin writes + future extensibility
//  The onboarding script has its OWN doPost in a separate deployment — untouched.
// ════════════════════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const data   = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === 'specialRequest') return handleSpecialRequest(data);
    if (action === 'manualAdjust')   return handleManualAdjust(data);
    if (action === 'rollover')       return handleRollover(data);

    return ContentService.createTextOutput(JSON.stringify({ error: 'Unknown action' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  AUTO-COUNT  — install once via installAutoCountTrigger()
//  Runs every 30 minutes, finds tours that have concluded, credits Tracker
// ════════════════════════════════════════════════════════════════════════════
function autoCountCompletedTours() {
  const ss           = SpreadsheetApp.openById(SHEET_ID);
  const toursSheet   = ss.getSheetByName("Tours");
  const trackerSheet = ss.getSheetByName("Tracker");
  const ctSheet      = getOrCreateSheet(ss, "CountedTours");

  ensureHeaders(ctSheet, ['UID', 'Guide', 'TourType', 'TourDate', 'CountedAt', 'IsSpecial']);

  const now = new Date();

  // Load already-counted UIDs
  const ctData   = ctSheet.getDataRange().getValues();
  ctData.shift();
  const counted  = new Set(ctData.map(r => String(r[0])));

  // Load Tours tab
  const toursRaw     = toursSheet.getDataRange().getValues();
  const toursHeaders = toursRaw.shift();

  // Load Tracker
  const trackerRaw     = trackerSheet.getDataRange().getValues();
  const trackerHeaders = trackerRaw[0]; // keep headers in array (don't shift)
  const totalColIdx    = trackerHeaders.indexOf("TOTAL");
  const currentSemIdx  = totalColIdx - 1;

  if (totalColIdx < 0) {
    Logger.log("autoCount: TOTAL column not found — aborting");
    return;
  }

  const toAdd    = {};   // displayName → count
  const newRows  = [];   // rows to append to CountedTours

  toursRaw.forEach((row, rowIdx) => {
    const rawDate  = row[0];
    const rawGuide = String(row[1] || '').trim();
    const typeCode = String(row[2] || '').trim();

    if (!rawDate || !rawGuide || !typeCode) return;

    // Skip blank/NA guide entries
    if (['N/A', '#N/A', ''].includes(rawGuide.toUpperCase())) return;

    // Check for skip symbols (backtick = not given)
    const hasSkip = SKIP_SYMBOLS.some(sym => rawGuide.includes(sym));
    if (hasSkip) return;

    // Clean the guide name (strip *, ~, +, spaces)
    const cleanGuide = rawGuide.replace(/[*~+`]/g, '').trim();
    if (!cleanGuide) return;

    // Look up tour config
    const cfg = TOUR_CONFIG[typeCode];
    if (!cfg) return; // unknown type, skip

    // Parse tour date
    const tourDate = rawDate instanceof Date ? new Date(rawDate) : new Date(rawDate);
    if (isNaN(tourDate.getTime())) return;

    // Build end time
    const endTime = new Date(tourDate);
    endTime.setHours(cfg.start[0], cfg.start[1] + cfg.duration, 0, 0);

    // Only count if tour has concluded
    if (now < endTime) return;

    // Unique ID: prevents double-counting across trigger runs
    const uid = `${formatDate(tourDate)}_${cleanGuide.replace(/\s+/g,'_')}_${typeCode}_r${rowIdx}`;
    if (counted.has(uid)) return;

    toAdd[cleanGuide] = (toAdd[cleanGuide] || 0) + 1;
    newRows.push([uid, cleanGuide, typeCode, formatDate(tourDate), now.toLocaleString(), false]);
  });

  if (!Object.keys(toAdd).length) {
    Logger.log("autoCount: nothing new");
    return;
  }

  // Apply to Tracker sheet
  // trackerRaw[0] = headers, trackerRaw[1..n] = guide rows
  Object.entries(toAdd).forEach(([guideName, increment]) => {
    // Find row index in trackerRaw (index 0 = headers)
    const idx = trackerRaw.findIndex((r, i) =>
      i > 0 && String(r[0]).toLowerCase().trim() === guideName.toLowerCase().trim()
    );
    if (idx < 1) {
      Logger.log("autoCount: guide not in Tracker: " + guideName);
      return;
    }
    // Sheet row number = idx + 1 (Apps Script is 1-based; row 1 = headers)
    const sheetRow = idx + 1;
    const cell     = trackerSheet.getRange(sheetRow, currentSemIdx + 1); // +1: 1-based cols
    cell.setValue((cell.getValue() || 0) + increment);
    Logger.log("autoCount: +" + increment + " → " + guideName + " (sheet row " + sheetRow + ")");
  });

  // Append new counted rows
  if (newRows.length) {
    const startRow = ctSheet.getLastRow() + 1;
    ctSheet.getRange(startRow, 1, newRows.length, newRows[0].length).setValues(newRows);
  }

  Logger.log("autoCount: complete — " + newRows.length + " tour(s) credited");
}


// ════════════════════════════════════════════════════════════════════════════
//  SPECIAL REQUEST
// ════════════════════════════════════════════════════════════════════════════
function handleSpecialRequest(data) {
  const ss           = SpreadsheetApp.openById(SHEET_ID);
  const trackerSheet = ss.getSheetByName("Tracker");
  const ctSheet      = getOrCreateSheet(ss, "CountedTours");
  const srSheet      = getOrCreateSheet(ss, "SpecialRequests");

  ensureHeaders(ctSheet, ['UID', 'Guide', 'TourType', 'TourDate', 'CountedAt', 'IsSpecial']);
  ensureHeaders(srSheet, ['Date', 'Guide', 'Type', 'Count', 'Notes', 'AddedBy', 'AddedAt']);

  const { guide, date, type, count, notes, adminUser } = data;
  const countNum = Math.max(1, parseInt(count) || 1);

  // Log to SpecialRequests tab
  srSheet.appendRow([date, guide, type, countNum, notes || '', adminUser, new Date().toLocaleString()]);

  // Credit Tracker current semester
  const trackerRaw     = trackerSheet.getDataRange().getValues();
  const trackerHeaders = trackerRaw[0];
  const totalColIdx    = trackerHeaders.indexOf("TOTAL");
  const currentSemIdx  = totalColIdx - 1;

  const idx = trackerRaw.findIndex((r, i) =>
    i > 0 && String(r[0]).toLowerCase().trim() === guide.toLowerCase().trim()
  );
  if (idx > 0) {
    const cell = trackerSheet.getRange(idx + 1, currentSemIdx + 1);
    cell.setValue((cell.getValue() || 0) + countNum);
  }

  // Log each unit to CountedTours so the admin can see them
  const now = new Date();
  for (let i = 0; i < countNum; i++) {
    const uid = `SR_${date}_${guide.replace(/\s+/g,'_')}_${type}_${now.getTime()}_${i}`;
    ctSheet.appendRow([uid, guide, type, date, now.toLocaleString(), true]);
  }

  appendAdminLog(ss, adminUser, 'SPECIAL_REQUEST',
    `+${countNum} for ${guide} (${type}) on ${date}${notes ? ' — ' + notes : ''}`
  );

  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}


// ════════════════════════════════════════════════════════════════════════════
//  MANUAL ADJUST  (absolute value set — matches the admin UI)
// ════════════════════════════════════════════════════════════════════════════
function handleManualAdjust(data) {
  const ss           = SpreadsheetApp.openById(SHEET_ID);
  const trackerSheet = ss.getSheetByName("Tracker");

  const { guide, newValue, reason, adminUser } = data;
  const newVal = parseInt(newValue);
  if (isNaN(newVal) || newVal < 0) throw new Error("Invalid newValue");
  if (!reason || !reason.trim())   throw new Error("Reason required");

  const trackerRaw     = trackerSheet.getDataRange().getValues();
  const trackerHeaders = trackerRaw[0];
  const totalColIdx    = trackerHeaders.indexOf("TOTAL");
  const currentSemIdx  = totalColIdx - 1;

  const idx = trackerRaw.findIndex((r, i) =>
    i > 0 && String(r[0]).toLowerCase().trim() === guide.toLowerCase().trim()
  );
  if (idx < 1) throw new Error("Guide not found: " + guide);

  const cell    = trackerSheet.getRange(idx + 1, currentSemIdx + 1);
  const oldVal  = cell.getValue() || 0;
  cell.setValue(newVal);

  appendAdminLog(ss, adminUser, 'MANUAL_ADJUST',
    `${guide}: ${oldVal} → ${newVal}. Reason: ${reason}`
  );

  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}


// ════════════════════════════════════════════════════════════════════════════
//  SEMESTER ROLLOVER
// ════════════════════════════════════════════════════════════════════════════
function handleRollover(data) {
  const ss           = SpreadsheetApp.openById(SHEET_ID);
  const trackerSheet = ss.getSheetByName("Tracker");

  const { newSemesterName, adminUser } = data;
  if (!newSemesterName || !newSemesterName.trim()) throw new Error("New semester name required");

  const trackerRaw     = trackerSheet.getDataRange().getValues();
  const trackerHeaders = trackerRaw[0];
  const totalColIdx    = trackerHeaders.indexOf("TOTAL"); // 0-based in array
  if (totalColIdx < 0) throw new Error("TOTAL column not found");

  const oldSemName  = trackerHeaders[totalColIdx - 1];
  // 1-based sheet column for TOTAL
  const totalSheetCol = totalColIdx + 1;

  // Step 1: Insert blank column before TOTAL — this becomes the new semester
  trackerSheet.insertColumnBefore(totalSheetCol);

  // Step 2: Header for new column
  trackerSheet.getRange(1, totalSheetCol).setValue(newSemesterName.trim());

  // Step 3: Zero-fill guide rows in new column
  const lastRow = trackerSheet.getLastRow();
  if (lastRow > 1) {
    const zeros = Array.from({ length: lastRow - 1 }, () => [0]);
    trackerSheet.getRange(2, totalSheetCol, lastRow - 1, 1).setValues(zeros);
  }

  // Step 4: Rebuild TOTAL formula for every guide row
  // After insert, TOTAL is now at totalSheetCol + 1
  const newTotalSheetCol = totalSheetCol + 1;
  const startLetter      = colNumberToLetter(4);                    // D — first semester col
  const endLetter        = colNumberToLetter(totalSheetCol);        // new current sem col
  for (let r = 2; r <= lastRow; r++) {
    trackerSheet.getRange(r, newTotalSheetCol)
      .setFormula(`=SUM(${startLetter}${r}:${endLetter}${r})`);
  }

  appendAdminLog(ss, adminUser, 'ROLLOVER',
    `Closed "${oldSemName}" → opened "${newSemesterName.trim()}"`
  );

  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}


// ════════════════════════════════════════════════════════════════════════════
//  TRIGGER INSTALLER  — run this ONE TIME manually from the editor
// ════════════════════════════════════════════════════════════════════════════
function installAutoCountTrigger() {
  // Remove existing to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'autoCountCompletedTours') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('autoCountCompletedTours')
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('Trigger set: autoCountCompletedTours every 30 min');
}


// ════════════════════════════════════════════════════════════════════════════
//  SHARED UTILITIES
// ════════════════════════════════════════════════════════════════════════════
function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeaders(sheet, headers) {
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
}

function appendAdminLog(ss, by, action, detail) {
  const sheet = getOrCreateSheet(ss, 'AdminLog');
  ensureHeaders(sheet, ['Timestamp', 'By', 'Action', 'Detail']);
  sheet.appendRow([new Date().toLocaleString(), by, action, detail]);
}

function formatDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function colNumberToLetter(col) {
  let result = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    result    = String.fromCharCode(65 + rem) + result;
    col       = Math.floor((col - 1) / 26);
  }
  return result;
}
