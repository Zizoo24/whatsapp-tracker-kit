'use strict';
// The lifecycle model: observations -> durable milestone occurrences -> projected status.
// These assert SHAPE and COMMERCIAL RULES, not vocabulary.

const test = require('node:test');
const assert = require('node:assert');
const {
  HANDOFF_ELIGIBLE, MILESTONES, MilestoneStateError, OBSERVATION_MILESTONE,
  STAGES, VALID_STATUS,
  compareOccurrence, mergeMilestones, orderingIsAmbiguous, parseMilestones, projectStatus,
} = require('../scripts/lib/status-model.cjs');

const obs = (type, at, seq) => ({ type, at, seq, message_id: 'm' + (seq || 0) });
const build = (...triples) => mergeMilestones({}, triples.map(([t, a, s]) => obs(t, a, s))).milestones;

test('every stage is a valid status and the ordering is declared once', () => {
  for (const s of STAGES) assert.ok(VALID_STATUS.has(s));
  assert.equal(new Set(STAGES).size, STAGES.length, 'no duplicate stages');
});

test('every observation maps to a distinct milestone', () => {
  const keys = Object.values(OBSERVATION_MILESTONE);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...MILESTONES].sort(), [...new Set(keys)].sort());
});

// ---- GUARDS #25: the rules a memoryless reducer lost ----------------------------------

test('unpaid is unpaid EVEN IF DELIVERED — the next action is still chase payment', () => {
  const m = build(['order_committed', '2026-08-01T09:00:00Z', 1], ['final_delivered', '2026-08-01T12:00:00Z', 2]);
  assert.equal(projectStatus(m), 'confirmed_unpaid');
});

test('THE DAY-2 CASE: payment after an early delivery completes the record', () => {
  const day1 = build(['order_committed', '2026-08-01T09:00:00Z', 1], ['final_delivered', '2026-08-01T12:00:00Z', 2]);
  assert.equal(projectStatus(day1), 'confirmed_unpaid');
  const day2 = mergeMilestones(day1, [obs('payment_received', '2026-08-02T09:00:00Z', 9)]).milestones;
  assert.equal(projectStatus(day2), 'done', 'milestones must remember the delivery');
});

// ---- GUARDS #28: ordering survives storage --------------------------------------------

test('a revision in the SAME SECOND as delivery still reopens the record', () => {
  // Identical timestamps, later ingestion seq. v1.2.0 stored only the timestamp, so
  // `revised > delivered` was false and the customer's correction request vanished.
  const m = build(
    ['payment_received', '2026-08-01T10:00:00Z', 5],
    ['final_delivered', '2026-08-01T12:00:00Z', 10],
    ['revision_requested', '2026-08-01T12:00:00Z', 11],
  );
  assert.equal(projectStatus(m), 'revision');
});

test('same-second ordering also holds in the other direction', () => {
  const m = build(
    ['payment_received', '2026-08-01T10:00:00Z', 5],
    ['revision_requested', '2026-08-01T12:00:00Z', 10],
    ['final_delivered', '2026-08-01T12:00:00Z', 11],
  );
  assert.equal(projectStatus(m), 'done');
});

test('a stored occurrence keeps its evidence provenance', () => {
  const m = build(['payment_received', '2026-08-01T10:00:00Z', 42]);
  assert.equal(m.paid.seq, 42);
  assert.equal(m.paid.message_id, 'm42');
});

test('compareOccurrence orders by timestamp first, then seq, and admits ties', () => {
  const a = { at: '2026-08-01T10:00:00Z', seq: 1 };
  const b = { at: '2026-08-01T11:00:00Z', seq: 0 };
  assert.ok(compareOccurrence(b, a) > 0, 'later timestamp wins regardless of seq');
  assert.ok(compareOccurrence({ at: a.at, seq: 2 }, a) > 0, 'seq breaks a timestamp tie');
  assert.equal(compareOccurrence(a, { at: a.at, seq: 1 }), 0);
});

// ---- Ordinary lifecycle ---------------------------------------------------------------

test('the happy path projects through every stage', () => {
  assert.equal(projectStatus(build(['order_committed', '2026-08-01T09:00:00Z', 1])), 'confirmed_unpaid');
  assert.equal(projectStatus(build(['payment_received', '2026-08-01T10:00:00Z', 2])), 'paid');
  assert.equal(projectStatus(build(
    ['payment_received', '2026-08-01T10:00:00Z', 2], ['work_started', '2026-08-01T11:00:00Z', 3],
  )), 'translating');
  assert.equal(projectStatus(build(
    ['payment_received', '2026-08-01T10:00:00Z', 2], ['final_delivered', '2026-08-01T12:00:00Z', 4],
  )), 'done');
});

test('GUARDS #17: a draft never completes a paid record', () => {
  assert.equal(projectStatus(build(
    ['payment_received', '2026-08-01T10:00:00Z', 2], ['draft_sent', '2026-08-01T11:00:00Z', 3],
  )), 'translating');
});

test('a second delivery closes a reopened record (latest-wins per milestone)', () => {
  const delivered = build(['payment_received', '2026-08-01T10:00:00Z', 2], ['final_delivered', '2026-08-01T12:00:00Z', 3]);
  const revised = mergeMilestones(delivered, [obs('revision_requested', '2026-08-02T09:00:00Z', 8)]).milestones;
  assert.equal(projectStatus(revised), 'revision');
  const redelivered = mergeMilestones(revised, [obs('final_delivered', '2026-08-03T09:00:00Z', 12)]).milestones;
  assert.equal(projectStatus(redelivered), 'done');
});

test('terminal-dead outcomes win over everything, including a completed delivery', () => {
  assert.equal(projectStatus(build(
    ['payment_received', '2026-08-01T10:00:00Z', 2], ['final_delivered', '2026-08-01T12:00:00Z', 3],
    ['payment_refunded', '2026-08-05T09:00:00Z', 20],
  )), 'refunded');
  assert.equal(projectStatus(build(['order_cancelled', '2026-08-05T09:00:00Z', 20])), 'cancelled');
});

// ---- Merge semantics ------------------------------------------------------------------

test('milestones only accumulate — an older re-read cannot overwrite a newer fact', () => {
  const first = build(['final_delivered', '2026-08-05T10:00:00Z', 20]);
  const { milestones, refused } = mergeMilestones(first, [obs('final_delivered', '2026-08-01T10:00:00Z', 2)]);
  assert.equal(milestones.final_delivered.at, '2026-08-05T10:00:00Z');
  assert.equal(refused[0].reason, 'older_than_stored_occurrence');
});

test('timestamps are compared as instants, not strings (mixed offset and Z forms)', () => {
  // '2026-08-01 14:00:00+04:00' is 10:00Z — EARLIER than 12:00Z though it sorts later
  // lexically. A string compare would pick the wrong "latest" delivery.
  const m = mergeMilestones(
    { final_delivered: { at: '2026-08-01T12:00:00Z', seq: 5 } },
    [obs('final_delivered', '2026-08-01 14:00:00+04:00', 6)],
  ).milestones;
  assert.equal(m.final_delivered.at, '2026-08-01T12:00:00Z');
});

test('an observation with no usable timestamp is refused as data, not silently dropped', () => {
  const { milestones, refused } = mergeMilestones({}, [{ type: 'payment_received' }]);
  assert.deepEqual(milestones, {});
  assert.equal(refused[0].reason, 'missing_or_unparseable_timestamp');
  assert.equal(mergeMilestones({}, [obs('payment_received', 'not-a-date', 1)]).refused[0].reason,
    'missing_or_unparseable_timestamp');
});

test('an unknown observation is refused, not coerced', () => {
  assert.equal(mergeMilestones({}, [obs('vibes_received', '2026-08-01T10:00:00Z', 1)]).refused[0].reason,
    'unknown_observation');
});

// ---- GUARDS #29: malformed authoritative state fails CLOSED ---------------------------

test('blank milestone state is a new record; MALFORMED state throws', () => {
  assert.deepEqual(parseMilestones(''), {});
  assert.deepEqual(parseMilestones(null), {});
  assert.deepEqual(parseMilestones({}), {});

  // Declared machine truth that cannot be read must never degrade to "no history".
  assert.throws(() => parseMilestones('{paid: BROKEN'), MilestoneStateError);
  assert.throws(() => parseMilestones('[]'), MilestoneStateError);
  assert.throws(() => parseMilestones('{"unknown_key":{"at":"2026-08-01T10:00:00Z"}}'), MilestoneStateError);
  assert.throws(() => parseMilestones('{"paid":{"at":"not-a-date"}}'), MilestoneStateError);
  assert.throws(() => projectStatus('{paid: BROKEN'), MilestoneStateError);
});

test('a v1.2.0 scalar timestamp still parses, so an early store upgrades in place', () => {
  const m = parseMilestones('{"paid":"2026-08-01T10:00:00Z"}');
  assert.equal(m.paid.at, '2026-08-01T10:00:00Z');
  assert.equal(m.paid.seq, null);
  assert.equal(projectStatus(m), 'paid');
});

test('milestones survive a round trip through the stored JSON string', () => {
  const m = build(['payment_received', '2026-08-01T10:00:00Z', 7]);
  assert.deepEqual(parseMilestones(JSON.stringify(m)), m);
});

// ---- The remaining explicit gate -------------------------------------------------------

test('GUARDS #11: the handoff-eligible set excludes the committed-but-unpaid stage', () => {
  assert.ok(!HANDOFF_ELIGIBLE.has(STAGES[0]));
  for (const s of HANDOFF_ELIGIBLE) assert.ok(VALID_STATUS.has(s));
});

test('GUARDS #34: the status-authority API is gone — there is one write route', () => {
  const model = require('../scripts/lib/status-model.cjs');
  assert.equal(model.canAutomatedTransition, undefined, 'legacy transition gate must not survive');
  assert.equal(model.STATUS_RANK, undefined, 'rank comparison must not survive');
});

test('GUARDS #33: an unorderable revision-vs-delivery tie fails closed', () => {
  // A v1.2.0 milestone (no seq) against a fresh one at the SAME timestamp. The order is
  // genuinely unknowable and decides whether the customer's correction is honoured.
  const legacy = { at: '2026-08-01T12:00:00Z', seq: null };
  const fresh = { at: '2026-08-01T12:00:00Z', seq: 9183 };
  assert.equal(orderingIsAmbiguous(legacy, fresh), true);
  assert.throws(() => projectStatus({
    paid: { at: '2026-08-01T09:00:00Z', seq: 1 },
    final_delivered: legacy,
    revision: fresh,
  }), MilestoneStateError);

  // Once both carry precision it resolves normally.
  assert.equal(projectStatus({
    paid: { at: '2026-08-01T09:00:00Z', seq: 1 },
    final_delivered: { at: '2026-08-01T12:00:00Z', seq: 9182 },
    revision: fresh,
  }), 'revision');
});

test('a missing seq is UNKNOWN precision, never position zero', () => {
  // Number(null) is 0 and Number.isFinite(0) is true, so a naive read sorted a legacy fact
  // as the earliest possible event instead of admitting it could not be ordered.
  const { seqOf } = require('../scripts/lib/status-model.cjs');
  assert.equal(seqOf({ at: 'x', seq: null }), null);
  assert.equal(seqOf({ at: 'x' }), null);
  assert.equal(seqOf({ at: 'x', seq: 0 }), 0);
});

test('an operator baseline keeps its label through a round trip', () => {
  const m = parseMilestones(JSON.stringify({
    paid: { at: '2026-06-02T00:00:00+04:00', seq: null, message_id: 'operator-baseline', source: 'operator_baseline' },
  }));
  assert.equal(m.paid.source, 'operator_baseline',
    'a synthesised fact must stay distinguishable from a measured one');
});
