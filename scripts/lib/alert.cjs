'use strict';
// alert.cjs — debounced self-alert over the message channel itself.
//
// Covers the "host is UP but the pipeline is BROKEN" outage shape, which is the common
// one. It is deliberately NOT the only channel: it posts THROUGH the bridge, so it cannot
// report a dead bridge. That case belongs to the cloud watchdog in apps-script/Code.gs,
// which alerts on the ABSENCE of a heartbeat.
//
// DEBOUNCE PLACEMENT MATTERS: the marker files live in the repo ROOT, never inside the
// work directory — prep wipes that directory every run, which would defeat the debounce
// and let a broken pipeline send an alert every single tick.
//
// Alerts are best-effort by construction: a failing alert must never break the pipeline.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ALERT_COOLDOWN_MIN = 120;

function alertMarkerPath(root, key) {
  if (!String(key || '').trim()) throw new Error('alert key is required');
  return path.join(root, `.alert-${key}`);
}

// Never let a customer identifier ride out in an alert. Alerts are operational signals,
// not data exports, and they can land in logs and mail spools.
function redactPhoneLikeValues(message) {
  return String(message || '').replace(/\b\d{8,}\b/g, '[redacted]');
}

function postAlert(apiBase, body, { spawn = spawnSync } = {}) {
  const sent = spawn('curl', [
    '-s', '--fail-with-body', '--max-time', '15',
    '-X', 'POST', `${apiBase}/api/send`,
    '-H', 'Content-Type: application/json', '-d', body,
  ], { encoding: 'utf8', windowsHide: true });
  return sent.status === 0;
}

function deliverSelfAlert({
  root,
  key,
  msg,
  recipient,
  apiBase = 'http://127.0.0.1:8080',
  nowMs = Date.now(),
  cooldownMin = ALERT_COOLDOWN_MIN,
  post = postAlert,
} = {}) {
  try {
    if (!recipient) return { delivered: false, suppressed: false, reason: 'no_recipient' };
    const marker = alertMarkerPath(root, key);
    let last = 0;
    let hasMarker = false;
    try {
      last = Number(fs.readFileSync(marker, 'utf8')) || 0;
      hasMarker = true;
    } catch {}
    if (hasMarker && nowMs - last < cooldownMin * 60000) return { delivered: true, suppressed: true };

    const body = JSON.stringify({
      Recipient: recipient,
      Message: 'Tracker alert: ' + redactPhoneLikeValues(msg),
    });
    if (!post(apiBase, body)) return { delivered: false, suppressed: false };
    fs.writeFileSync(marker, String(nowMs));
    return { delivered: true, suppressed: false };
  } catch {
    return { delivered: false, suppressed: false };
  }
}

module.exports = {
  ALERT_COOLDOWN_MIN,
  alertMarkerPath,
  deliverSelfAlert,
  postAlert,
  redactPhoneLikeValues,
};
