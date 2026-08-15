'use strict';
// result-merge.cjs — cross-pass precedence. Ported verbatim in shape.
//
// The counterparty pass records WHO is doing the work (the `counterparty` column) and
// moves the record to an in-progress stage. It must NEVER overwrite a terminal status the
// CUSTOMER pass produced in the SAME run.
//
// PRODUCTION FAILURE (docs/GUARDS.md #10): in a single run the counterparty pass stamped
// an in-progress status onto a record the customer pass had already marked complete,
// leaving finished work stuck in the "needs attention" colour. Hit 3 real rows.
//
// The precedence is one-directional and deliberate: a terminal stage from the pass that
// owns completion always beats a side-channel stamp.

function hasTerminalRecord(results, recordId, terminalStatus = 'done') {
  return results.some((entry) => (entry.records || []).some((record) => (
    record && record.record_id === recordId && record.status === terminalStatus
  )));
}

// Push a counterparty update ({record_id, counterparty, status}) into results, unless
// the customer pass already produced the terminal status for that record this run.
function mergeCounterpartyUpdate(results, recordId, counterparty, status) {
  if (typeof recordId !== 'string' || !recordId || !counterparty || !status) {
    return { added: false, reason: 'invalid_update' };
  }
  if (hasTerminalRecord(results, recordId)) {
    return { added: false, reason: 'customer_pass_terminal' };
  }
  results.push({
    phone: recordId.split('_')[0],
    records: [{ record_id: recordId, status, counterparty }],
  });
  return { added: true, reason: 'appended' };
}

module.exports = { mergeCounterpartyUpdate, hasTerminalRecord };
