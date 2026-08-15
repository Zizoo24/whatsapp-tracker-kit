#!/usr/bin/env node
'use strict';
// tracker-apply.cjs — DETERMINISTIC WRITE. No model call happens here.
//
// Reads .tracker-work/results.json, derives each record's status from its OBSERVATIONS
// against the live store, upserts by record_id, and — only on full success — advances the
// rowid cursor.
//
// results.json shape (produced by tracker-watch after validation):
//   [ { "phone": "...", "records": [
//       { "record_id": "<validated immutable id>", "start_date": "YYYY-MM-DD or '' for update",
//         "observations": [{ "type": "payment_received", "evidence_msg_ids": ["m1"] }],
//         "client_name": "", "doc_type": "", ... } ] } ]
//
// Usage: node scripts/tracker-apply.cjs [--keep-cursor]

const fs = require('fs');
const path = require('path');
const { VALID_STATUS, canAutomatedTransition, reduceObservations } = require('./lib/status-model.cjs');
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

  const pending = [];
  for (const entry of results) {
    const phone = canon(entry.phone);
    for (const d of entry.records || []) {
      // A record without a validated id is an upstream bug, not something to paper over:
      // writing it creates an unaddressable row that nothing can ever update.
      if (!d.record_id) {
        console.error('refusing a record without a validated record_id');
        process.exit(1);
      }
      pending.push({ phone, record: d });
    }
  }

  if (!pending.length) {
    // The chats WERE evaluated; they simply held nothing committed. That is a normal,
    // correct outcome — not a failure — so the cursor should still advance.
    console.log('tracker-apply: no committed records to write this run');
  }

  // ---- Read the authoritative current state: FAIL CLOSED (docs/GUARDS.md #24) ----------
  // The reducer needs each record's CURRENT status to decide which observations may apply.
  // v1 caught a failed pre-read and wrote anyway "without the guard" — precisely inverting
  // the fail-closed rule at the one place it protects hard-won state. If we cannot see the
  // current state, we do not write and we do not advance the cursor.
  let currentByRecord = new Map();
  if (pending.length) {
    try {
      const currentRows = await fetchRows(cfg, 'Records');
      for (const r of currentRows) if (r.record_id) currentByRecord.set(String(r.record_id), r);
    } catch (e) {
      console.error('ABORT: could not read current store state (' + e.message + '). '
        + 'Refusing to write without it — a blind write can silently walk a completed record '
        + 'backwards. The cursor is kept; the next tick retries.');
      process.exit(1);
    }
  }

  // ---- Derive status from observations ------------------------------------------------
  // THE GUARD LIVES HERE, AT THE SOLE AUTOMATED WRITER — never in the store API, which is
  // also the correction path and must stay a dumb, honest upsert (GUARDS #13).
  //
  // canAutomatedTransition (inside the reducer) replaces v1's raw rank comparison, which
  // classified the legitimate `done -> revision` move as a downgrade and silently discarded
  // it while validation had explicitly allowed it (GUARDS #22).
  const rows = [];
  for (const { phone, record } of pending) {
    const current = currentByRecord.get(String(record.record_id));
    const currentStatus = String(current?.status || '').trim();
    const observations = Array.isArray(record.observations) ? record.observations : [];

    let status;
    if (observations.length) {
      const derived = reduceObservations(currentStatus || null, observations);
      status = derived.status;
      for (const r of derived.refused) {
        console.log(`guard: ${record.record_id} refused ${r.observation} (${r.reason})`);
      }
      if (!status || status === currentStatus) {
        // Every observation was refused, or none moved the record. Other fields may still
        // legitimately refresh, so fall through with no status key rather than dropping the
        // row — the non-empty merge then leaves the existing stage intact.
        status = null;
      }
    } else {
      // A pre-derived status (the counterparty pass supplies one directly, with no
      // observations) must clear the SAME gate. The in-run precedence check in
      // result-merge.cjs only sees this run's results; the live store may have moved on
      // since prep read it, so the authoritative check has to happen here too.
      const incoming = String(record.status || '').trim();
      if (!VALID_STATUS.has(incoming)) {
        status = null;
      } else {
        const verdict = canAutomatedTransition(currentStatus || null, incoming);
        if (verdict.allowed) {
          status = incoming;
        } else {
          status = null;
          console.log(`guard: ${record.record_id} kept "${currentStatus}" (${verdict.reason})`);
        }
      }
    }

    const row = {
      record_id: record.record_id,
      source_date: record.start_date || '',
      client_name: record.client_name || '',
      phone,
      doc_type: record.doc_type || '',
      language_pair: record.language_pair || '',
      price: record.price || '',
      delivery_time: record.delivery_time || '',
      summary: record.summary || '',
    };
    if (status) row.status = status;
    if (record.counterparty) row.counterparty = record.counterparty;
    rows.push(row);
  }

  if (rows.length) {
    const res = await appendRows(rows, cfg, 'Records'); // upsert by record_id
    console.log('tracker-apply:', JSON.stringify(res), '| rows:', rows.length);
  }

  // A PARTIAL run still applies its successful rows but KEEPS the cursor, so the deferred
  // chats are retried losslessly next tick. Upsert-by-id makes the retry harmless.
  if (keepCursor) {
    console.log('cursor kept (partial extraction)');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(WORKDIR, 'manifest.json'), 'utf8'));
  // manifest.maxRowid is the boundary prep ACTUALLY processed (possibly chunked below the
  // frozen maximum), so the cursor can never overrun evidence the model was not shown.
  const next = advanceCursorState(STATE, manifest);
  console.log('cursor advanced to rowid', next.lastRowid, '| message time', next.lastTs);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
