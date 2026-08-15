// Tiny .env loader (no dotenv dependency) + config defaults.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadDotenv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

export function loadConfig() {
  loadDotenv();
  return {
    sheetUrl: process.env.SHEET_WEBHOOK_URL || '',
    sheetSecret: process.env.SHEET_SECRET || '',
    dbPath: process.env.WHATSAPP_DB_PATH || '',
    bridgeExe: process.env.WHATSAPP_BRIDGE_EXE || '',
    bridgeApi: process.env.WHATSAPP_BRIDGE_API || 'http://127.0.0.1:8080',
    alertNumber: process.env.TRACKER_ALERT_NUMBER || '',
    // Per-chat budget the WATCHER will carry. It must be >= maxNewMsgs, because the watcher
    // aborts rather than truncate new evidence (tracker-prep enforces the relationship).
    maxMsgs: Number(process.env.TRACKER_MAX_MSGS || 250),
    // Budget for NEW messages per chat. Exceeding it LOWERS the ingestion boundary; it never
    // truncates. Context is safe to trim because it can never justify a write.
    maxNewMsgs: Number(process.env.TRACKER_MAX_NEW_MSGS || 150),
    maxContextMsgs: Number(process.env.TRACKER_MAX_CONTEXT_MSGS || 150),
    counterpartyLookbackDays: Number(process.env.TRACKER_COUNTERPARTY_LOOKBACK_DAYS || 5),
    // Restricted READ-ONLY key — reconciliation input only, never writes.
    stripeKey: process.env.STRIPE_KEY || '',
    statePath: path.join(ROOT, 'state.json'),
    root: ROOT,
  };
}
