// The hash-chained call log shared by Kernel's API scripts (ebay.mjs, dealwork.mjs) and read by the Controller's
// checks (earncheck.mjs). Each line is {n, at, actor, cmd, ...entry, prev, h}: n counts from 1, prev is the line
// before's h (64 zeros for the first), and h is the SHA-256 of the line without h. An edited, inserted or reordered
// line breaks the chain, which verifyLog reports. Lines cut off the end leave a shorter chain that still verifies, so
// the Controller notes the last line's n and h each time it reads the log and checks them next time
// (dealwork.mjs log --from <n> --hash <h>).

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

export const GENESIS = '0'.repeat(64);
export class LogError extends Error {}

const sha = (s) => createHash('sha256').update(s).digest('hex');
export const lineHash = (obj) => { const { h, ...rest } = obj; return sha(JSON.stringify(rest)); };

// Every line of the log, parsed. A line that isn't a JSON object comes back as {n, broken: true, raw}, with the
// first 200 characters of what is there.
export function readLog(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    let v;
    try { v = JSON.parse(l); } catch { v = null; }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { n: i + 1, broken: true, raw: l.slice(0, 200) };
  });
}

// The first problem in the chain, or null when every line is intact and in place.
export function verifyLog(lines) {
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const x = lines[i];
    if (x.broken) return `line ${i + 1} is not a JSON object`;
    if (x.n !== i + 1) return `line ${i + 1} says it is line ${x.n}`;
    if (x.prev !== prev) return `line ${i + 1} does not follow line ${i}`;
    if (x.h !== lineHash(x)) return `line ${i + 1} was changed after it was written`;
    prev = x.h;
  }
  return null;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function acquire(lock, staleMs, what) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); return; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > staleMs) { unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new LogError(`${what} is locked (${lock}); if no other script is running, delete that file`);
      sleep(50);
    }
  }
}
const release = (lock) => { try { unlinkSync(lock); } catch {} };

function withLock(path, fn) {
  const lock = path + '.lock';
  acquire(lock, 30000, 'the call log');
  try { return fn(); } finally { release(lock); }
}

// Runs an async step while holding a lock file next to the log (`<log>.<name>.lock`), so two runs of a script can't
// interleave it: for example two bids, each checking the daily cap before the other has logged its bid.
export async function exclusive(path, name, fn, staleMs = 120000) {
  const lock = `${path}.${name}.lock`;
  acquire(lock, staleMs, `another ${name}`);
  try { return await fn(); } finally { release(lock); }
}

// Appends one line; throws (LogError, or the file system's error) if it can't. A line containing any of `secrets`
// is refused, so a credential never reaches the log.
export function appendLine(path, { actor, cmd, secrets = [] }, entry) {
  withLock(path, () => {
    const lines = readLog(path);
    const last = lines[lines.length - 1];
    const line = { n: lines.length + 1, at: new Date().toISOString(), actor, cmd, ...entry, prev: last ? last.h : GENESIS };
    line.h = lineHash(line);
    const encoded = JSON.stringify(line);
    if (secrets.some((s) => typeof s === 'string' && s.length >= 8 && encoded.includes(s))) throw new LogError('refusing to write a call log line that contains a credential');
    appendFileSync(path, encoded + '\n');
  });
}

// Who is running the script: the clone's git user, else the OS user.
export function actor() {
  try { return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || userInfo().username; } catch { return userInfo().username; }
}
