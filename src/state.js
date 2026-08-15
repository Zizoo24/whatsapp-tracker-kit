// Auxiliary watermark store for the OPTIONAL payment lane.
//
// NOTE: this is NOT the message cursor. The message cursor lives in tracker-state.json and
// is owned exclusively by scripts/lib/message-cursor.cjs. Keeping them separate means a
// payment-lane failure can never corrupt message ingestion, and vice versa.
import fs from 'node:fs';

const EMPTY = { paymentsTs: 0 };

export function loadState(statePath) {
  if (!fs.existsSync(statePath)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch {
    return { ...EMPTY };
  }
}

export function saveState(statePath, state) {
  const out = {};
  for (const k of Object.keys(EMPTY)) out[k] = state[k] ?? EMPTY[k];
  fs.writeFileSync(statePath, JSON.stringify(out, null, 2));
}
