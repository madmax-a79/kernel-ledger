#!/usr/bin/env node
// The Controller's check of Kernel's earn lines (Rule 26). Read-only: it writes nothing, commits nothing and never
// calls a marketplace.
//
//   node scripts/earncheck.mjs [--ledger ledger.json] [--calllog <path>]
//
// For every earn line in the published ledger (main on GitHub; --ledger checks a local file instead), it flags:
// - a category that isn't one of Rule 26's five eligible kinds;
// - price minus fee not equal to net, or net_usd not equal to net (USD) or to net x fx_usd_per_cad to the cent (CAD);
// - a CAD payout without an fx_date, or whose fx_usd_per_cad isn't 1 / the Bank of Canada's USD/CAD rate published
//   on that date;
// - no payout receipt file, or one that isn't in the repo. Every receipt that exists (files and links) is listed
//   under "open" so the Controller can confirm the client's identity is covered, which no script can see;
// - a client, customer or buyer field at any depth, in any form (clientName, clientname, BUYER_EMAIL);
// - no id, or no marketplace record before it. In the marketplace call log (WORK_CALL_LOG, or --calllog), a line
//   must link this earn line to a job ({"marketplace": "...", "job": "...", "earn": "W001"}), every line linking it
//   must name that same job, that job must be linked to no other earn line, and the same or an earlier line must
//   record the job's agreed price and funded escrow ({"marketplace": "...", "job": "...", "price": "40.00 USD",
//   "escrow": "funded"}). Only lines with "event": "done" from dealwork.mjs start (the price and funded escrow) and
//   earnings (the link) count, which it writes after its calls succeed; an earn line on any other marketplace is
//   flagged until a script writes its records. Both bots can append to the log, so dealwork.mjs audit checks each
//   record against the marketplace and flags one under any other command or marketplace.
//   "marketplace" must equal the earn line's, and both lines are dated ("at") on or before the earn line's date
//   (Vancouver). scripts/dealwork.mjs writes these lines (start and earnings); until they exist, every earn line is
//   flagged;
// - a price that doesn't match the job's agreed price in that record: the same USD amount for a USD line, or, for a
//   line recorded in CAD as it landed, the USD amount at the line's own fx_usd_per_cad (to the cent).
// Then it prints Challenge Value, Traded and Earned exactly as the ledger page computes them (from index.html in
// this clone, so pull first), for the weekly pack.
//
// Exit status: 0 nothing flagged, 1 something flagged, 2 the check couldn't run.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLog, verifyLog } from './calllog.mjs';

const REPO_RAW = 'https://raw.githubusercontent.com/madmax-a79/kernel-ledger/main/';
const VALET = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json';
// Rule 26's eligible work, in the constitution's words (the same list as the ledger rules).
const CATEGORIES = ['research and summaries', 'data cleanup', 'structured writing and editing', 'code and small automations', 'transcription and translation'];
const CLIENT_WORDS = ['client', 'customer', 'buyer'];
const RECEIPT = /^receipts\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif|heic|pdf)$/i;

class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--ledger', '--calllog'].includes(argv[i]) || argv[i + 1] == null) fail('usage: node scripts/earncheck.mjs [--ledger ledger.json] [--calllog <path>]');
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  return opts;
}

// ---- sources ------------------------------------------------------------------------------------------

function sources(opts) {
  const base = process.env.EARNCHECK_BASE_URL;
  if (base && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) fail('EARNCHECK_BASE_URL may only name a local test server');
  const remote = base ? base + '/' : REPO_RAW;
  return {
    ledgerFile: opts.ledger || null,
    ledgerUrl: remote + 'ledger.json',
    receiptUrl: (p) => remote + p,
    valet: base ? base + '/valet/observations/FXUSDCAD/json' : VALET,
    callLog: opts.calllog || process.env.WORK_CALL_LOG || null,
  };
}

async function get(url, what) {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    return r;
  } catch (e) {
    fail(`could not reach ${what}: ${e.cause?.code || e.message}`);
  }
}

async function loadLedger(src) {
  if (src.ledgerFile) {
    try { return JSON.parse(readFileSync(src.ledgerFile, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { fail(`cannot read ${src.ledgerFile}: ${e.message}`); }
  }
  const r = await get(src.ledgerUrl + `?t=${Date.now()}`, 'GitHub (the published ledger)');
  if (!r.ok) fail(`GitHub answered HTTP ${r.status} for the published ledger`);
  try { return await r.json(); } catch { fail('the published ledger is not valid JSON'); }
}

// The Bank of Canada's USD/CAD rate published on one date, or null when it published none (weekends, holidays).
const rates = new Map();
async function bocRate(src, date) {
  if (!rates.has(date)) {
    const r = await get(`${src.valet}?start_date=${date}&end_date=${date}`, 'the Bank of Canada');
    if (!r.ok) fail(`the Bank of Canada answered HTTP ${r.status}`);
    let body;
    try { body = await r.json(); } catch { fail('the Bank of Canada did not answer with JSON'); }
    const o = body?.observations?.find((x) => x?.d === date);
    const v = Number(o?.FXUSDCAD?.v);
    rates.set(date, v > 0 ? v : null);
  }
  return rates.get(date);
}

async function receiptExists(src, p) {
  if (src.ledgerFile) {
    const f = path.join(path.dirname(path.resolve(src.ledgerFile)), p);
    return existsSync(f) && statSync(f).isFile();
  }
  const r = await get(src.receiptUrl(p), 'GitHub (a receipt)');
  if (r.status === 404) return false;
  if (!r.ok) fail(`GitHub answered HTTP ${r.status} for ${p}, so its presence can't be checked`);
  return true;
}

// ---- the marketplace call log (scripts/calllog.mjs, the same hash chain as the eBay log) ----------------

function readCallLog(file) {
  if (!file) return null;
  if (!existsSync(file)) return { file, lines: [], chain: `no file at ${file}` };
  const lines = readLog(file);
  return { file, lines, chain: verifyLog(lines) || 'intact' };
}

const vancouverDay = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
};

// The one line that links this earn line to one job on its marketplace, and the same or an earlier line recording
// that job's agreed price and funded escrow. A job backs one earn line only.
function marketplaceRecord(log, e) {
  if (!log) return 'no marketplace record: no marketplace call log is set up (WORK_CALL_LOG)';
  if (log.chain !== 'intact') return `no marketplace record can be trusted: the call log ${log.chain}`;
  const onTime = (x) => { const d = vancouverDay(x.at); return d != null && typeof e.date === 'string' && d <= e.date; };
  // Only dealwork.mjs writes records (start: price and funded escrow; earnings: the link), and its audit checks them
  // against dealwork. A record for any other marketplace could only be hand-made, so none can be verified.
  if (e.marketplace !== 'dealwork.ai') return `no marketplace record: no script writes records for ${JSON.stringify(e.marketplace ?? null)}, so none can be verified`;
  const sameMarket = (x) => x.marketplace === e.marketplace;
  const writes = (x, cmd) => x.cmd === cmd;
  const links = log.lines.map((x, i) => [x, i]).filter(([x]) => x.event === 'done' && x.earn === e.id && typeof x.job === 'string' && x.job && sameMarket(x) && writes(x, 'earnings'));
  const jobs = [...new Set(links.map(([x]) => x.job))];
  if (jobs.length > 1) return `marketplace record: ${e.id} is linked to more than one job (${jobs.join(', ')})`;
  const ontime = links.filter(([x]) => onTime(x));
  if (!ontime.length) return `no marketplace record: no call-log line on ${e.marketplace} links ${e.id} to a job on or before ${e.date}`;
  const [[link, at]] = ontime;
  const others = [...new Set(log.lines.filter((x) => x.event === 'done' && x.job === link.job && sameMarket(x) && x.earn != null && x.earn !== e.id).map((x) => x.earn))];
  if (others.length) return `marketplace record: job ${link.job} also backs ${others.join(', ')}; a job backs one earn line`;
  const funded = log.lines.slice(0, at + 1).find((x) => x.event === 'done' && writes(x, 'start') && x.job === link.job && sameMarket(x) && x.escrow === 'funded' && x.price != null && x.price !== '' && onTime(x));
  if (!funded) return `no marketplace record: job ${link.job} has no call-log line with its agreed price and funded escrow before ${e.id}`;
  return { price: funded.price, job: link.job };
}

// The agreed price as recorded ("40.00 USD"), checked against the earn line's price.
function priceFlag(e, agreed) {
  const m = /^(\d+(?:\.\d+)?) (USD|CAD)$/.exec(String(agreed));
  if (!m) return `the marketplace record's price ${JSON.stringify(agreed)} isn't an amount like "40.00 USD"`;
  const [amount, cur] = [Number(m[1]), m[2]];
  if (!isNum(e.price)) return null;
  if (e.currency === cur) return Math.abs(e.price - amount) > 0.005 ? `price ${e.price} ${cur} is not the agreed ${amount.toFixed(2)} ${cur}` : null;
  if (cur === 'USD' && e.currency === 'CAD' && isNum(e.fx_usd_per_cad) && e.fx_usd_per_cad > 0) {
    const want = amount / e.fx_usd_per_cad;
    return Math.abs(e.price - want) > 0.01 ? `price ${e.price} CAD is not the agreed ${amount.toFixed(2)} USD at ${e.fx_usd_per_cad} (${want.toFixed(2)} CAD)` : null;
  }
  return null;
}

// ---- the page's own arithmetic -------------------------------------------------------------------------

function pageComputation() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
  let html;
  try { html = readFileSync(file, 'utf8'); } catch { fail(`cannot read ${file}, whose arithmetic the totals must match`); }
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const numSrc = /const num = [^\n]+/.exec(script)?.[0];
  const start = script.indexOf('function computeState(');
  if (!numSrc || start < 0) fail('cannot find computeState in index.html');
  let depth = 0, end = -1;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) fail('cannot read computeState in index.html');
  return new Function(`${numSrc}\n${script.slice(start, end)}\nreturn computeState;`)();
}

// As the page writes money: sign from the rounded value, thousands separated.
const c2 = (n) => Math.round(Number(n) * 100) / 100;
const usd = (n) => { const r = c2(n); return (r < 0 ? '-' : '') + '$' + Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

// ---- the checks ---------------------------------------------------------------------------------------

// The same test as the ledger rules: a key's letters alone, lookalikes folded and invisible characters dropped.
const flatKey = (k) => String(k).normalize('NFKD').replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '').toLowerCase().replace(/[^a-z]/g, '');
function keysDeep(v) {
  const keys = [], todo = [v];
  while (todo.length) {
    const x = todo.pop();
    if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { if (!Array.isArray(x)) keys.push(k); todo.push(y); }
  }
  return keys;
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

async function checkLine(src, log, e, status) {
  const flags = [];
  const hasId = typeof e.id === 'string' && e.id !== '';
  if (!hasId) flags.push('no id');
  if (!CATEGORIES.includes(e.category)) flags.push(`category ${JSON.stringify(e.category ?? null)} is not one of Rule 26's five`);
  if (![e.price, e.fee, e.net, e.net_usd].every(isNum)) flags.push('price, fee, net and net_usd must all be numbers');
  else {
    if (Math.abs(e.price - e.fee - e.net) > 0.005) flags.push(`price ${e.price} minus fee ${e.fee} is not net ${e.net}`);
    if (e.currency === 'USD' && Math.abs(e.net - e.net_usd) > 0.005) flags.push(`net_usd ${e.net_usd} is not net ${e.net} for a USD payout`);
  }
  if (e.currency !== 'USD' && e.currency !== 'CAD') flags.push(`currency ${JSON.stringify(e.currency ?? null)} is not USD or CAD`);
  if (e.currency === 'CAD') {
    if (typeof e.fx_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.fx_date)) flags.push('a CAD payout has no fx_date');
    else if (!isNum(e.fx_usd_per_cad)) flags.push('a CAD payout has no fx_usd_per_cad');
    else {
      const v = await bocRate(src, e.fx_date);
      if (v == null) flags.push(`the Bank of Canada published no USD/CAD rate on fx_date ${e.fx_date}`);
      else if (Math.abs(e.fx_usd_per_cad - 1 / v) >= 0.00005) flags.push(`fx_usd_per_cad ${e.fx_usd_per_cad} is not the Bank of Canada rate on ${e.fx_date} (1 / ${v} = ${(1 / v).toFixed(5)})`);
      if (isNum(e.net) && isNum(e.net_usd) && Math.abs(e.net * e.fx_usd_per_cad - e.net_usd) > 0.01) flags.push(`net_usd ${e.net_usd} is not net ${e.net} x ${e.fx_usd_per_cad} to the cent`);
    }
  }
  const files = (Array.isArray(e.receipts) ? e.receipts : []).filter((r) => typeof r === 'string' && RECEIPT.test(r));
  if (!files.length) flags.push('no payout receipt file');
  const open = [];
  for (const f of files) {
    if (await receiptExists(src, f)) open.push(f);
    else flags.push(`receipt ${f} is not in the repo`);
  }
  for (const u of Array.isArray(e.receipts) ? e.receipts : []) if (typeof u === 'string' && /^https?:\/\//i.test(u)) open.push(u);
  const named = [...new Set(keysDeep(e).filter((k) => CLIENT_WORDS.some((w) => flatKey(k).includes(w))))];
  if (named.length) flags.push(`client field${named.length > 1 ? 's' : ''} ${named.map((k) => JSON.stringify(k)).join(', ')}`);
  const record = hasId ? marketplaceRecord(log, e) : null;
  if (typeof record === 'string') flags.push(record);
  else if (record) { const p = priceFlag(e, record.price); if (p) flags.push(p); }
  return { id: e.id ?? null, date: e.date ?? null, marketplace: e.marketplace ?? null, category: e.category ?? null, currency: e.currency ?? null, net_usd: e.net_usd ?? null, controller_status: status, flags, open };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const src = sources(opts);
  const computeState = pageComputation();
  const ledger = await loadLedger(src);
  const entries = (Array.isArray(ledger?.entries) ? ledger.entries : fail('the ledger has no entries')).filter((x) => x && typeof x === 'object');
  const log = readCallLog(src.callLog);
  const latest = new Map();
  for (const x of entries) if (x.type === 'check' && x.checks) latest.set(x.checks, x.status);
  const lines = [];
  for (const e of entries.filter((x) => x.type === 'earn')) lines.push(await checkLine(src, log, e, latest.get(e.id) || 'pending'));
  const s = computeState(ledger);
  const flagged = lines.filter((l) => l.flags.length).length;
  return {
    checked_at: new Date().toISOString(),
    ledger: src.ledgerFile || 'published (main on GitHub)',
    call_log: log ? { file: log.file, lines: log.lines.length, chain: log.chain } : null,
    earn_lines: lines.length,
    flagged,
    lines,
    weekly_pack: { challenge_value: usd(s.value), traded: usd(c2(s.value) - c2(s.earned)), earned: usd(s.earned) },
    note: 'Open every receipt under "open" and confirm the client\'s identity is covered; no script can see that.',
  };
}

try {
  const out = await main(process.argv.slice(2));
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.flagged ? 1 : 0);
} catch (e) {
  console.error(e instanceof Stop ? e.message : e.stack);
  process.exit(2);
}
