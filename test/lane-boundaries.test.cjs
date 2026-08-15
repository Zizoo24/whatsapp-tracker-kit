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

test('GUARDS #13: status is derived at the writer, never in the store API', () => {
  const apply = read('scripts/tracker-apply.cjs');
  assert.ok(apply.includes('mergeMilestones') && apply.includes('projectStatus'),
    'the writer must derive status by merging milestones and projecting');
  const store = read('apps-script/Code.gs');
  assert.ok(!store.includes('STATUS_RANK') && !store.includes('projectStatus'),
    'the store API must stay a dumb upsert — it is also the correction path');
});

test('GUARDS #25: status is projected from durable milestones, in exactly one place', () => {
  const model = read('scripts/lib/status-model.cjs');
  assert.ok(model.includes('function projectStatus'), 'the projection must be a named pure function');
  // The unpaid rule is the clause the memoryless reducer lost. Pin it.
  assert.ok(/if \(!m\.paid\) return 'confirmed_unpaid'/.test(model),
    'delivery must never complete an unpaid record');
  // Deriving status anywhere else is how two normalizers drift apart (GUARDS #21).
  assert.ok(!/records\.push\([\s\S]{0,300}status:\s*derived/.test(read('scripts/lib/client-result.cjs')),
    'validation must not compute an authoritative status; the writer owns it');
});

test('GUARDS #29: unreadable authoritative state fails closed everywhere it is read', () => {
  const model = read('scripts/lib/status-model.cjs');
  assert.ok(model.includes('class MilestoneStateError'), 'malformed truth needs its own error type');
  assert.ok(!/catch\s*{\s*return \{\};/.test(model),
    'parsing must not degrade malformed non-blank state to "no history"');
  assert.ok(read('scripts/tracker-apply.cjs').includes('MilestoneStateError'),
    'the writer must abort rather than write over unreadable state');
});

test('GUARDS #30: the writer emits exactly one row per record_id per tick', () => {
  const apply = read('scripts/tracker-apply.cjs');
  assert.ok(/byRecord\s*=\s*new Map\(\)/.test(apply), 'updates must be aggregated by record_id');
  assert.ok(/agg\.observations\.push\(\.\.\.d\.observations\)/.test(apply),
    'every lane\'s observations must be unioned, not written as separate rows');
});

test('GUARDS #31: a pre-milestone row blocks the automated lane instead of being rewritten', () => {
  assert.ok(/predates the milestone model/.test(read('scripts/tracker-apply.cjs')),
    'blank milestones beside a real status must not be read as "no history"');
});

test('GUARDS #32/#40: operators correct facts, and every derived view is covered', () => {
  const admin = read('scripts/tracker-admin.cjs');
  assert.ok(/status is a projection of milestones and cannot be set directly/.test(admin),
    'a status-only correction vanishes on the next observation');
  assert.ok(admin.includes('milestone_ops'), 'the tool must expose the real correction target');

  // The authoritative state AND both views derived from it must be covered by the snapshot,
  // concurrency check, backup and readback — a field absent from ROW_FIELDS is invisible to
  // all four, which is how paid_at silently drifted.
  const { ROW_FIELDS } = require('../scripts/tracker-admin.cjs');
  for (const f of ['milestones', 'status', 'paid_at']) {
    assert.ok(ROW_FIELDS.includes(f), `${f} must be covered by the safety machinery`);
  }

  // Derived views must never be directly correctable — that is the projection trap again.
  const { CORRECTABLE } = require('../scripts/tracker-admin.cjs');
  for (const f of ['status', 'paid_at']) {
    assert.ok(!CORRECTABLE.has(f), `${f} is derived; it must not be hand-settable`);
  }
});

test('GUARDS #41: every milestone write path goes through the evidence resolver', () => {
  const admin = read('scripts/tracker-admin.cjs');
  // `replace` used to hand its occurrences straight to parseMilestones, which validates
  // shape but verifies nothing — the one path that skipped provenance.
  assert.ok(!/ops\.replace\)\s*milestones = parseMilestones\(ops\.replace\)/.test(admin),
    'replace must not bypass resolveOccurrence');
  const replaceBlock = admin.slice(admin.indexOf('if (ops.replace)'), admin.indexOf('for (const name of'));
  assert.ok(replaceBlock.includes('resolveOccurrence'), 'replace must resolve each occurrence');
});

test('the admin tool takes the SAME writer lock, rather than only advising it', () => {
  const admin = read('scripts/tracker-admin.cjs');
  assert.ok(admin.includes('acquireRunLock') && admin.includes(".tracker-lock'"),
    'a documented "stop the scheduler first" is not a guarantee');
  assert.ok(!/rows restored from/.test(admin),
    'the tool must not claim a rollback it does not perform');
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
