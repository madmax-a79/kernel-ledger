#!/usr/bin/env node
// Append one line to a top-level array of ledger.json, commit it and push.
//
//   node scripts/append.mjs <array> <file.json> [--dry-run] [--operator]
//
//   <array>      entries | interventions | manipulation | amendments | audits
//   <file.json>  a UTF-8 file holding exactly one JSON object
//   --dry-run    check it against the latest main and print what would be committed; change nothing
//   --operator   needed for the operator's and Controller's lines: interventions, amendments,
//                audits, Controller checks and retractions. Kernel never passes it.
//
// Existing lines are never touched: the object is inserted as text just before the array's
// closing bracket, so the commit diff shows only the new line. New receipt files named in
// "receipts" (receipts/<name>.jpg etc.) are committed with it. Dates are Vancouver calendar
// dates. If someone else pushed first, it re-applies on top and retries.

import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const FILE = 'ledger.json';
const MAX_DEPTH = 32;
const ATTEMPTS = 3;
const OPERATOR_ONLY = ['interventions', 'amendments', 'audits'];

// ---- Ledger rules. The same block is in scripts/append.mjs and in the append-only guard
// ---- (.github/workflows/append-only-guard.yml); change both together.
const ARRAYS = ['entries', 'interventions', 'manipulation', 'amendments', 'audits'];
const TYPES = ['buy', 'sell', 'pass', 'correction', 'death', 'reload', 'note', 'check'];
const STATUSES = ['verified', 'flagged'];
// Numbers the page does arithmetic with, and the lowest value each may take.
const NUMBERS = { trade: 1, amount_cad: 0, fx_usd_per_cad: 0, amount_usd: 0, net_usd: -Infinity, est_value_usd: 0, fees_usd: 0, shipping_usd: 0, hours: 0, km: 0 };
// What each log line on the page shows; without these the line renders blank.
const LOG_FIELDS = { interventions: ['date', 'kind', 'detail'], manipulation: ['date', 'channel', 'summary'], amendments: ['version', 'date', 'summary'], audits: ['date', 'note'] };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
// Photos, screenshots and PDFs only: nothing a browser would run on the ledger's own site.
const RECEIPT = /^receipts\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif|heic|pdf)$/;
// Control characters other than tab and newline, and bidirectional overrides.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const text = (v) => typeof v === 'string' && v.trim() !== '';
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
const isUrl = (s) => typeof s === 'string' && /^https?:\/\/[^\s\\/?#]+\.[^\s\\/?#]+([/?#][^\s\\]*)?$/i.test(s);

// Deep equality of parsed JSON; iterative, so no nesting can overflow the stack.
function same(a, b) {
  const todo = [[a, b]];
  while (todo.length) {
    const [x, y] = todo.pop();
    if (x === y) continue;
    if (typeof x !== 'object' || typeof y !== 'object' || x === null || y === null || Array.isArray(x) !== Array.isArray(y)) return false;
    const kx = Object.keys(x);
    if (kx.length !== Object.keys(y).length) return false;
    for (const k of kx) {
      if (!Object.hasOwn(y, k)) return false;
      todo.push([x[k], y[k]]);
    }
  }
  return true;
}

// Nesting depth of a parsed value, and every string (keys included) in it; both iterative.
function shape(v) {
  let depth = 0;
  const found = [], todo = [[v, 0]];
  while (todo.length) {
    const [x, d] = todo.pop();
    if (typeof x === 'string') found.push(x);
    else if (x && typeof x === 'object') {
      depth = Math.max(depth, d + 1);
      for (const [k, y] of Object.entries(x)) { if (!Array.isArray(x)) found.push(k); todo.push([y, d + 1]); }
    }
  }
  return { depth, strings: found };
}

// The calendar date in Vancouver, where the operator's clock runs, `days` from now.
function vancouverDate(days = 0) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Date.now() + days * 86400000)).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

// Everything wrong with appending obj to ledger[array]; empty when it may be appended.
function problems(array, obj, ledger, latestDate) {
  const out = [];
  const say = (p) => out.push(p);
  if (!isObject(obj)) return ['it is not a JSON object'];
  const { depth, strings } = shape(obj);
  if (depth > 8) return [`it is nested ${depth} levels deep; a ledger line needs at most 8`];
  const need = (k) => { if (!text(obj[k])) say(`missing "${k}" (text)`); };
  const meta = isObject(ledger.meta) ? ledger.meta : {};
  const items = ledger[array].filter(isObject);
  if (obj.id != null && !(typeof obj.id === 'string' && ID.test(obj.id))) say('"id" may use letters, digits, ".", "_" and "-" (at most 40), e.g. E001');

  if (array === 'entries') {
    ['id', 'type', 'date'].forEach(need);
    const byId = new Map(items.map((e) => [String(e.id).toLowerCase(), e]));
    const count = (t) => items.filter((e) => e.type === t).length;
    const lives = Number(meta.lives_total || 3), startUsd = Number(meta.start_usd || 10);
    const num = (k) => { if (typeof obj[k] !== 'number') say(`missing "${k}" (number)`); };
    const ref = (k, types) => {
      if (!text(obj[k])) { say(`missing "${k}"`); return null; }
      const e = byId.get(obj[k].toLowerCase());
      if (!e || e.id !== obj[k]) { say(`"${k}": no entry with id ${JSON.stringify(obj[k])}`); return null; }
      if (types && !types.includes(e.type)) { say(`"${k}": ${e.id} is a ${e.type}, not a ${types.join(' or ')}`); return null; }
      if (isDate(e.date) && isDate(obj.date) && obj.date < e.date) say(`dated before ${e.id} (${e.date}), which it refers to`);
      return e;
    };
    if (typeof obj.id === 'string' && byId.has(obj.id.toLowerCase())) say(`an entry with id ${JSON.stringify(byId.get(obj.id.toLowerCase()).id)} already exists`);
    if (text(obj.type) && !TYPES.includes(obj.type)) say(`"type" must be one of: ${TYPES.join(', ')}`);
    switch (obj.type) {
      case 'buy':
        num('net_usd'); num('est_value_usd');
        if (obj.net_usd > 0) say('a buy spends cash, so "net_usd" must be 0 or negative');
        break;
      case 'sell': {
        num('net_usd');
        const buy = ref('closes', ['buy']);
        if (buy && items.some((e) => e.type === 'sell' && e.closes === buy.id)) say(`"closes": ${buy.id} was already sold`);
        break;
      }
      case 'correction':
        ref('corrects');
        break;
      case 'death':
        if (count('death') > count('reload')) say('already dead: the next life starts with a reload');
        if (count('death') >= lives) say(`all ${lives} lives are used`);
        break;
      case 'reload':
        if (obj.net_usd !== startUsd) say(`a reload carries "net_usd": ${startUsd}`);
        if (count('reload') >= count('death')) say('a reload needs a death entry first');
        if (count('death') >= lives) say(`all ${lives} lives are used`);
        break;
      case 'check':
        ref('checks', TYPES.filter((t) => t !== 'check'));
        need('status');
        if (text(obj.status) && !STATUSES.includes(obj.status)) say(`"status" must be one of: ${STATUSES.join(', ')}`);
        break;
    }
    for (const [k, min] of Object.entries(NUMBERS)) {
      if (obj[k] == null) continue;
      if (typeof obj[k] !== 'number' || !Number.isFinite(obj[k])) say(`"${k}" must be a number`);
      else if (obj[k] < min) say(`"${k}" must be at least ${min}`);
    }
    const lastTrade = Math.max(0, ...items.map((e) => (Number.isInteger(e.trade) ? e.trade : 0)));
    if (obj.trade != null && !(Number.isInteger(obj.trade) && obj.trade <= lastTrade + 1)) say(`"trade" must be a whole number no higher than ${lastTrade + 1}`);
    if (obj.comps != null && !(Array.isArray(obj.comps) && obj.comps.every(isUrl))) say('"comps" must be a list of http(s) links');
    if (obj.listing != null && !isUrl(obj.listing)) say('"listing" must be an http(s) link');
    if (obj.memo != null && !isObject(obj.memo)) say('"memo" must be an object');
    if (obj.receipts != null && !(Array.isArray(obj.receipts) && obj.receipts.every((r) => isUrl(r) || (typeof r === 'string' && RECEIPT.test(r))))) {
      say('"receipts" must be http(s) links or receipts/<name>.jpg, .jpeg, .png, .webp, .gif, .heic or .pdf');
    }
    if (isDate(obj.date) && isDate(meta.start_date) && obj.date < meta.start_date) say(`"date" is before the start date ${meta.start_date}`);
  } else if (obj.retracts != null) {
    // An operator line that retracts an earlier line of the same log, which stays visible, struck out.
    need('date'); need('reason');
    const target = Number.isInteger(obj.retracts) ? ledger[array][obj.retracts] : undefined;
    if (!isObject(target) || target.retracts != null) say(`"retracts" must be the position (0 = first) of an existing ${array} line`);
    else if (items.some((x) => x.retracts === obj.retracts)) say(`${array}[${obj.retracts}] is already retracted`);
  } else {
    LOG_FIELDS[array].forEach(need);
    if (array === 'amendments' && text(obj.version) && !/^\d+(\.\d+)*$/.test(obj.version)) say('"version" is written like "1.1", without a "v"');
    if (array === 'amendments' && items.some((x) => String(x.version) === String(obj.version))) say(`amendment v${obj.version} already exists`);
    if (array === 'audits' && obj.week != null && !(Number.isInteger(obj.week) && obj.week >= 0)) say('"week" must be a whole number');
    else if (array === 'audits' && obj.week != null && items.some((x) => x.week === obj.week)) say(`the audit note for week ${obj.week} already exists`);
    if (items.some((x) => same(x, obj))) say(`this exact line is already in ${array}`);
  }
  if (array !== 'entries' && obj.id != null && items.some((x) => x.id === obj.id)) say(`${array} already has id ${JSON.stringify(obj.id)}`);
  if (obj.date != null && !isDate(obj.date)) say('"date" must be a real date written YYYY-MM-DD');
  else if (isDate(obj.date) && obj.date > latestDate) say(`"date" ${obj.date} is in the future (latest allowed ${latestDate}, Vancouver time)`);
  if (strings.some((s) => HIDDEN.test(s))) say('text contains control or bidirectional-override characters');
  return out;
}
// Duplicate keys per object (so a second "entries" can't hide behind the first) and nesting depth.
function scan(src) {
  const stack = [], dups = [];
  let deepest = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      let k = j + 1;
      while (/\s/.test(src[k])) k++;
      const top = stack[stack.length - 1];
      if (top && src[k] === ':') {
        const key = JSON.parse(src.slice(i, j + 1));
        if (top.has(key)) dups.push(key);
        top.add(key);
      }
      i = j;
    } else if (c === '{' || c === '[') {
      stack.push(c === '{' ? new Set() : null);
      deepest = Math.max(deepest, stack.length);
    } else if (c === '}' || c === ']') stack.pop();
  }
  return { dups: [...new Set(dups)], deepest };
}
// ---- end of ledger rules

class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };

let root;
function gitRaw(...args) {
  try {
    return execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    e.message = `git ${args.join(' ')} failed:\n${String(e.stderr || e.message).trim()}`;
    throw e;
  }
}
const git = (...args) => gitRaw(...args).toString('utf8');
const gitOk = (...args) => { try { gitRaw(...args); return true; } catch { return false; } };
const hashOf = (bytes) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: root, input: bytes }).toString().trim();

function decode(buf, where) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); }
  catch { fail(`${where} is not valid UTF-8`); }
}
const parseLedger = (src) => {
  try { return JSON.parse(src.replace(/^﻿/, '')); } catch (e) { fail(`${FILE} is not valid JSON: ${e.message}`); }
};

// Offsets of the '[' and ']' of a top-level array, found by scanning the raw text.
function locate(src, key) {
  let depth = 0, hit = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      if (depth === 1) {
        let k = j + 1;
        while (/\s/.test(src[k])) k++;
        if (src[k] === ':' && JSON.parse(src.slice(i, j + 1)) === key) {
          if (hit) fail(`${FILE} has "${key}" twice; fix that by hand first`);
          k++;
          while (/\s/.test(src[k])) k++;
          if (src[k] !== '[') fail(`"${key}" in ${FILE} is not an array`);
          hit = { keyStart: i, open: k, close: -1 };
        }
      }
      i = j;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (hit && hit.close < 0 && depth === 1 && i > hit.open) hit.close = i;
    }
  }
  if (!hit) fail(`${FILE} has no top-level "${key}" array`);
  return hit;
}

// The new file text: the old text with the object inserted before the array's closing bracket.
function insert(src, key, obj) {
  const { keyStart, open, close } = locate(src, key);
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const keyIndent = /^[ \t]*/.exec(src.slice(src.lastIndexOf('\n', keyStart) + 1, keyStart))[0];
  const unit = keyIndent || '  ';
  const itemIndent = keyIndent + unit;
  const body = JSON.stringify(obj, null, unit.startsWith('\t') ? '\t' : unit.length).replace(/\n/g, eol + itemIndent);
  const inner = src.slice(open + 1, close);
  if (inner.trim() === '') return src.slice(0, open + 1) + eol + itemIndent + body + eol + keyIndent + src.slice(close);
  const end = open + 1 + inner.trimEnd().length;
  return src.slice(0, end) + ',' + eol + itemIndent + body + src.slice(end);
}

// The new text, checked: existing content unchanged, and within the guard's limits.
function build(src, ledger, array, obj) {
  const next = insert(src, array, obj);
  if (!same(parseLedger(next), { ...ledger, [array]: [...ledger[array], obj] })) fail('internal check failed: the edit would change existing content; nothing written');
  const { dups, deepest } = scan(next.replace(/^﻿/, ''));
  if (dups.length) fail(`the line repeats a key: ${dups.join(', ')}`);
  if (deepest > MAX_DEPTH) fail(`the line is nested more than ${MAX_DEPTH} levels deep`);
  return next;
}

// Receipt files named in the line: exact names on disk, regular files, never replacing one.
function receiptFiles(obj) {
  const problems = [], add = [];
  const tracked = git('ls-tree', '-r', '--name-only', 'HEAD', '--', 'receipts/').split('\n').filter(Boolean);
  let onDisk = [];
  try { onDisk = readdirSync(path.join(root, 'receipts')); } catch { /* no folder yet */ }
  for (const r of Array.isArray(obj.receipts) ? obj.receipts : []) {
    if (typeof r !== 'string' || !RECEIPT.test(r)) continue;
    if (tracked.includes(r)) {
      if (!gitOk('diff', '--quiet', 'HEAD', '--', r)) problems.push(`receipt ${r} is already committed and the file on disk differs; receipts are never replaced, use a new name`);
      continue;
    }
    if (tracked.some((t) => t.toLowerCase() === r.toLowerCase())) { problems.push(`receipt ${r} differs only in case from the committed ${tracked.find((t) => t.toLowerCase() === r.toLowerCase())}`); continue; }
    if (!onDisk.includes(path.basename(r))) { problems.push(`receipt ${r} not found (names are case-sensitive); put the file in receipts/ first`); continue; }
    if (!lstatSync(path.join(root, r)).isFile()) { problems.push(`receipt ${r} must be a regular file, not a folder or link`); continue; }
    if (gitOk('check-ignore', '-q', '--', r)) { problems.push(`receipt ${r} is ignored by .gitignore`); continue; }
    add.push(r);
  }
  return { problems, add };
}

// One-line commit subject from checked fields, never carrying CI-skip markers.
function message(array, obj) {
  const clip = (s, n = 60) => {
    const t = [...String(s).replace(/\[\s*(skip|no)[\s-]*(ci|actions)\s*\]|\[\s*(ci|actions)[\s-]*skip\s*\]|skip-checks\s*:/gi, '').replace(/\s+/g, ' ').trim()];
    return t.length > n ? t.slice(0, n - 1).join('') + '…' : t.join('');
  };
  const id = obj.id != null ? obj.id + ' ' : '';
  if (obj.retracts != null) return `${id}retract ${array}[${obj.retracts}]`;
  switch (array) {
    case 'entries':
      if (obj.type === 'check') return `${id}check ${obj.checks} ${obj.status}`;
      return `${id}${obj.type}` + (obj.item || obj.title ? ` ${clip(obj.item || obj.title)}` : '');
    case 'interventions': return `${id}intervention ${obj.date} ${clip(obj.kind, 40)}`;
    case 'manipulation': return `${id}manipulation attempt ${obj.date} ${clip(obj.channel, 40)}`;
    case 'amendments': return `${id}amendment v${obj.version}`;
    case 'audits': return `${id}audit note ${obj.week != null ? 'week ' + obj.week : obj.date}`;
  }
}

const fetchMain = () => git('fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main');

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  const [array, input] = args;
  if (args.length !== 2 || !ARRAYS.includes(array) || [...flags].some((f) => !['--dry-run', '--operator'].includes(f))) {
    fail(`usage: node scripts/append.mjs <${ARRAYS.join('|')}> <file.json> [--dry-run] [--operator]`);
  }

  let obj;
  try { obj = JSON.parse(decode(readFileSync(path.resolve(input)), input).replace(/^﻿/, '')); }
  catch (e) { if (e instanceof Stop) throw e; fail(`cannot read ${input}: ${e.message}`); }
  if (!isObject(obj)) fail(`${input} must hold one JSON object`);
  if (!flags.has('--operator') && (OPERATOR_ONLY.includes(array) || obj.type === 'check' || obj.retracts != null)) {
    fail(`${obj.retracts != null ? 'retractions' : obj.type === 'check' ? 'Controller checks' : array} are appended by the operator, not Kernel (the operator adds --operator)`);
  }

  try { root = path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()); }
  catch { fail('run this inside the ledger repo'); }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  if (branch !== 'main') fail(`on branch "${branch}"; switch to main first`);

  if (flags.has('--dry-run')) {
    // Check against the latest main without touching the checkout.
    let where = 'origin/main';
    try { fetchMain(); } catch { where = 'local HEAD (could not fetch origin)'; }
    const src = decode(gitRaw('cat-file', 'blob', `${where === 'origin/main' ? 'origin/main' : 'HEAD'}:${FILE}`), FILE);
    const ledger = parseLedger(src);
    for (const k of ARRAYS) if (!Array.isArray(ledger[k])) fail(`${FILE} has no "${k}" array`);
    const receipts = receiptFiles(obj);
    const found = [...problems(array, obj, ledger, vancouverDate(0)), ...receipts.problems];
    if (found.length) fail(`would not append to ${array}:\n  - ${found.join('\n  - ')}`);
    build(src, ledger, array, obj);
    console.log(`OK (dry run against ${where}) — would append to ${array} and commit:\n  ${message(array, obj)}`);
    if (receipts.add.length) console.log(`  with ${receipts.add.join(', ')}`);
    return;
  }

  // One append at a time per checkout. The lock names its owner so a crashed run's lock is reclaimed.
  const lock = path.join(git('rev-parse', '--absolute-git-dir').trim(), 'ledger-append.lock');
  const token = `${process.pid} ${hostname()} ${Date.now()}`;
  let fd;
  for (let tries = 0; fd === undefined; tries++) {
    try { fd = openSync(lock, 'wx'); } catch {
      let owner = '';
      try { owner = readFileSync(lock, 'utf8'); } catch { continue; }
      const [pid, host] = owner.split(' ');
      let alive = true;
      if (host === hostname()) { try { process.kill(Number(pid), 0); } catch (e) { alive = e.code === 'EPERM'; } }
      if (alive || tries > 2) fail(`another append is running (process ${pid} on ${host}); wait for it to finish`);
      try { unlinkSync(lock); } catch { /* raced */ }
    }
  }
  writeFileSync(fd, token);
  closeSync(fd);
  // Signals wait until this synchronous run ends, so an interrupted append still finishes or undoes cleanly.
  const received = [];
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => received.push(s));
  try {
    appendLocked(array, obj);
  } finally {
    try { if (readFileSync(lock, 'utf8') === token) unlinkSync(lock); } catch { /* already gone */ }
    if (received.length) console.error(`(received ${received.join(', ')}; finished the append first)`);
  }
}

function appendLocked(array, obj) {
  const ledgerPath = path.join(root, FILE);
  for (let attempt = 1; ; attempt++) {
    fetchMain();
    const ahead = Number(git('rev-list', '--count', 'origin/main..HEAD').trim());
    if (ahead) fail(`local main has ${ahead} commit(s) that are not on origin (an append whose push failed?). Publish with "git push origin main" or drop with "git reset --keep origin/main", then run this again`);
    // A receipt someone else already committed with the same bytes is theirs to bring in.
    for (const r of Array.isArray(obj.receipts) ? obj.receipts.filter((x) => typeof x === 'string' && RECEIPT.test(x)) : []) {
      if (gitOk('cat-file', '-e', `HEAD:${r}`) || !gitOk('cat-file', '-e', `origin/main:${r}`)) continue;
      let mine = null;
      try { mine = hashOf(readFileSync(path.join(root, r))); } catch { continue; }
      if (mine !== git('rev-parse', `origin/main:${r}`).trim()) fail(`receipt ${r} was just committed by someone else with different content; rename yours`);
      unlinkSync(path.join(root, r));
    }
    git('merge', '--ff-only', '--quiet', 'origin/main');
    const start = git('rev-parse', 'HEAD').trim();

    // Build from the committed ledger, and refuse if the file on disk differs from it.
    const committed = gitRaw('cat-file', 'blob', `HEAD:${FILE}`);
    if (!readFileSync(ledgerPath).equals(committed)) fail(`${FILE} on disk differs from the committed file; restore it ("git checkout -- ${FILE}") first`);
    const src = decode(committed, FILE);
    const ledger = parseLedger(src);
    for (const k of ARRAYS) if (!Array.isArray(ledger[k])) fail(`${FILE} has no "${k}" array`);

    const receipts = receiptFiles(obj);
    const found = [...problems(array, obj, ledger, vancouverDate(0)), ...receipts.problems];
    if (found.length) fail(`not appended to ${array}:\n  - ${found.join('\n  - ')}`);
    const next = build(src, ledger, array, obj);
    const msg = message(array, obj);

    // On a failure before the push, leave the checkout as it was; receipt files stay on disk.
    let madeCommit = false;
    const undo = () => {
      const steps = [
        () => madeCommit && git('reset', '--quiet', '--soft', start),
        () => git('restore', '--staged', '--worktree', '--', FILE),
        () => receipts.add.length && git('restore', '--staged', '--', ...receipts.add),
      ];
      for (const step of steps) { try { step(); } catch (e) { console.error(`(cleanup) ${e.message}`); } }
    };
    try {
      if (receipts.add.length) git('add', '--', ...receipts.add);
      writeFileSync(ledgerPath, next);
      git('commit', '--quiet', '--only', '-m', msg, '--', FILE, ...receipts.add);
      madeCommit = true;
      if (git('rev-parse', 'HEAD~1').trim() !== start || git('rev-parse', `HEAD:${FILE}`).trim() !== hashOf(Buffer.from(next))) {
        fail('the commit does not match the prepared ledger (a hook, a line-ending setting or another process changed it); undone');
      }
    } catch (e) {
      undo();
      if (e instanceof Stop) throw e;
      fail(`commit failed; nothing was appended:\n${e.message}`);
    }

    try {
      git('push', '--quiet', 'origin', 'HEAD:main');
      console.log(`Appended to ${array} and pushed: ${msg}`);
      return;
    } catch (e) {
      // The server may have taken the push even though this side saw an error.
      let fetched = true;
      try { fetchMain(); } catch { fetched = false; }
      if (fetched && gitOk('merge-base', '--is-ancestor', 'HEAD', 'origin/main')) {
        console.log(`Appended to ${array} and pushed: ${msg} (the push reported an error, but main has the commit)`);
        return;
      }
      if (!fetched) {
        fail(`push result unknown (could not reach origin); the commit is kept locally. Do not append this line again: run this command again later and it will say whether main has it.\n${e.message}`);
      }
      undo();
      // Retry only when another push got there first, never for hook, ruleset or permission refusals.
      if (attempt < ATTEMPTS && /\[rejected\][^\n]*\((fetch first|non-fast-forward)\)|\[remote rejected\][^\n]*\((incorrect old value provided|cannot lock ref[^)]*)\)/.test(e.message)) {
        console.error(`main moved while appending; retrying (${attempt + 1}/${ATTEMPTS})`);
        continue;
      }
      fail(`push failed; nothing was appended:\n${e.message}`);
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Stop || e.stderr != null ? e.message : e.stack);
  process.exit(1);
}
