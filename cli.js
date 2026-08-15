#!/usr/bin/env node
// Entry point for the OPTIONAL payment reconciliation lane.
//   node cli.js reconcile [--dry-run]
//
// The extraction pipeline is a separate lane and does not go through here — run
// `node scripts/tracker-watch.cjs` (or let the scheduler do it).
import { reconcileOnce } from './src/reconcile.js';

const cmd = process.argv[2];
const has = (name) => process.argv.includes(name);

try {
  if (cmd === 'reconcile') {
    const r = await reconcileOnce({ dryRun: has('--dry-run') });
    console.log(`Done. ${r.payments} payment(s) recorded${r.dryRun ? ' (dry-run)' : ''}.`);
  } else {
    console.log('Usage: node cli.js reconcile [--dry-run]');
    process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
