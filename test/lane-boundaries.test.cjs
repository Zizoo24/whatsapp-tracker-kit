'use strict';
// Architectural boundaries that are easy to erode with a "small" edit and expensive to
// discover in production. These assert on SOURCE TEXT on purpose: the point is to fail
// the moment someone adds the forbidden capability, not once it misbehaves at 3am.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('GUARDS #18: the keepalive is TRANSPORT ONLY — it may name no webhook action but heartbeat', () => {
  const src = read('scripts/bridge-keepalive.cjs');
  const actions = [...src.matchAll(/action:\s*'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(actions)], ['heartbeat'],
    'the keepalive has grown into a writer; it now races the extraction lane');
  for (const forbidden of ['tracker-prep', 'tracker-apply', 'invokeProvider', 'appendRows', 'fetchRows']) {
    assert.ok(!src.includes(forbidden),
      `keepalive must not reference ${forbidden} — transport and semantics are separate lanes`);
  }
});

test('GUARDS #13: the monotonic guard lives at the writer, never in the store API', () => {
  assert.ok(read('scripts/tracker-apply.cjs').includes('STATUS_RANK'),
    'the writer must enforce the monotonic guard');
  assert.ok(!read('apps-script/Code.gs').includes('STATUS_RANK'),
    'the store API must stay a dumb upsert — it is also the correction path');
});

test('the run lock lives outside the work directory that prep wipes', () => {
  const watch = read('scripts/tracker-watch.cjs');
  assert.match(watch, /LOCK = path\.join\(ROOT, '\.tracker-lock'\)/,
    'a lock inside .tracker-work is deleted mid-run by prep, letting two ticks overlap');
});

test('every live SQLite read passes a finite busy timeout', () => {
  for (const file of ['scripts/tracker-prep.cjs', 'scripts/tracker-watch.cjs', 'scripts/bridge-keepalive.cjs']) {
    const src = read(file);
    const opens = [...src.matchAll(/new DatabaseSync\(([^)]*)\)/g)].map((m) => m[1]);
    for (const args of opens) {
      assert.match(args, /readOnly:\s*true/, `${file}: live DB opened writable`);
      assert.match(args, /timeout:\s*\d+/, `${file}: no finite timeout — this hangs on live writes`);
    }
  }
});

test('the env loader is not scoped to a prefix (it once starved the watcher of its config)', () => {
  const src = read('scripts/lib/agent-provider.cjs');
  assert.ok(!/match\(\/\^\\s\*\(TRACKER_/.test(src),
    'a prefix-scoped loader silently drops WHATSAPP_* and SHEET_* keys');
});

test('prompts referenced by the watcher exist and are non-empty', () => {
  for (const name of ['customer-rules.txt', 'counterparty-rules.txt']) {
    assert.ok(read(path.join('prompts', name)).trim().length > 0, `${name} is empty — the lane fails closed`);
  }
});
