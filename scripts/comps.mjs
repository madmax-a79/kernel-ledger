#!/usr/bin/env node
// BrickLink sold-price cross-check for LEGO, for Kernel's decisions and the Controller's checks.
//
//   node scripts/comps.mjs --item 70779-1 [--type SET] [--condition used|new] [--days 60] [--currency USD] [--country US | --region north_america]
//
// Private by design. BrickLink's API terms forbid storing its content beyond short periods and
// displaying it more than 24 hours stale, so this keeps nothing and its output is never committed
// or published. The public evidence, when the ledger cites BrickLink, is a screenshot of the
// item's public price guide page. BrickLink sales carry no links and "used" mixes complete and
// incomplete sets, so they cross-check Kernel's eBay sold comps; they are not Rule 13 comps.
//
// Environment, from the bot's secret store:
//   BRICKLINK_CONSUMER_KEY, BRICKLINK_CONSUMER_SECRET, BRICKLINK_TOKEN, BRICKLINK_TOKEN_SECRET

import { createHmac, randomBytes } from 'node:crypto';

const API = 'https://api.bricklink.com/api/store/v1';
const TYPES = ['SET', 'MINIFIG', 'PART', 'GEAR', 'BOOK', 'CATALOG', 'INSTRUCTION', 'ORIGINAL_BOX'];
const REGIONS = ['asia', 'africa', 'north_america', 'south_america', 'middle_east', 'europe', 'eu', 'oceania'];
const NOTICE = "The term 'BrickLink' is a trademark of the LEGO Group BrickLink. This application uses the BrickLink API but is not endorsed or certified by LEGO BrickLink, Inc.";
const PUBLIC_PAGE_PARAM = { SET: 'S', MINIFIG: 'M', PART: 'P', GEAR: 'G', BOOK: 'B', CATALOG: 'C', INSTRUCTION: 'I', ORIGINAL_BOX: 'O' };

class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };

function parseArgs(argv) {
  const opts = {};
  const flags = ['--item', '--type', '--condition', '--days', '--currency', '--country', '--region'];
  for (let i = 0; i < argv.length; i += 2) {
    if (!flags.includes(argv[i]) || argv[i + 1] == null) {
      fail('usage: node scripts/comps.mjs --item 70779-1 [--type SET] [--condition used|new] [--days 60] [--currency USD] [--country US | --region north_america]');
    }
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  return opts;
}

// RFC 3986 percent-encoding, as OAuth 1.0 requires.
const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// An OAuth 1.0 HMAC-SHA1 Authorization header for a GET request.
function authorization(url, query, creds) {
  const oauth = {
    oauth_consumer_key: creds.consumerKey,
    oauth_token: creds.token,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };
  const params = Object.entries({ ...query, ...oauth }).map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const base = ['GET', enc(url), enc(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  const signature = createHmac('sha1', `${enc(creds.consumerSecret)}&${enc(creds.tokenSecret)}`).update(base).digest('base64');
  return 'OAuth realm="", ' + Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${k}="${enc(v)}"`).join(', ');
}

async function main(argv) {
  const opts = parseArgs(argv);
  const item = String(opts.item || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(item)) fail('--item must be a BrickLink catalog number, e.g. 70779-1');
  const type = String(opts.type || 'SET').toUpperCase();
  if (!TYPES.includes(type)) fail(`--type must be one of ${TYPES.join(', ')}`);
  const condition = String(opts.condition || 'used').toLowerCase();
  if (!['used', 'new'].includes(condition)) fail('--condition must be used or new');
  const days = Number(opts.days || 60);
  if (!Number.isInteger(days) || days < 1 || days > 183) fail('--days must be a whole number from 1 to 183 (BrickLink keeps six months)');
  const currency = String(opts.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail('--currency must be a three-letter code, e.g. USD');
  if (opts.country && opts.region) fail('give --country or --region, not both');
  if (opts.country && !/^[A-Z]{2}$/.test(opts.country)) fail('--country must be a two-letter code, e.g. US (BrickLink uses UK for the United Kingdom)');
  if (opts.region && !REGIONS.includes(opts.region)) fail(`--region must be one of ${REGIONS.join(', ')}`);

  const creds = {
    consumerKey: process.env.BRICKLINK_CONSUMER_KEY, consumerSecret: process.env.BRICKLINK_CONSUMER_SECRET,
    token: process.env.BRICKLINK_TOKEN, tokenSecret: process.env.BRICKLINK_TOKEN_SECRET,
  };
  const missing = Object.entries({ BRICKLINK_CONSUMER_KEY: creds.consumerKey, BRICKLINK_CONSUMER_SECRET: creds.consumerSecret, BRICKLINK_TOKEN: creds.token, BRICKLINK_TOKEN_SECRET: creds.tokenSecret }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) fail(`set ${missing.join(', ')} (from the secret store)`);
  // Tests may point at a local stand-in; anything else goes to BrickLink.
  const base = process.env.BRICKLINK_BASE_URL || API;
  if (base !== API && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) fail('BRICKLINK_BASE_URL may only name a local test server');

  const url = `${base}/items/${type}/${encodeURIComponent(item)}/price`;
  const query = { guide_type: 'sold', new_or_used: condition === 'used' ? 'U' : 'N', currency_code: currency };
  if (opts.country) query.country_code = opts.country;
  if (opts.region) query.region = opts.region;
  let r;
  try {
    r = await fetch(`${url}?${new URLSearchParams(query)}`, { headers: { authorization: authorization(url, query, creds), accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    fail(`could not reach BrickLink: ${e.cause?.code || e.message}`);
  }
  let body = null;
  try { body = await r.json(); } catch { fail(`BrickLink answered HTTP ${r.status} without JSON`); }
  const code = Number(body?.meta?.code);
  if (!r.ok || !(code >= 200 && code < 300)) {
    const why = `${body?.meta?.message || ''}${body?.meta?.description ? ': ' + body.meta.description : ''}`;
    if (code === 401 || r.status === 401) fail(`BrickLink refused the credentials (${why || 'HTTP 401'}); check the four BRICKLINK_ values and that the token allows this machine's IP address`);
    fail(`BrickLink answered ${code || r.status}${why ? ' (' + why + ')' : ''}`);
  }
  const pg = body.data || {};
  const cutoff = Date.now() - days * 86400000;
  const sales = (pg.price_detail || [])
    .map((d) => ({ date: String(d.date_ordered || '').slice(0, 10), at: Date.parse(d.date_ordered), unit_price: Math.round(Number(d.unit_price) * 100) / 100, quantity: Number(d.quantity), seller_country: d.seller_country_code || null, buyer_country: d.buyer_country_code || null }))
    .filter((s) => Number.isFinite(s.at) && Number.isFinite(s.unit_price))
    .sort((a, b) => b.at - a.at);
  const recent = sales.filter((s) => s.at >= cutoff);
  const lastThree = recent.slice(0, 3);
  const num = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);

  console.log(JSON.stringify({
    private: 'BrickLink API data for Kernel and the Controller only. Never commit or publish it; cite a screenshot of the public price guide page instead.',
    notice: NOTICE,
    item: { type, no: item },
    condition,
    currency: pg.currency_code || currency,
    six_months: { sales: Number(pg.unit_quantity) || 0, items: Number(pg.total_quantity) || 0, min: num(pg.min_price), max: num(pg.max_price), avg: num(pg.avg_price), qty_avg: num(pg.qty_avg_price) },
    window_days: days,
    recent_sales: recent.map(({ at, ...s }) => s),
    cross_check: {
      rule: 'lowest of the last three sales in the window, same item and condition',
      last_three: lastThree.map(({ at, ...s }) => s),
      lowest: lastThree.length === 3 ? Math.min(...lastThree.map((s) => s.unit_price)) : null,
      thin_market: lastThree.length < 3,
      caveat: 'Not a Rule 13 comp: BrickLink sales have no links, and "used" mixes complete and incomplete sets.',
    },
    public_page: `https://www.bricklink.com/v2/catalog/catalogitem.page?${PUBLIC_PAGE_PARAM[type]}=${encodeURIComponent(item)}#T=P`,
  }, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Stop ? e.message : e.stack);
  process.exit(1);
}
