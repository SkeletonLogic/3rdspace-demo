# 3rdSpace — hosted demo

**→ https://skeletonlogic.github.io/3rdspace-demo/**

A peer-to-peer network for dating and friend-finding, where the interesting
problem is not the chat — it is stopping a node host from quietly tuning a
room's admission rule into a private harvesting ground, and letting anyone
check for themselves whether one has.

Install it: open the link on a phone → **Add to Home screen**. It is a PWA and
works offline after the first load.

## The scores in this demo are not precomputed

This page ships the **published data** of three demo nodes — signed log
entries, tree heads, member statistics, compatibility edges — and recomputes
every capture score **in your browser**, using `core.bundle.js`, the same
detector code a real node runs.

That is not a detail. "Every badge is computed on your device" is the claim the
whole design rests on, so baking the numbers into the payload and displaying
them under that sentence would have made the app lie. Open DevTools: there are
zero API requests, and only `demo-data.json` and `core.bundle.js` are fetched.

## What to look at

Three nodes appear in one browse list:

| | |
| --- | --- |
| **Belay & Chill** | an honest niche room — narrow, but narrow *on topic* |
| **Crag Social** | the same shape, captured: an on-topic gate **plus** the host's personal type on age, build and politics |
| **Quiet Room** | publishes no log at all, so it reads *can't tell* rather than clean |

Open **Audit** on the first two and compare. Each reads as a sentence — *"the
rule for getting in filters on your age, your body and your politics — things
this room is not about"* — with every number, formula, evidence row and log entry
one tap behind **Show the working**. Nothing is hidden; it is demoted, because
the person who wants to check an inclusion proof by hand still has to be able to.

The captured room also carries a cryptographic proof: a ban citing a rule its own
log introduces *afterwards*. That is not a score and is never blended into one.

### Profile pages

Open **Room** on either node and tap somebody. Everyone has a page they can
style, at three rungs that all edit one document — pick a theme, nudge the knobs,
or write the HTML and CSS yourself.

One of the seeded pages deliberately carries a tracking beacon, a remote image
and a `<script>`, so you can watch the renderer refuse them and say why in plain
words. Profile pages never run scripts, render in a sandboxed frame with a
content policy that permits **no network origins at all**, and carry their own
images inside the author's signature — so a host cannot swap somebody's photo,
and a stylesheet cannot become a visit tracker that reports who read a profile.

Behind that claim: 70 adversarial payloads, 70 contained, and a browser
measurement in which rendering all three pages made zero requests to the beacon's
host — with the sanitiser *switched off* as well as on, so the two layers are
known to work independently.

Sound is synthesised live in the Web Audio API, no audio files. Toggle in
**You → Sound**.

## Limits of the demo

- **Read-only.** Joining, posting, publishing a page and hosting need a live
  node.
- **A snapshot.** Timestamps are frozen at build time, so rate-based terms (the
  ban rate against a peer baseline) read slightly differently than they do
  against a running node.
- The people, rooms and messages are synthetic.

## Honesty note

The detectors are not all good. On the measured sweep the combined score
reaches 0.918 ROC AUC at a 0% false-positive rate on honest niche rooms, but
capture-by-predicate — the centrepiece attack — is caught 33% of the time, and
four of five pre-registered failure criteria were met. One of the two founding
hypotheses did not survive measurement and is written up as failed rather than
tuned away.

Profile pages made one thing measurably worse, and the number is published rather
than buried: a free-form page is a channel none of the detectors read, so a host
can coordinate through it and gerrymander a room while publishing a clean rule.
Measured, detection collapses — ROC AUC 0.830 → 0.631, and the detector the suite
rests on reads exactly zero in **100%** of those rooms.

---

Generated from a private source repository by `npm run demo:build`.
This repo contains build output only.
