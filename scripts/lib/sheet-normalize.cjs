'use strict';
// sheet-normalize.cjs — ONE normalizer for every store-facing value.
//
// WHY ONE: in the source system the writer and the nightly auditor each grew their own
// normalizer, and they disagreed about dates. A stored ISO INSTANT like
// '2026-06-21T20:00:00.000Z' is 2026-06-22 in a UTC+4 timezone.
//
//   writer   -> localDate()           -> '2026-06-22'   (correct: the record started then)
//   auditor  -> String(v).slice(0,10) -> '2026-06-21'   (wrong: a naive UTC slice)
//
// So the auditor reported a mismatch on EVERY record whose creation instant fell in the
// evening window — 8 of its first 10 findings, all off by exactly one day. Those were not
// data problems; they were two normalizers drifting apart. Adjudicating them would have
// made them recur nightly and made "zero findings" permanently unreachable.
//
// SET YOUR TIMEZONE. A tracker for a local business must render dates in the operator's
// civil day, not UTC.

const DISPLAY_TIMEZONE = process.env.TRACKER_TIMEZONE || 'UTC';

function localDate(date, timeZone = DISPLAY_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeCell(field, value, { blankAs = '' } = {}) {
  if (value === null || value === undefined || String(value).trim() === '') return blankAs;
  const text = String(value).trim();
  if (field === 'source_date') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
      const date = new Date(text);
      if (!Number.isNaN(date.getTime())) return localDate(date);
    }
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    if (match) return match[1];
  }
  return text;
}

// Comparison form: also collapses internal whitespace, which free-text fields need.
function normalizeForCompare(field, value) {
  const base = normalizeCell(field, value);
  return field === 'source_date' ? base : base.replace(/\s+/g, ' ').trim();
}

module.exports = { DISPLAY_TIMEZONE, localDate, normalizeCell, normalizeForCompare };
