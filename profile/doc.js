/**
 * THE ONE DOCUMENT.
 *
 * A profile page is `{ v, theme, title, html, css, assets }` and nothing else.
 * Themes, knobs and the code editor are three views of that object:
 *
 *   theme  → writes a set of custom properties into a managed block in `css`
 *   knobs  → reads and writes individual properties in that same block, and
 *            splices individual blocks in `html` by source offset
 *   code   → edits `html` and `css` as text
 *
 * HOW FAR THE ROUND TRIP GOES — decided, implemented, and stated in the UI
 * rather than left for someone to discover:
 *
 *  ✔ Knob values round-trip completely. They are custom properties in a block
 *    delimited by two comments; edit them by hand and the knobs show your
 *    values, because the knobs have no other storage to disagree with.
 *  ✔ Editing one block in the visual editor splices exactly that block's source
 *    span. The rest of your file — indentation, comments, custom markup — comes
 *    back byte for byte.
 *  ✔ BBCode round-trips: a text block keeps its BBCode in `data-3s-src` beside
 *    the HTML it compiled to, so the visual editor still shows you BBCode after
 *    a trip through the code editor.
 *  ✖ If you hand-edit the HTML *inside* a BBCode block, the two disagree. The
 *    editor detects this by recompiling, says so, and asks which one you meant.
 *    It never silently picks.
 *  ✖ If you set a knob's property again further down your own stylesheet, your
 *    rule wins and the knob cannot. The editor marks that knob "overridden
 *    below" and disables it rather than writing a value that does nothing.
 *  ✖ Markup that is not one of the recognised blocks shows in the visual editor
 *    as "custom HTML", movable and deletable but not editable there. It is never
 *    rewritten and never dropped.
 */

import { parse } from './html.js';
import { parseDecls, parseStylesheet } from './css.js';
import { bbcodeToHtml } from './bbcode.js';
import { themeById, KNOB_PROPS, THEMES } from './themes.js';

export const PAGE_VERSION = 1;
export const BEGIN = '/* 3rdspace:knobs — written by the visual editor. Edit freely: the knobs read it back. */';
export const END = '/* 3rdspace:end — everything below is yours, and the editor never touches it. */';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ------------------------------------------------------------ the knob block

/**
 * Read the managed block.
 *
 * @returns {{ values: Record<string,string>, present: boolean, head: string,
 *            block: string, tail: string, overridden: string[] }}
 */
export function readKnobs(css) {
  const src = String(css ?? '');
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0 || e < b) {
    return { values: {}, present: false, head: '', block: '', tail: src, overridden: overriddenIn(src) };
  }
  const block = src.slice(b + BEGIN.length, e);
  const values = {};
  for (const rule of parseStylesheet(block)) {
    if (rule.type !== 'rule') continue;
    for (const d of parseDecls(rule.decls)) {
      if (d.prop.startsWith('--')) values[d.prop] = d.value;
    }
  }
  const tail = src.slice(e + END.length);
  return {
    values, present: true,
    head: src.slice(0, b), block, tail,
    overridden: overriddenIn(tail),
  };
}

/** Knob properties the author has set again in their own CSS, where they win. */
function overriddenIn(css) {
  const out = new Set();
  const scan = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'at') { if (n.body) scan(parseStylesheet(n.body)); continue; }
      for (const d of parseDecls(n.decls)) if (KNOB_PROPS.includes(d.prop)) out.add(d.prop);
    }
  };
  scan(parseStylesheet(String(css ?? '')));
  return [...out];
}

/** Write the managed block back, leaving everything around it untouched. */
export function writeKnobs(css, values) {
  const { head, tail, present } = readKnobs(css);
  // `:root`, not `#pp-page`.
  //
  // MEASURED, in the browser: with the block on `#pp-page`, picking a theme
  // recoloured the panels and left the page background on the previous theme's
  // gradient. Custom properties inherit DOWNWARDS, and the base stylesheet paints
  // the background on `body` — an ancestor of `#pp-page`, which therefore could
  // not see a property defined on its own descendant.
  const body = [':root {'];
  for (const prop of KNOB_PROPS) {
    if (values[prop] === undefined) continue;
    body.push(`  ${prop}: ${values[prop]};`);
  }
  body.push('}');
  const block = `${BEGIN}\n${body.join('\n')}\n${END}`;
  if (!present) return `${block}\n${String(css ?? '')}`;
  return `${head}${block}${tail}`;
}

// ---------------------------------------------------------------- the page

export function emptyPage(themeId = 'aqua', displayName = '') {
  const theme = themeById(themeId);
  const name = displayName || 'this is me';
  const html = [
    `<h1 data-3s="heading">${esc(name)}</h1>`,
    '<div data-3s="text" data-3s-mode="bbcode" data-3s-src="Say something true. [b]Anything.[/b]">Say something true. <strong>Anything.</strong></div>',
    '<div data-3s="stamps" data-3s-items="heart,orb,leaf"><span class="pp-stamp pp-stamp-heart"></span><span class="pp-stamp pp-stamp-orb"></span><span class="pp-stamp pp-stamp-leaf"></span></div>',
  ].join('\n');
  return {
    v: PAGE_VERSION,
    theme: theme.id,
    title: displayName || '',
    html,
    css: writeKnobs('', theme.knobs),
    assets: {},
  };
}

/** Apply a theme: replace every knob value, leave html, assets and tail CSS. */
export function applyTheme(page, themeId) {
  const theme = themeById(themeId);
  return { ...page, theme: theme.id, css: writeKnobs(page.css, theme.knobs) };
}

/** Does the page still match its named theme exactly? Drives "Aqua, edited". */
export function themeIsPristine(page) {
  const theme = THEMES.find((t) => t.id === page.theme);
  if (!theme) return false;
  const { values } = readKnobs(page.css);
  return KNOB_PROPS.every((p) => (values[p] ?? '') === (theme.knobs[p] ?? ''));
}

// ---------------------------------------------------------------- blocks

/**
 * The top-level structure of the page, as the visual editor sees it.
 *
 * Anything the editor does not recognise comes back as `kind:'custom'` with its
 * source intact. Nothing is dropped for being unrecognised — that is the
 * difference between an editor that teaches and one that owns your file.
 */
export function readBlocks(html) {
  const src = String(html ?? '');
  const root = parse(src);
  const out = [];
  for (const node of root.children) {
    if (node.t !== 'el') continue;
    const attr = (n) => (node.attrs.find(([k]) => k === n) ?? [])[1];
    const kind = attr('data-3s');
    const span = [node.start ?? 0, node.end ?? src.length];
    const source = src.slice(span[0], span[1]);
    const inner = innerOf(source, node);

    if (kind === 'heading') {
      out.push({ kind: 'heading', level: node.name, text: stripTags(inner), span, source });
    } else if (kind === 'text') {
      const mode = attr('data-3s-mode') === 'html' ? 'html' : 'bbcode';
      const bb = decodeAttr(attr('data-3s-src') ?? '');
      const drifted = mode === 'bbcode' && normalise(bbcodeToHtml(bb).html) !== normalise(inner);
      out.push({ kind: 'text', mode, bbcode: bb, html: inner, drifted, span, source });
    } else if (kind === 'photo') {
      const img = findFirst(node, 'img');
      const cap = findFirst(node, 'figcaption');
      out.push({
        kind: 'photo',
        asset: ((img?.attrs.find(([k]) => k === 'src') ?? [])[1] ?? '').replace(/^asset:/, ''),
        alt: (img?.attrs.find(([k]) => k === 'alt') ?? [])[1] ?? '',
        caption: cap ? stripTags(src.slice(cap.start ?? 0, cap.end ?? 0)) : '',
        span, source,
      });
    } else if (kind === 'stamps') {
      out.push({ kind: 'stamps', items: (decodeAttr(attr('data-3s-items') ?? '')).split(',').filter(Boolean), span, source });
    } else if (kind === 'links') {
      out.push({ kind: 'links', links: readLinks(node, src), span, source });
    } else if (kind === 'divider') {
      out.push({ kind: 'divider', span, source });
    } else {
      out.push({ kind: 'custom', tag: node.name, span, source });
    }
  }
  return out;
}

function innerOf(source, node) {
  if (node.name === 'hr' || node.name === 'img') return '';
  const open = source.indexOf('>');
  const close = source.lastIndexOf('</');
  if (open < 0 || close < open) return '';
  return source.slice(open + 1, close);
}

function findFirst(node, name) {
  for (const c of node.children ?? []) {
    if (c.t !== 'el') continue;
    if (c.name === name) return c;
    const hit = findFirst(c, name);
    if (hit) return hit;
  }
  return null;
}

function readLinks(node, src) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (c.t !== 'el') continue;
      if (c.name === 'a') {
        out.push({
          href: (c.attrs.find(([k]) => k === 'href') ?? [])[1] ?? '',
          label: stripTags(innerOf(src.slice(c.start ?? 0, c.end ?? 0), c)),
        });
      }
      walk(c);
    }
  };
  walk(node);
  return out;
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
const normalise = (s) => String(s).replace(/\s+/g, ' ').trim();
const decodeAttr = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Render one block back to source. The inverse of `readBlocks` for what it owns. */
export function blockToHtml(b) {
  switch (b.kind) {
    case 'heading':
      return `<${b.level || 'h2'} data-3s="heading">${esc(b.text ?? '')}</${b.level || 'h2'}>`;
    case 'text': {
      if (b.mode === 'html') {
        return `<div data-3s="text" data-3s-mode="html">${b.html ?? ''}</div>`;
      }
      const compiled = bbcodeToHtml(b.bbcode ?? '').html;
      return `<div data-3s="text" data-3s-mode="bbcode" data-3s-src="${esc(b.bbcode ?? '')}">${compiled}</div>`;
    }
    case 'photo':
      return `<figure data-3s="photo"><img src="asset:${esc(b.asset ?? '')}" alt="${esc(b.alt ?? '')}">`
        + `${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`;
    case 'stamps':
      return `<div data-3s="stamps" data-3s-items="${esc((b.items ?? []).join(','))}">`
        + (b.items ?? []).map((s) => `<span class="pp-stamp pp-stamp-${esc(s)}"></span>`).join('')
        + '</div>';
    case 'links':
      return `<ul data-3s="links" class="pp-links">${(b.links ?? [])
        .map((l) => `<li><a href="${esc(l.href)}">${esc(l.label || l.href)}</a></li>`).join('')}</ul>`;
    case 'divider':
      return '<hr data-3s="divider">';
    default:
      return b.source ?? '';
  }
}

/**
 * Replace one block's source span. Everything outside the span is preserved
 * exactly, which is what makes "nudge two colours, then read the code" show
 * only the two lines that changed.
 */
export function spliceBlock(html, span, replacement) {
  const src = String(html ?? '');
  return src.slice(0, span[0]) + replacement + src.slice(span[1]);
}

/** Reorder or delete by rebuilding from the block list, preserving each source. */
export function blocksToHtml(blocks) {
  return blocks.map((b) => (b.dirty ? blockToHtml(b) : (b.source ?? blockToHtml(b)))).join('\n');
}

/** Which assets the markup actually references — everything else is garbage. */
export function referencedAssets(html) {
  const out = new Set();
  const re = /asset:([0-9a-f]{64})/gi;
  let m;
  while ((m = re.exec(String(html ?? '')))) out.add(m[1].toLowerCase());
  return out;
}

export function collectGarbage(page) {
  const used = referencedAssets(page.html);
  const assets = {};
  let freed = 0;
  for (const [hash, a] of Object.entries(page.assets ?? {})) {
    if (used.has(hash)) assets[hash] = a;
    else freed += a.bytes ?? 0;
  }
  return { page: { ...page, assets }, freed };
}

export function pageBytes(page) {
  return new TextEncoder().encode(JSON.stringify(page)).length;
}
