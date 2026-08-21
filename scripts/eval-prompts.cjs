#!/usr/bin/env node
'use strict';
// eval-prompts.cjs — run the SEMANTIC fixtures through the real model.
//
// WHY THIS EXISTS: the unit and acceptance suites prove the deterministic machinery. They
// cannot detect a PROMPT CONTRADICTION, because no model is involved. v1.2.2 shipped a prompt
// defining `final_delivered` as happening "AFTER its payment" in two places while a third
// paragraph correctly said to report an early delivery anyway — every test still passed, and
// the contradiction would have surfaced only as wrong rows in production.
//
// Each fixture states a rule the prompt must produce and cites the incident behind it. The
// model's output is validated through the REAL validator and projected through the REAL
// lifecycle, so this checks the whole contract rather than eyeballing prose.
//
// Usage:
//   node scripts/eval-prompts.cjs                  # all fixtures
//   node scripts/eval-prompts.cjs --only 02        # one fixture, by filename prefix
//   node scripts/eval-prompts.cjs --provider claude
//
// Requires a configured provider (TRACKER_AGENT_PROVIDERS in .env). Costs real model calls.

const fs = require('fs');
const path = require('path');
const { invokeProvider, loadEnv, resolveProviderChain } = require('./lib/agent-provider.cjs');
const { validateAndNormalizeClientResult } = require('./lib/client-result.cjs');
const { mergeMilestones, projectStatus } = require('./lib/status-model.cjs');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'eval', 'fixtures');
loadEnv(path.join(ROOT, '.env'));

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function loadPrompt(name) {
  const file = path.join(ROOT, 'prompts', name);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) throw new Error('prompt file is empty: ' + file);
  return text;
}

function extractJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/g, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('no JSON object in model output');
  return JSON.parse(cleaned.slice(a, b + 1));
}

// Validate the model's output, then project it exactly as the writer would, and compare
// against the rule this fixture pins.
function checkCustomer(fixture, raw) {
  const failures = [];
  const validated = validateAndNormalizeClientResult(raw, fixture.input);
  const e = fixture.expect;

  if (typeof e.records === 'number' && validated.records.length !== e.records) {
    failures.push('expected ' + e.records + ' record(s), got ' + validated.records.length);
  }
  const rec = validated.records[0];
  if (!rec) return { failures: failures.length ? failures : ['no record returned'] };

  const observed = rec.observations.map((o) => o.type);
  for (const want of e.must_observe || []) {
    if (!observed.includes(want)) {
      failures.push('missing observation "' + want + '" (got: ' + (observed.join(', ') || 'none') + ')');
    }
  }
  for (const banned of e.must_not_observe || []) {
    if (observed.includes(banned)) failures.push('emitted forbidden observation "' + banned + '"');
  }
  if (e.must_not_reuse_record_id && rec.record_id === e.must_not_reuse_record_id) {
    failures.push('reused terminal record_id instead of minting a new one');
  }

  if (e.projects_to) {
    const current = (fixture.input.existing_rows || []).find((r) => r.record_id === rec.record_id);
    const merged = mergeMilestones(current ? current.milestones : {}, rec.observations);
    const status = projectStatus(merged.milestones);
    if (status !== e.projects_to) {
      failures.push('projects to "' + status + '", expected "' + e.projects_to + '"');
    }
  }
  return { failures, observed };
}

// The counterparty pass has no record validator, so shape-check it directly — including the
// same evidence burden the watcher enforces.
function checkCounterparty(fixture, raw) {
  const failures = [];
  const e = fixture.expect;
  const updates = Array.isArray(raw.updates) ? raw.updates : null;
  const reviews = Array.isArray(raw.reviews) ? raw.reviews : null;
  if (!updates || !reviews) return { failures: ['output must contain updates[] and reviews[]'] };

  if (typeof e.updates === 'number' && updates.length !== e.updates) {
    failures.push('expected ' + e.updates + ' update(s), got ' + updates.length
      + ': ' + JSON.stringify(updates.map((u) => u && u.record_id)));
  }
  if (typeof e.reviews === 'number' && reviews.length !== e.reviews) {
    failures.push('expected ' + e.reviews + ' review(s), got ' + reviews.length);
  }
  const newIds = new Set((fixture.input.new_messages || []).map((m) => String(m.id)));
  for (const u of updates) {
    const ids = Array.isArray(u.evidence_msg_ids) ? u.evidence_msg_ids.map(String) : [];
    if (!ids.some((id) => newIds.has(id))) {
      failures.push('update for ' + (u && u.record_id) + ' cites no resolvable new evidence');
    }
  }
  return { failures, observed: updates.map((u) => u && u.record_id) };
}

(async () => {
  const only = arg('only');
  const chain = arg('provider') ? [arg('provider')] : resolveProviderChain();
  if (!chain.length) {
    console.error('no model provider configured — set TRACKER_AGENT_PROVIDERS in .env');
    process.exit(2);
  }

  const files = fs.readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !only || f.startsWith(only))
    .sort();
  if (!files.length) { console.error('no fixtures matched'); process.exit(2); }

  console.log('Running ' + files.length + ' semantic fixture(s) via: ' + chain.join(' -> '));
  console.log('These cost real model calls and check what code tests cannot: prompt contradictions.\n');

  let passed = 0;
  const failedNames = [];

  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
    const rules = loadPrompt(fixture.prompt === 'counterparty' ? 'counterparty-rules.txt' : 'customer-rules.txt');
    const prompt = rules + '\n\nINPUT JSON:\n' + JSON.stringify(fixture.input);

    let raw = null;
    let lastErr = '';
    for (const provider of chain) {
      const r = invokeProvider(provider, prompt);
      if ((r.ok || r.timedOut) && r.stdout) {
        try { raw = extractJson(r.stdout); break; } catch (err) { lastErr = err.message; }
      } else {
        lastErr = String(r.stderr || r.error || 'provider failed').slice(0, 160);
      }
    }

    if (!raw) {
      console.log('FAIL ' + file + '\n    ' + fixture.name + '\n    PROVIDER/PARSE FAILURE: ' + lastErr + '\n');
      failedNames.push(file);
      continue;
    }

    let result;
    try {
      result = fixture.prompt === 'counterparty'
        ? checkCounterparty(fixture, raw)
        : checkCustomer(fixture, raw);
    } catch (err) {
      // A validator rejection IS a finding: the prompt produced something the pipeline
      // refuses, which in production means a permanently deferred chat.
      console.log('FAIL ' + file + '\n    ' + fixture.name
        + '\n    REJECTED BY VALIDATOR: ' + err.message
        + '\n    why it matters: ' + fixture.why + '\n');
      failedNames.push(file);
      continue;
    }

    if (!result.failures.length) {
      console.log('PASS ' + file + '  — ' + fixture.name);
      if (result.observed) {
        console.log('     observed: ' + ([].concat(result.observed).join(', ') || '(none, as required)'));
      }
      passed++;
    } else {
      console.log('FAIL ' + file + '\n    ' + fixture.name);
      for (const f of result.failures) console.log('    - ' + f);
      console.log('    why it matters: ' + fixture.why + '\n');
      failedNames.push(file);
    }
  }

  console.log('\n' + passed + '/' + files.length + ' semantic fixtures passed');
  if (failedNames.length) {
    console.log('failed: ' + failedNames.join(', '));
    console.log('\nA failure here is a PROMPT defect, not a code defect. Fix prompts/*.txt and re-run.');
    process.exitCode = 1;
  }
})().catch((e) => { console.error('eval FAILED:', e.message); process.exit(1); });
