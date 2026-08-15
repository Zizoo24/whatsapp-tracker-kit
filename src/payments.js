// READ-ONLY payment processor reader (Stripe shown; swap for your processor).
//
// HARD RULE: use a RESTRICTED, READ-ONLY key (Stripe `rk_…` with Charges:Read). This
// system is TRACKING ONLY — it must never create, modify, or refund a payment, and never
// write a payment link anywhere. A tracker that can move money is a liability, not a
// convenience.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Amounts arrive in the currency's smallest unit. Most are 2-decimal, but some are
// 3-decimal and a few are 0-decimal — dividing everything by 100 silently misreports
// those by 10x or 100x.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'XAF', 'XOF', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV', 'XPF']);
const THREE_DECIMAL = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);

function toMajor(amount, currency) {
  const cur = (currency || '').toUpperCase();
  const div = ZERO_DECIMAL.has(cur) ? 1 : THREE_DECIMAL.has(cur) ? 1000 : 100;
  return amount / div;
}

// Fetch succeeded charges created at or after `sinceUnix`, oldest -> newest, paginating.
export async function fetchChargesSince(cfg, sinceUnix) {
  if (!cfg.stripeKey) throw new Error('STRIPE_KEY is not set (see .env)');
  const out = [];
  let startingAfter = null;

  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: '100' });
    // `gte` not `gt`, so a charge created in the same second as the watermark is never
    // skipped. The boundary charge is therefore re-fetched every run — that is expected
    // and harmless, because the store upserts by charge id.
    if (sinceUnix) qs.set('created[gte]', String(sinceUnix));
    if (startingAfter) qs.set('starting_after', startingAfter);

    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`https://api.stripe.com/v1/charges?${qs}`, {
        headers: { Authorization: `Bearer ${cfg.stripeKey}` },
      });
      if (res.status !== 429 && res.status < 500) break;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
    }
    const data = await res.json();
    if (data.error) throw new Error(`Payment API ${res.status}: ${data.error.message}`);

    for (const c of data.data || []) {
      if (c.status !== 'succeeded' || c.refunded) continue;
      const bd = c.billing_details || {};
      out.push({
        id: c.id,
        created: c.created,
        date: new Date(c.created * 1000).toISOString().slice(0, 10),
        amount: toMajor(c.amount, c.currency),
        currency: (c.currency || '').toUpperCase(),
        name: (bd.name || '').trim(),
        email: (bd.email || c.receipt_email || '').trim().toLowerCase(),
      });
    }
    if (!data.has_more || !(data.data || []).length) break;
    startingAfter = data.data[data.data.length - 1].id;
  }

  out.sort((a, b) => a.created - b.created); // oldest first, so the watermark advances monotonically
  return out;
}
