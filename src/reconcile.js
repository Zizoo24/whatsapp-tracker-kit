// Payment reconciliation — records EVERY succeeded payment in the Payments tab as a
// complete, reliable payment log.
//
// DELIBERATELY DOES NOT MATCH PAYMENTS TO RECORDS. An earlier version matched on
// name + amount and it was unsafe: currency-blind and dependent on a loose price parse,
// so it produced false "paid" statuses on real records. A wrong payment status is worse
// than no payment status — it stops you chasing money you never received.
//
// The chat-side extraction already covers payment status for ANY payment method, because
// the model reads the confirmation from the conversation. This lane exists for the audit
// log, not for status.
//
// If you later want true record<->payment matching, the safe shape is: charge ->
// checkout session -> payment link -> the chat where that link was sent most recently
// BEFORE the payment time (links get reused, so time disambiguates), plus an exact email
// match. Never name+amount.
import { loadConfig } from '../config.js';
import { loadState, saveState } from './state.js';
import { fetchChargesSince } from './payments.js';
import { appendRows } from './sheet.js';

export async function reconcileOnce(opts = {}) {
  const cfg = loadConfig();
  if (!cfg.stripeKey) throw new Error('STRIPE_KEY is not set (see .env)');
  const dry = Boolean(opts.dryRun);
  const state = loadState(cfg.statePath);

  const charges = await fetchChargesSince(cfg, state.paymentsTs || 0);
  if (!charges.length) {
    console.log('No new payments since the last run.');
    return { payments: 0 };
  }

  const rows = charges.map((c) => ({
    charge_id: c.id,
    paid_at: c.date,
    amount: c.amount,
    currency: c.currency,
    customer_name: c.name,
    email: c.email,
    matched_record_id: '', // intentionally blank — see the header note
  }));

  if (dry) {
    console.log(`[dry-run] ${rows.length} payment(s) would be recorded:`);
    for (const r of rows) console.log(`  - ${r.paid_at} | ${r.currency} ${r.amount} | ${r.customer_name || '-'}`);
    return { payments: rows.length, dryRun: true };
  }

  await appendRows(rows, cfg, 'Payments'); // upserts by charge_id -> idempotent
  saveState(cfg.statePath, {
    ...loadState(cfg.statePath),
    paymentsTs: charges[charges.length - 1].created,
  });
  return { payments: rows.length };
}
