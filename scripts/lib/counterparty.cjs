'use strict';
// counterparty.cjs — SEAM. The registry of NON-CUSTOMER chats.
//
// A "counterparty" is anyone you talk to about the work who is NOT the customer:
// an outsourcing vendor, a subcontractor, an internal team. Their chats are EXCLUDED
// from customer extraction and get a separate pass, because the evidence that work was
// handed over lives in THEIR chat (that is where the files get forwarded), not the
// customer's.
//
// FAILURE THIS PREVENTS (docs/GUARDS.md #6): an unregistered counterparty's chat was
// parsed as a CUSTOMER order, inventing a customer from a name WE had typed to them.
// Registering the number is the entire fix.
//
// Keys are canonical digits — no '+', no spaces, no punctuation. One counterparty may
// have several numbers; every alias must map to the SAME display value, or the store
// gets two names for one entity.

const COUNTERPARTIES = Object.freeze({
  // '971500000000': 'vendor-a',
  // '971500000001': 'vendor-a',   // same vendor, second number -> same value
  // '971500000002': 'vendor-b',
});

// GROUP-chat counterparties. Some counterparties work in a shared group thread rather
// than a 1:1 chat. This map exists because the active-chat scan deliberately excludes
// '@g.us' (group traffic is not customer traffic), so WITHOUT registering the group a
// whole counterparty is invisible: its handoffs are never detected, and the pass may
// credit a DIFFERENT counterparty for its work. Only groups listed here are ever pulled
// in — never groups at large.
const COUNTERPARTY_GROUPS = Object.freeze({
  // '120000000000000000@g.us': 'vendor-c',
});

module.exports = { COUNTERPARTIES, COUNTERPARTY_GROUPS };
