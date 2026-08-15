'use strict';
// Architectural boundaries that are easy to erode with a "small" edit and expensive to
// discover in production. These assert on SOURCE TEXT deliberately: the point is to fail the
// moment someone adds the forbidden capability, not once it misbehaves at 3am.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('GUARDS #18: the keepalive is TRANSPORT ONLY — no webhook action but heartbeat', () => {
  const src = read('scripts/bridge-keepalive.cjs');
  const actions = [...src.matchAll(/action:\s*'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(actions)], ['heartbeat'],
    'the keepalive has grown into a writer; it now races the extraction lane');
  for (const forbidden of ['tracker-prep', 'tracker-apply', 'invokeProvider', 'appendRows', 'fetchRows']) {
    assert.ok(!src.includes(forbidden), `keepalive must not reference ${forbidden}`);
  }
});

test('GUARDS #13: the transition guard lives at the writer, never in the store API', () => {
  assert.ok(read('scripts/tracker-apply.cjs').includes('reduceObservations'),
    'the writer must derive status through the guarded reducer');
  const store = read('apps-script/Code.gs');
  assert.ok(!store.includes('STATUS_RANK') && !store.includes('canAutomatedTransition'),
    'the store API must stay a dumb upsert — it is also the correction path');
});

test('GUARDS #23: new evidence is never truncated; only context is', () => {
  const watch = read('scripts/tracker-watch.cjs');
  assert.ok(/raw\.context\s*=\s*raw\.context\.slice\(-MAX_MSGS\)/.test(watch),
    'context must be the thing that gets trimmed');
  assert.ok(!/raw\.conversation\s*=\s*raw\.conversation\.slice/.test(watch),
    'v1 truncated a merged timestamp-sorted array, dropping newly ingested old-timestamp messages');
  assert.ok(/new_messages[\s\S]{0,400}refusing to truncate new evidence/.test(watch),
    'an oversized new-message delta must abort, not silently truncate');

  const prep = read('scripts/tracker-prep.cjs');
  assert.ok(prep.includes('new_messages') && prep.includes('context'),
    'prep must emit new evidence and context as separate fields');
  assert.ok(/CHUNKED|chunked/.test(prep),
    'prep must lower the ingestion boundary rather than drop evidence');
});

test('GUARDS #24: authoritative reads fail CLOSED', () => {
  const prep = read('scripts/tracker-prep.cjs');
  assert.ok(/lid map unavailable[\s\S]{0,200}refusing to run/.test(prep),
    'an unreadable lid map must abort — @lid chats would vanish while the cursor advanced');
  assert.ok(/store read failed[\s\S]{0,200}refusing to run/.test(prep),
    'an unreadable store must abort — existing records would look new and be duplicated');
  assert.ok(!prep.includes('proceeding without'), 'prep must not continue past a failed authoritative read');

  const apply = read('scripts/tracker-apply.cjs');
  assert.ok(/could not read current store state[\s\S]{0,200}Refusing to write/.test(apply),
    'the writer must not write blind when current state is unavailable');
  assert.ok(!apply.includes('proceeding without it'),
    'v1 explicitly wrote without the guard when the pre-read failed');
});

test('the run lock lives outside the work directory that prep wipes', () => {
  assert.match(read('scripts/tracker-watch.cjs'), /LOCK = path\.join\(ROOT, '\.tracker-lock'\)/,
    'a lock inside .tracker-work is deleted mid-run by prep, letting two ticks overlap');
});

test('every live SQLite read passes a finite busy timeout', () => {
  for (const file of ['scripts/tracker-prep.cjs', 'scripts/tracker-watch.cjs', 'scripts/bridge-keepalive.cjs']) {
    const src = read(file);
    for (const args of [...src.matchAll(/new DatabaseSync\(([^)]*)\)/g)].map((m) => m[1])) {
      assert.match(args, /readOnly:\s*true/, `${file}: live DB opened writable`);
      assert.match(args, /timeout:\s*\d+/, `${file}: no finite timeout — this hangs on live writes`);
    }
  }
});

test('the env loader is not scoped to a prefix (it once starved the watcher of its config)', () => {
  assert.ok(!/match\(\/\^\\s\*\(TRACKER_/.test(read('scripts/lib/agent-provider.cjs')),
    'a prefix-scoped loader silently drops WHATSAPP_* and SHEET_* keys');
});

test('the store endpoint rejects unknown tabs and never guesses an action', () => {
  const src = read('apps-script/Code.gs');
  assert.ok(src.includes('unknown sheet: '), 'an unknown tab must be rejected, not defaulted');
  assert.ok(src.includes('unknown or missing action: '), 'a missing action must not fall through to a write');
  assert.ok(src.includes('missing the required key: '), 'automated writes must carry the stable key');
});

test('prompts referenced by the watcher exist, are non-empty, and forbid emitting a status', () => {
  const customer = read(path.join('prompts', 'customer-rules.txt'));
  assert.ok(customer.trim().length > 0);
  assert.ok(/never output a "status" field/i.test(customer),
    'the prompt must state the observation boundary the validator enforces');
  assert.ok(read(path.join('prompts', 'counterparty-rules.txt')).trim().length > 0);
});
