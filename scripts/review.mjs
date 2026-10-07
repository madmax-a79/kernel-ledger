#!/usr/bin/env node
// The operator's side of the C$25 review gate (Rule 26). Run it on the operator's Mac, never on the bots' machine.
//
//   node scripts/review.mjs keygen
//       Once. Makes the signing key: the private half stays on this Mac (KERNEL_REVIEW_KEY, default
//       ~/.kernel/review-key.pem) and the public half goes to keys/review.pub, which you commit and push. Prints the
//       public key's fingerprint, which the weekly dealwork audit takes as REVIEW_KEY_SHA256.
//   node scripts/review.mjs approve --contract <id> --file <deliverable> --description-file <description.txt>
//       [--marketplace dealwork.ai]
//       Prints a token that approves exactly this file, under this name, with this description, for this contract.
//       Kernel sends both as attachments, with their SHA-256s; check that both hashes this prints match, then send
//       Kernel the token. Never paste Kernel's text into a shell command: it could run there.
//   node scripts/review.mjs fingerprint
//       Prints the fingerprint of keys/review.pub in this clone.
//
// The review is veto-only: approve unless the deliverable is illegal, unsafe, or breaks the constitution or the
// marketplace's terms. A refusal is a veto: don't approve, and log it as an intervention.

import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PUBLIC_KEY_FILE, normalizeText, publicKeyFingerprint, sha256, signApproval } from './approval.mjs';

class Stop extends Error {}
const fail = (msg) => { throw new Stop(msg); };
const PRIVATE = process.env.KERNEL_REVIEW_KEY || path.join(homedir(), '.kernel', 'review-key.pem');
const USAGE = 'usage: node scripts/review.mjs keygen | fingerprint | approve --contract <id> --file <deliverable> --description-file <description.txt> [--marketplace dealwork.ai]';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = { keygen: [], fingerprint: [], approve: ['contract', 'file', 'description-file', 'marketplace'] }[cmd];
  if (!flags) fail(USAGE);
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = String(rest[i]).replace(/^--/, '');
    if (!String(rest[i]).startsWith('--') || !flags.includes(k) || rest[i + 1] == null) fail(`${cmd} takes ${flags.map((f) => '--' + f).join(' ') || 'no flags'}`);
    if (Object.hasOwn(opts, k)) fail(`--${k} given twice`);
    opts[k] = rest[i + 1];
  }
  return { cmd, opts };
}

function keygen() {
  if (existsSync(PRIVATE)) fail(`${PRIVATE} already exists. To replace the key, delete it first, then commit the new keys/review.pub.`);
  // A new key invalidates every approval signed with the old one, so an existing public key is never replaced
  // quietly (for example when KERNEL_REVIEW_KEY points somewhere new).
  if (existsSync(PUBLIC_KEY_FILE)) fail(`${PUBLIC_KEY_FILE} already exists, so a review key is already in use. To replace it, delete that file and the old private key on purpose, then run keygen again, commit the new keys/review.pub and give the Controller the new fingerprint.`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(path.dirname(PRIVATE), { recursive: true, mode: 0o700 });
  writeFileSync(PRIVATE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  mkdirSync(path.dirname(PUBLIC_KEY_FILE), { recursive: true });
  writeFileSync(PUBLIC_KEY_FILE, publicKey.export({ type: 'spki', format: 'pem' }));
  return {
    private_key: PRIVATE, public_key: PUBLIC_KEY_FILE, fingerprint: publicKeyFingerprint(),
    then: 'Commit and push keys/review.pub (git add keys/review.pub && git commit -m "Review key" && git push). Note the fingerprint: the weekly dealwork audit, on this Mac, takes it as REVIEW_KEY_SHA256. Keep the private key on this Mac only.',
  };
}

function approve(o) {
  if (!o.contract || !o.file || !o['description-file']) fail('approve needs --contract, --file and --description-file (the description Kernel will send, as the file it sent you)');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(o.contract)) fail('--contract must be the contract id');
  if (!existsSync(PRIVATE)) fail(`no private key at ${PRIVATE}; run keygen first`);
  let data;
  try { data = readFileSync(o.file); } catch (e) { fail(`cannot read ${o.file}: ${e.code || e.message}`); }
  let raw;
  try { raw = readFileSync(o['description-file']); } catch (e) { fail(`cannot read ${o['description-file']}: ${e.code || e.message}`); }
  const decoded = raw.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(raw)) fail('--description-file must be UTF-8 text');
  const description = normalizeText(decoded);
  // The same limits deliver puts on a description.
  if (!description || description.length > 500) fail('the description must be 1 to 500 characters');
  if (/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(description)) fail('the description has control characters');
  const name = path.basename(o.file);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) fail('the file\'s name may use letters, digits, ".", "_" and "-" only, as deliver requires; don\'t approve it, and log it as a possible manipulation');
  const hash = sha256(data);
  const token = signApproval({ marketplace: o.marketplace || 'dealwork.ai', contract: o.contract, sha256: hash, name, description_sha256: sha256(description) }, createPrivateKey(readFileSync(PRIVATE)));
  return {
    contract: o.contract, file: name, sha256: hash, description, description_sha256: sha256(description), approval: token,
    then: 'Check that sha256 and description_sha256 both match what Kernel sent; if either differs, ask again. Then send Kernel the approval. It works only for this exact file, under this name, with this description.',
  };
}

try {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const out = cmd === 'keygen' ? keygen() : cmd === 'fingerprint' ? { public_key: PUBLIC_KEY_FILE, fingerprint: publicKeyFingerprint() ?? fail(`no ${PUBLIC_KEY_FILE}`) } : approve(opts);
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e instanceof Stop ? e.message : e.stack);
  process.exit(1);
}
