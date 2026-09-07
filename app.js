/**
 * 3rdSpace client.
 *
 * Two things this file is careful about:
 *  1. The profile never leaves the device. It lives in localStorage and moves
 *     only as a file the user explicitly saves.
 *  2. Every capture badge renders together with the evidence that produced it.
 *     There is no path in this UI that shows a number on its own — if you can
 *     see a score, you can see why, and you can see how to recompute it.
 */

import { sound, setEnabled, ensure as ensureAudio, play, previewAll } from './sound.js?v=de525bd754';
import { plainVerdict, plainDetector } from './profile/plain.js';
import { mountEditor, pageFromSigned } from './profile/editor.js';
import { mountViewer, isBlocked, setBlocked, blockedSet } from './profile/viewer.js';

const $ = (s) => document.querySelector(s);
const el = (t, cls, txt) => {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};
const KEY = '3rdspace.profile.v1';
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

const state = {
  schema: null, node: null, badges: [], sel: null,
  tab: 'audit', scope: 'both', profile: null, es: null,
  view: 'v-spaces', installEvent: null, seenAlert: new Set(),
  /** whose page the viewer is showing, and where the back button goes */
  viewingPage: null, backTo: 'v-me', editor: null,
};

// ---------------------------------------------------------------- demo mode
//
// The hosted build has no node behind it, so it ships the three demo nodes'
// PUBLISHED DATA and recomputes every audit here, in the browser, using the same
// detector code a real node runs (core.bundle.js).
//
// This is why the scores are NOT baked into demo-data.json. "Every badge is
// computed on your device" has to stay literally true, or the one claim this
// whole product rests on becomes marketing.

let DEMO = null;   // the payload, once loaded
let CORE = null;   // the detector bundle, once loaded

async function tryDemo() {
  // MEASURED BUG, fixed here: `src/client/demo-data.json` is checked in, and the
  // local swarm serves the whole client directory — so the app fell into
  // read-only demo mode even when a real node was answering on the same origin.
  // Joining, posting and publishing a page were all refused on a machine that
  // could do all three.
  //
  // The question is not "is there a demo payload on disk" but "is there a node
  // behind this page", so that is what gets asked, and asked first.
  try {
    const live = await fetch('/api/node', { cache: 'no-cache' });
    if (live.ok) {
      const n = await live.json();
      if (n && typeof n.pk === 'string') return false;
    }
  } catch { /* no node here: fall through to the bundled payload */ }

  try {
    const r = await fetch('./demo-data.json?v=cb93abadea', { cache: 'no-cache' });
    if (!r.ok) return false;
    const data = await r.json();
    if (data.magic !== '3rdspace-demo') return false;
    CORE = await import('./core.bundle.js?v=53037f3645');
    DEMO = data;
    return true;
  } catch {
    return false;
  }
}

const demoRooms = () => DEMO.nodes.flatMap((n) => n.rooms.map((room) => ({ node: n, room })));
const findRoom = (id) => demoRooms().find((x) => x.room.id === id);
const demoNodeFor = (id) => (id && findRoom(id) ? findRoom(id).node : DEMO.nodes[0]);

/** Run the real detectors over a stored PublishedView. */
function demoReport(room, intent) {
  const view = room.views[intent];
  if (!view) return { error: 'no view', detectors: [], proofs: [] };
  return CORE.buildReport(view);
}

/**
 * Stand-in for the node API. Same routes, same shapes — the rest of the app
 * cannot tell which one it is talking to, which is what keeps one code path
 * for both the hosted demo and a real node.
 */
async function api(path) {
  if (!DEMO) return (await fetch(path)).json();

  const [route, qs] = path.split('?');
  const q = new URLSearchParams(qs || '');

  if (route === '/api/schema') return DEMO.schema;

  if (route === '/api/node') {
    // The demo browse list spans all three nodes, so "the node" is whichever
    // one owns the currently selected room.
    const n = demoNodeFor(state.sel);
    return {
      pk: n.pk, title: n.title, scope: 'both', logging: n.logging, selfCheck: n.selfCheck,
      rooms: n.rooms.map((r) => ({
        id: r.id, title: r.title, topic: r.topic, scope: r.scope,
        members: r.members, predicateVersion: r.predicateVersion, predicate: r.predicate,
      })),
    };
  }

  if (route === '/api/badges') {
    const badges = demoRooms().map(({ node, room }) => {
      const intents = room.scope === 'both' ? ['dating', 'friendship'] : [room.scope];
      const perIntent = {};
      for (const i of intents) {
        const r = demoReport(room, i);
        perIntent[i] = {
          score: r.score === undefined ? null : r.score,
          auditable: !!r.auditable,
          top: (r.detectors || [])
            .filter((d) => d.state === 'ok' && d.score > 0.2)
            .sort((a, b) => b.score - a.score).slice(0, 2)
            .map((d) => ({ id: d.id, headline: d.headline })),
          proofs: (r.proofs || []).length,
        };
      }
      return {
        room: room.id, node: node.pk, title: room.title, scope: room.scope,
        topic: room.topic, members: room.members, perIntent,
        auditable: node.logging, hostTitle: node.title,
      };
    });
    return { node: DEMO.nodes[0].pk, badges };
  }

  if (route === '/api/audit') {
    const hit = findRoom(q.get('room'));
    return hit ? demoReport(hit.room, q.get('intent') || 'dating') : { error: 'no such room' };
  }

  if (route === '/api/messages') {
    const hit = findRoom(q.get('room'));
    return hit ? { messages: hit.room.messages, members: hit.room.memberList } : { error: 'no such room' };
  }

  if (route === '/api/page') {
    // Search every demo node: a page belongs to a person, not to a room.
    const author = q.get('author') ?? '';
    for (const n of DEMO.nodes) {
      if (n.pages?.[author]) return n.pages[author];
      const removed = (n.pagesRemoved ?? []).filter((r) => r.author === author).at(-1);
      if (removed) return { error: 'no page', removedByHost: removed };
    }
    return { error: 'no page', removedByHost: null };
  }

  if (route === '/api/log') return demoNodeFor(state.sel).log;

  if (route === '/api/sth') {
    const n = demoNodeFor(state.sel);
    return { sths: n.sths, latest: n.sths[n.sths.length - 1] };
  }

  if (route === '/api/export') {
    const hit = findRoom(q.get('room'));
    if (!hit) return { error: 'no such room' };
    return {
      magic: '3rdspace-room-export', version: 1, exportedAt: Date.now(),
      source: {
        node: hit.node.pk, room: hit.room.id,
        sth: hit.node.sths[hit.node.sths.length - 1], entries: hit.node.log.entries,
      },
      members: hit.room.memberList, reviews: [], vouches: [],
    };
  }

  return { error: 'not available in the hosted demo' };
}

/** Writes are refused out loud in demo mode, rather than silently doing nothing. */
function demoWriteBlocked() {
  play('nope');
  toast('Read-only demo \u2014 run a node locally to join, post or host');
}

// ------------------------------------------------------------------ sky

function makeBubbles() {
  const box = $('#bubbles');
  if (!box) return;
  const n = window.innerWidth < 700 ? 9 : 16;
  for (let i = 0; i < n; i++) {
    const b = el('div', 'bub');
    const size = 10 + Math.random() * 46;
    b.style.width = b.style.height = `${size}px`;
    b.style.left = `${Math.random() * 100}%`;
    b.style.animationDuration = `${16 + Math.random() * 26}s`;
    b.style.animationDelay = `${-Math.random() * 30}s`;
    b.style.setProperty('--sway', `${(Math.random() * 8 - 4).toFixed(1)}vw`);
    box.append(b);
  }
}

// -------------------------------------------------------------- profile

function loadProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* private mode: fall through */ }
  return null;
}

function saveProfile() {
  try { localStorage.setItem(KEY, JSON.stringify(state.profile)); }
  catch { toast('Could not save locally — export to a file instead'); }
}

async function newProfile(name) {
  // The identity keypair is generated in the browser, by the browser.
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pk = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const sk = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).slice(-32);
  return {
    magic: '3rdspace-profile', version: 1,
    createdAt: Date.now(), exportedAt: Date.now(),
    identity: { pk: hex(pk), sk: hex(sk) },
    displayName: name || 'anon', viewScope: 'both',
    self: { schema: 'traits/v1', answers: [], updatedAt: Date.now() },
    prefs: {}, salts: {}, published: {},
    reviewsAuthored: [], reviewsReceived: [], banReceipts: [],
    vouchesGiven: [], vouchesReceived: [], proofs: [], rooms: [],
    settings: { epsilon: 4, publishCompatEdges: true, signDeliveryReceipts: true, personhoodProvider: 'VouchWeb' },
  };
}

async function sha256hex(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return hex(new Uint8Array(h));
}

async function fingerprint(p) {
  const h = await sha256hex(p.identity.pk);
  return h.slice(0, 16).match(/.{1,4}/g).join('-');
}

function download(name, text) {
  const b = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// --------------------------------------------------------------- badges

// M11 — TWO SURFACES, ONE TRUTH.
//
// The default surface is ordinary language. Every technical artefact is still
// here — scores, formulas, evidence rows, tree heads, the raw log — one tap away
// behind ONE affordance that behaves identically everywhere: "Show the working".
// Nothing is deleted. It is demoted, because the person who wants to verify a
// proof by hand must still be able to, and that capability is the reason the
// plain sentence can be trusted at all.

/**
 * The disclosure. One component for every technical detail in the app, so that
 * "there is more underneath" is a single learnable gesture rather than six
 * different ones. The body is built lazily: an audit's evidence is expensive to
 * render and most people will never open it.
 */
function working(build, label = 'Show the working') {
  const d = el('details', 'working');
  const sum = el('summary');
  sum.append(el('span', 'chev', '›'));
  sum.append(document.createTextNode(label));
  d.append(sum);
  const body = el('div', 'workingbody');
  d.append(body);
  let built = false;
  d.addEventListener('toggle', () => {
    if (!d.open || built) return;
    built = true;
    play('tap');
    build(body);
  });
  return d;
}

const cls = (score, auditable) => {
  if (!auditable || score === null || score === undefined) return 'unk';
  return score < 0.35 ? 'ok' : score < 0.6 ? 'warn' : 'bad';
};

/**
 * The badge, in words.
 *
 * The number is not deleted — it is on the dial, in the reproduction formula,
 * and in the CLI. It is just not the first thing anyone reads, because "risk 42"
 * is a number whose units nobody knows.
 */
const BADGE_WORDS = { ok: 'looks fine', warn: 'worth a look', bad: 'something’s off', unk: 'can’t tell' };
const icon = (intent) => (intent === 'dating' ? '♥' : '☺');

function badgeEl(intent, v, auditable) {
  const ok = auditable && v.auditable;
  const k = cls(v.score, ok);
  const b = el('span', `badge ${k}`);
  b.append(el('span', 'dot'));
  b.append(document.createTextNode(`${icon(intent)} ${BADGE_WORDS[k]}`));
  return b;
}

// -------------------------------------------------------------- spaces

function renderSpaces() {
  const box = $('#spaces');
  box.replaceChildren();
  const visible = state.badges.filter(
    (b) => state.scope === 'both' || b.scope === 'both' || b.scope === state.scope,
  );
  if (!visible.length) {
    box.append(el('p', 'hint', 'No spaces here yet. Switch your view, or host one.'));
    return;
  }
  for (const b of visible) {
    const card = el('button', `space${state.sel === b.room ? ' sel' : ''}`);
    card.type = 'button';

    const r1 = el('div', 'row1');
    r1.append(el('span', 'name', b.title));
    card.append(r1);

    const meta = el('div', 'meta');
    // Only worth showing when the host is not the room — otherwise it just
    // repeats the title back at you.
    if (b.hostTitle && b.hostTitle !== b.title) meta.append(el('span', 'tag', `@ ${b.hostTitle}`));
    meta.append(el('span', 'tag', b.scope === 'both' ? 'friends + dating' : b.scope));
    for (const t of b.topic.slice(0, 3)) meta.append(el('span', 'tag', t));
    meta.append(el('span', 'count', `${b.members} member${b.members === 1 ? '' : 's'}`));
    card.append(meta);

    const badges = el('div', 'badges');
    for (const [intent, v] of Object.entries(b.perIntent)) badges.append(badgeEl(intent, v, b.auditable));
    if (Object.values(b.perIntent).some((v) => v.proofs > 0)) {
      badges.append(el('span', 'badge bad', '⚑ caught, provably'));
    }
    card.append(badges);

    card.onclick = () => {
      state.sel = b.room;
      state.tab = 'audit';
      play('open');
      renderSpaces();
      go('v-space');
    };
    box.append(card);
  }
}

// --------------------------------------------------------------- dials

function dial(score, klass) {
  const wrap = el('div', 'dial');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 84 84');
  svg.setAttribute('width', '84');
  svg.setAttribute('height', '84');

  const R = 36, C = 2 * Math.PI * R;
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', '42'); track.setAttribute('cy', '42'); track.setAttribute('r', String(R));
  track.setAttribute('fill', 'none'); track.setAttribute('stroke', 'rgba(10,80,115,.14)');
  track.setAttribute('stroke-width', '9');
  svg.append(track);

  if (score !== null && score !== undefined) {
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.id = `g${Math.random().toString(36).slice(2)}`;
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
    const stops = klass === 'ok' ? ['#b6f08a', '#2f9e46']
      : klass === 'warn' ? ['#ffd88a', '#e0921a'] : ['#ff9d90', '#c9372a'];
    for (const [off, col] of [[0, stops[0]], [1, stops[1]]]) {
      const s = document.createElementNS(NS, 'stop');
      s.setAttribute('offset', String(off));
      s.setAttribute('stop-color', col);
      grad.append(s);
    }
    const defs = document.createElementNS(NS, 'defs');
    defs.append(grad);
    svg.append(defs);

    const arc = document.createElementNS(NS, 'circle');
    arc.setAttribute('cx', '42'); arc.setAttribute('cy', '42'); arc.setAttribute('r', String(R));
    arc.setAttribute('fill', 'none'); arc.setAttribute('stroke', `url(#${grad.id})`);
    arc.setAttribute('stroke-width', '9'); arc.setAttribute('stroke-linecap', 'round');
    arc.setAttribute('stroke-dasharray', String(C));
    arc.setAttribute('stroke-dashoffset', String(C));
    // The final value is set on the element itself and the sweep is a CSS
    // animation with NO fill-mode, so whether or not the animation ever runs
    // (it does not while the page is backgrounded) the arc still ends up
    // showing the real score rather than an empty ring.
    //
    // The earlier version set the start value, then the end value from a
    // requestAnimationFrame callback. rAF does not fire while the page is
    // backgrounded, so the arc could be left stuck at its starting offset —
    // showing a stub instead of the score. A CSS animation always lands on the
    // correct final state whether or not it ever gets to run.
    arc.style.setProperty('--c', String(C));
    arc.setAttribute('stroke-dashoffset', String(C * (1 - score)));
    arc.style.animation = 'dialIn .95s cubic-bezier(.2,.8,.3,1)';
    svg.append(arc);
  }

  wrap.append(svg);
  const val = el('div', 'val');
  val.append(document.createTextNode(score === null || score === undefined ? '—' : String(Math.round(score * 100))));
  val.append(el('small', null, 'capture risk'));
  wrap.append(val);
  return wrap;
}

// ---------------------------------------------------------- space pane

async function renderSpace() {
  const pane = $('#spacePane');
  const b = state.badges.find((x) => x.room === state.sel);
  pane.replaceChildren();
  if (!b) {
    const e = el('div', 'empty');
    e.append(el('div', 'big'));
    e.append(el('h1', null, 'Pick a space'));
    e.append(el('p', null, 'Open its audit before you join. The score, the evidence behind it, and what the node refuses to publish.'));
    pane.append(e);
    return;
  }

  pane.append(el('h2', 'sec', b.title));
  pane.append(el('p', 'hint',
    `${b.topic.join(' · ')} — ${b.scope === 'both' ? 'friends and dating' : b.scope} — ${b.members} members`));

  const tabs = el('div', 'subtabs');
  for (const [id, t] of [['audit', 'Audit'], ['chat', 'Room'], ['rule', 'Who gets in'], ['log', 'Log']]) {
    const btn = el('button', state.tab === id ? 'on' : '', t);
    btn.type = 'button';
    btn.onclick = () => { state.tab = id; play('tap'); renderSpace(); };
    tabs.append(btn);
  }
  pane.append(tabs);

  if (state.tab === 'audit') return renderAudit(pane, b);
  if (state.tab === 'chat') return renderChat(pane, b);
  if (state.tab === 'rule') return renderRule(pane, b);
  return renderLog(pane, b);
}

async function renderAudit(pane, b) {
  for (const intent of Object.keys(b.perIntent)) {
    let rep;
    try { rep = await api(`/api/audit?room=${b.room}&intent=${intent}`); }
    catch { pane.append(el('div', 'notice', 'Could not reach this node.')); return; }
    if (rep.error) continue;

    const v = plainVerdict(rep);

    // ---- the plain surface: a verdict, one sentence, and why
    const head = el('div', `card verdict ${v.tone}`);
    const h = el('h3');
    h.append(document.createTextNode(`${icon(intent)} ${intent === 'dating' ? 'Dating here' : 'Friends here'}`));
    const pill = el('span', `badge ${v.tone}`);
    pill.append(el('span', 'dot'));
    pill.append(document.createTextNode(v.title));
    h.append(pill);
    head.append(h);
    head.append(el('p', 'lead', v.sentence));
    if (v.because.length) {
      const ul = el('ul', 'because');
      for (const line of v.because) ul.append(el('li', null, line));
      head.append(ul);
    }

    // ---- everything technical, one tap away, behind the same affordance
    head.append(working((box) => {
      const sw = el('div', 'scorewrap');
      sw.append(dial(rep.auditable ? rep.score : null, cls(rep.score, rep.auditable)));
      const side = el('div');
      side.append(el('div', 'note', rep.auditable && rep.score !== null
        ? `Capture risk ${Math.round(rep.score * 100)} out of 100, computed on this device from what the node published.`
        : 'No score: this node does not publish enough to be scored.'));
      side.append(el('div', 'mono', rep.reproduction.formula));
      sw.append(side);
      box.append(sw);
      box.append(el('div', 'note',
        'These numbers come from a simulator whose realism bounds how far they generalise. That belongs next to the score, not only in the docs.'));

      for (const d of rep.detectors) {
        const pd = plainDetector(d, rep);
        const c = el('div', 'card');
        const dh = el('h3');
        dh.append(document.createTextNode(pd.name));
        const dp = el('span', `badge ${pd.tone}`);
        dp.append(el('span', 'dot'));
        dp.append(document.createTextNode(
          d.state === 'ok' ? String(Math.round(d.score * 100)) : d.state.replace(/-/g, ' ')));
        dh.append(dp);
        c.append(dh);
        c.append(el('div', 'note', pd.line));
        c.append(working((inner) => {
          inner.append(el('div', 'mono', `${d.id} — ${d.headline}`));
          for (const e of d.evidence) {
            const ev = el('div', 'ev');
            ev.append(el('div', 'lbl', e.label));
            ev.append(el('div', 'det', e.detail));
            inner.append(ev);
          }
        }, 'The arithmetic'));
        box.append(c);
      }
    }));
    pane.append(head);

    // A flagged space gets one sober tone, once.
    const key = `${b.room}:${intent}`;
    if (rep.score !== null && rep.score >= 0.6 && !state.seenAlert.has(key)) {
      state.seenAlert.add(key);
      play(rep.proofs.length ? 'proof' : 'alert');
    }

    // Proofs keep their prominence. A proof is not a probability, and unlike a
    // score it does not get demoted behind a disclosure.
    for (const p of rep.proofs) {
      const pc = el('div', 'proof');
      pc.append(el('h3', null, 'Caught, provably'));
      pc.append(el('div', null, PROOF_PLAIN[p.kind] ?? p.summary));
      pc.append(el('div', 'why',
        'Not a judgement call and not a score. Anyone holding this node’s public key can check this for themselves, forever.'));
      pc.append(working((box) => {
        box.append(el('div', 'mono', `${p.kind} — ${p.summary}`));
        box.append(el('pre', 'pp-src', JSON.stringify(p.artefacts, null, 1).slice(0, 4000)));
      }, 'The artefacts'));
      pane.append(pc);
    }
  }
}

const PROOF_PLAIN = {
  equivocation: 'This node has signed two different versions of its own history. Both carry its signature, and they cannot both be true.',
  truncation: 'This node deleted something it had already proved was in its history. Somebody kept the proof.',
  'post-hoc-rule': 'Somebody was banned here under a rule that did not exist yet when they were banned.',
  'unlogged-enforcement': 'This node acted on somebody without recording it, and the gap shows in its own log.',
  'forged-block': 'This node produced a block declaration that the person it names never signed.',
};

async function renderChat(pane, b) {
  if (!state.profile) {
    const c = el('div', 'card');
    c.append(el('h3', null, 'Make a profile first'));
    c.append(el('div', 'note', 'Your answers stay on this device.'));
    const go2 = el('button', 'primary wide', 'Set up');
    go2.type = 'button';
    go2.onclick = () => { play('tap'); go('v-me'); };
    c.append(go2);
    pane.append(c);
    return;
  }

  const data = await api(`/api/messages?room=${b.room}`);
  const me = state.profile.identity.pk;
  const joined = data.members.includes(me);

  if (!joined) {
    const c = el('div', 'card');
    c.append(el('h3', null, 'You are not in this space'));
    c.append(el('div', 'note',
      'Joining publishes only the coarse buckets this space’s rule actually checks — never your answers.'));
    const btn = el('button', 'primary wide', 'Request to join');
    btn.type = 'button';
    btn.style.marginTop = '10px';
    btn.onclick = async () => {
      if (DEMO) return demoWriteBlocked();
      const buckets = await bucketsFor(b);
      const r = await fetch('/api/join', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: b.room, pk: me, buckets, sig: 'browser' }),
      }).then((x) => x.json());
      if (r.admitted) { play('admit'); toast('Admitted'); }
      else { play('reject'); toast(`Not admitted — ${r.outcome}${r.failedDims.length ? `: ${r.failedDims.join(', ')}` : ''}`); }
      refresh();
    };
    c.append(btn);
    pane.append(c);
    return;
  }

  // People here, and their pages. Tapping somebody opens their page in the
  // sandboxed viewer; blocking is local, silent, and needs no round trip.
  const people = el('div', 'card');
  people.append(el('h3', null, `People here (${data.members.length})`));
  people.append(el('div', 'note', 'Tap somebody to see their page. It is checked against their signature and rendered in a sealed frame on this device.'));
  const grid = el('div', 'people');
  for (const pk of data.members) {
    if (pk === me) continue;
    const chip = el('button', `person${isBlocked(pk) ? ' blocked' : ''}`);
    chip.type = 'button';
    chip.append(el('span', 'fp', pk.slice(0, 10)));
    if (isBlocked(pk)) chip.append(el('small', null, 'blocked'));
    chip.onclick = () => { play('open'); openPage(pk); };
    grid.append(chip);
  }
  people.append(grid);
  pane.append(people);

  const msgs = el('div', 'msgs');
  // A blocked person's messages are hidden here, on this device, with no round
  // trip — so the node cannot learn who you blocked and they cannot tell.
  const hidden = data.messages.filter((m) => isBlocked(m.sender)).length;
  for (const m of data.messages) {
    if (isBlocked(m.sender)) continue;
    const bub = el('div', `bubble${m.sender === me ? ' me' : ''}`);
    if (m.sender !== me) bub.append(el('span', 'who', m.sender.slice(0, 8)));
    bub.append(document.createTextNode(m.text));
    msgs.append(bub);
  }
  if (hidden) {
    msgs.append(el('div', 'note', `${hidden} message${hidden === 1 ? '' : 's'} from people you blocked are hidden. They do not know.`));
  }
  pane.append(msgs);
  requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });

  const comp = el('div', 'composer');
  const inp = el('input');
  inp.placeholder = 'Say something…';
  inp.enterKeyHint = 'send';
  const send = el('button', 'primary', 'Send');
  send.type = 'button';
  const doSend = async () => {
    if (DEMO) return demoWriteBlocked();
    const text = inp.value.trim();
    if (!text) return;
    inp.value = '';
    play('send');
    await fetch('/api/post', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: b.room, pk: me, text }),
    });
    renderSpace();
  };
  send.onclick = doSend;
  inp.onkeydown = (e) => { if (e.key === 'Enter') doSend(); };
  comp.append(inp, send);
  pane.append(comp);

  const fork = el('div', 'card');
  fork.append(el('h3', null, 'Leave and take the room with you'));
  fork.append(el('div', 'note',
    'Forking exports the membership, the reviews and this node’s signed history, and re-forms the space under a new host. Bans do not carry over. The fork names its source, so nobody can fork away from their own record.'));
  const fb = el('button', 'ghost wide', 'Export this space');
  fb.type = 'button';
  fb.style.marginTop = '10px';
  fb.onclick = async () => {
    const x = await api(`/api/export?room=${b.room}`);
    download(`3rdspace-room-${b.room.slice(0, 8)}.json`, JSON.stringify(x, null, 2));
    play('save');
    toast('Room exported');
  };
  fork.append(fb);
  pane.append(fork);
}

function describe(a) {
  switch (a.t) {
    case 'any': return 'anyone';
    case 'likert-band': return `around ${a.target} (±${a.slack})`;
    case 'range': return `between ${Math.round(a.lo)} and ${Math.round(a.hi)}`;
    case 'set': return `one of: ${a.ok.join(', ')}`;
    case 'bool': return a.want ? 'yes' : 'no';
    default: return JSON.stringify(a);
  }
}

/** Dimension ids in words, so the rule reads as a sentence about people. */
const DIM_WORDS = {
  'activity.climbing': 'how much you climb',
  'activity.hiking': 'how often you hike',
  'activity.boardgames': 'how into board games you are',
  'activity.music': 'whether you make music',
  'identity.queer': 'whether you are LGBTQ+',
  'life.parent': 'whether you are a parent',
  'faith.practice': 'how much religion shapes your week',
  'lang.primary': 'the language you socialise in',
  'geo.region': 'roughly where you are',
  'person.age': 'your age',
  'person.introvert': 'how outgoing you are',
  'person.tidy': 'how tidy you are',
  'pol.axis': 'your politics',
  'body.type': 'your build',
  'habit.smoke': 'whether you smoke',
  'habit.drink': 'how much you drink',
  'health.status': 'your health',
  'econ.income': 'your income',
};
const dimWords = (id) => DIM_WORDS[id] ?? String(id).split('.').pop().replace(/[-_]/g, ' ');
const cap1 = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);

function renderRule(pane, b) {
  const room = state.node.rooms.find((r) => r.id === b.room);
  const onTopic = new Set((state.schema?.dims ?? [])
    .filter((d) => d.tags.some((t) => b.topic.includes(t)))
    .map((d) => d.id));

  const c = el('div', 'card');
  c.append(el('h3', null, 'Who gets in'));
  if (!room.predicate.clauses.length) {
    c.append(el('p', 'lead', 'Anyone can join this space. There are no conditions at all.'));
  } else {
    c.append(el('p', 'lead',
      `This space checks ${room.predicate.clauses.length} thing${room.predicate.clauses.length === 1 ? '' : 's'} about you before letting you in.`));
    for (const cl of room.predicate.clauses) {
      const ev = el('div', 'ev');
      ev.append(el('div', 'lbl', cap1(dimWords(cl.dim))));
      ev.append(el('div', 'det', `must be ${describe(cl.accept)}. The host’s stated reason: “${cl.rationale}”.`));
      if (!onTopic.has(cl.dim)) {
        ev.append(el('div', 'det flag',
          'This has nothing to do with what the space says it is about — which is the pattern the audit looks for.'));
      }
      c.append(ev);
    }
  }
  c.append(working((box) => {
    box.append(el('div', 'mono', `predicate v${room.predicateVersion}`));
    box.append(el('div', 'note',
      'Every change to this rule is a signed entry in the node’s log, so the whole history of who was let in under which version can be checked.'));
    const t = el('table', 'kv');
    for (const cl of room.predicate.clauses) {
      const tr = el('tr');
      tr.append(el('td', 'mono', cl.dim));
      tr.append(el('td', null, `${describe(cl.accept)} — ${cl.rationale}`));
      t.append(tr);
    }
    box.append(t);
  }));
  pane.append(c);
}

function summarise(b) {
  switch (b.t) {
    case 'ADMIT': return b.member.slice(0, 10);
    case 'REJECT': return `${b.applicant.slice(0, 10)} (${b.outcome}${b.failedDims.length ? `: ${b.failedDims.join(', ')}` : ''})`;
    case 'BAN': case 'KICK': return `${(b.target || '?').slice(0, 10)} rule=${b.ruleId} ${b.reason ? `"${b.reason}"` : '(no reason given)'}`;
    case 'PREDICATE_SET': return `v${b.version} — ${b.diffRationale}`;
    case 'RELAY_ACK': return `${b.sender.slice(0, 8)}→${(b.recipient || 'room').slice(0, 8)}`;
    case 'JOIN_REQUEST': return b.applicant.slice(0, 10);
    case 'HOST_PREF_PUBLISH': return b.intent;
    case 'RULESET_SET': return `v${b.version}: ${b.rules.map((r) => r.id).join(', ')}`;
    default: return '';
  }
}

const shortPk = (h) => (h ? String(h).slice(0, 8) : 'someone');

/** Every entry type, in a sentence. The initialism goes in the working. */
const ENTRY_PLAIN = {
  NODE_GENESIS: () => 'this node started keeping its history here',
  ROOM_CREATE: (x) => `the space “${x.room?.title ?? ''}” was created`,
  PREDICATE_SET: (x) => `who gets in was changed — ${x.diffRationale || 'no reason given'}`,
  RULESET_SET: (x) => `the house rules were set (${(x.rules ?? []).length} of them)`,
  HOST_PREF_PUBLISH: (x) => `the host published what they are personally looking for, for ${x.intent}`,
  JOIN_REQUEST: (x) => `${shortPk(x.applicant)} knocked`,
  ADMIT: (x) => `${shortPk(x.member)} was let in`,
  REJECT: (x) => `${shortPk(x.applicant)} was turned away — ${x.outcome === 'host-discretion' ? 'the host simply decided not to' : x.outcome === 'indeterminate' ? 'they kept something private that the rule checks' : 'they did not match the rule'}`,
  BAN: (x) => `${shortPk(x.target)} was banned${x.reason ? ` — “${x.reason}”` : ', with no reason recorded'}`,
  KICK: (x) => `${shortPk(x.target)} was removed${x.reason ? ` — “${x.reason}”` : ', with no reason recorded'}`,
  UNBAN: (x) => `${shortPk(x.target)} was unbanned`,
  LEAVE: (x) => `${shortPk(x.member)} left`,
  MEMBER_STATS: () => 'the room published its aggregate statistics',
  RELAY_ACK: (x) => `the host records receiving a message from ${shortPk(x.sender)}`,
  FORK_OF: () => 'this space was forked from another node, and says so',
  APPEAL_OPEN: (x) => `${shortPk(x.appellant)} appealed a ban`,
  APPEAL_VERDICT: (x) => `an appeal was ${x.verdict}`,
  PAGE_SET: (x) => `${shortPk(x.author)} published a profile page`,
  PAGE_REMOVE: (x) => `the host took down ${shortPk(x.author)}’s profile page${x.reason ? ` — “${x.reason}”` : ', with no reason recorded'}`,
};

async function renderLog(pane, b) {
  const { entries, verification } = await api('/api/log');
  const sths = await api('/api/sth');
  const mine = entries.filter((x) => !x.room || x.room === b.room);

  const c = el('div', `card verdict ${verification.ok ? 'ok' : 'bad'}`);
  const h = el('h3');
  h.append(document.createTextNode('This node’s history'));
  const p = el('span', `badge ${verification.ok ? 'ok' : 'bad'}`);
  p.append(el('span', 'dot'));
  p.append(document.createTextNode(verification.ok ? 'checks out' : 'does not check out'));
  h.append(p);
  c.append(h);
  c.append(el('p', 'lead', verification.ok
    ? `Everything this node has done to this space is written down, in order, and the whole chain of ${verification.size} entries was checked on this device just now.`
    : 'The history this node published does not hold together. That is not a scoring judgement — a chain either verifies or it does not, and this one does not.'));
  for (const prob of verification.problems) c.append(el('div', 'ev', prob));
  c.append(working((box) => {
    box.append(el('div', 'mono',
      `${verification.size} entries · Merkle root ${verification.root.slice(0, 20)}… · ${sths.sths.length} signed tree heads`));
    box.append(el('div', 'note',
      'Each entry is hashed into an append-only Merkle tree and the root is signed. Two signed roots at the same tree size with different values would be a proof of equivocation, and that check runs on this device.'));
    const t = el('table', 'kv');
    for (const st of sths.sths.slice(-8).reverse()) {
      const tr = el('tr');
      tr.append(el('td', null, `size ${st.treeSize}`));
      tr.append(el('td', 'mono', `${st.rootHash.slice(0, 24)}…`));
      t.append(tr);
    }
    box.append(t);
  }, 'The tree heads'));
  pane.append(c);

  const list = el('div', 'card');
  list.append(el('h3', null, 'What has happened here'));
  list.append(el('div', 'note',
    'Newest first. Everything a host does that affects somebody else is in this list — that is what makes any of it checkable.'));
  for (const e of mine.slice(-70).reverse()) {
    const row = el('div', 'ev');
    const plain = ENTRY_PLAIN[e.body.t];
    row.append(el('div', 'det', plain ? cap1(plain(e.body)) : `${e.body.t} ${summarise(e.body)}`));
    row.append(el('div', 'lbl', new Date(e.ts).toLocaleString()));
    list.append(row);
  }
  list.append(working((box) => {
    const t = el('table', 'kv');
    for (const e of mine.slice(-70).reverse()) {
      const tr = el('tr');
      tr.append(el('td', null, `#${e.seq}`));
      tr.append(el('td', null, `${e.body.t} ${summarise(e.body)}`));
      t.append(tr);
    }
    box.append(t);
  }, 'The raw entries'));
  pane.append(list);
}

// -------------------------------------------------------------- buckets

const bucketCount = (d) =>
  d.kind.t === 'likert' ? d.kind.points
    : d.kind.t === 'categorical' ? d.kind.options.length
      : d.kind.t === 'numeric' ? d.kind.bins : 2;

const bucketOf = (d, v) => {
  if (d.kind.t === 'likert') return Math.max(0, Math.min(d.kind.points - 1, Math.round(Number(v)) - 1));
  if (d.kind.t === 'categorical') { const i = d.kind.options.indexOf(String(v)); return i < 0 ? null : i; }
  if (d.kind.t === 'numeric') {
    const f = (Number(v) - d.kind.min) / (d.kind.max - d.kind.min);
    return Math.max(0, Math.min(d.kind.bins - 1, Math.floor(f * d.kind.bins)));
  }
  return v ? 1 : 0;
};

async function bucketsFor(b) {
  // Publish coarse buckets ONLY for the dims this space's rule actually gates.
  const room = state.node.rooms.find((r) => r.id === b.room);
  const need = new Set(room.predicate.clauses.map((c) => c.dim));
  const out = {};
  for (const d of state.schema.dims) {
    if (!need.has(d.id)) continue;
    const ans = state.profile.self.answers.find((a) => a.dim === d.id);
    if (!ans || ans.visibility !== 'bucketed') continue;
    const n = bucketCount(d);
    const i = bucketOf(d, ans.value);
    const v = new Array(n).fill(0);
    if (i !== null) v[i] = 1;
    out[d.id] = v;
  }
  return out;
}

// ----------------------------------------------------------------- "You"

async function renderMe() {
  const pane = $('#mePane');
  pane.replaceChildren();

  if (!state.profile) {
    const c = el('div', 'card');
    c.append(el('h3', null, 'Create your identity'));
    c.append(el('div', 'note',
      'A keypair is generated here, in your browser. Nothing is registered anywhere. Your answers never leave this device.'));
    const nm = el('input');
    nm.placeholder = 'Display name';
    nm.style.marginTop = '10px';
    const go2 = el('button', 'primary wide', 'Create');
    go2.type = 'button';
    go2.style.marginTop = '10px';
    go2.onclick = async () => {
      state.profile = await newProfile(nm.value.trim() || 'anon');
      saveProfile();
      play('admit');
      toast('Identity created — save it to a file before you rely on it');
      renderMe();
    };
    c.append(nm, go2);
    pane.append(c);
    return;
  }

  const p = state.profile;
  const idc = el('div', 'card');
  idc.append(el('h3', null, p.displayName));
  const fp = el('div', 'fp', await fingerprint(p));
  idc.append(fp);
  idc.append(el('div', 'mono', `${p.self.answers.length} answers · ${Object.keys(p.prefs).length} preference set(s) · ${p.rooms.length} space(s)`));

  const nm = el('input');
  nm.value = p.displayName;
  nm.style.marginTop = '10px';
  nm.onchange = () => { p.displayName = nm.value.trim() || 'anon'; saveProfile(); renderMe(); };
  idc.append(nm);
  pane.append(idc);

  // --- questionnaire
  const qc = el('div', 'card');
  qc.append(el('h3', null, 'About you'));
  qc.append(el('div', 'note',
    'These stay on this device. A space only ever receives the coarse bucket for the dimensions its rule actually checks.'));
  const qb = el('button', 'primary wide', p.self.answers.length ? 'Edit answers' : 'Answer the questionnaire');
  qb.type = 'button';
  qb.style.marginTop = '10px';
  qb.onclick = () => { play('tap'); openQuestionnaire(); };
  qc.append(qb);
  pane.append(qc);

  // --- profile page
  const pc = el('div', 'card');
  pc.append(el('h3', null, 'Your page'));
  pc.append(el('div', 'note', p.page
    ? `Published and signed. ${Math.round(new TextEncoder().encode(JSON.stringify(p.page)).length / 1024)} KB, including any photos — they live inside the page, so no node can swap one.`
    : 'A page of your own: pick a theme, or nudge the colours, or write the HTML and CSS yourself. All three edit the same document, so you can start at any rung and climb.'));
  const pb = el('button', 'primary wide', p.page ? 'Edit your page' : 'Make a page');
  pb.type = 'button';
  pb.style.marginTop = '10px';
  pb.onclick = () => { play('open'); openEditor(); };
  pc.append(pb);
  pc.append(working((box) => {
    box.append(el('div', 'note',
      'Your page is signed with the same key as the rest of your identity, over deterministic CBOR bytes, and every reader verifies it on their own device before anything is drawn. It renders in a sandboxed frame with no scripts and no network access at all — which is what stops a page being a tracking beacon that reports who looked at it.'));
    if (p.page) {
      box.append(el('div', 'mono', `signature ${p.page.sig.slice(0, 24)}… · ${Object.keys(p.page.assets ?? {}).length} photo(s)`));
    }
  }, 'What happens when you publish'));
  pane.append(pc);

  // --- blocked people
  const blocked = [...blockedSet()];
  if (blocked.length) {
    const bc = el('div', 'card');
    bc.append(el('h3', null, `Blocked (${blocked.length})`));
    bc.append(el('div', 'note',
      'Blocks live on this device only. Nothing was sent to any node, so the people you blocked cannot tell, and there is nothing for a host to retaliate against.'));
    for (const pk of blocked) {
      const row = el('div', 'row');
      row.append(el('span', 'fp', pk.slice(0, 12)));
      const un = el('button', 'ghost', 'Unblock');
      un.type = 'button';
      un.onclick = () => { setBlocked(pk, false); renderMe(); };
      row.append(un);
      bc.append(row);
    }
    pane.append(bc);
  }

  // --- the movable file
  const fc = el('div', 'card');
  fc.append(el('h3', null, 'Your profile file'));
  fc.append(el('div', 'notice'));
  fc.querySelector('.notice').innerHTML =
    'This file <strong>is</strong> your identity. Copy it to another phone and you are the same person there. '
    + 'Lose it with no copy and it is gone — there is no recovery server, and nobody can restore it for you.';
  const row = el('div', 'row');
  const b1 = el('button', 'primary', 'Save to file');
  b1.type = 'button';
  b1.onclick = () => {
    p.exportedAt = Date.now();
    saveProfile();
    download(`3rdspace-${p.displayName}.json`, JSON.stringify(p, null, 2));
    play('save');
    toast('Saved. Keep it like a house key.');
  };
  const b2 = el('button', 'ghost', 'Encrypted…');
  b2.type = 'button';
  b2.onclick = () => exportEncrypted();
  const b3 = el('button', 'ghost', 'Load a file');
  b3.type = 'button';
  b3.onclick = () => $('#fileImport').click();
  row.append(b1, b2, b3);
  fc.append(row);
  pane.append(fc);

  // --- sound
  const sc = el('div', 'card');
  sc.append(el('h3', null, 'Sound'));
  const sw = el('div', 'switch');
  const txt = el('div', 'txt', 'Sound effects');
  txt.append(el('small', null, 'Synthesised live — no audio files, nothing downloaded.'));
  const tg = el('button', 'toggle');
  tg.type = 'button';
  tg.setAttribute('role', 'switch');
  tg.setAttribute('aria-checked', String(sound.enabled));
  tg.append(el('span', 'knob'));
  tg.onclick = () => {
    setEnabled(!sound.enabled);
    tg.setAttribute('aria-checked', String(sound.enabled));
  };
  sw.append(txt, tg);
  sc.append(sw);
  const pv = el('button', 'ghost wide', 'Preview the palette');
  pv.type = 'button';
  pv.onclick = () => { ensureAudio(); previewAll(); toast('open · admit · receive · send · alert · proof'); };
  sc.append(pv);
  pane.append(sc);

  // --- install
  const ic = el('div', 'card');
  ic.append(el('h3', null, 'Install on this device'));
  if (state.installEvent) {
    ic.append(el('div', 'note', 'Adds 3rdSpace to your home screen and runs it full-screen, offline-capable.'));
    const ib = el('button', 'primary wide', 'Add to home screen');
    ib.type = 'button';
    ib.style.marginTop = '10px';
    ib.onclick = async () => {
      state.installEvent.prompt();
      const { outcome } = await state.installEvent.userChoice;
      if (outcome === 'accepted') { play('admit'); toast('Installed'); }
      state.installEvent = null;
      renderMe();
    };
    ic.append(ib);
  } else if (window.matchMedia('(display-mode: standalone)').matches) {
    ic.append(el('div', 'note', 'Running as an installed app. ✓'));
  } else {
    ic.append(el('div', 'note',
      'Android Chrome: menu ⋮ → “Add to Home screen”. iOS Safari: Share → “Add to Home Screen”. '
      + 'For the full installable app over plain HTTP, allowlist this origin in chrome://flags/#unsafely-treat-insecure-origin-as-secure.'));
  }
  pane.append(ic);
}

async function exportEncrypted() {
  const pass = prompt('Passphrase for this file (you will need it to load the profile again):');
  if (!pass) return;
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    enc.encode(JSON.stringify(state.profile))));
  download(`3rdspace-${state.profile.displayName}.enc.json`, JSON.stringify({
    magic: '3rdspace-profile-encrypted', version: 1,
    kdf: { name: 'pbkdf2', iterations: 310000, hash: 'SHA-256', salt: hex(salt) },
    cipher: 'aes-256-gcm', iv: hex(iv), ciphertext: hex(ct), pk: state.profile.identity.pk,
  }, null, 2));
  play('save');
  toast('Encrypted profile saved');
}

// ------------------------------------------------------- profile pages

/**
 * The editor lives in its own view rather than the bottom sheet: three rungs, a
 * live preview and a code pane do not fit in a sheet, and a page is something
 * people sit with.
 */
function openEditor() {
  state.backTo = 'v-me';
  $('#pageTitle').textContent = 'Your page';
  const root = $('#pagePane');
  root.replaceChildren();
  state.editor = mountEditor({
    el, toast, play, root,
    profile: state.profile,
    saveProfile,
    /**
     * Publishing is a separate step from saving, and it is allowed to fail
     * loudly: the page is yours on this device whether or not a node will
     * carry it.
     */
    publish: async (signed) => {
      if (DEMO) return;
      try {
        const r = await fetch('/api/page', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signed),
        }).then((x) => x.json());
        if (!r.ok) toast(`Saved here, but this node refused it: ${r.error}`);
      } catch {
        toast('Saved on this device. This node could not be reached, so it has not been published yet.');
      }
    },
  });
  go('v-page');
}

/** Somebody else's page, verified and sandboxed before anything is drawn. */
async function openPage(pk, name) {
  state.backTo = 'v-space';
  state.viewingPage = pk;
  $('#pageTitle').textContent = name || pk.slice(0, 12);
  const root = $('#pagePane');
  root.replaceChildren();
  go('v-page');

  let signed = null;
  try { signed = await api(`/api/page?author=${pk}`); }
  catch { /* handled below */ }

  if (!signed || signed.error) {
    const c = el('div', 'card');
    c.append(el('h3', null, 'No page'));
    if (signed?.removedByHost) {
      const r = signed.removedByHost;
      c.append(el('div', 'notice',
        `The host took this page down${r.reason ? ` — “${r.reason}”` : ', without recording a reason'}. That removal is entry #${r.seq} in this node’s log, which is why you can be told about it at all: a host who deletes pages leaves a trail, and the audit reads it.`));
    } else {
      c.append(el('div', 'note', 'This person has not published a page.'));
    }
    root.append(c);
    return;
  }
  await mountViewer({ el, play, toast }, root, signed, { author: pk });
}

// ------------------------------------------------------- questionnaire

function openQuestionnaire() {
  const body = $('#sheetBody');
  body.replaceChildren();
  body.append(el('div', 'grip'));
  body.append(el('h2', null, 'About you'));
  body.append(el('p', 'hint',
    'These answers stay on this device. A space only receives the coarse bucket for the dimensions its admission rule actually checks.'));

  const readers = [];
  for (const d of state.schema.dims) {
    const cur = state.profile.self.answers.find((a) => a.dim === d.id);
    const q = el('div', 'q');
    q.append(el('div', 'p', d.prompt));
    const ctl = el('div', 'ctl');
    let input;

    if (d.kind.t === 'likert') {
      input = el('input');
      input.type = 'range'; input.min = 1; input.max = d.kind.points;
      input.value = cur ? cur.value : Math.ceil(d.kind.points / 2);
      const out = el('div', 'out');
      const paint = () => {
        const i = Number(input.value);
        out.textContent = i <= 1 ? d.kind.anchors[0] : i >= d.kind.points ? d.kind.anchors[1] : `${i} / ${d.kind.points}`;
      };
      paint();
      input.oninput = paint;
      ctl.append(input, out);
    } else if (d.kind.t === 'boolean') {
      input = el('select');
      for (const [v, t] of [['', '—'], ['yes', 'Yes'], ['no', 'No']]) {
        const o = el('option', null, t); o.value = v; input.append(o);
      }
      input.value = cur === undefined ? '' : (cur.value ? 'yes' : 'no');
      ctl.append(input);
    } else if (d.kind.t === 'categorical') {
      input = el('select');
      const o0 = el('option', null, '—'); o0.value = ''; input.append(o0);
      for (const o of d.kind.options) { const x = el('option', null, o); x.value = o; input.append(x); }
      if (cur) input.value = String(cur.value);
      ctl.append(input);
    } else {
      input = el('input');
      input.type = 'number'; input.inputMode = 'numeric';
      input.min = d.kind.min; input.max = d.kind.max;
      if (cur) input.value = cur.value;
      ctl.append(input);
    }
    q.append(ctl);

    const priv = el('label', 'priv');
    const cb = el('input'); cb.type = 'checkbox';
    cb.checked = cur ? cur.visibility === 'private' : false;
    priv.append(cb, document.createTextNode('Keep private — spaces gating this will see “can’t tell”, not “no”'));
    q.append(priv);
    body.append(q);

    readers.push(() => {
      const raw = input.value;
      if (raw === '' || raw === null) return null;
      const value = d.kind.t === 'boolean' ? raw === 'yes' : d.kind.t === 'categorical' ? raw : Number(raw);
      return { dim: d.id, value, visibility: cb.checked ? 'private' : 'bucketed' };
    });
  }

  const row = el('div', 'row');
  const save = el('button', 'primary', 'Save');
  save.type = 'submit'; save.value = 'save';
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.type = 'submit'; cancel.value = 'close';
  row.append(save, cancel);
  body.append(row);

  const dlg = $('#sheet');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    const answers = readers.map((r) => r()).filter(Boolean);
    state.profile.self = { schema: state.schema.id, answers, updatedAt: Date.now() };
    saveProfile();
    play('save');
    toast(`Saved ${answers.length} answers — on this device only`);
    renderMe();
  }, { once: true });
}

// -------------------------------------------------------------- plumbing

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', 'toast', msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3600);
}

function go(view) {
  state.view = view;
  for (const s of document.querySelectorAll('.view')) s.classList.toggle('on', s.id === view);
  // v-page is not a tab. While it is open no tab is lit, so the bottom bar does
  // not claim you are somewhere you are not.
  for (const b of $('#tabs').children) b.classList.toggle('on', b.dataset.view === view);
  if (view === 'v-space') renderSpace();
  if (view === 'v-me') renderMe();
}

async function refresh() {
  try {
    state.node = await api('/api/node');
    const b = await api('/api/badges');
    state.badges = b.badges ?? [];
  } catch {
    toast('Cannot reach this node');
    return;
  }
  if (!state.sel && state.badges.length) state.sel = state.badges[0].room;
  renderSpaces();
  if (state.view === 'v-space') renderSpace();
}

async function init() {
  makeBubbles();

  // Hosted build? Then there is no node behind this page: fall back to the
  // bundled published data and compute the audits here.
  if (await tryDemo()) {
    const banner = el('div', 'notice');
    banner.innerHTML = '<strong>Hosted demo.</strong> Three nodes\u2019 published data ships with this page, and every capture score below is recomputed <strong>in your browser</strong> from those bytes by the same detector code a real node runs. Joining, posting and hosting need a live node \u2014 clone the repo and run <code>node src/host/swarm.ts</code> for the full thing.';
    document.querySelector('#v-spaces').prepend(banner);
  }

  state.schema = await api('/api/schema');
  state.profile = loadProfile();
  if (state.profile?.viewScope) {
    state.scope = state.profile.viewScope;
    for (const x of $('#scopeToggle').children) x.classList.toggle('on', x.dataset.scope === state.scope);
  }

  // The AudioContext may only start inside a gesture, so arm it on the first one.
  const arm = () => { ensureAudio(); window.removeEventListener('pointerdown', arm); };
  window.addEventListener('pointerdown', arm, { once: true });

  $('#scopeToggle').onclick = (e) => {
    const b = e.target.closest('button[data-scope]');
    if (!b) return;
    state.scope = b.dataset.scope;
    for (const x of $('#scopeToggle').children) x.classList.toggle('on', x === b);
    if (state.profile) { state.profile.viewScope = state.scope; saveProfile(); }
    play('toggle');
    renderSpaces();
  };

  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    play('tap');
    state.viewingPage = null;
    go(b.dataset.view);
  };

  $('#btnPageBack').onclick = () => {
    play('tap');
    state.viewingPage = null;
    state.editor = null;
    go(state.backTo);
  };

  $('#btnHost').onclick = async () => {
    if (DEMO) return demoWriteBlocked();
    const title = prompt('Name your space:');
    if (!title) return;
    const topic = (prompt('Topic tags, comma separated (e.g. climbing, queer):') || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const scope = prompt('Dating, friendship, or both?', 'both');
    await fetch('/api/room', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title, topic,
        scope: ['dating', 'friendship', 'both'].includes(scope) ? scope : 'both',
        predicate: { clauses: [] },
      }),
    });
    play('admit');
    toast('Space created — set who gets in from “Who gets in”');
    refresh();
  };

  const fi = el('input');
  fi.type = 'file'; fi.id = 'fileImport'; fi.accept = 'application/json'; fi.hidden = true;
  fi.onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (obj.magic === '3rdspace-profile-encrypted') { toast('Encrypted profiles load from the CLI in this build'); return; }
      if (obj.magic !== '3rdspace-profile') throw new Error('not a profile file');
      state.profile = obj;
      saveProfile();
      play('admit');
      toast(`Loaded ${obj.displayName} — you are that identity on this device now`);
      renderMe();
    } catch (err) { play('nope'); toast(`Could not load: ${err.message}`); }
  };
  document.body.append(fi);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    if (state.view === 'v-me') renderMe();
  });

  try {
    if (DEMO) throw new Error('no live node to stream from');
    const es = new EventSource('/api/events');
    es.addEventListener('message', () => { if (state.view === 'v-space' && state.tab === 'chat') { play('receive'); renderSpace(); } });
    es.addEventListener('members', () => refresh());
    es.addEventListener('rooms', () => refresh());
    state.es = es;
  } catch { /* live updates are optional */ }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* needs a secure context */ });
  }

  await refresh();
  go('v-spaces');
}

init();
