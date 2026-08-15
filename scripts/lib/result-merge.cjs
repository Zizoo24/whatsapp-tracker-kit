'use strict';
// result-merge.cjs — how the counterparty lane contributes to a record.
//
// WHAT THIS NO LONGER DOES (GUARDS #35): it used to DISCARD the counterparty contribution
// whenever the customer pass had emitted a "terminal" observation in the same tick. That
// suppression belonged to the direct-status era, where a counterparty stamp could overwrite a
// completed record's status (GUARDS #10). Two things have since made it not merely
// unnecessary but wrong:
//
//   1. `final_delivered` is no longer terminal by itself — delivery while unpaid keeps the
//      record in the chase-payment stage, so suppressing on it discarded valid work facts
//      from ordinary early-delivery jobs.
//   2. The writer now emits exactly ONE row per record per tick, merging every lane's
//      observations and projecting once (GUARDS #30). Ordering is resolved by the
//      projection, not by which lane wrote last, so there is nothing left to protect.
//
// `work_started` and the counterparty's identity are TRUE HISTORICAL FACTS. Even on a record
// that ends cancelled or refunded, "Vendor A did the work" is worth keeping — the projection
// still returns the terminal status, because terminal-dead outcomes win there.
//
// So this file simply records the contribution. The lifecycle decision is made in exactly one
// place: projectStatus.

// Append a counterparty contribution ({record_id, counterparty, observation}) to the results.
// The writer aggregates by record_id afterwards, so appending a second entry for a record the
// customer pass already touched is correct and safe.
function mergeCounterpartyUpdate(results, recordId, counterparty, observation) {
  if (typeof recordId !== 'string' || !recordId || !counterparty || !observation || !observation.type) {
    return { added: false, reason: 'invalid_update' };
  }
  results.push({
    phone: recordId.split('_')[0],
    records: [{ record_id: recordId, counterparty, observations: [observation] }],
  });
  return { added: true, reason: 'appended' };
}

module.exports = { mergeCounterpartyUpdate };
