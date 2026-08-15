'use strict';
// bridge-supervisor.cjs — keep the ingress process alive without hammering it.
//
// THREE PRODUCTION LESSONS ARE ENCODED HERE:
//
// 1. A DEAD BRIDGE LOOKS EXACTLY LIKE A QUIET DAY. Downstream, zero new messages is
//    indistinguishable from "nobody wrote today". The source system lost 52 hours to this
//    before any supervision existed. Probe the PROCESS, don't infer from the data.
//
// 2. HEALTH MUST BE AN EXPLICIT SIGNAL, NEVER MESSAGE AGE. The bridge can be alive, its
//    REST port up, and its socket silently dead — a "connected-but-stale zombie". But the
//    inverse trap is worse: restarting because no message arrived recently means a genuinely
//    quiet account gets its session churned all day. So this supervisor restarts ONLY on an
//    explicit failed /api/health probe. Message age is carried as a metric for alerting and
//    is NEVER a restart trigger. (This requires the /api/health patch — see bridge/.)
//
// 3. THE RESTART BUDGET MUST BE SHARED, NOT PER-LANE. It used to live in one lane's private
//    state file while another lane called the same supervisor every 3 minutes — so a
//    crash-looping bridge was relaunched forever while the logs claimed "pausing restarts".
//    The budget now lives in a marker file HERE, so every caller is bound by it.
//
// Escalation goes out through the HEARTBEAT (email watchdog), never through the message
// channel: in this failure mode the message channel IS the dead component.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const STALE_MARKER = path.join(ROOT, '.bridge-stale-restart');
const BUDGET_MARKER = path.join(ROOT, '.bridge-supervision-state.json');

const STALE_COOLDOWN_MIN = 30;      // min gap between restarts of an unhealthy-but-alive bridge
const BUDGET_MAX = 3;               // relaunches per window before we stop hammering
const BUDGET_WINDOW_MIN = 30;
const ESCALATE_COOLDOWN_MIN = 60;   // observe-only period after escalation
const UNHEALTHY_ESCALATE_MIN = 90;  // alive-but-unhealthy this long escalates on its own clock

function bridgeExe() {
  const exe = process.env.WHATSAPP_BRIDGE_EXE || '';
  if (!exe) throw new Error('WHATSAPP_BRIDGE_EXE is not set');
  return exe;
}
const bridgeApi = () => process.env.WHATSAPP_BRIDGE_API || 'http://127.0.0.1:8080';
const processName = () => path.basename(bridgeExe());

function readBudget(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
function writeBudget(state, file) {
  fs.writeFileSync(file, JSON.stringify(state));
}

function defaultProcessApi() {
  const exe = bridgeExe();
  const name = processName();
  const dir = path.dirname(exe);
  const logDir = path.join(dir, 'store', 'logs');
  const isWindows = process.platform === 'win32';

  return {
    isAlive() {
      if (isWindows) {
        const result = spawnSync('tasklist', [], { encoding: 'utf8', windowsHide: true });
        if (result.status !== 0) throw new Error('bridge supervisor could not inspect processes');
        return new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(result.stdout || '');
      }
      const result = spawnSync('pgrep', ['-f', name], { encoding: 'utf8' });
      return String(result.stdout || '').trim().length > 0;
    },
    kill() {
      if (isWindows) spawnSync('taskkill', ['/F', '/IM', name], { encoding: 'utf8', windowsHide: true });
      else spawnSync('pkill', ['-f', name], { encoding: 'utf8' });
    },
    health() {
      const result = spawnSync('curl', [
        '-fsS', '--max-time', '5', '--retry', '2', '--retry-delay', '1', '--retry-connrefused',
        `${bridgeApi()}/api/health`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (result.status !== 0) {
        return { reachable: false, healthy: false, error: String(result.stderr || '').trim().slice(0, 200) };
      }
      try {
        const body = JSON.parse(result.stdout || '{}');
        return {
          reachable: true,
          healthy: body.ok === true && body.connected === true && body.logged_in === true,
          body,
        };
      } catch (error) {
        return { reachable: true, healthy: false, error: 'invalid health JSON: ' + error.message };
      }
    },
    start() {
      fs.mkdirSync(logDir, { recursive: true });
      const stdout = fs.openSync(path.join(logDir, 'supervisor.out.log'), 'a');
      const stderr = fs.openSync(path.join(logDir, 'supervisor.err.log'), 'a');
      // detached + unref so the bridge survives this short-lived supervisor process.
      const child = spawn(exe, [], {
        cwd: dir, detached: true, stdio: ['ignore', stdout, stderr], windowsHide: true,
      });
      fs.closeSync(stdout);
      fs.closeSync(stderr);
      child.unref();
      if (!child.pid) throw new Error('bridge supervisor relaunch returned no pid');
      return child.pid;
    },
  };
}

// Fails CLOSED on a non-ENOENT read error: a permission failure used to read as "no
// cooldown" and allow kill/restart storms. A corrupt marker is deleted and treated as
// absent, self-healing on the next successful relaunch.
function readCooldown(markerPath, nowMs = Date.now()) {
  let raw;
  try { raw = fs.readFileSync(markerPath, 'utf8'); }
  catch (err) { return err && err.code === 'ENOENT' ? 0 : nowMs; }
  try { return Number(JSON.parse(raw).at || 0); }
  catch { try { fs.unlinkSync(markerPath); } catch {} return 0; }
}

function superviseBridgeProcess({
  nowMs = Date.now(),
  processApi = defaultProcessApi(),
  markerPath = STALE_MARKER,
  staleCooldownMin = STALE_COOLDOWN_MIN,
  budgetPath = BUDGET_MARKER,
} = {}) {
  const state = readBudget(budgetPath);
  state.relaunches = (state.relaunches || []).filter((t) => nowMs - t < BUDGET_WINDOW_MIN * 60000);

  // Observe-mode is keyed on escalatedAt ALONE. Pruning the relaunch window first made
  // observe-mode silently end at oldest-relaunch + 30min instead of escalation + 60min.
  if (state.escalatedAt && nowMs - state.escalatedAt < ESCALATE_COOLDOWN_MIN * 60000) {
    let health;
    try { health = processApi.isAlive() ? processApi.health() : { reachable: false, healthy: false }; }
    catch { health = { reachable: false, healthy: false }; }
    if (health.healthy) {
      delete state.escalatedAt;
      delete state.unhealthySinceMs;
      writeBudget(state, budgetPath);
      return { kind: 'observed_running', bridgePid: null, health, recovered: true };
    }
    return { kind: 'escalated', bridgePid: null, health, escalatedAt: state.escalatedAt, fresh: false };
  }
  if (state.escalatedAt) delete state.escalatedAt; // cooldown expired — resume supervision

  const escalate = (health) => {
    state.escalatedAt = nowMs;
    writeBudget(state, budgetPath);
    return { kind: 'escalated', bridgePid: null, health, escalatedAt: nowMs, fresh: true };
  };

  if (!processApi.isAlive()) {
    if (state.relaunches.length >= BUDGET_MAX) return escalate({ reachable: false, healthy: false });
    state.relaunches.push(nowMs);
    writeBudget(state, budgetPath);
    const bridgePid = processApi.start();
    fs.writeFileSync(markerPath, JSON.stringify({ at: nowMs, reason: 'dead' }));
    return { kind: 'dead_relaunch', bridgePid, health: { reachable: false, healthy: false } };
  }

  const health = processApi.health();
  if (health.healthy) {
    if (state.unhealthySinceMs) { delete state.unhealthySinceMs; writeBudget(state, budgetPath); }
    return { kind: 'observed_running', bridgePid: null, health };
  }

  // Alive but unhealthy. The 30-min cooldown rate-limits restarts to one per window, so
  // this path can never trip the 3-in-30 budget on its own — a logged-out bridge needing
  // a QR re-pair would restart forever without ever alerting. So persistent unhealthiness
  // escalates on its own clock.
  if (!state.unhealthySinceMs) { state.unhealthySinceMs = nowMs; writeBudget(state, budgetPath); }
  if (nowMs - state.unhealthySinceMs >= UNHEALTHY_ESCALATE_MIN * 60000) return escalate(health);

  if (nowMs - readCooldown(markerPath, nowMs) < staleCooldownMin * 60000) {
    return { kind: 'observed_running', bridgePid: null, health, cooldown: true };
  }
  if (state.relaunches.length >= BUDGET_MAX) return escalate(health);

  state.relaunches.push(nowMs);
  writeBudget(state, budgetPath);
  processApi.kill();
  const bridgePid = processApi.start();
  fs.writeFileSync(markerPath, JSON.stringify({
    at: nowMs,
    reason: health.reachable ? 'unhealthy' : 'health_unreachable',
  }));
  return { kind: 'stale_relaunch', bridgePid, health };
}

module.exports = {
  BUDGET_MARKER,
  BUDGET_MAX,
  BUDGET_WINDOW_MIN,
  ESCALATE_COOLDOWN_MIN,
  STALE_COOLDOWN_MIN,
  STALE_MARKER,
  UNHEALTHY_ESCALATE_MIN,
  defaultProcessApi,
  readCooldown,
  superviseBridgeProcess,
};
