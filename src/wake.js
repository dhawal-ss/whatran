import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DIR } from './baseline.js';

// Guard against waking the agent about the same thing forever.
//
// A synchronous Stop hook is protected by the harness: Claude Code sets
// `stop_hook_active` and gives up after a run of consecutive blocks. A
// background hook that wakes the agent is a different mechanism, and whether
// that counter covers it is not documented. Since a hook that fires every turn
// with an instruction the agent cannot satisfy is one of the nastiest failure
// modes there is, whatran keeps its own count rather than relying on someone
// else's.
//
// The count is per set of findings: fix one thing and the count resets, because
// that is progress. Say the same thing three times with nothing changing and it
// stops talking, because at that point the agent cannot act on it and the
// person needs to see it instead.
const FILE = 'wake.json';
const LIMIT = 3;

function wakePath(projectDir) {
  return path.join(projectDir, DIR, FILE);
}

export function fingerprintFindings(findings) {
  const parts = findings
    .map((f) => `${f.code}:${[...f.evidence].sort().join(',')}`)
    .sort();
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

function read(projectDir) {
  try { return JSON.parse(fs.readFileSync(wakePath(projectDir), 'utf8')); } catch { return null; }
}

function write(projectDir, doc) {
  try {
    fs.mkdirSync(path.join(projectDir, DIR), { recursive: true });
    const p = wakePath(projectDir);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    fs.renameSync(tmp, p);
  } catch { /* the guard is best-effort; never break a run over it */ }
}

// Returns { allowed, attempt }. `allowed` is false once the same findings have
// been raised LIMIT times without changing.
export function shouldWake(projectDir, findings) {
  const fingerprint = fingerprintFindings(findings);
  const prev = read(projectDir);
  const attempt = prev && prev.fingerprint === fingerprint ? (prev.count ?? 0) + 1 : 1;
  write(projectDir, { fingerprint, count: attempt, at: new Date().toISOString() });
  return { allowed: attempt <= LIMIT, attempt, limit: LIMIT };
}

// Called when a run comes back clean, so the next real finding starts fresh.
export function clearWake(projectDir) {
  try { fs.rmSync(wakePath(projectDir), { force: true }); } catch { /* ignore */ }
}

export const __test = { LIMIT };

// Only one background check at a time.
//
// A blocking hook cannot overlap with itself: the turn waits. A background one
// can, and on a repo whose suite takes minutes a few quick turns would start
// several full suite runs at once and bring the machine to its knees. The
// second and later arrivals simply stand down; the one already running will
// report on a newer tree anyway.
const LOCK = 'check.lock';
const STALE_LOCK_MS = 30 * 60 * 1000;

export function acquireLock(projectDir) {
  const file = path.join(projectDir, DIR, LOCK);
  try {
    fs.mkdirSync(path.join(projectDir, DIR), { recursive: true });
    const existing = readLock(file);
    if (existing && Date.now() - existing.at < STALE_LOCK_MS && isAlive(existing.pid)) {
      return null;
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
    // Re-read: if another process won the race, stand down.
    const now = readLock(file);
    if (!now || now.pid !== process.pid) return null;
    return () => { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } };
  } catch {
    // If the lock cannot be taken at all, run anyway rather than going silent.
    return () => {};
  }
}

function readLock(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// A lock left behind by a killed process must not block every future run.
function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
