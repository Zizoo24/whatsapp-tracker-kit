'use strict';
// The semantic fixtures are only useful if they stay attached to the real model. A fixture
// citing a renamed observation, or a status that no longer exists, would silently stop
// testing anything — and its failure would look like a model problem rather than drift.
//
// This runs with no model call: it checks the fixtures are well-formed and self-consistent.
// `npm run eval` is the part that costs real calls.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { OBSERVATION_MILESTONE, VALID_STATUS } = require('../scripts/lib/status-model.cjs');

const DIR = path.join(__dirname, '..', 'eval', 'fixtures');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

test('there are semantic fixtures at all', () => {
  assert.ok(files.length >= 6, 'the prompt contract needs fixtures for each failure it encodes');
});

test('every fixture declares what it pins and why it exists', () => {
  for (const f of files) {
    const x = load(f);
    assert.ok(x.name, `${f}: missing name`);
    // The "why" is what stops a future maintainer deleting a fixture they do not understand.
    assert.ok(x.why && /GUARDS #\d+/.test(x.why), `${f}: must cite the incident it guards`);
    assert.ok(['customer', 'counterparty'].includes(x.prompt), `${f}: unknown prompt lane`);
  }
});

test('every cited observation and status exists in the live model', () => {
  for (const f of files) {
    const e = load(f).expect || {};
    for (const o of [...(e.must_observe || []), ...(e.must_not_observe || [])]) {
      assert.ok(OBSERVATION_MILESTONE[o], `${f}: cites unknown observation "${o}"`);
    }
    if (e.projects_to) {
      assert.ok(VALID_STATUS.has(e.projects_to), `${f}: cites unknown status "${e.projects_to}"`);
    }
  }
});

test('every fixture supplies new evidence the model could actually cite', () => {
  for (const f of files) {
    const x = load(f);
    const msgs = x.input.new_messages || [];
    assert.ok(msgs.length, `${f}: no new_messages — nothing could justify an observation`);
    for (const m of msgs) {
      assert.ok(m.id, `${f}: a new message has no id`);
      assert.ok(m.ts, `${f}: message ${m.id} has no timestamp`);
      assert.ok(Number.isFinite(Number(m.seq)), `${f}: message ${m.id} has no ingestion seq`);
    }
    // Ids must be unique, or evidence citation is ambiguous.
    const ids = msgs.map((m) => String(m.id));
    assert.equal(new Set(ids).size, ids.length, `${f}: duplicate message ids`);
  }
});

test('fixtures that reference an existing record carry parseable milestone state', () => {
  const { parseMilestones } = require('../scripts/lib/status-model.cjs');
  for (const f of files) {
    for (const row of load(f).input.existing_rows || []) {
      assert.doesNotThrow(() => parseMilestones(row.milestones),
        `${f}: existing row ${row.record_id} has unreadable milestones`);
    }
  }
});

test('the early-delivery fixture pins the exact rule the milestone model exists for', () => {
  // If this fixture is ever weakened, GUARDS #25 loses its only semantic coverage.
  const x = load(files.find((f) => f.startsWith('01')));
  assert.ok(x.expect.must_observe.includes('final_delivered'));
  assert.ok(x.expect.must_not_observe.includes('payment_received'));
  assert.equal(x.expect.projects_to, 'confirmed_unpaid',
    'delivered-but-unpaid must remain in the chase-payment stage');
});
