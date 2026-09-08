# Normative hip, knee and ankle joint moments across common sports movements

**Question:** Can BioScout responsibly publish a normative-data table for peak hip, knee
and ankle joint moments during running, jumping, side-stepping/cutting, squatting and
single-leg landing, for users to compare their own movement against?

**Short answer: only partially, and only for one task.** Running has a real (if
imprecisely extracted) speed-moment gradient from multiple studies. Every other task in
this review — countermovement jump, squat, cutting, single-leg landing — has published
numbers, but they are small-sample, sport- or sex-specific, phase-averaged rather than
true peaks, or reported in incompatible units (Nm/kg vs Nm/(kg·height) vs %BW·height).
Pooling them into a single "normal range" table would manufacture a precision the
literature doesn't have. This review documents what exists, what's missing, and what a
defensible v1 data file can and can't claim.

## Method

Literature search across five tasks (running, vertical jumping, side-stepping/cutting,
squatting, single-leg drop/hop landing), looking specifically for peak internal/external
hip, knee and ankle moments in healthy adult samples, normalised to body mass (Nm/kg),
from inverse-dynamics studies. Preference given to large-sample reference datasets and
systematic reviews over single small studies. This was a rapid evidence scan, not a
registered systematic review (no PRISMA flow, no dual screening, no risk-of-bias
scoring) — treat it as a scoping pass that should be tightened before anything here is
presented to users as validated.

## Findings by task

### Running — best-covered, still not a clean table
Peak knee extensor and ankle plantarflexor moments both rise with running speed
(Rasmussen et al. 2014, Clin Biomech, n=33 recreational runners, 8→12→16 km/h); the
plantarflexor moment rises proportionally *more* than the knee extensor moment as speed
increases. Sprint acceleration work (Colyer et al. 2019, J Exp Biol, n=8 sub-elite
sprinters) found ankle plantarflexor moment impulse — not knee or hip — correlates with
acceleration magnitude. The two large open datasets that could seed a normative table
either don't include moments (Fukuchi/Running Injury Clinic 2024, Scientific Data,
n=1,798, kinematics only) or need the primary tables pulled directly rather than taken
from a review (Fukuchi et al. 2017, PeerJ, open on Figshare). **Direction is
well-established (ankle contribution grows fastest with speed); exact Nm/kg magnitudes
for a table need pulling from primary figures, not secondary sources.**

### Vertical jumping (CMJ / squat jump / drop jump) — no usable population norm
The most complete numbers found (Sci Rep 2025, n=33 elite male volleyball players,
loaded CMJ) report hip, knee and ankle net joint moment averaged across the movement
phase, not a discrete peak, across external load conditions 0–60% MVC — e.g. hip
1.05→1.85 Nm/kg and ankle 0.83→1.73 Nm/kg as load rose 0→30-50%. Elite, male-only,
sport-specific, phase-averaged: not a population baseline, and the non-monotonic knee
value across load steps suggests methodological noise rather than a real peak. No
mixed-sex, mixed-level, large-n dataset with a genuine peak-moment figure was found.
**Gap: real.**

### Side-stepping / cutting — frontal-plane only, and task-dependent
The best single data point (Frontiers Sports Active Living 2022, n=51 female handball
players) gives peak knee abduction moment (KAM) 1.52–1.73 Nm/kg depending on cut
complexity (simple pre-planned vs. unanticipated vs. catch-and-cut). This is the
ACL-injury literature's primary outcome, so it's comparatively well studied — but almost
entirely as KAM (frontal plane) in female, sport-specific samples; sagittal hip/knee/
ankle moments during cutting are comparatively under-reported. Widely-cited classic work
(Sigward & Powers; McLean et al.) establishes sex differences in KAM but numeric tables
weren't retrievable via automated fetch this pass. **A KAM range (~1.0–2.0 Nm/kg) exists
but is not sex- or sport-general; sagittal moments in cutting remain a gap.**

### Squatting — the direction is solid, the magnitude isn't
Elite powerlifter data (Sci Rep 2026, n=29, 13F/16M) shows hip flexion/extension moment
rising substantially with load up to 90% 1RM while knee and ankle moments stay
comparatively flat — i.e. loading a squat shifts mechanical demand toward the hip, not
the knee or ankle. That qualitative pattern is more load-bearing than any single Nm/kg
number in the literature found here, and no bodyweight-squat, general-population,
both-sex dataset with peak sagittal moments in Nm/kg turned up. **Same conclusion as the
existing MSK-modelling review in this folder: squat kinematics/tempo are gettable, squat
joint loading is not, especially loaded.**

### Single-leg drop/hop landing — weakest coverage of the five
Dominated by clinical comparison studies (ACL-reconstructed vs. healthy, sex
differences) reporting standardized mean differences or relative comparisons, not
absolute Nm/kg baselines in large healthy samples. One landing-vs-jump comparison (BMC
Musculoskelet Disord 2018, n=42, 21F/21M) even normalises to Nm/(kg·height) rather than
Nm/kg, which is not directly comparable to the rest of this table. A 2018 systematic
review/meta-analysis of ACLR landing biomechanics (35 pooled studies) reports SMDs
(−1.2 to −0.52 for peak knee extensor moment, ACLR vs control) but not absolute values
for either group. **No usable absolute normative figure for healthy single-leg landing
was found in this pass.**

## What this means for a "normative data" feature

1. Do not ship a single cross-task table implying comparable confidence across
   movements. Running has a real gradient; the other four tasks don't have an
   equivalent.
2. Where a number is reported, publish it with its actual sample (n, sex, level, load
   condition) attached — never as a bare "normal knee moment is X Nm/kg" — because every
   value found here is contingent on load, speed, sport or sex in ways that would
   mislead a general user if stripped out.
3. Directional findings (ankle contribution rises fastest with running speed; squat load
   shifts demand toward the hip) are better evidenced than any point estimate and are
   safe to state as findings, not norms.
4. Frontal-plane KAM in cutting is the one place with a real number range, but it's
   female-athlete-specific in the studies found — do not generalise to male athletes or
   to sagittal-plane loading in the same task.
5. This reuses the tier logic from `2026_Sep_MiniReview_MSK_modelling_sporting_tasks/`
   in this same folder: joint *moments* sit in Tier B (reportable with an uncertainty
   band, population-level, never a single-user diagnosis) at best, and only for running;
   everywhere else the honest tier is "insufficient normative evidence," not Tier C
   (which is about contact forces specifically) — it's a fourth bucket this review adds:
   **Tier D, "no defensible population norm exists yet."**

## Caveats

Several PubMed/PMC pages returned anti-bot blocks during this pass rather than content,
so absence of an extracted number here means "not retrieved in this search," not
"doesn't exist" — a follow-up pass with direct PDF/institutional access would likely
recover exact Nm/kg tables for at least the running and squat literature. This is a
scoping review, not a systematic one: no PRISMA screening, no risk-of-bias grading, no
exhaustive database search (single search session, open web only). Treat `joint_moments.json`
in this folder as a snapshot worth republishing once those primary tables are pulled, not
a finished reference dataset.

## Sources referenced

- Rasmussen et al. 2014, *Clinical Biomechanics* — knee/ankle moments vs. running speed, n=33
- Colyer, Nagahara & Salo 2019, *J Experimental Biology* — sprint acceleration kinetics, n=8
- Fukuchi, Fukuchi & Duarte 2017, *PeerJ* — open running biomechanics dataset (kinetics)
- Fukuchi et al. 2024, *Scientific Data* — 1,798-subject walk/run dataset (kinematics only)
- [Sci Rep 2025] loaded CMJ elite volleyball, n=33 — https://www.nature.com/articles/s41598-025-03887-8
- Frontiers Sports Active Living 2022 — cutting KAM, n=51 female handball —
  https://www.frontiersin.org/journals/sports-and-active-living/articles/10.3389/fspor.2022.983888/full
- [Sci Rep 2026] elite powerlifter squat kinetics vs. load, n=29 —
  https://www.nature.com/articles/s41598-026-43999-3
- BMC Musculoskeletal Disorders 2018 — drop landing vs. drop jump, n=42 —
  https://link.springer.com/article/10.1186/s12891-018-2291-4
- Sports Medicine 2018 — systematic review/meta-analysis, ACLR single-leg landing
  biomechanics, 35 pooled studies —
  https://link.springer.com/article/10.1007/s40279-018-0942-0

See also `../2026_Sep_MiniReview_MSK_modelling_sporting_tasks/` for the wider muscle-force
and contact-force evidence this review's tiering builds on.
