#!/usr/bin/env node
'use strict';
// tracker-prep.cjs — DETERMINISTIC INPUT ASSEMBLY. No model call happens here.
//
// Finds chats with newly INGESTED messages (rowid delta, not timestamp) and writes one JSON
// file per chat containing:
//   new_messages : EVERY message in the rowid delta. Never truncated. The only valid evidence.
//   context      : older messages, capped. Reading comprehension only.
//
// THAT SPLIT IS LOAD-BEARING (docs/GUARDS.md #23). v1 emitted one `conversation` array
// sorted by (timestamp, rowid) and let the watcher keep only the newest N entries. A message
// can be newly INGESTED with an OLD send timestamp — that is the entire reason the cursor is
// a rowid — so it sorted toward the front, got truncated away, and the cursor still advanced
// past its rowid. That silently violates the cardinal rule: never advance a cursor over a
// message the model was not shown.
//
// If a chat's new-message delta exceeds the budget we LOWER THE INGESTION BOUNDARY for the
// whole pass rather than dropping evidence. The remainder is picked up next tick.
//
// Usage: node scripts/tracker-prep.cjs
// DO NOT RUN THIS WHILE A TICK IS LIVE — it wipes the work directory.

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { COUNTERPARTIES, COUNTERPARTY_GROUPS } = require('./lib/counterparty.cjs');
const { HANDOFF_ELIGIBLE } = require('./lib/status-model.cjs');
const {
  createMessageBoundary,
  isMessageNew,
  latestTimestamp,
  readCursorState,
} = require('./lib/message-cursor.cjs');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'tracker-state.json');
const WORKDIR = path.join(ROOT, '.tracker-work');

// Budget for NEW messages per chat. Exceeding it lowers the boundary; it never truncates.
const MAX_NEW = Number(process.env.TRACKER_MAX_NEW_MSGS || 150);
// Cap for historical CONTEXT, which is safe to truncate — it can never justify a write.
const MAX_CONTEXT = Number(process.env.TRACKER_MAX_CONTEXT_MSGS || 150);

const canon = (s) => String(s || '').replace(/\D/g, '');
const fail = (msg) => { console.error('prep ABORT: ' + msg); process.exit(1); };

// FULL timestamp plus the mirror's rowid as `seq`.
//
// v1.1 truncated to minute precision (`slice(0, 16)`) while validation ordered observations
// by that timestamp. A payment confirmation and a file send routinely land in the SAME
// minute, so their order — which decides paid-vs-delivered — was effectively arbitrary.
// `seq` is exact ingestion order and is what validation sorts on.
const toRow = (m, from, isNew) => ({
  id: m.id,
  ts: String(m.timestamp),
  seq: Number(m.rowid),
  from,
  is_new: isNew,
  text: m.content || (m.media_type ? '[' + m.media_type + (m.filename ? ': ' + m.filename : '') + ']' : ''),
});

(async () => {
  const { loadConfig } = await import('file://' + path.join(ROOT, 'config.js').replace(/\\/g, '/'));
  const { fetchRows } = await import('file://' + path.join(ROOT, 'src', 'sheet.js').replace(/\\/g, '/'));
  const cfg = loadConfig();
  if (!cfg.dbPath) fail('WHATSAPP_DB_PATH is not set (see .env)');

  const MSG_DB = cfg.dbPath;
  const WA_DB = MSG_DB.replace(/messages\.db$/i, 'whatsapp.db');

  // ALWAYS readOnly WITH a finite timeout. Without a finite timeout, node:sqlite HANGS
  // indefinitely on the bridge's live writes — the tick never returns and the lane wedges.
  const M = new DatabaseSync(MSG_DB, { readOnly: true, timeout: 5000 });
  const st = readCursorState(STATE);
  const boundary = createMessageBoundary(M, st);
  const { mode: cursorMode, sinceRowid, sinceTs } = boundary;

  // ---- lid map: FAIL CLOSED (GUARDS #24) ----------------------------------------------
  // Modern WhatsApp keys chats by '<lid>@lid', not '<phone>@s.whatsapp.net'. Without this
  // map a chat resolves to no phone and vanishes from the manifest — and then the global
  // cursor advances past its messages anyway. v1 logged the failure and continued, which
  // turned a transient read error into permanent, silent data loss.
  const lidToPn = new Map();
  const pnToLids = new Map();
  try {
    const W = new DatabaseSync(WA_DB, { readOnly: true, timeout: 5000 });
    for (const r of W.prepare('SELECT lid, pn FROM whatsmeow_lid_map').all()) {
      const lid = String(r.lid);
      const pn = canon(r.pn);
      lidToPn.set(lid, pn);
      if (!pnToLids.has(pn)) pnToLids.set(pn, []);
      pnToLids.get(pn).push(lid);
    }
  } catch (e) {
    fail('lid map unavailable (' + e.message + ') — refusing to run, because @lid chats '
      + 'would silently disappear while the cursor advanced past them');
  }

  const jidToPhone = (jid) => {
    if (jid.endsWith('@s.whatsapp.net')) return canon(jid.split('@')[0]);
    if (jid.endsWith('@lid')) return lidToPn.get(jid.split('@')[0]) || '';
    return '';
  };

  // ---- store read: FAIL CLOSED (GUARDS #24) -------------------------------------------
  // Existing rows are AUTHORITATIVE. Continuing with an empty set makes every established
  // record look brand new, so the model re-creates records that already exist.
  let storeRows;
  try {
    storeRows = await fetchRows(cfg, 'Records');
  } catch (e) {
    fail('store read failed (' + e.message + ') — refusing to run, because existing records '
      + 'would look new and be duplicated');
  }
  const rowsByPhone = {};
  for (const r of storeRows) {
    const ph = canon(r.phone);
    if (ph) (rowsByPhone[ph] = rowsByPhone[ph] || []).push(r);
  }

  // ---- Choose the ingestion boundary --------------------------------------------------
  // Start at the frozen maximum, then LOWER it until no chat's new-message delta exceeds
  // the budget. Lowering only ever shrinks every chat's delta, so this terminates.
  const activeSql = cursorMode === 'rowid'
    ? "SELECT chat_jid FROM messages WHERE (chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid') "
      + 'AND rowid > ? AND rowid <= ? GROUP BY chat_jid'
    : "SELECT chat_jid FROM messages WHERE (chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid') "
      + 'AND timestamp > ? AND rowid <= ? GROUP BY chat_jid';

  const newRowidsForJids = (jids, ceiling) => {
    const ph = '(' + jids.map(() => '?').join(',') + ')';
    return cursorMode === 'rowid'
      ? M.prepare('SELECT rowid FROM messages WHERE chat_jid IN ' + ph
          + ' AND rowid > ? AND rowid <= ? ORDER BY rowid').all(...jids, sinceRowid, ceiling)
      : M.prepare('SELECT rowid FROM messages WHERE chat_jid IN ' + ph
          + ' AND timestamp > ? AND rowid <= ? ORDER BY rowid').all(...jids, sinceTs, ceiling);
  };

  const jidsForPhone = (phone) => [
    phone + '@s.whatsapp.net',
    ...(pnToLids.get(phone) || []).map((l) => l + '@lid'),
  ];

  let ceiling = boundary.maxRowid;
  let chunked = false;
  for (let pass = 0; pass < 12; pass++) {
    const active = cursorMode === 'rowid'
      ? M.prepare(activeSql).all(sinceRowid, ceiling)
      : M.prepare(activeSql).all(sinceTs, ceiling);

    const groups = new Map();
    for (const a of active) {
      const phone = jidToPhone(a.chat_jid);
      // An unresolvable jid must not be silently skipped — that is the failure the lid-map
      // fail-closed above exists to prevent, arriving by another route.
      if (!phone) {
        fail('chat ' + a.chat_jid + ' has new messages but no resolvable phone — refusing to '
          + 'advance the cursor past a conversation the model cannot be shown');
      }
      if (!groups.has(phone)) groups.set(phone, jidsForPhone(phone));
    }
    for (const jid of Object.keys(COUNTERPARTY_GROUPS)) {
      const rows = cursorMode === 'rowid'
        ? M.prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND rowid > ? AND rowid <= ? LIMIT 1')
          .all(jid, sinceRowid, ceiling)
        : M.prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND timestamp > ? AND rowid <= ? LIMIT 1')
          .all(jid, sinceTs, ceiling);
      if (rows.length) groups.set('group:' + jid, [jid]);
    }

    let lowered = null;
    for (const jids of groups.values()) {
      const rowids = newRowidsForJids(jids, ceiling);
      if (rowids.length > MAX_NEW) {
        // Cut at the budget-th new message. Everything above it waits for the next tick.
        const cut = Number(rowids[MAX_NEW - 1].rowid);
        lowered = lowered == null ? cut : Math.min(lowered, cut);
      }
    }
    if (lowered == null) break;
    ceiling = lowered;
    chunked = true;
  }

  if (chunked) {
    console.log('prep: ingestion boundary CHUNKED to rowid ' + ceiling
      + ' (a chat exceeded ' + MAX_NEW + ' new messages; the remainder follows next tick)');
  }

  const isNew = (m) => isMessageNew(m, { ...boundary, maxRowid: ceiling });

  // ---- Assemble per-chat inputs -------------------------------------------------------
  fs.rmSync(WORKDIR, { recursive: true, force: true });
  fs.mkdirSync(WORKDIR, { recursive: true });

  const activeChats = cursorMode === 'rowid'
    ? M.prepare(activeSql).all(sinceRowid, ceiling)
    : M.prepare(activeSql).all(sinceTs, ceiling);

  const phones = new Set();
  const activeCounterparties = new Set();
  for (const a of activeChats) {
    const ph = jidToPhone(a.chat_jid);
    if (!ph) continue; // already fail-closed above
    if (COUNTERPARTIES[ph]) activeCounterparties.add(ph);
    else phones.add(ph);
  }
  const activeGroups = new Set();
  for (const jid of Object.keys(COUNTERPARTY_GROUPS)) {
    const rows = cursorMode === 'rowid'
      ? M.prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND rowid > ? AND rowid <= ? LIMIT 1')
        .all(jid, sinceRowid, ceiling)
      : M.prepare('SELECT 1 FROM messages WHERE chat_jid = ? AND timestamp > ? AND rowid <= ? LIMIT 1')
        .all(jid, sinceTs, ceiling);
    if (rows.length) activeGroups.add(jid);
  }

  const manifest = [];
  let maxTs = st.lastTs || sinceTs;

  for (const phone of phones) {
    const jids = jidsForPhone(phone);
    const ph = '(' + jids.map(() => '?').join(',') + ')';
    const msgs = M.prepare(
      'SELECT rowid,id,timestamp,is_from_me,media_type,filename,content FROM messages '
      + 'WHERE chat_jid IN ' + ph + ' AND rowid <= ? ORDER BY timestamp,rowid'
    ).all(...jids, ceiling);
    if (!msgs.length) continue;

    // EVERY new message survives. Only context is capped.
    const newMessages = [];
    const context = [];
    for (const m of msgs) {
      if (isNew(m)) {
        newMessages.push(toRow(m, m.is_from_me ? 'BUSINESS' : 'CUSTOMER', true));
        maxTs = latestTimestamp(maxTs, m.timestamp);
      } else {
        context.push(toRow(m, m.is_from_me ? 'BUSINESS' : 'CUSTOMER', false));
      }
    }
    if (!newMessages.length) continue;
    const trimmedContext = context.slice(-MAX_CONTEXT);

    // `milestones` travels with each existing row so validation can tell whether new
    // observations would actually change a terminal record.
    const existing_rows = (rowsByPhone[phone] || []).map((r) => ({
      record_id: r.record_id, source_date: String(r.source_date).slice(0, 10), doc_type: r.doc_type,
      price: r.price, status: r.status, paid_at: r.paid_at || '', client_name: r.client_name || '',
      language_pair: r.language_pair || '', delivery_time: r.delivery_time || '', summary: r.summary || '',
      milestones: r.milestones || '',
    }));
    const file = path.join(WORKDIR, 'chat_' + phone + '.json');
    fs.writeFileSync(file, JSON.stringify({
      phone, jids, existing_rows,
      context: trimmedContext,
      new_messages: newMessages,
      context_truncated: context.length > trimmedContext.length,
    }, null, 1));
    manifest.push({
      phone, file, new: newMessages.length, context: trimmedContext.length, existing: existing_rows.length,
    });
  }

  // ---- Counterparty pass inputs -------------------------------------------------------
  // STRUCTURAL GUARD (GUARDS #11): only HANDOFF_ELIGIBLE records are offered as candidates.
  // We forward documents to a counterparty JUST TO GET A PRICE QUOTE, which is not a
  // handoff. Filtering here, in code, means a quote-check can never be misread as one — no
  // matter what the model concludes. Do not move this into the prompt.
  const inFlight = storeRows
    .filter((r) => canon(r.phone) && !COUNTERPARTIES[canon(r.phone)]
      && HANDOFF_ELIGIBLE.has(String(r.status).trim()) && r.record_id)
    .map((r) => ({
      record_id: r.record_id, source_date: String(r.source_date).slice(0, 10),
      client_name: r.client_name || '', doc_type: r.doc_type,
      language_pair: r.language_pair || '', price: r.price, status: r.status, summary: r.summary || '',
    }));

  const counterparties = [];
  const channels = [
    ...[...activeCounterparties].map((p) => ({ name: COUNTERPARTIES[p], phone: p, jids: null })),
    ...[...activeGroups].map((g) => ({ name: COUNTERPARTY_GROUPS[g], phone: '', jids: [g] })),
  ];

  for (const ch of channels) {
    const jids = ch.jids || jidsForPhone(ch.phone);
    const ph = '(' + jids.map(() => '?').join(',') + ')';
    const lookback = new Date(Date.now() - cfg.counterpartyLookbackDays * 864e5)
      .toISOString().replace('T', ' ').slice(0, 19);
    // Union the context window with the rowid delta: a RESTORED message can be newly
    // inserted with an OLD send timestamp and would fall outside a pure time window.
    const msgs = cursorMode === 'rowid'
      ? M.prepare(
        'SELECT rowid,id,timestamp,is_from_me,media_type,filename,content FROM messages '
        + 'WHERE chat_jid IN ' + ph + ' AND rowid <= ? AND (timestamp > ? OR rowid > ?) ORDER BY timestamp,rowid'
      ).all(...jids, ceiling, lookback, sinceRowid)
      : M.prepare(
        'SELECT rowid,id,timestamp,is_from_me,media_type,filename,content FROM messages '
        + 'WHERE chat_jid IN ' + ph + ' AND rowid <= ? AND timestamp > ? ORDER BY timestamp,rowid'
      ).all(...jids, ceiling, lookback);
    if (!msgs.length) continue;

    const newMessages = [];
    const context = [];
    for (const m of msgs) {
      if (isNew(m)) {
        newMessages.push(toRow(m, m.is_from_me ? 'BUSINESS' : 'COUNTERPARTY', true));
        maxTs = latestTimestamp(maxTs, m.timestamp);
      } else {
        context.push(toRow(m, m.is_from_me ? 'BUSINESS' : 'COUNTERPARTY', false));
      }
    }
    if (!newMessages.length) continue;

    const file = path.join(WORKDIR, 'counterparty_' + ch.name + '.json');
    fs.writeFileSync(file, JSON.stringify({
      counterparty: ch.name, phone: ch.phone, in_flight: inFlight,
      context: context.slice(-MAX_CONTEXT),
      new_messages: newMessages,
    }, null, 1));
    counterparties.push({
      counterparty: ch.name, file, new: newMessages.length, in_flight: inFlight.length,
    });
  }

  fs.writeFileSync(path.join(WORKDIR, 'manifest.json'), JSON.stringify({
    cursorMode, sinceRowid, sinceTs,
    maxRowid: ceiling,          // the cursor may advance ONLY to what we actually processed
    frozenMaxRowid: boundary.maxRowid,
    chunked, maxTs,
    count: manifest.length, chats: manifest, counterparties,
  }, null, 1));

  console.log(
    'tracker-prep:',
    cursorMode === 'rowid' ? 'after rowid ' + sinceRowid : 'since ' + sinceTs,
    '-> rowid ' + ceiling + (chunked ? ' (chunked from ' + boundary.maxRowid + ')' : ''),
    '| customer chats:', manifest.length,
    '| counterparty chats:', counterparties.length
  );
  manifest.forEach((m) => console.log('  ' + m.phone + '  new=' + m.new + '  context=' + m.context + '  existing=' + m.existing));
  counterparties.forEach((v) => console.log('  counterparty:' + v.counterparty + '  new=' + v.new + '  in_flight=' + v.in_flight));
  if (!manifest.length && !counterparties.length) console.log('  (nothing new — the tick can skip the model entirely)');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
