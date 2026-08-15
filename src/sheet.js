// The durable-store client. Upsert / read / delete / heartbeat over an authenticated POST
// to an Apps Script web app. No service account, no googleapis dependency.
//
// SECURITY INVARIANT: the secret ALWAYS travels in the POST body, NEVER in a URL query
// string. Read paths use POST with {action:'read'} for exactly this reason — a leaked read
// URL must not grant writes, and URLs leak through logs, history, and referrers.
//
// SWAPPING THE STORE: this file is the entire interface. Point these five functions at a
// Postgres/SQLite upsert and nothing upstream changes.

// Thrown when the store fails recoverably (transient HTML error page, 5xx, network) after
// retries, OR returns an explicit error. The caller stops the run gracefully — the cursor
// is not advanced, so the work is simply retried.
export class SheetError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

async function post(cfg, body, label) {
  if (!cfg.sheetUrl) throw new SheetError('SHEET_WEBHOOK_URL is not set (see .env)');
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    let txt;
    try {
      res = await fetch(cfg.sheetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        redirect: 'follow', // Apps Script web apps 302 to a result host
        body: JSON.stringify({ ...body, secret: cfg.sheetSecret }),
        signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
      });
      txt = await res.text();
    } catch (e) {
      lastErr = `network: ${e.message}`;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(txt);
    } catch {
      // An HTML error page instead of JSON is a transient platform-side error. Retryable.
      lastErr = `non-JSON (${res.status}): ${txt.slice(0, 120)}`;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    if (json.ok) return json;
    // An explicit error (e.g. unauthorized) is NOT retryable — retrying just burns time.
    throw new SheetError(`${label} error: ${json.error || 'unknown'}`);
  }
  throw new SheetError(`${label} failed after retries: ${lastErr}`);
}

// Upsert by the tab's key column. `replaceEmpty` opts into blanket authoritative blanking;
// leave it false for normal writes so an empty field never erases a populated cell.
export async function appendRows(rows, cfg, sheetName = 'Records', { replaceEmpty = false } = {}) {
  if (!rows.length) return { appended: 0, updated: 0 };
  return post(cfg, { sheet: sheetName, rows, replaceEmpty }, 'Store write');
}

export async function fetchRows(cfg, sheetName = 'Records') {
  const json = await post(cfg, { action: 'read', sheet: sheetName }, 'Store read');
  return json.rows || [];
}

export async function deleteRows(keys, cfg, sheetName = 'Records') {
  if (!keys.length) return { deleted: 0 };
  return post(cfg, { action: 'delete', sheet: sheetName, keys }, 'Store delete');
}

export async function fetchCapabilities(cfg) {
  return post(cfg, { action: 'capabilities' }, 'Store capability probe');
}

// Best-effort liveness ping. A failed heartbeat must NEVER roll back local work — the
// cloud watchdog treats ABSENCE as the signal, so a dropped beat is self-correcting.
export async function postHeartbeat(cfg, payload) {
  if (!cfg.sheetUrl || !cfg.sheetSecret) return false;
  try {
    const json = await post(cfg, { ...payload, action: 'heartbeat' }, 'Heartbeat');
    return Boolean(json.ok);
  } catch {
    return false;
  }
}
