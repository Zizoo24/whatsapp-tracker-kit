#!/usr/bin/env node
'use strict';
// bridge-keepalive.cjs — TRANSPORT KEEPALIVE. Nothing else. Ever.
//
// WHY THIS IS A SEPARATE LANE (a 66-hour outage):
// In the source system the bridge self-heal lived INSIDE the extraction watcher. When the
// watcher was retired, that silently removed the only thing keeping the WhatsApp socket
// open. The bridge died, the laptop rebooted, and nothing brought it back — 66.5 hours
// with ZERO message ingestion. The messages were not merely unprocessed; they never
// reached the machine at all. Recovery only worked because WhatsApp's offline queue
// happened to still hold them, which is finite and undocumented.
//
// The lesson generalises: WHO INTERPRETS conversations and WHO KEEPS THE SOCKET OPEN are
// different responsibilities with different lifecycles. Retiring one must never disable
// the other. So transport lives here, on its own schedule (~5 min + at logon).
//
// HARD BOUNDARY — this script must never grow:
//   no prep, no model call of any kind, no store row read or write, no cursor.
// The only webhook POST below is action:'heartbeat' — a liveness ping, not a row write.
// If it ever needs one of those it has become a writer and belongs in the agent lane.
// Keep a test that pins this file to naming no other webhook action.

const fs = require('node:fs');
const path = require('node:path');
const { superviseBridgeProcess } = require('./lib/bridge-supervisor.cjs');
const { loadEnv } = require('./lib/agent-provider.cjs');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'bridge-keepalive.log');

function log(line) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(LOG, `${ts} ${line}\n`);
}

// Deliberately re-reads only the keys it needs rather than importing the ESM config
// loader: this file must stay a tiny CJS leaf with no path into the extraction stack.
function readEnv(root = ROOT) {
  const out = { url: '', secret: '', dbPath: '' };
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(SHEET_WEBHOOK_URL|SHEET_SECRET|WHATSAPP_DB_PATH|WHATSAPP_BRIDGE_EXE|WHATSAPP_BRIDGE_API)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const v = m[2].replace(/^["']|["']$/g, '');
      if (m[1] === 'SHEET_WEBHOOK_URL') out.url = v;
      else if (m[1] === 'SHEET_SECRET') out.secret = v;
      else if (m[1] === 'WHATSAPP_DB_PATH') out.dbPath = v;
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch { /* missing .env -> heartbeat disabled, supervision still runs */ }
  return out;
}

// Message-store freshness — ALERT-ONLY, never a restart trigger. Opened readOnly with a
// finite busy timeout; without one, node:sqlite hangs on the bridge's live writes.
function msgdbAgeMin(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    const row = db.prepare('SELECT MAX(timestamp) ts FROM messages').get();
    db.close();
    const ms = Date.parse(String(row.ts || '').replace(' ', 'T'));
    return Number.isNaN(ms) ? null : Math.round((Date.now() - ms) / 60000);
  } catch { return null; }
}

// The heartbeat carries INGESTION health, not just "this process ran": a healthy poster
// must never vouch for a dead bridge.
async function postHeartbeat({ env, bridgeHealthy, ageMin, lastError, fetchImpl = fetch }) {
  if (!env.url || !env.secret) return 'no_webhook_config';
  try {
    const res = await fetchImpl(env.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.secret,
        action: 'heartbeat',
        poster: 'keepalive',
        ranAt: new Date().toISOString(),
        bridgeAgeMin: ageMin === null ? '' : ageMin,
        lastError: lastError || (bridgeHealthy ? '' : 'bridge_unhealthy'),
      }),
      signal: AbortSignal.timeout(15000),
    });
    return res.ok ? 'ok' : `http_${res.status}`;
  } catch (err) {
    return `post_failed:${err.name || 'Error'}`;
  }
}

async function main({
  supervise = superviseBridgeProcess,
  emit = log,
  env = null,
  fetchImpl = fetch,
} = {}) {
  loadEnv(path.join(ROOT, '.env'));
  const resolved = env || readEnv();
  let result = null;
  let lastError = '';

  try {
    result = supervise();
  } catch (err) {
    emit(`ERROR supervise failed: ${err.message}`);
    lastError = 'bridge_supervise_error';
    process.exitCode = 1;
  }

  // Healthy ticks stay SILENT. At 12 ticks an hour, per-tick "still fine" lines would
  // bury the handful that matter. Only state CHANGES get a log line.
  if (result) {
    if (result.kind === 'dead_relaunch' || result.kind === 'stale_relaunch') {
      const reason = result.kind === 'dead_relaunch'
        ? 'was DEAD'
        : (result.health && result.health.reachable ? 'unhealthy' : 'health probe unreachable');
      emit(`bridge ${reason} — relaunched (pid ${result.bridgePid})`);
    } else if (result.kind === 'escalated') {
      lastError = 'bridge_crash_loop';
      // Only the FIRST tick of an escalation logs; the 60-min observe window would
      // otherwise write a dozen identical lines.
      if (result.fresh) emit('RESTART BUDGET EXHAUSTED — restarts paused, escalated via the email watchdog');
    } else if (result.recovered) {
      emit('bridge recovered on its own — escalation cleared');
    } else if (result.cooldown) {
      emit('bridge unhealthy but within restart cooldown — left alone');
    }
  }

  const bridgeHealthy = Boolean(result && result.kind === 'observed_running'
    && result.health && result.health.healthy);
  const ageMin = resolved.dbPath ? msgdbAgeMin(resolved.dbPath) : null;
  const hb = await postHeartbeat({ env: resolved, bridgeHealthy, ageMin, lastError, fetchImpl });
  if (hb !== 'ok' && hb !== 'no_webhook_config') emit(`heartbeat post failed: ${hb}`);

  return { lastError, bridgeHealthy, ageMin, heartbeat: hb };
}

if (require.main === module) {
  main().catch((err) => {
    log(`ERROR keepalive tick failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, readEnv, postHeartbeat };
