#!/usr/bin/env node
// Kernel's eBay listings through eBay's Sell APIs, with limits the Controller can check.
//
//   node scripts/ebay.mjs list   --sku E004 --title "LEGO 70779 Protector of Stone, complete" --price 24.99
//                                --condition USED_GOOD --category 19006 --images https://kernelexperiment.com/receipts/E004-photo.jpg[,...]
//                                --description "..." [--condition-note "..."] [--aspect "Brand=LEGO" --aspect "LEGO Set Number=70779"]
//   node scripts/ebay.mjs revise --sku E004 --price 19.99
//   node scripts/ebay.mjs end    --sku E004
//   node scripts/ebay.mjs orders [--since 2026-09-27]
//   node scripts/ebay.mjs audit                                   the Controller: every listing against the ledger and the call log
//   node scripts/ebay.mjs log    [--from 41 --hash <line 41's h>] the Controller: check the call log and show what is new
//
// Operator, once:
//   node scripts/ebay.mjs consent-url                             then sign in as the selling account and agree
//   node scripts/ebay.mjs exchange --code <code from the address bar>
//   node scripts/ebay.mjs location --key kernel --postal <post office postal code> --province BC [--city Vancouver] --phone <number>
//
// Limits, which stop mistakes and manipulation through this script (the Controller's audit catches the rest):
// - The token carries two scopes: sell.inventory and sell.fulfillment.readonly.
// - Only a buy the published ledger (main on GitHub) still holds can be listed: one unit, fixed price, no Best Offer.
// - No list or revise below the floor: the price that nets the buy's est_value_usd after eBay's final value fee and
//   the tax on it, est_value_usd / (1 - FEE), taking est_value_usd as last re-marked by a correction the Controller
//   has not flagged, converted at the Bank of Canada's latest rate for a CAD listing. To price lower, append a
//   correction first.
// - revise changes only the price; end needs the SKU; nothing ends or deletes in bulk.
// - Every eBay call is appended to the call log (EBAY_CALL_LOG) before it is sent, and again with its answer; so is
//   every refusal. The log is hash-chained so edits show. (exchange, the operator's one-time token step, isn't logged.)
// - Buyer data is never written anywhere: orders are cut down in memory to SKUs, amounts and statuses before
//   anything is printed or logged, and the log records only how many orders came back and their SKUs.
//
// Private by design: eBay's API License Agreement limits storing and redistributing what its APIs return, so the
// output is never committed or published. The ledger's receipts are screenshots of the listing and the order,
// with buyer details redacted (Rule 12).
//
// Environment, from the bot's secret store:
//   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET  the production keyset's App ID and Cert ID
//   EBAY_REFRESH_TOKEN                  the selling account's refresh token (from exchange)
//   EBAY_MARKETPLACE                    EBAY_CA or EBAY_US
//   EBAY_PAYMENT_POLICY_ID, EBAY_RETURN_POLICY_ID, EBAY_FULFILLMENT_POLICY_ID, EBAY_LOCATION_KEY
//   EBAY_CALL_LOG                       the call log's path, the same file for both bots
//   EBAY_RUNAME                         consent-url and exchange only
//   EBAY_ENV                            "production" (default) or "sandbox"

import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { userInfo } from 'node:os';

const SCOPES = ['https://api.ebay.com/oauth/api_scope/sell.inventory', 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly'];
const LEDGER = 'https://raw.githubusercontent.com/madmax-a79/kernel-ledger/main/ledger.json';
const FX = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1';
// eBay's final value fee for most categories (LEGO, cameras and tools among them) for a seller registered in Canada,
// charged on the total amount of the sale: https://www.ebay.ca/help/selling/fees-credits-invoices/selling-fees?id=4822
// (checked 2026-09-28). eBay's fees carry 5% GST and 7% BC PST (Bulletin PST 142). PST never comes back, and the
// operator isn't GST-registered, so the GST doesn't either (if that changes, FEE_TAX becomes 0.07): the fee costs
// 13.6% x 1.12 = 15.232% of the sale. Books & Magazines, Movies & TV and Music charge 15.3% and are not
// covered; if Kernel ever lists those, revisit the floor first.
// These live here, not in the environment, so Kernel and the Controller's audit use the same rate.
const FEE_RATE = 0.136;
const FEE_TAX = 0.12;
const FEE = FEE_RATE * (1 + FEE_TAX);
const pct = (x) => `${+(x * 100).toFixed(3)}%`;
const HOSTS = {
  production: { auth: 'https://auth.ebay.com/oauth2/authorize', token: 'https://api.ebay.com/identity/v1/oauth2/token', inventory: 'https://api.ebay.com/sell/inventory/v1', fulfillment: 'https://apiz.ebay.com/sell/fulfillment/v1', item: { EBAY_CA: 'https://www.ebay.ca/itm/', EBAY_US: 'https://www.ebay.com/itm/' } },
  sandbox: { auth: 'https://auth.sandbox.ebay.com/oauth2/authorize', token: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token', inventory: 'https://api.sandbox.ebay.com/sell/inventory/v1', fulfillment: 'https://api.sandbox.ebay.com/sell/fulfillment/v1', item: { EBAY_CA: 'https://sandbox.ebay.com/itm/', EBAY_US: 'https://sandbox.ebay.com/itm/' } },
};
const MARKETS = { EBAY_CA: { currency: 'CAD', language: 'en-CA' }, EBAY_US: { currency: 'USD', language: 'en-US' } };
const CONDITIONS = ['NEW', 'LIKE_NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS', 'MANUFACTURER_REFURBISHED', 'CERTIFIED_REFURBISHED', 'EXCELLENT_REFURBISHED', 'VERY_GOOD_REFURBISHED', 'GOOD_REFURBISHED', 'SELLER_REFURBISHED', 'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE', 'FOR_PARTS_OR_NOT_WORKING', 'PRE_OWNED_EXCELLENT', 'PRE_OWNED_FAIR'];
// The fields updateOffer takes; it replaces the whole offer, so revise sends back everything else as it was.
const OFFER_FIELDS = ['availableQuantity', 'categoryId', 'charity', 'extendedProducerResponsibility', 'hideBuyerDetails', 'includeCatalogProductDetails', 'listingDescription', 'listingDuration', 'listingPolicies', 'listingStartDate', 'lotSize', 'merchantLocationKey', 'pricingSummary', 'quantityLimitPerBuyer', 'regulatory', 'secondaryCategoryId', 'storeCategoryNames', 'tax'];
const GENESIS = '0'.repeat(64);
const PRIVATE = 'eBay API data for Kernel and the Controller only. Never commit or publish it; the ledger cites screenshots of the listing and the order instead.';

const COMMANDS = {
  list: { flags: ['sku', 'title', 'price', 'condition', 'category', 'images', 'description', 'condition-note', 'aspect'], required: ['sku', 'title', 'price', 'condition', 'category', 'images', 'description'] },
  revise: { flags: ['sku', 'price'], required: ['sku', 'price'] },
  end: { flags: ['sku'], required: ['sku'] },
  orders: { flags: ['since'], required: [] },
  audit: { flags: [], required: [] },
  log: { flags: ['from', 'hash'], required: [] },
  location: { flags: ['key', 'postal', 'city', 'province', 'country', 'phone'], required: ['key', 'postal', 'province', 'phone'] },
  'consent-url': { flags: [], required: [] },
  exchange: { flags: ['code'], required: ['code'] },
};
const USAGE = 'usage: node scripts/ebay.mjs list|revise|end|orders|audit|log|location|consent-url|exchange [flags] (see the top of scripts/ebay.mjs)';

class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const spec = COMMANDS[cmd];
  if (!spec) fail(USAGE);
  const opts = { aspect: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const name = String(rest[i]).replace(/^--/, '');
    if (!rest[i].startsWith('--') || !spec.flags.includes(name) || rest[i + 1] == null) fail(`${USAGE}\n${cmd} takes ${spec.flags.map((f) => '--' + f).join(' ') || 'no flags'}`);
    if (name === 'aspect') opts.aspect.push(rest[i + 1]); else if (name in opts) fail(`--${name} given twice`); else opts[name] = rest[i + 1];
  }
  const missing = spec.required.filter((f) => opts[f] == null || opts[f] === '');
  if (missing.length) fail(`${cmd} needs ${missing.map((f) => '--' + f).join(', ')}`);
  return { cmd, opts };
}

const CONTROL = new RegExp('[' + [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x7f], [0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']');
function text(v, what, max, { lines = false } = {}) {
  const s = (lines ? String(v).replace(/\r\n?/g, '\n') : String(v)).trim();
  if (!s || s.length > max) fail(`${what} must be 1 to ${max} characters`);
  if (CONTROL.test(s) || (!lines && /[\r\n\t]/.test(s))) fail(`${what} has control characters`);
  return s;
}
const skuOf = (v) => (/^[A-Za-z0-9._-]{1,50}$/.test(v) ? v : fail('--sku must be the buy\'s ledger id, e.g. E004'));
function priceOf(v) {
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(String(v))) fail('--price must be an amount like 24.99');
  const p = Number(v);
  if (!(p > 0)) fail('--price must be more than 0');
  return p;
}
const money = (n, currency) => `${n.toFixed(2)} ${currency}`;
const amount = (a) => (a && a.value != null && a.value !== '' ? `${Number(a.value).toFixed(2)} ${a.currency || ''}`.trim() : null);
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');

// ---- the call log -------------------------------------------------------------------------------------

const sha = (s) => createHash('sha256').update(s).digest('hex');
const lineHash = (obj) => { const { h, ...rest } = obj; return sha(JSON.stringify(rest)); };

function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { return { n: i + 1, broken: true, raw: l.slice(0, 200) }; }
  });
}

// Checks every line's hash and its link to the line before; returns the first problem, if any.
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
function withLock(path, fn) {
  const lock = path + '.lock';
  const deadline = Date.now() + 10000;
  for (;;) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30000) { unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) fail(`the call log is locked (${lock}); if no other ebay.mjs is running, delete that file`);
      sleep(50);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch {} }
}

function record(ctx, entry) {
  if (!ctx.logPath) return;
  withLock(ctx.logPath, () => {
    const lines = readLog(ctx.logPath);
    const last = lines[lines.length - 1];
    const line = { n: lines.length + 1, at: new Date().toISOString(), actor: ctx.actor, cmd: ctx.cmd, ...entry, prev: last ? last.h : GENESIS };
    line.h = lineHash(line);
    appendFileSync(ctx.logPath, JSON.stringify(line) + '\n');
  });
}

function actor() {
  try { return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || userInfo().username; } catch { return userInfo().username; }
}

// ---- eBay ---------------------------------------------------------------------------------------------

async function send(url, init, what) {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch {}
    return { r, data };
  } catch (e) {
    return { error: `could not reach ${what}: ${e.cause?.code || e.message}` };
  }
}

// Every call is written to the log before it is sent (so nothing reaches eBay unlogged) and again with its answer.
function note(ctx, entry, unwritten) {
  try { record(ctx, entry); } catch (e) { fail(`${unwritten}: cannot write the call log ${ctx.logPath} (${e instanceof Stop ? e.message : e.code || e.message})`); }
}

async function accessToken(ctx) {
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: ctx.env.refresh, scope: SCOPES.join(' ') });
  const shown = 'oauth2/token (refresh)';
  note(ctx, { event: 'send', api: 'identity', method: 'POST', path: shown }, `POST ${shown} was not sent`);
  const { r, data, error } = await send(ctx.urls.token, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${ctx.env.id}:${ctx.env.secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: form }, 'eBay');
  note(ctx, { event: 'answer', api: 'identity', method: 'POST', path: shown, status: r ? r.status : null, ...(error ? { error } : {}) }, `POST ${shown} reached eBay, but its answer is not in the call log`);
  if (error) fail(error);
  if (!r.ok || !data?.access_token) fail(`eBay refused the refresh token (${data?.error || 'HTTP ' + r.status}${data?.error_description ? ': ' + data.error_description : ''}); it may have expired or been revoked, so the operator runs consent-url and exchange again`);
  return data.access_token;
}

async function call(ctx, api, method, path, { query, body, absent } = {}) {
  const url = new URL(ctx.urls[api] + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const headers = { authorization: 'Bearer ' + ctx.token, accept: 'application/json' };
  if (body) Object.assign(headers, { 'content-type': 'application/json', 'content-language': ctx.market.language });
  const shown = url.pathname.replace(/^.*\/(inventory|fulfillment)\/v1/, '') + url.search;
  note(ctx, { event: 'send', api, method, path: shown }, `${method} ${shown} was not sent`);
  const { r, data, error } = await send(url, { method, headers, body: body ? JSON.stringify(body) : undefined }, 'eBay');
  const errors = (data?.errors || []).map((e) => `${e.errorId}: ${e.longMessage || e.message}`);
  note(ctx, { event: 'answer', api, method, path: shown, status: r ? r.status : null, ...(errors.length ? { errors } : {}), ...(error ? { error } : {}) }, `${method} ${shown} reached eBay${r ? ` (HTTP ${r.status})` : ''}, but its answer is not in the call log`);
  if (error) fail(error);
  if (absent && absent(r.status, (data?.errors || []).map((e) => Number(e.errorId)))) return null;
  if (r.status === 401 || r.status === 403) fail(`eBay refused the call (HTTP ${r.status}) to ${method} ${shown}; check that the token was granted both scopes${errors.length ? '\n' + errors.join('\n') : ''}`);
  if (!r.ok) fail(`eBay answered HTTP ${r.status} to ${method} ${shown}${errors.length ? ':\n' + errors.join('\n') : ''}`);
  return data;
}

// A SKU eBay has never seen comes back as 404, or as 400 "invalid value" (25709/25710/25713): either means no offers.
const noOffers = (status, ids) => status === 404 || (status === 400 && ids.length > 0 && ids.every((id) => [25709, 25710, 25713].includes(id)));
async function offersFor(ctx, sku) {
  const data = await call(ctx, 'inventory', 'GET', '/offer', { query: { sku }, absent: noOffers });
  return data?.offers || [];
}

// ---- the ledger floor ---------------------------------------------------------------------------------

async function getJson(url, what) {
  const { r, data, error } = await send(url, { headers: { accept: 'application/json' } }, what);
  if (error) fail(`${error}, so no floor can be set`);
  if (!r.ok || !data) fail(`${what} answered HTTP ${r.status}, so no floor can be set`);
  return data;
}

// Held buys and their floors in USD, in append order: a sell or a death releases them; a correction
// re-marks one unless the Controller's latest check on that correction is "flagged".
function holdings(ledger) {
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : fail('the published ledger has no entries');
  const status = new Map();
  for (const e of entries) if (e?.type === 'check' && e.checks) status.set(e.checks, e.status);
  const held = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'buy') held.set(e.id, { usd: Number(e.est_value_usd) || 0, basis: `${e.id} est_value_usd` });
    else if (e.type === 'sell' && e.closes) held.delete(e.closes);
    else if (e.type === 'correction' && held.has(e.corrects) && e.est_value_usd != null && status.get(e.id) !== 'flagged') held.set(e.corrects, { usd: Number(e.est_value_usd) || 0, basis: `${e.id} re-mark` });
    else if (e.type === 'death') held.clear();
  }
  return held;
}

async function floors(ctx) {
  const ledger = await getJson(ctx.urls.ledger + (ctx.test ? '' : `?t=${Date.now()}`), 'GitHub (the published ledger)');
  const held = holdings(ledger);
  let fx = null;
  // Listing-currency units per US dollar.
  const perUsd = async (currency) => {
    if (currency === 'USD') return 1;
    if (currency !== 'CAD') fail(`no floor for a ${currency} listing`);
    if (!fx) {
      const data = await getJson(ctx.urls.fx, 'the Bank of Canada');
      const o = data?.observations?.[0];
      const rate = Number(o?.FXUSDCAD?.v);
      if (!(rate > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(o?.d || '')) fail('the Bank of Canada gave no USD/CAD rate, so no floor can be set');
      fx = { date: o.d, cad_per_usd: rate };
    }
    return fx.cad_per_usd;
  };
  return { held, perUsd, fx: () => fx };
}

async function floorFor(ctx, f, sku, currency) {
  const h = f.held.get(sku);
  if (!h) fail(`${sku} is not a buy the published ledger holds (sold, lost to a death, or not appended and pushed yet)`);
  // est_value_usd is net of fees, so the floor is the price that nets it, rounded up to the cent.
  const gross = (h.usd * (await f.perUsd(currency))) / (1 - FEE);
  return { amount: Math.ceil(gross * 100 - 1e-9) / 100, basis: `${h.basis} ${h.usd.toFixed(2)} USD / (1 - ${pct(FEE)} fee: ${pct(FEE_RATE)} plus ${pct(FEE_TAX)} GST and PST on it)` };
}

// ---- commands -----------------------------------------------------------------------------------------

async function list(ctx, o) {
  const sku = skuOf(o.sku);
  const title = text(o.title, '--title', 80);
  const description = text(o.description, '--description', 4000, { lines: true });
  const condition = CONDITIONS.includes(o.condition) ? o.condition : fail(`--condition must be one of ${CONDITIONS.join(', ')} (which ones a category takes varies)`);
  const category = /^\d{1,10}$/.test(o.category) ? o.category : fail('--category must be an eBay category id, e.g. 19006');
  const images = String(o.images).split(',').map((s) => s.trim()).filter(Boolean);
  if (!images.length || images.length > 24 || !images.every((u) => /^https:\/\/[^\s"<>]+$/.test(u))) fail('--images must be 1 to 24 https links, comma-separated');
  const note = o['condition-note'] != null ? text(o['condition-note'], '--condition-note', 1000) : null;
  const aspects = {};
  for (const a of o.aspect) {
    const m = /^([^=]{1,65})=(.{1,65}(\|.{1,65})*)$/.exec(String(a));
    if (!m) fail(`--aspect must look like "Brand=LEGO" (several values: "Color=Red|Blue"), not ${JSON.stringify(a)}`);
    aspects[text(m[1], 'an aspect name', 65)] = m[2].split('|').map((v) => text(v, 'an aspect value', 65));
  }
  const price = priceOf(o.price);
  const currency = ctx.market.currency;
  const f = await floors(ctx);
  const floor = await floorFor(ctx, f, sku, currency);
  if (price < floor.amount) fail(`refused: ${money(price, currency)} is below ${sku}'s floor of ${money(floor.amount, currency)} (${floor.basis}${f.fx() ? ` at ${f.fx().cad_per_usd} CAD/USD, ${f.fx().date}` : ''}); to price lower, append a correction that re-marks ${sku} first`);

  ctx.token = await accessToken(ctx);
  const existing = await offersFor(ctx, sku);
  if (existing.some((x) => x.status === 'PUBLISHED')) fail(`${sku} is already listed; use revise to change its price or end to end it`);
  if (existing.some((x) => x.format !== 'FIXED_PRICE' || x.marketplaceId !== ctx.marketplace)) fail(`${sku} has an offer this script did not make (another format or marketplace); the operator removes it in Seller Hub first`);
  await call(ctx, 'inventory', 'PUT', `/inventory_item/${encodeURIComponent(sku)}`, { body: {
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition,
    ...(note ? { conditionDescription: note } : {}),
    product: { title, description: escapeHtml(description), imageUrls: images, ...(Object.keys(aspects).length ? { aspects } : {}) },
  } });
  const offer = {
    availableQuantity: 1,
    categoryId: category,
    includeCatalogProductDetails: false,
    listingDescription: escapeHtml(description),
    listingDuration: 'GTC',
    listingPolicies: { fulfillmentPolicyId: ctx.env.fulfillment, paymentPolicyId: ctx.env.payment, returnPolicyId: ctx.env.returns },
    merchantLocationKey: ctx.env.location,
    pricingSummary: { price: { value: price.toFixed(2), currency } },
  };
  let offerId = existing[0]?.offerId;
  if (offerId) await call(ctx, 'inventory', 'PUT', `/offer/${encodeURIComponent(offerId)}`, { body: offer });
  else offerId = (await call(ctx, 'inventory', 'POST', '/offer', { body: { sku, marketplaceId: ctx.marketplace, format: 'FIXED_PRICE', ...offer } }))?.offerId;
  if (!offerId) fail('eBay created no offer');
  const published = await call(ctx, 'inventory', 'POST', `/offer/${encodeURIComponent(offerId)}/publish`);
  const listingId = published?.listingId || fail('eBay published no listing');
  const result = { sku, offer_id: offerId, listing_id: listingId, price: money(price, currency), floor: money(floor.amount, currency), floor_basis: floor.basis, ...(f.fx() ? { fx: f.fx() } : {}) };
  record(ctx, { event: 'done', ...result });
  return { ...result, url: ctx.urls.item + listingId, warnings: (published.warnings || []).map((w) => `${w.errorId}: ${w.message}`) };
}

async function publishedOffer(ctx, sku) {
  const live = (await offersFor(ctx, sku)).filter((x) => x.status === 'PUBLISHED');
  if (!live.length) fail(`${sku} has no live listing`);
  if (live.length > 1 || live[0].format !== 'FIXED_PRICE') fail(`${sku} has a listing this script did not make (an auction, or two listings); the operator handles it in Seller Hub`);
  return live[0];
}

async function revise(ctx, o) {
  const sku = skuOf(o.sku);
  const price = priceOf(o.price);
  const f = await floors(ctx);
  ctx.token = await accessToken(ctx);
  const offer = await publishedOffer(ctx, sku);
  const currency = offer.pricingSummary?.price?.currency || ctx.market.currency;
  const floor = await floorFor(ctx, f, sku, currency);
  if (price < floor.amount) fail(`refused: ${money(price, currency)} is below ${sku}'s floor of ${money(floor.amount, currency)} (${floor.basis}${f.fx() ? ` at ${f.fx().cad_per_usd} CAD/USD, ${f.fx().date}` : ''}); to price lower, append a correction that re-marks ${sku} first`);
  const body = Object.fromEntries(OFFER_FIELDS.filter((k) => offer[k] !== undefined).map((k) => [k, offer[k]]));
  body.pricingSummary = { ...offer.pricingSummary, price: { value: price.toFixed(2), currency } };
  await call(ctx, 'inventory', 'PUT', `/offer/${encodeURIComponent(offer.offerId)}`, { body });
  const result = { sku, listing_id: offer.listing?.listingId || null, old_price: amount(offer.pricingSummary?.price), price: money(price, currency), floor: money(floor.amount, currency), floor_basis: floor.basis, ...(f.fx() ? { fx: f.fx() } : {}) };
  record(ctx, { event: 'done', ...result });
  return result;
}

async function end(ctx, o) {
  const sku = skuOf(o.sku);
  ctx.token = await accessToken(ctx);
  const offer = await publishedOffer(ctx, sku);
  const r = await call(ctx, 'inventory', 'POST', `/offer/${encodeURIComponent(offer.offerId)}/withdraw`);
  const result = { sku, ended: r?.listingId || offer.listing?.listingId || null };
  record(ctx, { event: 'done', ...result });
  return result;
}

// Everything an order may say about the buyer (name, user id, address, phone, email, notes, tax ids) stays out:
// only these fields are copied.
function orderSummary(x) {
  const p = x.pricingSummary || {};
  return {
    order_id: x.orderId,
    created: x.creationDate,
    payment_status: x.orderPaymentStatus || null,
    fulfillment_status: x.orderFulfillmentStatus || null,
    cancel_state: x.cancelStatus?.cancelState || null,
    items: amount(p.priceSubtotal),
    shipping_charged: amount(p.deliveryCost),
    tax: amount(p.tax),
    total: amount(p.total),
    ebay_fees: amount(x.totalMarketplaceFee),
    lines: (x.lineItems || []).map((l) => ({
      sku: l.sku || null,
      listing_id: l.legacyItemId || null,
      title: l.title || null,
      quantity: l.quantity ?? null,
      price: amount(l.lineItemCost),
      total: amount(l.total),
      refunded: (l.refunds || []).length ? amount({ value: l.refunds.reduce((s, r) => s + (Number(r.amount?.value) || 0), 0), currency: l.refunds[0].amount?.currency }) : null,
      status: l.lineItemFulfillmentStatus || null,
    })),
  };
}

async function orders(ctx, o) {
  const today = new Date().toISOString().slice(0, 10);
  const since = o.since ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || Number.isNaN(Date.parse(since)) || since > today) fail('--since must be a date like 2026-09-27, not in the future');
  if (Date.parse(since) < Date.now() - 700 * 86400000) fail('--since can go back at most about two years (eBay\'s limit)');
  ctx.token = await accessToken(ctx);
  const out = [];
  for (let offset = 0, pages = 0; pages < 20; pages++) {
    const data = await call(ctx, 'fulfillment', 'GET', '/order', { query: { filter: `creationdate:[${since}T00:00:00.000Z..]`, limit: '50', offset: String(offset) } });
    const batch = (data?.orders || []).map(orderSummary);
    out.push(...batch);
    offset += batch.length;
    if (!batch.length || offset >= Number(data?.total || 0)) break;
  }
  record(ctx, { event: 'done', since, orders: out.length, skus: [...new Set(out.flatMap((x) => x.lines.map((l) => l.sku)).filter(Boolean))] });
  return { since, orders: out };
}

// The Controller's daily check: every offer on the account against the ledger's floors and the call log.
async function audit(ctx) {
  const f = await floors(ctx);
  const lines = readLog(ctx.logPath);
  const chain = verifyLog(lines);
  const logged = new Map(); // listing id -> last price the log recorded for it
  for (const x of lines) if (x.event === 'done' && x.listing_id && x.price) logged.set(String(x.listing_id), x.price);
  ctx.token = await accessToken(ctx);
  const skus = [];
  for (let offset = 0, pages = 0; pages < 50; pages++) {
    const data = await call(ctx, 'inventory', 'GET', '/inventory_item', { query: { limit: '100', offset: String(offset) } });
    const batch = (data?.inventoryItems || []).map((x) => x.sku);
    skus.push(...batch);
    offset += batch.length;
    if (!batch.length || offset >= Number(data?.total || 0)) break;
  }
  const listings = [];
  for (const sku of skus) {
    for (const x of await offersFor(ctx, sku)) {
      const problems = [];
      const live = x.status === 'PUBLISHED';
      const price = Number(x.pricingSummary?.price?.value);
      const currency = x.pricingSummary?.price?.currency;
      let floor = null;
      if (live && !f.held.has(sku)) problems.push('listed, but the ledger does not hold this SKU');
      if (f.held.has(sku) && currency) {
        floor = (await floorFor(ctx, f, sku, currency)).amount;
        if (live && price < floor) problems.push(`priced below the floor of ${money(floor, currency)}`);
      }
      if (x.format !== 'FIXED_PRICE') problems.push(`format ${x.format}, not fixed price`);
      if (Number(x.availableQuantity) > 1) problems.push(`${x.availableQuantity} units, not one`);
      if (x.listingPolicies?.bestOfferTerms?.bestOfferEnabled) problems.push('Best Offer is on');
      const id = x.listing?.listingId ? String(x.listing.listingId) : null;
      if (live && id && !logged.has(id)) problems.push('not in the call log');
      else if (live && id && logged.get(id) !== amount(x.pricingSummary?.price)) problems.push(`live price ${amount(x.pricingSummary?.price)}, but the call log last set ${logged.get(id)}`);
      listings.push({ sku, status: x.status, listing_id: id, listing_status: x.listing?.listingStatus || null, price: amount(x.pricingSummary?.price), floor: floor == null ? null : money(floor, currency), problems });
    }
  }
  const problems = listings.reduce((s, x) => s + x.problems.length, 0) + (chain ? 1 : 0);
  record(ctx, { event: 'done', listings: listings.length, problems });
  return { checked_at: new Date().toISOString(), log: { lines: lines.length, chain: chain || 'intact' }, fx: f.fx(), problems, listings };
}

function showLog(ctx, o) {
  const lines = readLog(ctx.logPath);
  const chain = verifyLog(lines);
  let from = 0;
  let anchor = null;
  if (o.from != null) {
    from = Number(o.from);
    if (!Number.isInteger(from) || from < 0 || from > lines.length) fail(`--from must be a line number from 0 to ${lines.length}`);
    if (o.hash != null && from > 0) anchor = lines[from - 1].h === o.hash ? 'matches' : `does not match: line ${from} now hashes to ${lines[from - 1].h}`;
  }
  const last = lines[lines.length - 1];
  return { log: ctx.logPath, lines: lines.length, chain: chain || 'intact', ...(anchor ? { anchor } : {}), head: last ? { n: last.n, h: last.h } : null, since_line: from, entries: lines.slice(from) };
}

async function location(ctx, o) {
  const key = /^[A-Za-z0-9_-]{1,36}$/.test(o.key) ? o.key : fail('--key must be 1 to 36 letters, digits, "_" or "-"');
  const country = (o.country || 'CA').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) fail('--country must be a two-letter code');
  const postal = String(o.postal).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{3,10}$/.test(postal)) fail('--postal must be a postal code');
  const body = { location: { address: { postalCode: postal, stateOrProvince: text(o.province, '--province', 40), country, ...(o.city ? { city: text(o.city, '--city', 60) } : {}) } }, locationTypes: ['WAREHOUSE'], merchantLocationStatus: 'ENABLED', name: 'Kernel', phone: text(o.phone, '--phone', 36) };
  ctx.token = await accessToken(ctx);
  await call(ctx, 'inventory', 'POST', `/location/${encodeURIComponent(key)}`, { body });
  record(ctx, { event: 'done', key, postal: postal.slice(0, 3), country });
  return { key, then: `set EBAY_LOCATION_KEY=${key} in the bots' secret store` };
}

function consentUrl(ctx) {
  const u = new URL(ctx.urls.auth);
  for (const [k, v] of Object.entries({ client_id: ctx.env.id, redirect_uri: ctx.env.runame, response_type: 'code', scope: SCOPES.join(' '), prompt: 'login' })) u.searchParams.set(k, v);
  return { open: u.toString(), then: 'Sign in as the selling account and agree. Copy the code value from the address bar of the page you land on, then run: node scripts/ebay.mjs exchange --code <code>' };
}

async function exchange(ctx, o) {
  let code = String(o.code).trim();
  if (/%[0-9A-Fa-f]{2}/.test(code)) code = decodeURIComponent(code);
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: ctx.env.runame });
  const { r, data, error } = await send(ctx.urls.token, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(`${ctx.env.id}:${ctx.env.secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: form }, 'eBay');
  if (error) fail(error);
  if (!r.ok || !data?.refresh_token) fail(`eBay refused the code (${data?.error || 'HTTP ' + r.status}${data?.error_description ? ': ' + data.error_description : ''}); codes expire after a few minutes, so run consent-url again`);
  const days = Math.floor(Number(data.refresh_token_expires_in) / 86400);
  return { refresh_token: data.refresh_token, expires_in_days: days || null, then: 'Put refresh_token in the bots\' secret store as EBAY_REFRESH_TOKEN, then clear this terminal. Nothing was saved.' };
}

// ---- main ---------------------------------------------------------------------------------------------

function config(cmd) {
  const env = {
    id: process.env.EBAY_CLIENT_ID, secret: process.env.EBAY_CLIENT_SECRET, refresh: process.env.EBAY_REFRESH_TOKEN, runame: process.env.EBAY_RUNAME,
    payment: process.env.EBAY_PAYMENT_POLICY_ID, returns: process.env.EBAY_RETURN_POLICY_ID, fulfillment: process.env.EBAY_FULFILLMENT_POLICY_ID, location: process.env.EBAY_LOCATION_KEY,
  };
  const need = { EBAY_CLIENT_ID: env.id, EBAY_CLIENT_SECRET: env.secret };
  if (cmd === 'consent-url') delete need.EBAY_CLIENT_SECRET;
  if (['consent-url', 'exchange'].includes(cmd)) need.EBAY_RUNAME = env.runame;
  else if (cmd !== 'log') Object.assign(need, { EBAY_REFRESH_TOKEN: env.refresh, EBAY_MARKETPLACE: process.env.EBAY_MARKETPLACE });
  if (cmd === 'list') Object.assign(need, { EBAY_PAYMENT_POLICY_ID: env.payment, EBAY_RETURN_POLICY_ID: env.returns, EBAY_FULFILLMENT_POLICY_ID: env.fulfillment, EBAY_LOCATION_KEY: env.location });
  if (cmd === 'log') for (const k of Object.keys(need)) delete need[k];
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  if (!['consent-url', 'exchange'].includes(cmd) && !process.env.EBAY_CALL_LOG) missing.push('EBAY_CALL_LOG');
  if (missing.length) fail(`set ${missing.join(', ')} (from the secret store)`);

  const marketplace = process.env.EBAY_MARKETPLACE || 'EBAY_CA';
  if (!MARKETS[marketplace]) fail('EBAY_MARKETPLACE must be EBAY_CA or EBAY_US');
  const name = process.env.EBAY_ENV || 'production';
  if (!HOSTS[name]) fail('EBAY_ENV must be "production" or "sandbox"');
  const urls = { ...HOSTS[name], ledger: LEDGER, fx: FX, item: HOSTS[name].item[marketplace] };
  // Tests may point everything at a local stand-in; nothing else is allowed.
  const base = process.env.EBAY_BASE_URL;
  if (base) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) fail('EBAY_BASE_URL may only name a local test server');
    Object.assign(urls, { auth: base + '/oauth2/authorize', token: base + '/identity/v1/oauth2/token', inventory: base + '/sell/inventory/v1', fulfillment: base + '/sell/fulfillment/v1', ledger: base + '/ledger.json', fx: base + '/valet/observations/FXUSDCAD/json?recent=1', item: base + '/itm/' });
  }
  return { cmd, env, marketplace, market: MARKETS[marketplace], urls, test: Boolean(base), logPath: null, actor: actor() };
}

async function main(argv) {
  const { cmd, opts } = parseArgs(argv);
  const ctx = config(cmd);
  if (cmd === 'consent-url') return consentUrl(ctx);
  if (cmd === 'exchange') return exchange(ctx, opts);
  const logPath = process.env.EBAY_CALL_LOG;
  if (cmd === 'log') { ctx.logPath = logPath; return showLog(ctx, opts); }
  // Nothing reaches eBay unless the call log takes the first line.
  try {
    ctx.logPath = logPath;
    const args = { ...opts };
    if (!args.aspect.length) delete args.aspect;
    if (args.phone) args.phone = '(given)';
    if (args.postal) args.postal = String(args.postal).toUpperCase().replace(/\s+/g, '').slice(0, 3);
    record(ctx, { event: 'start', marketplace: ctx.marketplace, args });
  } catch (e) {
    if (e instanceof Stop) throw e;
    fail(`cannot write the call log ${logPath} (${e.code || e.message}), so nothing was sent to eBay`);
  }
  try {
    return await { list, revise, end, orders, audit, location }[cmd](ctx, opts);
  } catch (e) {
    try { record(ctx, { event: 'stopped', reason: e instanceof Stop ? e.message : String(e.message || e) }); } catch {}
    throw e;
  }
}

try {
  const out = await main(process.argv.slice(2));
  console.log(JSON.stringify({ private: PRIVATE, ...out }, null, 2));
} catch (e) {
  console.error(e instanceof Stop ? e.message : e.stack);
  process.exit(1);
}
