/**
 * The three-rung editor.
 *
 *   Themes — pick one, you are done.
 *   Knobs  — every action is a control; nothing can be malformed.
 *   Code   — HTML, CSS and BBCode, with the live preview beside them.
 *
 * All three edit ONE document, and the ladder is climbable because of it: pick a
 * theme, nudge two colours, open the code, and the two lines your two clicks
 * wrote are the only two lines that changed. That is not a metaphor — the knobs
 * write custom properties into a delimited block, and `spliceBlock` replaces one
 * block's source span and leaves every other byte alone.
 *
 * Where the round trip stops, it says so on screen rather than discarding work
 * quietly. See the header of `doc.js` for the four edges and why each is where
 * it is.
 *
 * Every refusal reads as "that isn't allowed here — here's why, and here's what
 * to use instead", never as a stack trace or a CSP violation. After saving, the
 * editor shows exactly what came off and why: a lossy sanitiser that stays quiet
 * teaches people the wrong thing about their own page.
 */

import { THEMES, KNOBS, FONT_STACKS, PATTERNS, STAMPS, themeById } from './themes.js';
import {
  emptyPage, applyTheme, themeIsPristine, readKnobs, writeKnobs,
  readBlocks, blockToHtml, spliceBlock, blocksToHtml, collectGarbage, pageBytes,
} from './doc.js';
import { mountPage, renderPage, baseCss } from './render.js';
import { bbcodeToHtml, BBCODE_HELP } from './bbcode.js';
import { importImage, MAX_IMAGE_BYTES, MAX_PAGE_ASSET_BYTES, MAX_ASSETS, ACCEPTED_TYPES } from './images.js';
import { signPage, ed25519Available } from './sign.js';

/**
 * @param {object} ctx  { el, toast, play, root, profile, saveProfile, publish }
 */
export function mountEditor(ctx) {
  const { el, toast, play, root } = ctx;
  const st = {
    page: ctx.profile.page ? pageFromSigned(ctx.profile.page) : emptyPage('aqua', ctx.profile.displayName),
    tab: 'themes',
    plain: false,
    lastRemovals: [],
  };

  const rerender = () => draw();

  function draw() {
    root.replaceChildren();

    // ---- preview, always visible: the thing you are editing is the thing you see
    const pv = el('div', 'card pp-preview');
    const ph = el('h3', null, 'Your page');
    const pcount = el('span', 'badge unk');
    pcount.append(el('span', 'dot'));
    ph.append(pcount);
    pv.append(ph);
    const frameBox = el('div', 'pp-frame-box');
    pv.append(frameBox);

    const prow = el('div', 'row');
    const plainBtn = el('button', 'ghost', st.plain ? 'Show it styled' : 'Show me this plain');
    plainBtn.type = 'button';
    plainBtn.onclick = () => { st.plain = !st.plain; play('tap'); draw(); };
    const saveBtn = el('button', 'primary', 'Save page');
    saveBtn.type = 'button';
    saveBtn.onclick = () => void save();
    prow.append(saveBtn, plainBtn);
    pv.append(prow);
    root.append(pv);

    const out = mountPage(frameBox, st.page, { plain: st.plain });
    st.lastRemovals = out.removals;
    const kb = Math.round(pageBytes(st.page) / 1024);
    pcount.append(document.createTextNode(`${kb} KB · ${out.images} photo${out.images === 1 ? '' : 's'} · ${out.links} link${out.links === 1 ? '' : 's'}`));

    // ---- rungs
    const tabs = el('div', 'subtabs');
    for (const [id, label] of [['themes', '1 · Themes'], ['knobs', '2 · Knobs'], ['code', '3 · Code']]) {
      const b = el('button', st.tab === id ? 'on' : '', label);
      b.type = 'button';
      b.onclick = () => { st.tab = id; play('tap'); draw(); };
      tabs.append(b);
    }
    root.append(tabs);

    if (st.tab === 'themes') drawThemes(root);
    else if (st.tab === 'knobs') drawKnobs(root);
    else drawCode(root);

    if (st.lastRemovals.length) root.append(removalsCard(st.lastRemovals));
  }

  // ------------------------------------------------------------ rung 1

  function drawThemes(host) {
    const c = el('div', 'card');
    c.append(el('h3', null, 'Pick a look'));
    c.append(el('div', 'note',
      'A theme is a set of colours, fonts and spacings — nothing more. Picking one writes about fifteen lines into your stylesheet, and the Code tab shows you exactly which fifteen.'));
    const grid = el('div', 'pp-themes');
    for (const t of THEMES) {
      const card = el('button', `pp-theme${st.page.theme === t.id ? ' on' : ''}`);
      card.type = 'button';
      const swatch = el('div', 'pp-swatch');
      swatch.style.background = `linear-gradient(160deg, ${t.knobs['--pp-bg-1']}, ${t.knobs['--pp-bg-2']})`;
      const chip = el('div', 'pp-chip');
      chip.style.background = t.knobs['--pp-panel'];
      chip.style.borderColor = t.knobs['--pp-border'];
      chip.style.color = t.knobs['--pp-accent'];
      chip.style.borderRadius = t.knobs['--pp-radius'];
      chip.textContent = 'Aa';
      swatch.append(chip);
      card.append(swatch);
      card.append(el('div', 'pp-tname', t.name));
      card.append(el('div', 'pp-tblurb', t.blurb));
      card.onclick = () => {
        st.page = applyTheme(st.page, t.id);
        play('admit');
        toast(`${t.name} — your words and photos are untouched`);
        draw();
      };
      grid.append(card);
    }
    c.append(grid);
    if (!themeIsPristine(st.page)) {
      c.append(el('div', 'note',
        `You are on ${themeById(st.page.theme).name}, edited. Picking a theme again replaces every colour and font; it never touches your words, your photos or any CSS you wrote yourself.`));
    }
    host.append(c);
  }

  // ------------------------------------------------------------ rung 2

  function drawKnobs(host) {
    const { values, overridden, present } = readKnobs(st.page.css);

    const kc = el('div', 'card');
    kc.append(el('h3', null, 'Colours, type and layout'));
    if (!present) {
      kc.append(el('div', 'notice',
        'The block these controls write has been deleted from your stylesheet. Change any control and it will be written back at the top, above everything you wrote.'));
    }
    for (const k of KNOBS) {
      const isOverridden = overridden.includes(k.prop);
      const row = el('div', 'pp-knob');
      const lab = el('label', 'pp-klabel', k.label);
      row.append(lab);
      const ctl = knobControl(k, values[k.prop], (v) => {
        st.page = { ...st.page, css: writeKnobs(st.page.css, { ...values, [k.prop]: v }) };
        draw();
      });
      if (isOverridden) {
        ctl.querySelectorAll('input, select').forEach((x) => { x.disabled = true; });
        row.classList.add('off');
      }
      row.append(ctl);
      row.append(el('div', 'pp-khelp', isOverridden
        ? `You set ${k.prop} again further down your own CSS, and your rule wins. This control is switched off rather than writing a value that would do nothing — delete your rule to get it back.`
        : `${k.help} — writes ${k.prop}`));
      kc.append(row);
    }
    host.append(kc);

    // ---- blocks
    const bc = el('div', 'card');
    bc.append(el('h3', null, 'What is on the page'));
    const blocks = readBlocks(st.page.html);
    if (!blocks.length) bc.append(el('div', 'note', 'Nothing yet. Add something below.'));

    blocks.forEach((b, i) => {
      const box = el('div', 'pp-block');
      const head = el('div', 'pp-bhead');
      head.append(el('span', 'pp-bkind', BLOCK_NAMES[b.kind] ?? b.kind));
      const tools = el('div', 'pp-btools');
      for (const [label, fn, disabled] of [
        ['↑', () => move(i, -1), i === 0],
        ['↓', () => move(i, 1), i === blocks.length - 1],
        ['✕', () => remove(i), false],
      ]) {
        const t = el('button', 'ghost tiny', label);
        t.type = 'button';
        t.disabled = disabled;
        t.onclick = fn;
        tools.append(t);
      }
      head.append(tools);
      box.append(head);
      box.append(blockEditor(b, (patch) => replace(b, { ...b, ...patch })));
      bc.append(box);
    });

    const add = el('div', 'row');
    for (const [kind, label] of [
      ['heading', '+ Heading'], ['text', '+ Words'], ['photo', '+ Photo'],
      ['stamps', '+ Stamps'], ['links', '+ Links'], ['divider', '+ Divider'],
    ]) {
      const b = el('button', 'ghost', label);
      b.type = 'button';
      b.onclick = () => {
        const fresh = defaultBlock(kind);
        st.page = { ...st.page, html: `${st.page.html}\n${blockToHtml(fresh)}` };
        play('tap');
        draw();
      };
      add.append(b);
    }
    bc.append(add);
    host.append(bc);

    function replace(b, next) {
      st.page = { ...st.page, html: spliceBlock(st.page.html, b.span, blockToHtml(next)) };
      draw();
    }
    function move(i, d) {
      const list = readBlocks(st.page.html);
      const j = i + d;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      st.page = { ...st.page, html: blocksToHtml(list) };
      play('tap');
      draw();
    }
    function remove(i) {
      const list = readBlocks(st.page.html);
      list.splice(i, 1);
      const next = { ...st.page, html: blocksToHtml(list) };
      const { page, freed } = collectGarbage(next);
      st.page = page;
      if (freed) toast(`Removed — ${Math.round(freed / 1024)} KB of photo freed`);
      play('nope');
      draw();
    }
  }

  function blockEditor(b, onChange) {
    const wrap = el('div');
    if (b.kind === 'heading') {
      const inp = el('input');
      inp.value = b.text;
      inp.placeholder = 'Heading';
      inp.onchange = () => onChange({ text: inp.value });
      const lvl = el('select');
      for (const l of ['h1', 'h2', 'h3']) {
        const o = el('option', null, l.toUpperCase());
        o.value = l;
        lvl.append(o);
      }
      lvl.value = b.level;
      lvl.onchange = () => onChange({ level: lvl.value });
      const row = el('div', 'row');
      row.append(inp, lvl);
      wrap.append(row);
      return wrap;
    }

    if (b.kind === 'text') {
      if (b.drifted) {
        const warn = el('div', 'notice');
        warn.append(document.createTextNode(
          'This block’s BBCode and its HTML no longer agree — the HTML was edited directly in the Code tab. Nothing has been thrown away; pick which one you meant.'));
        const row = el('div', 'row');
        const keepHtml = el('button', 'ghost', 'Keep the HTML');
        keepHtml.type = 'button';
        keepHtml.onclick = () => onChange({ mode: 'html', drifted: false });
        const keepBb = el('button', 'ghost', 'Go back to the BBCode');
        keepBb.type = 'button';
        keepBb.onclick = () => onChange({ mode: 'bbcode', drifted: false });
        row.append(keepHtml, keepBb);
        warn.append(row);
        wrap.append(warn);
      }
      const modes = el('div', 'subtabs');
      for (const [m, label] of [['bbcode', 'BBCode'], ['html', 'HTML']]) {
        const t = el('button', b.mode === m ? 'on' : '', label);
        t.type = 'button';
        t.onclick = () => {
          if (m === 'html' && b.mode === 'bbcode') {
            onChange({ mode: 'html', html: bbcodeToHtml(b.bbcode).html });
            toast('Converted to HTML. Your BBCode for this block is no longer kept — that conversion only goes one way.');
          } else if (m === 'bbcode' && b.mode === 'html') {
            onChange({ mode: 'bbcode', bbcode: b.bbcode || '' });
            toast('Back to BBCode. Any HTML you typed in this block has been replaced by what the BBCode compiles to.');
          }
        };
        modes.append(t);
      }
      wrap.append(modes);
      const ta = el('textarea');
      ta.rows = 5;
      ta.value = b.mode === 'bbcode' ? b.bbcode : b.html;
      ta.onchange = () => onChange(b.mode === 'bbcode' ? { bbcode: ta.value, drifted: false } : { html: ta.value });
      wrap.append(ta);
      if (b.mode === 'bbcode') {
        const notes = bbcodeToHtml(ta.value).notes;
        if (notes.length) wrap.append(removalsCard(notes, 'BBCode this did not understand'));
        wrap.append(bbHelp());
      }
      return wrap;
    }

    if (b.kind === 'photo') {
      const a = st.page.assets[b.asset];
      if (a) {
        const img = el('img', 'pp-thumb');
        img.src = `data:${a.type};base64,${a.data}`;
        img.alt = b.alt || '';
        wrap.append(img);
        wrap.append(el('div', 'note', `${a.w || '?'}×${a.h || '?'}, ${Math.round((a.bytes ?? 0) / 1024)} KB, stored inside the page`));
      }
      const file = el('input');
      file.type = 'file';
      file.accept = ACCEPTED_TYPES.join(',');
      file.onchange = () => void addPhoto(file, (hash) => onChange({ asset: hash }));
      wrap.append(file);
      const alt = el('input');
      alt.placeholder = 'Describe the photo (for people using a screen reader)';
      alt.value = b.alt;
      alt.onchange = () => onChange({ alt: alt.value });
      const cap = el('input');
      cap.placeholder = 'Caption (optional)';
      cap.value = b.caption;
      cap.onchange = () => onChange({ caption: cap.value });
      wrap.append(alt, cap);
      return wrap;
    }

    if (b.kind === 'stamps') {
      const shelf = el('div', 'pp-shelf');
      for (const [id, label] of STAMPS) {
        const on = b.items.includes(id);
        const chip = el('button', `pp-stampchip${on ? ' on' : ''}`);
        chip.type = 'button';
        chip.title = label;
        const dot = el('span', `pp-stamp pp-stamp-${id}`);
        chip.append(dot);
        chip.onclick = () => onChange({ items: on ? b.items.filter((x) => x !== id) : [...b.items, id] });
        shelf.append(chip);
      }
      wrap.append(shelf);
      wrap.append(el('div', 'note', 'Every stamp is drawn in CSS. Showing one downloads nothing, which is why they cannot be used to see who visited you.'));
      return wrap;
    }

    if (b.kind === 'links') {
      const list = [...b.links];
      list.forEach((l, i) => {
        const row = el('div', 'row');
        const lab = el('input');
        lab.placeholder = 'Label';
        lab.value = l.label;
        lab.onchange = () => { list[i] = { ...list[i], label: lab.value }; onChange({ links: list }); };
        const href = el('input');
        href.placeholder = 'https://…';
        href.value = l.href;
        href.onchange = () => { list[i] = { ...list[i], href: href.value }; onChange({ links: list }); };
        const del = el('button', 'ghost tiny', '✕');
        del.type = 'button';
        del.onclick = () => { list.splice(i, 1); onChange({ links: list }); };
        row.append(lab, href, del);
        wrap.append(row);
      });
      const add = el('button', 'ghost', '+ Add a link');
      add.type = 'button';
      add.onclick = () => onChange({ links: [...list, { label: '', href: '' }] });
      wrap.append(add);
      wrap.append(el('div', 'note',
        'Readers always see where a link really goes: the address is printed beside it, and your CSS cannot hide that.'));
      return wrap;
    }

    if (b.kind === 'custom') {
      const pre = el('pre', 'pp-src', b.source.slice(0, 600));
      wrap.append(el('div', 'note',
        `A <${b.tag}> you wrote yourself. The visual editor will not touch it — move it, delete it, or edit it in the Code tab.`));
      wrap.append(pre);
      return wrap;
    }

    wrap.append(el('div', 'note', 'A horizontal rule.'));
    return wrap;
  }

  // ------------------------------------------------------------ rung 3

  function drawCode(host) {
    const hc = el('div', 'card');
    hc.append(el('h3', null, 'HTML'));
    hc.append(el('div', 'note',
      'This is your page. Scripts never run here — not yours, not anyone’s — so anything that needs one is refused and named below rather than silently dropped.'));
    const html = el('textarea', 'pp-code');
    html.rows = 12;
    html.value = st.page.html;
    html.onchange = () => { st.page = { ...st.page, html: html.value }; play('tap'); draw(); };
    hc.append(html);
    host.append(hc);

    const cc = el('div', 'card');
    cc.append(el('h3', null, 'CSS'));
    cc.append(el('div', 'note',
      'The block at the top is what the knobs write. Change a value by hand and the knobs will show your value — they read this block, they have no other memory. Everything below the second comment is yours and the editor never rewrites it.'));
    const css = el('textarea', 'pp-code');
    css.rows = 16;
    css.value = st.page.css;
    css.onchange = () => { st.page = { ...st.page, css: css.value }; play('tap'); draw(); };
    cc.append(css);
    host.append(cc);

    const help = el('div', 'card');
    help.append(el('h3', null, 'How the knobs actually work'));
    help.append(el('div', 'note',
      'Nothing here is hidden from you. This is the stylesheet every page starts with — the only thing that reads the properties the knobs write. Copy any rule out of it and override it below your own block.'));
    const pre = el('pre', 'pp-src', baseCss());
    help.append(pre);
    host.append(help);

    host.append(bbHelp());
  }

  function bbHelp() {
    const c = el('div', 'card');
    c.append(el('h3', null, 'BBCode, if you learned it in a forum'));
    const t = el('table', 'kv');
    for (const [code, what] of BBCODE_HELP) {
      const tr = el('tr');
      tr.append(el('td', 'mono', code));
      tr.append(el('td', null, what));
      t.append(tr);
    }
    c.append(t);
    return c;
  }

  // ------------------------------------------------------------ photos

  async function addPhoto(fileInput, done) {
    const f = fileInput.files?.[0];
    if (!f) return;
    const used = Object.values(st.page.assets).reduce((a, x) => a + (x.bytes ?? 0), 0);
    if (Object.keys(st.page.assets).length >= MAX_ASSETS) {
      toast(`A page can hold ${MAX_ASSETS} photos. Remove one first.`);
      return;
    }
    const buf = new Uint8Array(await f.arrayBuffer());
    const r = await importImage(buf, f.type);
    if (!r.ok) { play('nope'); toast(r.note); return; }
    if (used + r.asset.bytes > MAX_PAGE_ASSET_BYTES) {
      play('nope');
      toast(`That would take the page past ${Math.round(MAX_PAGE_ASSET_BYTES / 1024)} KB of photos. Pages carry their own images so nobody can swap them — which means they have to stay downloadable.`);
      return;
    }
    st.page = { ...st.page, assets: { ...st.page.assets, [r.hash]: r.asset } };
    play('save');
    toast(r.removed.length
      ? `Added. Stripped ${r.removed.join(', ')} — phone photos carry GPS, and that is not going on your profile.`
      : 'Added. Re-encoded from pixels, so nothing that was in the file came with it.');
    done(r.hash);
  }

  // -------------------------------------------------------------- saving

  async function save() {
    const { page } = collectGarbage(st.page);
    st.page = page;

    const out = renderPage(page, {});
    if (!(await ed25519Available())) {
      play('nope');
      toast('This browser cannot make Ed25519 signatures yet, and an unsigned page is one a node could rewrite. Nothing was published.');
      return;
    }
    const signed = await signPage(
      { ...page, updatedAt: Date.now() },
      ctx.profile.identity.sk,
      ctx.profile.identity.pk,
    );
    ctx.profile.page = signed;
    ctx.saveProfile();
    play('save');

    const kb = Math.round(new TextEncoder().encode(JSON.stringify(signed)).length / 1024);
    toast(out.removals.length
      ? `Saved and signed (${kb} KB). ${out.removals.length} thing${out.removals.length === 1 ? '' : 's'} could not be kept — see below.`
      : `Saved and signed (${kb} KB). Nothing had to be removed.`);
    st.lastRemovals = out.removals;
    await ctx.publish?.(signed);
    draw();
  }

  function removalsCard(removals, title) {
    const c = el('div', 'card pp-removals');
    c.append(el('h3', null, title ?? `What could not be kept (${removals.length})`));
    c.append(el('div', 'note',
      'Nothing here was thrown away silently. Each line says what was removed, why, and what to use instead.'));
    for (const r of removals.slice(0, 40)) {
      const ev = el('div', 'ev');
      ev.append(el('div', 'lbl', r.what));
      ev.append(el('div', 'det', r.why));
      ev.append(el('div', 'det pp-instead', `Try instead: ${r.instead}`));
      c.append(ev);
    }
    if (removals.length > 40) c.append(el('div', 'note', `…and ${removals.length - 40} more of the same kinds.`));
    return c;
  }

  function knobControl(k, value, onSet) {
    const box = el('div', 'pp-kctl');
    if (k.type === 'colour') {
      const sw = el('input');
      sw.type = 'color';
      sw.value = /^#[0-9a-f]{6}$/i.test(String(value ?? '')) ? value : '#ffffff';
      const tx = el('input');
      tx.value = value ?? '';
      tx.placeholder = '#rrggbb';
      sw.oninput = () => { tx.value = sw.value; };
      sw.onchange = () => onSet(sw.value);
      tx.onchange = () => onSet(tx.value.trim());
      box.append(sw, tx);
      if (!/^#[0-9a-f]{6}$/i.test(String(value ?? ''))) {
        box.append(el('div', 'note', 'Set to something the colour picker cannot show. Your value is kept; type over it to change it.'));
      }
      return box;
    }
    if (k.type === 'range' || k.type === 'px') {
      const num = parseFloat(String(value ?? '')) || 0;
      const r = el('input');
      r.type = 'range';
      r.min = k.min;
      r.max = k.max;
      r.step = k.step ?? 1;
      r.value = String(num);
      const outp = el('div', 'out', k.type === 'px' ? `${num}px` : String(num));
      r.oninput = () => { outp.textContent = k.type === 'px' ? `${r.value}px` : r.value; };
      r.onchange = () => onSet(k.type === 'px' ? `${r.value}px` : r.value);
      box.append(r, outp);
      return box;
    }
    if (k.type === 'font' || k.type === 'pattern') {
      const table = k.type === 'font' ? FONT_STACKS : PATTERNS;
      const sel = el('select');
      let matched = false;
      for (const [id, [label, css]] of Object.entries(table)) {
        const o = el('option', null, label);
        o.value = css;
        sel.append(o);
        if (css === value) matched = true;
      }
      if (!matched) {
        const o = el('option', null, 'set in your own CSS');
        o.value = value ?? '';
        sel.append(o);
      }
      sel.value = value ?? '';
      sel.onchange = () => onSet(sel.value);
      box.append(sel);
      return box;
    }
    const sel = el('select');
    for (const [v, label] of [['1', 'One column'], ['2', 'Two columns']]) {
      const o = el('option', null, label);
      o.value = v;
      sel.append(o);
    }
    sel.value = String(value ?? '1');
    sel.onchange = () => onSet(sel.value);
    box.append(sel);
    return box;
  }

  draw();
  return { get page() { return st.page; }, redraw: rerender };
}

const BLOCK_NAMES = {
  heading: 'Heading', text: 'Words', photo: 'Photo',
  stamps: 'Stamps', links: 'Links', divider: 'Divider', custom: 'Your own HTML',
};

function defaultBlock(kind) {
  switch (kind) {
    case 'heading': return { kind: 'heading', level: 'h2', text: 'A heading' };
    case 'text': return { kind: 'text', mode: 'bbcode', bbcode: 'Something about you.', html: '' };
    case 'photo': return { kind: 'photo', asset: '', alt: '', caption: '' };
    case 'stamps': return { kind: 'stamps', items: ['star'] };
    case 'links': return { kind: 'links', links: [{ label: '', href: '' }] };
    default: return { kind: 'divider' };
  }
}

/** A signed page, back to the editable document. */
export function pageFromSigned(signed) {
  return {
    v: signed.v ?? 1,
    theme: signed.theme ?? 'aqua',
    title: signed.title ?? '',
    html: signed.html ?? '',
    css: signed.css ?? '',
    assets: signed.assets ?? {},
  };
}
