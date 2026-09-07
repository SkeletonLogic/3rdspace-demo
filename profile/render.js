/**
 * The renderer: turn a profile page into an inert document, and hand the viewer
 * the controls.
 *
 * THE CONTAINMENT, in the order it matters:
 *
 *  1. A sandboxed iframe with NO `allow-scripts` and NO `allow-same-origin`.
 *     Without `allow-scripts` nothing in the document can execute; without
 *     `allow-same-origin` the frame is an opaque origin, so even if something
 *     did execute it could not read the parent's storage — which on a viewer's
 *     device means their private key, their profile file and their messages.
 *  2. A Content-Security-Policy with NO network origins at all. This is not
 *     belt-and-braces: it is what stops a stylesheet being a tracking beacon.
 *     `background: url(https://me.example/hit?who=…)` would otherwise tell the
 *     page's author who opened their profile and from what IP, silently.
 *  3. The sanitiser, which has already run. It is the contract with the author,
 *     not the containment — see `sanitize.js`.
 *
 * The iframe also contains `position: fixed`, which matters more than it sounds.
 * Loose in the page, an author's CSS could paint a fake "no capture detected"
 * badge over the app's own chrome, or a convincing fake key prompt. The one
 * claim this whole product rests on is that its badges mean something. Profile
 * CSS must never be able to draw one, and inside an iframe it cannot reach past
 * the frame's own box.
 *
 * THE VIEWER'S SETTINGS BEAT THE AUTHOR'S STYLING. The override sheet is last
 * and uses `!important`: `prefers-reduced-motion` kills animation outright, and
 * "show me this plain" reverts every author declaration on the page. The author
 * gets expression; the reader keeps their body and their accessibility settings.
 */

import { sanitizeHtml } from './sanitize.js';
import { sanitizeCss } from './css.js';

/**
 * No network origins. `img-src`/`media-src` allow `data:` and `blob:` because a
 * page carries its own images; every other directive is `'none'` by inheritance
 * from `default-src`, including `connect-src`, `script-src` and `frame-src`.
 *
 * `blob:` is listed for completeness, but an opaque-origin frame cannot resolve
 * a blob URL minted by the parent, so in practice everything the renderer shows
 * arrives as `data:`. Stated here rather than discovered later.
 */
export const CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * A link the reader deliberately clicks may open; nothing else may move.
 *
 * `allow-popups` plus `allow-popups-to-escape-sandbox` is the whole grant. With
 * an empty sandbox every link is inert, and a profile that cannot link to your
 * band is not a profile. A click is a user action; a silent beacon is not, and
 * the sanitiser writes the true destination host beside every link so the text
 * cannot lie about where the click goes.
 */
export const SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * The base stylesheet. It is the only consumer of the knobs, and it is shown
 * verbatim in the code editor's "how this works" pane — an author who wants to
 * know what `--pp-accent` does can read the four lines that use it.
 */
export function baseCss() {
  return `
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; }
body {
  font: var(--pp-size, 15px)/1.55 var(--pp-font, system-ui, sans-serif);
  color: var(--pp-ink, #123);
  /* Two layers: the pattern (a complete background layer, sizing included —
     see PATTERNS in themes.js for why) over the page gradient. */
  background:
    var(--pp-pattern, none),
    linear-gradient(180deg, var(--pp-bg-1, #eafaff), var(--pp-bg-2, #7fd0ef) 78%) 0 0 / 100% 100% no-repeat;
  background-attachment: fixed;
  min-height: 100%;
  -webkit-text-size-adjust: 100%;
}
#pp-page {
  max-width: var(--pp-width, 640px);
  margin: 0 auto;
  padding: 18px 14px 40px;
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(var(--pp-cols, 1), minmax(0, 1fr));
  align-items: start;
}
#pp-page > * {
  background: color-mix(in srgb, var(--pp-panel, #fff) calc(var(--pp-panel-alpha, .86) * 100%), transparent);
  border: 1px solid var(--pp-border, #cde);
  border-radius: var(--pp-radius, 16px);
  padding: 14px 16px;
  margin: 0;
  position: relative;
  overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255,255,255,calc(var(--pp-gloss, .5) * .95)),
              0 6px 18px -8px rgba(10,40,60,.35);
}
#pp-page > *::before {
  content: "";
  position: absolute; inset: 0 0 auto 0; height: 42%;
  background: linear-gradient(180deg, rgba(255,255,255,calc(var(--pp-gloss, .5) * .55)), transparent);
  pointer-events: none;
}
#pp-page > h1, #pp-page > h2, #pp-page > h3 {
  font-family: var(--pp-font-display, inherit);
  color: var(--pp-accent, #0e5f86);
  line-height: 1.2;
  letter-spacing: -0.01em;
}
#pp-page > h1 { font-size: 1.9em; }
#pp-page > h2 { font-size: 1.45em; }
#pp-page > h3 { font-size: 1.15em; }
#pp-page a { color: var(--pp-accent, #0e5f86); }
#pp-page img { max-width: 100%; height: auto; display: block; border-radius: calc(var(--pp-radius, 16px) * .6); }
#pp-page figure { padding: 10px; }
#pp-page figcaption { font-size: .86em; opacity: .8; padding: 8px 4px 2px; }
#pp-page blockquote { border-left: 3px solid var(--pp-accent, #0e5f86); padding-left: 12px; }
#pp-page hr { border: 0; border-top: 1px solid var(--pp-border, #cde); padding: 0; height: 0; }
#pp-page pre, #pp-page code { font-family: ui-monospace, Consolas, monospace; }
#pp-page pre { overflow-x: auto; }
#pp-page table { border-collapse: collapse; width: 100%; }
#pp-page td, #pp-page th { border: 1px solid var(--pp-border, #cde); padding: 5px 8px; text-align: left; }
#pp-page ul.pp-links { list-style: none; padding-left: 0; display: grid; gap: 6px; }

/* The stamps shelf. Drawn in CSS so that showing one downloads nothing. */
.pp-stamp {
  display: inline-block; width: 26px; height: 26px; margin: 3px;
  vertical-align: middle;
  background: radial-gradient(circle at 34% 28%, #fff, var(--pp-accent, #0e5f86));
  box-shadow: inset 0 -2px 4px rgba(0,0,0,.25), 0 2px 5px -2px rgba(0,0,0,.5);
}
.pp-stamp-heart { border-radius: 50% 50% 8% 50%; transform: rotate(45deg); }
.pp-stamp-star { clip-path: polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%); border-radius: 0; }
.pp-stamp-bolt { clip-path: polygon(58% 0,20% 55%,46% 55%,38% 100%,80% 42%,52% 42%); border-radius: 0; }
.pp-stamp-orb { border-radius: 50%; }
.pp-stamp-leaf { border-radius: 0 50% 0 50%; }
.pp-stamp-drop { border-radius: 50% 50% 50% 0; transform: rotate(45deg); }
.pp-stamp-moon { border-radius: 50%; box-shadow: inset -8px -2px 0 0 color-mix(in srgb, var(--pp-panel, #fff) 92%, transparent); }
.pp-stamp-sun { border-radius: 50%; box-shadow: 0 0 0 3px color-mix(in srgb, var(--pp-accent, #0e5f86) 40%, transparent); }
.pp-stamp-ring { border-radius: 50%; background: none; border: 5px solid var(--pp-accent, #0e5f86); }
.pp-stamp-square { border-radius: 3px; }
.pp-stamp-diamond { border-radius: 3px; transform: rotate(45deg); }
.pp-stamp-blink { border-radius: 4px; animation: pp-blink 1.2s steps(2, jump-none) infinite; }
@keyframes pp-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: .25 } }

/* Where a link really goes. Author CSS cannot reach this: the sanitiser drops
   any author selector mentioning s3-, and this rule is last and !important. */
.s3-dest {
  display: inline !important;
  visibility: visible !important;
  font-size: .82em !important;
  font-family: ui-monospace, Consolas, monospace !important;
  opacity: 1 !important;
  color: inherit !important;
  text-decoration: none !important;
  white-space: nowrap !important;
  position: static !important;
  clip-path: none !important;
  transform: none !important;
  width: auto !important; height: auto !important;
}
`.trim();
}

/**
 * The last sheet in the document. Everything here is the reader's, not the
 * author's, and everything here is `!important` for that reason.
 */
function viewerCss(opts) {
  const plain = `
html.pp-plain #pp-page, html.pp-plain #pp-page * {
  all: revert !important;
  font-family: system-ui, sans-serif !important;
  color: #111 !important;
  background: #fff !important;
  box-shadow: none !important;
  animation: none !important;
  transform: none !important;
  max-width: 100% !important;
}
html.pp-plain body { background: #fff !important; }
html.pp-plain #pp-page { max-width: 40rem !important; margin: 0 auto !important; padding: 16px !important; }
html.pp-plain .s3-dest { color: #444 !important; }
`;
  const motion = `
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
`;
  const forcedStill = opts.stillness ? `
*, *::before, *::after {
  animation: none !important;
  transition: none !important;
}
` : '';
  return `${plain}${motion}${forcedStill}`;
}

/**
 * Build the document for the iframe.
 *
 * @param {{v:number, theme:string, html:string, css:string, assets:object}} page
 * @param {{ plain?: boolean, stillness?: boolean, lang?: string }} opts
 * @returns {{ srcdoc: string, removals: Array, links: number, images: number, bytes: number }}
 */
export function renderPage(page, opts = {}) {
  const assets = page?.assets ?? {};
  const body = sanitizeHtml(page?.html ?? '', { assets });
  // Author CSS is NOT re-scoped.
  //
  // The scope existed for a preview that shared a document with the editor's own
  // chrome; the editor mounts its preview in this same sandboxed frame, so there
  // is nothing to share and nothing to protect. Rewriting selectors also broke
  // the thing the ladder depends on: `:root` and `body` are where a stylesheet
  // says what colour a PAGE is, and an author who writes either should get what
  // they wrote. `sanitizeCss` still takes a `scope` option, and it is still
  // tested; the renderer just has no use for it.
  const style = sanitizeCss(page?.css ?? '');

  const cls = opts.plain ? ' class="pp-plain"' : '';
  const srcdoc = `<!doctype html>
<html lang="${escAttr(opts.lang || 'en')}"${cls}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escAttr(CSP)}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${baseCss()}</style>
<style>${style.css}</style>
<style>${viewerCss(opts)}</style>
</head>
<body>
<div id="pp-page">
${body.html}
</div>
</body>
</html>`;

  return {
    srcdoc,
    removals: [...body.removals, ...style.removals],
    links: body.links,
    images: body.images,
    bytes: new TextEncoder().encode(srcdoc).length,
  };
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Create (or update) the sandboxed frame. Browser-only. */
export function mountPage(host, page, opts = {}) {
  const out = renderPage(page, opts);
  let frame = host.querySelector('iframe.pp-frame');
  if (!frame) {
    frame = document.createElement('iframe');
    frame.className = 'pp-frame';
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('title', 'profile page');
    host.append(frame);
  }
  // srcdoc rather than a blob URL: a blob URL would inherit an origin, and the
  // whole point of this frame is that it has none.
  frame.srcdoc = out.srcdoc;
  return out;
}
