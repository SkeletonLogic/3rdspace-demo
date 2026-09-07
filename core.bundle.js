// src/core/schema.ts
function dimById(schema, id) {
  return schema.dims.find((d) => d.id === id);
}
function bucketCount(d) {
  switch (d.kind.t) {
    case "likert":
      return d.kind.points;
    case "categorical":
      return d.kind.options.length;
    case "numeric":
      return d.kind.bins;
    case "boolean":
      return 2;
  }
}
function bucketValue(d, i) {
  switch (d.kind.t) {
    case "likert":
      return i + 1;
    case "categorical":
      return d.kind.options[i] ?? d.kind.options[0];
    case "numeric": {
      const { min, max, bins } = d.kind;
      return min + (i + 0.5) / bins * (max - min);
    }
    case "boolean":
      return i === 1;
  }
}
function isOnTopic(d, topic) {
  return d.tags.some((t) => topic.includes(t));
}

// src/core/acceptance.ts
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function evalAcceptance(d, a, v) {
  switch (a.t) {
    case "any":
      return 1;
    case "likert-band": {
      const x = Number(v);
      if (!Number.isFinite(x)) return 0;
      const over = Math.max(0, Math.abs(x - a.target) - a.slack);
      return clamp01(1 - over / Math.max(1e-9, a.falloff));
    }
    case "range": {
      const x = Number(v);
      if (!Number.isFinite(x)) return 0;
      if (x >= a.lo && x <= a.hi) return 1;
      const dist = x < a.lo ? a.lo - x : x - a.hi;
      return clamp01(1 - dist / Math.max(1e-9, a.slack));
    }
    case "bool":
      return Boolean(v) === a.want ? 1 : 0;
    case "set": {
      if (Array.isArray(v)) {
        const set = new Set(a.ok);
        const inter = v.filter((x) => set.has(String(x))).length;
        const union = (/* @__PURE__ */ new Set([...v.map(String), ...a.ok])).size;
        return union === 0 ? 0 : inter / union;
      }
      if (a.ok.includes(String(v))) return 1;
      return a.partialCredit ?? 0;
    }
  }
}
function acceptanceVector(d, a) {
  const n = bucketCount(d);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = evalAcceptance(d, a, bucketValue(d, i));
  return out;
}
function normalise(v) {
  let s = 0;
  for (const x of v) s += x;
  if (s <= 0) return v.map(() => 1 / Math.max(1, v.length));
  return v.map((x) => x / s);
}
function selectivity(rho, a) {
  const p = normalise(rho);
  let e = 0;
  for (let i = 0; i < a.length; i++) e += p[i] * (a[i] ?? 0);
  return clamp01(1 - e);
}
function overlap(rho, a, b) {
  const p = normalise(rho);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < p.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    ab += p[i] * x * y;
    aa += p[i] * x * x;
    bb += p[i] * y * y;
  }
  const den = Math.sqrt(aa * bb);
  return den <= 1e-12 ? 0 : clamp01(ab / den);
}
function uniformRho(n) {
  return new Array(n).fill(1 / n);
}

// src/core/matching.ts
var BUCKET_MIDPOINTS = [0.125, 0.375, 0.625, 0.875];
var CONF_WEIGHTS = [0.25, 0.6, 1];

// src/core/ldp.ts
var K_BUCKETS = 4;
function rrKeepProbability(epsilon, k = K_BUCKETS) {
  if (!Number.isFinite(epsilon)) return 1;
  const e = Math.exp(epsilon);
  return e / (e + k - 1);
}
function debiasedCompat(observedBucket, epsilon, k = K_BUCKETS) {
  const p = rrKeepProbability(epsilon, k);
  if (p >= 1) return BUCKET_MIDPOINTS[observedBucket] ?? 0.5;
  const q = (1 - p) / (k - 1);
  const denom = p - q;
  if (Math.abs(denom) < 1e-9) return 0.5;
  let est = 0;
  for (let i = 0; i < k; i++) {
    const obs = i === observedBucket ? 1 : 0;
    est += (obs - q) / denom * (BUCKET_MIDPOINTS[i] ?? 0.5);
  }
  return est;
}

// src/core/view.ts
function membersAt(view, ts) {
  const present = /* @__PURE__ */ new Set();
  for (const e of view.entries) {
    if (e.ts > ts) break;
    if (e.body.t === "ADMIT") {
      if (e.body.member) present.add(e.body.member);
    } else if (e.body.t === "BAN" || e.body.t === "KICK") {
      if (e.body.target) present.delete(e.body.target);
    } else if (e.body.t === "LEAVE") {
      if (e.body.member) present.delete(e.body.member);
    }
  }
  return [...present];
}
function currentMembers(view) {
  return membersAt(view, view.now);
}
function bans(view) {
  const out = [];
  for (const e of view.entries) {
    if (e.body.t !== "BAN" && e.body.t !== "KICK") continue;
    if (typeof e.body.target !== "string" || e.body.target.length === 0) continue;
    out.push({ entry: e, target: e.body.target, ruleId: e.body.ruleId ?? "(none)", ts: e.ts });
  }
  return out;
}
function contentRemovals(view) {
  const out = [];
  for (const e of view.entries) {
    if (e.body.t !== "PAGE_REMOVE") continue;
    if (typeof e.body.author !== "string" || !e.body.author) continue;
    out.push({ entry: e, author: e.body.author, ruleId: e.body.ruleId ?? "(none)", reason: e.body.reason ?? "", ts: e.ts });
  }
  return out;
}
function malformedEntries(view) {
  return view.entries.filter((e) => {
    if (e.body.t === "BAN" || e.body.t === "KICK") return typeof e.body.target !== "string" || !e.body.target;
    if (e.body.t === "ADMIT") return typeof e.body.member !== "string" || !e.body.member;
    return false;
  });
}
function memberDays(view) {
  const day = 864e5;
  const joins = /* @__PURE__ */ new Map();
  let total = 0;
  for (const e of view.entries) {
    if (e.body.t === "ADMIT") joins.set(e.body.member, e.ts);
    else if (e.body.t === "BAN" || e.body.t === "KICK") {
      const j = joins.get(e.body.target);
      if (j !== void 0) {
        total += (e.ts - j) / day;
        joins.delete(e.body.target);
      }
    } else if (e.body.t === "LEAVE") {
      const j = joins.get(e.body.member);
      if (j !== void 0) {
        total += (e.ts - j) / day;
        joins.delete(e.body.member);
      }
    }
  }
  for (const j of joins.values()) total += (view.now - j) / day;
  return Math.max(1e-6, total);
}

// src/core/bytes.ts
function short(h, n = 8) {
  if (!h) return "(none)";
  return h.length <= n ? h : h.slice(0, n);
}

// src/core/detectors/hcc.ts
var N_MIN_AUDIT = 8;
var MIN_COVERAGE = 0.4;
var key = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
function buildGraph(view, members) {
  const set = new Set(members);
  const acc = /* @__PURE__ */ new Map();
  for (const e of view.compatEdges) {
    if (e.intent !== view.intent) continue;
    if (!set.has(e.a) || !set.has(e.b) || e.a === e.b) continue;
    const k = key(e.a, e.b);
    const m = debiasedCompat(e.bucket, view.epsilon);
    const c = CONF_WEIGHTS[e.conf] ?? 0.5;
    const cur = acc.get(k) ?? { sum: 0, conf: 0, n: 0 };
    cur.sum += m * c;
    cur.conf += c;
    cur.n += 1;
    acc.set(k, cur);
  }
  const w = /* @__PURE__ */ new Map();
  for (const [k, v] of acc) {
    if (v.conf <= 0) continue;
    w.set(k, { m: v.sum / v.conf, c: v.conf / v.n });
  }
  return { nodes: members, w };
}
function centralityExcess(g, x) {
  let sX = 0, wX = 0, sAll = 0, wAll = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    for (let j = i + 1; j < g.nodes.length; j++) {
      const a = g.nodes[i], b = g.nodes[j];
      const e = g.w.get(key(a, b));
      if (!e) continue;
      sAll += e.c * e.m;
      wAll += e.c;
      if (a === x || b === x) {
        sX += e.c * e.m;
        wX += e.c;
      }
    }
  }
  const wRest = wAll - wX;
  if (wX <= 0 || wRest <= 0) return null;
  return sX / wX - (sAll - sX) / wRest;
}
function degreeCentralisation(g) {
  const n = g.nodes.length;
  if (n < 3) return 0;
  const deg = /* @__PURE__ */ new Map();
  for (const v of g.nodes) deg.set(v, 0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const e = g.w.get(key(g.nodes[i], g.nodes[j]));
      if (!e) continue;
      deg.set(g.nodes[i], (deg.get(g.nodes[i]) ?? 0) + e.m);
      deg.set(g.nodes[j], (deg.get(g.nodes[j]) ?? 0) + e.m);
    }
  }
  const vals = [...deg.values()];
  const max = Math.max(...vals);
  const sum = vals.reduce((a, d) => a + (max - d), 0);
  return sum / ((n - 1) * (n - 2) * 1);
}
function detectHcc(view, opts = {}) {
  const id = opts.label ?? "HCC";
  const members = currentMembers(view);
  const all = members.includes(view.host) ? members : [view.host, ...members];
  const blank = (state, headline) => ({
    id,
    score: 0,
    state,
    headline,
    evidence: [],
    raw: { n: all.length }
  });
  if (all.length < N_MIN_AUDIT) {
    return blank("too-small-to-audit", `${all.length} members \u2014 below the audit floor of ${N_MIN_AUDIT}`);
  }
  if (view.auditCoverage < MIN_COVERAGE) {
    return blank("insufficient-coverage", `only ${(view.auditCoverage * 100).toFixed(0)}% of members publish compatibility edges`);
  }
  let g = buildGraph(view, all);
  if (opts.weights) {
    const w2 = /* @__PURE__ */ new Map();
    for (const [k, v] of g.w) {
      const [a, b] = k.split("|");
      const wa = opts.weights.get(a) ?? 1;
      const wb = opts.weights.get(b) ?? 1;
      w2.set(k, { m: v.m, c: v.c * Math.sqrt(Math.max(0, wa) * Math.max(0, wb)) });
    }
    g = { nodes: g.nodes, w: w2 };
  }
  const T = /* @__PURE__ */ new Map();
  for (const x of all) {
    const t = centralityExcess(g, x);
    if (t !== null) T.set(x, t);
  }
  if (!T.has(view.host) || T.size < N_MIN_AUDIT) {
    return blank("insufficient-data", `only ${T.size} members have enough edges to place`);
  }
  const th = T.get(view.host);
  const others = [...T.entries()].filter(([k]) => k !== view.host);
  const geq = others.filter(([, v]) => v >= th).length;
  const p = (1 + geq) / (1 + others.length);
  const vals = [...T.values()];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1));
  const z = sd > 1e-9 ? (th - mean) / sd : 0;
  const cd = degreeCentralisation(g);
  const ranked = others.sort((a, b) => b[1] - a[1]).slice(0, 3);
  const evidence = [
    {
      label: "Permutation test",
      detail: `host centrality excess T = ${th.toFixed(3)}; ${geq} of ${others.length} members score at least as high (p = ${p.toFixed(3)})`,
      weight: 1 - p
    },
    {
      label: "Room shape",
      detail: `degree centralisation ${cd.toFixed(3)} (0 = clique, 1 = star); member T distribution mean ${mean.toFixed(3)} sd ${sd.toFixed(3)}`
    },
    {
      label: "Nearest members",
      detail: ranked.length ? ranked.map(([k, v]) => `${short(k)} T=${v.toFixed(3)}`).join(", ") : "no comparable members"
    },
    {
      label: "Reproduce this",
      detail: `recompute T(x) for every member from the ${view.compatEdges.length} signed edges in MEMBER_STATS; the host is at rank ${geq + 1} of ${others.length + 1}`
    }
  ];
  return {
    id,
    score: 1 - p,
    state: "ok",
    headline: `p = ${p.toFixed(3)} over ${all.length} members (z = ${z.toFixed(2)})`,
    evidence,
    raw: { p, z, T_host: th, mean, sd, n: all.length, centralisation: cd, coverage: view.auditCoverage }
  };
}

// src/core/detectors/pp.ts
var UNATTRIBUTED_WEIGHT = 0.5;
function rhoFor(view, dim) {
  const d = dimById(view.schema, dim);
  const n = d ? bucketCount(d) : 4;
  const r = view.population[dim];
  return r && r.length === n ? r : uniformRho(n);
}
function memberPrefVector(view, dim, n) {
  for (let i = view.stats.length - 1; i >= 0; i--) {
    const agg = view.stats[i].prefAggregate[view.intent]?.[dim];
    if (agg && agg.length === n) return agg;
  }
  return null;
}
function predicateTerms(view, predicate) {
  const terms = [];
  const hostPrefs = view.hostPrefsEarliest ?? view.hostPrefs;
  for (const c of predicate.clauses) {
    const d = dimById(view.schema, c.dim);
    if (!d) continue;
    const n = bucketCount(d);
    const rho = rhoFor(view, c.dim);
    const pv = acceptanceVector(d, c.accept);
    const sel = selectivity(rho, pv);
    const hv = hostPrefs?.accept[c.dim];
    const mv = memberPrefVector(view, c.dim, n);
    const gv = view.populationPrefs[c.dim];
    const hostWeight = hostPrefs?.weight[c.dim] ?? 0;
    terms.push({
      dim: c.dim,
      onTopic: isOnTopic(d, view.topic),
      sel,
      hostOverlap: hv && hv.length === n ? overlap(rho, pv, hv) : 0,
      memberOverlap: mv ? overlap(rho, pv, mv) : 0,
      popOverlap: gv && gv.length === n ? overlap(rho, pv, gv) : 0,
      // A host who gates a dimension but publishes no preference for it cannot
      // be attributed OR exonerated on that clause — see UNATTRIBUTED_WEIGHT.
      attributable: !!hv && hv.length === n && hostWeight > 0,
      contribution: 0
    });
  }
  return terms;
}
function detectPp(view) {
  const id = "PP";
  const predicate = view.predicateHistory.at(-1)?.predicate;
  const blank = (state, headline) => ({
    id,
    score: 0,
    state,
    headline,
    evidence: [],
    raw: {}
  });
  if (!predicate || predicate.clauses.length === 0) {
    return blank("not-applicable", "the room admits everyone \u2014 no predicate to attribute");
  }
  if (!view.hostPrefs && !view.hostPrefsEarliest) {
    return blank("unauditable", "the host publishes no preference vector, so provenance cannot be checked");
  }
  const terms = predicateTerms(view, predicate);
  const totalSel = terms.reduce((a, t) => a + t.sel, 0);
  if (totalSel <= 1e-9) {
    return blank("not-applicable", "the predicate excludes nobody");
  }
  let offTopicMass = 0;
  let onTopicMass = 0;
  let unattributedMass = 0;
  for (const t of terms) {
    const gap = t.attributable ? Math.max(0, t.hostOverlap - t.popOverlap) : UNATTRIBUTED_WEIGHT;
    t.contribution = t.sel * gap / totalSel;
    if (t.onTopic) onTopicMass += t.contribution;
    else {
      offTopicMass += t.contribution;
      if (!t.attributable) unattributedMass += t.contribution;
    }
  }
  const pp = offTopicMass;
  const ppOn = onTopicMass;
  const offTerms = terms.filter((t) => !t.onTopic && t.sel > 0.01).sort((a, b) => b.contribution - a.contribution);
  const onTerms = terms.filter((t) => t.onTopic && t.sel > 0.01).sort((a, b) => b.sel - a.sel);
  const evidence = [];
  for (const t of offTerms.slice(0, 4)) {
    evidence.push({
      label: `Off-topic clause: ${t.dim}`,
      detail: `excludes ${(t.sel * 100).toFixed(0)}% of the population; matches the host's own stated taste ${t.hostOverlap.toFixed(2)} vs what people generally want ${t.popOverlap.toFixed(2)} (this room's members: ${t.memberOverlap.toFixed(2)}, which the predicate itself helped cause and so is not used in the score)`,
      weight: t.contribution
    });
  }
  const unattributed = offTerms.filter((t) => !t.attributable);
  if (unattributed.length) {
    evidence.push({
      label: "Unattributable off-topic gating",
      detail: `${unattributed.map((t) => t.dim).join(", ")} \u2014 the room gates on these but the host publishes no preference for them, so the gating can be neither attributed to the host's taste nor explained as a shared norm. Counted at half weight.`,
      weight: unattributedMass
    });
  }
  if (offTerms.length === 0) {
    evidence.push({
      label: "No off-topic gating",
      detail: `all ${terms.length} clauses are on dimensions tagged for this room's topic (${view.topic.join(", ") || "none declared"})`
    });
  }
  if (onTerms.length) {
    evidence.push({
      label: "On-topic narrowness (not counted against the host)",
      detail: `${onTerms.map((t) => `${t.dim} sel=${t.sel.toFixed(2)}`).join(", ")} \u2014 PP_on = ${ppOn.toFixed(3)}`
    });
  }
  if (view.hostPrefRetroFit) {
    evidence.push({
      label: "Retro-fit",
      detail: "the host's committed preferences changed after this predicate was set; provenance is measured against their earliest commitment"
    });
  }
  const breadth = view.topic.length;
  evidence.push({
    label: "Declared topic breadth",
    detail: `${breadth} tag(s): ${view.topic.join(", ") || "(none)"} \u2014 a broad declared topic makes more clauses count as on-topic, so read PP alongside this`
  });
  return {
    id,
    score: Math.max(0, Math.min(1, pp)),
    state: "ok",
    headline: `PP = ${pp.toFixed(3)} off-topic host-tracking mass (PP_on = ${ppOn.toFixed(3)})`,
    evidence,
    raw: {
      pp,
      ppOn,
      unattributedMass,
      totalSel,
      clauses: terms.length,
      offTopicClauses: terms.filter((t) => !t.onTopic).length,
      topicBreadth: breadth,
      retroFit: view.hostPrefRetroFit ? 1 : 0
    }
  };
}
function detectPd(view) {
  const id = "PD";
  const hist = view.predicateHistory;
  const blank = (state, headline) => ({
    id,
    score: 0,
    state,
    headline,
    evidence: [],
    raw: { versions: hist.length }
  });
  if (hist.length < 2) return blank("insufficient-history", `only ${hist.length} predicate version(s) \u2014 drift needs history, and a young node is not thereby innocent`);
  const hostPrefs = view.hostPrefsEarliest ?? view.hostPrefs;
  if (!hostPrefs) return blank("unauditable", "the host publishes no preference vector");
  const align = (p) => {
    let mass = 0;
    for (const c of p.clauses) {
      const d = dimById(view.schema, c.dim);
      if (!d) continue;
      const n = bucketCount(d);
      const rho = rhoFor(view, c.dim);
      const pv = acceptanceVector(d, c.accept);
      const sel = selectivity(rho, pv);
      const hv = hostPrefs.accept[c.dim];
      const ov = hv && hv.length === n ? overlap(rho, pv, hv) : 0;
      mass += sel * ov;
    }
    return mass;
  };
  const A = hist.map((h) => align(h.predicate));
  const net = A[A.length - 1] - A[0];
  let tv = 0, maxStep = 0;
  for (let i = 1; i < A.length; i++) {
    const s = Math.abs(A[i] - A[i - 1]);
    tv += s;
    maxStep = Math.max(maxStep, s);
  }
  const R = tv > 1e-9 ? net / tv : 0;
  const pd = Math.max(0, net) * (0.5 + 0.5 * R);
  const evidence = [
    {
      label: "Net movement toward the host",
      detail: `host-aligned exclusion mass went ${A[0].toFixed(3)} \u2192 ${A[A.length - 1].toFixed(3)} across ${hist.length} versions (net ${net >= 0 ? "+" : ""}${net.toFixed(3)}) \u2014 the room got more exclusive in the host's own direction`,
      weight: Math.max(0, net)
    },
    {
      label: "Monotonicity",
      detail: `total variation ${tv.toFixed(3)}, ratio R = ${R.toFixed(2)} (1.0 = every change pushed the same way)`
    },
    {
      label: "Largest single change",
      detail: `maxStep = ${maxStep.toFixed(4)} \u2014 this is what a per-edit review threshold would have seen, ${maxStep < 0.02 ? "and it is small enough that no single edit looks notable" : "which is large enough to have been caught per-edit"}`
    },
    {
      label: "Reproduce this",
      detail: `recompute alignment for each PREDICATE_SET entry (seq ${hist.map((h) => h.seq).join(", ")}) against the host's earliest HOST_PREF_PUBLISH`
    }
  ];
  return {
    id,
    score: Math.max(0, Math.min(1, pd)),
    state: "ok",
    headline: `PD = ${pd.toFixed(3)} (net ${net >= 0 ? "+" : ""}${net.toFixed(3)}, R = ${R.toFixed(2)}, maxStep = ${maxStep.toFixed(4)})`,
    evidence,
    raw: { pd, net, tv, R, maxStep, versions: hist.length, first: A[0], last: A[A.length - 1] }
  };
}

// src/core/detectors/bf.ts
var LAMBDA_DAYS = 7;
var BETA = { f1: 0.9, f2: 0.9, f3: 0.7, f4: 0.9 };
function hostDirected(view, u) {
  const hp = view.hostPrefs ?? view.hostPrefsEarliest;
  const bu = view.buckets[u];
  if (!hp || !bu) return 0;
  let num = 0, den = 0;
  for (const [dim, accept] of Object.entries(hp.accept)) {
    const d = dimById(view.schema, dim);
    if (!d) continue;
    const w = hp.weight[dim] ?? 0;
    if (w <= 0) continue;
    const b = bu[dim];
    if (!b || b.length !== bucketCount(d)) continue;
    let mass = 0, tot = 0;
    for (let i = 0; i < b.length; i++) {
      mass += b[i] * (accept[i] ?? 0);
      tot += b[i];
    }
    if (tot <= 0) continue;
    num += w * (mass / tot);
    den += w;
  }
  return den > 0 ? num / den : 0;
}
function percentile(values, v) {
  if (values.length === 0) return 0.5;
  const below = values.filter((x) => x < v).length;
  return below / values.length;
}
function pageRemovalScore(view) {
  const removals = contentRemovals(view);
  if (removals.length === 0) return { score: 0, rows: [], n: 0 };
  const ruleSeq = /* @__PURE__ */ new Map();
  for (const e of view.entries) {
    if (e.body.t === "RULESET_SET") {
      for (const r of e.body.rules) if (!ruleSeq.has(r.id)) ruleSeq.set(r.id, e.seq);
    }
  }
  const scored = removals.map((r) => {
    const before = membersAt(view, r.ts - 1);
    const withHost = before.includes(view.host) ? before : [view.host, ...before];
    const g = buildGraph(view, withHost);
    const kk = (a, c) => a < c ? `${a}|${c}` : `${c}|${a}`;
    const M = (a, c) => g.w.get(kk(a, c))?.m ?? null;
    const peerMeans = [];
    for (const u of before) {
      const vals = before.filter((v) => v !== u).map((v) => M(u, v)).filter((x) => x !== null);
      if (vals.length) peerMeans.push(vals.reduce((a, c) => a + c, 0) / vals.length);
    }
    const hostVals = before.map((u) => M(u, view.host)).filter((x) => x !== null);
    const tPeerVals = before.filter((v) => v !== r.author).map((v) => M(r.author, v)).filter((x) => x !== null);
    const tPeer = tPeerVals.length ? tPeerVals.reduce((a, c) => a + c, 0) / tPeerVals.length : null;
    const tHost = M(r.author, view.host);
    const f1 = tPeer !== null && tHost !== null ? Math.max(0, percentile(peerMeans, tPeer) - percentile(hostVals, tHost)) : 0;
    const intro = ruleSeq.get(r.ruleId);
    const f4 = intro === void 0 ? 1 : intro > r.entry.seq ? 1 : r.reason.length > 0 ? 0 : 0.5;
    const score = 1 - (1 - BETA.f1 * f1) * (1 - BETA.f4 * f4);
    return { r, f1, f4, score };
  });
  const mean = scored.reduce((a, x) => a + x.score, 0) / scored.length;
  const rows = scored.sort((a, b) => b.score - a.score).slice(0, 3).map((x) => ({
    label: `Profile page of ${short(x.r.author)} removed (seq ${x.r.entry.seq})`,
    detail: [
      x.f1 > 0.2 ? "they were well matched to the room and poorly matched to the host" : "no match-pattern marker",
      x.f4 >= 1 ? "the rule cited does not predate the removal" : x.f4 > 0 ? "no reason recorded" : `cited rule "${x.r.ruleId}"`
    ].join("; ") + ` [f1=${x.f1.toFixed(2)} f4=${x.f4.toFixed(2)}]`,
    weight: x.score
  }));
  rows.push({
    label: "Why page removals count here",
    detail: `${removals.length} profile page(s) taken down by this host. Removal is a log entry, so it is checkable \u2014 and a host who removes the pages of exactly the people the room was for is doing by deletion what the ban forensics above look for.`
  });
  return { score: Math.max(0, Math.min(1, mean)), rows, n: removals.length };
}
function detectBf(view) {
  const id = "BF";
  const allBans = bans(view);
  const blank = (state, headline) => ({
    id,
    score: 0,
    state,
    headline,
    evidence: [],
    raw: { bans: allBans.length }
  });
  const days = Math.max(1e-6, memberDays(view));
  const rate = allBans.length / days;
  const sizeOk = (p) => p.members > 0 && Math.abs(Math.log(p.members / Math.max(1, view.members.length))) < Math.log(3);
  const jaccard = (p) => {
    const inter = p.topic.filter((t) => view.topic.includes(t)).length;
    const union = (/* @__PURE__ */ new Set([...p.topic, ...view.topic])).size;
    return union === 0 ? 1 : inter / union;
  };
  const others = view.peers.filter((p) => p.node !== view.node);
  let peers = others.filter((p) => jaccard(p) >= 0.5 && sizeOk(p));
  let peerBasis = "same topic and size";
  if (peers.length < 3) {
    peers = others.filter((p) => jaccard(p) >= 0.2 && sizeOk(p));
    peerBasis = "related topic and similar size";
  }
  if (peers.length < 3) {
    peers = others.filter(sizeOk);
    peerBasis = "similar size, any topic";
  }
  if (peers.length < 3) {
    peers = others;
    peerBasis = "all known rooms";
  }
  let brZ = 0;
  if (peers.length >= 3) {
    const rs = peers.map((p) => p.bansPerMemberDay).sort((a, b) => a - b);
    const med = rs[Math.floor(rs.length / 2)];
    const mad = rs.map((r) => Math.abs(r - med)).sort((a, b) => a - b)[Math.floor(rs.length / 2)];
    const scale = Math.max(1e-6, 1.4826 * mad);
    brZ = (rate - med) / scale;
  }
  const pr = pageRemovalScore(view);
  if (allBans.length === 0) {
    return {
      id,
      score: pr.score,
      state: "ok",
      headline: pr.n ? `no bans in ${days.toFixed(0)} member-days, but ${pr.n} profile page(s) removed` : `no bans in ${days.toFixed(0)} member-days`,
      evidence: [
        { label: "Ban rate", detail: `0 bans; peer baseline drawn from ${peers.length} comparable rooms` },
        ...pr.rows
      ],
      raw: { bans: 0, rate: 0, brZ, peers: peers.length, pageRemovals: pr.n, pageRemovalScore: pr.score }
    };
  }
  const perBan = [];
  const ruleSeq = /* @__PURE__ */ new Map();
  for (const e of view.entries) {
    if (e.body.t === "RULESET_SET") {
      for (const r of e.body.rules) if (!ruleSeq.has(r.id)) ruleSeq.set(r.id, e.seq);
    }
  }
  const receiptedTargets = /* @__PURE__ */ new Set();
  for (const e of view.entries) {
    if ((e.body.t === "BAN" || e.body.t === "KICK") && e.body.reason && e.body.reason.length > 0) {
      receiptedTargets.add(e.body.target);
    }
  }
  for (const b of allBans) {
    const before = membersAt(view, b.ts - 1);
    const withHost = before.includes(view.host) ? before : [view.host, ...before];
    const g = buildGraph(view, withHost);
    const kk = (a, c) => a < c ? `${a}|${c}` : `${c}|${a}`;
    const M = (a, c) => g.w.get(kk(a, c))?.m ?? null;
    const peerMeans = [];
    for (const u of before) {
      const vals = before.filter((v) => v !== u).map((v) => M(u, v)).filter((x) => x !== null);
      if (vals.length) peerMeans.push(vals.reduce((a, c) => a + c, 0) / vals.length);
    }
    const hostVals = before.map((u) => M(u, view.host)).filter((x) => x !== null);
    const tPeerVals = before.filter((v) => v !== b.target).map((v) => M(b.target, v)).filter((x) => x !== null);
    const tPeer = tPeerVals.length ? tPeerVals.reduce((a, c) => a + c, 0) / tPeerVals.length : null;
    const tHost = M(b.target, view.host);
    const f1 = tPeer !== null && tHost !== null ? Math.max(0, percentile(peerMeans, tPeer) - percentile(hostVals, tHost)) : 0;
    const windowStart = b.ts - 30 * 864e5;
    const hostDm = /* @__PURE__ */ new Map();
    let hostDmTotal = 0;
    for (const a of view.relayAcks) {
      if (a.ts < windowStart || a.ts > b.ts) continue;
      if (a.sender !== view.host || !a.recipient) continue;
      hostDm.set(a.recipient, (hostDm.get(a.recipient) ?? 0) + 1);
      hostDmTotal++;
    }
    let f2 = 0;
    let rival = null;
    for (const u of before) {
      if (u === b.target) continue;
      const pursuit = hostDmTotal > 0 ? (hostDm.get(u) ?? 0) / hostDmTotal : 0;
      const m = M(b.target, u);
      if (m === null) continue;
      const v = m * hostDirected(view, u) * pursuit;
      if (v > f2) {
        f2 = v;
        rival = u;
      }
    }
    f2 = Math.min(1, f2 * 3);
    let f3 = 0;
    let deltaDays = Infinity;
    if (rival) {
      let first = Infinity;
      for (const a of view.relayAcks) {
        if (a.ts > b.ts) continue;
        const between = a.sender === b.target && a.recipient === rival || a.sender === rival && a.recipient === b.target;
        if (between) first = Math.min(first, a.ts);
      }
      if (Number.isFinite(first)) {
        deltaDays = (b.ts - first) / 864e5;
        f3 = Math.exp(-deltaDays / LAMBDA_DAYS);
      }
    }
    const intro = ruleSeq.get(b.ruleId);
    const f4 = intro === void 0 ? 1 : intro > b.entry.seq ? 1 : receiptedTargets.has(b.target) ? 0 : 0.5;
    const f = [f1, f2, f3, f4];
    const score = 1 - (1 - BETA.f1 * f1) * (1 - BETA.f2 * f2) * (1 - BETA.f3 * f3) * (1 - BETA.f4 * f4);
    perBan.push({
      entry: b.entry,
      target: b.target,
      score,
      f,
      note: [
        f1 > 0.2 ? `well matched to the room (pct ${percentile(peerMeans, tPeer ?? 0).toFixed(2)}) but not to the host` : "",
        rival && f2 > 0.05 ? `strong match for ${short(rival)}, whom the host was messaging` : "",
        Number.isFinite(deltaDays) && f3 > 0.1 ? `banned ${deltaDays.toFixed(1)} days after first contact with them` : "",
        f4 >= 1 ? "rule cited does not predate the ban" : f4 > 0 ? "no reason recorded" : ""
      ].filter(Boolean).join("; ") || "no forensic markers"
    });
  }
  const meanBan = perBan.reduce((a, b) => a + b.score, 0) / perBan.length;
  const rateMult = Math.max(0.5, Math.min(2, 1 + brZ / 3));
  const banPart = Math.max(0, Math.min(1, meanBan * rateMult));
  const bf = pr.n === 0 ? banPart : 1 - (1 - banPart) * (1 - pr.score);
  const worst = [...perBan].sort((a, b) => b.score - a.score).slice(0, 4);
  const evidence = worst.map((w) => ({
    label: `Ban of ${short(w.target)} (seq ${w.entry.seq})`,
    detail: `${w.note} [f1=${w.f[0].toFixed(2)} f2=${w.f[1].toFixed(2)} f3=${w.f[2].toFixed(2)} f4=${w.f[3].toFixed(2)}]`,
    weight: w.score
  }));
  const malformed = malformedEntries(view);
  if (malformed.length) {
    evidence.push({
      label: "Malformed log entries",
      detail: `${malformed.length} entry/entries (seq ${malformed.map((e) => e.seq).join(", ")}) are missing required fields and could not be assessed. A node that publishes unparseable entries is not thereby clean.`,
      weight: 0
    });
  }
  evidence.push(...pr.rows);
  evidence.push({
    label: "Ban rate vs peers",
    detail: peers.length >= 3 ? `${(rate * 1e3).toFixed(2)} bans per 1000 member-days; z = ${brZ.toFixed(2)} against ${peers.length} peer rooms (${peerBasis})` : `${(rate * 1e3).toFixed(2)} bans per 1000 member-days; too few comparable rooms (${peers.length}) for a baseline, so no rate multiplier applied`
  });
  return {
    id,
    score: bf,
    state: "ok",
    headline: `${allBans.length} ban(s), mean forensic score ${meanBan.toFixed(2)}, rate z = ${brZ.toFixed(2)}` + (pr.n ? `; ${pr.n} page removal(s) at ${pr.score.toFixed(2)}` : ""),
    evidence,
    raw: { bf, meanBan, banPart, brZ, bans: allBans.length, rate, peers: peers.length, pageRemovals: pr.n, pageRemovalScore: pr.score }
  };
}

// src/core/detectors/ss.ts
var HEARTBEAT_WINDOW_MS = 36e5;
var MIN_RECIPIENTS = 3;
var MIN_MSGS_PER_PAIR = 2;
var MIN_DELIVERABLE = 12;
function detectSs(view) {
  const id = "SS";
  const members = currentMembers(view);
  const blank = (state, headline) => ({
    id,
    score: 0,
    state,
    headline,
    evidence: [],
    raw: {}
  });
  const online = /* @__PURE__ */ new Map();
  for (const h of view.heartbeats) {
    if (h.room !== view.room) continue;
    let s = online.get(h.user);
    if (!s) {
      s = /* @__PURE__ */ new Set();
      online.set(h.user, s);
    }
    s.add(h.window);
  }
  const blocked = /* @__PURE__ */ new Set();
  for (const b of view.blocks) blocked.add(`${b.blocker}|${b.blocked}`);
  const acked = /* @__PURE__ */ new Set();
  for (const r of view.deliveryReceipts) acked.add(`${r.msgHash}|${r.recipient}`);
  const pairs = /* @__PURE__ */ new Map();
  for (const ack of view.relayAcks) {
    const { sender, recipient } = ack;
    if (!recipient) continue;
    if (recipient === sender) continue;
    if (blocked.has(`${recipient}|${sender}`)) continue;
    const w = Math.floor(ack.ts / HEARTBEAT_WINDOW_MS);
    if (!online.get(recipient)?.has(w)) continue;
    const k = `${sender}|${recipient}`;
    const cur = pairs.get(k) ?? { d: 0, a: 0 };
    cur.d++;
    if (acked.has(`${ack.msgHash}|${recipient}`)) cur.a++;
    pairs.set(k, cur);
  }
  const bySender = /* @__PURE__ */ new Map();
  const detailBySender = /* @__PURE__ */ new Map();
  for (const [k, v] of pairs) {
    if (v.d < MIN_MSGS_PER_PAIR) continue;
    const [s, r] = k.split("|");
    const cur = bySender.get(s) ?? { d: 0, a: 0 };
    cur.d += v.d;
    cur.a += v.a;
    bySender.set(s, cur);
    const dd = detailBySender.get(s) ?? [];
    dd.push({ to: r, d: v.d, a: v.a });
    detailBySender.set(s, dd);
  }
  const measurable = [...bySender.entries()].filter(
    ([s, v]) => v.d >= MIN_DELIVERABLE && (detailBySender.get(s)?.length ?? 0) >= MIN_RECIPIENTS
  );
  if (measurable.length < 4) {
    return blank(
      "insufficient-data",
      `only ${measurable.length} sender(s) have ${MIN_DELIVERABLE}+ deliverable messages to ${MIN_RECIPIENTS}+ online recipients`
    );
  }
  const totalD = measurable.reduce((a, [, v]) => a + v.d, 0);
  const totalA = measurable.reduce((a, [, v]) => a + v.a, 0);
  const pHat = Math.min(0.999, Math.max(1e-3, totalA / Math.max(1, totalD)));
  const D = /* @__PURE__ */ new Map();
  const rows = [];
  let worst = null;
  let worstScore = 0;
  for (const [s, v] of measurable) {
    const ratio = v.a / v.d;
    D.set(s, ratio);
    const se = Math.sqrt(pHat * (1 - pHat) / v.d);
    const z = se > 1e-9 ? (ratio - pHat) / se : 0;
    const sc = Math.max(0, Math.min(1, (-z - 2) / 6));
    rows.push({ u: s, d: ratio, z, s: sc, n: v.d });
    if (sc > worstScore) {
      worstScore = sc;
      worst = s;
    }
  }
  rows.sort((a, b) => a.d - b.d);
  const med = pHat;
  const evidence = [];
  if (worst) {
    const det = (detailBySender.get(worst) ?? []).sort((a, b) => a.a / a.d - b.a / b.d).slice(0, 5);
    evidence.push({
      label: `Suppression candidate ${short(worst)}`,
      detail: `delivered ${(D.get(worst) * 100).toFixed(0)}% of ${rows.find((r) => r.u === worst).n} deliverable messages, against a pooled room rate of ${(pHat * 100).toFixed(0)}% (z = ${rows.find((r) => r.u === worst).z.toFixed(2)} under a binomial at that rate)`,
      weight: worstScore
    });
    evidence.push({
      label: "Per-recipient breakdown",
      detail: det.map((x) => `\u2192${short(x.to)} ${x.a}/${x.d}`).join(", ")
    });
    evidence.push({
      label: "What this does and does not show",
      detail: "each counted message has a host RELAY_ACK and a recipient heartbeat in the same hour, and no declared block. A single low pair would prove nothing; this is an aggregate across recipients."
    });
  }
  evidence.push({
    label: "Room delivery health",
    detail: `${measurable.length} measurable senders; pooled delivery rate ${(pHat * 100).toFixed(1)}% over ${totalD} messages; lowest three ${rows.slice(0, 3).map((r) => `${short(r.u)}=${r.d.toFixed(2)} (n=${r.n})`).join(", ")}`
  });
  return {
    id,
    score: worstScore,
    state: "ok",
    headline: worst ? `worst sender delivers at ${D.get(worst).toFixed(2)} vs pooled ${pHat.toFixed(2)} (z = ${rows.find((r) => r.u === worst).z.toFixed(1)})` : `no suppression signal across ${measurable.length} senders`,
    evidence,
    raw: { ss: worstScore, pooled: pHat, senders: measurable.length, worstRatio: worst ? D.get(worst) : pHat, worstZ: worst ? rows.find((r) => r.u === worst).z : 0 }
  };
}

// src/core/personhood.ts
var GAMMA = { c1: 1, c2: 1.5, c3: 1, c4: 1, c5: 1.5 };
var BURST_B0 = 2;
var ELSEWHERE_K0 = 2;
function personalisedPageRank(vouches, seeds, excluding, opts = {}) {
  const alpha = opts.alpha ?? 0.85;
  const iters = opts.iters ?? 30;
  const out = /* @__PURE__ */ new Map();
  const nodes = new Set(seeds);
  for (const v of vouches) {
    nodes.add(v.from);
    nodes.add(v.to);
    if (v.from === excluding) continue;
    const arr = out.get(v.from) ?? [];
    arr.push(v.to);
    out.set(v.from, arr);
  }
  const seedSet = seeds.filter((s) => nodes.has(s));
  const restart = /* @__PURE__ */ new Map();
  if (seedSet.length === 0) {
    for (const n of nodes) restart.set(n, 1 / nodes.size);
  } else {
    for (const s of seedSet) restart.set(s, 1 / seedSet.length);
  }
  let r = new Map(restart);
  for (let it = 0; it < iters; it++) {
    const next = /* @__PURE__ */ new Map();
    let dangling = 0;
    for (const [n, mass] of r) {
      const outs = out.get(n);
      if (!outs || outs.length === 0) {
        dangling += mass;
        continue;
      }
      const share = alpha * mass / outs.length;
      for (const t of outs) next.set(t, (next.get(t) ?? 0) + share);
    }
    const leak = 1 - alpha + alpha * dangling;
    for (const [n, m] of restart) next.set(n, (next.get(n) ?? 0) + leak * m);
    r = next;
  }
  return r;
}
function cosine(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    ab += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  const d = Math.sqrt(aa * bb);
  return d < 1e-12 ? 0 : ab / d;
}
function flatBuckets(view, pk) {
  const b = view.buckets[pk];
  if (!b) return [];
  const out = [];
  for (const d of view.schema.dims) out.push(...b[d.id] ?? []);
  return out;
}
var VouchWebProvider = class {
  id = "VouchWeb";
  evidence(pk, view) {
    const host = view.host;
    const joins = Object.values(view.joinedAt).sort((a, b) => a - b);
    const mine = view.joinedAt[pk];
    let c1 = 1;
    if (mine !== void 0 && joins.length > 2) {
      const span = Math.max(1, (joins[joins.length - 1] - joins[0]) / 864e5);
      const overallRate = joins.length / span;
      const near = joins.filter((t) => Math.abs(t - mine) <= 1.5 * 864e5).length;
      const localRate = near / 3;
      const burst = overallRate > 0 ? localRate / overallRate : 1;
      c1 = Math.exp(-Math.max(0, burst - 1) / BURST_B0);
    }
    const me = flatBuckets(view, pk);
    let maxSim = 0;
    if (me.length) {
      for (const other of view.members) {
        if (other === pk) continue;
        const o = flatBuckets(view, other);
        if (!o.length) continue;
        maxSim = Math.max(maxSim, cosine(me, o));
      }
    }
    const c2 = Math.max(0, 1 - Math.max(0, (maxSim - 0.9) / 0.1));
    let agree = 0, total = 0;
    for (const e of view.entries) {
      if ((e.body.t === "BAN" || e.body.t === "KICK") && e.body.cosigners) {
        total++;
        if (e.body.cosigners.some((c) => c.by === pk)) agree++;
      }
    }
    const chance = 0.25;
    const c3 = total === 0 ? 1 : Math.max(0, 1 - Math.max(0, (agree / total - chance) / (1 - chance)));
    const k = view.elsewhere[pk] ?? 0;
    const c4 = 1 - Math.exp(-k / ELSEWHERE_K0);
    const ppr = personalisedPageRank(view.vouches, view.seeds, host);
    const mineR = ppr.get(pk) ?? 0;
    const memberRanks = view.members.map((m) => ppr.get(m) ?? 0).filter((x) => x > 0).sort((a, b) => a - b);
    const medR = memberRanks.length ? memberRanks[Math.floor(memberRanks.length / 2)] : 0;
    const c5 = medR > 0 ? Math.max(0, Math.min(1, mineR / medR)) : mineR > 0 ? 1 : 0;
    const parts = [
      [c1, GAMMA.c1],
      [c2, GAMMA.c2],
      [c3, GAMMA.c3],
      [c4, GAMMA.c4],
      [c5, GAMMA.c5]
    ];
    const sumG = parts.reduce((a, [, g]) => a + g, 0);
    let logSum = 0;
    for (const [v, g] of parts) logSum += g * Math.log(Math.max(1e-4, v));
    const independence = Math.exp(logSum / sumG);
    return {
      c1_joinTime: c1,
      c2_distinct: c2,
      c3_voteIndependence: c3,
      c4_elsewhere: c4,
      c5_vouchIndependence: c5,
      independence
    };
  }
  weight(pk, view) {
    return this.evidence(pk, view).independence;
  }
};
function effectiveN(weights) {
  const s1 = weights.reduce((a, b) => a + b, 0);
  const s2 = weights.reduce((a, b) => a + b * b, 0);
  return s2 <= 0 ? 0 : s1 * s1 / s2;
}

// src/core/detectors/iwr.ts
var REVIEW_PRIOR = 3;
var REVIEW_PSEUDO = 3;
function detectIwr(view, provider = new VouchWebProvider()) {
  const members = currentMembers(view);
  const all = members.includes(view.host) ? members : [view.host, ...members];
  const weights = /* @__PURE__ */ new Map();
  for (const m of all) weights.set(m, m === view.host ? 1 : provider.weight(m, view));
  const nonHost = all.filter((m) => m !== view.host);
  const ws = nonHost.map((m) => weights.get(m) ?? 0);
  const nEffMembers = effectiveN(ws);
  const packRatio = nonHost.length > 0 ? nEffMembers / nonHost.length : 1;
  const packScore = Math.max(0, Math.min(1, 1 - packRatio));
  const lowest = [...nonHost].map((m) => ({ m, w: weights.get(m) ?? 0, e: provider.evidence(m, view) })).sort((a, b) => a.w - b.w).slice(0, 4);
  const packEvidence = [
    {
      label: "Effective membership",
      detail: `${nonHost.length} members, effective sample size ${nEffMembers.toFixed(1)} (${(packRatio * 100).toFixed(0)}% independent)`,
      weight: packScore
    },
    ...lowest.map((l) => ({
      label: `Low independence: ${short(l.m)}`,
      detail: `I = ${l.w.toFixed(3)} \u2014 joinTime ${l.e.c1_joinTime.toFixed(2)}, distinctness ${l.e.c2_distinct.toFixed(2)}, voteIndep ${l.e.c3_voteIndependence.toFixed(2)}, elsewhere ${l.e.c4_elsewhere.toFixed(2)}, vouch ${l.e.c5_vouchIndependence.toFixed(2)}`,
      weight: 1 - l.w
    })),
    {
      label: "Reproduce this",
      detail: `personalised PageRank over the ${view.vouches.length} public vouches from your own seed set, with the host's out-edges deleted`
    }
  ];
  const pack = {
    id: "PACK",
    score: packScore,
    state: nonHost.length < 5 ? "too-small-to-audit" : "ok",
    headline: `N_eff = ${nEffMembers.toFixed(1)} of ${nonHost.length} members`,
    evidence: packEvidence,
    raw: { packScore, nEffMembers, members: nonHost.length, packRatio }
  };
  const nodeReviews = view.reviews.filter((r) => r.subject.t === "node" && r.subject.id === view.node);
  const rWeights = [];
  let num = 0, den = 0;
  for (const r of nodeReviews) {
    const w = r.author === view.host ? 0 : provider.weight(r.author, view);
    rWeights.push(w);
    num += w * r.ratings.overall;
    den += w;
  }
  const nEffReviews = effectiveN(rWeights);
  const repRaw = (num + REVIEW_PSEUDO * REVIEW_PRIOR) / (den + REVIEW_PSEUDO);
  const plainMean = nodeReviews.length ? nodeReviews.reduce((a, r) => a + r.ratings.overall, 0) / nodeReviews.length : REVIEW_PRIOR;
  const repScore = Math.max(0, Math.min(1, (REVIEW_PRIOR - repRaw) / 2));
  const repEvidence = [
    {
      label: "Weighted rating",
      detail: `${repRaw.toFixed(2)} / 5 from ${nodeReviews.length} reviews, effective sample size ${nEffReviews.toFixed(1)}`,
      weight: repScore
    },
    {
      label: "Unweighted rating",
      detail: `${plainMean.toFixed(2)} / 5 \u2014 the gap between this and the weighted figure is the sybil discount`
    }
  ];
  if (nodeReviews.length >= 3 && nEffReviews / nodeReviews.length < 0.4) {
    repEvidence.push({
      label: "Review credibility",
      detail: `only ${(nEffReviews / nodeReviews.length * 100).toFixed(0)}% of review weight is independent of the host \u2014 treat the headline rating as close to unsupported`
    });
  }
  const rep = {
    id: "IWR",
    score: repScore,
    state: nodeReviews.length < 3 ? "insufficient-data" : "ok",
    headline: `${repRaw.toFixed(2)}/5 weighted (N_eff ${nEffReviews.toFixed(1)} of ${nodeReviews.length})`,
    evidence: repEvidence,
    raw: { rep: repRaw, plainMean, nEffReviews, reviews: nodeReviews.length, repScore }
  };
  return { rep, pack, weights };
}

// src/core/detectors/dr.ts
var MIN_CHECKABLE = 3;
var SHRINK_K = 5;
var ONE_HOT_MASS = 0.9;
function evaluatePublished(view, predicate, buckets) {
  const failed = [];
  const unknown = [];
  if (!buckets) return { verdict: "cannot-tell", failed, unknown: predicate.clauses.map((c) => c.dim) };
  for (const c of predicate.clauses) {
    const d = dimById(view.schema, c.dim);
    if (!d) continue;
    const b = buckets[c.dim];
    if (!b || b.length !== bucketCount(d)) {
      unknown.push(c.dim);
      continue;
    }
    let best = 0;
    let total = 0;
    for (let i = 0; i < b.length; i++) {
      total += b[i];
      if (b[i] > b[best]) best = i;
    }
    if (total <= 0 || b[best] / total < ONE_HOT_MASS) {
      unknown.push(c.dim);
      continue;
    }
    const thr = c.accept.t === "set" || c.accept.t === "bool" ? 1 : 0.5;
    let minMu = Infinity;
    let maxMu = -Infinity;
    for (const v of bucketSamples(d, best)) {
      const mu = evalAcceptance(d, c.accept, v);
      minMu = Math.min(minMu, mu);
      maxMu = Math.max(maxMu, mu);
    }
    if (maxMu < thr) {
      failed.push(c.dim);
      continue;
    }
    if (minMu < thr) {
      unknown.push(c.dim);
      continue;
    }
  }
  if (unknown.length > 0) return { verdict: "cannot-tell", failed, unknown };
  return { verdict: failed.length ? "fails" : "passes", failed, unknown };
}
function bucketSamples(d, i) {
  if (!d) return [i];
  switch (d.kind.t) {
    case "likert":
      return [i + 1];
    case "boolean":
      return [i === 1];
    case "categorical":
      return [d.kind.options[i] ?? d.kind.options[0]];
    case "numeric": {
      const { min, max, bins } = d.kind;
      const w = (max - min) / bins;
      return [min + i * w, min + (i + 0.25) * w, min + (i + 0.5) * w, min + (i + 0.75) * w, min + (i + 1) * w];
    }
  }
}
function detectDr(view) {
  const id = "DR";
  const blank = (state, headline, raw = {}) => ({
    id,
    score: 0,
    state,
    headline,
    evidence: [],
    raw
  });
  const knocks = /* @__PURE__ */ new Map();
  for (const e of view.entries) {
    if (e.body.t !== "JOIN_REQUEST") continue;
    if (typeof e.body.applicant !== "string" || !e.body.applicant) continue;
    knocks.set(e.body.applicant, e.body.buckets ?? {});
  }
  const byVersion = /* @__PURE__ */ new Map();
  for (const h of view.predicateHistory) byVersion.set(h.version, h.predicate);
  const rejects = [];
  for (const e of view.entries) {
    if (e.body.t !== "REJECT") continue;
    if (typeof e.body.applicant !== "string" || !e.body.applicant) continue;
    rejects.push({ entry: e, applicant: e.body.applicant, outcome: e.body.outcome, version: e.body.predicateVersion });
  }
  if (rejects.length === 0) {
    return blank("ok", "nobody has been turned away here", { rejects: 0, checkable: 0, unexplained: 0 });
  }
  if (view.predicateHistory.length === 0) {
    return blank("unauditable", "the node publishes no predicate history, so its own rule cannot be applied to its own rejections", { rejects: rejects.length });
  }
  let checkable = 0;
  let unexplained = 0;
  let statedDiscretion = 0;
  let contradicted = 0;
  const hits = [];
  for (const r of rejects) {
    const predicate = byVersion.get(r.version) ?? view.predicateHistory.at(-1)?.predicate;
    if (!predicate) continue;
    if (r.outcome === "indeterminate") continue;
    const { verdict } = evaluatePublished(view, predicate, knocks.get(r.applicant));
    if (verdict === "cannot-tell") continue;
    checkable++;
    if (verdict !== "passes") continue;
    unexplained++;
    if (r.outcome === "host-discretion") statedDiscretion++;
    else contradicted++;
    if (hits.length < 6) hits.push({ seq: r.entry.seq, who: r.applicant, outcome: r.outcome });
  }
  if (checkable < MIN_CHECKABLE) {
    return blank(
      "insufficient-data",
      `only ${checkable} of ${rejects.length} rejection(s) can be checked against the published rule \u2014 a rate needs more than that, and a room with few rejections is not thereby innocent`,
      { rejects: rejects.length, checkable, unexplained }
    );
  }
  const rate = unexplained / checkable;
  const shrink = checkable / (checkable + SHRINK_K);
  const dr = Math.max(0, Math.min(1, rate * shrink));
  const evidence = [];
  for (const h of hits) {
    evidence.push({
      label: `${short(h.who)} was turned away (entry ${h.seq})`,
      detail: h.outcome === "host-discretion" ? "they met every condition this room publishes, and the host recorded the reason as their own discretion. That is hand-picking, done in the open." : "they met every condition this room publishes, and the host recorded the rejection as a rule failure. The host\u2019s own log disagrees with the host\u2019s own rule.",
      weight: 1 / Math.max(1, checkable)
    });
  }
  if (unexplained === 0) {
    evidence.push({
      label: "Every rejection is explained by the published rule",
      detail: `${checkable} rejection(s) checked against the predicate version each one cites; all of them genuinely failed it`
    });
  }
  evidence.push({
    label: "How this is counted",
    detail: `${unexplained} of ${checkable} checkable rejection(s) pass the room\u2019s own rule (${statedDiscretion} recorded as host discretion, ${contradicted} recorded as a rule failure that was not one). ${rejects.length - checkable} more could not be checked and are excluded, not assumed.`
  });
  evidence.push({
    label: "Reproduce this",
    detail: "for each REJECT, take the applicant\u2019s buckets from their own JOIN_REQUEST, take the predicate version the rejection cites, and evaluate one against the other. A rejection only counts here if the applicant passes at every point of their published bucket, so bucket coarseness cannot explain it."
  });
  evidence.push({
    label: "What this does not say",
    detail: "turning away someone who passes is not proof of capture \u2014 a host may have a good reason that is not in the rule. It does mean the published rule is not the whole rule."
  });
  return {
    id,
    score: dr,
    state: "ok",
    headline: `DR = ${dr.toFixed(3)} \u2014 ${unexplained} of ${checkable} checkable rejections pass the room\u2019s own rule`,
    evidence,
    raw: {
      dr,
      rate,
      checkable,
      unexplained,
      statedDiscretion,
      contradicted,
      rejects: rejects.length,
      shrink
    }
  };
}

// src/core/proofs.ts
function detectPostHocRule(entries) {
  const out = [];
  const ruleIntroduced = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.body.t === "RULESET_SET") {
      for (const r of e.body.rules) {
        if (!ruleIntroduced.has(r.id)) ruleIntroduced.set(r.id, e.seq);
      }
    }
  }
  for (const e of entries) {
    if (e.body.t !== "BAN" && e.body.t !== "KICK") continue;
    const at = ruleIntroduced.get(e.body.ruleId);
    if (at === void 0) {
      out.push({
        kind: "post-hoc-rule",
        node: e.nodeId,
        summary: `${e.body.t} at seq ${e.seq} cites rule "${e.body.ruleId}" which the log never introduces`,
        artefacts: { entry: e }
      });
    } else if (at > e.seq) {
      out.push({
        kind: "post-hoc-rule",
        node: e.nodeId,
        summary: `${e.body.t} at seq ${e.seq} cites rule "${e.body.ruleId}" introduced later at seq ${at}`,
        artefacts: { entry: e, ruleSeq: at }
      });
    }
  }
  return out;
}

// src/core/detectors/index.ts
var FEATURES = ["HCC", "HCC_W", "PP", "PD", "BF", "SS", "PACK", "IWR", "DR"];
var DETECTOR_VERSION = "0.1.0";
var UNIFORM_MODEL = {
  kind: "uniform",
  intercept: -2.2,
  coef: { HCC: 1, HCC_W: 1, PP: 1, PD: 1, BF: 1, SS: 1, PACK: 1, IWR: 1, DR: 1 },
  mean: { HCC: 0, HCC_W: 0, PP: 0, PD: 0, BF: 0, SS: 0, PACK: 0, IWR: 0, DR: 0 },
  sd: { HCC: 1, HCC_W: 1, PP: 1, PD: 1, BF: 1, SS: 1, PACK: 1, IWR: 1, DR: 1 }
};
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}
function runDetectors(view, opts = {}) {
  const provider = opts.provider ?? new VouchWebProvider();
  const iwr = detectIwr(view, provider);
  const hcc = detectHcc(view);
  const hccW = detectHcc(view, { weights: iwr.weights, label: "HCC_W" });
  return {
    results: {
      HCC: hcc,
      HCC_W: hccW,
      PP: detectPp(view),
      PD: detectPd(view),
      BF: detectBf(view),
      SS: detectSs(view),
      PACK: iwr.pack,
      IWR: iwr.rep,
      DR: detectDr(view)
    },
    weights: iwr.weights
  };
}
function featureValue(r, model, f) {
  if (r.state !== "ok") return { z: 0, used: false };
  const sd = model.sd[f] || 1;
  return { z: (r.score - model.mean[f]) / sd, used: true };
}
function combine(run, model = UNIFORM_MODEL) {
  let x = model.intercept;
  const inputs = {};
  const used = [];
  for (const f of FEATURES) {
    const r = run.results[f];
    const { z, used: u } = featureValue(r, model, f);
    inputs[f] = r.state === "ok" ? r.score : NaN;
    if (!u) continue;
    x += model.coef[f] * z;
    used.push(f);
  }
  if (used.length === 0) return { score: null, inputs, used };
  return { score: sigmoid(x), inputs, used };
}
function buildReport(view, opts = {}) {
  const model = opts.model ?? UNIFORM_MODEL;
  const run = runDetectors(view, opts);
  const { score, inputs, used } = combine(run, model);
  const seen = /* @__PURE__ */ new Set();
  const proofs = [...view.proofs, ...detectPostHocRule(view.entries)].filter((p) => {
    const k = `${p.kind}|${p.node}|${p.summary}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const auditable = view.entries.length > 0 && view.sths.length > 0 && (view.hostPrefs !== null || view.hostPrefsEarliest !== null);
  return {
    node: view.node,
    room: view.room,
    intent: view.intent,
    score: auditable ? score : null,
    auditable,
    detectors: Object.values(run.results),
    proofs,
    reproduction: {
      formula: `sigmoid(${model.intercept.toFixed(3)} + \u03A3 \u03B2_k \xB7 (score_k \u2212 \u03BC_k)/\u03C3_k) over ${used.join(", ") || "no usable detectors"}`,
      weights: Object.fromEntries(used.map((f) => [f, model.coef[f]])),
      inputs
    }
  };
}
export {
  DETECTOR_VERSION,
  FEATURES,
  UNIFORM_MODEL,
  buildReport,
  combine,
  detectBf,
  detectDr,
  detectHcc,
  detectIwr,
  detectPd,
  detectPp,
  detectSs,
  runDetectors,
  sigmoid
};
