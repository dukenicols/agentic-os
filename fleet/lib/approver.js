'use strict';
// The human's approval credential for the fleet UI: a passphrase stored only as an scrypt hash in
// $FLEET_HOME/approver.json (0600). Agents can read that file but can't turn it back into the passphrase.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;
const MIN_LENGTH = 12;

const approverPath = (home) => path.join(home, 'approver.json');

function scrypt(passphrase, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(passphrase).normalize('NFC'), salt, keylen, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

async function hashPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_LENGTH) {
    throw new Error(`passphrase must be at least ${MIN_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(passphrase, salt, PARAMS);
  return { algo: 'scrypt', ...PARAMS, salt: salt.toString('base64'), hash: key.toString('base64'), createdAt: new Date().toISOString() };
}

function writeApprover(home, record) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = approverPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/** The stored credential, or null if none is configured (the UI then refuses every action). */
function loadApprover(home) {
  try {
    const r = JSON.parse(fs.readFileSync(approverPath(home), 'utf8'));
    if (r.algo !== 'scrypt' || !r.salt || !r.hash || !r.N || !r.r || !r.p || !r.keylen) return null;
    return r;
  } catch {
    return null;
  }
}

async function verifyPassphrase(record, passphrase) {
  if (!record || typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const key = await scrypt(passphrase, Buffer.from(record.salt, 'base64'), record);
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** At most `max` failures per `windowMs`; once exceeded, everything is refused until the window passes. */
class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { max, windowMs, now, failures: [] });
  }

  prune() {
    const cutoff = this.now() - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  blocked() {
    this.prune();
    return this.failures.length >= this.max;
  }

  retryAfterSeconds() {
    this.prune();
    return this.failures.length ? Math.ceil((this.failures[0] + this.windowMs - this.now()) / 1000) : 0;
  }

  fail() {
    this.failures.push(this.now());
  }

  /**
   * Reserve an attempt *before* the (slow, async) verification, so a parallel burst can't slip past
   * blocked() while earlier guesses are still being checked. Returns a function that gives the slot
   * back if the attempt turns out to be valid.
   */
  reserve() {
    const t = this.now();
    this.failures.push(t);
    return () => {
      const i = this.failures.lastIndexOf(t);
      if (i >= 0) this.failures.splice(i, 1);
    };
  }
}

module.exports = { hashPassphrase, verifyPassphrase, loadApprover, writeApprover, approverPath, RateLimiter, MIN_LENGTH };
