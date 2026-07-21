# Statlo

**A daily MLB player-projection engine.** It ingests Statcast and MLB Stats API data, builds
per-plate-appearance rate models for ~20 outcome categories, expands them to game-level
probabilities, freezes those predictions before first pitch, grades them against box scores the
next day, and feeds the results back as per-category correction factors.

The interesting part isn't the projections. It's the **closed loop**: every prediction is frozen,
every contributing factor is logged alongside it, and every factor can be ablated afterward to ask
*"did this actually add anything?"* Most of them don't — and the code says so.

---

## Why this exists

Sports projection code tends to rot in a specific way: someone adds a factor because it sounds
right, it never gets measured, and three months later the model is a pile of plausible-sounding
multipliers nobody can justify or remove. This project is built around not letting that happen.

Three structural commitments enforce it:

1. **Predictions freeze before first pitch.** Written to `predictions-YYYY-MM-DD.json` and never
   rewritten. A prediction you can edit after the outcome isn't a prediction.
2. **Every factor is logged on every pick.** Each entry carries a `factors: {...}` object with each
   multiplier's contribution. A factor you didn't log is a factor you can never evaluate.
3. **Grading is automatic and adversarial to the model.** The accuracy loop reads real box scores,
   computes realized rate vs. predicted rate per category, and derives correction factors from the
   gap — measured against the model's *raw* output, not its already-corrected output.

---

## What it actually does

**Data layer** (`lib/mlbApi.js`) — MLB Stats API + Baseball Savant. Batter/pitcher platoon splits,
expected stats (xwOBA/xSLG/xERA), pitch-level arsenals and whiff rates by pitch group,
batter-vs-pitcher histories, bullpen composition, park factors, live weather. Aggressively cached,
since these are public endpoints that deserve to be treated gently.

**Model** (`lib/probabilities.js`) — the core. For each batter-game it builds a per-PA rate for each
outcome, applies contextual multipliers (pitcher quality, arsenal matchup, park, weather, defense,
times-through-order, lineup context), then expands to game probabilities via binomial:
`P(≥1) = 1 − (1−p)^PA`, and `P(≥2) = 1 − P(0) − P(1)` for the multi-event categories.

Categories include hits, extra-base hits, 2+ total bases, home runs, runs, RBI, walks, strikeouts,
2+ strikeouts, stolen bases, and the complements (no-hit / no-walk / no-strikeout).

**Accuracy loop** (`lib/accuracy.js`) — freeze, grade, calibrate. Also tracks **discrimination**
separately from calibration, which matters more than it sounds: a category can be perfectly
calibrated on average while its internal ranking carries no information at all. Both are measured.

**Research boards** — league-wide views built on the same data: rolling hot/cold streaks scored on
expected stats rather than raw results, platoon-split leaders, and a worst-projected-starters board.

**Backtests** (`backtests/`) — standalone analysis scripts. The pattern worth stealing: they're
**resumable**. Long API-bound sweeps checkpoint to disk and skip completed work on restart, so an
interrupted six-hour run costs you nothing.

---

## Engineering notes

A few problems here were more interesting than the modeling:

- **Concurrent read-modify-write on the daily file.** Several independent code paths update the same
  frozen prediction file. Writes go through a write-temp-then-rename so a reader or a killed process
  can never observe a half-written file.
- **Leakage discipline.** Anything computed *after* the freeze is kept structurally separate from
  the frozen payload, so post-hoc information can't leak backwards into what gets graded.
- **Calibration vs. shape errors.** A single flat correction factor per category can't fix a model
  whose error *varies with its own prediction*. Where that showed up, the fix was shrinking
  predictions toward the observed mean rather than scaling them — documented inline.
- **Small-sample handling.** Batter-vs-pitcher samples are tiny and seductive. Rates blend toward
  the larger split sample as a function of sample size, and escalators are sized to the lower
  confidence bound rather than the point estimate.

---

## Setup

```bash
git clone <your-fork>
cd statlo
npm install
npm start          # http://localhost:3000
```

**No credentials, no API keys, no configuration.** The only env var is `PORT`. First boot warms the
Savant leaderboards and the day's slate (a few minutes) and writes into `cache/`, which is
gitignored.

---

## What's deliberately NOT here

This is extracted from a larger private project. Three things were removed on purpose:

- **No betting, odds, or EV layer.** No sportsbook integrations, no market-edge computation, no
  ROI or closing-line tracking, no parlay construction. This projects player outcomes; it does not
  price them against a market.
- **No tuned constants.** Every inclusion floor, gate threshold, and sensitivity weight is a
  clearly-marked neutral **placeholder** (see the banner at the top of `lib/probabilities.js`). The
  published constants are *structure*, not a calibrated model. Derive your own — a threshold fitted
  to someone else's data is worse than no threshold, because it looks authoritative while encoding
  a population you never observed.
- **No gathered data.** No prediction history, no calibration history, no caches. The repo starts
  empty by design.

**Practical consequence:** the scripts in `backtests/` read frozen prediction files, so on a fresh
clone they will correctly report having nothing to analyze. Run the app for a couple of weeks first
— it needs to accumulate its own frozen slates before there's anything to grade.

> This is a modeling and research tool, not betting advice, and the placeholder constants are not
> predictive. Nothing here is a recommendation to wager.

---

## Architecture

| Path | Role |
|---|---|
| `lib/mlbApi.js` | All external data access + caching. Everything else reads from here. |
| `lib/probabilities.js` | The model: per-PA rates → contextual factors → game probabilities. |
| `lib/accuracy.js` | Freeze, grade, calibrate. Owns the prediction file format. |
| `lib/winPrediction.js` | Team-level win probability and run-total projection. |
| `lib/streaks.js`, `lib/splitLeaders.js`, `lib/cyOld.js` | League-wide research boards. |
| `lib/weather.js`, `lib/leadoffPredictor.js` | Context inputs (park/wind, projected lineup slots). |
| `routes.js` / `server.js` | HTTP API and the daily cron pipeline. |
| `public/` | Single-page UI — vanilla JS, no build step. |
| `backtests/` | Resumable research and factor-ablation scripts. |

**Daily flow:** preload slate + Savant → `computeAllProbables()` → freeze to
`predictions-YYYY-MM-DD.json` → next day, grade vs. box scores → update correction factors → repeat.

---

## Data sources

Reads from the **MLB Stats API** (`statsapi.mlb.com`) and **Baseball Savant**
(`baseballsavant.mlb.com`), both properties of MLB Advanced Media. This project is **not affiliated
with, endorsed by, or sponsored by MLB, MLBAM, or any club.** You're responsible for reviewing the
applicable terms for any data source you point it at, and for rate-limiting your own usage. Cache
aggressively (this repo does) and don't hammer public endpoints.

## License

MIT — see [LICENSE](LICENSE).
