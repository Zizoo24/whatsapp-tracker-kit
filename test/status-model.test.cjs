'use strict';
// The lifecycle model and its reducer. These assert SHAPE, not vocabulary — rename the
// stages and they should still pass unchanged.

const test = require('node:test');
const assert = require('node:assert');
const {
  DEAD_STAGES, HANDOFF_ELIGIBLE, OBSERVATION_STAGE, STAGES, STATUS_RANK,
  TERMINAL_STATUS, TERMINAL_TRANSITIONS, VALID_STATUS,
  canAutomatedTransition, reduceObservations,
} = require('../scripts/lib/status-model.cjs');

test('rank is monotonic along the declared stage order', () => {
  for (let i = 1; i < STAGES.length; i++) {
    assert.ok(STATUS_RANK[STAGES[i]] > STATUS_RANK[STAGES[i - 1]]);
  }
});

test('every valid status is rankable (an unrankable one escapes the guard)', () => {
  for (const s of VALID_STATUS) assert.equal(typeof STATUS_RANK[s], 'number', `${s} has no rank`);
});

test('every observation maps to a valid stage', () => {
  for (const [obs, stage] of Object.entries(OBSERVATION_STAGE)) {
    assert.ok(VALID_STATUS.has(stage), `${obs} maps to unknown stage ${stage}`);
  }
});

test('GUARDS #17: a draft is structurally incapable of completing a record', () => {
  assert.notEqual(OBSERVATION_STAGE.draft_sent, 'done');
  assert.equal(OBSERVATION_STAGE.draft_sent, OBSERVATION_STAGE.work_started);
});

test('GUARDS #14: the observation for a customer saying "Done" cannot reach the terminal stage', () => {
  // The model maps that phrase to payment_received; the reducer must land on paid.
  const { status } = reduceObservations(null, [
    { type: 'order_committed' }, { type: 'payment_received' },
  ]);
  assert.equal(status, 'paid');
});

test('GUARDS #11: the handoff-eligible set excludes the committed-but-unpaid stage', () => {
  assert.ok(!HANDOFF_ELIGIBLE.has(STAGES[0]));
  for (const s of HANDOFF_ELIGIBLE) assert.ok(VALID_STATUS.has(s));
});

test('GUARDS #13: a stale re-read cannot walk a record backwards', () => {
  const v = canAutomatedTransition('done', 'paid', 'payment_received');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /downgrade_refused|terminal_transition_forbidden/);
});

test('GUARDS #22: a post-delivery revision IS allowed (rank alone would refuse it)', () => {
  assert.ok(STATUS_RANK.revision < STATUS_RANK.done, 'precondition: revision ranks below done');
  const v = canAutomatedTransition('done', 'revision', 'revision_requested');
  assert.equal(v.allowed, true, 'the legitimate backward move must survive');
});

test('a terminal record cannot be reopened by an unrelated observation', () => {
  assert.equal(canAutomatedTransition('done', 'paid', 'payment_received').allowed, false);
  assert.equal(canAutomatedTransition('refunded', 'paid', 'payment_received').allowed, false);
  assert.equal(TERMINAL_TRANSITIONS.refunded.size, 0, 'a refunded record never reopens');
});

test('terminal-dead outcomes may arrive from any active stage', () => {
  for (const dead of DEAD_STAGES) {
    assert.equal(canAutomatedTransition('paid', dead, 'order_cancelled').allowed, true);
  }
});

test('the reducer walks a whole lifecycle within one delta, in order', () => {
  const { status, applied } = reduceObservations(null, [
    { type: 'order_committed' }, { type: 'payment_received' },
    { type: 'draft_sent' }, { type: 'final_delivered' },
  ]);
  assert.equal(status, 'done');
  assert.deepEqual(applied.map((a) => a.status),
    ['confirmed_unpaid', 'paid', 'translating', 'done']);
});

test('the reducer reports refusals as data, never silence', () => {
  const { status, refused } = reduceObservations('done', [{ type: 'payment_received' }]);
  assert.equal(status, 'done');
  assert.equal(refused.length, 1);
  assert.ok(refused[0].reason, 'a refusal must carry a reason a human can read');
});

test('an unknown observation is refused, not coerced', () => {
  const { refused } = reduceObservations(null, [{ type: 'vibes_received' }]);
  assert.equal(refused[0].reason, 'unknown_observation');
});

test('every terminal status declares a transition table', () => {
  for (const s of TERMINAL_STATUS) assert.ok(TERMINAL_TRANSITIONS[s], `${s} has none`);
});
