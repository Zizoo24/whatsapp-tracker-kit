#!/usr/bin/env node
'use strict';
// tracker-apply.cjs — DETERMINISTIC WRITE. No model call happens here.
//
// Reads .tracker-work/results.json, enforces the monotonic lifecycle guard, upserts by
// record_id, and — ONLY on full success — advances the rowid cursor.
//
// results.json shape:
//   [ { "phone": "...", "records": [
//       { "record_id": "<validated immutable id>", "start_date": "YYYY-MM-DD or '' for update",
//         "client_name": "", "doc_type": "", "language_pair": "", "price": "",
//         "delivery_time": "", "status": "paid", "summary": "" }, ... ] }, ... ]
//
// Usage: node scripts/tracker-apply.cjs [--keep-cursor]

const fs = require('fs');
const path = require('path');
const { STATUS_RANK, VALID_STATUS } = require('./lib/status-model.cjs');
const { advanceCursorState } = require('./lib/message-cursor.cjs');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'tracker-state.json');
const WORKDIR = path.join(ROOT, '.tracker-work');
const keepCursor = process.argv.includes('--keep-cursor');
const canon = (s) => String(s || '').replace(/\D/g, '');

(async () => {
  const resultsPath = path.join(WORKDIR, 'results.json');
  if (!fs.existsSync(resultsPath)) { console.error('no results.json — the tick produced nothing'); process.exit(1); }
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

  const { loadConfig } = await import('file://' + path.join(ROOT, 'config.js').replace(/\\/g, '/'));
  const { appendRows, fetchRows } = await import('file://' + path.join(ROOT, 'src', 'sheet.js').replace(/\\/g, '/'));
  const cfg = loadConfig();

  const rows = [];
  for (const entry of results) {
    const phone = canon(entry.phone);
    for (const d of entry.records || []) {
      // A record without a validated id is a bug upstream, not something to paper over:
      // writing it would create an unaddressable row nothing can ever update.
      if (!d.record_id) {
        console.error('refusing a record without a validated record_id');
        process.exit(1);
      }
      if (!VALID_STATUS.has(d.status)) continue; // defensive: drop anything off-model
      const row = {
        record_id: d.record_id,
        source_date: d.start_date || '',
        client_name: d.client_name || '',
        phone,
        doc_type: d.doc_type || '',
        language_pair: d.language_pair || '',
        price: d.price || '',
        delivery_time: d.delivery_time || '',
        status: d.status,
        summary: d.summary || '',
      };
      if (d.counterparty) row.counterparty = d.counterparty;
      rows.push(row);
    }
  }

  // ---- THE MONOTONIC LIFECYCLE GUARD (docs/GUARDS.md #13) ----------------------------
  // The extractor re-emits historical records on every run. An old, completed record shows
  // only its payment in the messages, so it comes back at an EARLIER stage. Without this
  // guard, the moment a repeat customer sends ANY message the whole thread is re-extracted
  // and a finished record silently walks backwards.
  //
  // WHY HERE AND NOT IN THE STORE API: the API is ALSO the correction path. Fixing a
  // wrongly-set terminal status requires posting a backward move, which an API-layer guard
  // would refuse — it would block exactly the write the operator needs. Guard the sole
  // AUTOMATED writer (the thing that re-emits stale reads); keep the API a dumb, honest
  // upsert. Note this only blocks DOWNGRADES, so a false promotion stays permanent and
  // must be fixed by an explicit correction.
  if (rows.length) {
    try {
      const currentRows = await fetchRows(cfg, 'Records');
      const currentByRecord = new Map();
      for (const r of currentRows) if (r.record_id) currentByRecord.set(String(r.record_id), r);
      for (const row of rows) {
        const currentStatus = String(currentByRecord.get(String(row.record_id))?.status || '').trim();
        const cr = STATUS_RANK[currentStatus];
        const nr = STATUS_RANK[row.status];
        if (cr != null && nr != null && nr < cr) {
          console.log(`guard: kept "${currentStatus}" for ${row.record_id} (refused downgrade to "${row.status}")`);
          // Delete the key so the non-empty merge leaves the advanced stage intact while
          // every OTHER field still refreshes.
          delete row.status;
        }
      }
    } catch (e) {
      console.error('status guard pre-read failed (proceeding without it):', e.message);
    }
  }

  if (rows.length) {
    const res = await appendRows(rows, cfg, 'Records'); // upsert by record_id
    console.log('tracker-apply:', JSON.stringify(res), '| rows:', rows.length);
  } else {
    // The chats WERE evaluated; they just held nothing committed. That is a normal,
    // correct outcome — not a failure — and the cursor should still advance.
    console.log('tracker-apply: no committed records to write this run');
  }

  // A PARTIAL run still applies its successful rows but KEEPS the cursor, so the deferred
  // chats are retried losslessly next tick. Upsert-by-id makes the retry harmless.
  if (keepCursor) {
    console.log('cursor kept (partial extraction)');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(WORKDIR, 'manifest.json'), 'utf8'));
  const next = advanceCursorState(STATE, manifest);
  console.log('cursor advanced to rowid', next.lastRowid, '| message time', next.lastTs);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
