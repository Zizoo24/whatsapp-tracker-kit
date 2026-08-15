#!/usr/bin/env node
'use strict';
// tracker-watch.cjs — THE TICK. Runs from the OS scheduler every ~3 minutes, 24/7,
// independent of any open editor or desktop app.
//
//   supervise bridge -> prep (deterministic) -> ONE model call per chat -> apply (deterministic)
//
// ZERO COST WHEN IDLE: if no chat has newly ingested rowids, it exits without invoking a
// model at all.
//
// FAILURE MODEL: if any chat fails extraction (after a retry per provider), the run
// applies its SUCCESSFUL chats but KEEPS the cursor, so the failed messages stay queued
// and the next tick retries them. Upsert by record_id is idempotent, so re-extraction just
// updates rows. Nothing is ever silently skipped.
//
// Usage: node scripts/tracker-watch.cjs

const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { mergeCounterpartyUpdate } = require('./lib/result-merge.cjs');
const { superviseBridgeProcess } = require('./lib/bridge-supervisor.cjs');
const { inferUniqueHandoffs } = require('./lib/counterparty-heuristic.cjs');
const { validateAndNormalizeClientResult } = require('./lib/client-result.cjs');
const { invokeProvider, loadEnv, resolveProviderChain } = require('./lib/agent-provider.cjs');
const { advanceCursorState, readCursorState } = require('./lib/message-cursor.cjs');
const { acquireRunLock, releaseRunLock } = require('./lib/run-lock.cjs');
const { deliverSelfAlert } = require('./lib/alert.cjs');

const ROOT = path.join(__dirname, '..');
const WORKDIR = path.join(ROOT, '.tracker-work');
// THE LOCK MUST LIVE OUTSIDE .tracker-work: prep wipes that directory at the start of
// every run, which would delete the lock MID-RUN and let a second tick overlap the first.
const LOCK = path.join(ROOT, '.tracker-lock');
const STATE = path.join(ROOT, 'tracker-state.json');
const NODE = process.execPath;

// MUST run before the constants below — they read process.env at module scope, and the
// child processes (prep/apply) inherit it too.
loadEnv(path.join(ROOT, '.env'));
const AGENT_CHAIN = resolveProviderChain();
const MAX_MSGS = Number(process.env.TRACKER_MAX_MSGS || 250);
const MSG_DB = process.env.WHATSAPP_DB_PATH || '';
const ALERT_NUMBER = process.env.TRACKER_ALERT_NUMBER || '';
const BRIDGE_API = process.env.WHATSAPP_BRIDGE_API || 'http://127.0.0.1:8080';
const SHEET_URL = process.env.SHEET_WEBHOOK_URL || '';
const SHEET_SECRET = process.env.SHEET_SECRET || '';

const log = (m) => console.log(new Date().toISOString().slice(0, 19) + ' ' + m);

// Fail LOUDLY and immediately on missing required config, rather than letting the bridge
// supervisor throw mid-tick where the error reads as a runtime fault. A misconfigured
// install must be obviously misconfigured, not subtly broken.
const MISSING = ['WHATSAPP_DB_PATH', 'WHATSAPP_BRIDGE_EXE', 'SHEET_WEBHOOK_URL', 'SHEET_SECRET']
  .filter((key) => !process.env[key]);
if (MISSING.length) {
  log('CONFIG ERROR: missing required .env key(s): ' + MISSING.join(', ')
    + ' — see .env.example. Refusing to run.');
  process.exit(2);
}

let agentAuthFailed = false;
let lastRunError = '';
let lastAgentProvider = '';

function alert(key, msg) {
  const r = deliverSelfAlert({ root: ROOT, key, msg, recipient: ALERT_NUMBER, apiBase: BRIDGE_API });
  if (r.delivered && !r.suppressed) log('  ALERT sent: ' + key);
}

// The heartbeat is what lets a CLOUD watchdog distinguish "the tick ran and failed" from
// "the host is asleep and nothing ran at all" — the failure mode the local alert channel
// cannot self-report, because that channel needs the local bridge. Posted every tick:
// idle, success, or abort.
function heartbeat(obj) {
  try {
    if (!SHEET_URL || !SHEET_SECRET) return;
    const body = JSON.stringify(Object.assign(
      { secret: SHEET_SECRET, action: 'heartbeat', poster: 'watcher' }, obj
    ));
    spawnSync('curl', ['-s', '-L', '--max-time', '20', '-X', 'POST', SHEET_URL,
      '-H', 'Content-Type: application/json', '-d', body], { encoding: 'utf8', windowsHide: true });
  } catch { /* best-effort */ }
}

// PROMPTS ARE DATA, NOT CODE. They used to live in JS template literals, and a live edit
// containing a backtick SyntaxError'd the entire watcher for three silent ticks. In .txt
// files, an editing mistake can garble a prompt (bad extractions, caught by fail-closed
// validation) but can never crash the lane.
//
// FAIL-CLOSED + SELF-ALERTING: a missing or empty prompt halts the tick BEFORE any state
// is touched. It uses its own curl rather than alert() because a garbled prompt must be
// reported even if module init is incomplete.
function loadPrompt(name) {
  const p = path.join(ROOT, 'prompts', name);
  let s = '';
  try { s = fs.readFileSync(p, 'utf8'); } catch {}
  if (!s.trim()) {
    const marker = path.join(ROOT, '.alert-prompt-load');
    let recent = false;
    try { recent = Date.now() - fs.statSync(marker).mtimeMs < 2 * 60 * 60 * 1000; } catch {}
    if (!recent && ALERT_NUMBER) {
      try {
        spawnSync('curl', ['-s', '--max-time', '15', '-X', 'POST', `${BRIDGE_API}/api/send`,
          '-H', 'Content-Type: application/json',
          '-d', JSON.stringify({
            Recipient: ALERT_NUMBER,
            Message: 'Tracker alert: prompt file missing/empty (' + name + ') — watcher HALTED until fixed.',
          })], { encoding: 'utf8', timeout: 20000, windowsHide: true });
        fs.writeFileSync(marker, name);
      } catch {}
    }
    throw new Error('prompt file missing or empty: ' + p);
  }
  return s;
}

const CUSTOMER_RULES = loadPrompt('customer-rules.txt');
const COUNTERPARTY_RULES = loadPrompt('counterparty-rules.txt');

function extractJson(text, validate, input) {
  const cleaned = String(text).replace(/```(?:json)?/g, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('no JSON object in output');
  const obj = JSON.parse(cleaned.slice(a, b + 1));
  const validated = validate(obj, input);
  if (!validated) throw new Error('bad shape');
  return validated === true ? obj : validated;
}

// Try each provider in the chain, twice each. A rejected result is fed BACK to the model
// as explicit validation feedback, which converts most malformed outputs into a correct
// retry instead of a deferral.
//
// TRUNCATION RULE (docs/GUARDS.md #23): `new_messages` is NEVER truncated here. Prep already
// guaranteed the delta fits the budget by lowering the ingestion boundary instead of
// dropping evidence. Only `context` — which can never justify a write — may be trimmed.
// v1 truncated a single merged, timestamp-sorted array, so a newly ingested message with an
// old timestamp could be cut while the cursor still advanced past its rowid.
function extractFile(file, rules, validate) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw.context) && raw.context.length > MAX_MSGS) {
    raw.context = raw.context.slice(-MAX_MSGS);
    raw.context_truncated = true;
  }
  if (Array.isArray(raw.new_messages) && raw.new_messages.length > MAX_MSGS) {
    // Prep should have chunked the boundary; reaching here means the two budgets disagree.
    // Refuse rather than silently drop evidence.
    log('  ABORT ' + path.basename(file) + ': ' + raw.new_messages.length
      + ' new messages exceeds TRACKER_MAX_MSGS=' + MAX_MSGS
      + ' — raise it or lower TRACKER_MAX_NEW_MSGS; refusing to truncate new evidence');
    return null;
  }
  let validationFeedback = '';
  for (const provider of AGENT_CHAIN) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = rules
        + (validationFeedback
          ? `\n\nYOUR PREVIOUS OUTPUT WAS REJECTED: ${validationFeedback}\nReturn a corrected result.\n\n`
          : '\n\n')
        + 'INPUT JSON:\n' + JSON.stringify(raw);
      const r = invokeProvider(provider, prompt);
      if ((r.ok || r.timedOut) && r.stdout) {
        try {
          const parsed = extractJson(r.stdout, validate, raw);
          lastAgentProvider = provider;
          return parsed;
        } catch (e) {
          validationFeedback = String((e && e.message) || e).slice(0, 300);
          log('  parse fail (' + provider + ':' + path.basename(file) + ' attempt ' + attempt + '): ' + validationFeedback);
          continue;
        }
      }
      if (r.authFailed) agentAuthFailed = true;
      const err = String(r.stderr || r.error || r.stdout || validationFeedback || '');
      log('  agent fail (' + provider + ':' + path.basename(file) + ' attempt ' + attempt + '): status='
        + r.status + (r.timedOut ? ' timeout' : '') + ' ' + err.slice(0, 200));
    }
  }
  if (!AGENT_CHAIN.length) log('  agent fail: TRACKER_AGENT_PROVIDERS resolved to an empty chain');
  return null;
}

const extractCustomer = (file) => extractFile(file, CUSTOMER_RULES, validateAndNormalizeClientResult);
const extractCounterparty = (file) => extractFile(file, COUNTERPARTY_RULES,
  (o) => Array.isArray(o.updates) && Array.isArray(o.reviews));

(function main() {
  // Several scheduler and recovery signals can arrive together after a wake. Atomic
  // creation plus owner-checked release prevents overlapping writers.
  const runLock = acquireRunLock(LOCK);
  if (!runLock.acquired) { log('locked (run in progress) - skip'); return; }
  fs.mkdirSync(WORKDIR, { recursive: true });

  try {
    const t0 = Date.now();

    // A QUIET CHAT IS HEALTHY. Supervise via the explicit connection endpoint; message
    // age is only ever a heartbeat metric, never a restart trigger.
    const bridge = superviseBridgeProcess();
    if (bridge.kind === 'dead_relaunch') {
      log('bridge: DEAD (process gone) — relaunched from cached session');
    } else if (bridge.kind === 'stale_relaunch') {
      log('bridge: ' + (bridge.health?.reachable ? 'UNHEALTHY' : 'HEALTH-ENDPOINT-UNREACHABLE')
        + ' — relaunched from cached session');
    } else if (bridge.kind === 'escalated') {
      lastRunError = 'bridge_crash_loop';
      if (bridge.fresh) log('bridge: RESTART BUDGET EXHAUSTED — restarts paused, escalated via heartbeat');
    } else if (bridge.cooldown) {
      log('bridge: unhealthy but within restart cooldown — waiting');
    }

    const prep = spawnSync(NODE, [path.join(ROOT, 'scripts', 'tracker-prep.cjs')],
      { encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: ROOT });
    if (prep.status !== 0) {
      log('prep FAILED: ' + (prep.error?.code === 'ETIMEDOUT'
        ? 'timed out after 120000ms'
        : String(prep.stderr || prep.stdout).slice(0, 300)));
      lastRunError = 'prep_failed';
      process.exitCode = 1;
      return;
    }

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(WORKDIR, 'manifest.json'), 'utf8')); }
    catch {
      log('no manifest - prep produced nothing');
      lastRunError = 'manifest_missing';
      process.exitCode = 1;
      return;
    }

    const counterpartyFiles = manifest.counterparties || [];
    if (!manifest.count && !counterpartyFiles.length) {
      // An idle pass still consumed the frozen rowid boundary. Persist it so liveness is
      // visible and irrelevant chats never hold the cursor behind.
      advanceCursorState(STATE, manifest);
      return;
    }

    log('activity: ' + manifest.count + ' customer chat(s), ' + counterpartyFiles.length
      + ' counterparty chat(s) ' + (manifest.cursorMode === 'rowid'
        ? 'after rowid ' + manifest.sinceRowid + ' through ' + manifest.maxRowid
        : 'since ' + manifest.sinceTs));

    const results = [];
    let extractionFailures = 0;

    for (const c of manifest.chats) {
      const res = extractCustomer(c.file);
      if (!res) {
        extractionFailures++;
        log('DEFER (cursor will be kept) - chat ' + c.phone + ' failed every provider');
        continue;
      }
      if (res.records.length) results.push(res);
      log('  ' + c.phone + ': ' + res.records.length + ' committed record(s)');
    }

    // ---- COUNTERPARTY PASS -----------------------------------------------------------
    // Records WHO is doing the work (the `counterparty` column) and moves the record to
    // an in-progress stage. Counterparty is NOT a status. Only status + counterparty are
    // merged, so customer-pass fields are never clobbered. prep already restricted the
    // candidates to eligible records, so a quote-check cannot look like a handoff.
    for (const v of counterpartyFiles) {
      const input = JSON.parse(fs.readFileSync(v.file, 'utf8'));
      if (!Array.isArray(input.in_flight) || input.in_flight.length === 0) {
        log('  counterparty:' + v.counterparty + ': skipped (no eligible records)');
        continue;
      }
      const res = extractCounterparty(v.file);
      if (!res) {
        extractionFailures++;
        log('DEFER (cursor will be kept) - counterparty ' + v.counterparty + ' failed every provider');
        continue;
      }

      const eligible = {};
      for (const o of input.in_flight) eligible[o.record_id] = String(o.status || '').trim();
      // Resolve cited ids against the messages prep marked new. The model supplies ids ONLY;
      // deterministic code supplies the timestamp and ingestion seq, so a hallucinated time
      // can never enter the durable record.
      const newById = new Map((input.new_messages || []).map((m) => [String(m.id), m]));

      // Union the model's updates with the deterministic heuristic (disabled by default),
      // then filter BOTH against the eligible set — a hallucinated id cannot survive this.
      const byRecord = new Map((res.updates || []).map((u) => [u && u.record_id, u]));
      for (const u of inferUniqueHandoffs(input)) if (!byRecord.has(u.record_id)) byRecord.set(u.record_id, u);
      const updates = [...byRecord.values()]
        .filter((u) => u && typeof u.record_id === 'string' && eligible[u.record_id]);

      for (const u of updates) {
        // Handing an eligible record to a counterparty means WORK HAS STARTED. Emitting that
        // as a milestone observation — rather than a status — keeps every lane going through
        // the same projection, so a handoff can never overwrite a further stage.
        const citedIds = Array.isArray(u.evidence_msg_ids) ? u.evidence_msg_ids.map(String)
          : (u.evidence_msg_id ? [String(u.evidence_msg_id)] : []);
        const cited = citedIds.map((id) => newById.get(id)).filter(Boolean);
        if (!cited.length) {
          // Without resolvable evidence the milestone cannot be ordered against anything, so
          // the handoff would be silently dropped downstream. Say so here instead.
          log('  counterparty:' + v.counterparty + ' skipped ' + u.record_id
            + ' (no resolvable evidence_msg_ids)');
          continue;
        }
        const latest = cited.reduce((a, b) => (Number(b.seq) > Number(a.seq) ? b : a));
        const merged = mergeCounterpartyUpdate(results, u.record_id, v.counterparty, {
          type: 'work_started',
          at: String(latest.ts || ''),
          seq: Number.isFinite(Number(latest.seq)) ? Number(latest.seq) : null,
          message_id: String(latest.id),
          evidence_msg_ids: citedIds,
        });
        if (merged.added) {
          log('  counterparty:' + v.counterparty + ' -> ' + u.record_id + ' [work_started] ('
            + String(u.evidence || '').slice(0, 70) + ')');
        } else if (merged.reason === 'customer_pass_terminal') {
          log('  counterparty:' + v.counterparty + ' skipped ' + u.record_id + ' (customer pass already terminal)');
        }
      }
      if (!updates.length) log('  counterparty:' + v.counterparty + ': no handoffs evident');

      // A reported cancellation is a REVIEW, never an automatic write. Deleting or voiding
      // a record on second-hand evidence is exactly the kind of irreversible action an
      // automated lane must not take. The reason is pinned to the exact string the prompt
      // mandates, so a model-invented reason cannot reach an operator alert.
      //
      // GUARDS #37: reviews carry the SAME evidence burden as updates. The prompt requires
      // evidence_msg_ids for both, but only updates were checked — so a review citing an old
      // or hallucinated id could raise a false cancellation alarm about a live order.
      const reviews = (res.reviews || []).filter((u) => {
        if (!u || !eligible[u.record_id]) return false;
        if (u.reason !== 'counterparty_reports_customer_cancelled') return false;
        const ids = Array.isArray(u.evidence_msg_ids) ? u.evidence_msg_ids.map(String) : [];
        const resolved = ids.filter((id) => newById.has(id));
        if (!resolved.length) {
          log('  counterparty:' + v.counterparty + ' ignored cancellation review for '
            + u.record_id + ' (no resolvable evidence_msg_ids)');
          return false;
        }
        return true;
      });
      if (reviews.length) {
        log('  counterparty:' + v.counterparty + ': ' + reviews.length + ' cancellation review(s); no automatic void');
        alert('counterparty-cancellation-' + v.counterparty,
          'A counterparty chat reports a customer cancellation for ' + reviews.length
          + ' in-flight record(s). Review before voiding; nothing was deleted automatically.');
      }
    }

    fs.writeFileSync(path.join(WORKDIR, 'results.json'), JSON.stringify(results, null, 1));
    const applyArgs = [path.join(ROOT, 'scripts', 'tracker-apply.cjs')];
    if (extractionFailures) applyArgs.push('--keep-cursor');
    const apply = spawnSync(NODE, applyArgs, { encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: ROOT });
    if (apply.status !== 0) {
      lastRunError = 'store_apply_failed';
      log('apply FAILED (cursor kept): ' + String(apply.stderr || apply.stdout).slice(0, 300));
      alert('apply-fail', 'Store WRITE is failing — records are not saving. Check watch.log and the store backend.');
      process.exitCode = 1;
      return;
    }
    log(String(apply.stdout).trim().split('\n').join(' | ') + ' | ' + (Date.now() - t0) + 'ms');

    if (extractionFailures) {
      lastRunError = agentAuthFailed ? 'agent_auth_failed' : 'agent_extraction_failed';
      log('PARTIAL: applied successful chats; kept cursor for ' + extractionFailures + ' deferred extraction(s)');
      if (agentAuthFailed) {
        alert('agent-auth', 'Every configured extraction provider failed and at least one reported an '
          + 'authentication error. Check TRACKER_AGENT_PROVIDERS and the local CLI logins.');
      } else {
        alert('extract-fail', 'Extraction deferred ' + extractionFailures + ' chat(s); successful chats '
          + 'were still applied and the failed messages remain queued.');
      }
      process.exitCode = 1;
    }
  } catch (error) {
    lastRunError = lastRunError || 'watcher_unhandled_error';
    log('watcher FAILED: ' + String(error?.stack || error).slice(0, 500));
    process.exitCode = 1;
  } finally {
    releaseRunLock(runLock);
    try {
      let bridgeAgeMin = -1;
      let cursorRowid = 0;
      let watermark = '';
      try {
        const db = new DatabaseSync(MSG_DB, { readOnly: true, timeout: 5000 });
        const r = db.prepare('SELECT MAX(timestamp) ts FROM messages').get();
        if (typeof db.close === 'function') db.close();
        const ms = Date.parse(String(r && r.ts).replace(' ', 'T'));
        if (!Number.isNaN(ms)) bridgeAgeMin = Math.round((Date.now() - ms) / 60000);
      } catch {}
      try {
        const state = readCursorState(STATE);
        watermark = state.lastTs || '';
        cursorRowid = Number(state.lastRowid || 0);
      } catch {}
      heartbeat({
        ranAt: new Date().toISOString(),
        bridgeAgeMin, watermark, cursorRowid,
        provider: lastAgentProvider,
        lastError: lastRunError,
      });
    } catch {}
  }
})();
