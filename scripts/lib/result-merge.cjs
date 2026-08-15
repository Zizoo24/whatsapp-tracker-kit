'use strict';
// result-merge.cjs — cross-pass precedence.
//
// The counterparty pass records WHO is doing the work (the `counterparty` column) and
// observes that work has started. It must NEVER overwrite a terminal outcome the CUSTOMER
// pass produced in the SAME run.
//
// PRODUCTION FAILURE (docs/GUARDS.md #10): in a single run the counterparty pass stamped an
// in-progress status onto a record the customer pass had already completed, leaving finished
// work showing as needing attention. Hit 3 real rows.
//
// Since v1.2 a counterparty update carries a `work_started` OBSERVATION rather than a status,
// so both lanes flow through the same milestone projection. The precedence check below stays
// because it is cheaper and clearer to refuse the update here than to rely on the projection
// ordering it correctly.

const TERMINAL_OBSERVATIONS = new Set(['final_delivered', 'order_cancelled', 'payment_refunded']);

// Did the customer pass produce a terminal outcome for this record in THIS run?
function hasTerminalRecord(results, recordId) {
  return results.some((entry) => (entry.records || []).some((record) => {
    if (!record || record.record_id !== recordId) return false;
    if (record.status === 'done') return true; // a pre-derived status (legacy shape)
    return (record.observations || []).some((o) => TERMINAL_OBSERVATIONS.has(o && o.type));
  }));
}

// Push a counterparty update into results, unless the customer pass already produced a
// terminal outcome for that record this run.
function mergeCounterpartyUpdate(results, recordId, counterparty, observation) {
  if (typeof recordId !== 'string' || !recordId || !counterparty || !observation || !observation.type) {
    return { added: false, reason: 'invalid_update' };
  }
  if (hasTerminalRecord(results, recordId)) {
    return { added: false, reason: 'customer_pass_terminal' };
  }
  results.push({
    phone: recordId.split('_')[0],
    records: [{ record_id: recordId, counterparty, observations: [observation] }],
  });
  return { added: true, reason: 'appended' };
}

module.exports = { TERMINAL_OBSERVATIONS, hasTerminalRecord, mergeCounterpartyUpdate };
