#!/usr/bin/env node
'use strict';
// tracker-admin.cjs — the DETERMINISTIC correction tool for the agent lane.
//
// The agent reasons about what a record should say; this tool performs every write, so an
// agent never touches the store directly. It contains NO classification logic and calls no
// model. It provides the four properties that make an agent-driven write safe:
//
//   1. a FRESH snapshot (a stale one is refused);
//   2. an optimistic CONCURRENCY check — any row that changed since the snapshot aborts;
//   3. a BACKUP of every affected row before mutating;
//   4. a field-by-field READBACK after writing, before reporting success.
//
// Without these, "the agent fixed it" is a claim, not a fact. v1 shipped the agent contract
// promising them while the tool was omitted — so the guarantees were prose. This is that
// tool.
//
// Usage:
//   node scripts/tracker-admin.cjs snapshot [--phone DIGITS] [--output FILE]
//   node scripts/tracker-admin.cjs validate --snapshot FILE --proposal FILE
//   node scripts/tracker-admin.cjs apply    --snapshot FILE --proposal FILE --dry-run
//   node scripts/tracker-admin.cjs apply    --snapshot FILE --proposal FILE --confirm APPROVED --agent NAME
//   node scripts/tracker-admin.cjs inspect  --record RECORD_ID
//
// OPERATORS CORRECT FACTS, NOT THE PROJECTION (GUARDS #32).
//
// `status` is derived from milestones, so setting it directly produces a correction that the
// next real observation silently erases — and it gives no way to remove a FALSE milestone
// (e.g. a payment that never happened). Corrections therefore target the milestones, and the
// status re-projects from them. That is the same truth-ownership rule the automated lane
// follows: whatever is declared authoritative is what every write path must edit.
//
// Proposal shape:
//   { "corrections": [ {
//       "record_id": "...",
//       "fields": { "price": "AED 150", "counterparty": null },     // optional, non-status
//       "milestone_ops": {
//         "set":     { "final_delivered": { "evidence_msg_id": "3EB0C7..." } },
//         "clear":   ["paid"],
//         "replace": { ... }        // replaces the COLLECTION; same provenance rules apply
//       },
//       "note": "why — required"
//   } ] }
//   A JSON null CLEARS a descriptive field. `record_id`, `phone`, `status` and `paid_at` can
//   never be set directly — the last two are projections of the milestones.

const fs = require('fs');
const path = require('path');
const {
  MILESTONES, MilestoneStateError, RECORD_FIELDS, parseMilestones, projectStatus, tsToEpoch,
} = require('./lib/status-model.cjs');
const { normalizeCell } = require('./lib/sheet-normalize.cjs');
const { loadEnv } = require('./lib/agent-provider.cjs');
const { acquireRunLock, releaseRunLock } = require('./lib/run-lock.cjs');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');
// THE SAME lock the automated writer takes. Documentation told the operator to disable the
// scheduled task and wait for this file to clear — but a documented procedure is not a
// guarantee, and a tick that fires mid-apply is a split-brain write. Taking the real lock
// makes the watcher skip its tick automatically, so safety is ENFORCED rather than advised.
const LOCK = path.join(ROOT, '.tracker-lock');
const MAX_SNAPSHOT_AGE_MIN = 60;

// Descriptive fields a human may correct directly. `status` and `paid_at` are deliberately
// ABSENT — both are PROJECTIONS of the milestones, and correcting a projection is how a fix
// silently disappears on the next observation. Use milestone_ops instead.
const CORRECTABLE = new Set([...RECORD_FIELDS, 'counterparty', 'source_date']);
// Every field the safety machinery must cover: `milestones` is the authoritative state, and
// `status`/`paid_at` are the views derived from it. GUARDS #40 — `paid_at` was missing here,
// so it was never read, compared, backed up or written: clearing a false payment left the row
// reading confirmed_unpaid AND paid-at-X, and prep feeds paid_at back to the model as context.
const DERIVED_FIELDS = ['status', 'paid_at'];
const ROW_FIELDS = ['record_id', 'source_date', 'client_name', 'phone', 'doc_type',
  'language_pair', 'price', 'delivery_time', 'status', 'summary', 'counterparty',
  'paid_at', 'milestones'];

// Write the derived views from the authoritative facts. The SAME derivation tracker-apply
// performs, so the two write paths cannot disagree.
function applyProjections(after, milestones) {
  after.milestones = JSON.stringify(milestones);
  after.status = projectStatus(milestones);
  after.paid_at = milestones.paid ? milestones.paid.at : '';
}

const canon = (v) => String(v || '').replace(/\D/g, '');

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error('unexpected argument: ' + arg);
    const key = arg.slice(2);
    if (key === 'dry-run') { options[key] = true; continue; }
    if (i + 1 >= argv.length) throw new Error(arg + ' requires a value');
    options[key] = argv[++i];
  }
  return { command, options };
}

// Never guess which agent made a write — provenance that might be wrong is worse than
// provenance that says "unknown".
function resolveAgent(options) {
  const explicit = options.agent || process.env.TRACKER_AGENT;
  if (explicit) return String(explicit).trim();
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) return 'claude';
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return 'codex';
  return 'unidentified-agent';
}

async function io() {
  loadEnv(path.join(ROOT, '.env'));
  const { loadConfig } = await import('file://' + path.join(ROOT, 'config.js').replace(/\\/g, '/'));
  const sheet = await import('file://' + path.join(ROOT, 'src', 'sheet.js').replace(/\\/g, '/'));
  return { cfg: loadConfig(), sheet };
}

const normalizeRow = (row) => Object.fromEntries(
  ROW_FIELDS.map((f) => [f, normalizeCell(f, row ? row[f] : '')])
);

/**
 * Resolve a milestone occurrence for a correction.
 *
 * GUARDS #38 — THE EFFECT BOUNDARY VERIFIES WHAT IT CAN VERIFY. The automated lane never
 * lets the model supply a timestamp: it cites a message id and deterministic code resolves
 * `at` and `seq` from the mirror. The correction path must work the same way, or an agent's
 * three independent assertions (at, seq, message_id) become durable "facts" nobody checked.
 *
 * Two explicit modes, and no third:
 *   EVIDENCE  { evidence_msg_id } -> looked up in the mirror, verified to belong to this
 *             record's conversation, and its real timestamp/rowid used.
 *   BASELINE  { at, source: 'operator_baseline' } -> a fact known only to the operator or
 *             recovered from a lost history. Allowed, but LABELLED as such forever rather
 *             than dressed up as an observation.
 */
function resolveOccurrence(name, occ, recordPhone, resolver) {
  if (!occ || typeof occ !== 'object' || Array.isArray(occ)) {
    throw new Error(`milestone ${name} requires an occurrence object`);
  }
  const evidenceId = String(occ.evidence_msg_id || occ.message_id || '').trim();
  const declaredSource = String(occ.source || '').trim();

  if (declaredSource === 'operator_baseline') {
    const at = String(occ.at || '').trim();
    if (!at || tsToEpoch(at) === null) {
      throw new Error(`milestone ${name} baseline requires a parseable "at" timestamp`);
    }
    // No seq: there was no ingestion event. The projection treats a missing seq as a genuine
    // absence of precision rather than as position zero.
    return { at, seq: null, message_id: evidenceId || 'operator-baseline', source: 'operator_baseline' };
  }

  if (!evidenceId) {
    throw new Error(`milestone ${name} requires evidence_msg_id (or source:"operator_baseline" `
      + 'for a fact with no message evidence)');
  }
  if (!resolver) {
    throw new Error(`milestone ${name} cites evidence but the message mirror is unavailable; `
      + 'set WHATSAPP_DB_PATH, or use source:"operator_baseline" if the history is gone');
  }
  const found = resolver(evidenceId);
  if (!found) {
    throw new Error(`milestone ${name} cites message ${evidenceId}, which is not in the message `
      + 'mirror. Do not assert a timestamp for a message that cannot be found.');
  }
  // GUARDS #42: FAIL CLOSED when the conversation cannot be PROVEN. This check used to run
  // only when `found.phone` was non-empty — but an unresolved `@lid` chat (no LID map)
  // yields exactly that blank, so identity silently became "unverified" instead of
  // "unknown". The automated prep lane already refuses unresolved LIDs for this reason.
  // `operator_baseline` remains the explicit escape hatch.
  const wanted = String(recordPhone || '').replace(/\D/g, '');
  if (wanted && !found.phone) {
    throw new Error(`milestone ${name} cites message ${evidenceId}, but its conversation could `
      + 'not be resolved to a phone (an unmapped @lid chat). Refusing to attach unverified '
      + 'evidence — fix the LID map, or use source:"operator_baseline" and say so explicitly.');
  }
  if (wanted && found.phone !== wanted) {
    throw new Error(`milestone ${name} cites message ${evidenceId} from a DIFFERENT conversation `
      + `(${found.phone}) than the record's (${wanted})`);
  }
  return { at: found.at, seq: found.seq, message_id: evidenceId, source: 'evidence' };
}

// Look a message up in the mirror by id, returning its true timestamp, rowid and phone.
// Returns null (rather than throwing) when the mirror is unreadable, so a correction that
// needs no evidence still works on a machine without the bridge.
function createMessageResolver() {
  const dbPath = process.env.WHATSAPP_DB_PATH || '';
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    // readOnly WITH a finite timeout — without one this hangs on the bridge's live writes.
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
  } catch { return null; }

  const waDb = dbPath.replace(/messages\.db$/i, 'whatsapp.db');
  const lidToPn = new Map();
  try {
    const { DatabaseSync } = require('node:sqlite');
    const W = new DatabaseSync(waDb, { readOnly: true, timeout: 5000 });
    for (const r of W.prepare('SELECT lid, pn FROM whatsmeow_lid_map').all()) {
      lidToPn.set(String(r.lid), String(r.pn).replace(/\D/g, ''));
    }
  } catch { /* the phone check degrades to "unverified"; the lookup itself still works */ }

  return (messageId) => {
    const row = db.prepare(
      'SELECT rowid, id, chat_jid, timestamp FROM messages WHERE id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(String(messageId));
    if (!row) return null;
    const jid = String(row.chat_jid || '');
    const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].replace(/\D/g, '')
      : jid.endsWith('@lid') ? (lidToPn.get(jid.split('@')[0]) || '')
        : '';
    return { at: String(row.timestamp), seq: Number(row.rowid), phone, chat_jid: jid };
  };
}

function readJson(file, label) {
  if (!file) throw new Error('--' + label + ' is required');
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function writeOut(value, output) {
  const body = JSON.stringify(value, null, 2) + '\n';
  if (!output) { process.stdout.write(body); return; }
  const file = path.resolve(output);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  console.log(file);
}

async function snapshot(options) {
  const { cfg, sheet } = await io();
  const rows = await sheet.fetchRows(cfg, 'Records');
  const only = canon(options.phone);
  const filtered = only ? rows.filter((r) => canon(r.phone) === only) : rows;
  return {
    schema: 'tracker-admin-snapshot-v1',
    generated_at: new Date().toISOString(),
    row_count: rows.length,
    rows: filtered.map(normalizeRow),
  };
}

// Build the exact before/after plan. Pure — no I/O — so it can be reviewed before anything
// is touched, and unit-tested without a live store.
function buildPlan(snap, proposal, resolver = createMessageResolver()) {
  if (!snap || snap.schema !== 'tracker-admin-snapshot-v1') throw new Error('unsupported snapshot schema');
  if (!proposal || typeof proposal !== 'object') throw new Error('proposal must be an object');
  const corrections = Array.isArray(proposal.corrections) ? proposal.corrections : [];
  if (!corrections.length) throw new Error('proposal contains no corrections');

  const byId = new Map(snap.rows.map((r) => [String(r.record_id), r]));
  const seen = new Set();
  const writes = [];

  for (const c of corrections) {
    const id = String((c && c.record_id) || '').trim();
    if (!id) throw new Error('correction requires record_id');
    if (seen.has(id)) throw new Error('one record corrected twice in a single proposal: ' + id);
    seen.add(id);

    const before = byId.get(id);
    if (!before) throw new Error('correction references a record absent from the snapshot: ' + id);

    const note = String((c && c.note) || '').trim();
    // An unexplained correction is unauditable. Six months later nobody can tell a fix from
    // a mistake, so the note is mandatory.
    if (!note) throw new Error('correction requires a note explaining why: ' + id);

    const fields = (c && c.fields) || {};
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('correction fields must be an object: ' + id);
    }
    if (!Object.keys(fields).length && !c.milestone_ops) {
      throw new Error('correction requires fields and/or milestone_ops: ' + id);
    }

    const after = { ...before };
    for (const [field, value] of Object.entries(fields)) {
      if (field === 'status') {
        throw new Error('status is a projection of milestones and cannot be set directly; '
          + 'use milestone_ops (a status correction would vanish on the next observation)');
      }
      if (!CORRECTABLE.has(field)) throw new Error('field is not correctable: ' + field);
      after[field] = value === null ? '' : normalizeCell(field, value);
    }

    // ---- Milestone operations: the real correction path -------------------------------
    const ops = c.milestone_ops;
    if (ops) {
      if (typeof ops !== 'object' || Array.isArray(ops)) throw new Error('milestone_ops must be an object');
      let milestones;
      try {
        milestones = parseMilestones(before.milestones);
      } catch (e) {
        if (e instanceof MilestoneStateError) {
          // A corrupt cell is repairable ONLY by replacing the whole set, so the operator
          // must say so explicitly rather than accidentally building on unreadable state.
          if (!ops.replace) {
            throw new Error(`stored milestones for ${id} are unreadable (${e.message}); `
              + 'supply milestone_ops.replace with the full corrected set to repair it');
          }
          milestones = {};
        } else throw e;
      }
      // GUARDS #41: `replace` means "replace the COLLECTION", never "bypass provenance".
      // It used to hand its occurrences straight to parseMilestones, which validates shape
      // but verifies nothing — so an arbitrary {at, seq, message_id} became durable fact
      // through the one path that skipped the resolver.
      if (ops.replace) {
        if (typeof ops.replace !== 'object' || Array.isArray(ops.replace)) {
          throw new Error('milestone_ops.replace must be an object');
        }
        milestones = {};
        for (const [name, occ] of Object.entries(ops.replace)) {
          if (!MILESTONES.includes(name)) throw new Error('unknown milestone: ' + name);
          milestones[name] = resolveOccurrence(name, occ, before.phone, resolver);
        }
      }

      for (const name of (Array.isArray(ops.clear) ? ops.clear : [])) {
        if (!MILESTONES.includes(name)) throw new Error('unknown milestone: ' + name);
        delete milestones[name];
      }
      for (const [name, occ] of Object.entries(ops.set || {})) {
        if (!MILESTONES.includes(name)) throw new Error('unknown milestone: ' + name);
        milestones[name] = resolveOccurrence(name, occ, before.phone, resolver);
      }

      // Write the facts AND every view derived from them, together, so they cannot disagree.
      applyProjections(after, milestones);
    }

    const changed = ROW_FIELDS.filter((f) => String(before[f] || '') !== String(after[f] || ''));
    if (!changed.length) continue; // a no-op correction is not an error, just nothing to do
    writes.push({ record_id: id, before, after, changed_fields: changed, note });
  }

  return {
    schema: 'tracker-admin-plan-v1',
    snapshot_generated_at: snap.generated_at,
    generated_at: new Date().toISOString(),
    writes,
    no_op_count: corrections.length - writes.length,
  };
}

function assertFresh(plan) {
  const ageMs = Date.now() - Date.parse(plan.snapshot_generated_at || '');
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_SNAPSHOT_AGE_MIN * 60000) {
    throw new Error('snapshot is stale (>' + MAX_SNAPSHOT_AGE_MIN + ' min) — take a fresh one before applying');
  }
}

// OPTIMISTIC CONCURRENCY. Between snapshot and apply, the automated lane or a human may have
// changed a row. Overwriting that blindly is how an agent silently undoes someone's work.
function assertUnchanged(plan, liveRows) {
  const live = new Map(liveRows.map((r) => [String(r.record_id), normalizeRow(r)]));
  for (const w of plan.writes) {
    const now = live.get(w.record_id);
    if (!now) throw new Error('record vanished from the store since the snapshot: ' + w.record_id);
    const drift = ROW_FIELDS.filter((f) => String(now[f] || '') !== String(w.before[f] || ''));
    if (drift.length) {
      throw new Error('the store changed since the snapshot for ' + w.record_id
        + ' (' + drift.join(',') + ') — re-snapshot and rebuild the proposal');
    }
  }
}

function backup(plan, agent) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR,
    'correction-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(file, JSON.stringify({
    at: new Date().toISOString(),
    agent,
    rows_before: plan.writes.map((w) => w.before),
    intended_after: plan.writes.map((w) => w.after),
    notes: plan.writes.map((w) => ({ record_id: w.record_id, note: w.note })),
  }, null, 2));
  return file;
}

async function apply(options) {
  const snap = readJson(options.snapshot, 'snapshot');
  const plan = buildPlan(snap, readJson(options.proposal, 'proposal'));
  if (options['dry-run']) return { applied: false, plan };
  if (options.confirm !== 'APPROVED') throw new Error('--confirm APPROVED is required to write');
  assertFresh(plan);
  if (!plan.writes.length) return { applied: true, plan, pushed: 0 };

  const agent = resolveAgent(options);

  // Take the writer lock BEFORE reading live state, so the automated lane cannot slip a tick
  // between our concurrency check and our write.
  const lock = acquireRunLock(LOCK);
  if (!lock.acquired) {
    throw new Error('the tracker writer lock is held (pid ' + (lock.owner?.pid || '?')
      + ') — the automated lane is mid-tick. Retry in a moment, or stop the scheduled task first.');
  }

  try {
    const { cfg, sheet } = await io();
    assertUnchanged(plan, await sheet.fetchRows(cfg, 'Records'));
    const backupPath = backup(plan, agent);

    // Name every field being blanked, so the store clears exactly those cells and nothing
    // else. The blanket replaceEmpty flag would erase fields this correction never mentioned.
    const rows = plan.writes.map((w) => {
      const row = { record_id: w.record_id };
      const clear = [];
      for (const f of w.changed_fields) {
        if (f === 'record_id') continue;
        row[f] = w.after[f];
        if (String(w.after[f] || '') === '') clear.push(f);
      }
      if (clear.length) row.clear_fields = clear;
      return row;
    });
    await sheet.appendRows(rows, cfg, 'Records');

    // READBACK: verify every asserted cell actually landed. Reporting success without this
    // is reporting an intention.
    const after = new Map((await sheet.fetchRows(cfg, 'Records')).map((r) => [String(r.record_id), normalizeRow(r)]));
    const failures = [];
    for (const w of plan.writes) {
      const live = after.get(w.record_id);
      if (!live) { failures.push({ record_id: w.record_id, error: 'row absent after write' }); continue; }
      for (const f of w.changed_fields) {
        if (String(live[f] || '') !== String(w.after[f] || '')) {
          failures.push({ record_id: w.record_id, field: f, expected: w.after[f], actual: live[f] });
        }
      }
    }
    if (failures.length) {
      // Be precise about what did and did not happen. An earlier version claimed rows were
      // "restored from" the backup — nothing was restored; a backup was merely taken first.
      // A false rollback claim is worse than no rollback, because it stops the operator
      // investigating a store that is now in an unknown state.
      throw new Error('READBACK FAILED — the store does not match what was written: '
        + JSON.stringify(failures)
        + ' | NO automatic rollback was performed. Pre-write values are in ' + backupPath
        + ' — inspect the store and restore manually if needed.');
    }

    return {
      applied: true, agent, backup: backupPath,
      pushed: rows.length, readback_verified: true,
      plan,
    };
  } finally {
    releaseRunLock(lock);
  }
}

async function inspect(recordId) {
  if (!recordId) throw new Error('--record is required');
  const { cfg, sheet } = await io();
  const rows = (await sheet.fetchRows(cfg, 'Records')).filter((r) => String(r.record_id) === recordId);
  return { record_id: recordId, found: rows.length, rows: rows.map(normalizeRow) };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/tracker-admin.cjs snapshot [--phone DIGITS] [--output FILE]',
    '  node scripts/tracker-admin.cjs validate --snapshot FILE --proposal FILE [--output FILE]',
    '  node scripts/tracker-admin.cjs apply --snapshot FILE --proposal FILE --dry-run',
    '  node scripts/tracker-admin.cjs apply --snapshot FILE --proposal FILE --confirm APPROVED --agent NAME',
    '  node scripts/tracker-admin.cjs inspect --record RECORD_ID',
    '',
    'apply takes the SAME .tracker-lock the automated writer uses, so a tick cannot run',
    'concurrently. Stopping the scheduled task first is still tidier for a long session.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'help' || options.help) { console.log(usage()); return; }
  if (command === 'snapshot') return writeOut(await snapshot(options), options.output);
  if (command === 'validate') {
    return writeOut(
      buildPlan(readJson(options.snapshot, 'snapshot'), readJson(options.proposal, 'proposal')),
      options.output
    );
  }
  if (command === 'apply') return writeOut(await apply(options), options.output);
  if (command === 'inspect') return writeOut(await inspect(options.record), options.output);
  throw new Error('unknown command: ' + command + '\n' + usage());
}

if (require.main === module) {
  main().catch((error) => {
    console.error('tracker-admin FAILED:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { CORRECTABLE, DERIVED_FIELDS, ROW_FIELDS, buildPlan, assertFresh, assertUnchanged, normalizeRow, parseArgs, resolveAgent };
