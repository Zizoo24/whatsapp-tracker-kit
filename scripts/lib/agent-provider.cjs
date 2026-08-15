'use strict';
// agent-provider.cjs — the ONE judgment step's transport. Model-runtime agnostic.
//
// Three adapters, tried in the order named by TRACKER_AGENT_PROVIDERS:
//   claude  — Claude Code CLI, headless (`-p`), tools disabled, no session persistence.
//   codex   — Codex CLI, ephemeral + read-only sandbox, output read from a temp file.
//   command — a generic stdin->stdout process, so any future runtime drops in without
//             touching this file.
//
// AUTH IS THE #1 SILENT KILLER (docs/GUARDS.md #12). A normal subscription OAuth token
// expires roughly daily and a headless subprocess CANNOT refresh it: every call returns
// 401, extraction aborts, the cursor freezes, and the store silently stops updating while
// everything LOOKS healthy. Use a long-lived token (`claude setup-token`) written to
// agent-token.env. `authFailed` below is what turns that into an alert instead of silence.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_CODEX_MODEL = 'gpt-5.4-mini';

// Loads .env into process.env for the CJS lanes, which cannot import the ESM config.js.
//
// The key pattern MUST stay generic (`[A-Z0-9_]+`) and match config.js. It was briefly
// scoped to a single prefix, which silently starved the watcher of WHATSAPP_BRIDGE_EXE,
// WHATSAPP_DB_PATH, SHEET_WEBHOOK_URL, and SHEET_SECRET: the bridge supervisor threw on
// tick #1 and the heartbeat could not post, so the cloud watchdog never learned the lane
// was dead. A config loader that silently drops keys is the same silent-failure class this
// system exists to eliminate. Already-set env vars still win, so a real environment
// overrides the file.
function loadEnv(file, env = process.env) {
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { return env; }
  for (const line of lines) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function resolveProviderChain(env = process.env) {
  const configured = String(env.TRACKER_AGENT_PROVIDERS || 'claude,codex')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(configured)].filter((name) => (
    name === 'claude' || name === 'codex' || name === 'command'
  ));
}

function resultFromSpawn(provider, result, output = result.stdout || '') {
  const stderr = String(result.stderr || '');
  const combined = String(output || '') + '\n' + stderr;
  return {
    provider,
    ok: result.status === 0 && Boolean(String(output || '').trim()),
    status: result.status,
    stdout: String(output || ''),
    stderr,
    timedOut: result.status == null && result.error?.code === 'ETIMEDOUT',
    // Distinguishing auth failure from any other failure is what makes the alert
    // actionable: "log in again" vs "the model returned junk".
    authFailed: /\b401\b|invalid authentication|failed to authenticate|not logged in|token has been revoked/i.test(combined),
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

function invokeClaude(prompt, { env = process.env, timeoutMs = 150000, spawn = spawnSync } = {}) {
  const executable = env.TRACKER_CLAUDE_PATH || '';
  if (!executable || !fs.existsSync(executable)) {
    return {
      provider: 'claude', ok: false, status: null, stdout: '', stderr: '',
      timedOut: false, authFailed: false,
      error: 'executable missing (set TRACKER_CLAUDE_PATH): ' + (executable || '(unset)'),
    };
  }
  const result = spawn(executable, [
    '-p',
    '--model', env.TRACKER_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL,
    '--tools', '',                 // pure text-in/JSON-out; no tools, no side effects
    '--no-session-persistence',
  ], { input: prompt, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env });
  return resultFromSpawn('claude', result);
}

function invokeCodex(prompt, { env = process.env, timeoutMs = 180000, spawn = spawnSync } = {}) {
  const executable = env.TRACKER_CODEX_PATH || '';
  if (!executable || !fs.existsSync(executable)) {
    return {
      provider: 'codex', ok: false, status: null, stdout: '', stderr: '',
      timedOut: false, authFailed: false,
      error: 'executable missing (set TRACKER_CODEX_PATH): ' + (executable || '(unset)'),
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-codex-'));
  const outputFile = path.join(tempDir, 'last-message.txt');
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--sandbox', 'read-only',
    '--color', 'never',
    '--output-last-message', outputFile,
    '--model', env.TRACKER_CODEX_MODEL || DEFAULT_CODEX_MODEL,
  ];

  try {
    // A .ps1 shim cannot be spawned directly on Windows; route it through PowerShell.
    const extension = path.extname(executable).toLowerCase();
    const command = extension === '.ps1' ? 'powershell.exe' : executable;
    const commandArgs = extension === '.ps1'
      ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', executable, ...args]
      : args;
    const result = spawn(command, commandArgs, {
      input: prompt, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, cwd: tempDir, env,
    });
    let output = '';
    try { output = fs.readFileSync(outputFile, 'utf8'); } catch { output = result.stdout || ''; }
    return resultFromSpawn('codex', result, output);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

function invokeCommand(prompt, { env = process.env, timeoutMs = 180000, spawn = spawnSync } = {}) {
  const executable = String(env.TRACKER_AGENT_COMMAND || '').trim();
  const fail = (error) => ({
    provider: 'command', ok: false, status: null, stdout: '', stderr: '',
    timedOut: false, authFailed: false, error,
  });
  if (!executable) return fail('TRACKER_AGENT_COMMAND is not configured');
  let args = [];
  try { args = JSON.parse(env.TRACKER_AGENT_ARGS_JSON || '[]'); }
  catch { return fail('TRACKER_AGENT_ARGS_JSON is invalid JSON'); }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    return fail('TRACKER_AGENT_ARGS_JSON must be a JSON string array');
  }
  return resultFromSpawn('command', spawn(executable, args, {
    input: prompt, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env,
  }));
}

function invokeProvider(provider, prompt, options = {}) {
  if (provider === 'claude') return invokeClaude(prompt, options);
  if (provider === 'codex') return invokeCodex(prompt, options);
  if (provider === 'command') return invokeCommand(prompt, options);
  return {
    provider, ok: false, status: null, stdout: '', stderr: '',
    timedOut: false, authFailed: false, error: 'unsupported provider',
  };
}

module.exports = {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  invokeClaude,
  invokeCodex,
  invokeCommand,
  invokeProvider,
  loadEnv,
  resolveProviderChain,
};
