/**
 * A tolerant HTML tokenizer and tree builder, written here rather than borrowed
 * from the DOM.
 *
 * WHY NOT `DOMParser` / `innerHTML`: mutation XSS. The browser's parser has
 * recovery rules that differ between the parse you sanitise and the parse the
 * renderer later performs, and the gap between the two is where mXSS lives —
 * `<noscript><p title="</noscript><img src=x onerror=...>">`, foreign-content
 * confusion in `<svg>`/`<math>`, and so on. Serialising from a tree the sanitiser
 * built itself removes that gap: the output is always balanced, always quoted,
 * and always escaped, so re-parsing it cannot produce a different shape.
 *
 * The second reason is testability. This module has no DOM dependency, so the
 * exact code that runs on a viewer's device also runs under `node --test`, and
 * the adversarial corpus is checked against the real thing rather than a mock.
 *
 * It does NOT implement HTML5 tree construction (no adoption agency, no implied
 * table sections). It implements *containment*: whatever the input, the output
 * is a balanced tree of allow-listed elements. That is the property the security
 * model needs; faithfulness to browser recovery is explicitly not a goal.
 */

/** Elements whose content is text, not markup. Their content is never parsed. */
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

/** Elements that never have children. */
export const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Attribute parsing that understands quoting, so `<a title="a>b">` is one tag
 * rather than a tag and some stray text. Unquoted values end at whitespace.
 */
function parseAttrs(src, i) {
  const attrs = [];
  let selfClose = false;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] === '>') { i++; break; }
    if (src[i] === '/' && src[i + 1] === '>') { selfClose = true; i += 2; break; }
    if (src[i] === '/') { i++; continue; }

    const nameStart = i;
    while (i < src.length && !/[\s/>=]/.test(src[i])) i++;
    const name = src.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }

    while (i < src.length && /\s/.test(src[i])) i++;
    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        i++;
        const end = src.indexOf(q, i);
        value = end < 0 ? src.slice(i) : src.slice(i, end);
        i = end < 0 ? src.length : end + 1;
      } else {
        const start = i;
        while (i < src.length && !/[\s>]/.test(src[i])) i++;
        value = src.slice(start, i);
      }
    }
    attrs.push([name, value]);
  }
  return { attrs, end: i, selfClose };
}

/** Tokenize. Comments, doctypes and processing instructions are dropped here. */
export function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (i < src.length) toks.push({ t: 'text', v: src.slice(i) });
      break;
    }
    if (lt > i) toks.push({ t: 'text', v: src.slice(i, lt) });

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      toks.push({ t: 'comment' });
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      toks.push({ t: 'decl' });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith('</', lt)) {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(src.slice(lt));
      if (!m) { toks.push({ t: 'text', v: '<' }); i = lt + 1; continue; }
      const gt = src.indexOf('>', lt);
      const to = gt < 0 ? src.length : gt + 1;
      toks.push({ t: 'end', name: m[1].toLowerCase(), at: lt, to });
      i = to;
      continue;
    }

    const m = /^<([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(src.slice(lt));
    if (!m) {
      // A lone `<` is text, exactly as a browser treats it.
      toks.push({ t: 'text', v: '<' });
      i = lt + 1;
      continue;
    }
    const name = m[1].toLowerCase();
    const { attrs, end, selfClose } = parseAttrs(src, lt + m[0].length);
    toks.push({ t: 'start', name, attrs, selfClose, at: lt, to: end });
    i = end;

    if (RAWTEXT.has(name) && !selfClose) {
      // Consume to the matching close tag WITHOUT parsing. This is the line
      // that stops `<style>a{}</style><img onerror=...>`-shaped payloads from
      // laundering markup through an element whose body is not markup.
      const close = new RegExp(`</\\s*${name}\\b[^>]*>`, 'i');
      const rest = src.slice(i);
      const hit = close.exec(rest);
      const body = hit ? rest.slice(0, hit.index) : rest;
      toks.push({ t: 'raw', name, v: body });
      const to = hit ? i + hit.index + hit[0].length : src.length;
      toks.push({ t: 'end', name, at: hit ? i + hit.index : to, to });
      i = to;
    }
  }
  return toks;
}

/**
 * Maximum element nesting.
 *
 * MEASURED, by the adversarial corpus: 5000 nested `<div>`s overflowed the
 * sanitiser's stack. That is a denial of service against the VIEWER's renderer,
 * not the author's, which makes it a real bug rather than a curiosity.
 *
 * Elements past this depth are UNWRAPPED — their children attach to the deepest
 * element that fitted — rather than re-parented as siblings. Unwrapping is what
 * makes the sanitiser idempotent: a document that has been through it once is
 * already inside the limit, so a second pass changes nothing. Re-parenting was
 * tried first and measurably was not a fixpoint.
 */
export const MAX_DEPTH = 64;

/**
 * Build a balanced tree.
 *
 * Nodes: `{ t:'text', v }` and `{ t:'el', name, attrs, children }`.
 * An end tag with no matching open element is discarded; unclosed elements are
 * closed at EOF. There is no code path that emits an unbalanced tree.
 *
 * Each stack frame carries a `sink`: the node its children attach to. For an
 * ordinary element that is itself; for one past `MAX_DEPTH` it is the frame's
 * own parent's sink, so the element vanishes and its contents survive. Close
 * tags still match against suppressed frames, so nesting stays balanced.
 */
export function parse(src) {
  const root = { t: 'el', name: '#root', attrs: [], children: [] };
  const stack = [{ node: root, sink: root }];
  const sink = () => stack[stack.length - 1].sink;

  for (const tk of tokenize(src)) {
    if (tk.t === 'text') { if (tk.v) sink().children.push({ t: 'text', v: decodeEntities(tk.v) }); continue; }
    if (tk.t === 'raw') { sink().children.push({ t: 'rawtext', name: tk.name, v: tk.v }); continue; }
    if (tk.t === 'comment' || tk.t === 'decl') continue;
    if (tk.t === 'start') {
      const deep = stack.length >= MAX_DEPTH;
      const node = { t: 'el', name: tk.name, attrs: tk.attrs, children: [], start: tk.at, end: tk.to };
      if (!deep) sink().children.push(node);
      if (!tk.selfClose && !VOID.has(tk.name)) {
        stack.push({ node, sink: deep ? sink() : node });
      }
      continue;
    }
    if (tk.t === 'end') {
      // Pop to the nearest matching open element; ignore if there is none, so a
      // stray `</div>` cannot close the wrapper we put the page in.
      let at = -1;
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].node.name === tk.name) { at = k; break; }
      if (at > 0) {
        // Record the source span of every element being closed here, so the
        // visual editor can splice one block's text without reformatting the
        // rest of the author's file.
        for (let k = stack.length - 1; k >= at; k--) stack[k].node.end = tk.to;
        stack.length = at;
      }
    }
  }
  return root;
}

// --------------------------------------------------------------- entities

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', copy: '©',
  reg: '®', trade: '™', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', deg: '°', times: '×', divide: '÷',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  hearts: '♥', star: '☆', check: '✓',
};

/**
 * Decode entities to their characters. This runs on TEXT, before the tree is
 * built, and everything is re-escaped on the way out — so `&lt;script&gt;`
 * decodes to `<script>` as *text* and re-encodes to `&lt;script&gt;`, and never
 * at any point becomes an element. Decoding first is what makes double-encoded
 * payloads (`&amp;lt;`) collapse to inert text instead of surviving a layer.
 */
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (whole, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return whole;
      // Lone surrogates would break the later re-encode; leave them as text.
      if (cp >= 0xd800 && cp <= 0xdfff) return whole;
      try { return String.fromCodePoint(cp); } catch { return whole; }
    }
    const hit = NAMED[body];
    return hit === undefined ? whole : hit;
  });
}

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s) {
  return s
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Serialise a tree the sanitiser has already vetted. */
export function serialize(node) {
  if (node.t === 'text') return escapeText(node.v);
  if (node.t === 'rawtext') return '';
  const kids = node.children.map(serialize).join('');
  if (node.name === '#root') return kids;
  const attrs = node.attrs.map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`)).join('');
  if (VOID.has(node.name)) return `<${node.name}${attrs}>`;
  return `<${node.name}${attrs}>${kids}</${node.name}>`;
}
