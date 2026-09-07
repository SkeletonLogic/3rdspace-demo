/**
 * Showing somebody else's page.
 *
 * Three things happen before a single byte is rendered, in this order:
 *
 *  1. The signature is checked HERE, on this device, against the author's key.
 *     The node that served the bytes is the party the signature is against, so
 *     its opinion of them is worth nothing.
 *  2. The page is sanitised HERE, on every render — never once at authoring
 *     time, and never on the host, because the host may hand a different viewer
 *     different bytes.
 *  3. It is mounted in a sandboxed iframe with no scripts, no same-origin, and a
 *     CSP with no network origins. See `render.js` for what each part stops.
 *
 * The reader keeps two controls the author cannot take away: "show me this
 * plain", which reverts every author declaration, and a block that is local,
 * needs no round trip, and is invisible to the person blocked.
 */

import { mountPage } from './render.js';
import { verifyPage } from './sign.js';

const BLOCK_KEY = '3rdspace.blocked.v1';

export function blockedSet() {
  try {
    const raw = localStorage.getItem(BLOCK_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

/**
 * Blocking is per-viewer, local, and silent.
 *
 * No request leaves the device, so the node cannot see it and cannot tell the
 * blocked party. That is deliberate: a block the other person can detect is a
 * block that invites retaliation, and in a dating app retaliation is not an
 * abstraction.
 */
export function setBlocked(pk, on) {
  const s = blockedSet();
  if (on) s.add(pk); else s.delete(pk);
  try { localStorage.setItem(BLOCK_KEY, JSON.stringify([...s])); } catch { /* private mode */ }
  return s;
}

export function isBlocked(pk) {
  return blockedSet().has(pk);
}

const VERDICT_WORDS = {
  verified: ['ok', 'Signed by them, unchanged since', 'The person whose page this is signed these exact bytes, photos included. The node serving it could not have edited a word.'],
  'not-a-page': ['unk', 'Not a profile page', 'What arrived is not in the shape of a page at all.'],
  unsigned: ['bad', 'Unsigned', 'This page carries no signature, so there is nothing tying it to the person it claims to be from.'],
  'wrong-author': ['bad', 'Signed by somebody else', 'The signature is valid, but not from the person this page was served as belonging to.'],
  'bad-signature': ['bad', 'Changed after it was signed', 'The bytes do not match the signature. The node that served this page is the only party in a position to have changed them.'],
  'asset-mismatch': ['bad', 'A photo does not match', 'An image in this page is not the image its content hash names, which is what swapping a photo looks like.'],
  'bad-key': ['bad', 'Unusable key', 'The author key on this page is not a valid signing key.'],
};

/**
 * @param {object} ctx { el, play, toast }
 * @param {HTMLElement} host
 * @param {object} signed  the page as served
 * @param {{ author: string, plain?: boolean, onToggle?: Function }} opts
 */
export async function mountViewer(ctx, host, signed, opts = {}) {
  const { el } = ctx;
  host.replaceChildren();

  if (isBlocked(opts.author)) {
    const c = el('div', 'card');
    c.append(el('h3', null, 'Blocked'));
    c.append(el('div', 'note',
      'You blocked this person, so their page is not shown. The block lives on this device only — nothing was sent anywhere, and they cannot tell.'));
    const un = el('button', 'ghost wide', 'Unblock');
    un.type = 'button';
    un.onclick = () => { setBlocked(opts.author, false); mountViewer(ctx, host, signed, opts); };
    c.append(un);
    host.append(c);
    return { rendered: false };
  }

  const verdict = await verifyPage(signed, opts.author);
  const [tone, title, why] = VERDICT_WORDS[verdict.state] ?? ['unk', verdict.state, verdict.detail];

  const head = el('div', tone === 'bad' ? 'proof' : 'card');
  const h = el('h3');
  h.append(document.createTextNode(title));
  const pill = el('span', `badge ${tone}`);
  pill.append(el('span', 'dot'));
  pill.append(document.createTextNode(verdict.ok ? 'verified here' : 'do not trust'));
  h.append(pill);
  head.append(h);
  head.append(el('div', 'note', why));
  host.append(head);

  if (!verdict.ok) {
    // A page that fails verification is never rendered. Showing it "with a
    // warning" would mean rendering bytes the host chose, which is exactly the
    // thing the signature exists to prevent.
    const c = el('div', 'card');
    c.append(el('div', 'note',
      'The page is not being shown. Rendering bytes that failed their own signature would mean showing you whatever the node felt like sending.'));
    c.append(el('div', 'mono', verdict.detail));
    host.append(c);
    return { rendered: false, verdict };
  }

  const bar = el('div', 'row');
  const plainBtn = el('button', 'ghost', opts.plain ? 'Show it styled' : 'Show me this plain');
  plainBtn.type = 'button';
  plainBtn.onclick = () => {
    opts.plain = !opts.plain;
    ctx.play?.('tap');
    mountViewer(ctx, host, signed, opts);
  };
  const blockBtn = el('button', 'ghost', 'Block this person');
  blockBtn.type = 'button';
  blockBtn.onclick = () => {
    setBlocked(opts.author, true);
    ctx.play?.('nope');
    ctx.toast?.('Blocked on this device. Nothing was sent, and they cannot tell.');
    mountViewer(ctx, host, signed, opts);
  };
  bar.append(plainBtn, blockBtn);
  host.append(bar);

  const box = el('div', 'pp-frame-box');
  host.append(box);
  const out = mountPage(box, signed, { plain: !!opts.plain });

  if (out.removals.length) {
    const c = el('div', 'card');
    c.append(el('h3', null, `${out.removals.length} thing${out.removals.length === 1 ? '' : 's'} in this page were not rendered`));
    c.append(el('div', 'note',
      'Profile pages are checked again on your device every time they are shown. This is what was refused in this one.'));
    for (const r of out.removals.slice(0, 12)) {
      const ev = el('div', 'ev');
      ev.append(el('div', 'lbl', r.what));
      ev.append(el('div', 'det', r.why));
      c.append(ev);
    }
    host.append(c);
  }

  return { rendered: true, verdict, out };
}
