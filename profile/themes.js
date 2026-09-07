/**
 * Themes and knobs.
 *
 * A theme is nothing but a set of knob values, and a knob is nothing but a CSS
 * custom property in a block the editor manages. That equivalence is the whole
 * trick behind the ladder: picking a theme, nudging a colour, and hand-editing
 * the stylesheet are three ways of writing the same eight lines. "Show me the
 * code" can therefore show you *exactly* what your two clicks wrote, and the
 * knobs can read your hand edits back, because there is nothing else to read.
 *
 * The base stylesheet in `render.js` is the only consumer of these properties.
 * An author who wants to know how a knob works can read that stylesheet in the
 * code editor; nothing about the mechanism is hidden from them.
 */

export const FONT_STACKS = {
  system: ['System', 'system-ui, "Segoe UI", Roboto, -apple-system, sans-serif'],
  round: ['Round', '"Comic Sans MS", "Chalkboard SE", "Segoe UI", sans-serif'],
  serif: ['Serif', 'Georgia, "Times New Roman", Times, serif'],
  slab: ['Slab', '"Rockwell", "Roboto Slab", Georgia, serif'],
  display: ['Display', '"Trebuchet MS", Verdana, Geneva, sans-serif'],
  mono: ['Mono', 'ui-monospace, Consolas, "Courier New", monospace'],
  wide: ['Wide', '"Franklin Gothic Medium", "Arial Black", Impact, sans-serif'],
};

/**
 * Background patterns, drawn entirely in CSS so that showing one downloads
 * nothing — the same reason the stamps are gradients rather than images.
 *
 * Each value is a complete `background` LAYER, position and size included
 * (`… 0 0 / 26px 26px`), rather than a bare `background-image`. That keeps one
 * knob to one custom property: a pattern that needed a matching
 * `background-size` would be one knob writing two properties, and the round trip
 * back into the knobs panel would have two things to disagree about.
 */
export const PATTERNS = {
  none: ['None', 'none'],
  bubbles: ['Bubbles', 'radial-gradient(circle at 22% 28%, rgba(255,255,255,.5) 0 9px, transparent 10px), radial-gradient(circle at 72% 62%, rgba(255,255,255,.36) 0 15px, transparent 16px), radial-gradient(circle at 46% 88%, rgba(255,255,255,.3) 0 6px, transparent 7px)'],
  grid: ['Grid', 'linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px) 0 0 / 26px 26px, linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px) 0 0 / 26px 26px'],
  stripes: ['Stripes', 'repeating-linear-gradient(135deg, rgba(255,255,255,.22) 0 12px, transparent 12px 24px)'],
  dots: ['Dots', 'radial-gradient(rgba(255,255,255,.55) 1.6px, transparent 1.7px) 0 0 / 18px 18px'],
  rays: ['Rays', 'repeating-conic-gradient(from 0deg at 50% 0%, rgba(255,255,255,.16) 0deg 6deg, transparent 6deg 14deg)'],
};

/**
 * Every knob: what it writes, what kind of control it is, and one line of prose
 * the editor shows underneath it. The prose is not decoration — it is how
 * someone learns what `--ink` means without being told to read a spec.
 */
export const KNOBS = [
  { prop: '--pp-bg-1', label: 'Background, top', type: 'colour', help: 'the top of the page’s background gradient' },
  { prop: '--pp-bg-2', label: 'Background, bottom', type: 'colour', help: 'the bottom of the gradient' },
  { prop: '--pp-pattern', label: 'Pattern', type: 'pattern', help: 'a repeating shape drawn over the background, in CSS — no image is downloaded' },
  { prop: '--pp-ink', label: 'Text', type: 'colour', help: 'body text; contrast against the panel is checked for you' },
  { prop: '--pp-accent', label: 'Accent', type: 'colour', help: 'headings and links' },
  { prop: '--pp-panel', label: 'Panel', type: 'colour', help: 'the card your content sits on' },
  { prop: '--pp-panel-alpha', label: 'Panel opacity', type: 'range', min: 0.3, max: 1, step: 0.02, help: 'lower is glassier; below about 0.6 text starts to fight the background' },
  { prop: '--pp-border', label: 'Edge', type: 'colour', help: 'panel borders and rules' },
  { prop: '--pp-radius', label: 'Corner radius', type: 'px', min: 0, max: 40, help: '0 is square, 20 is very round' },
  { prop: '--pp-font', label: 'Body font', type: 'font', help: 'fonts are chosen from a fixed list, because downloading one would be a network request' },
  { prop: '--pp-font-display', label: 'Heading font', type: 'font', help: 'used for headings' },
  { prop: '--pp-size', label: 'Text size', type: 'px', min: 12, max: 22, help: 'base size; everything else scales from it' },
  { prop: '--pp-width', label: 'Page width', type: 'px', min: 320, max: 1100, help: 'how wide the content column gets on a big screen' },
  { prop: '--pp-cols', label: 'Columns', type: 'cols', help: 'one column, or two side by side on a wide screen' },
  { prop: '--pp-gloss', label: 'Gloss', type: 'range', min: 0, max: 1, step: 0.05, help: 'the specular highlight across the top of each panel' },
];

export const KNOB_PROPS = KNOBS.map((k) => k.prop);

const base = {
  '--pp-pattern': PATTERNS.none[1],
  '--pp-panel-alpha': '0.86',
  '--pp-radius': '16px',
  '--pp-font': FONT_STACKS.system[1],
  '--pp-font-display': FONT_STACKS.system[1],
  '--pp-size': '15px',
  '--pp-width': '640px',
  '--pp-cols': '1',
  '--pp-gloss': '0.5',
};

/**
 * The gallery. Enough of them that "pick a theme" is a real choice, drawn from
 * the Frutiger Aero family the rest of the app speaks: wet glass, sky
 * gradients, saturated aqua and leaf green, and the sunset/bubblegum branches
 * the era also had.
 */
export const THEMES = [
  {
    id: 'aqua', name: 'Aqua', blurb: 'Wet glass over a bright sky. The house style.',
    knobs: { ...base, '--pp-bg-1': '#eafaff', '--pp-bg-2': '#7fd0ef', '--pp-ink': '#0b2f42', '--pp-accent': '#0e5f86', '--pp-panel': '#ffffff', '--pp-border': '#b6e4f6', '--pp-pattern': PATTERNS.bubbles[1] },
  },
  {
    id: 'vista', name: 'Vista Green', blurb: 'Leaf green and glass. Optimistic, 2007.',
    knobs: { ...base, '--pp-bg-1': '#f2ffe9', '--pp-bg-2': '#79c34a', '--pp-ink': '#12300a', '--pp-accent': '#1f6b25', '--pp-panel': '#ffffff', '--pp-border': '#c6e9ab', '--pp-pattern': PATTERNS.rays[1], '--pp-gloss': '0.7' },
  },
  {
    id: 'sunset', name: 'Sunset', blurb: 'Warm gradient, soft edges, evening light.',
    knobs: { ...base, '--pp-bg-1': '#fff3e0', '--pp-bg-2': '#f0806b', '--pp-ink': '#3b1d14', '--pp-accent': '#b6402a', '--pp-panel': '#fffaf5', '--pp-border': '#f6cdbb', '--pp-radius': '22px', '--pp-font-display': FONT_STACKS.display[1] },
  },
  {
    id: 'bubblegum', name: 'Bubblegum', blurb: 'Pink, round, and entirely unashamed.',
    knobs: { ...base, '--pp-bg-1': '#fff0f7', '--pp-bg-2': '#f79ac6', '--pp-ink': '#3d1028', '--pp-accent': '#b52a72', '--pp-panel': '#fffbfd', '--pp-border': '#f9c8de', '--pp-radius': '26px', '--pp-pattern': PATTERNS.dots[1], '--pp-font': FONT_STACKS.round[1], '--pp-font-display': FONT_STACKS.round[1] },
  },
  {
    id: 'deepsea', name: 'Deep Sea', blurb: 'Dark water. Light text, high contrast.',
    knobs: { ...base, '--pp-bg-1': '#062534', '--pp-bg-2': '#0b4763', '--pp-ink': '#dff2fb', '--pp-accent': '#7fd0ef', '--pp-panel': '#0d3d52', '--pp-border': '#1d6180', '--pp-panel-alpha': '0.7' },
  },
  {
    id: 'paper', name: 'Paper', blurb: 'Ink on warm paper. Nothing shiny at all.',
    knobs: { ...base, '--pp-bg-1': '#f6f2e9', '--pp-bg-2': '#e4dcc9', '--pp-ink': '#2b2618', '--pp-accent': '#7a5a1e', '--pp-panel': '#fffdf7', '--pp-border': '#d9cfb6', '--pp-radius': '4px', '--pp-gloss': '0', '--pp-font': FONT_STACKS.serif[1], '--pp-font-display': FONT_STACKS.slab[1] },
  },
  {
    id: 'terminal', name: 'Terminal', blurb: 'Green on black, monospace, no apologies.',
    knobs: { ...base, '--pp-bg-1': '#04140a', '--pp-bg-2': '#062b13', '--pp-ink': '#b8ffcf', '--pp-accent': '#4dff9b', '--pp-panel': '#03170c', '--pp-border': '#125c30', '--pp-radius': '2px', '--pp-gloss': '0', '--pp-panel-alpha': '0.9', '--pp-font': FONT_STACKS.mono[1], '--pp-font-display': FONT_STACKS.mono[1], '--pp-pattern': PATTERNS.grid[1] },
  },
  {
    id: 'frost', name: 'Frost', blurb: 'Pale glass, thin lines, a lot of air.',
    knobs: { ...base, '--pp-bg-1': '#f7fbff', '--pp-bg-2': '#cfe0ec', '--pp-ink': '#26333d', '--pp-accent': '#436b86', '--pp-panel': '#ffffff', '--pp-border': '#dbe7ef', '--pp-radius': '10px', '--pp-panel-alpha': '0.72', '--pp-gloss': '0.25', '--pp-width': '720px' },
  },
  {
    id: 'lagoon', name: 'Lagoon', blurb: 'Teal and sand, two columns, holiday brochure.',
    knobs: { ...base, '--pp-bg-1': '#e6fbf7', '--pp-bg-2': '#33b6a6', '--pp-ink': '#08302c', '--pp-accent': '#0a6f63', '--pp-panel': '#ffffff', '--pp-border': '#a9e5db', '--pp-cols': '2', '--pp-width': '860px', '--pp-pattern': PATTERNS.stripes[1] },
  },
  {
    id: 'ultraviolet', name: 'Ultraviolet', blurb: 'Purple haze with a hard accent.',
    knobs: { ...base, '--pp-bg-1': '#f4eeff', '--pp-bg-2': '#9d7ce0', '--pp-ink': '#241338', '--pp-accent': '#5b2ea6', '--pp-panel': '#fdfbff', '--pp-border': '#ddd0f5', '--pp-radius': '20px', '--pp-font-display': FONT_STACKS.wide[1] },
  },
  {
    id: 'noir', name: 'Noir', blurb: 'Charcoal, one warm accent, big type.',
    knobs: { ...base, '--pp-bg-1': '#191b1e', '--pp-bg-2': '#0d0e10', '--pp-ink': '#ece9e4', '--pp-accent': '#f0a05a', '--pp-panel': '#212429', '--pp-border': '#3a3f46', '--pp-radius': '6px', '--pp-gloss': '0.12', '--pp-size': '16px', '--pp-font-display': FONT_STACKS.wide[1] },
  },
  {
    id: 'meadow', name: 'Meadow', blurb: 'Grass, sky, and a serif. Very wallpaper.',
    knobs: { ...base, '--pp-bg-1': '#dff0ff', '--pp-bg-2': '#8fce5f', '--pp-ink': '#1c2a13', '--pp-accent': '#2f6d1f', '--pp-panel': '#fbfff6', '--pp-border': '#cbe6ad', '--pp-radius': '18px', '--pp-font': FONT_STACKS.serif[1], '--pp-pattern': PATTERNS.rays[1] },
  },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** The stamps shelf — drawn in CSS, so nothing is downloaded to show one. */
export const STAMPS = [
  ['heart', 'Heart'], ['star', 'Star'], ['bolt', 'Bolt'], ['orb', 'Orb'],
  ['leaf', 'Leaf'], ['drop', 'Drop'], ['moon', 'Moon'], ['sun', 'Sun'],
  ['ring', 'Ring'], ['square', 'Square'], ['diamond', 'Diamond'], ['blink', 'Blinky'],
];
