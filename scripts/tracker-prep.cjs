#!/usr/bin/env node
'use strict';
// tracker-prep.cjs — DETERMINISTIC INPUT ASSEMBLY. No model call happens here.
//
// Finds chats with newly INGESTED messages (rowid delta, not timestamp) and writes one
// JSON file per chat containing the conversation plus that counterparty's existing store
// rows, so the model can reconcile against authoritative state instead of guessing.
//
// Usage: node scripts/tracker-prep.cjs
//
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

const canon = (s) => String(s || '').replace(/\D/g, '');

(async () => {
  const { loadConfig } = await import('file://' + path.join(ROOT, 'config.js').replace(/\\/g, '/'));
  const { fetchRows } = await import('file://' + path.join(ROOT, 'src', 'sheet.js').replace(/\\/g, '/'));
  const cfg = loadConfig();
  if (!cfg.dbPath) throw new Error('WHATSAPP_DB_PATH is not set (see .env)');

  const MSG_DB = cfg.dbPath;
  // The lid->phone map lives in a sibling DB written by the same bridge.
  const WA_DB = MSG_DB.replace(/messages\.db$/i, 'whatsapp.db');

  // ALWAYS readOnly WITH a finite timeout. Without a finite timeout, node:sqlite HANGS
  // indefinitely on the bridge's live writes — the tick never returns and the lane wedges.
  const M = new DatabaseSync(MSG_DB, { readOnly: true, timeout: 5000 });
  const st = readCursorState(STATE);
  const boundary = createMessageBoundary(M, st);
  const { mode: cursorMode, sinceRowid, sinceTs, maxRowid } = boundary;

  // MODERN WHATSAPP KEYS CHATS BY @lid, NOT BY PHONE. Without this map a phone number
  // resolves to nothing and the chat is invisible. Both rails must be queried together,
  // because one contact's history can span both.
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
  } catch (e) { console.error('lid map unavailable:', e.message); }

  const jidToPhone = (jid) => {
    if (jid.endsWith('@s.whatsapp.net')) return canon(jid.split('@')[0]);
    if (jid.endsWith('@lid')) return lidToPn.get(jid.split('@')[0]) || '';
    return '';
  };

  // Freeze this pass at maxRowid. Messages inserted while the model reasons stay ABOVE the
  // boundary and are picked up next pass rather than being skipped.
  const active = cursorMode === 'rowid'
    ? M.prepare(
      "SELECT chat_jid, MAX(rowid) hi FROM messages " +
      "WHERE (chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid') " +
      'AND rowid > ? AND rowid <= ? GROUP BY chat_jid'
    ).all(sinceRowid, maxRowid)
    : M.prepare(
      "SELECT chat_jid, MAX(timestamp) hi FROM messages " +
      "WHERE (chat_jid LIKE '%@s.whatsapp.net' OR chat_jid LIKE '%@lid') " +
      'AND timestamp > ? AND rowid <= ? GROUP BY chat_jid'
    ).all(sinceTs, maxRowid);

  const phones = new Set();
  const activeCounterparties = new Set();
  for (const a of active) {
    const ph = jidToPhone(a.chat_jid);
    if (!ph) continue;
    if (COUNTERPARTIES[ph]) activeCounterparties.add(ph);
    else phones.add(ph);
  }

  // Registered counterparty GROUPS, queried separately: the scan above deliberately
  // excludes '@g.us' because group traffic is not customer traffic. Only REGISTERED
  // groups are pulled in — never groups at large.
  const activeGroups = new Set();
  const groupJids = Object.keys(COUNTERPARTY_GROUPS);
  if (groupJids.length) {
    const gph = '(' + groupJids.map(() => '?').join(',') + ')';
    const rows = cursorMode === 'rowid'
      ? M.prepare('SELECT chat_jid FROM messages WHERE chat_jid IN ' + gph +
          ' AND rowid > ? AND rowid <= ? GROUP BY chat_jid').all(...groupJids, sinceRowid, maxRowid)
      : M.prepare('SELECT chat_jid FROM messages WHERE chat_jid IN ' + gph +
          ' AND timestamp > ? AND rowid <= ? GROUP BY chat_jid').all(...groupJids, sinceTs, maxRowid);
    for (const g of rows) activeGroups.add(g.chat_jid);
  }

  // Read the store ONCE and group by phone, so the model reconciles against authoritative
  // state rather than re-deriving history from messages alone.
  let storeRows = [];
  try { storeRows = await fetchRows(cfg, 'Records'); }
  catch (e) { console.error('store read failed:', e.message); }
  const rowsByPhone = {};
  for (const r of storeRows) {
    const ph = canon(r.phone);
    if (ph) (rowsByPhone[ph] = rowsByPhone[ph] || []).push(r);
  }

  fs.rmSync(WORKDIR, { recursive: true, force: true });
  fs.mkdirSync(WORKDIR, { recursive: true });

  const manifest = [];
  let maxTs = st.lastTs || sinceTs;

  for (const phone of phones) {
    // Both rails for this phone, so the model sees the FULL history of the relationship
    // even though only the new tail can justify a write.
    const jids = [phone + '@s.whatsapp.net', ...(pnToLids.get(phone) || []).map((l) => l + '@lid')];
    const ph = '(' + jids.map(() => '?').join(',') + ')';
    const msgs = M.prepare(
      'SELECT rowid,id,timestamp,is_from_me,media_type,filename,content FROM messages ' +
      'WHERE chat_jid IN ' + ph + ' AND rowid <= ? ORDER BY timestamp,rowid'
    ).all(...jids, maxRowid);
    if (!msgs.length) continue;

    for (const m of msgs) if (isMessageNew(m, boundary)) maxTs = latestTimestamp(maxTs, m.timestamp);

    const conversation = msgs.map((m) => ({
      id: m.id,
      ts: String(m.timestamp).slice(0, 16),
      from: m.is_from_me ? 'BUSINESS' : 'CUSTOMER',
      // is_new is the EVIDENCE GATE. Validation refuses any cited id that is not is_new,
      // so old context can inform reading but can never justify a write.
      is_new: isMessageNew(m, boundary),
      text: m.content || (m.media_type ? '[' + m.media_type + (m.filename ? ': ' + m.filename : '') + ']' : ''),
    }));
    const existing_rows = (rowsByPhone[phone] || []).map((r) => ({
      record_id: r.record_id, source_date: String(r.source_date).slice(0, 10), doc_type: r.doc_type,
      price: r.price, status: r.status, paid_at: r.paid_at || '', client_name: r.client_name || '',
      language_pair: r.language_pair || '', delivery_time: r.delivery_time || '', summary: r.summary || '',
    }));
    const file = path.join(WORKDIR, 'chat_' + phone + '.json');
    fs.writeFileSync(file, JSON.stringify({ phone, jids, existing_rows, conversation }, null, 1));
    manifest.push({ phone, file, msgs: conversation.length, existing: existing_rows.length });
  }

  // ---- COUNTERPARTY PASS INPUTS -------------------------------------------------
  // CRITICAL STRUCTURAL GUARD (docs/GUARDS.md #11): only HANDOFF_ELIGIBLE records are
  // offered as candidates. We routinely forward a document to a counterparty JUST TO GET
  // A PRICE QUOTE before the customer has committed or paid — that is NOT a handoff.
  // Filtering here, in code, means a quote-check can never be misread as a handoff no
  // matter what the model thinks. Do not move this into the prompt.
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
    const jids = ch.jids
      || [ch.phone + '@s.whatsapp.net', ...(pnToLids.get(ch.phone) || []).map((l) => l + '@lid')];
    const ph = '(' + jids.map(() => '?').join(',') + ')';
    // A handoff thread spans days, so include a context window — not just the new tail.
    const lookback = new Date(Date.now() - cfg.counterpartyLookbackDays * 864e5)
      .toISOString().replace('T', ' ').slice(0, 19);
    // Union the context window with the rowid delta: a RESTORED message can be newly
    // inserted with an OLD send timestamp and would fall outside a pure time window.
    const msgs = cursorMode === 'rowid'
      ? M.prepare(
        'SELECT rowid,id,timestamp,is_from_me,media_type,filename,content FROM messages ' +
        'WHERE chat_jid IN ' + ph + ' AND rowid <= ? AND (timestamp > ? OR rowid > ?) ORDER BY timestamp,rowid'
      ).all(...jids, maxRowid, lookback, sinceRowid)
      : M.prepare(
        'SELECT rowid,id,timestamp,is_from_me,media_type,filename,content FROM messages ' +
        'WHERE chat_jid IN ' + ph + ' AND rowid <= ? AND timestamp > ? ORDER BY timestamp,rowid'
      ).all(...jids, maxRowid, lookback);
    if (!msgs.length) continue;

    for (const m of msgs) if (isMessageNew(m, boundary)) maxTs = latestTimestamp(maxTs, m.timestamp);

    const conversation = msgs.map((m) => ({
      id: m.id,
      ts: String(m.timestamp).slice(0, 16),
      from: m.is_from_me ? 'BUSINESS' : 'COUNTERPARTY',
      is_new: isMessageNew(m, boundary),
      text: m.content || (m.media_type ? '[' + m.media_type + (m.filename ? ': ' + m.filename : '') + ']' : ''),
    }));
    const file = path.join(WORKDIR, 'counterparty_' + ch.name + '.json');
    fs.writeFileSync(file, JSON.stringify({
      counterparty: ch.name, phone: ch.phone, in_flight: inFlight, conversation,
    }, null, 1));
    counterparties.push({ counterparty: ch.name, file, msgs: conversation.length, in_flight: inFlight.length });
  }

  fs.writeFileSync(path.join(WORKDIR, 'manifest.json'), JSON.stringify({
    cursorMode, sinceRowid, sinceTs, maxRowid, maxTs,
    count: manifest.length, chats: manifest, counterparties,
  }, null, 1));

  console.log(
    'tracker-prep:',
    cursorMode === 'rowid' ? 'after rowid ' + sinceRowid : 'since ' + sinceTs,
    '-> rowid ' + maxRowid,
    '| active customer chats:', manifest.length,
    '| active counterparty chats:', counterparties.length
  );
  manifest.forEach((m) => console.log('  ' + m.phone + '  msgs=' + m.msgs + '  existing=' + m.existing));
  counterparties.forEach((v) => console.log('  counterparty:' + v.counterparty + '  msgs=' + v.msgs + '  in_flight=' + v.in_flight));
  if (!manifest.length && !counterparties.length) console.log('  (nothing new — the tick can skip the model entirely)');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
