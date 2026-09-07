/**
 * The profile-page sanitiser: an allow-list over the tree `html.js` builds.
 *
 * WHERE THIS SITS IN THE SECURITY MODEL. A profile authored by one person is
 * rendered on another person's device, and that device holds their private key,
 * their profile file and their message history. There is no trusted server to
 * clean anything: the node serving the bytes is explicitly the adversary in this
 * project's threat model, and it may hand a viewer different bytes than the
 * author signed. So:
 *
 *   1. The renderer's sandboxed iframe is the CONTAINMENT. It has no
 *      `allow-scripts`, no `allow-same-origin`, and a CSP with no network
 *      origins whatsoever. That is what actually stops an attack.
 *   2. This sanitiser is the CONTRACT. It defines what an author may write and
 *      explains every refusal in the author's own language, so the visual editor
 *      can teach rather than merely deny.
 *   3. It runs on the VIEWER's device, on every render. Never once at authoring
 *      time, and never on the host.
 *
 * NO SCRIPTS. EVER. MySpace allowed JavaScript in profiles and got Samy, a worm
 * that took the site down in under a day. There is no version of "carefully
 * allowed JS" worth that risk in a dating app, and this note exists so the
 * decision does not get relitigated by someone who has not read the history.
 */

import { parse, serialize, VOID, escapeText, decodeEntities } from './html.js';
import { sanitizeInlineStyle } from './css.js';

/** Tags an author may use, with the attributes each one may carry. */
export const ALLOWED_TAGS = {
  // structure
  div: [], section: [], article: [], aside: [], header: [], footer: [], main: [], nav: [],
  p: [], span: [], br: [], hr: [], pre: [], blockquote: ['cite'], figure: [], figcaption: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], details: ['open'], summary: [],
  // text
  a: ['href', 'target', 'rel'], b: [], strong: [], i: [], em: [], u: [], s: [], del: [], ins: [],
  mark: [], small: [], sub: [], sup: [], code: [], kbd: [], samp: [], var: [], q: ['cite'],
  abbr: [], cite: [], time: ['datetime'], bdi: [], bdo: [], ruby: [], rt: [], rp: [], wbr: [],
  // lists
  ul: [], ol: ['start', 'reversed', 'type'], li: ['value'], dl: [], dt: [], dd: [],
  // media
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding'],
  picture: [], hgroup: [],
  // tables
  table: [], thead: [], tbody: [], tfoot: [], tr: [], th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'], caption: [], colgroup: ['span'], col: ['span'],
  progress: ['value', 'max'], meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
};

/** Attributes any allowed element may carry. */
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'lang', 'dir', 'style', 'role']);

/**
 * Elements dropped WITH their contents, because their contents are not prose.
 * Everything unknown is unwrapped instead — see `refusalFor`.
 */
const DROP_SUBTREE = new Set([
  'script', 'style', 'link', 'meta', 'base', 'title', 'head',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'svg', 'math', 'template', 'slot', 'noscript', 'noembed', 'noframes',
  'canvas', 'audio', 'video', 'source', 'track', 'map', 'area',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea',
  'label', 'fieldset', 'legend', 'datalist', 'output', 'dialog', 'search',
  'xmp', 'plaintext', 'listing',
]);

/** Why each refused tag is refused, and what to reach for instead. */
const REFUSALS = {
  script: ['Profile pages never run scripts — not yours, not anyone’s. MySpace allowed it and got a worm that took the site down in a day, and here a script would be running on a stranger’s device next to their private key.', 'CSS animation, or a details/summary block for things that open and close'],
  style: ['A <style> element inside the page would sneak past the stylesheet checks.', 'the CSS tab, or a style="" attribute on the element'],
  iframe: ['An embedded frame loads someone else’s page, which is a network request and therefore a visit tracker.', 'a link — readers can click it if they want to'],
  object: ['<object> and <embed> load external content, which is a network request.', 'a photo block'],
  embed: ['<object> and <embed> load external content, which is a network request.', 'a photo block'],
  svg: ['Inline SVG is a second document format with its own scripting and its own parser quirks, which is exactly where renderer bugs live.', 'a photo block, or shapes drawn with CSS border-radius and gradients'],
  math: ['MathML is a second document format with its own parser quirks.', 'text, or a photo of the equation'],
  form: ['A form submits data somewhere, and a profile page has nowhere legitimate to submit it to.', 'write what you want to ask; people can message you'],
  input: ['Form controls only exist to collect what someone types, and a profile page must never do that.', 'plain text'],
  button: ['A button with nothing to press is a phishing shape.', 'a link, or a details/summary block'],
  textarea: ['Form controls only exist to collect what someone types.', 'a <pre> block'],
  link: ['<link> loads a stylesheet or icon over the network.', 'the CSS tab'],
  meta: ['<meta> changes how the whole document behaves, including its security headers.', 'nothing; it has no effect on a profile page'],
  base: ['<base> silently rewrites where every link on the page goes.', 'write the full address in each link'],
  canvas: ['<canvas> is only useful with a script, and profile pages never run scripts.', 'a photo block, or CSS gradients'],
  audio: ['Audio and video elements load a file over the network.', 'describe it, or link to it'],
  video: ['Audio and video elements load a file over the network.', 'describe it, or link to it'],
  noscript: ['<noscript> content is parsed differently depending on whether scripts are on, and that difference is a known way to smuggle markup past a sanitiser.', 'write the content directly'],
  marquee: ['<marquee> scrolls in a way a reader cannot switch off, and it ignores the reduced-motion setting.', 'a CSS animation — those are switched off automatically for readers who ask for less motion'],
  blink: ['<blink> flashes in a way a reader cannot switch off.', 'a CSS animation'],
  dialog: ['A modal dialog covers the page, which is the shape a fake prompt takes.', 'a details/summary block'],
};

const UNWRAP_DEFAULT = ['That tag is not one profile pages allow, so its contents were kept and the tag itself dropped.', 'a div or span with a class of your own'];

function refusalFor(tag) {
  return REFUSALS[tag] ?? UNWRAP_DEFAULT;
}

// ------------------------------------------------------------------ URLs

const IMAGE_MEDIA = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i;
const ASSET = /^asset:[0-9a-f]{64}$/i;

/** Cap on one embedded `data:` image inside the markup, before base64 overhead. */
export const MAX_INLINE_DATA_URL = 900_000;

/**
 * Link policy, decided rather than defaulted.
 *
 * A `sandbox=""` frame makes every link inert, which is safe and miserable — a
 * profile that cannot link to your band is not a profile. So the renderer grants
 * `allow-popups allow-popups-to-escape-sandbox`, a link opens in a new tab when
 * the reader deliberately clicks it, and the sanitiser writes the real
 * destination host next to the link text so the text cannot lie about where it
 * goes. A click is a user action; a silent beacon is not, and that is the whole
 * distinction the policy turns on.
 */
function linkPolicy(raw) {
  // Control characters are stripped from URLs *anywhere* in them by every
  // browser's URL parser, which is how `java<TAB>script:` gets to be a live
  // scheme. Stripping them here first means the scheme this judges is the
  // scheme the browser would act on.
  const href = String(raw ?? '').trim().replace(/[ -]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (!scheme) {
    return { ok: false, why: 'Links need a full address, because a profile page has no site of its own for a relative link to be relative to.', instead: 'https://example.com/your-page' };
  }
  const s = scheme[1].toLowerCase();
  if (s === 'http' || s === 'https') {
    let host = '';
    try { host = new URL(href).host; } catch { host = ''; }
    if (!host) return { ok: false, why: 'That address could not be read as a web address.', instead: 'https://example.com/your-page' };
    return { ok: true, href, host };
  }
  if (s === 'mailto') {
    const who = href.slice(7).split('?')[0];
    if (!/^[^\s@]+@[^\s@]+$/.test(who)) return { ok: false, why: 'That mailto: link does not contain an email address.', instead: 'mailto:you@example.com' };
    return { ok: true, href: `mailto:${who}`, host: who };
  }
  if (s === 'javascript' || s === 'vbscript') {
    return { ok: false, why: 'javascript: links are code, and profile pages never run scripts.', instead: 'a plain https: link' };
  }
  if (s === 'data') {
    return { ok: false, why: 'A data: link can carry a whole document, including one that imitates this app’s own screens.', instead: 'a plain https: link' };
  }
  return { ok: false, why: `${s}: links hand the address to another program on the reader’s device, and a profile page should not choose that for them.`, instead: 'an http: or https: link' };
}

// ------------------------------------------------------------- sanitiser

/**
 * @param {string} src author HTML
 * @param {{ assets?: Record<string, {type:string, data:string}> }} opts
 *        `assets` resolves `asset:<sha256>` to the embedded image. Assets the
 *        page does not carry are dropped, not left as broken references — a
 *        missing asset would otherwise be a URL the browser tries to resolve.
 * @returns {{ html: string, removals: Array<{what:string,why:string,instead:string}>, links: number, images: number }}
 */
export function sanitizeHtml(src, opts = {}) {
  const assets = opts.assets ?? {};
  const removals = [];
  const seen = new Set();
  let links = 0, images = 0;

  const note = (what, why, instead) => {
    const key = `${what}|${why}`;
    if (seen.has(key) || removals.length >= 200) return;
    seen.add(key);
    removals.push({ what, why, instead });
  };

  const walk = (node) => {
    const out = [];
    for (const child of node.children) {
      if (child.t === 'text') { out.push(child); continue; }
      if (child.t === 'rawtext') continue;

      const tag = child.name;

      // Chips this sanitiser injected on a previous pass are removed before a
      // fresh one is added, so sanitising twice does not stack two of them.
      // Marking them makes the sanitiser IDEMPOTENT, which is the property that
      // actually blocks mutation XSS: there is no second parse for a payload to
      // be different in. An author who writes the marker themselves just has
      // their element dropped, which is the correct outcome either way.
      if (child.attrs.some(([k]) => k.toLowerCase() === 'data-3s-dest')) continue;

      if (DROP_SUBTREE.has(tag)) {
        const [why, instead] = refusalFor(tag);
        note(`<${tag}>`, why, instead);
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(ALLOWED_TAGS, tag)) {
        const [why, instead] = refusalFor(tag);
        note(`<${tag}>`, why, instead);
        out.push(...walk(child)); // unwrap: keep the words, drop the box
        continue;
      }

      const kids = VOID.has(tag) ? [] : walk(child);
      const attrs = [];
      const allowed = new Set([...GLOBAL_ATTRS, ...ALLOWED_TAGS[tag]]);
      let linkHost = null;

      for (const [rawName, rawValue] of child.attrs) {
        const name = rawName.toLowerCase();

        if (name.startsWith('on')) {
          note(`${name}="…"`, 'Event handlers are script, and profile pages never run scripts. This one would have been inert anyway — the renderer runs no JavaScript at all — but it is removed so the page you save is the page you meant.', 'a CSS :hover rule');
          continue;
        }
        // `data-3s*` is the visual editor's own bookkeeping — which block this
        // is, whether its text came from BBCode, and so on. It is stripped
        // SILENTLY rather than reported: it appears on every honestly authored
        // page, and a refusal list that fires on the editor's own output would
        // train people to ignore the list. Nothing in the renderer reads these
        // attributes, so stripping them costs nothing; the protection that
        // matters against a forged chip is the `s3-` class rule below and the
        // `data-3s-dest` drop above.
        if (name.startsWith('data-3s')) continue;
        if (name === 'is' || name.startsWith('xmlns') || name.startsWith('xlink')) {
          note(`${name}="…"`, `${name} changes which element the browser actually builds, which is a way to smuggle one past an allow-list of tag names.`, 'a data attribute of your own, e.g. data-mine');
          continue;
        }
        if (!allowed.has(name)) {
          note(`${name}="…" on <${tag}>`, `<${tag}> does not take a ${name} attribute here.`, `class, id, title, lang, dir or style${ALLOWED_TAGS[tag].length ? `, or ${ALLOWED_TAGS[tag].join(', ')}` : ''}`);
          continue;
        }

        // Attribute values carry entities too, and a browser decodes them before
        // acting on them: `java&#115;cript:` is a live scheme by the time the
        // navigation happens. Decode first so the policy judges what the browser
        // will judge; `serialize` re-escapes on the way out, so a legitimate `&amp;`
        // in a query string survives as one instead of growing a layer per save.
        let value = decodeEntities(String(rawValue ?? ''));

        if (name === 'class' || name === 'id') {
          const parts = value.split(/\s+/).filter(Boolean);
          const kept = parts.filter((p) => !/^s3-/i.test(p));
          if (kept.length !== parts.length) {
            note(`${name}="${value}"`, 'Names starting with s3- belong to 3rdSpace, so that author CSS cannot restyle or hide the bits the app adds — a link’s real destination, for one.', 'a name of your own, e.g. my-card');
          }
          if (!kept.length) continue;
          value = kept.join(' ');
        }

        if (name === 'style') {
          const { css, removals: r } = sanitizeInlineStyle(value);
          for (const x of r) note(`style: ${x.what}`, x.why, x.instead);
          if (!css) continue;
          value = css;
        }

        if (name === 'href') {
          const p = linkPolicy(value);
          if (!p.ok) { note(`href="${clip(value)}"`, p.why, p.instead); continue; }
          value = p.href;
          linkHost = p.host;
        }

        if (name === 'src') {
          const v = value.trim();
          if (ASSET.test(v)) {
            const hash = v.slice(6).toLowerCase();
            const asset = assets[hash];
            if (!asset) {
              note(`src="${clip(v)}"`, 'That photo is not stored inside this page, so there is nothing to show. A profile page carries its own images; it never fetches them.', 're-add the photo from the editor');
              continue;
            }
            value = `data:${asset.type};base64,${asset.data}`;
          } else if (IMAGE_MEDIA.test(v.replace(/\s+/g, ''))) {
            if (v.length > MAX_INLINE_DATA_URL) {
              note('src="data:image/…"', `That image is ${Math.round(v.length / 1024)}KB written straight into the markup, over the ${Math.round(MAX_INLINE_DATA_URL / 1024)}KB cap.`, 'add it as a photo block — those are re-encoded, capped, and shared between blocks that use the same image');
              continue;
            }
            value = v.replace(/\s+/g, '');
          } else {
            note(`src="${clip(v)}"`, 'Images must live inside the page. A remote image URL is a network request, which tells whoever hosts it who looked at your profile and from what IP address — and it lets your node swap your photo for another one.', 'add the photo from the editor; it is stored inside the page and covered by your signature');
            continue;
          }
          images++;
        }

        if (name === 'target' || name === 'rel') continue; // set by policy below

        attrs.push([name, value]);
      }

      if (tag === 'a') {
        const href = attrs.find(([k]) => k === 'href');
        if (!href) {
          // An anchor with no usable destination is just text; keep the text.
          out.push(...kids);
          continue;
        }
        links++;
        attrs.push(['target', '_blank']);
        attrs.push(['rel', 'noopener noreferrer nofollow ugc']);
        attrs.push(['data-3s-host', linkHost ?? '']);
        kids.push({
          t: 'el', name: 'span',
          attrs: [['class', 's3-dest'], ['data-3s-dest', ''], ['aria-hidden', 'false']],
          children: [{ t: 'text', v: ` (${linkHost}) ` }],
        });
      }

      if (tag === 'img' && !attrs.some(([k]) => k === 'src')) continue;
      if (tag === 'img' && !attrs.some(([k]) => k === 'alt')) attrs.push(['alt', '']);

      out.push({ t: 'el', name: tag, attrs, children: kids });
    }
    return out;
  };

  const root = parse(String(src ?? ''));
  const kept = walk(root);
  return {
    html: kept.map(serialize).join(''),
    removals, links, images,
  };
}

function clip(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 45)}…` : t;
}

export { escapeText };
