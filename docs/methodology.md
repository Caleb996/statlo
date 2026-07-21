# Methodology

How this project decides whether a factor is real. The code is replaceable; this part took the
longest to learn and is the reason the model hasn't turned into a pile of unjustifiable
multipliers.

---

## 1. Log every factor on every prediction

Each surfaced pick carries a `factors: {...}` object recording each multiplier's contribution
(as a log-ratio, so contributions are additive and a no-op factor is exactly 0).

This is the whole foundation. **A factor you didn't log is a factor you can never evaluate.** If
you add a park adjustment and don't record what it did on each individual pick, then six weeks
later the only question you can answer is "is the model good?" — never "is *this piece* good?"

`backtests/analyze-prop-factors.js` auto-discovers factor keys from the logged objects, so a new
factor becomes ablatable the moment it starts being logged. No new script per factor.

## 2. Freeze before first pitch

Predictions are written to `predictions-YYYY-MM-DD.json` and never rewritten. A prediction you can
revise after seeing the outcome isn't a prediction.

This has a practical consequence worth internalizing: **changing a gate has no effect on today's
board.** Today was already frozen. The change takes effect at the next freeze. If you forget this
you will spend an afternoon convinced your edit didn't apply.

Anything computed after the freeze is kept structurally separate from the frozen payload so it
can't leak backwards into what gets graded.

## 3. Ship new factors at shadow weight

A new factor should first be logged while multiplying by ~1.0. Let it ride along doing nothing,
accumulate a few weeks of frozen slates, and only give it real weight once ablation shows it adds
something *beyond what you already had*.

The word "incremental" is load-bearing. Most new factors correlate with something already in the
model. A factor that looks predictive in isolation and adds nothing on top of your existing inputs
is not a discovery — it's a restatement.

## 4. Prune on flat or negative lift

Most plausible-sounding factors do nothing. This is the **normal outcome**, not a failure, and the
codebase documents its dead ends on purpose:

- A recent-form trend term for projected strikeouts made the projections measurably *worse*. It's
  excluded, and the comment says why, so nobody re-adds it in six months.
- Several situational effects turned out to already live inside a season rate the model was
  using — real effects, zero incremental value.

Recording a negative result is worth as much as recording a positive one. It's the difference
between a model you can reason about and one you're afraid to touch.

## 5. Distrust small wins and small samples

A 4-point edge on 30 picks is noise wearing a suit. Two habits help:

- **Check the largest sample, not the most flattering cut.** If an effect is strong at n=40 and
  vanishes at n=200, believe the n=200.
- **Watch for non-monotonicity.** If a gate's effect goes up, then down, then up as you raise the
  threshold, you're reading noise and should not tune finer. Where that happened here, the code
  says so explicitly and caps how precisely the gate is fit.

Escalators are sized to the **lower confidence bound** rather than the point estimate, because
small samples flatter and the point estimate is the optimistic end of a wide interval.

## 6. Test the player's own rate stat on the full population

This one cost a false negative and is the subtlest trap in the file.

An early audit asked "does quality of contact predict RBI?" and found nothing. It was wrong twice
over: it tested a *matchup-adjusted* factor rather than the hitter's own rate stat, and it ran only
over picks the model had **already surfaced** — a range-compressed, selection-biased sample where
everyone already looked good.

Re-run against every batter who took a plate appearance, using the hitter's own contact quality,
the effect was clear and sizable.

**The lesson:** to test whether a player attribute matters, test it on the whole population, not on
the subset your model already liked. Selection-biased samples produce confident null results, which
are the most expensive kind of wrong.

## 7. Separate calibration from discrimination

Two different questions that a single accuracy number hides:

- **Calibration** — when you say 60%, does it happen 60% of the time?
- **Discrimination** — do your higher-rated picks actually beat your lower-rated ones?

A category can be perfectly calibrated and completely useless: if every pick is 40% and every pick
truly is 40%, you've learned nothing about which to prefer. Both are tracked per category.

A related trap: **a flat correction factor cannot fix a shape error.** If your model's error grows
with its own prediction, scaling everything by one constant over-corrects the bottom and
under-corrects the top. The fix is shrinking predictions toward the observed mean, not scaling
them.

## 8. Invariants the model must not violate

Structural relationships are worth asserting in code, because a probability model can produce
individually plausible numbers that are jointly impossible.

Concrete example this codebase hit: the "2+ walks" list was briefly **larger** than the "1+ walk"
list. Both gates were reasonable in isolation, but they were independent — so a batter could clear
the stricter 2+ bar while failing the 1+ bar, which cannot happen in reality. The fix was making
the 2+ gate require the 1+ gate, guaranteeing a subset by construction rather than by coincidence.

If category A implies category B, encode it. Don't hope the thresholds happen to agree.

---

## Running the analysis

The scripts in `backtests/` read frozen prediction files and grade them against box scores. **On a
fresh clone they will report having nothing to analyze — that's correct, not broken.** Run the app
for a couple of weeks so it accumulates its own frozen slates first.

Long sweeps are **resumable**: they checkpoint to disk and skip completed work on restart, so an
interrupted run costs nothing. Worth copying if you write your own — these are API-bound jobs that
can run for hours, and a non-resumable one will eventually lose you a whole afternoon.
