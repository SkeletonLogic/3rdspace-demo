/**
 * Signing and verifying a profile page.
 *
 * Profile pages are published data served by an untrusted host, so they are a
 * new channel in the threat model and they get the same treatment as every
 * other one: signed by the author's existing Ed25519 key over deterministic
 * CBOR bytes, with domain separation, and verified on the VIEWER's device
 * before anything is rendered.
 *
 * What this buys, concretely: the node serving the bytes cannot edit somebody's
 * page, cannot swap their photo (the image bytes are inside the signature), and
 * cannot forge one. What it does not buy: the node can still refuse to serve a
 * page at all — which is why removal is a log entry (see `core/page.ts`) rather
 * than a silent absence.
 */

import { encode, domainSep, toHex, fromHex } from './cbor.js';

export const PAGE_MAGIC = '3rdspace-profile-page';
export const SIG_TYPE = 'profile-page';

/**
 * The exact bytes both sides sign.
 *
 * Assets are a sorted array of triples rather than a map, so the encoding does
 * not depend on anyone's object key order — the CBOR encoder sorts map keys
 * anyway, and this makes the invariant visible instead of load-bearing.
 * `src/core/page.ts` builds the identical structure, and a test asserts the two
 * encoders agree byte for byte.
 */
export function canonicalPage(page) {
  const assets = Object.entries(page.assets ?? {})
    .map(([hash, a]) => [String(hash).toLowerCase(), String(a.type ?? ''), String(a.data ?? '')])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return {
    v: page.v ?? 1,
    author: String(page.author ?? ''),
    updatedAt: Math.floor(Number(page.updatedAt ?? 0)),
    theme: String(page.theme ?? ''),
    title: String(page.title ?? ''),
    html: String(page.html ?? ''),
    css: String(page.css ?? ''),
    assets,
  };
}

export function pageBytesToSign(page) {
  return domainSep(SIG_TYPE, encode(canonicalPage(page)));
}

/** Is Ed25519 available in this browser's WebCrypto? Chrome 137+, Safari 17+. */
export async function ed25519Available() {
  try {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return !!kp;
  } catch {
    return false;
  }
}

/**
 * Sign a page with a 32-byte Ed25519 seed, hex — the same `identity.sk` the
 * profile file already carries.
 */
export async function signPage(page, skHex, pkHex) {
  const key = await importPrivate(skHex);
  const bytes = pageBytesToSign({ ...page, author: pkHex });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, bytes));
  return {
    magic: PAGE_MAGIC,
    v: page.v ?? 1,
    author: pkHex,
    updatedAt: page.updatedAt ?? Date.now(),
    theme: page.theme ?? '',
    title: page.title ?? '',
    html: page.html ?? '',
    css: page.css ?? '',
    assets: page.assets ?? {},
    sig: toHex(sig),
  };
}

/**
 * Verify a page as received.
 *
 * Every failure is a distinct, displayable state. "Could not check this" and
 * "this was tampered with" are not the same claim, and collapsing them would be
 * the sort of quiet imprecision the rest of this codebase refuses.
 *
 * @returns {{ ok: boolean, state: string, detail: string }}
 */
export async function verifyPage(blob, expectAuthor) {
  if (!blob || blob.magic !== PAGE_MAGIC) {
    return { ok: false, state: 'not-a-page', detail: 'that is not a profile page' };
  }
  if (typeof blob.sig !== 'string' || !/^[0-9a-f]{128}$/i.test(blob.sig)) {
    return { ok: false, state: 'unsigned', detail: 'the page carries no usable signature' };
  }
  if (expectAuthor && blob.author !== expectAuthor) {
    return {
      ok: false, state: 'wrong-author',
      detail: `the page is signed by ${String(blob.author).slice(0, 12)}… but was served as ${String(expectAuthor).slice(0, 12)}…`,
    };
  }
  let key;
  try { key = await importPublic(blob.author); }
  catch { return { ok: false, state: 'bad-key', detail: 'the author key on this page is not a valid Ed25519 key' }; }

  const okSig = await crypto.subtle.verify(
    { name: 'Ed25519' }, key, fromHex(blob.sig), pageBytesToSign(blob),
  );
  if (!okSig) {
    return {
      ok: false, state: 'bad-signature',
      detail: 'the signature does not match these bytes — the page was changed after it was signed, and the node serving it is the only party that could have done that',
    };
  }

  for (const [hash, a] of Object.entries(blob.assets ?? {})) {
    const actual = await sha256OfBase64(a.data ?? '');
    if (actual !== String(hash).toLowerCase()) {
      return {
        ok: false, state: 'asset-mismatch',
        detail: `an image in this page does not match the name it is filed under (${String(hash).slice(0, 10)}…)`,
      };
    }
  }
  return { ok: true, state: 'verified', detail: 'signed by the author, and unchanged since' };
}

async function sha256OfBase64(b64) {
  const { fromBase64 } = await import('./images.js');
  const h = await crypto.subtle.digest('SHA-256', fromBase64(b64));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// WebCrypto wants PKCS#8 and SPKI wrappers; the raw 32 bytes are what the rest
// of the codebase stores, so the fixed DER prefixes live here. Same constants as
// `core/crypto.ts`, for the same reason.
const PKCS8_PREFIX = fromHex('302e020100300506032b657004220420');
const SPKI_PREFIX = fromHex('302a300506032b6570032100');

function importPrivate(skHex) {
  const seed = fromHex(skHex);
  if (seed.length !== 32) throw new Error('secret key must be 32 bytes');
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX, 0);
  der.set(seed, PKCS8_PREFIX.length);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
}

function importPublic(pkHex) {
  const raw = fromHex(pkHex);
  if (raw.length !== 32) throw new Error('public key must be 32 bytes');
  // 'raw' import is the interoperable path and is what Node and Chrome both
  // accept; the SPKI form is kept as a fallback for engines that refuse 'raw'.
  return crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    .catch(() => {
      const der = new Uint8Array(SPKI_PREFIX.length + 32);
      der.set(SPKI_PREFIX, 0);
      der.set(raw, SPKI_PREFIX.length);
      return crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    });
}
