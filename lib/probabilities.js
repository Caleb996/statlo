'use strict';

const { weatherHrMult: weatherHrMultFn } = require('./weather');

const {
  matchupCache, batterSplitCache, pitcherStatCache, pitcherRecentCache,
  pitcherSplitCache, recentBatterCache, rpAppearanceCache, vsTeamCache,
  HR_PARK_FACTORS, standingsCache,
  parseWeather, getUmpTendency, estimatedPAs, computeProbablesAdj,
  localDate, getSavantData, getCareerVenueCached, getBatterArsenalValue, getBatterWhiffValue,
  getTeamDefense, getLeagueHrPerGameSync, getAutoOutKMatchup, getCrushHrMatchup, getSavantPitcherData,
  getTeamKPct, getLeagueKPctAvg, getLeagueWhiffAvg,
} = require('./mlbApi');

// Park factors for BALLS IN PLAY, distinct from the HR park table. Hits (BABIP) and
// extra-base hits respond to outfield size / altitude differently than home runs —
// Coors inflates doubles enormously; pitcher parks suppress gap hits. Default 1.0.
const HITS_PARK_FACTOR = {
  'coors field': 1.09, 'fenway park': 1.04, 'great american ball park': 1.02,
  'globe life field': 1.02, 'chase field': 1.02, 'kauffman stadium': 1.03,
  'oracle park': 0.97, 'petco park': 0.97, 't-mobile park': 0.96,
  'tropicana field': 0.97, 'comerica park': 0.98, 'oakland coliseum': 0.97,
  'citi field': 0.98, 'busch stadium': 0.98,
};
const XBH_PARK_FACTOR = {
  'coors field': 1.28, 'fenway park': 1.12, 'kauffman stadium': 1.08,
  'globe life field': 1.05, 'great american ball park': 1.04, 'chase field': 1.04,
  'oracle park': 0.92, 'petco park': 0.93, 't-mobile park': 0.93,
  'tropicana field': 0.94, 'comerica park': 0.95,
};

// Handedness-specific HR park factors — the asymmetry a single park number misses (short
// porches favor one side). { L, R } multipliers, default neutral. Modulated by the
// batter's pull% so a pull hitter gets more of his pull-side porch, a spray hitter (e.g.
// Goldschmidt) still gets a share. Notable, well-documented asymmetries only.
const PARK_HAND_HR = {
  'yankee stadium':              { L: 1.22, R: 1.04 }, // short RF porch → LHB
  'oracle park':                 { L: 0.82, R: 0.95 }, // RF graveyard → LHB death
  'fenway park':                 { L: 0.94, R: 1.06 }, // Monster/deep RF
  'oriole park at camden yards': { L: 1.05, R: 0.90 }, // LF wall moved back 2022 → RHB suppressed
  'great american ball park':    { L: 1.12, R: 1.10 },
  'citizens bank park':          { L: 1.10, R: 1.08 },
  'pnc park':                    { L: 1.06, R: 0.94 }, // short RF → LHB
  'minute maid park':            { L: 0.98, R: 1.06 }, // Crawford boxes LF → RHB
  'daikin park':                 { L: 0.98, R: 1.06 },
  'petco park':                  { L: 0.90, R: 0.92 },
  'comerica park':               { L: 0.92, R: 0.88 },
  'kauffman stadium':            { L: 0.92, R: 0.93 },
  't-mobile park':               { L: 0.90, R: 0.92 },
  'loandepot park':              { L: 0.90, R: 0.90 },
  'dodger stadium':              { L: 1.03, R: 1.05 },
  'american family field':       { L: 1.06, R: 1.04 },
  'globe life field':            { L: 1.05, R: 1.05 },
  'truist park':                 { L: 1.04, R: 1.04 },
  'sutter health park':          { L: 1.06, R: 1.06 },
};

// Elastic candidate floors. A batter is a CANDIDATE for a "needs to happen" prop when
// its GAME probability clears a "real chance" floor — NOT a "strong play" bar. The list
// length is then free to flex with the slate (a hitter-friendly day surfaces more, a
// pitching-heavy day fewer). Confident plays are flagged `strong:true` for the UI/tags;
// downstream consumers apply their own (higher) thresholds, so a lower floor here
// never leaks weak legs into those. PROP_MAX is a generous ceiling, not a target.
// Floors are set so the FLOOR (not the cap) governs the count — the list stays elastic
// and flexes with the slate. They mark "a genuinely above-average chance," not "anyone
// with a nonzero chance" (a .230 hitter still clears 55% hit prob — too inclusive). Tune
// these to taste; PROP_MAX is only a runaway guard that should rarely bind.
// Raised to de-clutter: a full-month discrimination audit
// (the ablation script) showed NO signal reliably ranks winners within a
// category (single-game props are variance-dominated), so the lever for "less messy" is
// simply showing fewer, higher-base-rate candidates rather than chasing a magic filter.
// ===========================================================================================
// PLACEHOLDER CONSTANTS — READ THIS FIRST
//
// Every inclusion floor, gate threshold, and sensitivity weight in this file is a NEUTRAL
// PLACEHOLDER. They are structurally sane (the model runs and produces plausible output) but
// they are NOT tuned, and they are NOT the values this framework was developed against.
//
// Derive your own. The intended loop is: freeze predictions -> grade them from box scores ->
// read the per-category calibration and discrimination -> move the floor. `backtests/` has the
// scripts for that. A floor copied from someone else's data is worse than no floor, because it
// looks authoritative while encoding a population you never observed.
//
// Published baseball constants are NOT placeholders and are safe to keep as-is: the FIP
// constant, wOBA linear weights, and the league-average baselines (xwOBA, chase rate, hard-hit
// rate, WHIP, OBP) used to center the factors below.
// ===========================================================================================
const PROP_FLOORS = {
  hit: 0.70, hrp: 0.15, tb: 0.48, tb2: 0.54, walk: 0.40, sb: 0.18,
  runsOver: 0.50, rbiOver: 0.50,
};
// Gate placeholders referenced further down (see the note above before trusting any of these).
const AUTO_OUT_WHIFF_GATE   = 0.46;  // whiff rate on the batter's weak pitch group
const SP_DEPTH_GATE_IP      = 5.0;   // starter IP/start — proxy for a third time through
const WALK_STRONG_STAFF_GATE = 1.46; // staff-wildness multiplier for a "strong" walk flag
const PROP_MAX = 45;

// Discrimination score — the ONLY signal that was weakly-but-consistently positive across
// the month (env + plate-appearance opportunity + matchup; a small but consistent edge across every category).
// Not a strong filter — used only to ORDER the elastic lists so the top is mildly enriched
// toward "more chances in a higher-scoring game". Falls back to prob when env factors
// are absent (walk/sb). See the ablation script for the evidence.
function propDiscScore(e) {
  const f = e.factors || {};
  let s = 0, any = false;
  const add = (v, w) => { if (v != null && isFinite(v)) { s += v * w; any = true; } };
  add(f.park, 1.0);                                          // game run-environment
  add(f.pa != null ? f.pa - 4.0 : null, 0.30);              // PA opportunity (centered)
  add(f.pitcher, 0.8);                                       // pitcher faced
  add(e.bvpHr != null ? Math.min(e.bvpHr, 4) : null, 0.10); // confirmed BvP HR history
  add(e.bvpAb != null ? Math.min(e.bvpAb, 30) / 30 : null, 0.05);
  return any ? s : null;
}

// Pitch-arsenal matchup → modest per-PA rate nudges, tightly clamped, only when the SP's
// pitch mix is sufficiently covered. Two distinct signals:
// - OFFENSE (hit/tb/hr/rbi/run): batter run_value/100 vs the SP's mix (batter-positive).
// - K: batter per-pitch-type WHIFF rate vs the SP's mix, relative to league — the direct
// strikeout signal (a slider-whiffer vs a slider-heavy arm Ks more). Replaces the old
// run-value inverse, which bundled contact/power/whiff into one number.
// Shipped behind the propFactors `arsenal` key so the ablation script measures lift.
// DOWN-WEIGHTED : the 11-day pooled ablation showed `arsenal` (ars.off) adds
// NOISE in every category it touches (HIT −23, TB −33, TB2 −22, HR+ −4, RBI −9, RUN −3)
// and the whiff side (ars.k) hurt K too. Cut both sensitivities ~60% and tighten the
// clamp toward neutral; if the next ablation still shows it negative, prune entirely.
const ARS_SENS       = 0.025;  // offense: run value → rate multiplier sensitivity (was 0.06)
const ARS_WHIFF_SENS = 0.22;   // K: sensitivity to relative whiff deviation (was 0.50)
const LG_WHIFF       = 0.25;   // league-avg whiff rate (0-1) baseline for the K matchup
const ARS_MIN_COV    = 0.50;   // require ≥50% of the SP's pitch usage to be evaluable
const clampMul = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const arsenalMults = (batterId, spId) => {
  let off = 1.0, k = 1.0;
  const a = getBatterArsenalValue(batterId, spId);
  if (a && a.coverage >= ARS_MIN_COV) off = clampMul(1 + a.rv * ARS_SENS, 0.95, 1.06);
  const w = getBatterWhiffValue(batterId, spId);
  if (w && w.coverage >= ARS_MIN_COV) k = clampMul(1 + (w.whiff / LG_WHIFF - 1) * ARS_WHIFF_SENS, 0.95, 1.06);
  return { off, k };
};
const { getCorrectionFactors, getCalibrationHistory } = require('./accuracy');

const LG_HR_PA       = 0.033;  // league SP HR/BF baseline (starters ~3.3%)
const LG_HR_PA_BP    = 0.028;  // league RP HR/BF baseline (relievers suppress HR, ~2.8%)
const LG_SP_KPCT     = 0.226;  // MLB avg SP strikeout rate (2024)
const HIT_UNDER_MIN  = 0.40;   // min hitless probability for a HIT- pick to surface

// Lineup-position multipliers — RBI opportunities weight toward middle order;
// run-scoring opportunities weight toward top of order.
// RBI_POS_MULT shrunk toward 1.0 by 0.5 on (ablation: `pos` was the worst
// RBI factor, −42/active) — the raw 1.58/0.76 extremes overshot the position effect.
const RBI_POS_MULT = [null, 0.945, 1.04, 1.195, 1.29, 1.23, 1.10, 1.005, 0.945, 0.88];
// RUN_POS_MULT compressed — a box-score check across a full season of starters showed the
// leadoff-to-9-hole run-scoring ratio is far flatter than this array originally assumed. Same overshoot RBI_POS_MULT already got caught
// for on 06-25. Rescaled to match the real per-slot ratios while keeping the same
// mean-preserving design (sums to ~9, so team-level total runs stays conserved).
const RUN_POS_MULT = [null, 1.26, 1.16, 1.06, 1.00, 0.98, 0.92, 0.92, 0.87, 0.84];

// RBI is high-variance pre-game (depends on runners on base, unobservable) and its
// position/team factors stack multiplicatively into extremes that overshoot — the
// source of rbiUnder's inverted discrimination (prop-buckets audit). Regress the
// factor stack toward the batter's own RBI rate to compress those extremes. Same
// principle as the moneyline's WINPROB_GAP_REGRESSION. <1 = more shrink toward base.
const RBI_FACTOR_REGRESSION = 0.6;

function fmtObp(n) {
  if (n >= 1) return '1.000';
  return '.' + String(Math.round(n * 1000)).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// Bullpen composite — weighted-avg rates excluding tired arms
// ---------------------------------------------------------------------------
function getBullpenComposite(rows, managerConsecRate = 0.20) {
  if (!rows?.length || !rows[0]?.pitchers) return null;
  const tendencyFactor = Math.max(0.5, Math.min(2.5, managerConsecRate / 0.20));
  let kSum = 0, bbSum = 0, hrSum = 0, eraSum = 0, xslgSum = 0, xslgW = 0, weight = 0;

  for (const pr of rows[0].pitchers) {
    if (pr.pitcher.role !== 'RP') continue;
    const pSt  = pitcherStatCache[pr.pitcher.id] || {};
    if (!pSt.bf || pSt.bf < 20) continue;
    // Rotation starters are tagged 'RP' on every day they aren't the confirmed starter
    // (no other signal available) but essentially never actually pitch in relief outside
    // deep extras — exclude them so their own last START doesn't get read as bullpen
    // workload/availability. Same guard as bullpenProfile in winPrediction.js.
    if ((pSt.gamesS || 0) > 2) continue;

    const rest = rpAppearanceCache[pr.pitcher.id] || {};
    const dr   = rest.daysRest;
    let restMult = 1.0;
    if      (dr === 0)                        restMult = 0.00;
    else if (dr === 1 && (rest.g3 || 0) >= 2) restMult = Math.min(0.35, 0.10 * tendencyFactor);
    else if (dr === 1)                        restMult = Math.min(0.75, 0.40 * tendencyFactor);

    const w = (pSt.gamesP || 1) * restMult;
    if (w === 0) continue;
    weight += w;
    if (pSt.kpct   != null) kSum   += parseFloat(pSt.kpct)  / 100 * w;
    if (pSt.bbpct  != null) bbSum  += parseFloat(pSt.bbpct) / 100 * w;
    if (pSt.hrRate != null) hrSum  += pSt.hrRate * w;
    if (pSt.era    != null) eraSum += pSt.era * w;
    // xSLG-allowed: expected slugging permitted — same Savant data as SP, per reliever
    const rpXslg = getSavantPitcherData()[pr.pitcher.id]?.xslg;
    if (rpXslg != null) { xslgSum += rpXslg * w; xslgW += w; }
  }
  if (weight === 0) return null;
  return {
    kPct: kSum/weight, bbPct: bbSum/weight, hrRate: hrSum/weight, era: eraSum/weight,
    xslg: xslgW > 0 ? xslgSum / xslgW : null,
  };
}

// ---------------------------------------------------------------------------
// Manager tendency — consecRate and dynamic SP/RP weight
// ---------------------------------------------------------------------------
function computeManagerTendency(rows, spId) {
  let crSum = 0, crCount = 0;
  for (const pr of (rows[0]?.pitchers || [])) {
    if (pr.pitcher.role !== 'RP') continue;
    const rest = rpAppearanceCache[pr.pitcher.id] || {};
    if (rest.consecRate != null) {
      const w = pitcherStatCache[pr.pitcher.id]?.gamesP || 1;
      crSum   += rest.consecRate * w;
      crCount += w;
    }
  }
  const managerConsecRate = crCount > 0 ? crSum / crCount : 0.20;

  let spAvgIp = 5.5;
  let isOpener = false;
  if (spId) {
    const pSt = pitcherStatCache[spId] || {};
    // pSt.ip is season-TOTAL innings (starts + any relief outings), but pSt.gamesS only
    // counts starts. For swingmen who've also relieved, ip/gamesS wildly overstates true
    // innings-per-start (e.g. a 6-start/16-appearance swingman with 52 IP shows "8.7").
    // Only trust the ratio when relief appearances are a small share of the season.
    const gamesS = pSt.gamesS || 0;
    const gamesP = pSt.gamesP || gamesS;
    const reliefApps = Math.max(0, gamesP - gamesS);
    // Opener/bulk-reliever detection (mirrors winPrediction.js's avgIpPerStart, the game-
    // level model, which already handled this) — a "probable starter" with almost no real
    // starts this season is very likely a deliberate 1-2 inning opener, not a normal
    // starter. The flat 5.5 fallback below assumed a full start and drastically
    // underweighted the actual bulk/bullpen pitcher who faces most of the lineup.
    isOpener = gamesS < 3 || reliefApps > gamesS * 2;
    const spIsPureStarter = reliefApps <= 2;
    if (isOpener) spAvgIp = 2.5;
    else if (pSt.ip > 0 && gamesS > 0 && spIsPureStarter)
      spAvgIp = Math.max(3.0, Math.min(8.0, pSt.ip / gamesS));
  }
  // The 0.40 floor below is tuned for ordinary short-outing starters (an early-hook guy
  // who still averages ~3.5-4 IP/start) — too high for a confirmed opener who's only
  // actually going 1-2 innings. Give openers their own, lower floor instead of quietly
  // widening the shared one for every pitcher.
  const spWt = isOpener
    ? Math.max(0.15, Math.min(0.35, spAvgIp / 9.0))
    : Math.max(0.40, Math.min(0.75, spAvgIp / 9.0));
  const rpWt = 1 - spWt;

  // Bad-script weight — same shape as winPrediction.js's spReliability: a starter
  // expected to go deep leans almost entirely on the leverage-weighted pen (the good
  // arms), while a short/opener-type start exposes the batter to the mop-up tail much
  // more. Mirrors the moneyline model so props and win/spread agree on this.
  const badScriptWt = 1 - Math.max(0.72, Math.min(0.90, 0.80 + (spAvgIp - 5.5) * 0.06));

  return { managerConsecRate, spWt, rpWt, badScriptWt };
}

const RP_LEVERAGE_W = { Closer: 1.5, Setup: 1.3, Middle: 0.85 };
function rpRoleFor(pSt) {
  if ((pSt.saves || 0) >= 5 || (pSt.saveOpps || 0) >= 5) return 'Closer';
  if ((pSt.holds || 0) >= 5)                              return 'Setup';
  return 'Middle';
}

// ---------------------------------------------------------------------------
// Squad Combo groups — groups a pool of qualifying players (favorable matchup +
// probability floor) into batches, projecting a COMBINED total across each batch.
// Built for runs (leadoffComboPool): a same-game grouped-
// style "N players combined score X+ runs" prop, assembled BEFORE lineups post where
// possible (predicted leadoff hitters — lib/leadoffPredictor.js). Extended
// for hits (hitsComboPool) — same grouping/math, different underlying stat.
//
// Math: each pool entry carries `prob` (P(stat >= 1), the model's own already-
// calibrated probability) and OPTIONALLY `lambda` (a direct expected-count value, when
// the caller has one — hits does, via hitPerPa*pa; runs doesn't, since runsOverProb has
// no direct linear expectation available). When lambda isn't supplied, it's recovered
// from prob: treating the stat's COUNT as Poisson(lambda) gives P(0)=e^-lambda=1-prob,
// so lambda=-ln(1-prob) — exact, not an approximation, but only as good as prob itself
// (see the EV-vs-distance robustness discussion: a directly-supplied lambda
// is preferred whenever available since it avoids extra derivation steps). A group's
// combined total is then Poisson(sum of member lambdas) (sum of independent Poissons is
// Poisson) — the same independence SIMPLIFICATION already used elsewhere in this app for
// combined group probability (real same-game correlation is not modeled), disclosed here too.
function poissonCdfCombo(k, lam) {
  if (lam <= 0) return 1;
  let term = Math.exp(-lam), s = term;
  for (let i = 1; i <= k; i++) { term *= lam / i; s += term; }
  return s;
}
// Deflate a combo pool's probs/lambdas by the category's daily calibration factor before
// grouping — mirrors what the ACCURACY_CATS loop does to the single-pick categories.
function correctComboPool(pool, factor) {
  const f = factor ?? 1.0;
  if (f === 1.0) return pool;
  return pool.map(e => ({
    ...e,
    prob: Math.max(0, Math.min(1, e.prob * f)),
    lambda: e.lambda != null ? e.lambda * f : e.lambda,
  }));
}
function computeLeadoffComboGroups(pool, groupSize = 8, metric = 'runs') {
  const sorted = [...pool].sort((a, b) => b.prob - a.prob);
  const groups = [];
  for (let i = 0; i < sorted.length; i += groupSize) {
    const chunk = sorted.slice(i, i + groupSize);
    if (chunk.length < 3) break; // too few stragglers left to form a meaningful group
    const lambdas = chunk.map(e => e.lambda != null ? e.lambda : -Math.log(Math.max(0.03, 1 - Math.min(e.prob, 0.97))));
    const combinedLambda = lambdas.reduce((a, b) => a + b, 0);
    const line = Math.max(0.5, Math.round(combinedLambda) - 0.5);
    const overProb = 1 - poissonCdfCombo(Math.floor(line), combinedLambda);
    const confirmedCount = chunk.filter(e => e.confirmed).length;
    groups.push({
      tier: groups.length + 1, metric,
      players: chunk.map(e => ({
        batterId: e.batterId, batter: e.batter, team: e.team, pitcher: e.pitcher, pitcherId: e.pitcherId, game: e.game,
        prob: +e.prob.toFixed(3), confirmed: e.confirmed,
        predictionConfidence: e.predictionConfidence, battingOrder: e.battingOrder ?? null,
      })),
      projTotal: +combinedLambda.toFixed(1),
      line, over: +overProb.toFixed(3), under: +(1 - overProb).toFixed(3),
      confirmedCount, lineupRisk: confirmedCount < chunk.length,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Main probables compute
// ---------------------------------------------------------------------------
function computeAllProbables() {
  const correctionFactors  = getCorrectionFactors();
  const calibrationHistory = getCalibrationHistory();
  const gamesLoaded = Object.keys(matchupCache).length;
  const hit = [], k = [], cold = [], hrp = [], hrpLive = [], hrm = [], vsTeamHr = [], vsTeamCareer = [], recentK = [];
  const spProjectedK = [];
  let slateHrSum = 0;   // Σ raw P(HR) over ALL batters — anchors the slate HR calibration
  const tb = [], tb2 = [], walk = [], rbiOver = [], rbiUnder = [], runsOver = [], runsUnder = [], sb = [];
  const bbUnder = [], kUnder = [];
  const actionablesLeadoff = [], actionablesSecond = [];
  const leadoffComboPool = [];
  const hitsComboPool = [];
  const streakHot = [], streakCold = [], streakFire = [];

  // --- Input-contribution instrumentation (propFactors) ---------------------
  // Per-prop analog of the win model's winFactors: log each input's SIGNED
  // log-contribution toward the category's own event so the ablation script
  // can measure whether each input actually improves prediction (lift) per prop.
  // L(mult)=ln of a factor's multiplicative effect on the per-PA rate; ratios are
  // computed from already-named locals (rates are mostly base x Pi factors, with a
  // couple of additive steps captured via before/after snapshots). `base` is the
  // pure split rate, `rate` the final per-PA rate, `pa` the plate appearances.
  const L = (m) => (m != null && isFinite(m) && m > 0) ? +Math.log(m).toFixed(4) : 0;
  const META = new Set(['base', 'rate', 'pa']);
  const negFactors = (f) => {           // toward the complement event (e.g. HR- from HR+)
    const o = { base: f.base, rate: f.rate, pa: f.pa };
    for (const k in f) if (!META.has(k)) o[k] = -f[k];
    return o;
  };

  for (const matchup of Object.values(matchupCache)) {
    const parkFactor = HR_PARK_FACTORS[matchup.venueName?.toLowerCase()] ?? 1.0;
    const sides = [
      { rows: matchup.awayPitchingVsHome, abbrev: matchup.home.abbrev, battingTeamId: matchup.home.teamId, opposingTeamId: matchup.away.teamId, opposingTeamAbbrev: matchup.away.abbrev, opposingTeamName: matchup.away.name, catcherCS: matchup.catcherCS?.forHomeBatters ?? 0.28, isHome: true  },
      { rows: matchup.homePitchingVsAway, abbrev: matchup.away.abbrev, battingTeamId: matchup.away.teamId, opposingTeamId: matchup.home.teamId, opposingTeamAbbrev: matchup.home.abbrev, opposingTeamName: matchup.home.name, catcherCS: matchup.catcherCS?.forAwayBatters ?? 0.28, isHome: false },
    ];
    const pWeather = parseWeather(matchup.weather);
    const umpTend  = getUmpTendency(matchup.umpire);

    for (const { rows, abbrev, battingTeamId, opposingTeamId, opposingTeamAbbrev, opposingTeamName, catcherCS, isHome } of sides) {
      if (!rows || !rows.length) continue;
      const spEntry = rows[0].pitchers.find(p => p.pitcher.role === 'SP');
      if (!spEntry) continue;
      const sp        = spEntry.pitcher;
      const hand      = sp.hand || 'R';
      const handLabel = hand === 'L' ? 'LHP' : 'RHP';
      const game      = `${matchup.away.abbrev} @ ${matchup.home.abbrev}`;
      const { managerConsecRate, spWt: SP_WT, rpWt: RP_WT, badScriptWt: BAD_SCRIPT_WT } = computeManagerTendency(rows, sp.id);
      const bpComp    = getBullpenComposite(rows, managerConsecRate);

      // Team lineup OBP — proxy for baserunner opportunity, the key driver of RBI chances
      // that the per-batter model cannot see. Clamped [0.75, 1.25] to avoid extreme swings.
      const LG_OBP = 0.315;
      const lineupObps = rows.map(r => batterSplitCache[r.batter.id]?.obp ?? null).filter(v => v !== null);
      const teamLineupObp = lineupObps.length >= 4
        ? lineupObps.reduce((a, b) => a + b, 0) / lineupObps.length
        : LG_OBP;
      const teamObpFactor = Math.max(0.75, Math.min(1.25, teamLineupObp / LG_OBP));

      // Batting-order -> OBP map, for the pitch-around walk factor below: how much on-base
      // threat sits in front of each hitter (the guys who create the runner-in-scoring-
      // position, first-base-open spot where a dangerous bat gets pitched around).
      // population effect (measured on a full-season backtest): walk rate roughly doubles
      // with first base open + a runner in scoring position, scaling with the batter's power.
      const orderObpMap = {};
      for (const r of rows) {
        const o = r.batter.battingOrder;
        if (o >= 1 && o <= 9) orderObpMap[o] = batterSplitCache[r.batter.id]?.obp ?? null;
      }

      // Team RS/G from standings — primary run-environment signal for scoring model
      const standRec = (standingsCache.data || {})[battingTeamId];
      const teamRS   = standRec?.gamesPlayed >= 10
        ? standRec.runsScored / standRec.gamesPlayed
        : null;

      // SP-level stats — same for every batter in this lineup, hoist out of loop
      const pSt     = pitcherStatCache[sp.id] || {};
      const pRecent = pitcherRecentCache[sp.id];
      const pSplit  = pitcherSplitCache[sp.id];

      // --- Per-side factors (same for every batter facing this defense/park/SP) ---
      // Opposing defense (OAA): an elite defense converts more balls-in-play into outs,
      // suppressing hits/BABIP and robbing some XBH. Full-season team OAA ~ -40..+40.
      const oppDef     = getTeamDefense(opposingTeamName);
      const oppOaa     = oppDef?.oaa ?? null;
      const defHitMult = oppOaa != null ? Math.max(0.97, Math.min(1.03, 1 - oppOaa / 1000)) : 1.0;
      const defXbhMult = oppOaa != null ? Math.max(0.98, Math.min(1.02, 1 - oppOaa / 1800)) : 1.0;
      // Ball-in-play park factors (distinct from the HR park table).
      const venueKey      = matchup.venueName?.toLowerCase();
      const hitParkMult   = HITS_PARK_FACTOR[venueKey] ?? 1.0;
      const xbhParkMult   = XBH_PARK_FACTOR[venueKey]  ?? 1.0;
      // Times-through-the-order: each look at the SP produces more (~+0.02 wOBA/turn).
      // A deeper-going starter exposes the lineup to more high-TTO PAs → larger average
      // uplift across the batter's looks. Derived from the SP's IP/start; small + clamped.
      // Guard: pSt.ip is season-TOTAL innings (starts + relief), pSt.gamesS is starts only —
      // for swingmen who've also relieved, ip/gamesS overstates true innings-per-start.
      const gamesSK    = pSt.gamesS || 0;
      const gamesPK    = pSt.gamesP || gamesSK;
      const reliefAppsK = Math.max(0, gamesPK - gamesSK);
      // Opener/bulk-reliever detection (mirrors winPrediction.js's avgIpPerStart) — see the
      // matching note in computeManagerTendency above for why the flat 5.3 fallback is
      // wrong for a deliberate 1-2 inning opener.
      const isOpenerK      = gamesSK < 3 || reliefAppsK > gamesSK * 2;
      const spIsPureStarterK = reliefAppsK <= 2;
      const spIpPerStart = isOpenerK ? 2.5
        : (pSt.ip > 0 && gamesSK > 0 && spIsPureStarterK)
          ? Math.max(3.0, Math.min(8.0, pSt.ip / gamesSK))
          : 5.3;
      const ttoMult      = Math.max(1.0, Math.min(1.05, 1 + (spIpPerStart - 5.0) * 0.012));

      // SP quality tier — FIP-blended ERA (45% ERA + 55% FIP) + K rate + WHIP.
      // FIP removes luck (BABIP, strand rate) and is more predictive than ERA alone.
      // Falls back to ERA-only when FIP is unavailable. Thresholds are +0.20 vs
      // pure-ERA thresholds to account for FIP running slightly higher on average.
      let spSeasonEra  = (pSt.era != null && pSt.fip != null)
        ? pSt.era * 0.35 + pSt.fip * 0.65
        : (pSt.era ?? null);
      // xERA blend (45%, matching winPrediction.js's effectiveSPEra) —
      // on 129 real starters: the era/fip blend above correlates only 0.17
      // with a pitcher's ACTUAL performance in a later holdout window, while xERA alone
      // correlates 0.51 — roughly 3x stronger. era/fip over a half-season sample is
      // genuinely noisy (BABIP, sequencing, bullpen support); xERA (quality-of-contact
      // based) is far more stable. Matches winPrediction.js's already-proven weight
      // rather than the backtest's own (leakage-favored) optimum, which trended toward
      // weighting xERA even higher.
      const spXeraForBlend = getSavantPitcherData()[sp.id]?.xera ?? null;
      if (spSeasonEra != null && spXeraForBlend != null && (pSt.ip || 0) >= 20) {
        spSeasonEra = spSeasonEra * 0.55 + spXeraForBlend * 0.45;
      }
      const spRecentEra  = (pRecent?.recentEra != null && pRecent.ip3 >= 12) ? pRecent.recentEra : null;
      const spBlendedEra = spRecentEra != null
        ? spSeasonEra * 0.55 + spRecentEra * 0.45
        : spSeasonEra;
      const spKpctNum = pSt.kpct ? parseFloat(pSt.kpct) / 100 : 0;
      let spTier = 0;
      if ((pSt.bf || 0) >= 50 && (pSt.gamesS || 0) >= 5 && spBlendedEra != null) {
        if      (spBlendedEra <= 2.70 && spKpctNum >= 0.28 && (pSt.whip || 99) <= 1.10) spTier = 3;
        else if (spBlendedEra <= 3.40 && spKpctNum >= 0.25)                               spTier = 2;
        else if (spBlendedEra <= 4.00 && spKpctNum >= 0.22)                               spTier = 1;
      }
      // Second path via Statcast xERA + K/BB — the ERA/K%/WHIP AND-gate above excludes
      // genuinely elite pitchers who clear two of three bars but narrowly miss the third
      // (Paul Skenes, xERA 2.76/K-BB 5.38, excluded on ERA alone —
      // his actual ERA is inflated by bad luck/defense, not skill; Zack Wheeler, ERA 2.36/
      // WHIP 0.94, excluded on K% alone at 27.3% vs the 28% bar). xERA/K-BB are Statcast
      // quality-of-contact-based and don't share that brittleness. Only raises tier, never
      // lowers it — this is a rescue path, not a stricter replacement.
      if ((pSt.bf || 0) >= 50 && (pSt.gamesS || 0) >= 5) {
        const spXera = getSavantPitcherData()[sp.id]?.xera ?? null;
        const spKbb  = getSavantPitcherData()[sp.id]?.kbb  ?? null;
        if (spXera != null && spKbb != null) {
          if      (spXera <= 2.90 && spKbb >= 4.0) spTier = Math.max(spTier, 3);
          else if (spXera <= 3.30 && spKbb >= 3.5) spTier = Math.max(spTier, 2);
        }
      }
      const spTierLabel = spTier === 3 ? 'Ace SP' : spTier === 2 ? 'Elite SP' : spTier === 1 ? 'Strong SP' : '';

      // SP negative tier — struggling/weak pitchers boost positive predictions
      let spNegTier = 0;
      if ((pSt.bf || 0) >= 50 && spBlendedEra != null && spTier === 0) {
        if      (spBlendedEra >= 6.50)                              spNegTier = 3;
        else if (spBlendedEra >= 5.50 && spKpctNum <= 0.19)         spNegTier = 2;
        else if (spBlendedEra >= 4.80 && spKpctNum <= 0.20)         spNegTier = 1;
      }
      const spNegTierLabel = spNegTier === 3 ? 'Struggling SP' : spNegTier === 2 ? 'Weak SP' : spNegTier === 1 ? 'Below-Avg SP' : '';
      // --- Projected Strikeouts (SP), once per side. Fit on a leakage-free multi-season start
      // backtest: season K% x own average batters-faced per start x opponent-team K-vulnerability
      // x pitcher whiff%. Two findings shaped the final form. Whiff% at FULL strength bought a
      // little extra correlation but pushed MAE the wrong way, so it is damped to half strength —
      // that kept nearly all the ranking gain without the error cost. And a recent-form
      // (last-three-start) trend term made things WORSE, so it is deliberately excluded rather
      // than silently dropped; negative results are worth recording too.
      const spKpctForProjK  = (pSt.bf || 0) > 0 ? pSt.so / pSt.bf : null;
      const spAvgBfPerStart = (spIsPureStarterK && gamesSK > 0 && (pSt.bf || 0) > 0)
        ? pSt.bf / gamesSK
        : spIpPerStart * 4.3;  // league-avg BF/IP fallback for openers/unclear samples
      if (spKpctForProjK != null && spAvgBfPerStart > 0 && (pSt.bf || 0) >= 40 && gamesSK >= 3) {
        let projK = spKpctForProjK * spAvgBfPerStart;

        const oppKPct  = getTeamKPct(battingTeamId);
        const lgKPct   = getLeagueKPctAvg();
        const oppKMult = oppKPct != null ? Math.max(0.80, Math.min(1.20, oppKPct / lgKPct)) : 1.0;
        projK *= oppKMult;

        const spWhiff   = getSavantPitcherData()[sp.id]?.whiffPct ?? null;
        const lgWhiff   = getLeagueWhiffAvg();
        const whiffMult = spWhiff != null ? Math.max(0.90, Math.min(1.10, 1 + (spWhiff / lgWhiff - 1) * 0.5)) : 1.0;
        projK *= whiffMult;

        const note = `${(spKpctForProjK * 100).toFixed(1)}% K rate x ${spAvgBfPerStart.toFixed(1)} BF/start`
          + (oppKPct != null ? ` x opp ${(oppKPct * 100).toFixed(1)}% K-rate` : '')
          + (spWhiff != null ? ` x ${spWhiff.toFixed(1)}% whiff` : '');

        spProjectedK.push({
          game, gamePk: matchup.gamePk, pitcher: sp.name, pitcherId: sp.id,
          team: opposingTeamAbbrev, opponent: abbrev, isHome,
          projK: +projK.toFixed(1),
          seasonKPct: +(spKpctForProjK * 100).toFixed(1),
          avgBfPerStart: +spAvgBfPerStart.toFixed(1),
          oppKPct: oppKPct != null ? +(oppKPct * 100).toFixed(1) : null, oppKMult: +oppKMult.toFixed(3),
          whiffPct: spWhiff, whiffMult: +whiffMult.toFixed(3),
          reliability: 'medium',
          note,
        });
      }

      for (const batterRow of rows) {
        const s = batterSplitCache[batterRow.batter.id];
        if (!s) continue;
        const careerVs = getCareerVenueCached(batterRow.batter.id, matchup.venueId);

        const splitPa    = hand === 'L' ? s.paVsL : s.paVsR;
        const useSplit   = splitPa >= 25;
        const fallbackOk = !useSplit && s.pa >= 80;
        if (!useSplit && !fallbackOk) continue;

        // Pitch-arsenal matchup multipliers (this batter vs this SP's pitch mix).
        const ars = arsenalMults(batterRow.batter.id, sp.id);

        const splitKPct = useSplit ? (hand === 'L' ? s.kPctVsL : s.kPctVsR) : s.kPct;
        const splitObp  = useSplit ? (hand === 'L' ? s.obpVsL  : s.obpVsR)  : s.obp;
        const splitAvg  = useSplit ? (hand === 'L' ? s.avgVsL  : s.avgVsR)  : s.avg;

        const spPair = batterRow.pitchers && batterRow.pitchers.find(pr => pr.pitcher.id === sp.id);
        const bvp    = spPair?.bvp;
        const bvpAb  = bvp?.ab || 0;
        function blendRate(bvpRate, splitRate, wOverride) {
          // BvP counts from ~15 PA (mid-band lifted — a 25-35 PA sample
          // is real signal, not noise; correction loop absorbs residual drift).
          // wOverride: extreme-signal escalator — the ladder is
          // magnitude-blind, so statistically extreme small samples can pass a
          // higher weight explicitly. Escalate HOT extremes only; cold small
          // samples showed zero predictive depression .
          if (bvpRate == null || bvpAb === 0) return splitRate;
          if (wOverride != null) return bvpRate * wOverride + splitRate * (1 - wOverride);
          if (bvpAb >= 40) return bvpRate * 0.45 + splitRate * 0.55;
          if (bvpAb >= 25) return bvpRate * 0.38 + splitRate * 0.62;
          if (bvpAb >= 15) return bvpRate * 0.30 + splitRate * 0.70;
          if (bvpAb >=  8) return bvpRate * 0.18 + splitRate * 0.82;
          if (bvpAb >=  4) return bvpRate * 0.10 + splitRate * 0.90;
          return               bvpRate * 0.05 + splitRate * 0.95;
        }
        // Hot small-sample escalators (multi-week backtest over thousands of batter-days):
        // a batter with multiple BvP home runs in a small AB sample homered same-day at a much
        // higher rate than his peers, and surfaced hrp picks realized well above their stated
        // probability — the original ladder was underweighting them. Rungs are sized to the
        // LOWER confidence bound rather than the point estimate, since small samples flatter.
        // A high BvP OPS in the same AB band showed milder evidence — one rung up only.
        // Cold extremes (0-for-10 types) deliberately NOT escalated: they realized no worse
        // than neutral — small-sample cold BvP is luck, not signal.
        const bvpHotHrW  = ((bvp?.hr || 0) >= 2 && bvpAb >= 4 && bvpAb <= 14) ? 0.40 : null;
        const bvpHotOpsW = ((bvp?.ops || 0) >= 1.100 && bvpAb >= 4 && bvpAb <= 14) ? 0.30 : null;

        const baseKPct = blendRate(bvp?.kpct != null ? parseFloat(bvp.kpct) / 100 : null, splitKPct);
        const baseObp  = blendRate(bvp?.obp, splitObp, bvpHotOpsW);
        const baseAvgRaw = blendRate(bvp?.avg, splitAvg, bvpHotOpsW);

        // Statcast lookup (hoisted up so xBA can stabilize the hit base).
        const savant = getSavantData()[batterRow.batter.id] || {};
        // xBA stabilizer: observed AVG over a partial season carries BABIP luck; the
        // luck-stripped Statcast xBA is a better true-talent base. Blend toward it.
        const XBA_W = 0.30;
        const baseAvg = (savant.xba != null && baseAvgRaw > 0)
          ? baseAvgRaw * (1 - XBA_W) + savant.xba * XBA_W
          : baseAvgRaw;

        const bRecent = recentBatterCache[batterRow.batter.id] || {};
        const streakBase = { batterId: batterRow.batter.id, batter: batterRow.batter.name, team: abbrev, game, gamePk: matchup.gamePk };
        if (bRecent.hitStreak     >= 5)                          streakHot.push({ ...streakBase, hitStreak: bRecent.hitStreak });
        if (bRecent.hitlessStreak >= 4)                          streakCold.push({ ...streakBase, hitlessStreak: bRecent.hitlessStreak });
        if (bRecent.avg7 >= 0.400 && (bRecent.ab7 || 0) >= 15)  streakFire.push({ ...streakBase, avg7: bRecent.avg7, ab7: bRecent.ab7 });
        const adj = computeProbablesAdj(
          batterRow.batter.hand || 'R', pSt, pRecent, pSplit, bRecent, s, pWeather, umpTend,
          getSavantPitcherData()[sp.id]?.xwoba ?? null
        );

        let kPct = Math.max(0, Math.min(0.99, (baseKPct || 0) * adj.kMult));
        let obp  = Math.max(0, Math.min(0.99, (baseObp  || 0) + adj.obpAdj));
        let avg  = Math.max(0, Math.min(0.99, (baseAvg  || 0) + adj.avgAdj));
        // propFactors snapshots: stage values to decompose each input's contribution.
        const _avgAdj = avg, _kAdj = kPct;     // after contextual adj (post-BvP base)
        let _avgBp = avg, _kBp = kPct, _avgHa = avg, _avgHh = avg;

        if (bpComp) {
          if (bpComp.kPct != null) {
            const bpKRatio = Math.max(0.80, Math.min(1.20, bpComp.kPct / 0.23));
            kPct = Math.max(0, Math.min(0.99, kPct * (1 + (bpKRatio - 1) * RP_WT)));
          }
          if (bpComp.era != null) {
            const bpOpsAdj = Math.max(-0.015, Math.min(0.015, (bpComp.era / 4.20 - 1) * 0.040 * RP_WT));
            obp = Math.max(0, Math.min(0.99, obp + bpOpsAdj));
            avg = Math.max(0, Math.min(0.99, avg + bpOpsAdj * 0.70));
          }
        }
        _avgBp = avg; _kBp = kPct;             // after bullpen

        // Home/away split adjustment — 20% weight on observed home/away avg vs season avg
        const HOME_AWAY_WEIGHT = 0.20;
        const haAvg = isHome ? s.avgHome : s.avgAway;
        const haObp = isHome ? s.obpHome : s.obpAway;
        const haPa  = isHome ? s.paHome  : s.paAway;
        if (haAvg != null && haPa >= 30 && s.avg != null && s.avg > 0) {
          const haFactor = Math.max(0.80, Math.min(1.20, haAvg / s.avg));
          avg = Math.max(0, Math.min(0.99, avg * (1 - HOME_AWAY_WEIGHT + HOME_AWAY_WEIGHT * haFactor)));
        }
        if (haObp != null && haPa >= 30 && s.obp != null && s.obp > 0) {
          const haFactor = Math.max(0.80, Math.min(1.20, haObp / s.obp));
          obp = Math.max(0, Math.min(0.99, obp * (1 - HOME_AWAY_WEIGHT + HOME_AWAY_WEIGHT * haFactor)));
        }
        _avgHa = avg;                          // after home/away split

        // Statcast contact quality — hard hit rate adjusts avg (contact luck correction)
        const LG_HARD_HIT  = 37.0;
        const LG_BABIP     = 0.300;
        // (savant looked up above for the xBA base stabilizer)
        // Bat-speed stabilizer (see the ablation script): season-to-date barrel rate
        // is a noisy batted-ball stat — early in the year a batter may have only ~50-180
        // PA. Bat speed is a sticky skill that forward-predicts HR power as well as barrel
        // itself (2025→2026 carryover test: bat speed alone R²=0.21 > barrel alone 0.195;
        // +0.03 incremental R² on top of barrel+hardHit). So pull the observed barrel
        // toward its bat-speed-implied expectation to de-noise it. expBarrel regression
        // fit on 2025 : -74.5 + 1.163·batSpeed; refit via the ablation script.
        let barrelStab = savant.barrelRate;
        if (savant.barrelRate != null && savant.batSpeed != null) {
          const expBarrel = Math.max(2, Math.min(18, -74.499 + 1.1627 * savant.batSpeed));
          barrelStab = 0.70 * savant.barrelRate + 0.30 * expBarrel;  // observed dominates; bat speed anchors
        }
        // Hard-hit down-weighted (ablation: HIT −34/active) — observed AVG +
        // xBA already carry contact quality; compress deviation (×0.5) and tighten clamp.
        const hardHitAdj    = savant.hardHitPct != null
          ? Math.max(0.93, Math.min(1.08, 1 + (savant.hardHitPct / LG_HARD_HIT - 1) * 0.5))
          : 1.0;
        if (hardHitAdj !== 1.0) avg = Math.max(0, Math.min(0.99, avg * hardHitAdj));
        _avgHh = avg;                          // after hard-hit

        // Pitcher xBA-allowed — the direct pitcher-side mirror of the batter xBA blend
        // above (baseAvg). Hit's pitcher-quality signal was previously only traditional
        // ERA (via computeProbablesAdj, shared with K/Walk/HR) — this is a dedicated,
        // localized addition scoped to Hit/Cold only, so it doesn't ripple into those
        // other categories. Modest cap since batter xBA already carries most of the
        // contact-quality signal; this adds the SP-specific suppression layer on top.
        const LG_XBA_ALLOWED = 0.240;
        const spXbaAllowed   = getSavantPitcherData()[sp.id]?.xbaAllowed;
        const xbaAllowedAdj  = spXbaAllowed != null
          ? Math.max(0.94, Math.min(1.06, 1 + (spXbaAllowed / LG_XBA_ALLOWED - 1) * 0.35))
          : 1.0;
        if (xbaAllowedAdj !== 1.0) avg = Math.max(0, Math.min(0.99, avg * xbaAllowedAdj));
        const _avgXbaAllowed = avg;            // after pitcher xBA-allowed

        // BABIP luck correction — high BABIP + soft contact = regression candidate; low BABIP + hard contact = unlucky
        // Weight increases when BABIP and hard hit rate move in opposite directions (clearer luck signal)
        if (s.babip != null && s.pa >= 100) {
          const babipDev    = s.babip - LG_BABIP;
          const hhDev       = savant.hardHitPct != null ? savant.hardHitPct - LG_HARD_HIT : null;
          const babipWeight = hhDev != null
            ? (babipDev * hhDev < 0 ? 0.40 : 0.12)
            : 0.25;
          const babipAdj    = Math.max(-0.025, Math.min(0.025, -babipDev * babipWeight));
          avg = Math.max(0, Math.min(0.99, avg + babipAdj));
        }
        const _avgPreArs = avg;
        avg = Math.max(0, Math.min(0.99, avg * ars.off)); // pitch-arsenal matchup

        // YoY regression — only penalize fallen-off players. Breakouts are NOT boosted:
        // their current stats already reflect the improvement, and boosting further
        // overreacts to what could be small-sample noise or a hot streak.
        const yoy = s.yoyTrend;
        let yoyHitMult = 1.0, yoyHrMult = 1.0;
        if (yoy && yoy.direction === 'regression') {
          const mag  = yoy.severity === 'severe' ? 0.04 : yoy.severity === 'significant' ? 0.025 : 0.012;
          yoyHitMult = Math.max(0.92, 1 - mag);
          yoyHrMult  = Math.max(0.85, 1 - mag * 1.5);
        }
        if (yoyHitMult !== 1.0) avg = Math.max(0, Math.min(0.99, avg * yoyHitMult));
        const yoyNote = yoy
          ? ' · YoY ' + (yoy.direction === 'regression' ? '↓' : '↑') + ' wOBA ' + yoy.wobaPrior + '→' + yoy.wobaCurr
          : '';

        // Sprint speed : a distinct, non-contact axis — fast runners beat out
        // infield hits and sustain higher BABIP regardless of contact quality. Modest avg
        // multiplier off league-avg ~27 ft/s.
        const sprintHitMult = (savant.sprintSpeed != null)
          ? Math.max(0.96, Math.min(1.05, 1 + (savant.sprintSpeed - 27) * 0.012))
          : 1.0;

        // Game-context multipliers on the hit rate: ballpark (balls in play), opposing
        // defense (OAA), times-through-the-order, and runner speed. Final per-PA step.
        const _avgPreCtx = avg;
        avg = Math.max(0, Math.min(0.99, avg * hitParkMult * defHitMult * ttoMult * sprintHitMult));

        // Context-aware expected PAs — scales with the batting team's run environment
        // and home/away. The exponent in prob = 1-(1-rate)^PA, so this matters as much
        // as the rate itself for "needs to happen" props.
        let paCtx = estimatedPAs(batterRow.batter.battingOrder, { teamRsPerG: teamRS, isHome });

        // Early-hook / platoon-pull risk — batting order alone assumes a full
        // game. A short-side platoon bat (real recent pattern: PA cut off well before the
        // order-implied count, e.g. pinch-hit for once the opposing bullpen turns to his
        // bad-handed reliever) needs a PA discount order-slot can't see. Data-driven from
        // the batter's OWN last-15-games PA realization (see getRecentBatterStats), not a
        // guess at tonight's specific bullpen matchup — asymmetric (only ever discounts,
        // never boosts) and dampened to 70% of the measured shortfall pending a full
        // backtest, same caution used for other new signals this session (whiff%, etc.).
        if (bRecent.paRealizationRatio != null && bRecent.paRealizationRatio < 1.0) {
          const hookMult = Math.max(0.75, 1 - (1 - bRecent.paRealizationRatio) * 0.7);
          paCtx = +(paCtx * hookMult).toFixed(3);
        }

        // Per-PA hit-rate factor decomposition (avg pipeline: BvP -> xBA -> adj -> bullpen
        // -> home/away -> hard-hit -> babip -> arsenal -> yoy -> park/def/tto). splitAvg is the pre-BvP base.
        const hitFactors = {
          base: +(splitAvg ?? 0).toFixed(5), rate: +avg.toFixed(5), pa: paCtx,
          bvp:      (splitAvg > 0 && bvpAb > 0) ? L(baseAvgRaw / splitAvg) : 0,
          xba:      (baseAvgRaw > 0) ? L(baseAvg / baseAvgRaw) : 0,
          adj:      L(_avgAdj / (baseAvg || _avgAdj)),
          bullpen:  L(_avgBp / _avgAdj),
          homeaway: L(_avgHa / _avgBp),
          hardhit:  L(_avgHh / _avgHa),
          pitcherXba: L(_avgXbaAllowed / _avgHh),
          babip:    L(_avgPreArs / _avgXbaAllowed),
          arsenal:  L(ars.off),
          yoy:      L(yoyHitMult),
          park:     L(hitParkMult),
          defense:  L(defHitMult),
          tto:      L(ttoMult),
          sprint:   L(sprintHitMult),
        };

        // Savant display notes — shown when adjustment is meaningful
        const hardHitNote = savant.hardHitPct != null && Math.abs(savant.hardHitPct - LG_HARD_HIT) >= 7
          ? ' · ' + savant.hardHitPct.toFixed(0) + '% hard contact' + (savant.hardHitPct > LG_HARD_HIT ? ' ↑' : ' ↓')
          : '';
        const babipNote = s.babip != null && s.pa >= 100 && (s.babip > 0.330 || s.babip < 0.270)
          ? ' · .' + String(Math.round(s.babip * 1000)).padStart(3, '0') + ' BABIP' + (s.babip > 0.330 ? '↑' : '↓')
          : '';
        const barrelNote = savant.barrelRate != null && (savant.barrelRate >= 10 || savant.barrelRate <= 4)
          ? ' · ' + savant.barrelRate.toFixed(1) + '% barrel rate' + (savant.barrelRate >= 10 ? ' ↑' : ' ↓')
          : '';
        // Bat speed note — flagged at the tails (league ~71.7 mph, sd ~2.7)
        const batSpeedNote = savant.batSpeed != null && (savant.batSpeed >= 75 || savant.batSpeed <= 68.5)
          ? ' · ' + savant.batSpeed.toFixed(1) + ' mph bat speed' + (savant.batSpeed >= 75 ? ' ↑' : ' ↓')
          : '';
        // New-factor display notes (shown only when meaningful).
        const defNote = oppOaa != null && Math.abs(oppOaa) >= 8
          ? ' · vs ' + (oppOaa > 0 ? 'elite' : 'poor') + ' defense (OAA ' + (oppOaa > 0 ? '+' : '') + oppOaa + ')'
          : '';
        const hitParkNote = Math.abs(hitParkMult - 1.0) >= 0.04
          ? ' · ' + (matchup.venueName || 'park') + ' hits ' + (hitParkMult >= 1 ? '+' : '') + Math.round((hitParkMult - 1) * 100) + '%'
          : '';
        const xbhParkNote = Math.abs(xbhParkMult - 1.0) >= 0.05
          ? ' · ' + (matchup.venueName || 'park') + ' XBH ' + (xbhParkMult >= 1 ? '+' : '') + Math.round((xbhParkMult - 1) * 100) + '%'
          : '';
        const xbaNote = savant.xba != null && baseAvgRaw > 0 && Math.abs(savant.xba - baseAvgRaw) >= 0.025
          ? ' · .' + String(Math.round(savant.xba * 1000)).padStart(3, '0') + ' xBA' + (savant.xba > baseAvgRaw ? ' ↑' : ' ↓')
          : '';
        const xbaAllowedNote = spXbaAllowed != null && Math.abs(xbaAllowedAdj - 1.0) >= 0.02
          ? ' · SP allows .' + String(Math.round(spXbaAllowed * 1000)).padStart(3, '0') + ' xBA'
          : '';
        const ttoNote = ttoMult >= 1.025 ? ' · ' + spIpPerStart.toFixed(1) + ' IP/start (TTO ↑)' : '';

        // Uses spSeasonEra (FIP + xERA blended above), not raw pSt.era — this is the
        // number validated to actually predict future performance; raw ERA
        // alone was the weak link feeding RBI/Runs/HR rate calculations before.
        const spEraFactor      = spSeasonEra > 0 ? Math.max(0.70, Math.min(1.30, spSeasonEra / 4.20))          : 1.0;
        const bpEraFactor      = bpComp?.era > 0  ? Math.max(0.70, Math.min(1.30, bpComp.era / 4.20))           : 1.0;
        const blendedEraFactor = spEraFactor * SP_WT + bpEraFactor * RP_WT;
        const spHrFactor       = (pSt.hrRate != null && pSt.bf >= 50) ? Math.max(0.70, Math.min(1.40, pSt.hrRate / LG_HR_PA)) : 1.0;
        const bpHrFactor       = bpComp?.hrRate != null               ? Math.max(0.70, Math.min(1.40, bpComp.hrRate / LG_HR_PA_BP)) : 1.0;
        const blendedHrFactor  = spHrFactor * SP_WT + bpHrFactor * RP_WT;
        const spBBFactor       = pSt.bf > 0         ? Math.max(0.50, Math.min(2.00, (pSt.bb / pSt.bf) / 0.082)) : 1.0;
        const bpBBFactor       = bpComp?.bbPct != null ? Math.max(0.50, Math.min(2.00, bpComp.bbPct / 0.082))   : 1.0;
        const blendedBBFactor  = spBBFactor * SP_WT + bpBBFactor * RP_WT;

        const bvpNote    = bvpAb >= 10 ? ` + ${bvpAb} AB vs pitcher`
                         : bvpAb  >  0 ? ` + ${bvpAb} AB vs pitcher (small sample)`
                         : '';
        const streakNote = bRecent.hitStreak    >= 7 ? ` · ${bRecent.hitStreak}-game hit streak`
                         : bRecent.hitlessStreak >= 3 ? ` · ${bRecent.hitlessStreak}g without a hit`
                         : '';
        const hookNote   = bRecent.paRealizationRatio != null && bRecent.paRealizationRatio < 0.85
                         ? ` · early-hook risk (${bRecent.avgPa15.toFixed(1)} PA/g last 15)`
                         : '';
        const sampleNote = (useSplit ? splitPa + ' PA split' : 'season avg') + bvpNote + streakNote + hookNote;
        const pa    = paCtx;
        const order = batterRow.batter.battingOrder;
        // Deliberately excludes 'predicted-leadoff' — a pre-lineup GUESS (see
        // lib/leadoffPredictor.js) must never be treated as a real posted lineup by
        // anything gated on lineupConfirmed (runsOver, actionablesLeadoff/2Hole, the
        // strong-pick threshold). isPredictedLeadoff below is its own, separate signal.
        const lineupConfirmed  = order >= 1 && order <= 9 && batterRow.batter.source !== 'predicted-leadoff';
        const isPredictedLeadoff = batterRow.batter.source === 'predicted-leadoff';
        const base = {
          batterId: batterRow.batter.id, batter: batterRow.batter.name, team: abbrev,
          sampleNote, pitcher: sp.name, pitcherId: sp.id, game, gamePk: matchup.gamePk, lineupConfirmed,
          spTier, spNegTier, bvpAb, bvpOps: bvp?.ops ?? 0,
          bvpHr: bvp?.hr || 0, bpHrFactor,
        };

        const splitAvgDisp   = splitAvg != null ? fmtObp(splitAvg) : fmtObp(avg);
        const bvpBlendSuffix = bvpAb > 0 && bvpAb < 10
          ? ' → ' + fmtObp(avg) + ' blended (' + bvpAb + ' AB vs SP)'
          : '';

        // AB/PA correction: avg is per-AB, not per-PA — walks are PAs with no hit opportunity.
        // hitPerPa = avg × (1 − BB%) gives the true per-PA hit rate used in probability formulas.
        const hitPerPa = avg * Math.max(0.70, Math.min(0.95, 1 - (s.bbPct || 0)));

        // Full-game matchup score: blends the batter-vs-STARTER pairing with the batter-
        // vs-BULLPEN pairing, weighted by each side's expected share of the batter's PAs
        // (SP_WT/RP_WT, from the starter's typical innings/9 — same split already used to
        // blend ERA/xSLG elsewhere). Previously this was SP-only, so a batter's whole-game
        // rating ignored how the game actually plays out once the starter exits — real
        // example that surfaced this gap: a batter retired cleanly by the SP but who then
        // mashed the opposing bullpen showed no sign of that in his "matchup score."
        // Bullpen side: true relievers only (gamesS<=2 excludes starters misclassified as
        // RP on days they aren't confirmed starting — see buildBullpenSide/bullpenProfile),
        // excluded if they pitched today, and down-weighted by the same days-rest/recent-
        // pitch-load availability tax used everywhere else in the bullpen system — so a
        // batter isn't rated against arms he's unlikely to actually face tonight.
        const spPairScoreOnly = spPair?.matchupScore ?? 0;
        let bullpenPairScore = null;
        if (batterRow.pitchers) {
          // Leverage-tiered, same shape as winPrediction.js's bullpenProfile: a batter
          // facing a deep-going starter mostly sees the good back-end arms if the pen gets
          // involved at all, while a short/opener-type start exposes the bad-script
          // (mop-up/Middle) tail much more. Previously every true reliever was averaged
          // flat, so a batter's rating didn't reflect that distinction at all — see
          // BAD_SCRIPT_WT (computeManagerTendency), which scales with the SP's expected IP.
          let levWSum = 0, levScoreSum = 0;
          let mopWSum = 0, mopScoreSum = 0;
          for (const pr of batterRow.pitchers) {
            if (pr.pitcher.role !== 'RP') continue;
            const rpSt = pitcherStatCache[pr.pitcher.id] || {};
            if ((rpSt.gamesS || 0) > 2) continue; // misclassified starter, not a true reliever
            const rest = rpAppearanceCache[pr.pitcher.id] || {};
            if (rest.daysRest === 0) continue; // pitched today — unavailable tonight
            let availW = 1.0;
            if      (rest.daysRest === 1 && (rest.g3 || 0) >= 2) availW = 0.70; // tired
            else if ((rest.pitches3 || 0) >= 40)                availW = 0.85; // heavy recent load
            const role = rpRoleFor(rpSt);
            const levW = RP_LEVERAGE_W[role] * availW;
            levWSum += levW;
            levScoreSum += pr.matchupScore * levW;
            if (role === 'Middle') {
              mopWSum += availW;
              mopScoreSum += pr.matchupScore * availW;
            }
          }
          const leveragePoolScore = levWSum > 0 ? levScoreSum / levWSum : null;
          const mopPoolScore      = mopWSum > 0 ? mopScoreSum / mopWSum : leveragePoolScore;
          if (leveragePoolScore != null)
            bullpenPairScore = leveragePoolScore * (1 - BAD_SCRIPT_WT) + mopPoolScore * BAD_SCRIPT_WT;
        }
        const spPairScore = bullpenPairScore != null
          ? +(spPairScoreOnly * SP_WT + bullpenPairScore * RP_WT).toFixed(2)
          : spPairScoreOnly;
        const spLabel      = spTierLabel || spNegTierLabel;
        const hitThreshold = spPairScore >= 8 ? 0.300
                           : spNegTier >= 2   ? 0.300
                           : spNegTier === 1  ? 0.310
                           : 0.320;
        const notColdStreak = (bRecent.hitlessStreak || 0) < 3;
        const hitStacks     = notColdStreak
          && (bvpAb >= 10 || (bRecent.hitStreak || 0) >= 3 || (bRecent.avg7 != null && bRecent.avg7 >= 0.350));
        const venueAvgNote = careerVs && careerVs.pa >= 25 && splitAvg != null && careerVs.avg >= splitAvg + 0.045
          ? ` · .${ String(Math.round(careerVs.avg * 1000)).padStart(3, '0') } in ${careerVs.ab} career AB at ${matchup.venueName || 'this park'}`
          : '';
        const hitProb   = 1 - Math.pow(1 - hitPerPa, pa);
        const hitStrong = spPairScore >= 6 && avg >= hitThreshold && hitStacks;
        if (avg != null && hitProb >= PROP_FLOORS.hit)
          hit.push({ ...base, prob: hitProb, strong: hitStrong, factors: hitFactors,
            stat: 'Bats ' + splitAvgDisp + ' vs ' + handLabel + bvpBlendSuffix + hardHitNote + xbaNote + xbaAllowedNote + babipNote + venueAvgNote + defNote + hitParkNote + ttoNote + yoyNote + (spNegTierLabel ? ' · vs ' + spNegTierLabel : '') });

        // P(2+ hits) — same per-PA binomial model as hitProb above (each PA an independent
        // Bernoulli(hitPerPa) trial, the same simplification already used for hitProb),
        // just P(X>=2) instead of P(X>=1): 1 - P(X=0) - P(X=1). Feeds the multi-hit squad
        // combo pool below (request) — a genuinely different question from
        // "any hit" (hitProb above), not a re-derivation of it.
        // Cap the effective per-PA rate for the multi-hit calc at .38 (grading
        // fix): the multiplier stack (split AVG × BvP × form × park × pitcher-xBA) can
        // compound to impossible inputs at the top of the pool — Otto Lopez's saved
        // P(2+ hits) of 0.734 on 7/10 implies a ~.46 per-PA hit rate; no hitter sustains
        // anywhere near that (league-best full-season AVG ≈ .33). The top-8 pool that day
        // went 2-for-31 while mid tiers all won — classic top-of-pool inflation. .38 still
        // leaves headroom above any real sustained rate, so it only clips the impossible.
        const mhRate = Math.min(0.38, hitPerPa);
        const _p0Hits = Math.pow(1 - mhRate, pa);
        const _p1Hits = pa * mhRate * Math.pow(1 - mhRate, pa - 1);
        const multiHitProb = Math.max(0, 1 - _p0Hits - _p1Hits);
        // Quality gate mirrors the runs combo (leadoffComboPool below): favorable matchup
        // required. ALSO requires a real (confirmed or predicted) order 1-4 (
        // request) — PA count drives multi-hit odds directly (PA_BY_ORDER: 4.7/4.5/4.3/
        // 4.1 for slots 1-4 vs 3.9 and dropping further below that), so slots 5+ or an
        // unresolved order aren't just lower-value, they're not really answerable pre-
        // lineup. Deliberately NOT adding an extra "elite-only" bar for order 4 beyond
        // that — multiHitProb already prices in the real PA gap via the `pa` term, so an
        // elite order-4 hitter naturally still ranks well without an artificial second
        // threshold on top of a formula that's already order-aware. Floor (0.20) is a
        // reasonable starting point from the per-PA math, not yet backtested against real
        // graded outcomes — this is a brand-new signal, same caveat as every other new
        // signal this session pending real accuracy data.
        if (avg != null && multiHitProb >= 0.20 && spPairScore >= 6 && order >= 1 && order <= 4) {
          hitsComboPool.push({
            ...base, prob: multiHitProb, lambda: mhRate * pa, factors: hitFactors,
            battingOrder: order,
            confirmed: lineupConfirmed,
            predictionConfidence: batterRow.batter.predictionConfidence || null,
            stat: 'P(2+ hits) ' + (multiHitProb*100).toFixed(0) + '% · Bats ' + splitAvgDisp + ' vs ' + handLabel,
          });
        }

        // Require ≥30 BF before trusting SP K% — small samples produce misleading rates
        const spKpctTrusted = pSt.kpct != null && (pSt.bf || 0) >= 30;
        const spAbsKPct  = spKpctTrusted ? parseFloat(pSt.kpct) / 100 : LG_SP_KPCT;
        const spKMult    = Math.max(0.70, Math.min(1.25, spAbsKPct / LG_SP_KPCT));
        // Blend SP and bullpen K rates by expected innings — bullpen faces 1-3 batters per game
        const bpKMult    = bpComp?.kPct != null
          ? Math.max(0.70, Math.min(1.25, bpComp.kPct / LG_SP_KPCT))
          : 1.0;
        const blendedKMult   = spKMult * SP_WT + bpKMult * RP_WT;
        const _kPreArs       = Math.min(0.32, (kPct || 0) * blendedKMult);
        // AUTO-OUT K BOOST — discrete contact-hole matchup. When the SP throws a pitch group the
        // batter genuinely can't handle (≥40% whiff & ≤.400 SLG) ≥25% of the time, K rate jumps
        // hard in both the 1+ and 2+ K bands. This is the
        // sharp discrete version of the diluted continuous whiff term (ars.k) above. Decent
        // weight, scaled by how heavily the SP leans on the hole; capped to stay bounded.
        const aoK = getAutoOutKMatchup(batterRow.batter.id, sp.id);
        let autoOutKMult = 1.0, autoOutKNote = '';
        if (aoK && aoK.matched) {
          autoOutKMult = Math.min(1.25, 1.10 + (aoK.usage - 0.25) * 0.7);
          const gname = { FB: 'fastballs', BRK: 'breaking', OFF: 'offspeed' }[aoK.group];
          const deepNote = spIpPerStart >= 5.0 ? ` · SP avg ${spIpPerStart.toFixed(1)} IP/start` : '';
          autoOutKNote = ` · 🎯 auto-out vs ${gname} (${(aoK.whiff * 100).toFixed(0)}% whiff) — SP throws ${(aoK.usage * 100).toFixed(0)}%${deepNote}`;
        }
        // When auto-out is matched, it IS the whiff signal (discrete, more precise than the
        // continuous ars.k term). Using both multiplies the same underlying data twice.
        // Neutralize ars.k when autoOutKMult fires so only one version of the signal applies.
        const aoMatched = !!(aoK && aoK.matched);
        const arsKFinal = aoMatched ? 1.0 : ars.k;

        // Z-CONTACT — measured on a large multi-season PA backtest (full-season
        // game logs joined to actual opposing starters): a batter's in-zone contact rate and
        // the pitcher's in-zone contact rate ALLOWED show a real, LARGE effect (15.9%-27.9%
        // K rate across the 4 quadrants — far bigger than the chase-rate interaction tested
        // alongside it, which did NOT hold up and was dropped). The pitcher's dominance ratio
        // was roughly CONSTANT across batter tiers (~1.18-1.19x either way), so this is modeled
        // as two independent multiplicative factors, not a cross term — matches how every
        // other factor in this file already combines. Distinct from ars.k (per-pitch-TYPE
        // whiff, arsenal-specific) — this is a season-aggregate, zone-based signal, low
        // redundancy risk with the existing arsenal term.
        const LG_Z_CONTACT         = 84.5;  // league-average Z-Contact%, from the backtest sample
        const LG_Z_CONTACT_ALLOWED = 84.7;
        const batterZContactMult = savant.zContactPct != null
          ? Math.max(0.85, Math.min(1.20, 1 + (LG_Z_CONTACT - savant.zContactPct) / LG_Z_CONTACT * 1.5))
          : 1.0;
        const spSavantK = getSavantPitcherData()[sp.id];
        const pitcherZDominanceMult = spSavantK?.zContactPctAllowed != null
          ? Math.max(0.90, Math.min(1.15, 1 + (LG_Z_CONTACT_ALLOWED - spSavantK.zContactPctAllowed) / LG_Z_CONTACT_ALLOWED * 1.2))
          : 1.0;

        const effectiveKRate = Math.min(0.34, _kPreArs * arsKFinal * autoOutKMult * batterZContactMult * pitcherZDominanceMult);
        // K-rate factor decomposition (kPct pipeline: BvP -> adj -> bullpen, then x
        // pitcher-staff K multiplier x arsenal). splitKPct is the pre-BvP base.
        const kFactors = {
          base: +(splitKPct ?? 0).toFixed(5), rate: +effectiveKRate.toFixed(5), pa,
          bvp:     (splitKPct > 0 && bvpAb > 0) ? L(baseKPct / splitKPct) : 0,
          adj:     L(_kAdj / (baseKPct || _kAdj)),
          bullpen: L(_kBp / _kAdj),
          pitcher: L(blendedKMult),
          arsenal: L(arsKFinal),   // neutralized when autoOut fires (same underlying whiff data)
          autoOut: L(autoOutKMult),
          zcontact: L(batterZContactMult), pitcherZ: L(pitcherZDominanceMult),
        };
        const spKNote    = spKpctTrusted ? ' · SP: ' + parseFloat(pSt.kpct).toFixed(1) + '% K rate' : '';
        const bpKNote    = bpComp?.kPct != null && Math.abs(bpComp.kPct - spAbsKPct) >= 0.05
          ? ' · pen: ' + (bpComp.kPct * 100).toFixed(1) + '%' : '';
        const zContactNote = savant.zContactPct != null && Math.abs(batterZContactMult - 1.0) >= 0.04
          ? ' · ' + savant.zContactPct.toFixed(0) + '% Z-Contact' + (batterZContactMult > 1 ? ' ↓' : ' ↑')
          : '';
        const pitcherZNote = spSavantK?.zContactPctAllowed != null && Math.abs(pitcherZDominanceMult - 1.0) >= 0.04
          ? ' · SP ' + spSavantK.zContactPctAllowed.toFixed(0) + '% Z-Contact allowed'
          : '';
        const venueKNote = careerVs && careerVs.pa >= 25 && splitKPct != null && careerVs.kRate >= splitKPct + 0.07
          ? ` · ${(careerVs.kRate * 100).toFixed(1)}% K rate at ${matchup.venueName || 'this park'} (${careerVs.pa} PA)`
          : '';
        if (effectiveKRate >= 0.28 || aoMatched) {
          const kProb  = 1 - Math.pow(1 - effectiveKRate, pa);
          // P(K>=2) via binomial: 1 - P(0) - P(1)
          const kTwoProb = 1 - Math.pow(1 - effectiveKRate, pa)
                             - pa * effectiveKRate * Math.pow(1 - effectiveKRate, pa - 1);
          k.push({ ...base, prob: kProb, kTwoProb: +kTwoProb.toFixed(4),
            factors: kFactors, strong: aoMatched, autoOut: aoMatched,
            aoWhiff: aoMatched ? aoK.whiff : null,
            spIpPerStart: +spIpPerStart.toFixed(1),
            battingOrder: order || null,
            stat: (kPct * 100).toFixed(1) + '% K rate vs ' + handLabel + spKNote + bpKNote + zContactNote + pitcherZNote + venueKNote + autoOutKNote + (spLabel ? ' · vs ' + spLabel : '') });
        } else if (splitKPct >= 0.26) {
          const kProb = 1 - Math.pow(1 - effectiveKRate, pa);
          k.push({ ...base, prob: kProb, factors: kFactors,
            stat: (splitKPct * 100).toFixed(1) + '% K rate vs ' + handLabel + ' (high-K profile)' + spKNote + bpKNote + venueKNote + autoOutKNote + (spLabel ? ' · vs ' + spLabel : '') });
        }
        const kUnderProb = Math.pow(1 - effectiveKRate, pa);
        if (kUnderProb >= 0.70)
          kUnder.push({ ...base, prob: kUnderProb, factors: negFactors(kFactors),
            stat: (kPct * 100).toFixed(1) + '% K rate vs ' + handLabel + spKNote + bpKNote + (spLabel ? ' · vs ' + spLabel : '') });

        // "Ice cold" pick area — batters whiffing in 45%+ of PAs over their last 7 games.
        // A pure recent-FORM filter (distinct from the matchup-based K category above); the
        // headline % shown is the recent K rate, with today's SP K matchup appended for context.
        if (bRecent.kPct7 != null && bRecent.kPct7 >= 0.45 && (bRecent.pa7 || 0) >= 10) {
          recentK.push({ ...base, prob: bRecent.kPct7,
            recentKPct: bRecent.kPct7, recentSo: bRecent.so7, recentPa: bRecent.pa7,
            // Model's per-GAME P(≥1 K) today — graded against the actual (did they K) so the
            // accuracy card compares like-for-like; the displayed `prob` stays the recent rate.
            kGameProb: 1 - Math.pow(1 - effectiveKRate, pa),
            stat: bRecent.so7 + ' K in ' + bRecent.pa7 + ' PA over last 7g (' + (bRecent.kPct7 * 100).toFixed(0) + '% K)' + spKNote + bpKNote + (spLabel ? ' · vs ' + spLabel : '') });
        }

        const hitlessProb = Math.pow(1 - hitPerPa, pa);
        if (hitlessProb >= HIT_UNDER_MIN && spPairScore <= 4)
          cold.push({ ...base, prob: hitlessProb, factors: negFactors(hitFactors),
            stat: 'Struggles vs ' + handLabel + ' — ' + splitAvgDisp + ' AVG · matchup score ' + spPairScore + '/10' + bvpBlendSuffix + yoyNote + (spLabel ? ' · vs ' + spLabel : '') });

        const hrRateSplit = useSplit ? (hand === 'L' ? s.hrRateVsL : s.hrRateVsR) : s.hrRateTotal;
        if (hrRateSplit != null) {
          // INPUT-ANCHOR (HR-derby-audit follow-through): the split HR rate
          // is the rarest-event outcome anchor in the app (~200 PA of HRs). Anchor it on
          // the barrel-implied expected HR rate — the Jordan Walker case, structurally:
          // elite inputs, modest outcome line, market (and previously this model) pricing
          // the outcomes. Regression fit 2026 cross-section :
          // expHR = 0.00619 + 0.00295·barrel% (R²=0.628 — barrel alone explains ~2/3 of
          // HR-rate variance). Counterfactual backtest over a month of graded days: this blend
          // improved both ranking lift and the share of real HR hitters captured in the top third
          // (best capture of the grid). ONE-ENTRY RULE: barrelStab moves into the anchor,
          // so the separate barrelAdj multiplier below is REMOVED (it was already flagged
          // as double-counting by the ablation and compressed — this resolves
          // it properly). barrelStab still modulates the inclusion FLOOR (a gate, not the
          // rate — no double entry). Anchor influence recorded in factors.anchor.
          const HR_SPLIT_KEEP = 0.40;
          const expHrRate = barrelStab != null ? Math.max(0.004, 0.00619 + 0.00295 * barrelStab) : null;
          const hrAnchored = expHrRate != null
            ? HR_SPLIT_KEEP * hrRateSplit + (1 - HR_SPLIT_KEEP) * expHrRate
            : hrRateSplit;
          const bvpHrRate = (bvp && bvpAb > 0) ? (bvp.hr || 0) / (bvp.pa || bvpAb) : null;
          const hrBlended = blendRate(bvpHrRate, hrAnchored, bvpHotHrW);
          let effectiveHrRate = hrBlended;
          effectiveHrRate *= parkFactor;
          effectiveHrRate *= blendedHrFactor;
          effectiveHrRate *= adj.hrMult;

          // Pitcher barrel%-allowed — (244-pitcher sample): correlates
          // with actual HR/9 allowed (r=0.685) AS STRONGLY as xSLG-allowed does (r=0.658),
          // and still shows real incremental correlation (r=0.249) against the HR/9 residual
          // AFTER removing xSLG-allowed's explanatory power — so it isn't redundant with
          // xSLG despite both being Statcast contact-quality metrics. blendedHrFactor above
          // is actual observed HR rate (backward-looking, subject to park/luck/sequencing);
          // this is a leading quality-of-contact check on top of it, same role hrRecentMult
          // plays below — a modest nudge, not a second full-weight HR-rate signal.
          const LG_BARREL_ALLOWED = 7.74;
          const spBarrelAllowed = getSavantPitcherData()[sp.id]?.barrelPctAllowed ?? null;
          const barrelAllowedMult = spBarrelAllowed != null
            ? Math.max(0.90, Math.min(1.15, 1 + (spBarrelAllowed / LG_BARREL_ALLOWED - 1) * 0.35))
            : 1.0;
          effectiveHrRate *= barrelAllowedMult;

          // Recent HR form down-weighted (ablation: −10/active for HR+) —
          // 14-game HR counts are noisy and the base split rate already trends; halve the
          // nudges so a hot/cold streak tilts rather than swings the rate.
          const recent = recentBatterCache[batterRow.batter.id] || { hr14: 0, g14: 0 };
          let hrRecentMult = 1.0;
          if (recent.g14 >= 10) {
            if      (recent.hr14 >= 5) hrRecentMult = 1.10;
            else if (recent.hr14 >= 3) hrRecentMult = 1.05;
            else if (recent.hr14 === 0) hrRecentMult = 0.90;
          }
          effectiveHrRate *= hrRecentMult;
          // Barrel multiplier REMOVED — barrel now enters ONCE, as the rate
          // anchor above (see input-anchor comment). The old separate multiplier here
          // would double-count it.
          // Career venue HR adjustment — max ±8%, requires 25+ career PA at this venue
          let hrVenueMult = 1.0;
          if (careerVs && careerVs.pa >= 25 && hrRateSplit > 0) {
            const vHrRatio = careerVs.hrRate / hrRateSplit;
            if      (vHrRatio >= 1.60) hrVenueMult = 1.08;
            else if (vHrRatio <= 0.35) hrVenueMult = 0.92;
          }
          effectiveHrRate *= hrVenueMult;
          effectiveHrRate *= ars.off;
          effectiveHrRate *= yoyHrMult;
          effectiveHrRate *= ttoMult;   // later looks at the SP → more HR

          // Hand-specific effective wind — computed here (before HR/FB) so all downstream
          // wind-sensitive calcs (windBoost, weatherHrMult, hrpLive, weatherWarn) share one value.
          // Pull hitters' HRs go to their pull side (~45° from CF), not straight to CF.
          // LHB pulling to RF benefits from crosswind toward RF (negative cross per our convention).
          // Dead CF wind (cross=0) helps ALL batters equally.
          const liveOut   = matchup.weatherLive?.outWindMph   ?? 0;
          const liveCross = matchup.weatherLive?.crossWindMph ?? 0;
          const handSign  = (batterRow.batter.hand || 'R') === 'L' ? -1 : 1;
          const pullSideWind = liveOut * 0.707 + liveCross * 0.707 * handSign;
          // Real 3-way spray model : an oppo-heavy hitter's wind exposure is
          // NOT just "less pull" — it's a genuinely different direction (mirrored across
          // the CF axis), so oppoSideWind flips the cross term rather than shrinking it.
          // Real-world confirmation: J.D. Martinez lost 10 HRs to wind across SIX different
          // parks in 2023-24 (MLB Statcast/Weather Applied Metrics) — attributed to his
          // oppo-heavy approach, not any one home park, which a park-only fix can't catch.
          const oppoSideWind = liveOut * 0.707 - liveCross * 0.707 * handSign;
          let effectiveLiveWind;
          if (savant.pullPct != null && savant.straightPct != null && savant.oppoPct != null) {
            const total = savant.pullPct + savant.straightPct + savant.oppoPct;
            const wPull = savant.pullPct / total, wStraight = savant.straightPct / total, wOppo = savant.oppoPct / total;
            effectiveLiveWind = liveOut * wStraight + pullSideWind * wPull + oppoSideWind * wOppo;
          } else {
            // Fallback when the spray split isn't available for this batter (e.g. under the
            // Savant min-PA floor): old 2-way pull-vs-CF interpolation. pullW: how much to
            // weight pull-side vs CF direction (0 at avg pull, 1 at 55%+ pull).
            const pullW = savant.pullPct != null ? Math.min(1.0, Math.max(0, (savant.pullPct - 35) / 20)) : 0;
            effectiveLiveWind = liveOut * (1 - pullW) + pullSideWind * pullW;
          }

          // HR/FB rate : the most direct power-in-the-air signal. Computed from
          // existing data — no new fetch: s.hrRateTotal (HR/PA) / (contactRate × fbPct).
          // contactRate = fraction of PA that become batted balls (not K or BB).
          // LG avg HR/FB ≈ 13.7% (LG_HR_PA 0.034 / (0.69 contact × 0.36 FB) ≈ 0.137).
          // Separates: pull-heavy grounder hitter (high pull, low HR/FB → penalty),
          // oppo power hitter (moderate pull, high HR/FB → reward),
          // spray contact hitter (high FB, low HR/FB → correctly flat/negative).
          // Replaces the pull×FB proxy — pullPct still used in parkHandMult below.
          const LG_HR_FB = 0.137;
          const contactRateHr = Math.max(0.10, 1 - (s.kPct || 0) - (s.bbPct || 0));
          const hrFbRate = (savant.fbPct != null && savant.fbPct > 5 && s.hrRateTotal != null)
            ? s.hrRateTotal / (contactRateHr * savant.fbPct / 100)
            : null;
          // HR/FB sensitivity scales with out-wind: in strong wind blowing out, a high-HR/FB
          // batter is far more dangerous (well-struck fly balls that die at the warning track
          // in calm air now clear). The wind amplifies the gap between true power and contact
          // batters. SD@CHC 6/30: 19 mph out, 92°F, 7 HRs — the discriminating factor was
          // who could genuinely square up fly balls, not just put them in the air.
          // outWindMph is already on matchup.weatherLive (from getGameWeather in weather.js).
          const outWind = matchup.weatherLive?.outWindMph ?? 0;
          // windBoost: 0 at calm → 1.0 at 20+ mph out. Only positive wind counts.
          // Use hand-specific effective wind for the HR/FB sensitivity scaling.
          // This means Schwarber (LHB) gets less boost from pure CF-out wind than a spray
          // hitter, and even less (or negative) from wind blowing out to LF.
          const windBoost     = effectiveLiveWind > 0 ? Math.min(1.0, effectiveLiveWind / 20) : 0;
          const hrFbSens      = 0.35 + windBoost * 0.30;
          const hrFbCap       = 1.07 + windBoost * 0.10;
          const pullHrMult = hrFbRate != null
            ? Math.max(0.90, Math.min(hrFbCap, 1 + (hrFbRate - LG_HR_FB) / LG_HR_FB * hrFbSens))
            : (savant.pullPct != null
              ? Math.max(0.93, Math.min(1.05 + windBoost * 0.05, 1 + (savant.pullPct - 40) / 100 * 0.4))
              : 1.0);
          effectiveHrRate *= pullHrMult;

          // Live weather: temp + wind HR multiplier, adjusted for batter hand.
          // Re-derive using effectiveLiveWind (hand-specific pull direction) so a
          // LHB pull hitter (Schwarber) gets less boost from pure CF-out wind, and
          // a crosswind toward LF correctly reduces his HR rate.
          const wlHr = matchup.weatherLive;
          let weatherHrMult = wlHr?.hrMult ?? 1.0;
          if (wlHr && wlHr.tempF != null && effectiveLiveWind !== (wlHr.outWindMph ?? 0)) {
            weatherHrMult = weatherHrMultFn(wlHr.tempF, effectiveLiveWind, wlHr.windSensitivity ?? 1.0);
          }
          effectiveHrRate *= weatherHrMult;

          // Handedness-specific park (short-porch asymmetry), modulated by the batter's
          // pull% — a pull hitter gets more of his pull-side porch; a spray hitter still
          // gets a share. Default neutral when the park/pull data is absent.
          let parkHandMult = 1.0;
          const phf = PARK_HAND_HR[venueKey];
          if (phf) {
            const hf   = (batterRow.batter.hand === 'L') ? phf.L : phf.R;
            const pull = savant.pullPct;
            const pullW = pull != null ? Math.max(0.6, Math.min(1.4, pull / 40)) : 1.0;
            parkHandMult = 1 + (hf - 1) * pullW;
          }
          effectiveHrRate *= parkHandMult;

          // CRUSH HR MATCHUP — the SP throws a pitch group this hitter CRUSHES (group SLG≥.500)
          // ≥25% of the time. A clear HR lift (the 3-group level won the granularity bake-off
          // vs 5-shape and pitch-type). Boost scaled by how heavily the SP leans on the crush
          // group; conservative + capped (the model already has the hitter's power and SP HR/9).
          const crushHr      = getCrushHrMatchup(batterRow.batter.id, sp.id);
          const crushMatched = !!(crushHr && crushHr.matched);
          const crushHrMult  = crushMatched ? Math.min(1.20, 1.08 + (crushHr.usage - 0.25) * 0.6) : 1.0;
          effectiveHrRate *= crushHrMult;

          effectiveHrRate = Math.min(0.09, Math.max(0, effectiveHrRate));

          const hrFactors = {
            base: +hrRateSplit.toFixed(5), rate: +effectiveHrRate.toFixed(5), pa,
            bvp:     (hrRateSplit > 0 && bvpAb > 0) ? L(hrBlended / hrRateSplit) : 0,
            park:    L(parkFactor), pitcher: L(blendedHrFactor), adj: L(adj.hrMult),
            recent:  L(hrRecentMult), anchor: (hrRateSplit > 0 ? L(hrAnchored / hrRateSplit) : 0), venue: L(hrVenueMult),
            arsenal: L(ars.off), yoy: L(yoyHrMult), tto: L(ttoMult),
            weather: L(weatherHrMult), parkhand: L(parkHandMult), pull: L(pullHrMult),
            crush: L(crushHrMult), barrelAllowed: L(barrelAllowedMult),
          };

          const hrProb     = 1 - Math.pow(1 - effectiveHrRate, pa);
          slateHrSum += hrProb;   // accumulate every batter's HR prob for the slate anchor
          const parkNote   = Math.abs(parkFactor - 1.0) >= 0.05
            ? ' · ' + (matchup.venueName || 'park') + ' (' + (parkFactor >= 1 ? '+' : '') + Math.round((parkFactor - 1) * 100) + '%)'
            : '';
          // Weather notes from the LIVE forecast (Open-Meteo), not the empty MLB feed.
          const wl = matchup.weatherLive;
          const weatherNote = wl && wl.outWindMph != null && Math.abs(wl.outWindMph) >= 4
            ? ' · ' + (wl.windLabel || (Math.abs(Math.round(wl.outWindMph)) + ' mph ' + (wl.outWindMph > 0 ? 'out' : 'in'))) + (wl.outWindMph > 0 ? ' ↑' : ' ↓')
            : '';
          const tempNote      = wl && wl.tempF != null && Math.abs(wl.tempF - 72) >= 8
            ? ' · ' + Math.round(wl.tempF) + '°F' + (wl.tempF >= 80 ? ' ↑' : wl.tempF <= 60 ? ' ↓' : '')
            : '';
          const pullNote      = hrFbRate != null && hrFbRate >= 0.18
            ? ' · ' + (hrFbRate * 100).toFixed(0) + '% HR/FB ↑'
            : (savant.pullPct != null && savant.pullPct >= 46 && (savant.fbPct == null || savant.fbPct >= 34)
              ? ' · ' + savant.pullPct.toFixed(0) + '% pull ↑'
              : '');
          const parkHandNote  = Math.abs(parkHandMult - 1.0) >= 0.05
            ? ' · ' + (matchup.venueName || 'park') + ' ' + (batterRow.batter.hand === 'L' ? 'LHB' : 'RHB') + ' ' + (parkHandMult >= 1 ? '+' : '') + Math.round((parkHandMult - 1) * 100) + '%'
            : '';
          const venueHrNote   = careerVs && careerVs.pa >= 20 && careerVs.hr >= 2
            ? ` · ${careerVs.hr} HR in ${careerVs.pa} career PA at ${matchup.venueName || 'this park'}`
            : '';
          // Headline "why it's here" — the single strongest reason this candidate made the
          // list, drawn from the updated factor set, so the justification leads with the
          // driver (esp. the barrel-anchored inclusion that admits elite power at lower proj).
          const hrWhy =
              (barrelStab != null && barrelStab >= 12)     ? 'ELITE BARREL ' + barrelStab.toFixed(0) + '% — '
            : (recent.g14 >= 10 && recent.hr14 >= 3)        ? 'HOT POWER (' + recent.hr14 + ' HR/' + recent.g14 + 'g) — '
            : (bvp && (bvp.hr || 0) >= 2 && bvpAb >= 8)     ? 'OWNS THIS SP (' + bvp.hr + ' HR) — '
            : crushMatched                                  ? 'CRUSHES SP’S PITCH — '
            : (parkHandMult >= 1.06)                        ? 'PULL-SIDE PARK — '
            : (weatherHrMult >= 1.08)                       ? 'WIND/HEAT AIDING — '
            : (parkFactor >= 1.08)                          ? 'HR PARK — '
            : (hrProb >= 0.25)                              ? 'STRONG PROJECTION — '
            : (barrelStab != null && barrelStab >= 10)      ? 'POWER THREAT ' + barrelStab.toFixed(0) + '% barrel — '
            : '';
          const crushNote  = crushMatched
            ? ' · 🎯 crushes ' + ({ FB: 'fastballs', BRK: 'breaking', OFF: 'offspeed' }[crushHr.group])
              + ' (.' + String(Math.round(crushHr.slg * 1000)).padStart(3, '0') + ' SLG) — SP throws ' + Math.round(crushHr.usage * 100) + '%'
            : '';
          const barrelAllowedNote = spBarrelAllowed != null && Math.abs(barrelAllowedMult - 1.0) >= 0.04
            ? ' · SP allows ' + spBarrelAllowed.toFixed(1) + '% barrel rate' + (barrelAllowedMult > 1 ? ' ↑' : ' ↓')
            : '';
          // Swing-change leading indicator (from the HR-derby-video audit):
          // when a batter's swing MECHANICS point meaningfully more pull-side than his
          // OUTCOME spray shows, the outcomes tend to follow — attack direction moves
          // weeks before spray/HR results do (the Willson Contreras 2026 pattern).
          // Validated league-wide: prior-season divergence predicts the next season's pull change;
          // top-decile divergers gained +3.6pts pull% vs +0.2 for the rest. Display badge
          // ONLY — no multiplier until it earns one from graded results. z-anchors are
          // dated empirical constants (2026 season, min 100 PA): attackDir mean
          // -2.24 sd 4.43 (negative = pull side), pull% mean 39.88 sd 6.99 — refresh if
          // league bat-tracking norms drift.
          let swingChangeNote = '';
          if (savant.attackDirection != null && savant.pullPct != null) {
            const zMech = (-savant.attackDirection - 2.24) / 4.43;   // pull-ness of the swing itself
            const zOut  = (savant.pullPct - 39.88) / 6.99;           // pull-ness of realized spray
            if (zMech - zOut >= 1.0) {
              swingChangeNote = ' · ⚡ swing points pull-side ahead of results — pull breakout risk';
            }
          }
          const hrStat     = hrWhy + (hrRateSplit * 100).toFixed(1) + '% HR/PA vs ' + handLabel
            + barrelNote + pullNote + batSpeedNote + parkNote + parkHandNote + weatherNote + tempNote + venueHrNote + crushNote + ttoNote + yoyNote
            + barrelAllowedNote + swingChangeNote
            + (pSt.hr9 != null && pSt.bf >= 50 ? ' · SP allows ' + parseFloat(pSt.hr9).toFixed(2) + ' HR/9' : '');
          const hrSampleNote = (useSplit ? splitPa + ' PA split' : 'season avg')
            + (bvpAb >= 10 ? ` + ${bvpAb} AB vs pitcher` : '')
            + (recent.g14 >= 10 ? ` · ${recent.hr14} HR last ${recent.g14}g` : '');
          const hrBase = { ...base, stat: hrStat, sampleNote: hrSampleNote };

          // Strong (confident) HR play: a good matchup with a real power signal.
          const hrpStacks = spPairScore >= 5
            && (parkFactor >= 1.05 || (recent.g14 >= 10 && recent.hr14 >= 2) || hrRateSplit >= 0.030
                || (bvp && (bvp.hr || 0) >= 2 && (bvp.pa || 0) >= 10)
                || (careerVs && careerVs.hr >= 2 && careerVs.pa >= 20));
          const hrStrongGate = (bvp && (bvp.hr || 0) >= 2 && bvpAb >= 8) ? 0.18 : 0.25;
          // Crush matchup is itself a confidence stack (clear measured lift); let it qualify as strong.
          const hrStrong = (hrProb >= hrStrongGate && hrpStacks) || (crushMatched && hrProb >= 0.18);
          // Barrel-anchored inclusion floor . A 2-day case-control showed
          // barrel separates HR hitters (+2-3pts) yet we were missing ~55% of actual HR
          // hitters — power bats on cold streaks / tough splits whose split-HR-rate prob
          // fell below the flat 0.15 floor. So MODULATE the floor by (bat-speed-stabilized)
          // barrel: lower the bar for genuine power, raise it for low-barrel filler. Keeps
          // pool size ~stable while lifting coverage of the power-driven HRs we were missing.
          let hrpFloor = PROP_FLOORS.hrp;                                  // 0.15 default
          if (barrelStab != null) {
            if      (barrelStab >= 10 && parkFactor >= 0.95) hrpFloor = 0.10; // real power, fair park
            else if (barrelStab <  6)                        hrpFloor = 0.20; // low power → higher bar
          }
          if (crushMatched && hrpFloor > 0.12) hrpFloor = 0.12;             // surface validated crush matchups

          if (hrProb >= hrpFloor) hrp.push({ ...hrBase, prob: hrProb, strong: hrStrong, factors: hrFactors,
            weatherWarn: effectiveLiveWind < -8 ? 'wind-in' : null,  // hand-specific: unfavorable for this batter's pull direction
          });

          // hrpLive: additive weather-surfaced candidates ONLY — batters who did NOT qualify
          // for hrp but DO qualify now because of favorable live weather (wind blowing out).
          // Not a repeat of hrp — genuinely new. Graded for track-record visibility
          // via lib/accuracy.js's accumulateHrpLive, which unions fresh candidates into
          // today's frozen file every 20 min since wind sharpens toward first pitch — but
          // never feeds a correction factor (see GRADED_EXTRA_CATS). Separate from existing
          // hrp entries: those get a weatherWarn flag when conditions worsen instead.
          const weatherCtx = {
            outWindMph: liveOut,
            windDesc:   matchup.weatherLive?.windDesc ?? null,
            windLabel:  matchup.weatherLive?.windLabel ?? null,
            tempF:      matchup.weatherLive?.tempF ?? null,
            roof:       matchup.weatherLive?.roof ?? null,
          };
          if (effectiveLiveWind >= 8 && hrProb < hrpFloor) {
            // Effective wind (hand-specific) has brought this batter into range.
            const liveFloor = Math.max(0.08, hrpFloor - 0.05);
            if (hrProb >= liveFloor) {
              hrpLive.push({ ...hrBase, prob: hrProb, strong: false, factors: hrFactors,
                weatherCtx, weatherAdded: true });
            }
          }

          if (hrProb <= 0.09 && hrRateSplit >= 0.030) hrm.push({ ...hrBase, prob: 1 - hrProb, factors: negFactors(hrFactors) });
        }

        // VS TEAM career HR history — notable if ≥20G, ≥3 HR, ≥0.10 HR/G, and matchup score ≥5
        if (spPairScore >= 5 && opposingTeamId) {
          const vtKey = `${batterRow.batter.id}-t${opposingTeamId}`;
          const vt = vsTeamCache[vtKey];
          if (vt && vt.g >= 20 && vt.hr >= 3 && vt.hr / vt.g >= 0.10) {
            vsTeamHr.push({
              batterId: batterRow.batter.id, batter: batterRow.batter.name,
              team: abbrev, game, gamePk: matchup.gamePk,
              matchupScore: spPairScore,
              vsTeamG:  vt.g,
              vsTeamHr: vt.hr,
              hrPerGame: vt.hr / vt.g,
              opposingTeamAbbrev,
              pitcher: sp.name,
            });
          }
        }

        // VS TEAM career "historically owns this team" — deliberately raw, no model
        // opinion. Just real career AVG/OPS against the opposing team, at a real sample
        // size, with no matchup-quality gate (spPairScore, tonight's specific pitcher,
        // etc. don't matter here) — the whole point is surfacing a guy who's simply been
        // extremely productive against this franchise for reasons no model captures.
        if (opposingTeamId) {
          const vtKey2 = `${batterRow.batter.id}-t${opposingTeamId}`;
          const vt2 = vsTeamCache[vtKey2];
          if (vt2 && vt2.ab >= 20 && vt2.avg != null && vt2.ops != null && (vt2.avg >= 0.300 || vt2.ops >= 0.850)) {
            vsTeamCareer.push({
              batterId: batterRow.batter.id, batter: batterRow.batter.name,
              team: abbrev, game, gamePk: matchup.gamePk,
              opposingTeamAbbrev, pitcher: sp.name,
              vsTeamG: vt2.g, vsTeamAb: vt2.ab, vsTeamH: vt2.h, vsTeamHrCount: vt2.hr,
              vsTeamRbi: vt2.rbi, vsTeamAvg: vt2.avg, vsTeamOps: vt2.ops,
            });
          }
        }

        const splitXbhRate   = useSplit ? (hand === 'L' ? s.xbhRateVsL : s.xbhRateVsR) : s.xbhRate;
        // INPUT-ANCHOR REBUILD : the season split XBH rate is a rare-event
        // OUTCOME (~200 PA of doubles/triples/HR) and was proven ANTI-predictive as the
        // ranking anchor — the factor-dominance scan had base at -7.7pts lift while
        // hardhit alone carried +9.3, and the category's overall ranking was INVERTED
        // (-1.0). Anchor the rate on the hardhit-implied expected XBH rate instead,
        // keeping only 20% of the split: counterfactual backtest on 30 graded days
        // flipped the ranking from -1.0 to +10.1pts lift (best in the app). Regression
        // fit 2026 cross-section : expXBH = 0.02264 + 0.00133·hardhit%
        // (R²=0.256) — refresh constants if league contact norms drift. ONE-ENTRY RULE:
        // hardhit/barrel/xwOBA-luck now live in the anchor, so their old multipliers are
        // REMOVED (they'd double-count — the same ablation lesson, resolved
        // the opposite way: instead of compressing the multipliers, the input became the
        // base). The anchor influence is recorded in factors.anchor for the audit trail.
        const expXbhRate = savant.hardHitPct != null
          ? Math.max(0.01, 0.02264 + 0.00133 * savant.hardHitPct)
          : null;
        const XBH_SPLIT_KEEP = 0.20;
        const xbhAnchored = splitXbhRate != null
          ? (expXbhRate != null ? XBH_SPLIT_KEEP * splitXbhRate + (1 - XBH_SPLIT_KEEP) * expXbhRate : splitXbhRate)
          : null;
        const bvpXbhRateRaw  = (bvp && bvp.pa > 0)
          ? ((bvp.doubles || 0) + (bvp.triples || 0) + (bvp.hr || 0)) / bvp.pa : null;
        const xbhBvpBlend    = xbhAnchored != null ? blendRate(bvpXbhRateRaw, xbhAnchored, bvpHotOpsW) : null;
        let effectiveXbhRate = xbhAnchored != null
          ? Math.max(0, Math.min(0.50, xbhBvpBlend * blendedEraFactor))
          : null;
        let xbhFactors = null;
        if (effectiveXbhRate != null) {
          const _xbhPreCtx = Math.max(0, Math.min(0.50, effectiveXbhRate * ars.off));
          // Blended SP+BP xSLG-allowed — slugging permitted by the full pitching staff.
          // Adds ranking signal for 2+TB beyond ERA (SP-only). Now extended to
          // the bullpen using the same weighted-average approach as bpComp.era/hrRate.
          // SP carries SP_WT weight (expected innings), BP carries RP_WT; falls back to
          // SP-only when bpComp.xslg is unavailable (BP data below min threshold).
          const spXslgAllowed     = getSavantPitcherData()[sp.id]?.xslg;
          const bpXslgAllowed     = bpComp?.xslg ?? null;
          const blendedXslg       = spXslgAllowed != null && bpXslgAllowed != null
            ? spXslgAllowed * SP_WT + bpXslgAllowed * RP_WT
            : (spXslgAllowed ?? bpXslgAllowed ?? null);
          const xbhSpSlugFactor   = blendedXslg != null
            ? Math.max(0.88, Math.min(1.15, 1 + (blendedXslg / 0.390 - 1) * 0.5))
            : 1.0;
          // Game context: XBH park (gap dimensions), opposing defense (robs doubles), TTO.
          effectiveXbhRate = Math.max(0, Math.min(0.50, _xbhPreCtx * xbhParkMult * defXbhMult * ttoMult * xbhSpSlugFactor));
          xbhFactors = {
            base: +(splitXbhRate ?? 0).toFixed(5), rate: +effectiveXbhRate.toFixed(5), pa,
            anchor:  (splitXbhRate > 0 && xbhAnchored != null) ? L(xbhAnchored / splitXbhRate) : 0,
            bvp:     (xbhAnchored > 0 && bvp && bvp.pa > 0) ? L(xbhBvpBlend / xbhAnchored) : 0,
            pitcher: L(blendedEraFactor), arsenal: L(ars.off), spSlug: L(xbhSpSlugFactor),
            park: L(xbhParkMult), defense: L(defXbhMult), tto: L(ttoMult),
          };
        }

        if (effectiveXbhRate != null && splitXbhRate > 0) {
          const tbProb = 1 - Math.pow(1 - effectiveXbhRate, pa);
          if (tbProb >= PROP_FLOORS.tb) tb.push({ ...base, prob: tbProb, strong: tbProb >= 0.55 && spPairScore >= 6, factors: xbhFactors,
            stat: (splitXbhRate * 100).toFixed(1) + '% XBH rate vs ' + handLabel + hardHitNote + barrelNote + defNote + xbhParkNote + yoyNote });
        }

        const splitSinglesRate = useSplit ? (hand === 'L' ? s.singlesRateVsL : s.singlesRateVsR) : s.singlesRate;
        if (effectiveXbhRate != null && splitSinglesRate != null) {
          const bvpSinglesRate = (bvp && bvp.pa > 0)
            ? Math.max(0, ((bvp.h || 0) - (bvp.doubles || 0) - (bvp.triples || 0) - (bvp.hr || 0))) / bvp.pa : null;
          const adjSinglesRate = Math.max(0, blendRate(bvpSinglesRate, splitSinglesRate) + adj.avgAdj * 0.40);
          const hitRatePA      = Math.min(0.99, effectiveXbhRate + adjSinglesRate);
          const noHitPA        = Math.max(0, 1 - hitRatePA);
          const p0   = Math.pow(noHitPA, pa);
          const p1   = pa * adjSinglesRate * Math.pow(noHitPA, pa - 1);
          const tb2Prob = Math.max(0, 1 - p0 - p1);
          if (tb2Prob >= PROP_FLOORS.tb2) tb2.push({ ...base, prob: tb2Prob, strong: tb2Prob >= 0.57 && spPairScore >= 6, factors: xbhFactors,
            stat: (splitXbhRate * 100).toFixed(1) + '% XBH rate vs ' + handLabel
              + ' · ' + ((splitSinglesRate + splitXbhRate) * 100).toFixed(1) + '% overall hit rate'
              + hardHitNote + barrelNote });
        }

        const splitBBPct = useSplit ? (hand === 'L' ? s.bbPctVsL : s.bbPctVsR) : s.bbPct;
        if (splitBBPct != null && splitBBPct > 0) {
          const bvpBBRate = (bvp && bvp.pa > 0) ? bvp.bb / bvp.pa : null;
          const bbBvpBlend = blendRate(bvpBBRate, splitBBPct);
          // Batter chase rate (large multi-season PA backtest): low-chase batters walk far
          // more than high-chase batters at every pitcher command level, and the gap WIDENS
          // facing a wild pitcher — but the pitcher-side RATIO is close enough to constant
          // that this is modeled as an independent
          // multiplicative factor alongside blendedBBFactor (the existing pitcher-wildness
          // signal), not a cross term — same approach as the Z-Contact K-model addition.
          const LG_CHASE_RATE = 29.8;
          const batterChaseWalkMult = savant.chaseRate != null
            ? Math.max(0.85, Math.min(1.25, 1 + (LG_CHASE_RATE - savant.chaseRate) / LG_CHASE_RATE * 1.3))
            : 1.0;

          // ---- Pitch-around factor. Pitchers work around a dangerous hitter when the base-out
          // state makes challenging him expensive, which shows up as walks. The modeling problem
          // is DOUBLE-COUNTING: a batter's season BB% already contains his average exposure to
          // those spots, so a naive "power hitter -> more walks" boost counts the same effect
          // twice and breaks walk calibration.
          //
          // The fix is to make the term MEAN-NEUTRAL and let it capture only the deviation from
          // a batter's normal context. It's a cross term of (batter danger vs league) x (on-base
          // threat hitting in front of him TONIGHT vs league), both centered at zero — so a
          // league-average bat in a league-average lineup slot multiplies by ~1.0 and the season
          // BB% carries the entire baseline. It fires only when a dangerous hitter ALSO has
          // table-setters in front of him, which is the situation that actually generates the
          // base-out states in question.
          //
          // Predictions freeze pre-game, so this can only use pre-game-knowable proxies — the
          // shape of tonight's lineup, never the live base-out state. `pitchAroundPressure` is
          // logged raw on each entry so the factor-ablation script can measure whether it adds
          // anything beyond season BB%; the weight and clamp below are placeholders (see the
          // PLACEHOLDER note at the top of this file).
          const LG_XSLG = 0.400;
          const dangerZ = savant.xslg != null
            ? Math.max(-0.5, Math.min(0.8, (savant.xslg - LG_XSLG) / LG_XSLG)) : 0;
          let frontContextZ = 0;
          if (order >= 1 && order <= 9) {
            const s1 = ((order - 2 + 9) % 9) + 1; // one slot in front (wraps 1 -> 9)
            const s2 = ((order - 3 + 9) % 9) + 1; // two slots in front
            const fronts = [orderObpMap[s1], orderObpMap[s2]].filter(v => v != null);
            if (fronts.length) {
              const frontObp = fronts.reduce((a, b) => a + b, 0) / fronts.length;
              frontContextZ = Math.max(-0.6, Math.min(0.6, (frontObp - LG_OBP) / LG_OBP));
            }
          }
          const pitchAroundPressure = dangerZ * frontContextZ;      // cross term — power AND setup
          const PA_SENS = 0.6;
          const pitchAroundMult = Math.max(0.96, Math.min(1.08, 1 + PA_SENS * pitchAroundPressure));

          let blendedBB = Math.max(0, Math.min(0.35, bbBvpBlend * blendedBBFactor * batterChaseWalkMult * pitchAroundMult));
          const walkProb    = 1 - Math.pow(1 - blendedBB, pa);
          const bbUnderProb = 1 - walkProb;
          const bbFactors = {
            base: +splitBBPct.toFixed(5), rate: +blendedBB.toFixed(5), pa,
            bvp:     (splitBBPct > 0 && bvp && bvp.pa > 0) ? L(bbBvpBlend / splitBBPct) : 0,
            pitcher: L(blendedBBFactor), chase: L(batterChaseWalkMult), pitchAround: L(pitchAroundMult),
          };
          const chaseWalkNote = savant.chaseRate != null && Math.abs(batterChaseWalkMult - 1.0) >= 0.04
            ? ' · ' + savant.chaseRate.toFixed(0) + '% chase rate' + (batterChaseWalkMult > 1 ? ' ↓' : ' ↑')
            : '';
          const bbBase = (splitBBPct * 100).toFixed(1) + '% walk rate vs ' + handLabel + chaseWalkNote
            + (pSt.bf > 0 ? ' · SP: ' + (pSt.bb / pSt.bf * 100).toFixed(1) + '% BB rate' : '')
            + (bpComp?.bbPct != null ? ' · bullpen: ' + (bpComp.bbPct * 100).toFixed(1) + '% BB rate' : '');
          const walkStat    = 'Patient hitter — ' + bbBase;
          const bbUnderStat = bbBase + ' — low walk profile' + (spLabel ? ' · vs ' + spLabel : '');
          // Component-threshold gate (user-driven): the walk list previously
          // included anyone whose MULTIPLIED prob cleared the floor — but a 30-day re-rank
          // of graded picks showed each component alone carries signal (base +1.7, SP
          // wildness +2.6, chase +4.9 pts top-vs-bottom-third) while their PRODUCT is flat
          // to negative (-1.7) — multiplying noisy factors manufactures false spread (the
          // Q3 pathology in the quintile audit: pred 52.5% realized 33.1%). Requiring the
          // two core components to be INDIVIDUALLY strong — a genuinely patient hitter
          // (hand-split BB% >= .12) facing a genuinely wild staff (factor >= 1.10) — kept
          // picks realized meaningfully better than the excluded set. The margin was around
          // 1.6 sigma over a month, so treat it as suggestive rather than settled — the daily
          // discrimination tracker is the
          // ongoing check; revisit if the gated list stops beating its old baseline.
          // Staff-wildness gate raised 1.10 -> 1.34 (a population backtest,
          // 901 graded picks over 40 slates): realized walk rate was a flat ~36-40% coin flip
          // for staff BB% 9-11%, then jumped to 44.1% (11-12%) / 48.1% (12%+). 1.34 ≈ 11% staff
          // (SP+BP) BB% vs the 8.2% league mark, cutting the coin-flip middle. Batter BB% above
          // the 12% floor did NOT discriminate (flat 39-43% across 12-18%+), so that floor is
          // unchanged — raising it only cuts volume with no accuracy gain. Tightens the list a
          // lot (~1/4 of prior volume); monitor the daily walk calibration and dial back if too
          // sparse. `strong` = the 12%+-staff 48% zone (batter-BB% requirement dropped — flat).
          const walkGate = splitBBPct >= 0.12 && blendedBBFactor >= 1.34;
          if (walkProb >= PROP_FLOORS.walk && walkGate) walk.push({ ...base, prob: walkProb, strong: walkProb >= 0.58 && blendedBBFactor >= WALK_STRONG_STAFF_GATE, factors: bbFactors, stat: walkStat, pitchAroundPressure: +pitchAroundPressure.toFixed(4) });
          if (bbUnderProb >= 0.87) bbUnder.push({ ...base, prob: bbUnderProb, factors: negFactors(bbFactors), stat: bbUnderStat });
        }

        if (s.rbiPct > 0) {
          const LG_WHIP    = 1.30;
          const LG_RBI_RS  = 4.50;
          const rbiPosMult = (order >= 1 && order <= 9) ? RBI_POS_MULT[order] : 1.0;

          // WHIP directly measures runners allowed per inning — the prerequisite for RBI.
          // Blended 60/40 with ERA factor: WHIP captures baserunner suppression,
          // ERA captures run prevention (some pitchers strand runners well; both matter).
          const whipFactor = pSt.whip != null && (pSt.bf || 0) >= 30
            ? Math.max(0.65, Math.min(1.35, pSt.whip / LG_WHIP))
            : 1.0;
          // Blended SP+BP xSLG-allowed — same signal/cap as runsOver's runXslgFactor
          // (RBI is mechanistically the same run-scoring event, just attributed to the
          // batter driving it in). WHIP/ERA capture baserunner+run prevention broadly;
          // this adds luck/defense-independent contact quality allowed on top.
          const spXslgForRbi = getSavantPitcherData()[sp.id]?.xslg ?? null;
          const bpXslgForRbi = bpComp?.xslg ?? null;
          const blendedXslgForRbi = spXslgForRbi != null && bpXslgForRbi != null
            ? spXslgForRbi * SP_WT + bpXslgForRbi * RP_WT
            : (spXslgForRbi ?? bpXslgForRbi ?? null);
          const rbiXslgFactor = blendedXslgForRbi != null
            ? Math.max(0.94, Math.min(1.06, 1 + (blendedXslgForRbi / 0.390 - 1) * 0.25))
            : 1.0;
          const blendedRbiFactor = (whipFactor * 0.60 + blendedEraFactor * 0.40) * rbiXslgFactor;

          // Team RS/G: captures the actual run-scoring environment this lineup produces.
          // Higher-scoring teams generate more RBI opportunities for every lineup slot.
          const teamRSperG  = teamRS ?? LG_RBI_RS;
          const teamRsFactor = Math.max(0.75, Math.min(1.25, teamRSperG / LG_RBI_RS));

          let eRbi = s.rbiPct * parkFactor;
          eRbi *= blendedRbiFactor;
          const _rbiPreAdj = eRbi;
          eRbi  = Math.max(0, eRbi + adj.avgAdj * 0.25);
          const _rbiPostAdj = eRbi;
          eRbi *= rbiPosMult;
          eRbi *= teamObpFactor;
          eRbi *= teamRsFactor;
          eRbi *= ars.off;
          // Mean-revert the contextual-factor overshoot toward the batter's own RBI rate
          // (compresses the extremes that drive rbiUnder's inverted discrimination).
          const _rbiPreReg = eRbi;
          eRbi = Math.max(0, s.rbiPct + (eRbi - s.rbiPct) * RBI_FACTOR_REGRESSION);

          const rbiOverProb  = 1 - Math.pow(1 - eRbi, pa);
          const rbiUnderProb = 1 - rbiOverProb;

          // RBI has NO BvP input (rate is team/position/pitcher driven). team =
          // lineup OBP x team RS/G (baserunner opportunity); pos = lineup slot;
          // regress = mean-reversion of the factor stack toward the batter's base rate.
          const rbiFactors = {
            base: +s.rbiPct.toFixed(5), rate: +eRbi.toFixed(5), pa,
            park: L(parkFactor), pitcher: L(blendedRbiFactor), xslg: L(rbiXslgFactor),
            adj:  L(_rbiPostAdj / (_rbiPreAdj || _rbiPostAdj)),
            pos:  L(rbiPosMult), team: L(teamObpFactor * teamRsFactor),
            arsenal: L(ars.off), regress: L(_rbiPreReg > 0 ? eRbi / _rbiPreReg : 1),
          };

          const posLabel  = lineupConfirmed ? ' · batting ' + order : '';
          const obpLabel  = Math.abs(teamObpFactor - 1.0) >= 0.05
            ? ' · lineup ' + (teamLineupObp >= 1 ? '1.000' : '.' + String(Math.round(teamLineupObp * 1000)).padStart(3, '0')) + ' OBP'
            : '';
          const whipLabel = pSt.whip != null && (pSt.bf || 0) >= 30
            ? ' · SP: ' + parseFloat(pSt.whip).toFixed(2) + ' WHIP' : '';
          const rbiXslgNote = blendedXslgForRbi != null && Math.abs(rbiXslgFactor - 1.0) >= 0.02
            ? ' · SP+BP allow .' + String(Math.round(blendedXslgForRbi * 1000)).padStart(3, '0') + ' xSLG'
            : '';
          const rbiBase      = (s.rbiPct * 100).toFixed(1) + '% RBI/PA' + posLabel + obpLabel;
          const rbiOverStat  = rbiBase + whipLabel + rbiXslgNote + (spLabel ? ' · vs ' + spLabel : '');
          const rbiUnderStat = rbiBase + whipLabel + rbiXslgNote + ' — low RBI spot' + (spLabel ? ' · vs ' + spLabel : '');

          const rbiThreshold = lineupConfirmed ? 0.52 : 0.56;
          // RBI+ contact qualification. RBI is heavily driven by lineup slot (whether runners
          // are on when you bat), so the interesting question is what separates hitters WITHIN
          // the same slot. A full-slate backtest — every batter who took a PA, not just the ones
          // the model already liked — showed a hitter's OWN quality of contact separates RBI
          // outcomes within a lineup spot, while the bottom of the order is structurally low
          // regardless. So this gates on contact quality inside an RBI-producing slot rather
          // than leaning on the probability floor, which barely discriminated on its own.
          // Hitters without Savant contact data (rookies, small samples) don't qualify.
          const rbiEliteContact = (savant.xwoba != null && savant.xwoba >= 0.340)
            || (savant.hardHitPct != null && savant.hardHitPct >= 44 && savant.barrelRate != null && savant.barrelRate >= 10);
          const rbiSpot = order != null && order >= 1 && order <= 6;
          const rbiContactNote = savant.xwoba != null && savant.xwoba >= 0.340
            ? ' · .' + String(Math.round(savant.xwoba * 1000)).padStart(3, '0') + ' xwOBA elite contact'
            : (savant.hardHitPct != null && savant.hardHitPct >= 44 ? ' · ' + savant.hardHitPct.toFixed(0) + '% hard-hit elite contact' : '');
          if (rbiOverProb >= PROP_FLOORS.rbiOver && lineupConfirmed && rbiEliteContact && rbiSpot)
            rbiOver.push({ ...base, prob: rbiOverProb,
              strong: rbiOverProb >= rbiThreshold && spPairScore >= 6 && teamObpFactor >= 1.00 && (savant.xwoba || 0) >= 0.360 && order >= 2 && order <= 5,
              factors: rbiFactors, stat: rbiOverStat + rbiContactNote });
          if (rbiUnderProb >= 0.75) rbiUnder.push({ ...base, prob: rbiUnderProb, factors: negFactors(rbiFactors), stat: rbiUnderStat });
        }

        if (s.runsPct > 0) {
          const LG_RS_G    = 4.50;
          const runPosMult = (order >= 1 && order <= 9) ? RUN_POS_MULT[order] : 1.0;

          // Team-based rate: expected runs from this lineup slot per PA
          // Uses actual team RS/G scaled by position weight — captures run environment
          const teamRSperG    = teamRS ?? LG_RS_G;
          const teamBasedRate = (teamRSperG * (runPosMult / 9)) / pa;

          // Batter's OBP relative to lineup average — higher OBP batters score
          // more than their teammates; avoids double-counting vs runsPct base
          const teamObpRef   = Math.max(0.280, teamLineupObp);
          const relObpFactor = Math.max(0.80, Math.min(1.20, obp / teamObpRef));

          // Blend: 60% team RS/G environment + 40% individual R/PA history
          const blendedBase = teamRS != null
            ? teamBasedRate * relObpFactor * 0.60 + (s.runsPct || 0) * 0.40
            : s.runsPct;

          // Speed bonus: high-SB runners score more often per time on base
          const sbMult = Math.max(0.95, Math.min(1.12, 1 + (s.sbAttemptRate || 0) * 1.5));

          // Batter xwOBA/wOBA luck-stripping (same pattern as the XBH signal above) — a
          // batter running colder than their expected contact quality scores more than
          // their current-rate stats suggest, and vice versa. Not an absolute quality
          // boost (that would double-count runsPct/OBP already in blendedBase).
          const runLuckMult = (savant.xwoba != null && savant.woba > 0)
            ? Math.max(0.94, Math.min(1.06, savant.xwoba / savant.woba))
            : 1.0;

          // Pitcher xSLG-allowed (SP+BP blended) — luck/defense-independent contact
          // quality allowed, complementing blendedEraFactor (which bakes in defense/
          // sequencing/luck). Same blend + sensitivity as the XBH signal above.
          const spXslgForRun = getSavantPitcherData()[sp.id]?.xslg ?? null;
          const rpXslgForRun = bpComp?.xslg ?? null;
          const blendedXslgForRun = spXslgForRun != null && rpXslgForRun != null
            ? spXslgForRun * SP_WT + rpXslgForRun * RP_WT
            : (spXslgForRun ?? rpXslgForRun ?? null);
          const runXslgFactor = blendedXslgForRun != null
            ? Math.max(0.94, Math.min(1.06, 1 + (blendedXslgForRun / 0.390 - 1) * 0.25))
            : 1.0;

          // Live weather → run-environment multiplier. Reuses the exact calibrated
          // formula from winPrediction.js's game-total model (fit on several thousand
          // open-park games) — heat/wind touch all offense, not just HR, so runsUnder
          // needs this too: a hot/windy game should not clear a "won't score" bar as
          // easily as a calm/cold one.
          const wl = matchup.weatherLive;
          let weatherRunMult = 1.0;
          if (wl) {
            const feels = wl.feelsLikeF != null ? wl.feelsLikeF : wl.tempF;
            if (feels != null)         weatherRunMult *= Math.max(0.95, Math.min(1.07, 1 + (feels - 72) * 0.003));
            if (wl.outWindMph != null) weatherRunMult *= Math.max(0.94, Math.min(1.06, 1 + wl.outWindMph * 0.006));
            if (wl.glareRunMult != null) weatherRunMult *= wl.glareRunMult;
          }

          // SP recent-form trend — spBlendedEra/spTier above already blend in the SP's
          // last-3-starts ERA, but that blended number only drives tier LABELS/notes; it
          // was never actually applied as an eRun multiplier. This adds just the NEW
          // information (is he trending hotter/colder than his own season rate lately),
          // not the season-average part already covered by blendedEraFactor/runXslgFactor.
          const spFormMult = (spRecentEra != null && spSeasonEra > 0)
            ? Math.max(0.94, Math.min(1.06, spRecentEra / spSeasonEra))
            : 1.0;

          let eRun = blendedBase * sbMult * blendedEraFactor * runXslgFactor * parkFactor * weatherRunMult * runLuckMult * spFormMult;
          const _runPreAdj = eRun;
          eRun     = Math.max(0, eRun + adj.obpAdj * 0.20);
          const _runPostAdj = eRun;
          eRun    *= ars.off;
          // Times-through-the-order: a deeper-going SP exposes the lineup to more PAs
          // against a tiring arm (same ttoMult used by the K model above).
          eRun    *= ttoMult;

          const runsOverProb  = 1 - Math.pow(1 - eRun, pa);
          let   runsUnderProb = 1 - runsOverProb;
          const rGames7       = bRecent.rGames7 || 0;
          let hotRunMult = 1.0;
          if      (rGames7 >= 5) hotRunMult = 0.80;
          else if (rGames7 >= 4) hotRunMult = 0.87;
          runsUnderProb *= hotRunMult;

          // Slump signal — the mirror case of hotRunMult above. bRecent.hitlessStreak/
          // avg7 already exist for the separate streakCold display, but were never
          // applied to runsUnder itself: a batter genuinely cold right now (not just
          // low season OBP) should clear the "won't score" bar more easily.
          const hitlessStreak = bRecent.hitlessStreak || 0;
          let slumpMult = 1.0;
          if      (hitlessStreak >= 5) slumpMult = 1.15;
          else if (hitlessStreak >= 3) slumpMult = 1.08;
          else if ((bRecent.avg7 != null && bRecent.ab7 >= 15 && bRecent.avg7 <= 0.130)) slumpMult = 1.10;
          runsUnderProb = Math.min(0.97, runsUnderProb * slumpMult);

          // teamenv = team RS/G environment + relative-OBP blend vs individual R/PA.
          const runFactors = {
            base: +(s.runsPct || 0).toFixed(5), rate: +eRun.toFixed(5), pa,
            teamenv: L(blendedBase / (s.runsPct || blendedBase)),
            speed:   L(sbMult), pitcher: L(blendedEraFactor), xslg: L(runXslgFactor),
            spform:  L(spFormMult),
            park:    L(parkFactor), weather: L(weatherRunMult), luck: L(runLuckMult),
            adj:     L(_runPostAdj / (_runPreAdj || _runPostAdj)),
            arsenal: L(ars.off), tto: L(ttoMult),
          };
          const runUnderFactors = negFactors(runFactors);
          runUnderFactors.hotrunner = L(hotRunMult); // applied to the under prob only
          runUnderFactors.slump     = L(slumpMult);  // applied to the under prob only

          const posLabel2    = lineupConfirmed ? ' · batting ' + order : '';
          const teamObpLabel = Math.abs(teamObpFactor - 1.0) >= 0.05
            ? ' · lineup ' + (teamLineupObp >= 1 ? '1.000' : '.' + String(Math.round(teamLineupObp * 1000)).padStart(3, '0')) + ' OBP'
            : '';
          const teamRSLabel  = teamRS != null ? ' · ' + teamRS.toFixed(2) + ' R/G' : '';
          const hotRunNote   = rGames7 >= 4 ? ` · scored ${rGames7}/7G (adjusted down)` : '';
          const weatherRunNote = Math.abs(weatherRunMult - 1.0) >= 0.03
            ? ' · ' + (weatherRunMult > 1 ? 'hot/windy +' : 'cold/wind-in ') + Math.abs(Math.round((weatherRunMult - 1) * 100)) + '% runs'
            : '';
          const xslgRunNote = blendedXslgForRun != null && Math.abs(runXslgFactor - 1.0) >= 0.02
            ? ' · SP allows .' + String(Math.round(blendedXslgForRun * 1000)).padStart(3, '0') + ' xSLG'
            : '';
          const runsBase     = 'OBP ' + fmtObp(obp) + teamRSLabel + posLabel2 + teamObpLabel + weatherRunNote + xslgRunNote;
          const runsOverStat = runsBase + (spLabel ? ' · vs ' + spLabel : '');
          const bvpAvgVal    = bvp?.avg ?? null;
          const bvpObpVal    = bvp?.obp ?? null;
          // When 10+ career ABs vs this SP exist, require avg<=.200 AND obp<=.300.
          // The OBP gate closes the walk gap: a batter who walks often vs this pitcher
          // still reaches base and can score even with a low hit rate.
          const bvpRunFilter = bvpAb < 10
            || (bvpAvgVal != null && bvpAvgVal <= 0.200 && (bvpObpVal == null || bvpObpVal <= 0.300));
          const bvpRunNote   = (bvpAb >= 10 && bvpAvgVal != null && bvpAvgVal <= 0.200)
            ? ' · .' + String(Math.round(bvpAvgVal * 1000)).padStart(3, '0') + ' avg vs SP (' + bvpAb + ' AB)'
            : '';
          const slumpNote    = hitlessStreak >= 3 ? ` · ${hitlessStreak}g without a hit`
                              : slumpMult > 1.0   ? ` · .${String(Math.round((bRecent.avg7 || 0) * 1000)).padStart(3, '0')} last 7g`
                              : '';
          const runsUnderStat = runsBase + hotRunNote + slumpNote + bvpRunNote + (spLabel ? ' · vs ' + spLabel : '');
          const runThreshold  = lineupConfirmed ? 0.68 : 0.72;
          // Leadoff slot only: accept a predicted leadoff hitter (lib/leadoffPredictor.js)
          // the same way the Leadoff/Hits Combo pools already do, below — without this, the
          // whole category was gated on lineupConfirmed with zero fallback, so early in the
          // day (before most lineups post) it silently collapsed to whichever handful of
          // teams happen to have the earliest games, not "who has a good matchup" (real bug
          // reported : at one point today it was effectively BOS-only). order 2+
          // still requires a real confirmed lineup — there's no predicted-order-2 system.
          const leadoffOk = lineupConfirmed || (isPredictedLeadoff && order === 1);
          const predictedLeadoffFlag = order === 1 && isPredictedLeadoff && !lineupConfirmed;
          // Order-TIERED run floor (validated a population backtest): the run
          // edge is specifically LEADOFF (order 1 = 55.6% realized vs ~40-45% for 2-9), NOT a
          // smooth "top of order" gradient — order 4-5 is actually the WORST (39.2%). So instead
          // of one flat floor we qualify by the statistical spot: leadoff clears at a low bar
          // (it over-performs its prob), 4-5 must clear a high bar (only the strongest), everyone
          // else sits at the base floor. Leadoff also over-performs regardless of prob band
          // (55.6% aggregate all the way down to the old .42 floor), which is why .46 is safe.
          const runsFloor = order === 1 ? 0.46
                          : (order >= 4 && order <= 5) ? 0.56
                          : PROP_FLOORS.runsOver;   // 0.50 for 2-3 and 6-9
          const leadoffStrong = order === 1 && obp >= 0.340 && spPairScore >= 6 && runsOverProb >= 0.50;
          if (runsOverProb >= runsFloor && (order === 1 ? leadoffOk : lineupConfirmed))
            runsOver.push({ ...base, prob: runsOverProb,
              strong: (runsOverProb >= runThreshold && spPairScore >= 6 && obp >= 0.330) || leadoffStrong,
              factors: runFactors, stat: (order === 1 ? 'Leadoff — top run-scoring spot · ' : '') + runsOverStat,
              predictedLeadoff: predictedLeadoffFlag });

          // Actionables — leadoff/2-hole hitters with a favorable matchup AND a real
          // high-OBP profile, specifically flagged as "likely to reach base and score at
          // some point tonight." Reuses the model's own calibrated runsOverProb rather than
          // a fresh formula — the same signal already validated for this exact question,
          // just filtered to the two lineup slots the user cares about. The spPairScore>=6
          // gate is what excludes a Wheeler-level shutdown matchup even for an otherwise-
          // strong OBP leadoff man. actionablesLeadoff accepts predicted leadoff (see above);
          // actionablesSecond has no predicted-order-2 system, so stays confirmed-only.
          if (spPairScore >= 6 && obp >= 0.330 && runsOverProb >= PROP_FLOORS.runsOver) {
            const actionEntry = { ...base, prob: runsOverProb, strong: runsOverProb >= runThreshold, factors: runFactors, stat: runsOverStat, predictedLeadoff: predictedLeadoffFlag };
            if (order === 1 && leadoffOk) actionablesLeadoff.push(actionEntry);
            else if (order === 2 && lineupConfirmed) actionablesSecond.push(actionEntry);
          }

          // Leadoff Run Combo pool — feeds computeLeadoffComboGroups, the
          // batched "N leadoff hitters combined score X+ runs" prop. Same quality gates as
          // actionablesLeadoff, but ALSO admits isPredictedLeadoff (source:'predicted-
          // leadoff', order forced to 1 by getBattingLineup) — the whole point is to have
          // real candidates available BEFORE lineups post, since by the time every game's
          // lineup is out, the early games' bets are already locked. `confirmed` is carried
          // through explicitly so the group-builder/UI/email can flag lineup risk on
          // anything not yet actually posted.
          // TEMP diagnostic (answering "how much does the matchup-score gate
          // actually change the selected group?"): admit on OBP+prob alone, but carry
          // spPairScore + passesMatchupGate so computeLeadoffComboGroups can build both
          // the real (gated) and an ablation (ungated) group for comparison. Revert to a
          // hard `spPairScore >= 6 &&` gate here if the diagnostic isn't kept.
          if ((lineupConfirmed || isPredictedLeadoff) && order === 1 &&
              obp >= 0.330 && runsOverProb >= PROP_FLOORS.runsOver) {
            leadoffComboPool.push({
              ...base, prob: runsOverProb, factors: runFactors, stat: runsOverStat,
              confirmed: lineupConfirmed,
              predictionConfidence: batterRow.batter.predictionConfidence || null,
              spPairScore, passesMatchupGate: spPairScore >= 6,
            });
          }
          // Gate on the CALIBRATED probability, not the raw one. The trailing correction
          // factor (runsUnder ~0.88 historically — this category has run ~12% overconfident)
          // was previously only applied for DISPLAY after selection, so a raw ">=0.78" gate
          // was actually producing ~69% real hit rate, not 78%. 0.65 is an honest target:
          // calibration-history.json shows ~69% was the best this category sustained even at
          // its highest-volume period (May), so 0.65 deliberately trades a little of that for
          // the volume back, rather than pretending a higher number is achievable today. This
          // will drift as accuracy.js's trailing correction re-learns against the new signals
          // added above — recheck against fresh calibration-history data in 1-2 weeks.
          const runUnderCorrection = correctionFactors.runsUnder ?? 1.0;
          const RUNS_UNDER_TARGET  = 0.65;
          if (runsUnderProb * runUnderCorrection >= RUNS_UNDER_TARGET && bvpRunFilter)
            runsUnder.push({ ...base, prob: runsUnderProb, factors: runUnderFactors, stat: runsUnderStat });
        }

        // Sprint-speed stabilizer — (461 real batters: corr=0.603
        // between Statcast sprint speed and real SB attempt rate; batters with a thin SB
        // sample averaged 26.6 ft/s vs 28.5 ft/s for real base-stealers). A fast batter
        // with little or no attempt history currently gets excluded from SB entirely
        // (gated on sbAttemptRate>0) even though speed alone is a real, meaningful
        // predictor. Bayesian-blend the real rate with a speed-derived expectation,
        // weighted by actual attempt count — few/no attempts leans on speed, a real
        // track record (SB_STAB_K+ attempts) increasingly dominates.
        // The speed-only prior is scaled by this batter's own reach-1st-base rate
        // (singles + walks + HBP, excluding XBH — a double/triple/HR removes the need to
        // steal). Validated : reach-1st rate correlates with real SB attempt
        // rate at 0.184 vs only 0.083 for full OBP (304 real batters) — a speedy batter who
        // rarely reaches 1st base has fewer real steal chances than an equally fast, high-
        // reach-1st batter, which the old speed-only prior ignored. Applied only to the
        // thin-sample PRIOR, not the real-attempts side (which already reflects each
        // batter's true on-base-linked history) — avoids double-counting.
        const LG_REACH1ST_RATE = 0.23; // approx MLB league-average (1B+BB+HBP)/PA
        const reach1stRate = (s.singlesRate || 0) + (s.bbPct || 0);
        const reachOppAdj  = reach1stRate > 0
          ? Math.max(0.6, Math.min(1.6, reach1stRate / LG_REACH1ST_RATE))
          : 1.0;
        const spdExpectedSbRate = savant.sprintSpeed != null
          ? Math.max(0, -0.284712 + 0.011269 * savant.sprintSpeed) * reachOppAdj
          : null;
        const sbAttempts  = s.sbAttempts || 0;
        const SB_STAB_K   = 6;
        const sbAttemptRateStab = spdExpectedSbRate != null
          ? (sbAttempts * s.sbAttemptRate + SB_STAB_K * spdExpectedSbRate) / (sbAttempts + SB_STAB_K)
          : s.sbAttemptRate;

        if (sbAttemptRateStab > 0) {
          const LG_CS_PCT          = 0.28;
          const LG_SB_SUCC_AGAINST = 0.72;
          // A pitcher-hand attempt-rate penalty (facing LHP) was tested and removed
          // — real data across the full 754-pitcher pool showed no suppression
          // of attempt rate per baserunner allowed facing LHP vs RHP at any sample-size
          // threshold (e.g. ≥100 baserunners: 7.46% LHP vs 6.89% RHP — same direction as
          // RHP, not lower), contradicting the previous flat 0.72x assumption.
          const catcherSucc  = Math.min(1, s.sbSuccessRate * (1 - catcherCS) / (1 - LG_CS_PCT));
          // Attempt-propensity boost — distinct from catcherSucc above, which only scales
          // the odds of SUCCEEDING once a runner goes. (67 real MLB
          // catchers, >=8 attempts/>=150 baserunners each): runners genuinely attempt more
          // often against a weak-armed catcher, not just succeed more — corr(catcher CS%,
          // attempt rate per baserunner) = -0.453. Bottom-quartile CS% catchers (12.6% CS)
          // saw an 8.49% attempt rate vs 6.66% for top-quartile (38.9% CS), a ~27% relative
          // gap. Scaled to 60% of the raw ratio here (rather than the full swing) since the
          // correlation, while real, isn't strong enough to trust the full point estimate.
          const catcherAttemptBoost = Math.max(0.85, Math.min(1.35,
            1 + 0.6 * ((1 - catcherCS) / (1 - LG_CS_PCT) - 1)
          ));
          const pSbTotal     = (pSt.sbAllowed || 0) + (pSt.csAllowed || 0);
          const pitcherSbAdj = pSt.sbSuccAllowed != null && pSbTotal >= 10
            ? Math.max(0.70, Math.min(1.30, pSt.sbSuccAllowed / LG_SB_SUCC_AGAINST))
            : 1.0;
          const sbRatePA = sbAttemptRateStab * catcherAttemptBoost * catcherSucc * pitcherSbAdj;
          const sbProb   = 1 - Math.pow(1 - sbRatePA, pa);
          const sbCatcherEffect = (1 - catcherCS) / (1 - LG_CS_PCT);
          const sbFactors = {
            base: +sbAttemptRateStab.toFixed(5), rate: +sbRatePA.toFixed(5), pa,
            success: L(s.sbSuccessRate), catcher: L(sbCatcherEffect),
            catcherAttempt: L(catcherAttemptBoost),
            pitcher: L(pitcherSbAdj), opportunity: L(reachOppAdj),
            speed: s.sbAttemptRate > 0 ? L(sbAttemptRateStab / s.sbAttemptRate) : 0,
          };
          if (sbProb >= PROP_FLOORS.sb) {
            const catchNote   = Math.abs(catcherCS - LG_CS_PCT) >= 0.05
              ? ' · catcher ' + (catcherCS * 100).toFixed(0) + '% CS' : '';
            const pitcherNote = Math.abs(pitcherSbAdj - 1.0) >= 0.08
              ? ' · SP allows ' + (pSt.sbSuccAllowed * 100).toFixed(0) + '% SBs'
              : '';
            const speedNote = spdExpectedSbRate != null && sbAttempts < SB_STAB_K
              ? ' · ' + savant.sprintSpeed.toFixed(1) + ' ft/s sprint speed'
              : '';
            const attemptsNote = sbAttempts > 0
              ? ' (' + sbAttempts + ' real attempts)'
              : ' (speed-projected — no attempts yet)';
            sb.push({ ...base, prob: sbProb, strong: sbProb >= 0.30, factors: sbFactors,
              stat: (sbAttemptRateStab * 100).toFixed(1) + '% SB attempt rate' + attemptsNote
                + ' · ' + (s.sbSuccessRate * 100).toFixed(0) + '% career success'
                + catchNote + pitcherNote + speedNote });
          }
        }
      }
    }
  }

  // Every category is ordered by probability DESCENDING — the candidate most likely to do
  // that category's thing sits at the top (incl. the "under" props: most-likely-to-go-
  // hitless, etc.). discScore is still attached for reference but no longer drives order.
  const byProb = arr => {
    for (const e of arr) e.discScore = +(propDiscScore(e) ?? e.prob).toFixed(4);
    arr.sort((a, b) => b.prob - a.prob);
  };
  byProb(hit); byProb(hrp); byProb(tb); byProb(tb2);
  byProb(walk); byProb(runsOver); byProb(rbiOver); byProb(sb);

  k.sort(        (a, b) => b.prob - a.prob);
  cold.sort(     (a, b) => b.prob - a.prob);   // highest hitless prob first
  hrm.sort(      (a, b) => b.prob - a.prob);
  vsTeamHr.sort( (a, b) => b.hrPerGame - a.hrPerGame);
  rbiUnder.sort( (a, b) => b.prob - a.prob);
  runsUnder.sort((a, b) => b.prob - a.prob);
  bbUnder.sort(  (a, b) => b.prob - a.prob);
  kUnder.sort(   (a, b) => b.prob - a.prob);

  const { LOCK_TO_CAT, ACCURACY_CATS } = require('./accuracy');

  // Scale the elastic-category ceilings (PROP_MAX=45 / 30 / 40) by slate size. These were
  // all tuned against a full ~15-game slate; holding them fixed meant a light slate (fewer
  // qualified batters overall) still got filled to the SAME count, which silently reached
  // further down the probability-sorted list to do it — confirmed empirically :
  // hit/hrp/walk sat at exactly 45 on an 8-game day just as often as on 15-game days,
  // defeating the "elastic, floor-governed" design intent stated below. Floor at 0.35x so
  // a very sparse day (2-3 games) doesn't collapse the lists to near-nothing.
  const SLATE_REF_GAMES = 15;
  const slateScale = Math.max(0.35, Math.min(1.0, gamesLoaded / SLATE_REF_GAMES));
  const propMaxS = Math.max(15, Math.round(PROP_MAX * slateScale));
  const cap30S   = Math.max(10, Math.round(30 * slateScale));
  const cap40S   = Math.max(12, Math.round(40 * slateScale));
  // HR+ gets a tighter ceiling than the other elastic categories : at 45
  // picks the surfaced probabilities ran only ~30% down to ~22% — the bottom half were
  // near-duplicates adding daily-noise volume, not information (only ~30-40 HR are hit
  // league-wide per day; 45 picks summing to ~11 expected HR is reaching well past the
  // model's real discrimination). Top ~24 on a full slate keeps every pick meaningfully
  // differentiated.
  const hrpCapS  = Math.max(10, Math.round(24 * slateScale));

  const probResult = {
    locks:     [],
    streakHot:  streakHot.sort( (a, b) => b.hitStreak     - a.hitStreak),
    streakCold: streakCold.sort((a, b) => b.hitlessStreak - a.hitlessStreak),
    streakFire: streakFire.sort((a, b) => b.avg7          - a.avg7),
    // Elastic "needs to happen" categories use a generous, slate-scaled ceiling — the
    // probability floor upstream (PROP_FLOORS) already governs inclusion, so the count
    // flexes with the slate rather than being forced to a fixed number.
    hit:       hit.slice(0,propMaxS),      k:        k.slice(0,cap40S),
    cold:      cold.slice(0,cap30S),       hrp:      hrp.slice(0,hrpCapS),
    hrpLive:   hrpLive.sort((a,b) => b.prob - a.prob), // no cap — all weather-qualified candidates
    hrm:       hrm.slice(0,cap30S),        vsTeamHr: vsTeamHr,
    vsTeamCareer: vsTeamCareer.sort((a,b) => b.vsTeamOps - a.vsTeamOps),
    tb:        tb.slice(0,propMaxS),
    tb2:       tb2.slice(0,propMaxS),
    walk:      walk.slice(0,propMaxS),     rbiOver:  rbiOver.slice(0,propMaxS),

    rbiUnder:  rbiUnder.slice(0,cap30S),   runsOver: runsOver.slice(0,propMaxS),
    runsUnder: runsUnder.slice(0,cap30S),  sb:       sb.slice(0,propMaxS),
    bbUnder:   bbUnder.slice(0,cap30S),    kUnder:   kUnder.slice(0,cap30S),
    recentK:   recentK.sort((a, b) => b.recentKPct - a.recentKPct).slice(0,cap40S),
    spProjectedK: spProjectedK.sort((a, b) => b.projK - a.projK),
    // Naturally capped at ~1 per team per slot (confirmed leadoff/2-hole only) — no
    // slate-scaled ceiling needed the way the elastic categories above have.
    actionablesLeadoff: actionablesLeadoff.sort((a, b) => b.prob - a.prob),
    actionablesSecond:  actionablesSecond.sort((a, b) => b.prob - a.prob),
    // Combo pools get the SAME daily calibration corrections the single-pick categories
    // get in the ACCURACY_CATS loop below (grading fix): they were being built
    // from raw probs/lambdas while the singles were corrected — on 7/10 (hit factor 0.80)
    // that set the tier-1 hits line at 12.5 off a 12.6 raw projTotal when the corrected
    // projection was ~10.1. Lambda scales by the same factor (first-order deflation of the
    // expected count); prob scales exactly like the singles' correction.
    leadoffComboGroups: computeLeadoffComboGroups(
      correctComboPool(leadoffComboPool.filter(e => e.passesMatchupGate), correctionFactors.runsOver), 8, 'runs'),
    // TEMP diagnostic : same pool, matchup-score gate removed, for a direct
    // "how much does spPairScore>=6 actually change the selection" comparison.
    leadoffComboGroupsNoMatchupGate: computeLeadoffComboGroups(
      correctComboPool(leadoffComboPool, correctionFactors.runsOver), 8, 'runs'),
    // Multi-Hit Squad Combo — same grouping/math as the runs combo, built
    // from P(2+ hits) instead. See hitsComboPool push above for the gate/formula.
    hitsComboGroups: computeLeadoffComboGroups(
      correctComboPool(hitsComboPool, correctionFactors.hit), 8, 'hits'),
    gamesLoaded,
  };

  // Apply correction factors first so locks are collected from corrected probabilities.
  // Stash the pre-correction value as rawProb: calibration MUST measure the raw model
  // probability, not the corrected one — otherwise the factor is computed against its
  // own output and converges to sqrt(actual/raw), only ever applying half the needed
  // correction (predictions land at the geometric mean of model and reality). Display,
  // locks use the corrected `prob`; the accuracy route averages `rawProb`.
  // Global HR calibration via the recent league rate (~2.3–2.6 HR/game). Sum the model's
  // raw P(HR) over ALL batters (slateHrSum) and compare to games × recentLeagueHR/game.
  // IMPORTANT: we do NOT scale candidate probs to fully close that gap — most of the slate
  // under-prediction is IRREDUCIBLE (random HRs by low-power non-candidates the model
  // correctly rates low), so a full scale would over-inflate the candidates to absurd
  // numbers (a top bat is never ~48% to homer). Instead the anchor is used to FLOOR the
  // trailing per-category correction — preventing a stale factor (e.g. 0.61 from cooler
  // weeks) from over-correcting on a hot slate. Damped ×0.72 (candidates are a smaller
  // slice of the total miss than the broad middle) and capped at 1.03 so it nudges, never
  // inflates. When the model OVER-predicts the slate total, the trailing correction wins.
  const nGames       = gamesLoaded;
  const leagueHrPerG = getLeagueHrPerGameSync();
  const hrTarget     = nGames * leagueHrPerG;
  const rawScale     = (slateHrSum > 1 && nGames > 0) ? hrTarget / slateHrSum : 1.0;
  const hrCorrection = Math.max(correctionFactors.hrp ?? 1.0, Math.min(1.03, rawScale * 0.72));

  // rbiOver spread compression — empirical, from 30 days of graded picks
  // realized RBI rate was nearly FLAT across every prediction quintile while the raw
  // predictions climbed steeply, so the inflation grew with the prediction. The spread was
  // almost pure noise, and a flat daily correction cannot fix a SHAPE error — it over-corrects
  // the bottom and under-corrects the top. Shrink each raw prob toward the observed raw mean, keeping 20% of the
  // deviation (the ordering's small real signal, +3.4pts top-vs-bottom-third, survives;
  // the false confidence spread dies). Applied AFTER selection/floor/cap so it cannot
  // change WHICH picks surface — only the stated numbers. With the daily factor on top,
  // every quintile lands within ~1pt of its realized rate on the 30-day sample. Anchor and
  // keep-ratio are dated empirical constants — re-derive if the eRbi formula changes.
  const RBI_RAW_ANCHOR = 0.567, RBI_SPREAD_KEEP = 0.20;
  for (const e of (probResult.rbiOver || [])) {
    e.prob = Math.max(0, Math.min(1, RBI_RAW_ANCHOR + (e.prob - RBI_RAW_ANCHOR) * RBI_SPREAD_KEEP));
  }

  for (const cat of ACCURACY_CATS) {
    if (!probResult[cat]) continue;
    const f = (cat === 'hrp') ? hrCorrection : (correctionFactors[cat] ?? 1.0);
    probResult[cat] = probResult[cat].map(e => ({
      ...e,
      rawProb: e.prob,
      prob:    Math.max(0, Math.min(1, e.prob * f)),
    }));
  }
  probResult.hrCalibration = { slateHrSum: +slateHrSum.toFixed(1), target: +hrTarget.toFixed(1), leagueHrPerG, rawScale: +rawScale.toFixed(3), hrCorrection: +hrCorrection.toFixed(3), trailingHrp: correctionFactors.hrp ?? 1.0, nGames };

  // Auto-out K subset — the validated contact-hole matchups, tracked separately in the
  // accuracy view to see whether they're more consistent than K picks at large. Filtered from
  // the CORRECTED k array (after the loop above) so flag + corrected prob are both preserved.
  probResult.kAutoOut = (probResult.k || []).filter(e => e.autoOut).slice(0, 30);

  // Multi-K (K>=2) candidates — batters with an arsenal "auto-out": a pitch group they whiff
  // on heavily that this starter throws often. Two supporting gates, both mechanical rather
  // than fitted: the starter has to work deep enough for a third plate appearance (K>=2 needs
  // repeat exposure to the same hole pitch), and the batter has to hit near the top of the
  // order (more PA). A null batting order means the lineup isn't posted yet, so it's allowed
  // through rather than silently dropped.
  probResult.kMulti = (probResult.k || [])
    .filter(e => e.autoOut
      && (e.aoWhiff      || 0) >= AUTO_OUT_WHIFF_GATE
      && (e.spIpPerStart || 0) >= SP_DEPTH_GATE_IP
      && (e.battingOrder == null || e.battingOrder <= 5))
    .sort((a, b) => (b.kTwoProb || 0) - (a.kTwoProb || 0))
    .slice(0, 20);

  const LOCK_THRESHOLD = 0.90;
  const lockSources = [
    { arr: probResult.tb,        label: 'XBH'  },
    { arr: probResult.tb2,       label: '2+TB' },
    { arr: probResult.hit,       label: 'HIT'  },
    { arr: probResult.rbiOver,   label: 'RBI+' },
    { arr: probResult.rbiUnder,  label: 'RBI-' },
    { arr: probResult.runsOver,  label: 'RUN+' },
    { arr: probResult.runsUnder, label: 'RUN-' },
    { arr: probResult.bbUnder,   label: 'BB-'  },
    { arr: probResult.kUnder,    label: 'K-'   },
    { arr: probResult.walk,      label: 'BB'   },
    { arr: probResult.sb,        label: 'SB'   },
    { arr: probResult.k,         label: 'K'    },
    { arr: probResult.cold,      label: 'HIT-' },
    { arr: probResult.hrp,       label: 'HR+'  },
  ];
  probResult.locks = lockSources
    .flatMap(({ arr, label }) => arr.filter(e => e.prob >= LOCK_THRESHOLD).map(e => ({ ...e, lockLabel: label })))
    .sort((a, b) => b.prob - a.prob);
  probResult.correctionFactors = correctionFactors;
  probResult.calibrationDays   = calibrationHistory.length;
  return probResult;
}

module.exports = { getBullpenComposite, computeManagerTendency, computeAllProbables, rpRoleFor, RP_LEVERAGE_W };
