'use strict';
// The lifecycle model: observations -> durable milestones -> projected status.
// These assert SHAPE and COMMERCIAL RULES, not vocabulary — rename the stages and they
// should still pass.

const test = require('node:test');
const assert = require('node:assert');
const {
  DEAD_STAGES, HANDOFF_ELIGIBLE, MILESTONES, OBSERVATION_MILESTONE, STAGES, STATUS_RANK,
  TERMINAL_STATUS, VALID_STATUS,
  canAutomatedTransition, mergeMilestones, parseMilestones, projectStatus,
} = require('../scripts/lib/status-model.cjs');

const obs = (type, at) => ({ type, at });
const build = (...pairs) => mergeMilestones({}, pairs.map(([t, a]) => obs(t, a))).milestones;

test('rank is monotonic and every valid status is rankable', () => {
  for (let i = 1; i < STAGES.length; i++) {
    assert.ok(STATUS_RANK[STAGES[i]] > STATUS_RANK[STAGES[i - 1]]);
  }
  for (const s of VALID_STATUS) assert.equal(typeof STATUS_RANK[s], 'number');
});

test('every observation maps to a distinct milestone', () => {
  const keys = Object.values(OBSERVATION_MILESTONE);
  assert.equal(new Set(keys).size, keys.length, 'two observations share a milestone');
  assert.deepEqual([...MILESTONES].sort(), [...new Set(keys)].sort());
});

// ---- THE REGRESSION THAT CREATED THIS MODEL -----------------------------------------

test('unpaid is unpaid EVEN IF DELIVERED — the next action is still chase payment', () => {
  const m = build(['order_committed', '2026-08-01T09:00:00Z'], ['final_delivered', '2026-08-01T12:00:00Z']);
  assert.equal(projectStatus(m), 'confirmed_unpaid',
    'a memoryless reducer called this "done" and stopped chasing the money');
});

test('unpaid + draft does not advance either', () => {
  const m = build(['order_committed', '2026-08-01T09:00:00Z'], ['draft_sent', '2026-08-01T10:00:00Z']);
  assert.equal(projectStatus(m), 'confirmed_unpaid');
});

test('THE DAY-2 CASE: payment arriving after an early delivery completes the record', () => {
  // Day 1 — committed and delivered, still unpaid.
  const day1 = build(['order_committed', '2026-08-01T09:00:00Z'], ['final_delivered', '2026-08-01T12:00:00Z']);
  assert.equal(projectStatus(day1), 'confirmed_unpaid');

  // Day 2 — payment lands. The delivery is now OLD context and cannot be re-cited as fresh
  // evidence, so only `payment_received` arrives. Milestones remember the delivery.
  const day2 = mergeMilestones(day1, [obs('payment_received', '2026-08-02T09:00:00Z')]).milestones;
  assert.equal(projectStatus(day2), 'done',
    'a memoryless reducer returned "paid" here, silently forgetting the job was finished');
});

// ---- Ordinary lifecycle ---------------------------------------------------------------

test('the happy path projects through every stage', () => {
  assert.equal(projectStatus(build(['order_committed', '2026-08-01T09:00:00Z'])), 'confirmed_unpaid');
  assert.equal(projectStatus(build(
    ['order_committed', '2026-08-01T09:00:00Z'], ['payment_received', '2026-08-01T10:00:00Z'],
  )), 'paid');
  assert.equal(projectStatus(build(
    ['order_committed', '2026-08-01T09:00:00Z'], ['payment_received', '2026-08-01T10:00:00Z'],
    ['work_started', '2026-08-01T11:00:00Z'],
  )), 'translating');
  assert.equal(projectStatus(build(
    ['order_committed', '2026-08-01T09:00:00Z'], ['payment_received', '2026-08-01T10:00:00Z'],
    ['final_delivered', '2026-08-01T12:00:00Z'],
  )), 'done');
});

test('GUARDS #17: a draft never completes a paid record', () => {
  const m = build(
    ['payment_received', '2026-08-01T10:00:00Z'], ['draft_sent', '2026-08-01T11:00:00Z'],
  );
  assert.equal(projectStatus(m), 'translating');
});

test('a revision AFTER delivery reopens the record; a second delivery closes it again', () => {
  const delivered = build(
    ['payment_received', '2026-08-01T10:00:00Z'], ['final_delivered', '2026-08-01T12:00:00Z'],
  );
  assert.equal(projectStatus(delivered), 'done');

  const revised = mergeMilestones(delivered, [obs('revision_requested', '2026-08-02T09:00:00Z')]).milestones;
  assert.equal(projectStatus(revised), 'revision');

  // Latest-wins per milestone is what makes a second cycle project correctly.
  const redelivered = mergeMilestones(revised, [obs('final_delivered', '2026-08-03T09:00:00Z')]).milestones;
  assert.equal(projectStatus(redelivered), 'done');
});

test('a revision recorded BEFORE the latest delivery does not reopen it', () => {
  const m = build(
    ['payment_received', '2026-08-01T10:00:00Z'],
    ['revision_requested', '2026-08-01T11:00:00Z'],
    ['final_delivered', '2026-08-01T12:00:00Z'],
  );
  assert.equal(projectStatus(m), 'done');
});

test('terminal-dead outcomes win over everything, including a completed delivery', () => {
  const m = build(
    ['payment_received', '2026-08-01T10:00:00Z'], ['final_delivered', '2026-08-01T12:00:00Z'],
    ['payment_refunded', '2026-08-05T09:00:00Z'],
  );
  assert.equal(projectStatus(m), 'refunded');
  assert.equal(projectStatus(build(['order_cancelled', '2026-08-05T09:00:00Z'])), 'cancelled');
});

// ---- Merge semantics ------------------------------------------------------------------

test('milestones only accumulate — a stale re-read cannot erase one', () => {
  const first = build(['payment_received', '2026-08-01T10:00:00Z']);
  const again = mergeMilestones(first, [obs('order_committed', '2026-08-01T09:00:00Z')]).milestones;
  assert.equal(again.paid_at, '2026-08-01T10:00:00Z', 'the earlier payment fact must survive');
  assert.equal(projectStatus(again), 'paid');
});

test('timestamps are compared as instants, not strings (mixed offset and Z forms)', () => {
  // '2026-08-01 14:00:00+04:00' is 10:00Z — EARLIER than 12:00Z, though it sorts later
  // lexically. A string compare would pick the wrong "latest" delivery.
  const m = mergeMilestones(
    { final_delivered_at: '2026-08-01T12:00:00Z' },
    [obs('final_delivered', '2026-08-01 14:00:00+04:00')],
  ).milestones;
  assert.equal(m.final_delivered_at, '2026-08-01T12:00:00Z');
});

test('an observation with no timestamp is refused as data, not silently dropped', () => {
  const { milestones, refused } = mergeMilestones({}, [{ type: 'payment_received' }]);
  assert.deepEqual(milestones, {});
  assert.equal(refused[0].reason, 'missing_timestamp');
});

test('an unknown observation is refused, not coerced', () => {
  assert.equal(mergeMilestones({}, [obs('vibes_received', '2026-08-01T10:00:00Z')]).refused[0].reason,
    'unknown_observation');
});

test('milestones survive a round trip through the stored JSON string', () => {
  const m = build(['payment_received', '2026-08-01T10:00:00Z']);
  assert.deepEqual(parseMilestones(JSON.stringify(m)), m);
  assert.deepEqual(parseMilestones(''), {});
  assert.deepEqual(parseMilestones('not json'), {});
  assert.deepEqual(parseMilestones(null), {});
});

// ---- The remaining explicit gate -------------------------------------------------------

test('GUARDS #11: the handoff-eligible set excludes the committed-but-unpaid stage', () => {
  assert.ok(!HANDOFF_ELIGIBLE.has(STAGES[0]));
  for (const s of HANDOFF_ELIGIBLE) assert.ok(VALID_STATUS.has(s));
});

test('GUARDS #13/#22: a direct status may not downgrade, but a post-completion move is allowed', () => {
  assert.equal(canAutomatedTransition('done', 'paid').allowed, false);
  assert.equal(canAutomatedTransition('done', 'revision').allowed, true);
  assert.equal(canAutomatedTransition('refunded', 'paid').allowed, false);
  assert.equal(canAutomatedTransition('cancelled', 'refunded').allowed, true);
  for (const dead of DEAD_STAGES) assert.equal(canAutomatedTransition('paid', dead).allowed, true);
});

test('every terminal status is projectable from milestones', () => {
  for (const s of TERMINAL_STATUS) assert.ok(VALID_STATUS.has(s));
});
