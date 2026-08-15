'use strict';
// run-lock.cjs — atomic, owner-checked, stale-reaping run lock. Ported verbatim.
//
// Three properties that each cost a production incident:
//  1. ATOMIC ACQUIRE. `fs.openSync(file, 'wx')` either creates the lock or throws EEXIST.
//     A read-then-write check races with itself when several scheduler and recovery
//     signals arrive together after wake.
//  2. OWNER-CHECKED RELEASE. Release only if the file still names OUR pid AND token.
//     Otherwise a slow run deletes the lock a newer run legitimately holds.
//  3. STALE REAPING. A crashed run must not wedge the lane forever — but only reap a lock
//     whose owner pid is genuinely gone AND which is older than staleMs.
//
// PLACEMENT MATTERS: keep the lock file OUTSIDE any directory that prep wipes. In the
// source system the lock lived inside the work dir, and prep's rmSync deleted it MID-RUN,
// letting a second tick overlap the first.

const crypto = require('crypto');
const fs = require('fs');

function parseOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      pid: Number(parsed.pid || 0),
      token: String(parsed.token || ''),
      startedAt: String(parsed.startedAt || ''),
    };
  } catch {
    return { pid: Number(String(raw || '').trim()) || 0, token: '', startedAt: '' };
  }
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — still alive.
    return error?.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const stat = fs.statSync(file);
    return { ...parseOwner(fs.readFileSync(file, 'utf8')), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function acquireRunLock(file, {
  staleMs = 30 * 60 * 1000,
  nowMs = Date.now(),
  pid = process.pid,
  pidAlive = defaultPidAlive,
} = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomUUID();
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({
        pid,
        token,
        startedAt: new Date(nowMs).toISOString(),
      }));
      fs.closeSync(fd);
      return { acquired: true, file, pid, token };
    } catch (error) {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (error?.code !== 'EEXIST') throw error;
      const owner = readLock(file);
      const active = owner?.pid ? pidAlive(owner.pid) : false;
      const stale = !owner || nowMs - owner.mtimeMs >= staleMs;
      if (active || !stale) return { acquired: false, file, owner };
      try {
        fs.unlinkSync(file);
      } catch {
        return { acquired: false, file, owner };
      }
    }
  }
  return { acquired: false, file, owner: readLock(file) };
}

function releaseRunLock(lock) {
  if (!lock?.acquired) return false;
  try {
    const owner = readLock(lock.file);
    if (!owner || owner.token !== lock.token || owner.pid !== lock.pid) return false;
    fs.unlinkSync(lock.file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  acquireRunLock,
  defaultPidAlive,
  parseOwner,
  readLock,
  releaseRunLock,
};
