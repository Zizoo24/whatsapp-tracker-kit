'use strict';
// ACCEPTANCE — the full pipeline against a STORE DOUBLE that replicates the deployed Apps
// Script's merge semantics exactly (upsert by key, non-empty merge, clear_fields, later row
// wins within a batch).
//
// WHY A DOUBLE AND NOT THE REAL SHEET: creating a scratch Sheet and deploying an Apps Script
// endpoint needs the operator's Google session, so it cannot happen here. The double is NOT a
// substitute for that run — see the "residual limitations" note in the README of this file's
// findings. What it DOES cover is every failure this project has actually shipped: they were
// all in the pipeline's own logic, and every one of them is reproduced end to end below.
//
// The double deliberately mirrors doPost's merge rules rather than a convenient in-memory
// map, because the clobber bug (GUARDS #30) lived precisely in those rules.

const test = require('node:test');
const assert = require('node:assert');
const { validateAndNormalizeClientResult } = require('../scripts/lib/client-result.cjs');
const { mergeCounterpartyUpdate } = require('../scripts/lib/result-merge.cjs');
const {
  MilestoneStateError, compareOccurrence, mergeMilestones, projectStatus,
} = require('../scripts/lib/status-model.cjs');

// ---- The store double -----------------------------------------------------------------
// Mirrors apps-script/Code.gs doPost: upsert by `record_id`; a field is written only when
// non-empty, OR named in clear_fields; rows in one batch apply in order.
const MERGE_FIELDS = ['source_date', 'client_name', 'phone', 'doc_type', 'language_pair',
  'price', 'delivery_time', 'status', 'summary', 'paid_at', 'counterparty', 'milestones'];

function createStore(seed = []) {
  const rows = new Map(seed.map((r) => [String(r.record_id), { ...r }]));
  return {
    read: () => [...rows.values()].map((r) => ({ ...r })),
    get: (id) => (rows.has(id) ? { ...rows.get(id) } : null),
    upsert(batch) {
      for (const incoming of batch) {
        const key = String(incoming.record_id);
        const clear = new Set(incoming.clear_fields || []);
        const current = rows.get(key) || { record_id: key };
        for (const f of MERGE_FIELDS) {
          const v = incoming[f] === undefined || incoming[f] === null ? '' : String(incoming[f]).trim();
          if (v || clear.has(f)) current[f] = v;
        }
        rows.set(key, current);
      }
      return { ok: true };
    },
  };
}

// ---- The writer, exactly as tracker-apply performs it ---------------------------------
// Aggregate by record_id -> union observations -> merge once -> project once -> ONE row.
function applyResults(store, results) {
  const byRecord = new Map();
  for (const entry of results) {
    for (const d of entry.records || []) {
      const id = String(d.record_id);
      const agg = byRecord.get(id) || { record_id: id, phone: entry.phone, fields: {}, observations: [], counterparty: '' };
      for (const f of ['start_date', 'client_name', 'doc_type', 'language_pair', 'price', 'delivery_time', 'summary']) {
        if (d[f] !== undefined && String(d[f]).trim() !== '') agg.fields[f] = d[f];
      }
      if (d.counterparty) agg.counterparty = d.counterparty;
      if (Array.isArray(d.observations)) agg.observations.push(...d.observations);
      byRecord.set(id, agg);
    }
  }

  const batch = [];
  const blocked = [];
  for (const agg of byRecord.values()) {
    const current = store.get(agg.record_id);
    const currentStatus = String(current?.status || '').trim();
    const stored = current?.milestones;

    // Migration gate (GUARDS #31).
    if (currentStatus && (stored === undefined || String(stored).trim() === '')) {
      blocked.push({ record_id: agg.record_id, reason: 'pre_milestone_row' });
      continue;
    }

    const row = { record_id: agg.record_id, phone: agg.phone };
    for (const [k, v] of Object.entries(agg.fields)) row[k === 'start_date' ? 'source_date' : k] = v;
    if (agg.counterparty) row.counterparty = agg.counterparty;

    if (agg.observations.length) {
      let merged;
      let status;
      try {
        merged = mergeMilestones(stored, [...agg.observations].sort(compareOccurrence));
        status = projectStatus(merged.milestones);
      } catch (e) {
        if (e instanceof MilestoneStateError) {
          blocked.push({ record_id: agg.record_id, reason: 'milestone_state', message: e.message });
          continue;
        }
        throw e;
      }
      row.milestones = JSON.stringify(merged.milestones);
      row.status = status;
      if (merged.milestones.paid) {
        row.paid_at = merged.milestones.paid.at;
      } else {
        row.paid_at = '';
        row.clear_fields = ['paid_at'];
      }
    }
    batch.push(row);
  }
  if (batch.length) store.upsert(batch);
  return { written: batch.length, blocked };
}

// ---- Scenario helpers -----------------------------------------------------------------
const PHONE = '971500000000';
let seq = 100;
const msg = (id, from, text, at) => ({ id, ts: at, seq: seq++, from, text });

function customerTick(store, newMessages, records) {
  const existing = store.read().filter((r) => String(r.phone) === PHONE);
  return validateAndNormalizeClientResult(
    { phone: PHONE, records },
    { phone: PHONE, existing_rows: existing, context: [], new_messages: newMessages }
  );
}

// =======================================================================================
test('ACCEPTANCE: commitment -> confirmed_unpaid -> paid -> translating -> done', () => {
  const store = createStore();
  const m1 = msg('a1', 'CUSTOMER', 'yes please go ahead', '2026-08-01T09:00:00Z');
  let res = customerTick(store, [m1], [{
    kind: 'new', order_anchor_id: 'a1', start_date: '2026-08-01', doc_type: 'passport',
    observations: [{ type: 'order_committed', evidence_msg_ids: ['a1'] }],
  }]);
  applyResults(store, [res]);
  const id = res.records[0].record_id;
  assert.equal(store.get(id).status, 'confirmed_unpaid');
  assert.equal(store.get(id).paid_at, '', 'no payment fact yet');

  const m2 = msg('a2', 'BUSINESS', 'payment received', '2026-08-01T10:00:00Z');
  applyResults(store, [customerTick(store, [m2], [{
    kind: 'update', record_id: id,
    observations: [{ type: 'payment_received', evidence_msg_ids: ['a2'] }],
  }])]);
  assert.equal(store.get(id).status, 'paid');
  assert.equal(store.get(id).paid_at, '2026-08-01T10:00:00Z', 'paid_at is derived, not invented');

  const m3 = msg('a3', 'BUSINESS', 'in translation now', '2026-08-01T11:00:00Z');
  applyResults(store, [customerTick(store, [m3], [{
    kind: 'update', record_id: id,
    observations: [{ type: 'work_started', evidence_msg_ids: ['a3'] }],
  }])]);
  assert.equal(store.get(id).status, 'translating');

  const m4 = msg('a4', 'BUSINESS', 'final certified file', '2026-08-01T15:00:00Z');
  applyResults(store, [customerTick(store, [m4], [{
    kind: 'update', record_id: id,
    observations: [{ type: 'final_delivered', evidence_msg_ids: ['a4'] }],
  }])]);
  assert.equal(store.get(id).status, 'done');
});

test('ACCEPTANCE: same-tick customer event + counterparty handoff -> ONE row, BOTH facts', () => {
  const store = createStore();
  const c1 = msg('b1', 'CUSTOMER', 'go ahead', '2026-08-01T09:00:00Z');
  const c2 = msg('b2', 'BUSINESS', 'payment received', '2026-08-01T09:30:00Z');
  const first = customerTick(store, [c1, c2], [{
    kind: 'new', order_anchor_id: 'b1', start_date: '2026-08-01', doc_type: 'passport',
    observations: [
      { type: 'order_committed', evidence_msg_ids: ['b1'] },
      { type: 'payment_received', evidence_msg_ids: ['b2'] },
    ],
  }]);
  applyResults(store, [first]);
  const id = first.records[0].record_id;

  // One tick: the customer pass sees a draft, the counterparty pass sees the handoff.
  const d1 = msg('b3', 'BUSINESS', 'draft for your review before we stamp', '2026-08-02T10:00:00Z');
  const v1 = msg('b4', 'BUSINESS', 'please do the passport one', '2026-08-02T10:05:00Z');
  const customer = customerTick(store, [d1], [{
    kind: 'update', record_id: id,
    observations: [{ type: 'draft_sent', evidence_msg_ids: ['b3'] }],
  }]);
  const results = [customer];
  mergeCounterpartyUpdate(results, id, 'vendor-a', {
    type: 'work_started', at: v1.ts, seq: v1.seq, message_id: v1.id,
  });

  const out = applyResults(store, results);
  assert.equal(out.written, 1, 'EXACTLY one row per record per tick');

  const row = store.get(id);
  const facts = JSON.parse(row.milestones);
  assert.ok(facts.draft_sent, 'customer-pass fact survived');
  assert.ok(facts.work_started, 'counterparty-pass fact survived');
  assert.ok(facts.paid, 'stored fact survived');
  assert.equal(row.counterparty, 'vendor-a');
  assert.equal(row.status, 'translating');
});

test('ACCEPTANCE: delivered BEFORE payment stays confirmed_unpaid, then completes on payment', () => {
  const store = createStore();
  const m1 = msg('c1', 'CUSTOMER', 'go ahead', '2026-08-01T09:00:00Z');
  const m2 = msg('c2', 'BUSINESS', 'here is your final certified file', '2026-08-01T12:00:00Z');
  const res = customerTick(store, [m1, m2], [{
    kind: 'new', order_anchor_id: 'c1', start_date: '2026-08-01', doc_type: 'passport',
    observations: [
      { type: 'order_committed', evidence_msg_ids: ['c1'] },
      { type: 'final_delivered', evidence_msg_ids: ['c2'] },
    ],
  }]);
  applyResults(store, [res]);
  const id = res.records[0].record_id;
  assert.equal(store.get(id).status, 'confirmed_unpaid', 'unpaid is unpaid even when delivered');

  // Day 2 — payment lands. The delivery is now OLD context and is NOT re-cited.
  const m3 = msg('c3', 'BUSINESS', 'payment received', '2026-08-02T09:00:00Z');
  applyResults(store, [customerTick(store, [m3], [{
    kind: 'update', record_id: id,
    observations: [{ type: 'payment_received', evidence_msg_ids: ['c3'] }],
  }])]);
  assert.equal(store.get(id).status, 'done', 'milestones remembered the delivery');
});

test('ACCEPTANCE: same-second delivery then revision -> revision; re-delivery -> done', () => {
  const store = createStore();
  const at = '2026-08-01T12:00:00Z';
  const m1 = msg('d1', 'CUSTOMER', 'go ahead', '2026-08-01T09:00:00Z');
  const m2 = msg('d2', 'BUSINESS', 'payment received', '2026-08-01T10:00:00Z');
  const m3 = msg('d3', 'BUSINESS', 'final file', at);
  const m4 = msg('d4', 'CUSTOMER', 'please fix the surname spelling', at); // SAME second, later seq
  const res = customerTick(store, [m1, m2, m3, m4], [{
    kind: 'new', order_anchor_id: 'd1', start_date: '2026-08-01', doc_type: 'passport',
    observations: [
      { type: 'order_committed', evidence_msg_ids: ['d1'] },
      { type: 'payment_received', evidence_msg_ids: ['d2'] },
      { type: 'final_delivered', evidence_msg_ids: ['d3'] },
      { type: 'revision_requested', evidence_msg_ids: ['d4'] },
    ],
  }]);
  applyResults(store, [res]);
  const id = res.records[0].record_id;
  assert.equal(store.get(id).status, 'revision', 'the same-second correction must not be swallowed');

  const m5 = msg('d5', 'BUSINESS', 'corrected final file', '2026-08-03T09:00:00Z');
  applyResults(store, [customerTick(store, [m5], [{
    kind: 'update', record_id: id,
    observations: [{ type: 'final_delivered', evidence_msg_ids: ['d5'] }],
  }])]);
  assert.equal(store.get(id).status, 'done');
});

test('ACCEPTANCE: a counterparty work fact survives a same-tick terminal customer event', () => {
  const store = createStore();
  const m1 = msg('e1', 'CUSTOMER', 'go ahead', '2026-08-01T09:00:00Z');
  const m2 = msg('e2', 'BUSINESS', 'payment received', '2026-08-01T10:00:00Z');
  const first = customerTick(store, [m1, m2], [{
    kind: 'new', order_anchor_id: 'e1', start_date: '2026-08-01', doc_type: 'passport',
    observations: [
      { type: 'order_committed', evidence_msg_ids: ['e1'] },
      { type: 'payment_received', evidence_msg_ids: ['e2'] },
    ],
  }]);
  applyResults(store, [first]);
  const id = first.records[0].record_id;

  const m3 = msg('e3', 'CUSTOMER', 'please cancel it', '2026-08-02T09:00:00Z');
  const v1 = msg('e4', 'BUSINESS', 'do the passport one', '2026-08-02T08:00:00Z');
  const results = [customerTick(store, [m3], [{
    kind: 'update', record_id: id,
    observations: [{ type: 'order_cancelled', evidence_msg_ids: ['e3'] }],
  }])];
  mergeCounterpartyUpdate(results, id, 'vendor-a', {
    type: 'work_started', at: v1.ts, seq: v1.seq, message_id: v1.id,
  });
  applyResults(store, results);

  const row = store.get(id);
  assert.equal(row.status, 'cancelled', 'the terminal outcome still wins the status');
  assert.ok(JSON.parse(row.milestones).work_started, 'but who did the work is still recorded');
  assert.equal(row.counterparty, 'vendor-a');
});

test('ACCEPTANCE: clearing a false paid milestone leaves status and paid_at consistent', () => {
  const store = createStore();
  const m1 = msg('f1', 'CUSTOMER', 'go ahead', '2026-08-01T09:00:00Z');
  const m2 = msg('f2', 'BUSINESS', 'payment received', '2026-08-01T10:00:00Z');
  const res = customerTick(store, [m1, m2], [{
    kind: 'new', order_anchor_id: 'f1', start_date: '2026-08-01', doc_type: 'passport',
    observations: [
      { type: 'order_committed', evidence_msg_ids: ['f1'] },
      { type: 'payment_received', evidence_msg_ids: ['f2'] },
    ],
  }]);
  applyResults(store, [res]);
  const id = res.records[0].record_id;
  assert.equal(store.get(id).paid_at, '2026-08-01T10:00:00Z');

  // The operator corrects the FACT (as tracker-admin does), then the row is rewritten.
  const corrected = JSON.parse(store.get(id).milestones);
  delete corrected.paid;
  store.upsert([{
    record_id: id,
    milestones: JSON.stringify(corrected),
    status: projectStatus(corrected),
    paid_at: '',
    clear_fields: ['paid_at'],
  }]);

  const row = store.get(id);
  assert.equal(row.status, 'confirmed_unpaid');
  assert.equal(row.paid_at, '', 'a derived view must be cleared with its fact, not left stale');
  assert.ok(!JSON.parse(row.milestones).paid);
});

test('ACCEPTANCE: malformed milestone JSON blocks the write and keeps the row intact', () => {
  const store = createStore([{
    record_id: 'X', phone: PHONE, status: 'paid', milestones: '{broken', paid_at: '2026-08-01T10:00:00Z',
  }]);
  const before = store.get('X');
  const out = applyResults(store, [{
    phone: PHONE,
    records: [{
      record_id: 'X',
      observations: [{ type: 'final_delivered', at: '2026-08-02T09:00:00Z', seq: 900, message_id: 'z' }],
    }],
  }]);
  assert.equal(out.written, 0);
  assert.equal(out.blocked[0].reason, 'milestone_state');
  assert.deepEqual(store.get('X'), before, 'nothing may be written over unreadable truth');
});

test('ACCEPTANCE: a pre-milestone row blocks migration instead of being rewritten', () => {
  const store = createStore([{ record_id: 'L', phone: PHONE, status: 'done', milestones: '' }]);
  const out = applyResults(store, [{
    phone: PHONE,
    records: [{
      record_id: 'L',
      observations: [{ type: 'revision_requested', at: '2026-08-02T09:00:00Z', seq: 900, message_id: 'z' }],
    }],
  }]);
  assert.equal(out.written, 0);
  assert.equal(out.blocked[0].reason, 'pre_milestone_row');
  assert.equal(store.get('L').status, 'done', 'a completed order must not silently become unpaid');
});

test('ACCEPTANCE: re-applying the same tick is idempotent (kept-cursor retry)', () => {
  const store = createStore();
  const m1 = msg('g1', 'CUSTOMER', 'go ahead', '2026-08-01T09:00:00Z');
  const m2 = msg('g2', 'BUSINESS', 'payment received', '2026-08-01T10:00:00Z');
  const build = () => customerTick(store, [m1, m2], [{
    kind: 'new', order_anchor_id: 'g1', start_date: '2026-08-01', doc_type: 'passport',
    observations: [
      { type: 'order_committed', evidence_msg_ids: ['g1'] },
      { type: 'payment_received', evidence_msg_ids: ['g2'] },
    ],
  }]);

  const first = build();
  applyResults(store, [first]);
  const after1 = store.get(first.records[0].record_id);
  assert.equal(store.read().length, 1);

  // The cursor was kept, so the identical delta is re-extracted and re-applied.
  applyResults(store, [build()]);
  assert.equal(store.read().length, 1, 'no duplicate row — the id is deterministic');
  assert.deepEqual(store.get(first.records[0].record_id), after1, 'and the state is unchanged');
});
