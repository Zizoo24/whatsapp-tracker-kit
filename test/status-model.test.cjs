'use strict';
// Pins the two structural rules in the lifecycle model. If you rename stages, these
// tests should still pass unchanged — they assert SHAPE, not vocabulary.

const test = require('node:test');
const assert = require('node:assert');
const {
  HANDOFF_ELIGIBLE, STAGES, STATUS_RANK, TERMINAL_STATUS, TERMINAL_TRANSITIONS, VALID_STATUS,
} = require('../scripts/lib/status-model.cjs');

test('rank is monotonic along the declared stage order', () => {
  for (let i = 1; i < STAGES.length; i++) {
    assert.ok(STATUS_RANK[STAGES[i]] > STATUS_RANK[STAGES[i - 1]],
      `${STAGES[i]} must outrank ${STAGES[i - 1]}`);
  }
});

test('every valid status is rankable (an unrankable status silently escapes the guard)', () => {
  for (const status of VALID_STATUS) {
    assert.equal(typeof STATUS_RANK[status], 'number', `${status} has no rank`);
  }
});

test('GUARDS #11: the handoff-eligible set excludes the committed-but-not-started stage', () => {
  assert.ok(!HANDOFF_ELIGIBLE.has(STAGES[0]),
    'the first stage must never be handoff-eligible, or a quote-check reads as a handoff');
  for (const stage of HANDOFF_ELIGIBLE) {
    assert.ok(VALID_STATUS.has(stage), `${stage} is not a valid status`);
  }
});

test('terminal statuses declare their allowed exits, and none goes backwards to a mid stage', () => {
  for (const status of TERMINAL_STATUS) {
    assert.ok(TERMINAL_TRANSITIONS[status], `${status} has no transition table`);
  }
  // The one legitimate backward move is a post-delivery revision, which carries its own
  // distinct evidence. Nothing else may reopen a completed record.
  assert.ok(TERMINAL_TRANSITIONS.done.has('revision'));
  assert.ok(!TERMINAL_TRANSITIONS.done.has('paid'));
  assert.equal(TERMINAL_TRANSITIONS.refunded.size, 0, 'a refunded record must never reopen');
});
