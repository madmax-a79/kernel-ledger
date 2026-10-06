# Kernel ledger

Live at **https://kernelexperiment.com**

Static, single-page public ledger. `index.html` renders `ledger.json`. No backend, no build step. The git history of this repo is the audit trail: nothing is ever edited or deleted in place, so every commit is a public, timestamped append.

## Deploy

1. This repo is public and GitHub Pages serves it from branch `main`, folder `/ (root)`.
2. The `CNAME` file holds the domain, `kernelexperiment.com`. Its DNS (Cloudflare) has four A records and four AAAA records at `@` for GitHub Pages, and `www` as a CNAME to `madmax-a79.github.io`, all DNS only (not proxied), so GitHub can issue the HTTPS certificate; "Enforce HTTPS" is turned on once it has.
3. `ledger.json` → `meta`: `offer_form_url` is the Tally form (https://tally.so/r/KYbEzV); set `start_date` to the date of the Day 0 post.

Vercel or Netlify also work: import the repo, no build command, output directory `/`.

Local preview: `python3 -m http.server 8080` in this folder, then open http://localhost:8080. Opening `index.html` as a file will not load `ledger.json`.

## How Kernel appends (give it this routine once)

```
git clone https://github.com/madmax-a79/kernel-ledger.git
# 1. put new receipt files in receipts/, named receipts/E003-photo.jpg and so on
#    (photo, payment proof, listing screenshot: .jpg .jpeg .png .webp .gif .heic or .pdf;
#    names use letters, digits, ".", "_", "-", so rename "Screenshot 2026-… PM.png" first;
#    a screenshot of another person's Craigslist ad never goes in the repo: its link goes in "listing")
# 2. write the new line to a file holding one JSON object, e.g. E003.json
node scripts/append.mjs entries E003.json --dry-run   # checks it against the latest main
node scripts/append.mjs entries E003.json             # validates, commits "E003 sell …" with its receipts, pushes
```

`scripts/append.mjs` never edits existing lines. It inserts the new object as text just before the array's closing bracket and re-reads the file to prove nothing else changed, so each commit's diff is exactly one new line. It works for every log: `entries`, `interventions`, `manipulation`, `amendments`, `audits`. It refuses to run while tracked files have uncommitted changes (new receipt files are fine). It brings `main` up to date first; if someone else pushes first, it re-applies the line on top of theirs and retries, up to 3 times, then stops with an error. It never force-pushes. Dates are Vancouver calendar dates (`TZ=America/Vancouver date +%F`).

Three identities append, each only its own kind of line:

| Who | GitHub account | Appends | Flag |
|---|---|---|---|
| Kernel | `kernel-agent` | entries of any type except `check`; manipulation attempts | none |
| The Controller | `kernel-controller` | `check` entries only; manipulation attempts | `--controller` |
| The operator | `madmax-a79` | interventions, amendments, audit notes, retractions (and anything else) | `--operator` |

The two bots never share an account: a check is only independent if the Controller, not Kernel, pushed it. The script refuses `--operator` unless git's identity in that checkout is `madmax-a79`, and `--controller` unless it is `kernel-controller`; that only stops a bot trying, and the guard, which checks who actually pushed, is the enforcement.

Kernel and the Controller each push as their own GitHub account, collaborators on this repo. GitHub does not let a collaborator use a fine-grained token on another person's repo, so each bot's token is a **classic** token with only the `public_repo` scope, kept in a credential helper rather than in the clone URL. Neither may ever have the `workflow` scope: without it, GitHub refuses any push that touches `.github/workflows/`, so neither bot can weaken the guard below. Every push is public.

Every push to `main` runs the **append-only guard** (GitHub Actions), and it also runs daily. It fails, publicly, if any commit since the last checked one edits, removes or reorders an existing object in `entries`, `interventions`, `manipulation`, `amendments` or `audits`, leaves `ledger.json` invalid, or appends a line that breaks the rules below (the same rules as the script, so pushing by hand gains nothing). Each run checks everything since the last run that passed, so a push whose run was skipped, cancelled or deleted is caught by the next one, and a problem keeps failing every run until the operator acknowledges it (below). Pushes by the two bot accounts, as recorded in GitHub's push log, are held to the table above: `kernel-agent` may not append checks, `kernel-controller` may append nothing but checks and manipulation attempts, both may add new receipt files, and neither may touch `meta` or any other file. Editing or deleting an existing entry is a wall breach (Rule 12) and is visible in the commit history; corrections are new entries with `"type": "correction"`. The guard reports after a push, it does not stop one, so `main` is also protected against force pushes and deletion. Keep `main` linear: `git pull --rebase`, never a merge that interleaves two appends.

The Controller appends `"type": "check"` entries instead of touching Kernel's lines, as `kernel-controller` with `node scripts/append.mjs entries C002.json --controller`. The page shows the most recently appended check for each entry as its Controller status. While a line's latest check is `flagged`, it counts only against the value: its costs, and any death or reload, still count; its gains and estimates do not. A flag can therefore only lower Challenge Value, never raise it, until a later check verifies the line. Once a later correction of a flagged line has a latest check of `verified`, the page shows the flagged line as `superseded` instead of `flagged` and names that correction (Amendment 7). A later correction is one appended after the check that currently flags the line, correcting the same line: the flagged line itself or, if the flagged line is a correction, the line it corrects, through any chain of corrections. A correction verified before the flag doesn't count. Only the label changes: the line still counts as flagged.

A log line (intervention, manipulation attempt, amendment, audit note) that should never have been appended is retracted, not removed: the operator appends `{"date": "…", "retracts": <position, 0 = first>, "reason": "…"}` to the same log, and the page shows the original struck out with the reason.

The page computes running totals in the order lines were appended, so a new line never changes the figures already shown on earlier ones, except a Controller check, which changes how the line it checks (and everything after it) is counted.

If a commit ever breaks the rules, the history cannot be repaired, so the guard keeps failing until the operator records the breach in public: append to `interventions` (with `--operator`) `{"date": "…", "kind": "breach", "detail": "what happened", "acknowledges": "<full commit id>"}`; when one breach spans several commits, `acknowledges` lists their full ids: `["<id>", "<id>"]`. The guard then reports those commits' problems as acknowledged instead of failing. Only a standing operator line acknowledges: not a retracted line, not a retraction, and not a line a bot appended. `append.mjs` refuses an id that isn't a commit on main.

Selling a lot in parts: record each piece as its own buy, or, after selling part of a lot, record the rest as a new buy with `net_usd` 0 and its own `est_value_usd`. A sell closes one buy completely.

## Shipping quotes (Rule 13)

`node scripts/rate.mjs --from <post office postal code> --to US:90210 [--to CA:M5V2T6] --weight-g 850 --dims 30x20x10` asks Canada Post's rating API for counter (retail) rates and prints them, with the Rule 13 rate (each destination's cheapest service, then the highest across destinations), what to enter on Find a Rate, and a `shipping_quote` template. The Canada Post developer agreement treats API results as confidential, so the script writes nothing and its output is never committed: it is for Kernel's decisions and the Controller's checks. The public record is the Find a Rate screenshot and the figure it shows. It reads `CANADAPOST_API_KEY` (`username:password`) and `CANADAPOST_ENV` (`production` or `development`) from the environment; it needs Node.js 20 or later and no packages.

## BrickLink cross-check (LEGO)

`node scripts/comps.mjs --item 70779-1 [--type SET] [--condition used|new] [--days 60] [--currency USD] [--country US | --region north_america]` asks BrickLink's price guide API for the item's sales in the last six months and prints those within `--days`, newest first, with the lowest of the last three. BrickLink sales carry no links and "used" mixes complete and incomplete sets, so they cross-check Kernel's eBay sold comps and are never Rule 13 comps themselves. BrickLink's API terms forbid storing its data or showing it stale, so the script writes nothing and its output is never committed: it is for Kernel's decisions and the Controller's checks. When a line cites BrickLink, the public record is a screenshot of the item's public price guide page (the script prints its link); that page shows prices in the viewer's currency. It reads `BRICKLINK_CONSUMER_KEY`, `BRICKLINK_CONSUMER_SECRET`, `BRICKLINK_TOKEN` and `BRICKLINK_TOKEN_SECRET` from the environment; it needs Node.js 20 or later and no packages.

The term 'BrickLink' is a trademark of the LEGO Group BrickLink. This application uses the BrickLink API but is not endorsed or certified by LEGO BrickLink, Inc.

## eBay listings (Kernel) and the daily audit (Controller)

`scripts/ebay.mjs` lists, reprices and ends Kernel's eBay listings and reads its orders through eBay's Sell APIs, with a token that carries only two scopes: `sell.inventory` and `sell.fulfillment.readonly`.

```bash
node scripts/ebay.mjs list   --sku E004 --title "…" --price 24.99 --condition USED_GOOD --category 19006 \
                             --images https://kernelexperiment.com/receipts/E004-photo.jpg --description "…" [--aspect "Brand=LEGO"]
node scripts/ebay.mjs revise --sku E004 --price 19.99
node scripts/ebay.mjs end    --sku E004
node scripts/ebay.mjs orders [--since 2026-09-27]
node scripts/ebay.mjs log    --from 41 --hash <the head from the last review>    # the Controller, daily
node scripts/ebay.mjs audit                                                    # the Controller, daily
```

Limits:

- The SKU is the buy's ledger id. Only a buy the published ledger (main on GitHub) still holds can be listed: one unit, fixed price, no Best Offer.
- Nothing is listed or repriced below the buy's floor: the price that nets its `est_value_usd` after eBay's fee, `est_value_usd ÷ (1 − 0.15232)`, taking `est_value_usd` as last re-marked by a correction the Controller hasn't flagged. For a CAD listing, the floor is converted at the Bank of Canada's latest rate. The rate is eBay.ca's 13.6% final value fee for most categories (LEGO, cameras and tools among them) plus the 5% GST and 7% BC PST charged on that fee, which the operator can't recover: 13.6% × 1.12 = 15.232%. Books, films and music (15.3% on eBay) aren't covered; if Kernel ever lists them, the floor is revisited first. The rate is set in the script, so Kernel and the Controller's audit use the same one. To price lower, Kernel first appends a correction that re-marks the buy.
- `revise` changes only the price. `end` needs the SKU. Nothing ends or deletes listings in bulk.
- Every eBay call is appended to the call log `EBAY_CALL_LOG` before it is sent, and again with eBay's answer; so is every refusal. A call whose line can't be written isn't sent. Each line carries the hash of the line before it, so an edited line shows. (`exchange`, the operator's one-time token step, isn't logged.)
- Buyer data is never written anywhere. Orders are cut down in memory to SKUs, amounts and statuses before anything is printed. The log records only how many orders came back and their SKUs.

These limits cover calls made through the script. The token itself can do anything its two scopes allow, so the Controller checks eBay's own records every day:

- `log --from <n> --hash <h>` checks the chain from the head recorded at the last review and prints the new lines. Record the new head (`n` and `h`) in the day's check.
- `audit` lists every offer on the account and flags any listing that is below its floor, that the ledger doesn't hold, that isn't fixed-price and single-unit, that has Best Offer on, or that is missing from the call log or priced differently from it.

eBay's API License Agreement limits storing and redistributing what its APIs return, so the output is never committed. The ledger's receipts are screenshots of the listing and the order, with buyer details redacted (Rule 12).

Environment, from the bots' secret store:

- `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`
- `EBAY_MARKETPLACE`: `EBAY_CA` or `EBAY_US`
- `EBAY_PAYMENT_POLICY_ID`, `EBAY_RETURN_POLICY_ID`, `EBAY_FULFILLMENT_POLICY_ID`, `EBAY_LOCATION_KEY`
- `EBAY_CALL_LOG`: one path outside both clones that both bots can append to

The operator's one-time setup uses `consent-url` and `exchange --code …` (prints the refresh token; nothing is saved), which need `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `EBAY_RUNAME`, then `location`, which runs like the bots' commands, with the secret-store values above. The script needs Node.js 20 or later and no packages.

## Marketplace work (Rule 26)

`scripts/dealwork.mjs` lists open jobs on dealwork.ai and Kernel's own service listings and pending listing requests. Dry-run is the default: it writes the call log and sends no HTTP. `--live` performs the reads. A bid is sent only when `--bid` is also passed, and only for one job that is eligible and funded. There is no worker daemon and no auto-bidder. Paging (`--page N`, `--pages N`, `--all`) uses the API's `page` parameter: sequential GETs 1.5 s apart, each logged, stopping at an empty or short page, at `meta.total`, if the API reports `page` as ignored, or if a page repeats jobs; `--all` is capped at 25 pages.

```bash
node scripts/dealwork.mjs list                         # dry-run: no HTTP
node scripts/dealwork.mjs jobs --live                  # one page of open jobs
node scripts/dealwork.mjs jobs --live --pages 3        # pages 1-3 (or --page N for one page)
node scripts/dealwork.mjs jobs --live --all            # every page, read-only, one GET at a time
node scripts/dealwork.mjs listings --live              # Kernel's listings and pending requests
node scripts/dealwork.mjs jobs --live --bid --job <id> --amount 10.00 --proposal "..."
node scripts/dealwork.mjs link --job <id> --earn W001  # call log only; no HTTP
```

A job is funded only when escrow can cover every slot: `budgetMax` >= `fixedPrice` × `maxConcurrent`, `posterFunded` is true, and the job is not claim-blocked. The failure already seen is `budgetMax` < `fixedPrice` × `maxConcurrent` (dealwork calls that `underfunded`). Bid-mode jobs have no `fixedPrice` and `maxConcurrent`, so this script will not bid on them. Rule 26's filter is hardcoded: the five eligible kinds, and refusals for licensed advice (legal, tax, medical, financial), academic assignments, reviews or testimonials, impersonation, adult content, ongoing support, illegal work, crypto or tokens, scrapers, lead-gen, and anything that requires paying to obtain work. The script never pays to obtain work, never delivers, and never writes client identity into the call log.

Every marketplace HTTP call is appended to `WORK_CALL_LOG` (a path outside this repo; the same hash chain as the eBay call log) before it is sent, and again with the outcome. A funded job is logged as `{"marketplace":"dealwork.ai","job":"…","price":"40.00 USD","escrow":"funded"}`. `link` appends `{"marketplace":"dealwork.ai","job":"…","earn":"W001"}` only when a funded line for that job is already there and the filter marked the job eligible. Dealwork job amounts have no currency field; the platform wallet is USD, so a USD price is what the log records. A deliverable priced in CAD at or below C$25 is marked `deliver-without-review`. Any other price, including every USD price, is `needs-jay-review`. Nothing is delivered.

It reads `baseUrl` and `apiKey` from `~/.openwork/credentials.json` (`baseUrl` must be `https://dealwork.ai`). `DEALWORK_BASE_URL` may only name a local test server. The script needs Node.js 20 or later and no packages.

## Checking earn lines (Controller)

`node scripts/earncheck.mjs` is the Controller's read-only check of every `earn` line (Rule 26). It writes nothing and never calls a marketplace. For each line in the published ledger (main on GitHub; `--ledger ledger.json` checks a local file), it flags:

- a category that isn't one of Rule 26's five;
- price minus fee not equal to net;
- `net_usd` that doesn't match `net`;
- a CAD payout without `fx_date`, or whose `fx_usd_per_cad` isn't 1 ÷ the Bank of Canada's USD/CAD rate published on that date;
- no payout receipt file, or one that isn't in the repo;
- a client, customer or buyer field at any depth;
- no id, or no marketplace record before it.

The marketplace record comes from the marketplace call log (`WORK_CALL_LOG`, or `--calllog`, the same hash chain as the eBay call log). `scripts/dealwork.mjs` writes those lines.

- Exactly one of its lines links the earn line to a job: `{"marketplace": "…", "job": "…", "earn": "W001"}`.
- That job backs no other earn line.
- The same line or an earlier one records the job's agreed price and funded escrow: `{"marketplace": "…", "job": "…", "price": "40.00 USD", "escrow": "funded"}`.
- `marketplace` equals the earn line's, and both lines are dated (`at`) on or before the earn line's date.

Until those lines are in the call log, every earn line is flagged.

Every receipt that exists, files in the repo and links alike, is listed under `open`, because only a person or model looking at it can confirm the client's identity is covered. The check ends with the weekly pack's figures: Challenge Value, Traded and Earned, computed by the page's own code from this clone's `index.html`, so pull first. It exits with 0 when nothing is flagged, 1 when something is, and 2 when it couldn't check, for example because GitHub or the Bank of Canada didn't answer.

## Entry schema

Every entry needs `id`, `type`, `date`. Types: `buy`, `sell`, `pass`, `correction`, `death`, `reload`, `note`, `check`, `earn`.

```json
{
  "id": "E001",
  "type": "buy",
  "trade": 1,
  "date": "2026-09-30",
  "item": "LEGO 70779 Protector of Stone, complete, used",
  "amount_cad": 5.00,
  "fx_usd_per_cad": 0.7301,
  "amount_usd": 3.65,
  "net_usd": -3.65,
  "est_value_usd": 9.60,
  "comps": ["https://www.ebay.com/itm/...", "https://www.ebay.com/itm/...", "https://www.ebay.com/itm/..."],
  "receipts": ["receipts/E001-photo.jpg", "receipts/E001-etransfer.png"],
  "listing": "https://www.craigslist.org/...",
  "hours": 0.75,
  "km": 12,
  "memo": { "what": "", "why": "", "solds": "", "risk": "", "exit": "" }
}
```

Field rules:

- `fx_usd_per_cad` is 1 ÷ the Bank of Canada USD/CAD rate for the completion date. On a weekend or holiday, use the latest published rate and record its date as `fx_date`.
- `shipping_quote` records a Rule 13 shipping quote as shown on Canada Post's public [Find a Rate](https://www.canadapost-postescanada.ca/cpc/en/tools/find-a-rate.page) page, whose screenshot goes in `receipts`: `{"rate_cad": 18.45, "service": "Expedited Parcel USA", "quote_type": "counter", "weight_g": 850, "dims_cm": [30, 20, 10], "origin_fsa": "V5L", "destination": "US 90210", "date": "2026-09-28"}`. The origin is only its first three characters, and so is a Canadian destination (`"CA M5V"`).
- `net_usd` is the effect on cash: negative for a buy; for a sell it is gross minus `fees_usd` minus `shipping_usd`.
- `est_value_usd` (buys only) is the lowest of the three sold comps minus selling fees and shipping — the Rule 13 figure. The page counts held items at this number.
- A free item (Rule 7) is a `buy` at cost zero: `amount_cad` 0 and `net_usd` 0, with `est_value_usd` set by Rule 13 like any held item, the operator's time in `hours`, and its receipts as for any buy. It counts toward the two-item limit (Rule 10).
- A `sell` entry carries `"closes": "E001"` pointing at the buy it sells.
- A `correction` entry carries `"corrects": "E001"`, plus `net_usd` (cash delta, if any) and/or `est_value_usd` (new held value).
- A `death` entry zeroes cash and clears held items; a `reload` entry carries `"net_usd": 10`.
- A `check` entry (Controller) carries `"checks": "E001"`, `"status": "verified" | "flagged"`, and `"note"`.
- An `earn` entry (Rule 26) records pay for digital work delivered through an agent marketplace. It carries:
  - `marketplace`;
  - `category`, one of Rule 26's five: `"research and summaries"`, `"data cleanup"`, `"structured writing and editing"`, `"code and small automations"`, `"transcription and translation"`;
  - `currency` of the payout, `"USD"` or `"CAD"`;
  - `price`, `fee` and `net` in that currency, where `net` = `price` − `fee`;
  - `net_usd`, what reached the challenge wallet: equal to `net` for USD, `net` × `fx_usd_per_cad` for CAD, with `fx_date` the date of that Bank of Canada rate;
  - the payout receipt as a `receipts/` file;
  - optionally a `title` and a `memo`.

  It never names the client: no field called client, customer or buyer, at any depth or capitalization (`memo.clientName` counts).

  ```json
  {"id": "W001", "type": "earn", "date": "2026-10-05", "title": "Cleaned a 2,000-row product CSV", "marketplace": "…", "category": "data cleanup", "currency": "USD", "price": 40.00, "fee": 8.00, "net": 32.00, "net_usd": 32.00, "receipts": ["receipts/W001-payout.png"]}
  ```
- `interventions`, `manipulation`, `amendments` and `audits` are separate arrays at the top level; the operator appends interventions, Kernel or the Controller appends manipulation attempts, the operator appends amendments, the auditor's notes are appended by the operator.

`scripts/append.mjs` and the guard enforce these: `id` is letters, digits, `.`, `_`, `-` and unique; a `sell` closes a `buy` that is not already sold; a `buy` has `net_usd` of 0 or less and an `est_value_usd`; only `buy`, `sell`, `correction`, `reload` and `earn` carry `net_usd`; an `earn` adds cash (`net_usd` above 0) in one of Rule 26's categories, with `net` = `price` − `fee`, `net_usd` matching `net` (at `fx_usd_per_cad` for CAD, which also needs `fx_date`), its payout receipt as a file, no `trade`, no `est_value_usd`, and no client, customer or buyer field at any depth or capitalization; a correction's `est_value_usd` re-marks a buy that is still held; a `death` happens only while alive and within the lives; a `reload` follows a `death` and carries the starting $10; a `check` names an existing entry and a status; a line is never dated before the entry it closes, corrects or checks, nor before `start_date`; amounts are numbers, none below zero except `net_usd`; `trade` goes up by at most one; dates are real and not in the future (Vancouver time); `comps` and `listing` are http(s) links; receipts are http(s) links or files named `receipts/<name>.jpg` (or `.jpeg`, `.png`, `.webp`, `.gif`, `.heic`, `.pdf`, any case) that are in the same commit, never replacing an existing one; no control or bidirectional-override characters. Log lines need the fields the page shows: interventions `date`, `kind`, `detail`; manipulation `date`, `channel`, `summary`; amendments `version` (like `"1.1"`), `date`, `summary`; audits `date`, `note`.

The Challenge Value on the page is computed from the entries: cash (start $10, plus every `net_usd`, plus reloads) plus held items at `est_value_usd`. If the page and Kernel's own number disagree, the page is right and Kernel's memo is wrong.

Under the Challenge Value, the page splits it in two, as Rule 13 requires.

- **Earned** is the `net_usd` of the current life's `earn` lines, plus corrections to them.
- **Traded** is the rest: the Challenge Value minus Earned. It includes the starting $10 and everything trading made or lost, even when trading used earned money.

The two always add up to the Challenge Value. A death clears both, like everything else in that life. A flagged `earn` counts for nothing until a later check verifies it.
