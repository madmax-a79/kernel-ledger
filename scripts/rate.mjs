#!/usr/bin/env node
// Canada Post quoted parcel rates, for Kernel's decisions and the Controller's checks.
//
//   node scripts/rate.mjs --from V5L3X4 --to US:90210 [--to CA:M5V2T6] [--to GB] --weight-g 850 --dims 30x20x10 [--service DOM.EP,USA.EP]
//
//   --from     origin postal code in full (use the drop-off post office's, never a home address)
//   --to       CA:<postal code>, US:<ZIP>, or a two-letter country code; repeat for several
//   --weight-g parcel weight in grams (at most 30000)
//   --dims     length x width x height in cm, any order
//   --service  only these service codes (default: every service offered)
//
// Private by design. The Canada Post developer agreement treats what the API returns as
// confidential, so this prints to the terminal and writes nothing: never commit or publish its
// output. The public evidence is a screenshot of Canada Post's Find a Rate page for the same
// parcel, and the ledger's "shipping_quote" records the figure shown there (Rule 13).
//
// Environment, from the bot's secret store:
//   CANADAPOST_API_KEY  the API key as "username:password"
//   CANADAPOST_ENV      "production" (default) or "development"; must match the key

const FIND_A_RATE = 'https://www.canadapost-postescanada.ca/cpc/en/tools/find-a-rate.page';
const HOSTS = { production: 'https://soa-gw.canadapost.ca', development: 'https://ct.soa-gw.canadapost.ca' };
const MEDIA = 'application/vnd.cpc.ship.rate-v4+xml';
const NS = 'http://www.canadapost.ca/ws/ship/rate-v4';
const POSTAL = /^[A-Z]\d[A-Z]\d[A-Z]\d$/;

class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };

function parseArgs(argv) {
  const opts = { to: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--from', '--to', '--weight-g', '--dims', '--service'].includes(flag) || value == null) {
      fail('usage: node scripts/rate.mjs --from V5L3X4 --to US:90210 [--to ...] --weight-g 850 --dims 30x20x10 [--service DOM.EP]');
    }
    if (flag === '--to') opts.to.push(value); else opts[flag.slice(2)] = value;
    i++;
  }
  return opts;
}

const postal = (v, what) => {
  const p = String(v).toUpperCase().replace(/\s+/g, '');
  if (!POSTAL.test(p)) fail(`${what} must be a Canadian postal code like V5L3X4, not ${JSON.stringify(v)}`);
  return p;
};

// A destination for the API, and how the ledger may show it (postal codes cut to their first three characters).
function destination(v) {
  const [kind, rest] = String(v).includes(':') ? String(v).split(/:(.*)/) : [String(v), ''];
  const k = kind.toUpperCase();
  if (k === 'CA') {
    const p = postal(rest, '--to CA:');
    return { xml: `<domestic><postal-code>${p}</postal-code></domestic>`, public: `CA ${p.slice(0, 3)}`, enter: p };
  }
  if (k === 'US') {
    if (!/^\d{5}(-\d{4})?$/.test(rest)) fail(`--to US: needs a ZIP code like 90210, not ${JSON.stringify(rest)}`);
    return { xml: `<united-states><zip-code>${rest}</zip-code></united-states>`, public: `US ${rest.slice(0, 5)}`, enter: rest };
  }
  if (/^[A-Z]{2}$/.test(k) && !rest) return { xml: `<international><country-code>${k}</country-code></international>`, public: k, enter: k };
  fail(`--to must be CA:<postal code>, US:<ZIP> or a two-letter country code, not ${JSON.stringify(v)}`);
}

const tag = (xml, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml); return m ? m[1].trim() : null; };
const money = (s) => (s == null || s === '' ? null : Math.round(Number(s) * 100) / 100);

async function quote(base, key, body) {
  let r;
  try {
    r = await fetch(`${base}/rs/ship/price`, {
      method: 'POST',
      headers: { accept: MEDIA, 'content-type': MEDIA, 'accept-language': 'en-CA', authorization: 'Basic ' + Buffer.from(key).toString('base64') },
      body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    fail(`could not reach Canada Post: ${e.cause?.code || e.message}`);
  }
  const xml = await r.text();
  if (!r.ok) {
    const messages = [...xml.matchAll(/<message>([\s\S]*?)<\/message>/g)].map((m) => `${tag(m[1], 'code')}: ${tag(m[1], 'description')}`);
    if (r.status === 401 || r.status === 403) fail(`Canada Post refused the key (HTTP ${r.status}); check CANADAPOST_API_KEY and that CANADAPOST_ENV matches it${messages.length ? '\n' + messages.join('\n') : ''}`);
    fail(`Canada Post answered HTTP ${r.status}${messages.length ? ':\n' + messages.join('\n') : ''}`);
  }
  return [...xml.matchAll(/<price-quote>([\s\S]*?)<\/price-quote>/g)].map(([, q]) => {
    const taxes = ['gst', 'pst', 'hst'].reduce((sum, t) => sum + (money(tag(q, t)) || 0), 0);
    const transit = tag(q, 'expected-transit-time');
    return {
      service_code: tag(q, 'service-code'),
      service_name: tag(q, 'service-name'),
      base_cad: money(tag(q, 'base')),
      taxes_cad: Math.round(taxes * 100) / 100,
      due_cad: money(tag(q, 'due')),
      transit_days: transit == null || transit === '' ? null : Number(transit),
      expected_delivery: tag(q, 'expected-delivery-date'),
    };
  });
}

// Today's date in Vancouver, where the operator's clock runs.
function today() {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.from || !opts.to.length || !opts['weight-g'] || !opts.dims) fail('--from, --to, --weight-g and --dims are all required');
  const from = postal(opts.from, '--from');
  const weightG = Number(opts['weight-g']);
  if (!Number.isInteger(weightG) || weightG <= 0 || weightG > 30000) fail('--weight-g must be a whole number of grams, at most 30000');
  const dims = String(opts.dims).toLowerCase().split('x').map(Number);
  if (dims.length !== 3 || !dims.every((d) => Number.isFinite(d) && d > 0 && d <= 300)) fail('--dims must be length x width x height in cm, e.g. 30x20x10');
  dims.sort((a, b) => b - a); // Canada Post wants the longest side as length, the shortest as height
  const services = opts.service ? opts.service.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  const tos = opts.to.map(destination);

  const key = process.env.CANADAPOST_API_KEY || '';
  if (!/^[^:\s]+:[^\s]+$/.test(key)) fail('CANADAPOST_API_KEY must be set to the API key as "username:password" (from the secret store)');
  const env = process.env.CANADAPOST_ENV || 'production';
  if (!HOSTS[env]) fail('CANADAPOST_ENV must be "production" or "development"');
  // Tests may point at a local stand-in; anything else must be one of Canada Post's own hosts.
  const base = process.env.CANADAPOST_BASE_URL || HOSTS[env];
  if (!Object.values(HOSTS).includes(base) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) fail('CANADAPOST_BASE_URL may only name a local test server');

  const parcel = `<parcel-characteristics><weight>${(weightG / 1000).toFixed(3)}</weight><dimensions><length>${dims[0].toFixed(1)}</length><width>${dims[1].toFixed(1)}</width><height>${dims[2].toFixed(1)}</height></dimensions></parcel-characteristics>`;
  const destinations = [];
  for (const to of tos) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><mailing-scenario xmlns="${NS}"><quote-type>counter</quote-type>${parcel}<origin-postal-code>${from}</origin-postal-code><destination>${to.xml}</destination></mailing-scenario>`;
    const quotes = (await quote(base, key, body)).filter((q) => !services || services.includes(q.service_code));
    destinations.push({ to: to.public, enter: to.enter, quotes });
  }

  // Rule 13: each destination's cheapest offered service, then the highest of those across destinations.
  const cheapest = destinations.map((d) => ({ to: d.to, enter: d.enter, q: d.quotes.filter((q) => q.due_cad != null).sort((a, b) => a.due_cad - b.due_cad)[0] }));
  if (cheapest.some((c) => !c.q)) fail(`no ${services ? 'matching ' : ''}service quoted for ${cheapest.filter((c) => !c.q).map((c) => c.to).join(', ')}`);
  const used = cheapest.sort((a, b) => b.q.due_cad - a.q.due_cad)[0];
  const date = today();

  console.log(JSON.stringify({
    private: 'Canada Post API data for Kernel and the Controller only. Never commit or publish it; publish the Find a Rate screenshot and its figure instead.',
    quoted_at: new Date().toISOString(),
    quote_type: 'counter',
    origin_fsa: from.slice(0, 3),
    parcel: { weight_g: weightG, dims_cm: dims },
    destinations: destinations.map(({ to, quotes }) => ({ to, quotes })),
    rule13: { to: used.to, service_code: used.q.service_code, service_name: used.q.service_name, due_cad: used.q.due_cad },
    find_a_rate: {
      page: FIND_A_RATE,
      enter: { from, to: used.enter, weight_kg: weightG / 1000, length_cm: dims[0], width_cm: dims[1], height_cm: dims[2] },
      then: `Screenshot the result showing ${used.q.service_name}, save it as receipts/<entry id>-rate.png, and copy its price into rate_cad.`,
    },
    ledger_shipping_quote: {
      rate_cad: '<price shown on Find a Rate>',
      service: used.q.service_name,
      quote_type: 'counter',
      weight_g: weightG,
      dims_cm: dims,
      origin_fsa: from.slice(0, 3),
      destination: used.to,
      date,
    },
  }, null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (e) {
  console.error(e instanceof Stop ? e.message : e.stack);
  process.exit(1);
}
