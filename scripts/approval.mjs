// Approval tokens for the C$25 review gate (Rule 26). The operator signs, with a key only he holds, that he let
// exactly this deliverable go for this contract on this marketplace: the file's bytes (SHA-256), its name, and the
// description sent with it. keys/review.pub, in the repo, verifies it; the weekly audit also checks that file
// against the operator's fingerprint. Used by scripts/review.mjs (signing, on the operator's Mac) and
// scripts/dealwork.mjs (checking).

import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLIC_KEY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'keys', 'review.pub');

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
// How a description is compared on both sides: line endings made \n, then trimmed.
export const normalizeText = (v) => String(v).replace(/\r\n?/g, '\n').trim();

// A token: base64url(JSON payload) + "." + base64url(Ed25519 signature over that first part).
export function signApproval({ marketplace, contract, sha256: hash, name, description_sha256 }, privateKey) {
  const payload = b64u(JSON.stringify({ v: 2, marketplace, contract, sha256: hash, name, description_sha256, at: new Date().toISOString() }));
  return `${payload}.${b64u(sign(null, Buffer.from(payload), privateKey))}`;
}

// null when the token approves exactly this marketplace, contract, file, name and description; otherwise what is
// wrong with it.
export function verifyApproval(token, { marketplace, contract, sha256: hash, name, description_sha256 }, publicKeyPem) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return 'the approval is not a token from scripts/review.mjs';
  const [payload, sig] = token.split('.');
  let p;
  try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return 'the approval cannot be read'; }
  let ok = false;
  try { ok = verify(null, Buffer.from(payload), createPublicKey(publicKeyPem), Buffer.from(sig, 'base64url')); } catch { ok = false; }
  if (!ok) return 'the approval is not signed with the operator\'s review key';
  if (p?.v !== 2) return 'the approval is from an older version of scripts/review.mjs; ask the operator for a new one';
  if (p.marketplace !== marketplace || p.contract !== contract) return `the approval is for ${p?.marketplace} contract ${p?.contract}, not ${marketplace} contract ${contract}`;
  if (p.sha256 !== hash) return 'the approval is for a different file: the deliverable changed after it was approved';
  if (p.name !== name) return `the approval is for a file named ${JSON.stringify(p.name)}, not ${JSON.stringify(name)}`;
  if (p.description_sha256 !== description_sha256) return 'the approval is for a different description: the text sent with the deliverable changed after it was approved';
  return null;
}

export function publicKey(file = PUBLIC_KEY_FILE) {
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

// The fingerprint the operator pins for the audit (REVIEW_KEY_SHA256): SHA-256 of keys/review.pub's bytes.
export function publicKeyFingerprint(file = PUBLIC_KEY_FILE) {
  return existsSync(file) ? sha256(readFileSync(file)) : null;
}
