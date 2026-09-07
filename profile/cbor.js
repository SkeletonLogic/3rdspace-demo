/**
 * Deterministic CBOR (RFC 8949 §4.2.1), for the browser.
 *
 * WHY THIS FILE EXISTS AT ALL, since a second encoder is exactly the kind of
 * duplication that produces a signature bug nobody can reproduce:
 *
 *   - `src/core/cbor.ts` is TypeScript, and the client is vanilla ES modules
 *     served with no build step (`node src/host/swarm.ts` and nothing else).
 *     A browser cannot load the `.ts`.
 *   - Signing has to happen on the author's device and verification on the
 *     viewer's, so the encoder must exist in the browser. There is no way to
 *     push this to the host: the host is the adversary.
 *
 * The duplication is therefore unavoidable, and the response is to turn it into
 * a measured invariant instead of a hope. `src/tests/profile-page.test.ts`
 * encodes a corpus with BOTH encoders and asserts the outputs are byte-identical.
 * If they ever drift, that test fails before anything reaches a signature.
 *
 * Same rules as the TypeScript encoder: shortest-form integers, map keys sorted
 * by encoded bytes, no indefinite lengths, `undefined` properties omitted, and
 * floats always float64 so a value's representation never depends on how it was
 * computed.
 */

const enc = new TextEncoder();

function head(major, len) {
  const mt = major << 5;
  if (len < 24) return new Uint8Array([mt | len]);
  if (len < 0x100) return new Uint8Array([mt | 24, len]);
  if (len < 0x10000) return new Uint8Array([mt | 25, len >> 8, len & 255]);
  if (len < 0x100000000) {
    return new Uint8Array([mt | 26, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255]);
  }
  const b = new Uint8Array(9);
  b[0] = mt | 27;
  new DataView(b.buffer).setBigUint64(1, BigInt(len));
  return b;
}

function encodeNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
    return n >= 0 ? head(0, n) : head(1, -n - 1);
  }
  if (!Number.isFinite(n)) throw new Error('cbor: non-finite number');
  const b = new Uint8Array(9);
  b[0] = 0xfb;
  new DataView(b.buffer).setFloat64(1, n);
  return b;
}

function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function encode(v) {
  if (v === null) return new Uint8Array([0xf6]);
  if (typeof v === 'boolean') return new Uint8Array([v ? 0xf5 : 0xf4]);
  if (typeof v === 'number') return encodeNumber(v);
  if (typeof v === 'bigint') {
    if (v < 0n) throw new Error('cbor: negative bigint unsupported');
    const b = new Uint8Array(9);
    b[0] = 0x1b;
    new DataView(b.buffer).setBigUint64(1, v);
    return b;
  }
  if (typeof v === 'string') {
    const u = enc.encode(v);
    return concat([head(3, u.length), u]);
  }
  if (v instanceof Uint8Array) return concat([head(2, v.length), v]);
  if (Array.isArray(v)) return concat([head(4, v.length), ...v.map(encode)]);
  if (typeof v === 'object') {
    const entries = [];
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (val === undefined) continue; // absent, not null
      entries.push([encode(k), encode(val)]);
    }
    entries.sort((a, b) => cmpBytes(a[0], b[0]));
    return concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [k, val])]);
  }
  throw new Error(`cbor: unsupported value ${typeof v}`);
}

/** `"3rdspace/v1/" + type + 0x00 + payload`, matching `core/crypto.ts`. */
export function domainSep(type, payload) {
  return concat([enc.encode(`3rdspace/v1/${type}`), new Uint8Array([0]), payload]);
}

export function toHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(h) {
  const s = String(h);
  if (s.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
