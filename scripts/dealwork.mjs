#!/usr/bin/env node
// Kernel's dealwork.ai marketplace calls (Rule 26). List-only unless --live, and a bid is sent only with --bid.
//
//   node scripts/dealwork.mjs list                              dry-run: no HTTP
//   node scripts/dealwork.mjs jobs --live                       open jobs (one page)
//   node scripts/dealwork.mjs listings --live                   Kernel's listings and pending listing requests
//   node scripts/dealwork.mjs list --live                       all three reads
//   node scripts/dealwork.mjs jobs --live --bid --job <id> --amount 10.00 --proposal "..."
//   node scripts/dealwork.mjs link --job <id> --earn W001       local call-log line only; no HTTP
//
// There is no auto-bidder, no daemon and no cron. This file never starts openwork-worker.js and never pays to
// obtain work. It does not deliver. Client identity is never written to the call log.
//
// A bid is refused unless all three hold: --bid was passed, the job is one of Rule 26's five kinds, and escrow
// can cover every slot (budgetMax >= fixedPrice * maxConcurrent, posterFunded is true, and the job is not
// blocked). The known failure is budgetMax < fixedPrice * maxConcurrent (the API calls that "underfunded").
// Bid-mode jobs have no fixedPrice and maxConcurrent, so this script cannot show they are funded and will not
// bid on them.
//
// Every marketplace HTTP call is appended to WORK_CALL_LOG before it is sent, and again with its outcome. The
// log is the hash chain scripts/earncheck.mjs already checks. A funded job is logged as
// {"marketplace":"dealwork.ai","job":"…","price":"40.00 USD","escrow":"funded"}. link appends the earn line
// {"marketplace":"dealwork.ai","job":"…","earn":"W001"} only when that funded line is already in the log and the job was marked eligible.
// A deliverable priced in CAD at or below C$25 is marked deliver-without-review; anything else (including
// every USD price, which this platform's wallet uses) is needs-jay-review. Nothing is delivered either way.
//
// Environment:
//   WORK_CALL_LOG            the call log's path, outside the repo, the same file for both bots
//   OPENWORK_CREDENTIALS     default ~/.openwork/credentials.json (baseUrl, apiKey; never printed)
//   DEALWORK_BASE_URL        tests only: http://127.0.0.1 or http://localhost, with a port
//
// Needs Node.js 20 or later and no packages.

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKETPLACE = 'dealwork.ai';
const ORIGIN = 'https://dealwork.ai';
// The platform's wallet is USD and job amounts carry no currency field (skill.md, wallet example).
const PLATFORM_CURRENCY = 'USD';
const GENESIS = '0'.repeat(64);
const PAGE = '/api/v1/jobs?per_page=20&sort=newest';
const LISTINGS = '/api/v1/listings/mine';
const REQUESTS = '/api/v1/listings/requests/pending';
// Rule 26, in the constitution's words. The same five strings as scripts/earncheck.mjs.
const CATEGORIES = ['research and summaries', 'data cleanup', 'structured writing and editing', 'code and small automations', 'transcription and translation'];
const CATEGORY_MAP = {
  research: 'research and summaries',
  writing: 'structured writing and editing',
  documentation: 'structured writing and editing',
  development: 'code and small automations',
  coding: 'code and small automations',
  data: 'data cleanup',
  translation: 'transcription and translation',
  transcription: 'transcription and translation',
};
// Refusals hardcoded from Rule 26, plus scrapers and lead-gen. Checked before a category can match.
const REFUSALS = [
  ['pay-to-obtain-work', /\b(application fee|paywall|buy credits|deposit required|fee to bid|pay to (apply|bid|work|unlock|obtain)|paid application)\b/i],
  ['crypto-or-tokens', /\b(crypto(?:currency)?|bitcoin|ethereum|nft|airdrop|altcoin|memecoin|web3|blockchain|defi|tokenomics|tokens?)\b/i],
  ['scraper', /\b(scrapes?|scrapers?|scraping|web ?crawlers?|crawling)\b/i],
  ['lead-gen', /\b(lead[- ]?gen(?:eration)?|leadgen|cold[- ]email list|email list)\b/i],
  ['licensed-advice', /\b(legal advice|tax advice|medical advice|financial advice|investment advice|legal opinion)\b|\b(lawyer|attorney|physician|diagnos\w*|prescription)\b|\b(file (my |your )?taxes|tax return)\b/i],
  ['academic-assignment', /\b(homework|coursework|take[- ]home exam|do my (essay|assignment|homework)|my assignment|for my class|for a grade)\b/i],
  ['review-or-testimonial', /\b(testimonials?|product reviews?|customer reviews?|write (a |an )?reviews?|fake reviews?|five[- ]star|5[- ]star)\b/i],
  ['impersonation', /\b(impersonat\w*|pretend to be|pose as|catfish)\b/i],
  ['adult', /\b(porn|nsfw|onlyfans|escort|xxx|sexual content|adult content)\b/i],
  ['ongoing-support', /\b(ongoing support|retainer|monthly support|on-call support|continuous support|unlimited revisions)\b/i],
  ['illegal', /\b(illegal|phishing|ransomware|carding|money laundering|stolen cards?|hack into|fake ids?)\b/i],
];
const KIND_PATTERNS = [
  ['transcription and translation', /\b(transcri\w*|translat\w*)\b/i],
  ['data cleanup', /\b(data clean\w*|cleanup|dedup\w*|csv|spreadsheet)\b/i],
  ['code and small automations', /\b(code|script|automation|programming|bugfix|software)\b/i],
  ['research and summaries', /\b(research|summar\w*)\b/i],
  ['structured writing and editing', /\b(writing|edit\w*|proofread\w*|documentation|blog)\b/i],
];
// C$25. Only an explicit CAD price at or below this is deliver-without-review. This script never delivers.
const REVIEW_UNITS = 25 * 10000;
const PRIVATE = 'Dealwork responses are for Kernel and the Controller only. Never commit this output, and never write client identity into the call log or the repo.';
const USAGE = 'usage: node scripts/dealwork.mjs [list|jobs|listings|link] [--live] [--bid --job <id> --amount <n> --proposal "..."] [--job <id> --earn <id>]';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const EARN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };

function parseArgs(argv) {
  const commands = ['jobs', 'listings', 'list', 'link'];
  let cmd = 'list';
  let rest = argv;
  if (argv[0] && !String(argv[0]).startsWith('--')) {
    if (!commands.includes(argv[0])) fail(USAGE);
    cmd = argv[0];
    rest = argv.slice(1);
  }
  const opts = { live: false, bid: false };
  const valued = new Set(['job', 'amount', 'proposal', 'hours', 'earn']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--live') { if (opts.live) fail('--live given twice'); opts.live = true; continue; }
    if (a === '--dry-run') { if (opts.dryRun) fail('--dry-run given twice'); opts.dryRun = true; continue; }
    if (a === '--bid') { if (opts.bid) fail('--bid given twice'); opts.bid = true; continue; }
    const m = /^--([a-z]+)$/.exec(String(a));
    if (!m || !valued.has(m[1]) || rest[i + 1] == null || String(rest[i + 1]).startsWith('--')) fail(`${USAGE}\nunknown or incomplete flag ${a}`);
    if (opts[m[1]] != null) fail(`--${m[1]} given twice`);
    opts[m[1]] = rest[++i];
  }
  if (opts.dryRun && opts.live) fail('pass either --live or --dry-run, not both');
  if (!opts.live) opts.dryRun = true;
  if (cmd === 'link') {
    if (opts.bid || opts.live) fail('link only writes the call log; it does not call the marketplace');
    if (!opts.job || !opts.earn) fail('link needs --job and --earn');
  }
  if (opts.bid && (!opts.job || opts.amount == null || opts.proposal == null)) fail('--bid needs --job, --amount and --proposal');
  return { cmd, opts };
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
function text(v, what, max) {
  const s = String(v).replace(/\r\n?/g, '\n').trim();
  if (!s || s.length > max) fail(`${what} must be 1 to ${max} characters`);
  if (CONTROL.test(s)) fail(`${what} has control characters`);
  return s;
}

// Amounts on the wire use up to 4 decimal places ("15.0000"). Compared as integer 1/10000 units.
function units(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  return Number(w) * 10000 + Number((f + '0000').slice(0, 4));
}
function formatAmount(v) {
  const u = units(v);
  if (u == null) return null;
  const n = u / 10000;
  return u % 100 === 0 ? n.toFixed(2) : n.toFixed(4);
}
function currencyOf(job) {
  if (job.currency == null || job.currency === '') return PLATFORM_CURRENCY;
  return typeof job.currency === 'string' && /^[A-Z]{3}$/.test(job.currency) ? job.currency : null;
}
function priceLabel(amount, currency) {
  const a = formatAmount(amount);
  if (a == null || !currency) return null;
  return `${a} ${currency}`;
}

// ---- Rule 26 ------------------------------------------------------------------------------------------

function blobOf(job) {
  const tags = Array.isArray(job.tags) ? job.tags : [];
  return [job.title, job.description, job.category, job.requirements, ...tags].filter((x) => typeof x === 'string').join('\n');
}

// Eligible only when nothing Rule 26 refuses matches, and the work is one of the five kinds.
export function classify(job) {
  const blob = blobOf(job);
  for (const [code, re] of REFUSALS) if (re.test(blob)) return { eligible: false, category: null, refusal: code };
  const mapped = CATEGORY_MAP[String(job.category || '').toLowerCase()];
  if (mapped && CATEGORIES.includes(mapped)) return { eligible: true, category: mapped, refusal: null };
  const hit = KIND_PATTERNS.find(([, re]) => re.test(blob));
  if (hit && CATEGORIES.includes(hit[0])) return { eligible: true, category: hit[0], refusal: null };
  return { eligible: false, category: null, refusal: 'not-eligible-kind' };
}

// Escrow covers fixedPrice * maxConcurrent. posterFunded false, or any claim block, is not funded.
export function fundedCheck(job) {
  const currency = currencyOf(job);
  const fixed = units(job.fixedPrice);
  const budget = units(job.budgetMax);
  const slots = job.maxConcurrent;
  if (currency !== 'USD' && currency !== 'CAD') return { ok: false, reason: 'price is not fiat USD or CAD' };
  if (fixed == null || budget == null || !Number.isInteger(slots) || slots < 1) return { ok: false, reason: 'no fixedPrice and maxConcurrent to test escrow cover' };
  if (budget < fixed * slots) return { ok: false, reason: 'budgetMax < fixedPrice * maxConcurrent' };
  if (job.posterFunded !== true) return { ok: false, reason: 'posterFunded is not true' };
  if (typeof job.claimBlockedReason === 'string' && job.claimBlockedReason) {
    const reason = /^[a-z0-9_ -]{1,40}$/i.test(job.claimBlockedReason) ? job.claimBlockedReason : 'claim blocked';
    return { ok: false, reason };
  }
  return { ok: true, reason: null };
}

// CAD at or below C$25 may be delivered without review. Every other price needs Jay. This script never delivers.
export function deliveryMark(amount, currency) {
  const u = units(amount);
  if (currency === 'CAD' && u != null && u <= REVIEW_UNITS) return 'deliver-without-review';
  return 'needs-jay-review';
}

export function bidAllowed({ bid, live, eligible, funded }) {
  return bid === true && live === true && eligible === true && funded === true;
}

function viewJob(job) {
  const currency = currencyOf(job);
  const rule = classify(job);
  const funded = fundedCheck(job);
  const amount = job.fixedPrice ?? null;
  return {
    job: typeof job.id === 'string' ? job.id : null,
    mode: job.jobMode ?? null,
    status: job.status ?? null,
    category: rule.category,
    refusal: rule.refusal,
    eligible: rule.eligible,
    funded: funded.ok,
    funded_reason: funded.reason,
    price: priceLabel(amount, currency),
    budget: priceLabel(job.budgetMax, currency),
    slots: Number.isInteger(job.maxConcurrent) ? job.maxConcurrent : null,
    escrow: funded.ok ? 'funded' : 'unfunded',
    delivery: deliveryMark(amount, currency),
    currency,
  };
}

// ---- the call log (the same hash chain as scripts/ebay.mjs and scripts/earncheck.mjs) ----------------

const sha = (s) => createHash('sha256').update(s).digest('hex');
const lineHash = (obj) => { const { h, ...rest } = obj; return sha(JSON.stringify(rest)); };

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { return { n: i + 1, broken: true }; }
  });
}

function verifyLog(lines) {
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const x = lines[i];
    if (x.broken) return `line ${i + 1} is not JSON`;
    if (x.n !== i + 1) return `line ${i + 1} says it is line ${x.n}`;
    if (x.prev !== prev) return `line ${i + 1} does not follow line ${i}`;
    if (x.h !== lineHash(x)) return `line ${i + 1} was changed after it was written`;
    prev = x.h;
  }
  return null;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(file, fn) {
  const lock = file + '.lock';
  const deadline = Date.now() + 10000;
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) { unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) fail(`the call log is locked (${lock}); if no other dealwork.mjs is running, delete that file`);
      sleep(50);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

function assertClean(line, secrets) {
  for (const s of secrets) if (s && line.includes(s)) fail('refusing to write a call log line that contains a credential');
  if (/ak_[A-Za-z0-9]/.test(line)) fail('refusing to write a call log line that contains an API key');
}

function record(ctx, entry) {
  if (!ctx.logPath) fail('set WORK_CALL_LOG (a path outside the repo)');
  withLock(ctx.logPath, () => {
    const lines = readLog(ctx.logPath);
    const problem = verifyLog(lines);
    if (problem) fail(`call log ${problem}; not appending`);
    const last = lines[lines.length - 1];
    const line = { n: lines.length + 1, at: new Date().toISOString(), actor: ctx.actor, cmd: ctx.cmd, marketplace: MARKETPLACE, ...entry, prev: last ? last.h : GENESIS };
    line.h = lineHash(line);
    const encoded = JSON.stringify(line);
    assertClean(encoded, ctx.secrets || []);
    appendFileSync(ctx.logPath, encoded + '\n');
  });
}

function note(ctx, entry, unwritten) {
  try { record(ctx, entry); } catch (e) { fail(`${unwritten}: cannot write the call log ${ctx.logPath} (${e instanceof Stop ? e.message : e.code || e.message})`); }
}

function actor() {
  try { return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || userInfo().username; } catch { return userInfo().username; }
}

// ---- dealwork -----------------------------------------------------------------------------------------

function credentials() {
  const file = process.env.OPENWORK_CREDENTIALS || path.join(homedir(), '.openwork', 'credentials.json');
  let creds;
  try { creds = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail(`cannot read credentials (${e.code || e.message})`); }
  if (!creds || typeof creds !== 'object') fail('credentials file is not a JSON object');
  const apiKey = typeof creds.apiKey === 'string' ? creds.apiKey : '';
  const hmac = typeof creds.hmacSecret === 'string' ? creds.hmacSecret : '';
  const identity = typeof creds.identityKey === 'string' ? creds.identityKey : '';
  if (!apiKey) fail('credentials have no apiKey');
  let base = typeof creds.baseUrl === 'string' ? creds.baseUrl.replace(/\/$/, '') : '';
  const override = process.env.DEALWORK_BASE_URL;
  if (override) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override)) fail('DEALWORK_BASE_URL may only name a local test server');
    base = override;
  } else if (base !== ORIGIN) fail(`credentials baseUrl must be ${ORIGIN}`);
  const secrets = [apiKey, hmac, identity].filter((s) => s.length >= 20);
  return { base, apiKey, secrets };
}

async function send(ctx, method, endpoint, body) {
  if (method !== 'GET' && ctx.allowWrite !== true) fail(`refusing ${method} ${endpoint}: list-only unless --bid has passed its checks`);
  if (!endpoint.startsWith('/api/v1/')) fail(`refusing unexpected endpoint ${endpoint}`);
  const shown = `${method} ${endpoint.split('?')[0]}`;
  note(ctx, { event: 'call', action: ctx.action, endpoint: `${method} ${endpoint}`, method, outcome: 'sending' }, `not sent`);
  let res, text;
  try {
    res = await fetch(ctx.base + endpoint, {
      method,
      headers: { authorization: 'Bearer ' + ctx.apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    text = await res.text();
  } catch (e) {
    note(ctx, { event: 'answer', action: ctx.action, endpoint: shown, method, outcome: 'error', error: e.cause?.code || e.message }, `${shown} failed and its error is not in the call log`);
    fail(`could not reach ${MARKETPLACE}: ${e.cause?.code || e.message}`);
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const code = data?.error?.code;
  const outcome = res.ok ? 'ok' : `http ${res.status}`;
  note(ctx, { event: 'answer', action: ctx.action, endpoint: shown, method, status: res.status, outcome, ...(code ? { error: String(code).slice(0, 40) } : {}) }, `${shown} reached ${MARKETPLACE} (HTTP ${res.status}), but its answer is not in the call log`);
  if (!res.ok) fail(`${shown} answered HTTP ${res.status}${code ? ` ${String(code).slice(0, 40)}` : ''}`);
  return data;
}

function logJob(ctx, view) {
  const entry = {
    event: 'job', action: 'jobs', endpoint: `GET ${PAGE.split('?')[0]}`, job: view.job, outcome: view.eligible ? 'eligible' : 'refused',
    escrow: view.escrow, delivery: view.delivery,
    ...(view.price ? { price: view.price } : {}),
    ...(view.category ? { category: view.category } : {}),
    ...(view.refusal ? { reason: view.refusal } : {}),
    ...(view.funded_reason ? { funded_reason: view.funded_reason } : {}),
  };
  record(ctx, entry);
}

function publicJob(job, view) {
  return {
    job: view.job,
    title: typeof job.title === 'string' ? job.title.slice(0, 140) : null,
    mode: view.mode,
    status: view.status,
    category: view.category,
    refusal: view.refusal,
    eligible: view.eligible,
    funded: view.funded,
    funded_reason: view.funded_reason,
    price: view.price,
    budget: view.budget,
    slots: view.slots,
    escrow: view.escrow,
    delivery: view.delivery,
    currency: view.currency,
  };
}

async function readJobs(ctx) {
  ctx.action = 'jobs';
  const body = await send(ctx, 'GET', PAGE);
  const rows = Array.isArray(body?.data) ? body.data : fail('jobs response has no data array');
  const jobs = [];
  for (const job of rows) {
    if (!job || typeof job !== 'object') continue;
    const view = viewJob(job);
    logJob(ctx, view);
    jobs.push(publicJob(job, view));
  }
  return { total: body?.meta?.total ?? null, page: body?.meta?.page ?? null, jobs };
}

function publicListing(row) {
  const currency = currencyOf(row);
  return {
    listing: typeof row.id === 'string' ? row.id : null,
    title: typeof row.title === 'string' ? row.title.slice(0, 140) : null,
    category: row.category ?? null,
    status: row.status ?? null,
    price: priceLabel(row.fixedPrice, currency),
    slots: Number.isInteger(row.maxConcurrent) ? row.maxConcurrent : null,
    delivery: deliveryMark(row.fixedPrice, currency),
  };
}

async function readListings(ctx) {
  ctx.action = 'listings';
  const mine = await send(ctx, 'GET', LISTINGS);
  const rows = Array.isArray(mine?.data) ? mine.data : fail('listings response has no data array');
  const listings = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const item = publicListing(row);
    record(ctx, { event: 'listing', action: 'listings', endpoint: `GET ${LISTINGS}`, listing: item.listing, outcome: 'ok', ...(item.price ? { price: item.price } : {}), delivery: item.delivery });
    listings.push(item);
  }
  ctx.action = 'requests';
  const pending = await send(ctx, 'GET', REQUESTS);
  const reqs = Array.isArray(pending?.data) ? pending.data : fail('listing requests response has no data array');
  const requests = [];
  for (const row of reqs) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id : null;
    const listing = typeof (row.listingId || row.listing_id) === 'string' ? (row.listingId || row.listing_id) : null;
    const rule = classify(row);
    const currency = currencyOf(row);
    const amount = row.fixedPrice ?? row.budget ?? null;
    const item = { request: id, listing, eligible: rule.eligible, refusal: rule.refusal, category: rule.category, price: priceLabel(amount, currency), delivery: deliveryMark(amount, currency) };
    record(ctx, { event: 'request', action: 'requests', endpoint: `GET ${REQUESTS}`, ...(id ? { request: id } : {}), ...(listing ? { listing } : {}), outcome: rule.eligible ? 'eligible' : 'refused', ...(rule.refusal ? { reason: rule.refusal } : {}), ...(rule.category ? { category: rule.category } : {}), ...(item.price ? { price: item.price } : {}), delivery: item.delivery });
    requests.push(item);
  }
  return { listings, requests };
}

async function placeBid(ctx, opts, jobs) {
  const found = jobs.find((j) => j.job === opts.job);
  const job = found || null;
  if (!bidAllowed({ bid: true, live: ctx.live, eligible: job?.eligible === true, funded: job?.funded === true })) {
    record(ctx, { event: 'refused', action: 'bid', endpoint: `POST /api/v1/jobs/${opts.job}/bids`, method: 'POST', job: opts.job, outcome: 'refused', reason: !job ? 'job not on this page' : job.funded ? (job.refusal || 'not eligible') : (job.funded_reason || 'not funded') });
    return { bid: 'refused', reason: !job ? 'job not on this page' : job.funded ? (job.refusal || 'not eligible') : (job.funded_reason || 'not funded') };
  }
  const amount = opts.amount;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(String(amount)) || !(Number(amount) > 0)) fail('--amount must be an amount like 10.00');
  const proposal = text(opts.proposal, '--proposal', 5000);
  const body = { proposedAmount: Number(amount).toFixed(2), proposalText: proposal };
  if (opts.hours != null) {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(String(opts.hours)) || !(Number(opts.hours) > 0)) fail('--hours must be a number of hours');
    body.estimatedHours = Number(opts.hours);
  }
  ctx.action = 'bid';
  ctx.allowWrite = true;
  try {
    await send(ctx, 'POST', `/api/v1/jobs/${encodeURIComponent(opts.job)}/bids`, body);
  } finally {
    ctx.allowWrite = false;
  }
  record(ctx, { event: 'bid', action: 'bid', endpoint: `POST /api/v1/jobs/${opts.job}/bids`, method: 'POST', job: opts.job, outcome: 'sent', price: priceLabel(amount, job.currency || PLATFORM_CURRENCY), delivery: job.delivery });
  return { bid: 'sent', job: opts.job, delivery: job.delivery };
}

function linkEarn(ctx, opts) {
  const job = text(opts.job, '--job', 80);
  const earn = text(opts.earn, '--earn', 40);
  if (!ID.test(job)) fail('--job must be the marketplace job id');
  if (!EARN_ID.test(earn)) fail('--earn must be the earn line id, e.g. W001');
  const lines = readLog(ctx.logPath);
  const problem = verifyLog(lines);
  if (problem) fail(`call log ${problem}`);
  const same = (x) => x.marketplace === MARKETPLACE && x.job === job;
  const funded = lines.some((x) => same(x) && x.escrow === 'funded' && x.price != null && x.price !== '' && x.outcome === 'eligible');
  if (!funded) fail(`no funded eligible line for job ${job} in the call log; link does not invent escrow`);
  const otherEarn = lines.filter((x) => same(x) && x.earn != null && x.earn !== earn).map((x) => x.earn);
  if (otherEarn.length) fail(`job ${job} is already linked to ${otherEarn[0]}`);
  const otherJob = lines.filter((x) => x.marketplace === MARKETPLACE && x.earn === earn && x.job !== job).map((x) => x.job);
  if (otherJob.length) fail(`${earn} is already linked to job ${otherJob[0]}`);
  if (lines.some((x) => same(x) && x.earn === earn)) return { linked: false, reason: 'already linked' };
  record(ctx, { event: 'link', action: 'link', endpoint: 'local', job, earn, outcome: 'linked' });
  return { linked: true, job, earn };
}

function dryRun(ctx, cmd, opts) {
  const endpoints = [];
  if (cmd === 'jobs' || cmd === 'list') endpoints.push(`GET ${PAGE}`);
  if (cmd === 'listings' || cmd === 'list') endpoints.push(`GET ${LISTINGS}`, `GET ${REQUESTS}`);
  for (const endpoint of endpoints) record(ctx, { event: 'dry-run', action: cmd, endpoint, method: 'GET', outcome: 'not-sent' });
  if (opts.bid) record(ctx, { event: 'refused', action: 'bid', endpoint: `POST /api/v1/jobs/${opts.job}/bids`, method: 'POST', job: opts.job, outcome: 'refused', reason: 'dry-run does not bid' });
  return { mode: 'dry-run', endpoints, bid: opts.bid ? 'refused' : 'not-requested' };
}

function config(cmd) {
  const logPath = process.env.WORK_CALL_LOG;
  if (!logPath) fail('set WORK_CALL_LOG (a path outside the repo)');
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const resolved = path.resolve(logPath);
  if (resolved === repo || resolved.startsWith(repo + path.sep)) fail('WORK_CALL_LOG must be outside the repo so a call log is never committed');
  return { cmd, logPath, actor: actor(), live: false, allowWrite: false, secrets: [], action: cmd };
}

async function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  const ctx = config(cmd);
  ctx.live = opts.live === true;
  if (cmd === 'link') return linkEarn(ctx, opts);
  if (opts.dryRun) return dryRun(ctx, cmd, opts);
  const creds = credentials();
  ctx.base = creds.base;
  ctx.apiKey = creds.apiKey;
  ctx.secrets = creds.secrets;
  const out = { mode: 'live' };
  if (cmd === 'jobs' || cmd === 'list') Object.assign(out, await readJobs(ctx));
  if (cmd === 'listings' || cmd === 'list') Object.assign(out, await readListings(ctx));
  if (opts.bid) {
    if (cmd === 'listings') fail('--bid is only checked against open jobs; run jobs --live --bid');
    Object.assign(out, await placeBid(ctx, opts, out.jobs || []));
  } else out.bid = 'not-requested';
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    const out = await main(process.argv.slice(2));
    console.log(JSON.stringify({ private: PRIVATE, marketplace: MARKETPLACE, ...out }, null, 2));
  } catch (e) {
    console.error(e instanceof Stop ? e.message : e.stack);
    process.exit(1);
  }
}
