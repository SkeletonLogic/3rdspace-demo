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
| **Quiet Room** | publishes no log at all, so it reads `UNAUDITABLE` rather than clean |

Open **Audit** on the first two and compare. The captured room names the
off-topic clauses it is flagged for and shows a cryptographic proof (a ban
citing a rule the log introduces *afterwards*). The honest one shows *why* its
narrowness does not count against it — its selectivity is all on the dimensions
the room is actually about.

Sound is synthesised live in the Web Audio API, no audio files. Toggle in
**You → Sound**.

## Limits of the demo

- **Read-only.** Joining, posting and hosting need a live node.
- **A snapshot.** Timestamps are frozen at build time, so rate-based terms
  (the ban rate against a peer baseline) read slightly differently than they do
  against a running node — the captured room scores 74 here versus 72 live.
- The people, rooms and messages are synthetic.

## Honesty note

The detectors are not all good. On the measured sweep the combined score
reaches 0.918 ROC AUC at a 0% false-positive rate on honest niche rooms, but
capture-by-predicate — the centrepiece attack — is caught 33% of the time, and
four of five pre-registered failure criteria were met. One of the two founding
hypotheses did not survive measurement and is written up as failed rather than
tuned away.

---

Generated from a private source repository by `npm run demo:build`.
This repo contains build output only.
