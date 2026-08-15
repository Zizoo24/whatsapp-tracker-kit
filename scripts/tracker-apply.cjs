#!/usr/bin/env node
'use strict';
// tracker-apply.cjs — DETERMINISTIC WRITE. No model call happens here.
//
// THE SINGLE PLACE STATUS IS DERIVED:
//
//   stored milestones  +  this run's observations  ->  merged milestones  ->  projected status
//
// Milestones are durable facts about the past and only ever accumulate, so a stale re-read
// cannot walk a record backwards — the monotonic guard is implicit in the data model rather
// than bolted on. It also means a record delivered while unpaid stays `confirmed_unpaid` and
// flips to `done` the moment payment lands, even though the delivery evidence is by then old
// context. See the header of scripts/lib/status-model.cjs.
//
// Usage: node scripts/tracker-apply.cjs [--keep-cursor]

const fs = require('fs');
const path = require('path');
const {
  VALID_STATUS, canAutomatedTransition, mergeMilestones, projectStatus,
} = require('./lib/status-model.cjs');
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
      // writing it creates an unaddressable row nothing can ever update.
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

  // ---- Read authoritative current state: FAIL CLOSED (docs/GUARDS.md #24) --------------
  // The projection needs each record's STORED MILESTONES. v1 caught a failed pre-read and
  // wrote anyway "without the guard" — inverting the fail-closed rule at the one place it
  // protects hard-won state. Without current state we do not write and do not advance.
  const currentByRecord = new Map();
  if (pending.length) {
    try {
      for (const r of await fetchRows(cfg, 'Records')) {
        if (r.record_id) currentByRecord.set(String(r.record_id), r);
      }
    } catch (e) {
      console.error('ABORT: could not read current store state (' + e.message + '). '
        + 'Refusing to write without it — a blind write can silently discard milestones. '
        + 'The cursor is kept; the next tick retries.');
      process.exit(1);
    }
  }

  const rows = [];
  for (const { phone, record } of pending) {
    const current = currentByRecord.get(String(record.record_id));
    const currentStatus = String(current?.status || '').trim();
    const observations = Array.isArray(record.observations) ? record.observations : [];

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

    if (observations.length) {
      const merged = mergeMilestones(current?.milestones, observations);
      for (const r of merged.refused) {
        console.log(`guard: ${record.record_id} refused ${r.observation} (${r.reason})`);
      }
      const status = projectStatus(merged.milestones);
      // The milestones column is the machine-readable truth; `status` is the human view
      // projected from it. Both are written together so they can never disagree.
      row.milestones = JSON.stringify(merged.milestones);
      row.status = status;
      if (merged.milestones.paid_at) row.paid_at = merged.milestones.paid_at;
      if (status !== currentStatus) {
        console.log(`  ${record.record_id}: ${currentStatus || '(new)'} -> ${status}`);
      }
    } else {
      // A lane that supplies a status directly (the counterparty pass) must clear the same
      // gate. result-merge only sees this run's results; the live store may have moved on
      // since prep read it, so the authoritative check happens here too.
      const incoming = String(record.status || '').trim();
      if (VALID_STATUS.has(incoming)) {
        const verdict = canAutomatedTransition(currentStatus || null, incoming);
        if (verdict.allowed) row.status = incoming;
        else console.log(`guard: ${record.record_id} kept "${currentStatus}" (${verdict.reason})`);
      }
    }

    if (record.counterparty) row.counterparty = record.counterparty;
    rows.push(row);
  }

  if (rows.length) {
    const res = await appendRows(rows, cfg, 'Records'); // upsert by record_id
    console.log('tracker-apply:', JSON.stringify(res), '| rows:', rows.length);
  }

  // A PARTIAL run still applies its successful rows but KEEPS the cursor, so deferred chats
  // are retried losslessly next tick. Upsert-by-id makes the retry harmless.
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
