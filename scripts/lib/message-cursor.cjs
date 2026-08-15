'use strict';
// message-cursor.cjs — THE LOAD-BEARING CORRECTNESS FIX. Ported verbatim. Treat as frozen.
//
// WHY ROWID AND NOT TIMESTAMP (this is not a style preference):
// `messages` is a rowid table and rowid order != timestamp order. Measured in the source
// system: 20 inversions in the last 4,000 messages, worst ~6 days late. A timestamp
// watermark therefore makes a late-arriving message with an OLD timestamp unreachable
// FOREVER — the watermark has already passed it. That is not a patchable bug; it is an
// entire outage blind-spot class. SQLite rowid is LOCAL INGESTION ORDER, which is exactly
// the thing we want to page through, so backlog restored after sleep stays visible.
//
// If anyone proposes reverting to timestamps, that inversion measurement is the counter-example.
//
// CARDINAL RULE: never advance a cursor over a message you did not show the model.
// Every silent-data-loss bug this system has had has that shape.

const fs = require('fs');
const path = require('path');

// Only used on a COLD START (no lastRowid yet). Never a fallback for a live cursor.
const FALLBACK_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

function readCursorState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function asRowid(value) {
  const rowid = Number(value);
  return Number.isSafeInteger(rowid) && rowid >= 0 ? rowid : null;
}

function latestTimestamp(left, right) {
  if (!left) return String(right || '');
  if (!right) return String(left || '');
  const leftMs = Date.parse(String(left).replace(' ', 'T'));
  const rightMs = Date.parse(String(right).replace(' ', 'T'));
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return rightMs > leftMs ? String(right) : String(left);
  }
  return String(right) > String(left) ? String(right) : String(left);
}

// Freeze the pass at maxRowid. Messages inserted WHILE the model reasons stay above this
// boundary and are picked up next pass instead of being skipped.
function createMessageBoundary(db, state = {}, nowMs = Date.now()) {
  const snapshot = db.prepare(
    'SELECT COALESCE(MAX(rowid), 0) maxRowid, MAX(timestamp) maxTs FROM messages'
  ).get();
  const sinceRowid = asRowid(state.lastRowid);
  const fallbackSinceTs = new Date(nowMs - FALLBACK_LOOKBACK_MS)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  return {
    mode: sinceRowid == null ? 'timestamp' : 'rowid',
    sinceRowid: sinceRowid == null ? 0 : sinceRowid,
    sinceTs: String(state.lastTs || fallbackSinceTs),
    maxRowid: Number(snapshot?.maxRowid || 0),
    snapshotMaxTs: String(snapshot?.maxTs || ''),
  };
}

function isMessageNew(message, boundary) {
  if (boundary.mode === 'rowid') {
    const rowid = Number(message?.rowid || 0);
    return rowid > boundary.sinceRowid && rowid <= boundary.maxRowid;
  }
  return String(message?.timestamp || '') > boundary.sinceTs;
}

function nextCursorState(current = {}, manifest = {}, nowIso = new Date().toISOString()) {
  const currentRowid = asRowid(current.lastRowid) || 0;
  const manifestRowid = asRowid(manifest.maxRowid);
  const lastRowid = manifestRowid == null
    ? currentRowid
    : Math.max(currentRowid, manifestRowid);
  const lastTs = latestTimestamp(current.lastTs, manifest.maxTs);

  return {
    ...current,
    lastTs,
    lastRowid,
    cursorMode: 'rowid',
    updatedAt: nowIso,
    lastSuccessAt: nowIso,
  };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1) + '\n');
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

function advanceCursorState(file, manifest, nowIso = new Date().toISOString()) {
  const next = nextCursorState(readCursorState(file), manifest, nowIso);
  writeJsonAtomic(file, next);
  return next;
}

module.exports = {
  FALLBACK_LOOKBACK_MS,
  advanceCursorState,
  asRowid,
  createMessageBoundary,
  isMessageNew,
  latestTimestamp,
  nextCursorState,
  readCursorState,
  writeJsonAtomic,
};
