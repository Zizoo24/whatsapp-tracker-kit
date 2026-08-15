/**
 * Google Apps Script — the durable store backend for whatsapp-tracker-kit.
 *
 * ==========================================================================
 * SEAM 3. The SHEETS object below is one of the three things you adapt.
 * ==========================================================================
 *
 * SETUP (one time):
 *  1. Open your Sheet -> Extensions -> Apps Script, paste this file.
 *  2. Project Settings -> Script Properties, add:
 *       SHEET_SECRET   = <the same long random string as .env>
 *       WATCHDOG_EMAIL = <where stall alerts should go>
 *     NEVER hardcode the secret here. This file is not gitignored and the deployment is
 *     Access: Anyone, so a secret in source lets anyone forge rows.
 *  3. Run setupHeaders() once (authorize when prompted). Idempotent.
 *  4. Run applyFilterAndSort(), applyStatusFormatting(), makeAllValidationsWarnOnly().
 *  5. Deploy -> Web app: Execute as Me, Who has access: Anyone. Put the /exec URL in .env.
 *  6. OPTIONAL but recommended: run installWatchdogTrigger() to arm the cloud dead-man's
 *     switch, then watchdogTestEmail() to PROVE the mail path works. An alert channel
 *     whose send permission has never been exercised is a decorative alarm.
 *
 * REDEPLOY: Deploy -> Manage deployments -> Edit -> New version. Editing the code alone
 * does NOT change the deployed web app. Local source is not proof of what is live —
 * the capabilities probe is.
 *
 * ENDPOINTS (all secret-gated, secret always in the POST body — never a URL):
 *   {rows:[...], sheet, replaceEmpty?}      upsert by key
 *   {action:'read', sheet}                  -> {ok, rows:[{header:value}...]}
 *   {action:'delete', sheet, keys:[...]}    delete by key
 *   {action:'capabilities'}                 -> what this deployment supports
 *   {action:'heartbeat', poster, ...}       liveness ping (Script Property, no sheet write)
 */

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty('SHEET_SECRET') || '';
}

// Per-tab schema.
//   key     = the upsert identity column
//   merge   = fields a write may overwrite (only when non-empty, unless told otherwise)
//   sortCol = the column the tab is kept sorted by, newest first
// logged_at / updated_at are server-set and must not appear in `merge`.
//
// GOTCHA THAT COST REAL DEBUGGING TIME: a column must appear in BOTH `headers` AND
// `merge`. The update path iterates `merge`, so a column listed only in `headers` gets
// created and then never populated on any existing row — it silently stays blank forever.
var SHEETS = {
  Records: {
    key: 'record_id',
    sortCol: 'source_date',
    // `milestones` is a JSON object of durable timestamps (committed_at, paid_at,
    // final_delivered_at, ...). It is the MACHINE-READABLE TRUTH; `status` is the human view
    // projected from it. Keeping milestones means the tracker never forgets that a job was
    // delivered while unpaid — it flips to done the moment payment lands, even though the
    // delivery evidence is by then old context.
    headers: [
      'logged_at', 'updated_at', 'source_date', 'client_name', 'phone', 'doc_type',
      'language_pair', 'price', 'delivery_time', 'status', 'summary', 'record_id',
      'paid_amount', 'paid_at', 'charge_id', 'counterparty', 'milestones',
    ],
    merge: [
      'source_date', 'client_name', 'phone', 'doc_type', 'language_pair', 'price',
      'delivery_time', 'status', 'summary', 'paid_amount', 'paid_at', 'charge_id',
      'counterparty', 'milestones',
    ],
  },
  Payments: {
    key: 'charge_id',
    sortCol: 'paid_at',
    headers: [
      'logged_at', 'charge_id', 'paid_at', 'amount', 'currency', 'customer_name',
      'email', 'matched_record_id',
    ],
    merge: ['paid_at', 'amount', 'currency', 'customer_name', 'email', 'matched_record_id'],
  },
};

// The statuses rendered as "needs attention". Keep in sync with scripts/lib/status-model.cjs.
var TERMINAL_OK = 'done';
var START_STAGE = 'confirmed_unpaid';
var DEAD_STAGES = ['cancelled', 'refunded'];

// ============================================================================
// NOTE: THE MONOTONIC STATUS GUARD DELIBERATELY DOES NOT LIVE HERE.
// It belongs at the sole AUTOMATED writer (scripts/tracker-apply.cjs), because that is
// the thing that re-emits stale historical records. Putting it in doPost would ALSO block
// the CORRECTION path: fixing a wrongly-set terminal status requires posting a backward
// move, and an API-layer guard would refuse exactly the write the operator needs.
// Keep doPost a dumb, honest upsert; guard at the writer. See docs/GUARDS.md #13.
// ============================================================================

function tab_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

// Ensure the tab has its header row and any newly-added columns, APPENDED at the end,
// without disturbing existing data.
//
// NB: a freshly inserted column is blank, so getLastColumn() does NOT advance to it — we
// track the target column ourselves (lastCol + 1) and write there. Writing to
// getLastColumn() after insertColumnAfter silently OVERWRITES the previous last column,
// which is how a key column's header label once got clobbered while its data survived.
function ensureSchema_(name) {
  var cfg = SHEETS[name];
  var sh = tab_(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, cfg.headers.length).setValues([cfg.headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  var lastCol = sh.getLastColumn();
  var have = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  cfg.headers.forEach(function (h) {
    if (have.indexOf(h) === -1) {
      lastCol += 1;
      if (lastCol > sh.getMaxColumns()) sh.insertColumnAfter(sh.getMaxColumns());
      sh.getRange(1, lastCol).setValue(h);
      have.push(h);
    }
  });
  return sh;
}

function setupHeaders() {
  ensureSchema_('Records');
  ensureSchema_('Payments');
  var sh = tab_('Records');
  Logger.log('Records: ' + sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].join(' | '));
}

// ONE-SHOT: sort each tab newest-first and (re)create a basic filter so the header row
// gets sort/filter dropdowns. doPost keeps the order live by inserting new rows at the top.
function applyFilterAndSort() {
  ['Records', 'Payments'].forEach(function (name) {
    var cfg = SHEETS[name];
    var sh = tab_(name);
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2) return;
    var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var sc = header.indexOf(cfg.sortCol);
    if (sc >= 0) sh.getRange(2, 1, lastRow - 1, lastCol).sort({ column: sc + 1, ascending: false });
    var existing = sh.getFilter();
    if (existing) existing.remove();
    sh.getRange(1, 1, sh.getLastRow(), lastCol).createFilter();
    Logger.log(name + ': sorted by ' + cfg.sortCol + ' desc; filter over ' + sh.getLastRow() + 'x' + lastCol);
  });
}

// STRUCTURAL FIX + ONE-SHOT: free-text columns that LOOK like dates get auto-converted by
// Sheets into a bare serial number on write (a "delivery_time" of "2026-06-13" became
// 46186 — meaningless to a human). Forcing Plain Text means no future write can be
// silently mangled regardless of what string lands in it.
function fixFreeTextFormat() {
  var sh = tab_('Records');
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  ['delivery_time', 'price'].forEach(function (field) {
    var idx = header.indexOf(field);
    if (idx < 0) return;
    sh.getRange(2, idx + 1, rows, 1).setNumberFormat('@');
    Logger.log('fixFreeTextFormat: ' + field + ' forced to Plain Text over ' + rows + ' rows');
  });
}

// STRUCTURAL FIX + ONE-SHOT: data-validation dropdowns HARD-REJECT any value not in their
// list, so a stale dropdown on the status column silently failed EVERY automated write and
// froze the whole store. Worse, dropdowns exist on multiple columns (free-text ones too),
// so every new language pair would fail. Sweep EVERY column: keep each dropdown's list for
// operator convenience but rebuild it warn-only, so no sheet-side rule can ever hard-block
// the pipeline again. Re-run this after anyone edits validation by hand.
function makeAllValidationsWarnOnly() {
  var sh = tab_('Records');
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  var fixed = 0;
  for (var c = 1; c <= sh.getLastColumn(); c++) {
    var rule = null;
    for (var r = 2; r <= 4; r++) {
      rule = sh.getRange(r, c).getDataValidation();
      if (rule) break;
    }
    if (!rule) continue;
    sh.getRange(2, c, rows, 1).setDataValidation(rule.copy().setAllowInvalid(true).build());
    fixed++;
    Logger.log('  col ' + c + ' (' + sh.getRange(1, c).getValue() + '): -> warn-only');
  }
  Logger.log('makeAllValidationsWarnOnly: ' + fixed + ' column rule(s) rebuilt warn-only');
}

// Row colouring by lifecycle position, as a FORMULA rule over the whole range rather than
// one rule per value — so adding a stage never requires touching the formatting.
//   AMBER = an active MIDDLE stage (needs action)
//   GREY  = terminal-dead (cancelled/refunded): kept as a record, visibly not active
// The `$E2<>""` guard (phone non-empty) is the ROW-SCOPE GUARD: it keeps historical or
// imported rows without a phone from being lit up. See docs/GUARDS.md #7.
function applyStatusFormatting() {
  var sh = tab_('Records');
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var phoneCol = columnLetter_(header.indexOf('phone') + 1);
  var statusCol = columnLetter_(header.indexOf('status') + 1);
  if (!phoneCol || !statusCol) throw new Error('phone/status column not found');

  var deadTest = DEAD_STAGES.map(function (s) { return '$' + statusCol + '2="' + s + '"'; }).join(', ');
  var notDead = DEAD_STAGES.map(function (s) { return '$' + statusCol + '2<>"' + s + '"'; }).join(', ');

  var rules = sh.getConditionalFormatRules().filter(function (r) {
    var bc = r.getBooleanCondition();
    if (!bc) return true;
    var vals = (bc.getCriteriaValues() || []).join(' ');
    // Drop OUR prior rules so re-running is idempotent; leave the operator's own alone.
    return !new RegExp(START_STAGE + '|' + DEAD_STAGES.join('|')).test(vals);
  });

  var fullRange = [sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), header.length)];
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($' + phoneCol + '2<>"", $' + statusCol + '2<>"", $'
      + statusCol + '2<>"' + START_STAGE + '", $' + statusCol + '2<>"' + TERMINAL_OK + '", ' + notDead + ')')
    .setBackground('#FFD966').setRanges(fullRange).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($' + phoneCol + '2<>"", OR(' + deadTest + '))')
    .setBackground('#D9D9D9').setFontColor('#666666').setRanges(fullRange).build());

  sh.setConditionalFormatRules(rules);
  Logger.log('status colours applied; rules now ' + rules.length + ' (amber=active-middle, grey=dead)');
}

function columnLetter_(index) {
  if (index < 1) return '';
  var letter = '';
  while (index > 0) {
    var mod = (index - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    index = Math.floor((index - mod) / 26);
  }
  return letter;
}

// ---- CLOUD WATCHDOG ---------------------------------------------------------
// Runs in Google's cloud on a 15-min trigger, so it alerts even when the operator's
// machine is asleep or off — the ONE failure mode the local alert channel cannot
// self-report, because that channel needs the local bridge.
//
// PER-POSTER STORAGE IS LOAD-BEARING: two lanes post here. They used to share ONE
// property, last-writer-wins, so the keepalive's crash-loop alarm was overwritten by the
// watcher's empty lastError within minutes and the watchdog sampled the alarm only by
// luck. Each poster now owns its own property and watchdogCheck reads them ALL.
function watchdogCheck() {
  var props = PropertiesService.getScriptProperties();
  var email = props.getProperty('WATCHDOG_EMAIL') || '';
  if (!email) return;

  var raws = ['HEARTBEAT_KEEPALIVE', 'HEARTBEAT_WATCHER', 'HEARTBEAT'].map(function (k) {
    return props.getProperty(k);
  }).filter(function (v) { return !!v; });
  if (!raws.length) return; // nothing ever posted -> nothing to judge, no false alarm

  var beats = [];
  for (var i = 0; i < raws.length; i++) {
    try { beats.push(JSON.parse(raws[i])); } catch (e) { /* skip a corrupt slot */ }
  }
  if (!beats.length) return;

  var now = new Date();
  // Freshness comes from the most recent beat of ANY poster: "is the host alive" is a
  // machine-level fact. The ERROR signal is the WORST any poster reported, so a healthy
  // watcher can no longer mask a crash-looping bridge.
  var freshestMs = -1;
  var freshest = beats[0];
  for (var b = 0; b < beats.length; b++) {
    var ms = Date.parse(beats[b].received);
    if (!isNaN(ms) && ms > freshestMs) { freshestMs = ms; freshest = beats[b]; }
  }
  var RANK = {
    store_apply_failed: 5, bridge_crash_loop: 5,
    watcher_unhandled_error: 4, prep_failed: 4, manifest_missing: 4, bridge_supervise_error: 4,
    agent_auth_failed: 3, agent_extraction_failed: 2, bridge_unhealthy: 1,
  };
  var worst = '';
  var worstBeat = freshest;
  for (var c = 0; c < beats.length; c++) {
    var e = String(beats[c].lastError || '');
    if (e && (RANK[e] || 0) > (RANK[worst] || 0)) { worst = e; worstBeat = beats[c]; }
  }

  var staleMin = freshestMs < 0 ? 9999 : Math.round((now.getTime() - freshestMs) / 60000);
  var timezone = props.getProperty('WATCHDOG_TIMEZONE') || Session.getScriptTimeZone();
  var hour = Number(Utilities.formatDate(now, timezone, 'H'));
  // Suppress overnight: a sleeping laptop is EXPECTED, and an alarm that fires nightly
  // trains the operator to ignore it. This channel is the last resort — protect it.
  var businessHours = hour >= 8 && hour < 23;

  var alert = null;
  if (worst === 'bridge_crash_loop' && staleMin <= 45) {
    alert = { key: 'crash_loop', subject: 'Tracker: bridge CRASH-LOOPING — restarts paused',
      body: 'The keepalive relaunched the bridge repeatedly and has stopped hammering it. '
        + 'Restarting is not fixing it (dead session needing a QR re-pair, a port conflict, or a corrupt store).\n\n'
        + 'On the host: check bridge-keepalive.log, then run the bridge interactively to see why it dies.' };
  } else if (worst === 'bridge_supervise_error' && staleMin <= 45) {
    alert = { key: 'supervise_error', subject: 'Tracker: bridge supervisor itself is failing',
      body: 'The keepalive could not even probe the bridge. Check bridge-keepalive.log on the host.' };
  } else if (worst === 'agent_auth_failed') {
    alert = { key: 'auth', subject: 'Tracker: every extraction provider failed authentication',
      body: 'No configured model CLI could complete extraction. Check TRACKER_AGENT_PROVIDERS and '
        + 're-authenticate at least one provider on the host. A headless CLI cannot refresh a normal '
        + 'login token — use a long-lived token.' };
  } else if (['store_apply_failed', 'watcher_unhandled_error', 'prep_failed', 'manifest_missing',
    'agent_extraction_failed'].indexOf(worst) >= 0) {
    alert = { key: 'writer', subject: 'Tracker: the writer failed',
      body: 'The local writer is running but failed with: ' + worst
        + '\nProvider: ' + (worstBeat.provider || '(none)') + '\n\nCheck watch.log on the host.' };
  } else if (staleMin > 45 && businessHours) {
    alert = { key: 'stale', subject: 'Tracker: no heartbeat — host off or task disabled',
      body: 'No heartbeat for ' + staleMin + ' min (last: ' + (freshest.ranAt || '?') + '). The host is '
        + 'likely asleep/off, or the keepalive task is disabled. Messages are NOT being mirrored while '
        + 'this lasts, and the provider-side offline queue is finite.' };
  } else if (Number(freshest.bridgeAgeMin) > 120 && businessHours) {
    alert = { key: 'bridge', subject: 'Tracker: heartbeats arriving but NO messages ingested for 2h+',
      body: 'The keepalive is alive and posting, but the newest mirrored message is '
        + freshest.bridgeAgeMin + ' min old. Either a genuinely quiet day, or the socket is silently '
        + 'dead in a way the health probe cannot see. If customers messaged in the last 2h, it is a zombie.' };
  }
  if (!alert) return;

  // Once per key per calendar day. See the overnight note above — same reasoning.
  var today = Utilities.formatDate(now, timezone, 'yyyy-MM-dd');
  var lastAlert = {};
  try { lastAlert = JSON.parse(props.getProperty('LAST_ALERT') || '{}'); } catch (e) {}
  if (lastAlert[alert.key] === today) return;

  MailApp.sendEmail(email, alert.subject, alert.body);
  lastAlert[alert.key] = today;
  props.setProperty('LAST_ALERT', JSON.stringify(lastAlert));
  Logger.log('watchdog alert emailed: ' + alert.key);
}

// RUNBOOK: prove the alarm channel end-to-end. Run after any re-authorization or scope
// change. Does NOT touch LAST_ALERT.
function watchdogTestEmail() {
  var email = PropertiesService.getScriptProperties().getProperty('WATCHDOG_EMAIL') || '';
  if (!email) throw new Error('set the WATCHDOG_EMAIL script property first');
  MailApp.sendEmail(email, 'Tracker: watchdog channel test',
    'Deliberate test of the dead-man\'s-switch email path. If you are reading this, mail permission '
    + 'and delivery both work. No action needed.');
  Logger.log('watchdog test email sent to ' + email);
}

// RUNBOOK: clear the once-per-day dedup after any DRILL. A test alert writes today's date
// into LAST_ALERT, which would then suppress a REAL alert of the same kind all day.
function resetWatchdogDedup() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('LAST_ALERT');
  Logger.log('LAST_ALERT cleared — a real alert of any kind can fire again today');
  ['HEARTBEAT_KEEPALIVE', 'HEARTBEAT_WATCHER', 'HEARTBEAT'].forEach(function (slot) {
    var raw = props.getProperty(slot);
    if (raw) Logger.log(slot + ' = ' + raw);
  });
}

function installWatchdogTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'watchdogCheck') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('watchdogCheck').timeBased().everyMinutes(15).create();
  Logger.log('watchdogCheck trigger installed (every 15 min)');
}

// ---- THE ENDPOINT -----------------------------------------------------------
function doPost(e) {
  var out = function (o) {
    return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  };

  // Check the secret BEFORE taking the lock — never let an unauthenticated caller hold it.
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return out({ ok: false, error: 'bad json' }); }
  var secret = getSecret_();
  if (!secret || body.secret !== secret) return out({ ok: false, error: 'unauthorized' });

  // Lets a client verify what THIS DEPLOYMENT supports. Local source is not proof the
  // deployed web app was updated; this probe is, and it fails closed.
  if (body.action === 'capabilities') {
    return out({
      ok: true,
      version: 'tracker-store-v1',
      capabilities: {
        // replaceEmpty is the BLUNT form: it blanks EVERY empty field of every row in the
        // request. Dangerous — it erases fields the caller simply never learned.
        // clearFields is the precise form: a row names the exact cells it is authoritative
        // to blank. Prefer clearFields always.
        replaceEmpty: true,
        clearFields: true,
        deleteRows: true,
        heartbeat: true,
      },
    });
  }

  // HEARTBEAT — a Script Property liveness ping. No lock, no sheet write.
  if (body.action === 'heartbeat') {
    var poster = String(body.poster || '');
    var key = poster === 'watcher' ? 'HEARTBEAT_WATCHER'
      : poster === 'keepalive' ? 'HEARTBEAT_KEEPALIVE'
      : 'HEARTBEAT';
    PropertiesService.getScriptProperties().setProperty(key, JSON.stringify({
      ranAt: body.ranAt || '',
      bridgeAgeMin: body.bridgeAgeMin,
      watermark: body.watermark || '',
      cursorRowid: body.cursorRowid,
      provider: body.provider || '',
      detail: String(body.detail || '').slice(0, 500),
      lastError: body.lastError || '',
      poster: poster,
      received: new Date().toISOString(),
    }));
    return out({ ok: true });
  }

  // HARDENING: never guess the caller's intent.
  //
  // v1 defaulted an unknown tab name to 'Records' and let a MISSING action fall through into
  // the upsert path. Both are silent-wrong-target hazards: a typo'd tab wrote customer rows
  // into the wrong sheet, and a malformed request became a write. Require both explicitly
  // and reject anything unrecognised.
  if (body.sheet !== undefined && !SHEETS[body.sheet]) {
    return out({ ok: false, error: 'unknown sheet: ' + body.sheet });
  }
  var name = body.sheet || 'Records';

  var action = body.action || (body.rows ? 'upsert' : '');
  if (['upsert', 'read', 'delete'].indexOf(action) === -1) {
    return out({ ok: false, error: 'unknown or missing action: ' + (action || '(none)') });
  }

  // READ path — no lock, no schema mutation. A read must not block writes or alter columns.
  if (action === 'read') {
    var rsh = tab_(name);
    var rdata = rsh.getLastRow() ? rsh.getDataRange().getValues() : [];
    var rheader = rdata[0] || [];
    var rrows = [];
    for (var ri = 1; ri < rdata.length; ri++) {
      var o = {};
      rheader.forEach(function (h, j) { o[h] = rdata[ri][j]; });
      rrows.push(o);
    }
    return out({ ok: true, rows: rrows });
  }

  var cfg = SHEETS[name];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = ensureSchema_(name);
    var data = sh.getDataRange().getValues();
    var header = data[0];
    var col = {};
    header.forEach(function (h, i) { col[h] = i; });
    var keyIndex = col[cfg.key];

    var keyToRow = {};
    for (var i = 1; i < data.length; i++) {
      var k = data[i][keyIndex];
      if (k) keyToRow[k] = i + 1;
    }

    if (action === 'delete') {
      var wanted = {};
      (body.keys || []).forEach(function (key) { wanted[String(key)] = true; });
      var rowsToDelete = [];
      Object.keys(wanted).forEach(function (key) {
        if (keyToRow[key]) rowsToDelete.push(keyToRow[key]);
      });
      // Descending, so deleting one row never shifts the index of the next.
      rowsToDelete.sort(function (a, b) { return b - a; });
      rowsToDelete.forEach(function (rowNumber) { sh.deleteRow(rowNumber); });
      return out({ ok: true, deleted: rowsToDelete.length });
    }

    var now = new Date();
    var appended = 0;
    var updated = 0;
    var replaceEmpty = body.replaceEmpty === true;

    // New rows are collected and inserted at the TOP in one block so the newest entry
    // stays first. pendingByKey also de-dupes a key appearing twice in the SAME batch.
    var pendingByKey = {};
    var pendingOrder = [];
    var pendingNoKey = [];

    var mergeInto = function (target, r) {
      var clearSet = {};
      (Array.isArray(r.clear_fields) ? r.clear_fields : []).forEach(function (f) { clearSet[f] = true; });
      cfg.merge.forEach(function (f) {
        var v = String(r[f] != null ? r[f] : '').trim();
        // Write when: the value is non-empty, OR the row explicitly names this field as
        // one it is authoritative to clear, OR the caller opted into blanket replaceEmpty.
        // Otherwise an empty field NEVER erases a populated cell — that default is what
        // makes a partial write safe.
        if (col[f] != null && (v || clearSet[f] || replaceEmpty)) target[col[f]] = v;
      });
    };

    // Every automated write must carry the stable key. Without it a retry cannot be
    // idempotent: the row is appended again instead of updated, and nothing can ever
    // address it afterwards. (A human adding a row by hand in the UI is unaffected.)
    var missingKey = (body.rows || []).filter(function (r) {
      return !r || String(r[cfg.key] || '').trim() === '';
    }).length;
    if (missingKey) {
      return out({ ok: false, error: missingKey + ' row(s) missing the required key: ' + cfg.key });
    }

    (body.rows || []).forEach(function (r) {
      var k = r[cfg.key];
      var existing = k ? keyToRow[k] : null;
      if (existing) {
        var range = sh.getRange(existing, 1, 1, header.length);
        var cur = range.getValues()[0];
        mergeInto(cur, r);
        if (col['updated_at'] != null) cur[col['updated_at']] = now;
        range.setValues([cur]);
        updated++;
      } else if (k && pendingByKey[k]) {
        mergeInto(pendingByKey[k], r);
      } else {
        var row = header.map(function (h) {
          if (h === 'logged_at' || h === 'updated_at') return now;
          return r[h] != null ? r[h] : '';
        });
        if (k) { pendingByKey[k] = row; pendingOrder.push(k); }
        else { pendingNoKey.push(row); }
        appended++;
      }
    });

    var newRows = pendingOrder.map(function (k) { return pendingByKey[k]; }).concat(pendingNoKey);
    if (newRows.length) {
      newRows.reverse(); // body order is oldest->newest; reverse puts newest at row 2
      // Insert INSIDE the existing filter range, which keeps the filter (and the user's
      // criteria) intact — unlike appendRow, which drops rows below the filter range.
      sh.insertRowsBefore(2, newRows.length);
      sh.getRange(2, 1, newRows.length, header.length).setValues(newRows);
      // insertRowsBefore inherits formatting from the row ABOVE — which is the header —
      // so new rows would render header-styled and dates could break. Copy an existing
      // data row's format instead of clearFormat, which would strip number formats and
      // expose raw date serials.
      if (sh.getLastRow() > newRows.length + 1) {
        sh.getRange(newRows.length + 2, 1, 1, header.length)
          .copyTo(sh.getRange(2, 1, newRows.length, header.length), { formatOnly: true });
      }
    }

    return out({ ok: true, appended: appended, updated: updated });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
