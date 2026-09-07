/**
 * BBCode → HTML.
 *
 * BBCode is here because a lot of people learned to make a page look like
 * theirs in a forum post, and that knowledge should still be worth something.
 * It is a *compiler*, not a second document format: its output goes through the
 * same sanitiser as hand-written HTML, so both rungs converge on one document
 * and there is no second security surface to get wrong.
 *
 * The parser is a stack of output buffers rather than a pile of regular
 * expressions. Regex BBCode breaks on the case that matters — nesting and
 * mismatched close tags — and a broken parser's failure mode is emitting markup
 * its author did not write, which is the one failure this codebase cannot have.
 * Every frame owns its own buffer, so `[url=x][b]y[/url]` closes `b` on the way
 * out and the output is balanced by construction.
 */

const SIMPLE = {
  b: ['<strong>', '</strong>'],
  i: ['<em>', '</em>'],
  u: ['<u>', '</u>'],
  s: ['<s>', '</s>'],
  sub: ['<sub>', '</sub>'],
  sup: ['<sup>', '</sup>'],
  code: ['<code>', '</code>'],
  pre: ['<pre>', '</pre>'],
  center: ['<div style="text-align:center">', '</div>'],
  left: ['<div style="text-align:left">', '</div>'],
  right: ['<div style="text-align:right">', '</div>'],
  h1: ['<h1>', '</h1>'],
  h2: ['<h2>', '</h2>'],
  h3: ['<h3>', '</h3>'],
  small: ['<small>', '</small>'],
  mark: ['<mark>', '</mark>'],
  spoiler: ['<details><summary>spoiler</summary>', '</details>'],
  list: ['<ul>', '</ul>'],
  olist: ['<ol>', '</ol>'],
};

const FONTS = {
  sans: 'system-ui, "Segoe UI", Tahoma, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, Consolas, "Courier New", monospace',
  round: '"Comic Sans MS", "Chalkboard SE", "Segoe UI", sans-serif',
  display: '"Trebuchet MS", Verdana, sans-serif',
};

const SIZES = [11, 12, 14, 17, 21, 27, 34];

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const isColour = (v) => /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s,.%/]+\)|hsla?\([\d\s,.%/]+\))$/i.test(String(v).trim());

/** Tokenize into text and tag tokens. An unparseable `[` is just text. */
function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('[', i);
    if (open < 0) { if (i < src.length) toks.push({ t: 'text', v: src.slice(i) }); break; }
    if (open > i) toks.push({ t: 'text', v: src.slice(i, open) });
    const close = src.indexOf(']', open);
    if (close < 0) { toks.push({ t: 'text', v: src.slice(open) }); break; }
    const body = src.slice(open + 1, close);
    const raw = src.slice(open, close + 1);
    if (!body || /[[\]\n]/.test(body)) {
      toks.push({ t: 'text', v: raw });
      i = close + 1;
      continue;
    }
    if (body[0] === '/') {
      toks.push({ t: 'close', name: body.slice(1).trim().toLowerCase(), raw });
    } else {
      const eq = body.indexOf('=');
      const name = (eq < 0 ? body : body.slice(0, eq)).trim().toLowerCase();
      const value = eq < 0 ? null : body.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      toks.push({ t: 'open', name, value, raw });
    }
    i = close + 1;
  }
  return toks;
}

/**
 * Compile BBCode to HTML.
 *
 * The HTML produced here is still untrusted: it goes to `sanitizeHtml` like any
 * other. What this guarantees is only that it is *balanced* and that every value
 * it interpolates was escaped.
 *
 * @returns {{ html: string, notes: Array<{what:string,why:string,instead:string}> }}
 */
export function bbcodeToHtml(src) {
  const notes = [];
  const seen = new Set();
  const note = (what, why, instead) => {
    const k = `${what}|${why}`;
    if (seen.has(k) || notes.length > 60) return;
    seen.add(k);
    notes.push({ what, why, instead });
  };

  const frames = [{ name: '#root', buf: [], wrap: (s) => s }];
  const emit = (s) => frames[frames.length - 1].buf.push(s);
  const openFrame = (name, wrap) => frames.push({ name, buf: [], wrap });
  const closeFrame = () => {
    const f = frames.pop();
    frames[frames.length - 1].buf.push(f.wrap(f.buf.join('')));
  };

  const inList = () => frames.some((f) => f.name === 'list' || f.name === 'olist');

  for (const tk of tokenize(String(src ?? ''))) {
    if (tk.t === 'text') { emit(esc(tk.v).replace(/\r?\n/g, '<br>')); continue; }

    if (tk.t === 'open') {
      const { name, value } = tk;

      if (name === 'hr') { emit('<hr>'); continue; }
      if (name === 'br') { emit('<br>'); continue; }

      if (name === '*') {
        if (!inList()) { note('[*]', 'A list item needs a list around it.', '[list][*] one [*] two [/list]'); continue; }
        // Close a previous item at this level before starting the next.
        if (frames[frames.length - 1].name === '*') closeFrame();
        openFrame('*', (inner) => `<li>${inner}</li>`);
        continue;
      }

      if (SIMPLE[name]) {
        const [o, c] = SIMPLE[name];
        openFrame(name, (inner) => `${o}${inner}${c}`);
        continue;
      }

      if (name === 'color' || name === 'bg') {
        if (!isColour(value)) {
          note(`[${name}=${value ?? ''}]`, 'That is not a colour this understands.', '[color=#ff8800] or [color=teal]');
          continue;
        }
        const prop = name === 'color' ? 'color' : 'background-color';
        openFrame(name, (inner) => `<span style="${prop}:${esc(value)}">${inner}</span>`);
        continue;
      }

      if (name === 'size') {
        const n = Math.round(Number(value));
        if (!Number.isFinite(n) || n < 1 || n > 7) {
          note(`[size=${value ?? ''}]`, 'Sizes run 1 to 7, the way they did in forum software.', '[size=4]');
          continue;
        }
        openFrame(name, (inner) => `<span style="font-size:${SIZES[n - 1]}px">${inner}</span>`);
        continue;
      }

      if (name === 'font') {
        const stack = FONTS[String(value ?? '').toLowerCase()];
        if (!stack) {
          note(`[font=${value ?? ''}]`,
            'Profile pages ship a fixed set of font stacks, because downloading a font file is a network request and therefore a visit tracker.',
            `[font=${Object.keys(FONTS).join('], [font=')}]`);
          continue;
        }
        openFrame(name, (inner) => `<span style="font-family:${esc(stack)}">${inner}</span>`);
        continue;
      }

      if (name === 'url') {
        openFrame('url', (inner) => {
          const href = value ?? inner.replace(/<[^>]*>/g, '').trim();
          if (!href) return inner;
          return `<a href="${esc(href)}">${inner || esc(href)}</a>`;
        });
        continue;
      }

      if (name === 'img') {
        // `[img]asset:<hash>[/img]`. The sanitiser resolves it against the
        // page's own image store, and refuses remote URLs there, loudly.
        openFrame('img', (inner) => {
          const ref = inner.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
          return ref ? `<img src="${esc(ref)}" alt="">` : '';
        });
        continue;
      }

      if (name === 'quote') {
        openFrame('quote', (inner) => (value
          ? `<blockquote><cite>${esc(value)}</cite>${inner}</blockquote>`
          : `<blockquote>${inner}</blockquote>`));
        continue;
      }

      note(tk.raw, `[${name}] is not a tag this understands, so it was left as plain text.`,
        '[b] [i] [u] [s] [color=…] [bg=…] [size=1-7] [font=…] [url=…] [img] [quote] [code] [list] with [*] [center] [h1]–[h3] [spoiler] [hr]');
      emit(esc(tk.raw));
      continue;
    }

    // ---- close
    let at = -1;
    for (let k = frames.length - 1; k > 0; k--) if (frames[k].name === tk.name) { at = k; break; }
    if (at < 0) continue; // a stray close tag is dropped, never emitted as markup
    // Close everything opened inside it too — this is what keeps output balanced.
    while (frames.length > at) closeFrame();
  }

  while (frames.length > 1) closeFrame();
  return { html: frames[0].buf.join(''), notes };
}

export const BBCODE_HELP = [
  ['[b]bold[/b]', 'bold'],
  ['[i]italic[/i]', 'italic'],
  ['[u]underline[/u]', 'underlined'],
  ['[s]struck[/s]', 'struck through'],
  ['[color=#ff8800]orange[/color]', 'coloured text'],
  ['[bg=#fff2cc]highlight[/bg]', 'a colour behind the text'],
  ['[size=5]big[/size]', 'sizes 1–7'],
  ['[font=round]soft[/font]', `fonts: ${Object.keys(FONTS).join(', ')}`],
  ['[url=https://x.example]my band[/url]', 'a link — its real address is always shown beside it'],
  ['[img]asset:…[/img]', 'a photo you added; images live inside the page'],
  ['[quote=Ada]text[/quote]', 'a quotation'],
  ['[list][*]one[*]two[/list]', 'a list — [olist] numbers them'],
  ['[center]middle[/center]', 'also [left] and [right]'],
  ['[h1]heading[/h1]', 'through [h3]'],
  ['[spoiler]hidden[/spoiler]', 'click to open'],
  ['[code]as typed[/code]', 'monospace'],
  ['[hr]', 'a horizontal rule'],
];
