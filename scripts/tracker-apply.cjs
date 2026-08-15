#!/usr/bin/env node
'use strict';
// tracker-apply.cjs — DETERMINISTIC WRITE. No model call happens here.
//
// THE SINGLE PLACE STATUS IS DERIVED:
//
//   stored milestones  +  ALL of this tick's observations for that record
//     -> merged milestones  ->  projected status  ->  ONE row
//
// EXACTLY ONE OUTGOING WRITE PER record_id PER TICK (GUARDS #30). The customer pass and the
// counterparty pass can both produce an update for the same record in one tick. Writing them
// as two rows meant the second `milestones` value overwrote the first — the store merges by
// key and takes the later non-empty cell — so one lane's facts were silently destroyed.
// Observations are unioned here, merged once, and projected once.
//
// Milestones only accumulate, so a stale re-read cannot walk a record backwards: the
// monotonic guard is implicit in the data model rather than bolted on.
//
// Usage: node scripts/tracker-apply.cjs [--keep-cursor]

const fs = require('fs');
const path = require('path');
const {
  MilestoneStateError, VALID_STATUS, canAutomatedTransition, compareOccurrence,
  mergeMilestones, projectStatus,
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

  // ---- Aggregate by record_id BEFORE touching the store -------------------------------
  // Every lane's contribution to one record is collapsed into a single logical update.
  const byRecord = new Map();
  for (const entry of results) {
    const phone = canon(entry.phone);
    for (const d of entry.records || []) {
      // A record without a validated id is an upstream bug, not something to paper over:
      // writing it creates an unaddressable row nothing can ever update.
      if (!d.record_id) {
        console.error('refusing a record without a validated record_id');
        process.exit(1);
      }
      const id = String(d.record_id);
      const agg = byRecord.get(id) || {
        record_id: id, phone, fields: {}, observations: [], counterparty: '', directStatus: '',
      };
      if (phone) agg.phone = agg.phone || phone;
      for (const f of ['start_date', 'client_name', 'doc_type', 'language_pair', 'price', 'delivery_time', 'summary']) {
        // Later non-empty values win; a lane that says nothing about a field never clears it.
        if (!__isBlank(d[f])) agg.fields[f] = d[f];
      }
      if (d.counterparty) agg.counterparty = d.counterparty;
      if (Array.isArray(d.observations)) agg.observations.push(...d.observations);
      if (d.status) agg.directStatus = d.status;
      byRecord.set(id, agg);
    }
  }

  function __isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

  if (!byRecord.size) {
    // The chats WERE evaluated; they simply held nothing committed. That is a normal,
    // correct outcome — not a failure — so the cursor should still advance.
    console.log('tracker-apply: no committed records to write this run');
  }

  // ---- Read authoritative current state: FAIL CLOSED (GUARDS #24) ---------------------
  const currentByRecord = new Map();
  if (byRecord.size) {
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
  let blocked = 0;
  for (const agg of byRecord.values()) {
    const current = currentByRecord.get(agg.record_id);
    const currentStatus = String(current?.status || '').trim();
    const storedMilestones = current?.milestones;

    // ---- MIGRATION GATE (GUARDS #31) --------------------------------------------------
    // A row carrying a lifecycle status but NO milestones predates this model. Its history
    // is real but unrecorded, and projecting from an empty milestone set would silently
    // rewrite it — e.g. a completed order whose customer requests a revision would project
    // to `confirmed_unpaid`, because no `paid` fact exists to find. Blank must never be read
    // as "there was no history".
    if (currentStatus && __isBlank(storedMilestones)) {
      console.error(`ABORT: ${agg.record_id} has status "${currentStatus}" but no milestones — `
        + 'this row predates the milestone model. Run the backfill (docs/MIGRATION.md) before '
        + 'the automated lane may write to it.');
      blocked++;
      continue;
    }

    const row = { record_id: agg.record_id, phone: agg.phone };
    if (!__isBlank(agg.fields.start_date)) row.source_date = agg.fields.start_date;
    for (const f of ['client_name', 'doc_type', 'language_pair', 'price', 'delivery_time', 'summary']) {
      if (!__isBlank(agg.fields[f])) row[f] = agg.fields[f];
    }
    if (agg.counterparty) row.counterparty = agg.counterparty;

    if (agg.observations.length) {
      // Union of every lane's observations for this record, in true ingestion order.
      const ordered = [...agg.observations].sort(compareOccurrence);
      let merged;
      try {
        merged = mergeMilestones(storedMilestones, ordered);
      } catch (e) {
        if (e instanceof MilestoneStateError) {
          // Declared machine truth that cannot be read must never degrade to "no history".
          console.error(`ABORT: ${agg.record_id} has unreadable milestone state (${e.message}). `
            + 'Refusing to write; inspect the row and repair it with tracker-admin.');
          blocked++;
          continue;
        }
        throw e;
      }
      for (const r of merged.refused) {
        console.log(`guard: ${agg.record_id} refused ${r.observation} (${r.reason})`);
      }
      const status = projectStatus(merged.milestones);
      // The milestones column is the machine-readable truth; `status` is the human view
      // projected from it. Both are written together so they can never disagree.
      row.milestones = JSON.stringify(merged.milestones);
      row.status = status;
      if (merged.milestones.paid) row.paid_at = merged.milestones.paid.at;
      if (status !== currentStatus) {
        console.log(`  ${agg.record_id}: ${currentStatus || '(new)'} -> ${status}`);
      }
    } else if (agg.directStatus) {
      // A lane supplying a status with no observations must still clear the explicit gate.
      const verdict = canAutomatedTransition(currentStatus || null, agg.directStatus);
      if (VALID_STATUS.has(agg.directStatus) && verdict.allowed) row.status = agg.directStatus;
      else console.log(`guard: ${agg.record_id} kept "${currentStatus}" (${verdict.reason})`);
    }

    rows.push(row);
  }

  if (rows.length) {
    const res = await appendRows(rows, cfg, 'Records'); // upsert by record_id
    console.log('tracker-apply:', JSON.stringify(res), '| rows:', rows.length);
  }

  // A blocked record means real evidence was NOT recorded. Keep the cursor so it is retried
  // once the operator resolves the cause, rather than advancing past it.
  if (blocked) {
    console.error(`cursor kept: ${blocked} record(s) blocked and must be resolved`);
    process.exitCode = 1;
    return;
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
