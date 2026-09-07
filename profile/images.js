/**
 * Image import: metadata stripping, re-encoding, capping, and content-hash
 * deduplication.
 *
 * THE BUG THIS EXISTS TO PREVENT. Phone photos carry EXIF, and EXIF carries
 * GPS. A dating profile that leaks the author's home coordinates is the worst
 * thing this project could ship, and it is completely silent: the photo looks
 * right, the page looks right, and the coordinates are sitting in the bytes.
 * So EXIF is stripped on every import, without asking, and there is no setting
 * to turn it off.
 *
 * TWO LAYERS, ON PURPOSE:
 *
 *  1. `stripMetadata` works on the BYTES, in pure JavaScript, with no browser
 *     involved. It is the layer that can be tested — `node --test` feeds it a
 *     JPEG with a GPS-bearing APP1 segment and asserts the segment is gone —
 *     which is the difference between a claim and a wish.
 *  2. `reencode` draws the image to a canvas and asks the browser to re-encode
 *     it. A canvas has no metadata to carry, so this is a second, independent
 *     removal, and it is also how the size cap is met. It only runs in a
 *     browser, so it cannot be the layer the guarantee rests on.
 *
 * Images are addressed by the SHA-256 of their final bytes. Two blocks using
 * the same photo store it once, and — because the hash is inside the signed
 * document — a host cannot swap somebody's photo for another one.
 */

/** Per-image cap after re-encoding. */
export const MAX_IMAGE_BYTES = 256 * 1024;
/** Longest edge after re-encoding. 1600 keeps a phone photo sharp on a phone. */
export const MAX_IMAGE_EDGE = 1600;
/** Total budget for one page's images. */
export const MAX_PAGE_ASSET_BYTES = 1_500_000;
export const MAX_ASSETS = 12;

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ------------------------------------------------------------ base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Chunked so a multi-megabyte image does not blow the argument limit. */
export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

export function fromBase64(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (clean[i + 2] !== undefined && o < out.length) out[o++] = (n >> 8) & 255;
    if (clean[i + 3] !== undefined && o < out.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

export async function sha256Hex(bytes) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// -------------------------------------------------------- format sniffing

export function sniffType(bytes) {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b.length > 6 && str(b, 0, 3) === 'GIF') return 'image/gif';
  return null;
}

function str(b, at, n) {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

// -------------------------------------------------------- the byte stripper

/**
 * Remove every metadata container the format allows, in the bytes themselves.
 *
 * @returns {{ bytes: Uint8Array, type: string|null, removed: string[] }}
 *          `removed` names each container dropped, so the editor can tell the
 *          author what came off their photo instead of doing it silently.
 */
export function stripMetadata(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const type = sniffType(bytes);
  if (type === 'image/jpeg') return { ...stripJpeg(bytes), type };
  if (type === 'image/png') return { ...stripPng(bytes), type };
  if (type === 'image/webp') return { ...stripWebp(bytes), type };
  if (type === 'image/gif') return { ...stripGif(bytes), type };
  return { bytes, type, removed: [] };
}

const JPEG_MARKER_NAMES = {
  0xe0: 'APP0/JFIF', 0xe1: 'APP1 (EXIF or XMP)', 0xe2: 'APP2 (ICC colour profile)',
  0xed: 'APP13 (IPTC/Photoshop)', 0xee: 'APP14 (Adobe)', 0xfe: 'comment',
};

/**
 * JPEG: keep the frame, the tables and the scan. Drop every APPn and every COM.
 *
 * APP1 is where EXIF lives, and EXIF is where GPS lives. APP0/JFIF is kept only
 * when it is a real JFIF header, because some encoders need it. The ICC profile
 * in APP2 is dropped too: it is not a location leak, but it is a fingerprintable
 * blob, and losing colour management on a profile photo is a fair trade.
 */
function stripJpeg(b) {
  const removed = [];
  const out = [b.subarray(0, 2)]; // SOI
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) { out.push(b.subarray(i)); i = b.length; break; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) break;
    const seg = b.subarray(i, i + 2 + len);

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isCom = marker === 0xfe;
    const isJfif = marker === 0xe0 && str(seg, 4, 4) === 'JFIF';

    if ((isApp && !isJfif) || isCom) {
      removed.push(JPEG_MARKER_NAMES[marker] ?? `APP${marker - 0xe0}`);
    } else {
      out.push(seg);
    }

    if (marker === 0xda) { // start of scan: entropy data to the end
      out.push(b.subarray(i + 2 + len));
      i = b.length;
      break;
    }
    i += 2 + len;
  }
  return { bytes: concat(out), removed: [...new Set(removed)] };
}

/** PNG: an allow-list of chunks. Everything ancillary that can carry text goes. */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'acTL', 'fcTL', 'fdAT']);

function stripPng(b) {
  const removed = [];
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 8 <= b.length) {
    const len = (b[i] << 24 >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
    const type = str(b, i + 4, 4);
    const total = 12 + len;
    if (len < 0 || i + total > b.length) break;
    if (PNG_KEEP.has(type)) out.push(b.subarray(i, i + total));
    else removed.push(`${type} chunk`);
    i += total;
    if (type === 'IEND') break;
  }
  return { bytes: concat(out), removed: [...new Set(removed)] };
}

/** WebP: drop EXIF, XMP and ICCP chunks, and clear their flags in VP8X. */
function stripWebp(b) {
  const removed = [];
  const chunks = [];
  let i = 12;
  let vp8x = null;
  while (i + 8 <= b.length) {
    const fourcc = str(b, i, 4);
    const len = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] * 0x1000000);
    const total = 8 + len + (len % 2);
    if (len < 0 || i + total > b.length) break;
    if (fourcc === 'EXIF' || fourcc === 'XMP ' || fourcc === 'ICCP') {
      removed.push(`${fourcc.trim()} chunk`);
    } else {
      const c = b.slice(i, i + total);
      if (fourcc === 'VP8X') vp8x = c;
      chunks.push(c);
    }
    i += total;
  }
  if (vp8x && vp8x.length > 8) {
    // bit 5 = ICC, bit 3 = EXIF, bit 2 = XMP in the VP8X feature byte
    vp8x[8] &= ~0b00101100;
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  const size = body.length + 4;
  header[4] = size & 255; header[5] = (size >> 8) & 255;
  header[6] = (size >> 16) & 255; header[7] = (size >>> 24) & 255;
  return { bytes: concat([header, body]), removed: [...new Set(removed)] };
}

/**
 * GIF: the format has no EXIF at all, so there is no location to leak. Comment
 * and plain-text extensions are still dropped; the NETSCAPE loop extension is
 * kept, because removing it would silently break every animation.
 */
function stripGif(b) {
  const removed = [];
  const out = [];
  let i = 0;
  // header + logical screen descriptor + optional global colour table
  if (b.length < 13) return { bytes: b, removed };
  const flags = b[10];
  let p = 13 + (flags & 0x80 ? 3 * (2 ** ((flags & 7) + 1)) : 0);
  out.push(b.subarray(0, Math.min(p, b.length)));
  i = p;
  while (i < b.length) {
    const c = b[i];
    if (c === 0x3b) { out.push(b.subarray(i, i + 1)); break; } // trailer
    if (c === 0x21) {
      const label = b[i + 1];
      let j = i + 2;
      while (j < b.length && b[j] !== 0) j += 1 + b[j];
      j++;
      if (label === 0xfe || label === 0x01) removed.push(label === 0xfe ? 'comment extension' : 'plain-text extension');
      else out.push(b.subarray(i, Math.min(j, b.length)));
      i = j;
      continue;
    }
    if (c === 0x2c) {
      // image descriptor: 10 bytes, optional local colour table, LZW data
      const lflags = b[i + 9];
      let j = i + 10 + (lflags & 0x80 ? 3 * (2 ** ((lflags & 7) + 1)) : 0);
      j++; // LZW minimum code size
      while (j < b.length && b[j] !== 0) j += 1 + b[j];
      j++;
      out.push(b.subarray(i, Math.min(j, b.length)));
      i = j;
      continue;
    }
    break;
  }
  return { bytes: concat(out), removed: [...new Set(removed)] };
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------- re-encode

/**
 * Browser-only second pass: draw to a canvas and let the browser encode it.
 *
 * A canvas holds pixels and nothing else, so whatever survived the byte
 * stripper does not survive this. It is also how the size cap is met — quality
 * steps down until the result fits, and the caller is told the final numbers so
 * the editor can say what it did rather than quietly degrading the photo.
 */
export async function reencode(bytes, type, opts = {}) {
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { bytes, type, reencoded: false, w: 0, h: 0 };
  }
  const maxEdge = opts.maxEdge ?? MAX_IMAGE_EDGE;
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;

  // Animated GIFs lose their animation on a canvas, so they are left alone and
  // judged on their stripped size instead. Better a refused GIF than a silently
  // still one.
  if (type === 'image/gif') return { bytes, type, reencoded: false, w: 0, h: 0 };

  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes], { type })); }
  catch { return { bytes, type, reencoded: false, w: 0, h: 0 }; }

  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  const hasAlpha = type === 'image/png' || type === 'image/webp';
  const outType = hasAlpha ? 'image/png' : 'image/jpeg';
  for (const q of [0.86, 0.72, 0.6, 0.5, 0.4]) {
    const blob = await new Promise((res) => canvas.toBlob(res, outType, q));
    if (!blob) break;
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (buf.length <= maxBytes || q === 0.4) {
      return { bytes: buf, type: blob.type || outType, reencoded: true, w, h };
    }
  }
  return { bytes, type, reencoded: false, w, h };
}

/**
 * The whole import path, in the order that matters.
 *
 * @returns {{ ok: boolean, hash?: string, asset?: object, note?: string, removed?: string[] }}
 */
export async function importImage(rawBytes, declaredType) {
  const raw = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const sniffed = sniffType(raw);
  if (!sniffed) {
    return { ok: false, note: `That file is not a JPEG, PNG, WebP or GIF — the four formats profile pages can carry. ${declaredType ? `It said it was ${declaredType}.` : ''}`.trim() };
  }

  const stripped = stripMetadata(raw);
  const enc = await reencode(stripped.bytes, sniffed);
  // Strip AGAIN after re-encoding: the browser's encoder can add its own
  // chunks, and the guarantee is about the bytes we store, not the bytes we
  // were handed.
  const final = stripMetadata(enc.bytes);

  if (final.bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      removed: stripped.removed,
      note: `That image is ${Math.round(final.bytes.length / 1024)}KB after processing, over the ${Math.round(MAX_IMAGE_BYTES / 1024)}KB limit for one photo. Profile pages carry their images inside themselves — that is what stops a node swapping your photo — so the whole page has to stay a size people can download.`,
    };
  }

  const hash = await sha256Hex(final.bytes);
  return {
    ok: true,
    hash,
    removed: [...new Set([...stripped.removed, ...final.removed])],
    asset: {
      type: final.type ?? sniffed,
      data: toBase64(final.bytes),
      bytes: final.bytes.length,
      w: enc.w || 0,
      h: enc.h || 0,
    },
  };
}
