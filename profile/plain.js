/**
 * M11 — the plain-language surface.
 *
 * The app used to lead with Merkle inclusion proofs, signed tree heads, capture
 * scores and detector initialisms. All of that still exists and none of it is
 * deleted; it is one tap away behind "Show the working". What comes first is a
 * sentence.
 *
 * TWO RULES KEEP THIS HONEST, and they are enforced here rather than promised:
 *
 *  1. THE PLAIN SENTENCE IS GENERATED FROM THE SAME NUMBERS. Every string below
 *     is a template selected by a threshold and filled from `report`. There is
 *     no per-room copy, no hand-written case, and no path by which the friendly
 *     text can drift from the evidence it claims to summarise.
 *
 *  2. YOU MAY HIDE THE ARITHMETIC. YOU MAY NOT SOFTEN THE VERDICT. The band is
 *     a pure function of the score and the presence of proofs — the same
 *     thresholds the badge already used — and a cryptographic proof pins it to
 *     the worst band whatever the score says. If the detectors say a room looks
 *     captured, this says "something's off". It does not say the room has a
 *     unique vibe. Warmth in the tone, never in the finding.
 *
 * `src/tests/plain-language.test.ts` asserts both: that no higher score ever
 * produces a friendlier band, and that a report carrying a proof never renders
 * as "looks fine".
 */

/** The same cut points the capture badge has always used. */
export const BANDS = { fine: 0.35, look: 0.6 };

const BAND_TEXT = {
  fine: { title: 'Looks fine', tone: 'ok', lead: 'Nothing here looks like the host is farming the room.' },
  look: { title: 'Worth a look', tone: 'warn', lead: 'A couple of things here are worth reading before you join.' },
  off: { title: 'Something’s off', tone: 'bad', lead: 'This room shows the pattern of a host running it for themselves.' },
  proof: { title: 'Caught in the act', tone: 'bad', lead: 'This is not a judgement call. There is a proof on file that anyone can check.' },
  unknown: { title: 'Can’t tell', tone: 'unk', lead: 'This node does not publish enough for anyone to check it.' },
};

/**
 * Dimension ids in words. A dimension not listed here is prettified from its id,
 * so a schema that grows does not start printing raw identifiers at people.
 */
const DIM_WORDS = {
  'person.age': 'your age',
  'person.introvert': 'how outgoing you are',
  'person.tidy': 'how tidy you are',
  'pol.axis': 'your politics',
  'body.type': 'your body',
  'habit.smoke': 'whether you smoke',
  'habit.drink': 'how much you drink',
  'health.status': 'your health',
  'econ.income': 'your income',
  'geo.region': 'where you live',
  'lang.primary': 'the language you speak',
  'identity.queer': 'whether you are LGBTQ+',
  'life.parent': 'whether you are a parent',
  'faith.practice': 'your religious practice',
};

function dimWords(id) {
  if (DIM_WORDS[id]) return DIM_WORDS[id];
  const tail = String(id).split('.').pop() ?? String(id);
  return tail.replace(/[-_]/g, ' ');
}

/** Off-topic dimensions PP named, pulled out of its own evidence rows. */
function offTopicDims(report) {
  const pp = report.detectors?.find((d) => d.id === 'PP');
  if (!pp) return [];
  return pp.evidence
    .map((e) => /^Off-topic clause:\s*(\S+)/.exec(e.label ?? ''))
    .filter(Boolean)
    .map((m) => dimWords(m[1]));
}

/** English list: "a, b and c". */
function list(xs) {
  const a = xs.filter(Boolean);
  if (a.length === 0) return '';
  if (a.length === 1) return a[0];
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

/**
 * One plain clause per detector, built from that detector's own numbers.
 *
 * Each entry returns null when the detector has nothing to say, so a clause
 * never appears without a measurement behind it.
 */
const CLAUSES = {
  PP: (d, report) => {
    if (d.state !== 'ok' || d.score <= 0.02) return null;
    const dims = offTopicDims(report);
    const n = Math.round(d.raw?.offTopicClauses ?? dims.length);
    if (!n) return null;
    return dims.length
      ? `the rule for getting in filters on ${list(dims.slice(0, 3))} — ${n === 1 ? 'a thing' : 'things'} this room is not about, and ${n === 1 ? 'it matches' : 'they match'} the host’s own stated taste more closely than what people generally want`
      : `the rule for getting in filters on ${n} thing${n === 1 ? '' : 's'} this room is not about`;
  },
  PD: (d) => {
    if (d.state !== 'ok' || d.score <= 0.02) return null;
    const v = Math.round(d.raw?.versions ?? 0);
    return `the rule for getting in has been tightened ${v ? `${v - 1} time${v - 1 === 1 ? '' : 's'} ` : ''}in the host’s own direction, in steps small enough that no single change looks like much`;
  },
  BF: (d) => {
    if (d.state !== 'ok' || d.score <= 0.05) return null;
    return 'people are being removed here in a pattern that tracks who the host is interested in, rather than who broke a rule';
  },
  SS: (d) => {
    if (d.state !== 'ok' || d.score <= 0.05) return null;
    return 'messages from at least one person here are not arriving, while that person’s own device says they were online and sent them';
  },
  HCC: (d) => {
    if (d.state !== 'ok' || d.score <= 0.15) return null;
    return 'the host sits centrally in who matches whom here — though this measure does not tell captured rooms apart from honestly narrow ones, so on its own it means little';
  },
  // The weighted variant says the same thing about the same room, so it gets the
  // same words. An earlier version returned null here, which put "nothing
  // unusual" next to a score of 94 in the working — a line that contradicted the
  // number printed beside it. `plainVerdict` de-duplicates identical clauses, so
  // the summary still says it once.
  HCC_W: (d, report) => CLAUSES.HCC(d, report),
  PACK: (d) => {
    if (d.state !== 'ok' || d.score <= 0.1) return null;
    return 'a group of accounts here behave as though one person controls them';
  },
  IWR: (d) => {
    if (d.state !== 'ok' || d.score <= 0.1) return null;
    return 'most accounts here have no history anywhere else on the network, so the room’s numbers are easy for one person to move';
  },
  DR: (d) => {
    if (d.state !== 'ok' || d.score <= 0.02) return null;
    const n = Math.round(d.raw?.unexplained ?? 0);
    const of = Math.round(d.raw?.checkable ?? 0);
    if (!n) return null;
    return `${n} of the ${of} people this room turned away met every condition it publishes — so whatever the real rule for getting in is, it is not the one on the page`;
  },
};

const PROOF_WORDS = {
  equivocation: 'this node has signed two different versions of its own history',
  truncation: 'this node has deleted something it had already proved was in its history',
  'post-hoc-rule': 'someone was banned here under a rule that did not exist yet when they were banned',
  'unlogged-enforcement': 'this node acted on someone without recording it',
  'forged-block': 'this node produced a block declaration its supposed author never signed',
};

/**
 * Detectors that may never write the headline sentence.
 *
 * HCC and its weighted twin are MEASURED not to separate a captured room from
 * an honestly narrow one in this regime — see DETECTION §2.5 and sim/RESULTS.md,
 * where the host's centrality rank interleaves at 4/24 for honest niche and
 * 4/21 for capture-by-predicate. A detector that cannot tell the two apart must
 * not be the first thing a reader is told, because the first sentence is the one
 * most people will act on. It still appears in "show the working", still counts
 * in the score exactly as it always did, and its wording carries the caveat.
 *
 * This is the same discipline as reporting the bad number: the friendly surface
 * inherits the project's own findings about its detectors rather than flattening
 * them into equal confidence.
 */
const NOT_HEADLINE = new Set(['HCC', 'HCC_W']);

/**
 * The band. A pure function of the score, whether the room is auditable, and
 * whether a proof exists — nothing else may reach it.
 */
export function bandOf(report) {
  if (report?.proofs?.length) return 'proof';
  if (!report?.auditable || report.score === null || report.score === undefined) return 'unknown';
  if (report.score < BANDS.fine) return 'fine';
  if (report.score < BANDS.look) return 'look';
  return 'off';
}

/**
 * The whole plain-language summary of one capture report.
 *
 * @returns {{ band: string, tone: string, title: string, sentence: string,
 *             because: string[], working: string }}
 */
export function plainVerdict(report) {
  const band = bandOf(report);
  const text = BAND_TEXT[band];

  const proofs = (report?.proofs ?? []).map((p) => PROOF_WORDS[p.kind] ?? p.summary);
  const ranked = [...(report?.detectors ?? [])]
    .filter((d) => d && d.state === 'ok')
    .sort((a, b) => b.score - a.score);

  // Ranked by score, but with the detectors that cannot discriminate pushed to
  // the back of the queue. They are still shown — hiding a measurement because
  // it is weak would be its own dishonesty — they just do not get to speak
  // first, in the headline or in the reasons underneath it.
  const clauses = [];
  const headlineClauses = [];
  const ordered = [
    ...ranked.filter((d) => !NOT_HEADLINE.has(d.id)),
    ...ranked.filter((d) => NOT_HEADLINE.has(d.id)),
  ];
  for (const d of ordered) {
    const f = CLAUSES[d.id];
    if (!f) continue;
    const c = f(d, report);
    if (!c || clauses.includes(c)) continue;
    clauses.push(c);
    if (!NOT_HEADLINE.has(d.id)) headlineClauses.push(c);
    if (clauses.length >= 4) break;
  }

  let sentence;
  if (band === 'proof') {
    sentence = `${text.lead} In this room, ${list(proofs.slice(0, 2))}.`;
  } else if (band === 'unknown') {
    const why = !report?.auditable
      ? 'It publishes no history to check, which is not the same as having nothing to hide — a host who declines the audit is showing you exactly as much as a host who fails it.'
      : 'Too little has happened here yet for any of the checks to say anything. A quiet new room is not thereby innocent.';
    sentence = `${text.lead} ${why}`;
  } else if (band === 'fine') {
    // A clean band never leads with an accusation. Leading with one would
    // contradict the very band it sits under, which is the exact drift between
    // summary and evidence this surface exists to prevent. Anything a detector
    // did say is still shown, immediately below, in `because`.
    sentence = 'Every check that could run here came back clean. The room may be narrow, but it is narrow about its own subject.';
  } else if (headlineClauses.length === 0) {
    sentence = `${text.lead} No single check stands out on its own; the score comes from several of them being slightly high at once.`;
  } else {
    sentence = `${cap(headlineClauses[0])}.`;
  }

  const because = clauses
    .filter((c) => band === 'fine' || c !== headlineClauses[0])
    .map(cap);
  if (band === 'fine') {
    const quiet = ranked.filter((d) => d.score < 0.05).length;
    if (quiet) because.push(`${quiet} of the ${ranked.length} checks that could run returned nothing at all`);
  }
  const skipped = (report?.detectors ?? []).filter((d) => d.state !== 'ok');
  if (skipped.length) {
    because.push(`${skipped.length} check${skipped.length === 1 ? '' : 's'} could not run here, so ${skipped.length === 1 ? 'it is' : 'they are'} counted as “no information” rather than “clean”`);
  }

  return {
    band,
    tone: text.tone,
    title: text.title,
    sentence,
    because,
    working: 'Show the working',
  };
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Plain wording for a detector whose state is not `ok`. */
export const STATE_WORDS = {
  'insufficient-data': 'not enough has been published here to run this check',
  'too-small-to-audit': 'this room is too small for this check to mean anything',
  'insufficient-history': 'this room is too new for this check — and being new is not innocence',
  'insufficient-coverage': 'too few people here publish the numbers this check needs',
  unauditable: 'the host does not publish what this check needs',
  'not-applicable': 'this check does not apply to a room set up like this one',
  ok: 'ran',
};

/** One plain line per detector, for the "show the working" list. */
export function plainDetector(d, report) {
  if (d.state !== 'ok') return { name: DETECTOR_NAMES[d.id] ?? d.id, line: STATE_WORDS[d.state] ?? d.state, tone: 'unk' };
  const clause = CLAUSES[d.id]?.(d, report);
  return {
    name: DETECTOR_NAMES[d.id] ?? d.id,
    line: clause ? cap(clause) : 'nothing unusual',
    tone: d.score > 0.5 ? 'bad' : d.score > 0.25 ? 'warn' : 'ok',
  };
}

export const DETECTOR_NAMES = {
  HCC: 'Who matches whom',
  HCC_W: 'Who matches whom, weighted by how established each account is',
  PP: 'What the entry rule filters on',
  PD: 'How the entry rule has changed',
  BF: 'Who gets removed, and when',
  SS: 'Whether messages arrive',
  PACK: 'Accounts under one hand',
  IWR: 'How established the accounts here are',
  DR: 'Whether the rule for getting in is the real one',
};

/** Plain wording for the sanitiser's refusals, used by the editor. */
export function plainRemoval(r) {
  return { what: r.what, why: r.why, instead: r.instead };
}
