'use strict';

const {
  matchupCache, batterSplitCache, pitcherStatCache, pitcherRecentCache,
  pitcherSplitCache, rpAppearanceCache, recentBatterCache, standingsCache,
  HR_PARK_FACTORS, LG_OPS_AGAINST, getUmpTendency,
  getSavantData, getSavantPitcherData, getTeamDefense,
  getPitcherArsenal, getPitcherFbVelo, getBatterArsenal,
} = require('./mlbApi');

const MLB_BASE_RUNS = 4.50;
const LG_OPS        = 0.720;
const LG_XWOBA      = 0.318; // league-average xwOBA (and wOBA) baseline
// Run-total calibration: the model systematically under-projected totals (actual 9.50
// vs predicted 8.55 over 158 games, +0.95 run/+11% bias). Applied equally to both
// teams, so it lifts the projected total WITHOUT changing the win split (ratio-preserved).
const TOTAL_CALIBRATION = 1.11;
const LG_ERA        = 4.20;
const LG_BP_ERA     = 4.55; // league-average bullpen ERA (higher than SP average)
const HOME_ADV      = 1.04;

// Expected PA by batting order position 1–9 (same table as probables)
const ORDER_PA = [4.7, 4.5, 4.3, 4.1, 3.9, 3.7, 3.5, 3.3, 3.1];

// ---------------------------------------------------------------------------
// Park run factor: ~40% of the HR factor adjustment carries into total runs.
// Air-density bonus for true high-altitude parks (ball carries on doubles/triples,
// not just HR) — small, on top of what the HR factor already captures. Shared by
// both teams, so it moves the total, never the winner.
// ---------------------------------------------------------------------------
const ALTITUDE_RUN_BONUS = { 'coors field': 1.03 };
function parkRunFactor(venueName) {
  const key = (venueName || '').toLowerCase();
  const hr  = HR_PARK_FACTORS[key] ?? 1.0;
  return (1 + (hr - 1) * 0.40) * (ALTITUDE_RUN_BONUS[key] ?? 1.0);
}

// Handedness park skew — short porches / asymmetric walls help one batter side. Run
// multipliers for LHB vs RHB at the platoon-skewed parks (overall park level lives in
// parkRunFactor; this is the L/R TILT around it). Applied per team by its lineup L/R
// mix, so it differs between the two teams and DOES move the moneyline. Centered near
// 1.0 for a balanced lineup. Default {L:1,R:1} for parks with no meaningful tilt.
const PARK_HAND_FACTORS = {
  'yankee stadium':           { L: 1.05, R: 0.99 }, // short RF porch → LHB
  'fenway park':              { L: 0.99, R: 1.04 }, // Green Monster → RHB
  'citizens bank park':       { L: 1.03, R: 1.00 }, // LHB-friendly
  'great american ball park': { L: 1.03, R: 1.01 },
  'oriole park at camden yards': { L: 1.00, R: 0.95 }, // deep LF wall (2022+) → suppresses RHB
  'oracle park':              { L: 0.96, R: 1.00 }, // deep RF triples alley → suppresses LHB power
  'petco park':               { L: 0.97, R: 0.99 },
};
function parkHandFactor(venueName, lhbFraction) {
  const ph = PARK_HAND_FACTORS[(venueName || '').toLowerCase()];
  if (!ph) return 1.0;
  return ph.L * lhbFraction + ph.R * (1 - lhbFraction);
}
function lineupLhbFraction(rows) {
  let lhb = 0, n = 0;
  for (const row of (rows || [])) {
    const bs = row.batter?.hand; // batter bat side: matchup objects store it as `hand`
    if (!bs) continue;
    n++;
    if (bs === 'L') lhb += 1;
    else if (bs === 'S') lhb += 0.5; // switch hitters take the platoon edge ~half the time
  }
  return n > 0 ? lhb / n : 0.35;
}

// ---------------------------------------------------------------------------
// Weather run factor: cold/wind suppress or boost scoring for both teams
// ---------------------------------------------------------------------------
function weatherRunFactor(weather) {
  if (!weather) return 1.0;
  const tempF = parseInt(weather.temp) || 72;
  const windStr = (weather.wind || '').toLowerCase();
  const mphMatch = windStr.match(/(\d+)\s*mph/i);
  const mph = mphMatch ? parseInt(mphMatch[1]) : 0;
  const blowingOut = windStr.includes('out');
  const blowingIn  = windStr.includes('in from');

  const tempFactor = Math.max(0.92, Math.min(1.08, 1 + (tempF - 72) * 0.0018));
  let windFactor = 1.0;
  if (mph >= 5) {
    const str = Math.min(0.06, mph * 0.004);
    if (blowingOut)     windFactor = 1 + str;
    else if (blowingIn) windFactor = 1 - str;
  }
  return Math.max(0.90, Math.min(1.10, tempFactor * windFactor));
}

// ---------------------------------------------------------------------------
// Umpire run factor: pitcher-friendly umps suppress scoring for both teams
// kAdj = % point change in K rate; bbAdj = % point change in BB rate
// ---------------------------------------------------------------------------
function umpireRunFactor(umpireName) {
  const t = getUmpTendency(umpireName);
  if (!t.kAdj && !t.bbAdj) return 1.0;
  return Math.max(0.94, Math.min(1.06, 1 + (t.bbAdj * 0.006) - (t.kAdj * 0.004)));
}

// ---------------------------------------------------------------------------
// Run distribution
// ---------------------------------------------------------------------------
// MLB team runs/game are overdispersed: variance ≈ 2× the mean (bursty innings,
// correlated scoring), not variance == mean as Poisson assumes. Modeling runs as
// independent Poisson therefore understates game variance and pushes win
// probabilities too far from 0.5 (overconfidence). We use a negative binomial
// with the same mean but a tunable variance-to-mean ratio.
//
// RUN_DISPERSION = variance / mean. 1.0 == Poisson; ~2.0 matches observed MLB
// run variance. Raise it to compress win probabilities toward 0.5, lower it to
// widen them. Tune against calibration-history.json (model avg favorite win% vs
// realized rate). For NB: var = mean + mean^2/r ⇒  r = mean / (RUN_DISPERSION - 1).
const RUN_DISPERSION = 2.0;

// WINPROB_GAP_REGRESSION shrinks the home/away expected-run gap toward its mean
// before the win/spread probability calc. The offense/pitching factors are noisy
// estimates that produce run differentials wider than reality supports, leaving
// the model overconfident even after the NB variance fix. Shrinking the gap toward
// its mean preserves the total exactly, so this affects ONLY the moneyline/spread
// split — O/U totals, the O/U line, and displayed expected runs are untouched.
// 1.0 == no regression. 0.82 is the TYPICAL-CASE CENTER (noon freeze, lineups not yet
// confirmed); gameGapRegression varies the actual value per game by input confidence
// around this center. Lower over-shrinks; raise toward 1.0 to trust raw run gaps more.
// Re-tune this center jointly with RUN_DISPERSION and RUN_CORR_SHOCK against
// calibration-history.json (model avg favorite win% vs realized rate per bucket).
const WINPROB_GAP_REGRESSION = 0.82;

// Per-game uncertainty shrinkage: a global gap regression treats a game between two
// established starters with confirmed lineups the same as one with a rookie call-up
// and a TBD lineup. We instead shrink the gap MORE (trust it less) when the inputs
// are thin. Centered so the typical noon game (established SPs, lineups not yet
// confirmed) returns ~WINPROB_GAP_REGRESSION; fully-confident games trust the gap more.
function gameGapRegression(matchup, awaySPId, homeSPId) {
  let reg = WINPROB_GAP_REGRESSION + 0.04; // 0.86 fully-confident ceiling
  const ls = matchup.lineupSource || {};
  if (ls.home !== 'confirmed') reg -= 0.02;
  if (ls.away !== 'confirmed') reg -= 0.02;
  for (const id of [awaySPId, homeSPId]) {
    const ip = pitcherStatCache[id]?.ip || 0;
    if      (ip > 0 && ip < 20) reg -= 0.10; // very thin starter sample → big shrink
    else if (ip > 0 && ip < 40) reg -= 0.05;
  }
  return Math.max(WINPROB_GAP_REGRESSION - 0.08, Math.min(WINPROB_GAP_REGRESSION + 0.06, reg));
}

// RUN_CORR_SHOCK: variance of a shared game-environment multiplier applied to BOTH
// teams' expected runs (weather swings, an unexpectedly tight/loose strike zone, pace
// — conditions that move both offenses together). The two teams' scores were modeled
// as independent; a shared shock induces the real positive correlation. Mean-preserving
// (E[shock]=1), so the projected total and O/U line are unchanged in expectation; it
// mainly widens the total distribution and slightly affects the run-line/moneyline.
// 0 == independent (old behavior). Tune jointly with RUN_DISPERSION / gap center.
const RUN_CORR_SHOCK = 0.04;

// Lanczos approximation for ln Γ(x) — lets the NB use a fractional dispersion r.
function lgamma(x) {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Poisson PMF via log-space — fallback when RUN_DISPERSION ≈ 1 (no overdispersion).
function poissonPmf(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let log = k * Math.log(lambda) - lambda;
  for (let i = 1; i <= k; i++) log -= Math.log(i);
  return Math.exp(log);
}

// Negative-binomial PMF with mean `mean` and dispersion r (r→∞ ⇒ Poisson).
// p = r/(r+mean); P(X=k) = Γ(k+r)/(Γ(r)·k!) · p^r · (1-p)^k
function negBinomPmf(mean, k, r) {
  if (mean <= 0) return k === 0 ? 1 : 0;
  const p = r / (r + mean);
  const logPmf = lgamma(k + r) - lgamma(r) - lgamma(k + 1)
               + r * Math.log(p) + k * Math.log(1 - p);
  return Math.exp(logPmf);
}

// Shared game-environment shock grid — a 3-point distribution with mean 1 and
// variance RUN_CORR_SHOCK, applied to BOTH teams' run means to induce correlation.
function shockGrid() {
  if (RUN_CORR_SHOCK <= 0) return [{ m: 1, w: 1 }];
  const d = Math.min(0.60, Math.sqrt(2 * RUN_CORR_SHOCK));
  return [{ m: 1 - d, w: 0.25 }, { m: 1, w: 0.5 }, { m: 1 + d, w: 0.25 }];
}

// ---------------------------------------------------------------------------
// Single-pass loop: win prob, O/U, and run-line spread in one iteration. Mixed
// over the shared-shock grid so the two teams' scores are positively correlated.
// ---------------------------------------------------------------------------
function computeGameProbabilities(lambdaHome, lambdaAway, ouLine) {
  const MAX = 32; // NB has a fatter tail than Poisson — widen grid so O/U mass isn't truncated
  const useNB = RUN_DISPERSION > 1.0001;
  const grid  = shockGrid();

  let homeWins = 0, awayWins = 0, ties = 0;
  let overProb = 0, homeCoversProb = 0, awayCoversProb = 0;
  for (const { m, w } of grid) {
    const lh = lambdaHome * m, la = lambdaAway * m;
    const rHome = useNB ? lh / (RUN_DISPERSION - 1) : 0;
    const rAway = useNB ? la / (RUN_DISPERSION - 1) : 0;
    // Precompute the away PMF once per shock level (reused across every home value).
    const aP = new Array(MAX + 1);
    for (let a = 0; a <= MAX; a++) aP[a] = useNB ? negBinomPmf(la, a, rAway) : poissonPmf(la, a);
    for (let h = 0; h <= MAX; h++) {
      const pH = (useNB ? negBinomPmf(lh, h, rHome) : poissonPmf(lh, h)) * w;
      for (let a = 0; a <= MAX; a++) {
        const p = pH * aP[a];
        if      (h > a) homeWins += p;
        else if (a > h) awayWins += p;
        else            ties     += p;
        if (h + a > ouLine)  overProb       += p;
        if (h >= a + 2)      homeCoversProb += p;
        if (a >= h + 2)      awayCoversProb += p;
      }
    }
  }
  // Ties are resolved in extra innings — allocate by relative scoring strength
  // rather than a flat home edge.
  const homeTieShare = lambdaHome / (lambdaHome + lambdaAway);
  const hFinal = homeWins + ties * homeTieShare;
  const aFinal = awayWins + ties * (1 - homeTieShare);
  const total  = hFinal + aFinal;
  return {
    homeWinPct:     hFinal / total,
    awayWinPct:     aFinal / total,
    overProb,
    underProb:      1 - overProb,
    homeCoversProb,
    awayCoversProb,
  };
}

function fmtOdds(p) {
  p = Math.max(0.0001, Math.min(0.9999, p));
  const o = p >= 0.5
    ? Math.round(-p / (1 - p) * 100)
    : Math.round(((1 - p) / p) * 100);
  return (o > 0 ? '+' : '') + o;
}

// ---------------------------------------------------------------------------
// SP effective ERA: blend season ERA with FIP (more predictive), then recent form
// ---------------------------------------------------------------------------
function effectiveSPEra(spId, isHome) {
  const pSt     = pitcherStatCache[spId]   || {};
  const pRecent = pitcherRecentCache[spId] || {};
  const pSplit  = pitcherSplitCache[spId]  || {};
  if (!pSt.era) return LG_ERA;
  const ip = pSt.ip || 0;
  // Bayesian regression toward league average for small IP samples.
  // 40 IP regression weight — a pitcher with 10 IP at 1.93 ERA regresses to ~3.75.
  // Above 80 IP the correction is <5% and essentially silent.
  const REGRESSION_IP = 40;
  let baseEra = ip < REGRESSION_IP
    ? (pSt.era * ip + LG_ERA * (REGRESSION_IP - ip)) / REGRESSION_IP
    : pSt.era;
  // FIP blend: FIP removes defense and suppresses ERA noise (requires ≥30 IP)
  if (pSt.fip != null && ip >= 30) {
    baseEra = baseEra * 0.35 + pSt.fip * 0.65;
  }
  // Home/away context: blend in split ERA when sample ≥20 IP (≈3+ starts in context)
  const contextEra = isHome ? pSplit.eraHome : pSplit.eraAway;
  const contextIp  = isHome ? pSplit.ipHome  : pSplit.ipAway;
  if (contextEra != null && contextIp >= 20) {
    baseEra = baseEra * 0.70 + contextEra * 0.30;
  }
  // Contact quality proxy: OPS allowed vs league avg — catches ERA luck (strand rate, sequencing)
  const totalPa = (pSplit.paVsL || 0) + (pSplit.paVsR || 0);
  if (pSplit.opsVsL != null && pSplit.opsVsR != null && totalPa >= 50) {
    const opsAllowed    = (pSplit.opsVsL * (pSplit.paVsL || 0) + pSplit.opsVsR * (pSplit.paVsR || 0)) / totalPa;
    const contactFactor = Math.max(0.93, Math.min(1.07, opsAllowed / LG_OPS_AGAINST));
    baseEra *= contactFactor;
  }
  // Statcast xERA — quality-of-contact based, strips defense/sequencing/BABIP luck;
  // more predictive of future ERA than ERA itself. Blend once the sample is stable.
  const sp = getSavantPitcherData()[spId];
  if (sp && sp.xera != null && ip >= 20) {
    baseEra = baseEra * 0.55 + sp.xera * 0.45;
  }
  // Recent form: last 3 starts (requires ≥8 IP in last 3)
  if (pRecent.recentEra != null && pRecent.ip3 >= 8)
    return baseEra * 0.60 + pRecent.recentEra * 0.40;
  return baseEra;
}

// ---------------------------------------------------------------------------
// SP average innings per start — determines bullpen exposure
// ---------------------------------------------------------------------------
function avgIpPerStart(spId) {
  const st       = pitcherStatCache[spId] || {};
  const gamesS   = st.gamesS || 0;
  const gamesP   = st.gamesP || gamesS;
  const reliefApps = Math.max(0, gamesP - gamesS);
  // Opener/bulk reliever: mostly relief appearances with occasional starts
  // Their total IP inflates ip/gamesS, and they realistically pitch 2-3 innings as "starter"
  const isOpener = gamesS < 3 || reliefApps > gamesS * 2;
  if (isOpener) return 2.5;
  if (st.ip && gamesS >= 5) return Math.min(7.0, Math.max(3.5, st.ip / gamesS));
  if (st.ip && gamesS >= 1) return Math.min(6.5, Math.max(3.5, st.ip / gamesS));
  return 5.5; // no starts or no IP data
}

// ---------------------------------------------------------------------------
// Bullpen fatigue: inflates a reliever's effective ERA based on recent workload
// ---------------------------------------------------------------------------
function fatigueMultiplier(id) {
  const rest = rpAppearanceCache[id];
  if (!rest) return 1.0;
  let mult = 1.0;
  if      (rest.daysRest === 0)                mult = 1.25; // pitched today
  else if (rest.daysRest === 1 && rest.g3 >= 2) mult = 1.15; // back-to-back appearances
  else if (rest.daysRest === 1)                mult = 1.07; // one day rest
  if ((rest.pitches3 || 0) >= 40)             mult = Math.max(mult, 1.10); // high pitch load
  return mult;
}

// ---------------------------------------------------------------------------
// Bullpen profile: leverage- and availability-weighted ERA, fatigue + platoon
// adjusted, plus a bad-script (early-hook) tail and a high-leverage subset.
// ---------------------------------------------------------------------------
// Reliever role from season usage (same thresholds as buildBullpenSide in mlbApi).
function rpRole(pSt) {
  if ((pSt.saves || 0) >= 5 || (pSt.saveOpps || 0) >= 5) return 'Closer';
  if ((pSt.holds || 0) >= 5)                              return 'Setup';
  return 'Middle';
}
// Leverage weights — games are decided by the best 2-3 arms, not the pen mean.
// Mean-neutral: a pen with uniform ERA returns that ERA under ANY positive weights.
const LEVERAGE_W = { Closer: 1.5, Setup: 1.3, Middle: 0.85 };

function bullpenProfile(rows) {
  // Lineup L/R breakdown — determines how platoon matchups work against this bullpen.
  // Bat side is stored as `hand` on the matchup batter object (was read as batSide → undefined).
  let lhbCount = 0, totalBatters = 0;
  for (const row of (rows || [])) {
    if (row.batter?.hand) {
      if (row.batter.hand === 'L') lhbCount++;
      totalBatters++;
    }
  }
  const lhbFraction = totalBatters > 0 ? lhbCount / totalBatters : 0.35;

  const rpIds = new Set();
  for (const row of (rows || [])) {
    for (const p of (row.pitchers || [])) {
      if (p.pitcher.role === 'RP') rpIds.add(p.pitcher.id);
    }
  }
  const arms = [];
  for (const id of rpIds) {
    const st     = pitcherStatCache[id];
    const pSplit = pitcherSplitCache[id];
    if (st?.era == null || (st.ip || 0) < 5) continue;
    // Rotation starters get tagged 'RP' for every game they aren't today's confirmed
    // starter (getPitchingStaff has no other signal), but a real starter essentially
    // never actually appears in relief outside deep extras — and their last START
    // (e.g. 100 pitches 2 days ago) isn't relief workload, so including them both
    // misrepresents bullpen depth and corrupts the fatigue read for genuine relievers.
    if ((st.gamesS || 0) > 2) continue;
    let era = st.era * fatigueMultiplier(id);
    // Platoon adjustment: inflate/deflate ERA based on handedness matchup
    if (pSplit?.opsVsL != null && pSplit?.opsVsR != null &&
        (pSplit.paVsL || 0) >= 20 && (pSplit.paVsR || 0) >= 20) {
      const platoonOps    = pSplit.opsVsL * lhbFraction + pSplit.opsVsR * (1 - lhbFraction);
      const platoonFactor = Math.max(0.88, Math.min(1.15, platoonOps / LG_OPS_AGAINST));
      era *= platoonFactor;
    }
    // Availability depth — beyond the binary pitched-today exclusion, down-weight
    // arms worn down by recent use (back-to-back, or 40+ pitches over 3 days). They
    // are less likely to be used tonight and less effective if they are.
    const rest = rpAppearanceCache[id] || {};
    let availW = 1.0;
    if      (rest.daysRest === 1 && (rest.g3 || 0) >= 2) availW = 0.70;
    else if ((rest.pitches3 || 0) >= 40)                availW = 0.85;
    const rpXslg   = getSavantPitcherData()[id]?.xslg ?? null;
    const rpBarrel = getSavantPitcherData()[id]?.barrelPctAllowed ?? null;
    arms.push({ era, ip: st.ip, role: rpRole(st), available: rest.daysRest !== 0, availW, xslg: rpXslg, barrel: rpBarrel });
  }
  if (!arms.length) return { leverageEra: LG_BP_ERA, badScriptEra: LG_BP_ERA, highLevEra: LG_BP_ERA };

  // Arms that pitched today are essentially unavailable tonight. Fall back to the
  // full pen only if exclusion leaves too little IP to trust.
  let pool = arms.filter(e => e.available);
  if (pool.reduce((s, e) => s + e.ip, 0) < 40) pool = arms;

  const wMean = (list, wf) => {
    let num = 0, den = 0;
    for (const a of list) { const w = wf(a); num += a.era * w; den += w; }
    return den > 0 ? num / den : LG_BP_ERA;
  };
  // Headline: leverage- and availability-weighted ERA of the realistic pen.
  const leverageEra = wMean(pool, a => a.ip * LEVERAGE_W[a.role] * a.availW);
  // xSLG-allowed: same weighting as leverageEra — expected slugging permitted by the pen.
  // Mirrors the SP xSLG factor in effectivePitchingFactor so the bullpen innings get the
  // same contact-quality adjustment as the starter's innings.
  const xslgPool = pool.filter(a => a.xslg != null);
  const leverageXslg = xslgPool.length > 0
    ? xslgPool.reduce((s, a) => s + a.xslg * a.ip * LEVERAGE_W[a.role] * a.availW, 0) /
      xslgPool.reduce((s, a) => s + a.ip * LEVERAGE_W[a.role] * a.availW, 0)
    : null;
  // Barrel%-allowed: same leverage weighting, mirrors the SP barrel factor.
  const barrelPool = pool.filter(a => a.barrel != null);
  const leverageBarrel = barrelPool.length > 0
    ? barrelPool.reduce((s, a) => s + a.barrel * a.ip * LEVERAGE_W[a.role] * a.availW, 0) /
      barrelPool.reduce((s, a) => s + a.ip * LEVERAGE_W[a.role] * a.availW, 0)
    : null;
  // Bad-script tail: when the starter is knocked out early, the low-leverage (Middle)
  // arms eat the innings. Fall back to the whole pen if the mop-up corps is too thin.
  let mop = pool.filter(a => a.role === 'Middle');
  if (mop.reduce((s, a) => s + a.ip, 0) < 15) mop = pool;
  const badScriptEra = wMean(mop, a => a.ip * a.availW);
  // High-leverage subset (Closer + Setup) — for the penLeverageEdge shadow.
  let hl = pool.filter(a => a.role !== 'Middle');
  if (!hl.length) hl = pool;
  const highLevEra = wMean(hl, a => a.ip * a.availW);

  return { leverageEra, badScriptEra, highLevEra, leverageXslg, leverageBarrel };
}

// Starter reliability → how much of the bullpen's exposure is normal-script (the
// leverage pen) vs bad-script (early hook → mop-up arms). Deep starters lean on the
// good pen; short starters/openers expose the bad-script tail more. Kept modest
// (bad-script weight 10-28%) so the effect is realistic, not a lurch.
function spReliability(spId) {
  const ip = avgIpPerStart(spId);
  return Math.max(0.72, Math.min(0.90, 0.80 + (ip - 5.5) * 0.06));
}

// Bullpen availability score: fraction of the pen's IP that did NOT pitch today
// (≈ how rested/deep the pen is tonight). 1.0 = fully available, lower = depleted.
function bullpenAvailability(rows) {
  const ids = new Set();
  for (const row of (rows || [])) {
    for (const p of (row.pitchers || [])) {
      if (p.pitcher.role === 'RP') ids.add(p.pitcher.id);
    }
  }
  let availIp = 0, totalIp = 0;
  for (const id of ids) {
    const st = pitcherStatCache[id];
    if (st?.era == null || (st.ip || 0) < 5) continue;
    totalIp += st.ip;
    if (rpAppearanceCache[id]?.daysRest !== 0) availIp += st.ip;
  }
  return totalIp > 0 ? Math.max(0.4, availIp / totalIp) : 1.0;
}

// Handedness mismatch: fraction of a lineup's PAs expected to face a SAME-handed
// pitcher (the platoon-disadvantaged state), weighting the opposing staff as ~55%
// starter + ~45% bullpen. Switch hitters always hold the platoon edge (0). Higher =
// more disadvantaged. Shadow-only for now — per-batter splits already carry most of
// the platoon signal live, so this measures the residual team-construction effect.
function handednessMismatch(rows) {
  if (!rows || !rows.length) return 0.5;
  const pitchers = rows[0].pitchers || [];
  const sp  = pitchers.find(p => p.pitcher.role === 'SP');
  const rps = pitchers.filter(p => p.pitcher.role === 'RP');
  const spIsR  = sp ? (sp.pitcher.hand !== 'L') : true;
  const penR   = rps.length ? rps.filter(p => p.pitcher.hand !== 'L').length / rps.length : 0.7;
  const staffR = 0.55 * (spIsR ? 1 : 0) + 0.45 * penR; // share of innings thrown by RHP
  let sum = 0, n = 0;
  for (const row of rows) {
    const bs = row.batter?.hand; // bat side (matchup objects store it as `hand`)
    if (!bs) continue;
    n++;
    if (bs === 'S') continue;                       // switch hitter → never same-handed
    sum += bs === 'R' ? staffR : (1 - staffR);      // RHB disadvantaged by RHP share, LHB by LHP share
  }
  return n > 0 ? sum / n : 0.5;
}

// Pitch-arsenal matchup: a lineup's usage-weighted run value (per 100, batter
// perspective) against the opposing SP's specific pitch mix. Positive = the lineup
// handles this SP's arsenal well. Sign assumes Savant batter run_value_per_100 is
// batter-positive; if the shadow's lift comes out inverted, flip it. Returns null
// when the SP arsenal or too few batters are missing.
function arsenalMatchup(lineupRows, spId) {
  const arsenal = getPitcherArsenal()[spId];
  if (!arsenal) return null;
  const bArs = getBatterArsenal();
  const usageTotal = Object.values(arsenal).reduce((s, u) => s + u, 0) || 1;
  let sum = 0, matched = 0;
  for (const row of (lineupRows || [])) {
    const bv = bArs[row.batter.id];
    if (!bv) continue;
    let score = 0, w = 0;
    for (const [pt, usage] of Object.entries(arsenal)) {
      if (bv[pt] == null) continue;
      score += bv[pt] * usage; w += usage;
    }
    if (w > 0) { sum += score / usageTotal; matched++; }
  }
  return matched >= 4 ? sum / matched : null;
}

// Schedule fatigue index [0,1]: a team grinding consecutive games with no recent
// off day (and/or deep into a road trip) is more fatigued. An off day resets it.
function scheduleFatigue(s) {
  if (!s) return 0;
  let f = s.restDays >= 2 ? 0 : Math.min(1, (s.consecutive || 1) / 9);
  if ((s.awayLast7 || 0) >= 6) f += 0.15; // long road trip
  return Math.min(1, f);
}

// SP run support: the team's realized scoring in this starter's games relative to their
// season norm (ratio from getSpRunSupport, attached to the matchup). Captures the "great
// pitcher, the team doesn't score for him / keeps losing his starts" pattern — opponent
// (ace-vs-ace) clustering and other SP-conditional offense effects the independent
// offense & pitching factors miss. Heavily regressed by sample (much of the ~15-start
// spread is noise) and clamped tight; modest live weight, logged as suppEdge for lift
// review. Applies to the team's OWN offense (its SP's run support), so it's asymmetric
// and moves the moneyline.
const RUNSUPP_SENS  = 0.5;   // fraction of the regressed ratio deviation applied to offense
const RUNSUPP_K     = 12;    // sample regression: weight = starts / (starts + K)
const RUNSUPP_CLAMP = 0.05;  // ±5% cap — tail guard for a new, noisy, not-yet-lift-validated signal
function runSupportFactor(rs) {
  if (!rs || rs.ratio == null || (rs.starts || 0) < 6) return 1.0;
  const w   = rs.starts / (rs.starts + RUNSUPP_K);
  const dev = (rs.ratio - 1) * w * RUNSUPP_SENS;
  return Math.max(1 - RUNSUPP_CLAMP, Math.min(1 + RUNSUPP_CLAMP, 1 + dev));
}

// ---------------------------------------------------------------------------
// Recent lineup form: compares each batter's 14-game OBP to season OBP
// Returns a factor [0.92, 1.08] — blended 50% toward 1.0 to avoid overreaction
// ---------------------------------------------------------------------------
function recentLineupFactor(rows) {
  let weightedSum = 0, totalWeight = 0;
  for (const row of (rows || [])) {
    const bRecent = recentBatterCache[row.batter.id];
    const s       = batterSplitCache[row.batter.id];
    if (!bRecent?.obp14 || !s?.obp || s.obp <= 0 || bRecent.pa14 < 10 || s.pa < 50) continue;
    const ratio  = Math.max(0.70, Math.min(1.30, bRecent.obp14 / s.obp));
    const order  = row.batter.battingOrder;
    const weight = (order >= 1 && order <= 9) ? ORDER_PA[order - 1] : 3.9;
    weightedSum += ratio * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return 1.0;
  const raw = weightedSum / totalWeight;
  // 14-game form graded as an ANTI-signal — formEdge pointed at the winner only ~41-47%
  // across 200+ resolved games (hot streaks mean-revert, so up-weighting them backfires).
  // Down-weighted to 25% influence (was 50%) and clamped tighter [0.95,1.05] pending the
  // joint re-tune; still logged as formEdge so its lift can be re-measured.
  return Math.max(0.95, Math.min(1.05, 0.75 + raw * 0.25));
}

// ---------------------------------------------------------------------------
// Lineup OPS: use the batter's split vs opposing SP's handedness when available
// ---------------------------------------------------------------------------
function avgLineupOps(rows) {
  if (!rows || !rows.length) return LG_OPS;
  let weightedSum = 0, totalWeight = 0;
  for (const row of rows) {
    const s = batterSplitCache[row.batter.id];
    if (!s) continue;
    const spEntry = row.pitchers?.find(p => p.pitcher.role === 'SP');
    const spHand  = spEntry?.pitcher?.hand ?? 'R';
    let ops;
    // Prefer hand-specific split when sample is sufficient (≥20 PA)
    if (spHand === 'L' && s.opsVsL != null && (s.paVsL || 0) >= 20) {
      ops = s.opsVsL;
    } else if (spHand === 'R' && s.opsVsR != null && (s.paVsR || 0) >= 20) {
      ops = s.opsVsR;
    } else {
      // Fall back to PA-weighted blend of both sides
      const totalPa = (s.paVsL || 0) + (s.paVsR || 0);
      if (s.opsVsL != null && s.opsVsR != null && totalPa > 0) {
        ops = (s.opsVsL * (s.paVsL || 0) + s.opsVsR * (s.paVsR || 0)) / totalPa;
      } else if (s.opsVsR != null && (s.paVsR || 0) > 0) {
        ops = s.opsVsR;
      } else if (s.opsVsL != null && (s.paVsL || 0) > 0) {
        ops = s.opsVsL;
      } else if (s.obp != null) {
        ops = s.obp * 1.75;
      } else {
        continue;
      }
    }
    // Prior-season anchor: a thin current-season sample is noisy this early in the
    // year, so regress toward last year's OPS by current PA (w = pa/(pa+150)).
    // Established regulars (high PA) are essentially untouched.
    // YoY regression guard: when a batter's wOBA has meaningfully dropped year-over-year,
    // pulling toward the inflated prior line is wrong — trust the current (lower) stats.
    const samplePa = (s.paVsL || 0) + (s.paVsR || 0);
    if (s.opsPrior != null && samplePa < 300) {
      let w = samplePa / (samplePa + 150);
      if (s.yoyTrend && s.yoyTrend.direction === 'regression') {
        const shrink = s.yoyTrend.severity === 'severe' ? 0.15 : s.yoyTrend.severity === 'significant' ? 0.40 : 0.65;
        w = 1 - (1 - w) * shrink;
      }
      ops = ops * w + s.opsPrior * (1 - w);
    }
    // Weight by expected PA contribution from this lineup slot
    const order  = row.batter.battingOrder;
    const weight = (order >= 1 && order <= 9) ? ORDER_PA[order - 1] : 3.9;
    weightedSum += ops * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : LG_OPS;
}

// ---------------------------------------------------------------------------
// Lineup xwOBA: batting-order-weighted average of each batter's Statcast xwOBA.
// xwOBA strips BABIP/sequencing luck, so it predicts future offense better than
// OPS. Returns null when too few batters have a Savant entry to trust.
// ---------------------------------------------------------------------------
function avgLineupXwoba(rows) {
  if (!rows || !rows.length) return null;
  const sav = getSavantData();
  let weightedSum = 0, totalWeight = 0, matched = 0;
  for (const row of rows) {
    const s = sav[row.batter.id];
    if (!s || s.xwoba == null) continue;
    const order  = row.batter.battingOrder;
    const weight = (order >= 1 && order <= 9) ? ORDER_PA[order - 1] : 3.9;
    weightedSum += s.xwoba * weight;
    totalWeight += weight;
    matched++;
  }
  return matched >= 5 && totalWeight > 0 ? weightedSum / totalWeight : null;
}

// ---------------------------------------------------------------------------
// Fastball velocity factor: ERA/FIP/xERA are lagging outcomes — a velocity drop
// (injury/decline) shows up here before the run prevention catches up. Below the
// league baseline raises the run factor (worse), above lowers it. Modest & clamped
// (±3%); mean-neutral at the baseline. Season-level — velo TREND/IL-return needs a
// rolling game-log source (deferred).
const LG_FB_VELO = 93.8; // league-average primary-fastball velocity (mph)
const VELO_SENS  = 0.006; // run-factor change per mph off baseline
function veloFactor(spId) {
  const v = getPitcherFbVelo()[spId];
  if (v == null) return 1.0;
  return Math.max(0.97, Math.min(1.03, 1 - (v - LG_FB_VELO) * VELO_SENS));
}

// ---------------------------------------------------------------------------
// Blended pitching factor: SP quality weighted by expected innings + bullpen
// ---------------------------------------------------------------------------
function effectivePitchingFactor(spId, bpEra, isHome, bpXslg = null, bpBarrel = null) {
  const spEra  = effectiveSPEra(spId, isHome);
  const spIp   = avgIpPerStart(spId);
  const bpIp   = 9 - spIp;
  // SP xSLG-allowed: incremental signal beyond ERA/FIP — validated +0.010 AUC for TB props
  // (+ games). Same logic applies to run totals: a pitcher giving up
  // hard contact (high xSLG-allowed) surrenders more runs than ERA alone captures, and
  // vice versa for pitchers beating ERA via soft contact / weak sequencing.
  // Conservative cap [0.92, 1.08] — tighter than individual TB props since ERA/FIP already
  // partially captures this, and run totals are team-level (individual variance is averaged out).
  const pSav       = getSavantPitcherData()[spId];
  // Sensitivity reduced to 0.25 (vs 0.40 in TB props) because effectiveSPEra already
  // blends in xERA (45% weight, line ~289) which is correlated with xSLG-allowed.
  // Applying full sensitivity on top of xERA would double-count the same Statcast signal.
  const xslgFactor = pSav?.xslg != null
    ? Math.max(0.94, Math.min(1.06, 1 + (pSav.xslg / 0.390 - 1) * 0.25))
    : 1.0;
  // SP barrel%-allowed: validated (244-pitcher sample) to correlate with actual
  // HR/9 allowed AS STRONGLY as xSLG-allowed (r=0.685 vs 0.658), and to retain real
  // incremental signal even after controlling for xSLG-allowed (residual r=0.249) — not
  // redundant despite both being Statcast contact-quality metrics. BUT xSLG-allowed and
  // barrel%-allowed are themselves correlated (r=0.756) — a pitcher extreme on one tends
  // to be extreme on the other, so stacking two independent ±6% factors could compound to
  // ~±12% for the same underlying "hard/soft contact allowed" pitcher, well past what the
  // validated incremental signal (residual r=0.249, a modest add-on, not a doubling)
  // justifies. Tighter cap here (±4%, vs xSLG's ±6%) keeps the COMBINED swing reasonable.
  const LG_BARREL_ALLOWED = 7.74;
  const barrelFactor = pSav?.barrelPctAllowed != null
    ? Math.max(0.96, Math.min(1.04, 1 + (pSav.barrelPctAllowed / LG_BARREL_ALLOWED - 1) * 0.20))
    : 1.0;
  const spFactor = Math.max(0.55, Math.min(1.60, (spEra / LG_ERA) * ttoMultiplier(spId) * veloFactor(spId) * xslgFactor * barrelFactor));
  // BP xSLG-allowed: same incremental adjustment as SP, applied to the bullpen innings.
  // Same conservative sensitivity (0.25) and tight cap [0.94, 1.06] to avoid double-counting
  // with the ERA-based bpFactor. bpXslg passed in from bullpenProfile.leverageXslg.
  const bpXslgFactor = bpXslg != null
    ? Math.max(0.94, Math.min(1.06, 1 + (bpXslg / 0.390 - 1) * 0.25))
    : 1.0;
  // BP barrel%-allowed — same tightened cap as the SP side, same correlated-factor reasoning.
  const bpBarrelFactor = bpBarrel != null
    ? Math.max(0.96, Math.min(1.04, 1 + (bpBarrel / LG_BARREL_ALLOWED - 1) * 0.20))
    : 1.0;
  const bpFactor = Math.max(0.65, Math.min(1.55, bpEra / LG_BP_ERA * bpXslgFactor * bpBarrelFactor));
  return (spFactor * spIp + bpFactor * bpIp) / 9;
}

// Times-through-order penalty: a starter degrades each pass through the lineup
// (3rd time ≈ +0.3-0.5 run). Deeper starters (high IP/start) accrue more 3rd-time
// exposure, so bump their run factor modestly. Conservative — deep outings also
// signal quality, so kept small and shadow-logged (ttoEdge) for later lift review.
const TTO_STRENGTH = 0.06;
function ttoMultiplier(spId) {
  const ip = avgIpPerStart(spId);
  const exposure = Math.max(0, Math.min(1, (ip - 4.5) / 4.5)); // 0 below 4.5 IP, ramps after
  return 1 + exposure * TTO_STRENGTH;
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------
function computeWinPredictions() {
  const results = [];

  for (const matchup of Object.values(matchupCache)) {
    const { home, away, venueName, weather, awayPitchingVsHome, homePitchingVsAway } = matchup;
    if (!awayPitchingVsHome?.length || !homePitchingVsAway?.length) continue;

    // awayPitchingVsHome: home batters face away pitchers → away team's pitching staff
    // homePitchingVsAway: away batters face home pitchers → home team's pitching staff
    const awaySPEntry = awayPitchingVsHome[0].pitchers.find(p => p.pitcher.role === 'SP');
    const homeSPEntry = homePitchingVsAway[0].pitchers.find(p => p.pitcher.role === 'SP');
    if (!awaySPEntry || !homeSPEntry) continue;

    const awaySPId = awaySPEntry.pitcher.id;
    const homeSPId = homeSPEntry.pitcher.id;

    // Lineup OPS vs opposing SP handedness, and luck-stripped lineup xwOBA
    const homeOffOps   = avgLineupOps(awayPitchingVsHome);
    const awayOffOps   = avgLineupOps(homePitchingVsAway);
    const homeOffXwoba = avgLineupXwoba(awayPitchingVsHome); // home batters
    const awayOffXwoba = avgLineupXwoba(homePitchingVsAway); // away batters

    // Bullpen profile for each team (leverage-weighted headline + bad-script tail)
    const awayPen = bullpenProfile(awayPitchingVsHome); // away pitchers (SP+RP) face home batters
    const homePen = bullpenProfile(homePitchingVsAway); // home pitchers (SP+RP) face away batters
    const awayBpEra = awayPen.leverageEra; // headline (display + bullpen-edge factor)
    const homeBpEra = homePen.leverageEra;
    // Bad-script blend: short/volatile starters expose the mop-up arms more often.
    const awayBpEff = awayBpEra * spReliability(awaySPId) + awayPen.badScriptEra * (1 - spReliability(awaySPId));
    const homeBpEff = homeBpEra * spReliability(homeSPId) + homePen.badScriptEra * (1 - spReliability(homeSPId));

    // Effective pitching factor: SP (ERA+FIP+recent+home/away context) blended with BP by innings
    // awaySP is pitching away; homeSP is pitching at home
    const awayPitchFactor = effectivePitchingFactor(awaySPId, awayBpEff, false, awayPen.leverageXslg, awayPen.leverageBarrel);
    const homePitchFactor = effectivePitchingFactor(homeSPId, homeBpEff, true,  homePen.leverageXslg, homePen.leverageBarrel);

    // Umpire run factor — pitcher-friendly umps suppress scoring for both teams
    const urf = umpireRunFactor(matchup.umpire);

    // Standings RS/G — blend 30% actual run production alongside 70% matchup-specific OPS
    const standings   = standingsCache.data || {};
    const homeRecord  = standings[home.teamId];
    const awayRecord  = standings[away.teamId];
    const homeRsPerG  = homeRecord?.gamesPlayed >= 10 ? homeRecord.runsScored / homeRecord.gamesPlayed : null;
    const awayRsPerG  = awayRecord?.gamesPlayed >= 10 ? awayRecord.runsScored / awayRecord.gamesPlayed : null;
    // Offense quality = OPS-based, blended 50/50 with xwOBA-based when available.
    // xwOBA fades BABIP/sequencing luck, sharpening the run estimate and the moneyline.
    const homeXwobaBased = homeOffXwoba != null ? homeOffXwoba / LG_XWOBA : null;
    const awayXwobaBased = awayOffXwoba != null ? awayOffXwoba / LG_XWOBA : null;
    const homeOpsBased = homeXwobaBased != null ? (homeOffOps / LG_OPS) * 0.5 + homeXwobaBased * 0.5 : homeOffOps / LG_OPS;
    const awayOpsBased = awayXwobaBased != null ? (awayOffOps / LG_OPS) * 0.5 + awayXwobaBased * 0.5 : awayOffOps / LG_OPS;
    const homeStndsFactor = homeRsPerG != null ? Math.max(0.80, Math.min(1.20, homeRsPerG / MLB_BASE_RUNS)) : null;
    const awayStndsFactor = awayRsPerG != null ? Math.max(0.80, Math.min(1.20, awayRsPerG / MLB_BASE_RUNS)) : null;
    const homeOffFactor = Math.max(0.75, Math.min(1.25,
      homeStndsFactor != null ? homeOpsBased * 0.70 + homeStndsFactor * 0.30 : homeOpsBased
    ));
    const awayOffFactor = Math.max(0.75, Math.min(1.25,
      awayStndsFactor != null ? awayOpsBased * 0.70 + awayStndsFactor * 0.30 : awayOpsBased
    ));
    const prf              = parkRunFactor(venueName);
    const wrf              = weatherRunFactor(weather);
    // Park handedness skew — per team by its lineup L/R mix. Asymmetric ⇒ moves the ML.
    const homeParkHand = parkHandFactor(venueName, lineupLhbFraction(awayPitchingVsHome)); // home batters
    const awayParkHand = parkHandFactor(venueName, lineupLhbFraction(homePitchingVsAway)); // away batters
    const homeRecentFactor = recentLineupFactor(awayPitchingVsHome); // home batters
    const awayRecentFactor = recentLineupFactor(homePitchingVsAway); // away batters

    // Team defense (OAA/FRP) suppresses the OPPONENT's runs — invisible in ERA, so
    // it's an asymmetric signal that does NOT cancel in the win ratio. FRP is
    // season-cumulative runs prevented; normalize by games to a per-game factor.
    const teamDefenseFactor = (fullName, gp) => {
      const d = getTeamDefense(fullName);
      if (!d || d.frp == null || !gp || gp < 10) return 1.0;
      return Math.max(0.93, Math.min(1.07, 1 - (d.frp / gp) / MLB_BASE_RUNS));
    };
    const homeDefenseFactor = teamDefenseFactor(home.name, homeRecord?.gamesPlayed);
    const awayDefenseFactor = teamDefenseFactor(away.name, awayRecord?.gamesPlayed);

    // Schedule fatigue (live, small): a team grinding consecutive games / deep into a
    // road trip with no off day has its offense dip slightly. Asymmetric ⇒ moves the
    // win prob. Kept modest (≤3%); promoted from shadow after sign/scale review.
    const FATIGUE_STRENGTH = 0.03;
    const homeFatigueMult = 1 - scheduleFatigue(matchup.homeSchedule) * FATIGUE_STRENGTH;
    const awayFatigueMult = 1 - scheduleFatigue(matchup.awaySchedule) * FATIGUE_STRENGTH;

    // SP run support — each team's offense adjusted by how much it scores in tonight's
    // starter's games vs its season norm (modest, regressed, ≤6%). Asymmetric ⇒ moves the ML.
    const homeSuppMult = runSupportFactor(matchup.homeSpRunSupport);
    const awaySuppMult = runSupportFactor(matchup.awaySpRunSupport);

    // Matchup-interaction multipliers. Offense/pitching above are estimated
    // independently and multiplied; these capture the genuinely interactive edge.
    // - handEdge (platoon stacking): PROMOTED LIVE. Kept small/clamped — per-batter
    // platoon splits already carry most of it, so HAND_SENS is deliberately tiny.
    // - arsenalEdge (lineup-vs-arsenal fit): SHADOW ONLY. an audit script showed
    // it pointing at the winner just 35% of the time, so the
    // mults are computed for logging but NOT applied to run means until the direction
    // validates on new slates (then weight it, possibly with a flipped sign).
    const HAND_SENS = 0.04;  // handedness mismatch sensitivity (mismatch centered at 0.5)
    const ARS_SENS  = 0.012; // arsenal run-value/100 sensitivity (shadow scale only)
    const mismatchHome = handednessMismatch(awayPitchingVsHome); // home lineup
    const mismatchAway = handednessMismatch(homePitchingVsAway); // away lineup
    const homeHandMult = 1 - (mismatchHome - 0.5) * HAND_SENS;   // home lineup more same-hand ⇒ less offense
    const awayHandMult = 1 - (mismatchAway - 0.5) * HAND_SENS;
    const homeArsRaw = arsenalMatchup(awayPitchingVsHome, awaySPId); // home lineup vs away SP arsenal
    const awayArsRaw = arsenalMatchup(homePitchingVsAway, homeSPId); // away lineup vs home SP arsenal
    const homeArsMult = homeArsRaw != null ? Math.max(0.96, Math.min(1.04, 1 + homeArsRaw * ARS_SENS)) : 1.0;
    const awayArsMult = awayArsRaw != null ? Math.max(0.96, Math.min(1.04, 1 + awayArsRaw * ARS_SENS)) : 1.0;

    // Live weather → run-environment multiplier (Open-Meteo). Applied to BOTH sides, so it
    // is mean-symmetric: it moves the O/U total, NOT the moneyline win split (weather helps
    // both lineups equally). Modest vs the HR effect — temp/wind touch all offense, not just HR.
    const wl = matchup.weatherLive;
    let weatherRunMult = 1.0;
    if (wl) {
      // HEAT INDEX (feels-like), not air temp: humid air is LESS dense, so humid heat carries
      // MORE. Validated on 2,657 open-park games (2023-25 summers) — feels-like 100°F+ averaged
      // +1.4 runs vs base, a signal air temp misses (a 90° air / 100° feels-like game looked
      // ordinary by air temp). Sensitivity kept conservative + clamp modest: the raw bin gap is
      // partly park selection (hot parks skew hitter-friendly), which the park factor already
      // handles — the win here is humid games finally registering at all. Falls back to air temp.
      const feels = wl.feelsLikeF != null ? wl.feelsLikeF : wl.tempF;
      if (feels != null)         weatherRunMult *= Math.max(0.95, Math.min(1.07, 1 + (feels - 72) * 0.003));
      if (wl.outWindMph != null) weatherRunMult *= Math.max(0.94, Math.min(1.06, 1 + wl.outWindMph * 0.006));
      // Sun glare suppresses both lineups' offense (sun in the hitters' eyes). Sparse, conservative.
      if (wl.glareRunMult != null) weatherRunMult *= wl.glareRunMult;
    }

    // NOTE: homeArsMult/awayArsMult are intentionally NOT in the run product (shadow only).
    const homeExpRuns = Math.max(2.0, Math.min(9.0,
      MLB_BASE_RUNS * TOTAL_CALIBRATION * homeOffFactor * awayPitchFactor * awayDefenseFactor * homeFatigueMult * homeSuppMult * homeHandMult * prf * homeParkHand * HOME_ADV * wrf * urf * homeRecentFactor * weatherRunMult
    ));
    const awayExpRuns = Math.max(2.0, Math.min(9.0,
      MLB_BASE_RUNS * TOTAL_CALIBRATION * awayOffFactor * homePitchFactor * homeDefenseFactor * awayFatigueMult * awaySuppMult * awayHandMult * prf * awayParkHand * wrf * urf * awayRecentFactor * weatherRunMult
    ));
    const totalExpRunsRaw = homeExpRuns + awayExpRuns;
    // High-total dampener: multiplicative factor stacking pushes extreme predicted totals
    // beyond what actually materializes (~+1.2 bias at 10-12, +2.4 at 12+). Regress the
    // total toward the league mean (2 × BASE) proportionally to how far it deviates.
    // Gentle below 10 (well-calibrated bucket), progressive above. Each side scaled
    // proportionally so the home/away ratio is preserved for the moneyline.
    const TOTAL_MEAN = 2 * MLB_BASE_RUNS;   // 9.0
    const TOTAL_REG_THRESHOLD = 9.0;        // start dampening above this
    const TOTAL_REG_STRENGTH  = 0.30;       // pull 30% of the excess back toward the mean
    let totalExpRuns = totalExpRunsRaw;
    if (totalExpRunsRaw > TOTAL_REG_THRESHOLD) {
      const excess = totalExpRunsRaw - TOTAL_REG_THRESHOLD;
      totalExpRuns = TOTAL_REG_THRESHOLD + excess * (1 - TOTAL_REG_STRENGTH);
    }
    // Scale each side proportionally so home/away ratio is preserved
    if (totalExpRuns !== totalExpRunsRaw) {
      const scale = totalExpRuns / totalExpRunsRaw;
      // Reassign for downstream (lambdaHome/lambdaAway, factors display)
      var adjHomeExpRuns = homeExpRuns * scale;
      var adjAwayExpRuns = awayExpRuns * scale;
    } else {
      var adjHomeExpRuns = homeExpRuns;
      var adjAwayExpRuns = awayExpRuns;
    }
    // Dynamic OU line: round model's expected total to nearest 0.5 (standard 0.5 increments)
    const ouLine = Math.round(totalExpRuns * 2) / 2;

    // Regress the home/away run gap toward its mean before the win/spread calc.
    // Mean-preserving, so totalExpRuns and ouLine above are unaffected — only the
    // moneyline/spread split tightens. The regression amount is per-game: thin inputs
    // (rookie SP, unconfirmed lineup) shrink the gap more (see gameGapRegression).
    const gapReg     = gameGapRegression(matchup, awaySPId, homeSPId);
    const meanRuns   = totalExpRuns / 2;
    const lambdaHome = meanRuns + (adjHomeExpRuns - meanRuns) * gapReg;
    const lambdaAway = meanRuns + (adjAwayExpRuns - meanRuns) * gapReg;

    const probs = computeGameProbabilities(lambdaHome, lambdaAway, ouLine);
    const { homeWinPct, awayWinPct, overProb, underProb, homeCoversProb, awayCoversProb } = probs;
    // Raw (pre-dampener, pre-gap-regression) win prob — the model's UNcompressed
    // confidence. Persisted so we can test whether loosening regression would let a
    // genuine confident tier express (raw-vs-calibrated discrimination/AUC). Display only.
    const rawHomeWinPct = computeGameProbabilities(homeExpRuns, awayExpRuns, ouLine).homeWinPct;

    // ── Key factors ──
    const factors = [];

    // Pitching edge — ERA shown is model-adjusted (FIP blend, home/away split, OPS quality, recent form)
    const awaySPEra  = effectiveSPEra(awaySPId, false);
    const homeSPEra  = effectiveSPEra(homeSPId, true);
    const homeSPName = homeSPEntry.pitcher.name;
    const awaySPName = awaySPEntry.pitcher.name;
    const eraGap = Math.abs(homeSPEra - awaySPEra);
    if (eraGap >= 0.50) {
      const betterIsHome = homeSPEra < awaySPEra;
      const betterName   = betterIsHome ? homeSPName : awaySPName;
      const betterEra    = Math.min(homeSPEra, awaySPEra);
      const worseEra     = Math.max(homeSPEra, awaySPEra);
      const worseName    = betterIsHome ? awaySPName : homeSPName;
      factors.push({
        label: 'Pitching edge',
        detail: `${betterName}: ${betterEra.toFixed(2)} adj ERA vs ${worseName}: ${worseEra.toFixed(2)} (FIP + Statcast xERA blend)`,
        side: betterIsHome ? 'home' : 'away',
      });
    } else {
      factors.push({
        label: 'Pitching',
        detail: `${homeSPName}: ${homeSPEra.toFixed(2)} · ${awaySPName}: ${awaySPEra.toFixed(2)} (even, FIP+xERA adj)`,
        side: 'neutral',
      });
    }

    // Bullpen edge — ERA is fatigue-adjusted and platoon-matched to opposing lineup
    const bpGap = Math.abs(homeBpEra - awayBpEra);
    if (bpGap >= 0.60) {
      const betterTeam = homeBpEra < awayBpEra ? home.name : away.name;
      factors.push({
        label: 'Bullpen edge',
        detail: `${betterTeam} BP: ${Math.min(homeBpEra, awayBpEra).toFixed(2)} ERA vs ${Math.max(homeBpEra, awayBpEra).toFixed(2)} (fatigue & platoon adj)`,
        side: homeBpEra < awayBpEra ? 'home' : 'away',
      });
    }

    // Velocity — fastball-velo gap is a leading indicator (decline/injury shows in velo
    // before ERA). Now live in the pitching math via veloFactor; surface it when notable.
    const homeVelo = getPitcherFbVelo()[homeSPId], awayVelo = getPitcherFbVelo()[awaySPId];
    if (homeVelo != null && awayVelo != null && Math.abs(homeVelo - awayVelo) >= 1.5) {
      const harderIsHome = homeVelo > awayVelo;
      factors.push({
        label: 'Velocity',
        detail: `${harderIsHome ? homeSPName : awaySPName} ${Math.max(homeVelo, awayVelo).toFixed(1)} vs ${Math.min(homeVelo, awayVelo).toFixed(1)} mph fastball`,
        side: harderIsHome ? 'home' : 'away',
      });
    }

    // Offense edge — OPS is batting-order weighted; RS/G blended in when available
    const opsGap = Math.abs(homeOffOps - awayOffOps);
    const rsGap  = homeRsPerG != null && awayRsPerG != null ? Math.abs(homeRsPerG - awayRsPerG) : 0;
    if (opsGap >= 0.025 || rsGap >= 0.40) {
      const betterIsHome = homeOffOps > awayOffOps;
      const betterTeam   = betterIsHome ? home.name : away.name;
      const homeRsStr    = homeRsPerG != null ? ` · ${homeRsPerG.toFixed(2)} R/G` : '';
      const awayRsStr    = awayRsPerG != null ? ` · ${awayRsPerG.toFixed(2)} R/G` : '';
      factors.push({
        label: 'Offense edge',
        detail: `${betterTeam}: ${(betterIsHome ? homeOffOps : awayOffOps).toFixed(3)} OPS${betterIsHome ? homeRsStr : awayRsStr} vs ${(betterIsHome ? awayOffOps : homeOffOps).toFixed(3)} OPS${betterIsHome ? awayRsStr : homeRsStr} (xwOBA-blended)`,
        side: betterIsHome ? 'home' : 'away',
      });
    }

    // Defense edge — team OAA/runs prevented (suppresses opponent runs; not in ERA)
    const homeDef = getTeamDefense(home.name), awayDef = getTeamDefense(away.name);
    if (homeDef && awayDef && Math.abs((homeDef.frp || 0) - (awayDef.frp || 0)) >= 8) {
      const homeBetter = (homeDef.frp || 0) > (awayDef.frp || 0);
      const betterTeam = homeBetter ? home.name : away.name;
      factors.push({
        label: 'Defense edge',
        detail: `${betterTeam}: ${Math.max(homeDef.frp, awayDef.frp)} vs ${Math.min(homeDef.frp, awayDef.frp)} fielding runs prevented (Statcast OAA)`,
        side: homeBetter ? 'home' : 'away',
      });
    }

    // Schedule spot — fatigue from consecutive games / road trip with no off day
    const homeFat = scheduleFatigue(matchup.homeSchedule), awayFat = scheduleFatigue(matchup.awaySchedule);
    if (Math.abs(homeFat - awayFat) >= 0.3) {
      const homeFresher = homeFat < awayFat;
      const tired = homeFresher ? away : home;
      const ts    = homeFresher ? matchup.awaySchedule : matchup.homeSchedule;
      factors.push({
        label: 'Schedule spot',
        detail: `${tired.abbrev} fatigued: ${ts?.consecutive || '?'} straight${(ts?.awayLast7 || 0) >= 6 ? ', long road trip' : ''}`,
        side: homeFresher ? 'home' : 'away',
      });
    }

    // Run support — does the team actually score for this SP? Surfaces the "great pitcher,
    // team keeps losing his starts" case (shown only when the season deviation is sizable).
    for (const [rs, team, spName, isHome] of [
      [matchup.homeSpRunSupport, home, homeSPName, true],
      [matchup.awaySpRunSupport, away, awaySPName, false],
    ]) {
      if (rs && rs.ratio != null && rs.starts >= 6 && Math.abs(rs.ratio - 1) >= 0.12) {
        const pct = Math.round((rs.ratio - 1) * 100);
        factors.push({
          label: 'Run support',
          detail: `${team.abbrev}: ${rs.avgRs} R/G in ${spName}'s ${rs.starts} starts (${pct > 0 ? '+' : ''}${pct}% vs season)`,
          side: rs.ratio >= 1 ? (isHome ? 'home' : 'away') : (isHome ? 'away' : 'home'),
        });
      }
    }

    // Recent form — last 14 games OBP vs season average
    const homeFormPct = Math.round((homeRecentFactor - 1) * 100);
    const awayFormPct = Math.round((awayRecentFactor - 1) * 100);
    if (Math.abs(homeFormPct) >= 3 || Math.abs(awayFormPct) >= 3) {
      const parts = [];
      if (Math.abs(homeFormPct) >= 3) parts.push(`${home.abbrev} ${homeFormPct > 0 ? '+' : ''}${homeFormPct}%`);
      if (Math.abs(awayFormPct) >= 3) parts.push(`${away.abbrev} ${awayFormPct > 0 ? '+' : ''}${awayFormPct}%`);
      factors.push({
        label: 'Recent form',
        detail: `Last 14 games vs season avg: ${parts.join(', ')}`,
        side: homeRecentFactor > awayRecentFactor ? 'home' : awayRecentFactor > homeRecentFactor ? 'away' : 'neutral',
      });
    }

    // Park
    if (Math.abs(prf - 1.0) >= 0.04) {
      const dir = prf > 1.0 ? 'hitter-friendly' : 'pitcher-friendly';
      factors.push({
        label: 'Park',
        detail: `${venueName || 'Venue'} — ${dir} (${prf > 1 ? '+' : ''}${Math.round((prf - 1) * 100)}% run factor)`,
        side: 'neutral',
      });
    }

    // Umpire
    if (Math.abs(urf - 1.0) >= 0.01 && matchup.umpire) {
      factors.push({
        label: 'Umpire',
        detail: `${matchup.umpire} — ${urf < 1.0 ? 'pitcher-friendly' : 'batter-friendly'} (${urf > 1 ? '+' : ''}${Math.round((urf - 1) * 100)}% scoring)`,
        side: 'neutral',
      });
    }

    // Weather
    if (Math.abs(wrf - 1.0) >= 0.03) {
      const dir = wrf > 1.0 ? 'boosts scoring' : 'suppresses scoring';
      factors.push({
        label: 'Weather',
        detail: `${weather?.temp ? weather.temp + '°F' : ''}${weather?.wind ? ' · ' + weather.wind : ''} — ${dir}`,
        side: 'neutral',
      });
    }

    factors.push({
      label: 'Home field',
      detail: `${home.name} (+4% baseline)`,
      side: 'home',
    });

    // Moneyline factor decomposition — signed ln(home/away run-ratio) contributions
    // toward HOME (positive) or AWAY (negative). park/weather/umpire/altitude cancel in
    // the ratio; the asymmetric factors below are the ENTIRE moneyline signal. Logged
    // per game to measure each factor's predictive lift vs outcomes (an audit script).
    const safe = x => (x && x > 0 ? x : 1);
    const offEdge     = Math.log(safe(homeOffFactor)    / safe(awayOffFactor));
    const pitchEdge   = Math.log(safe(awayPitchFactor)  / safe(homePitchFactor));
    const formEdge    = Math.log(safe(homeRecentFactor) / safe(awayRecentFactor));
    const defEdge     = Math.log(safe(awayDefenseFactor) / safe(homeDefenseFactor)); // away D worse ⇒ toward home
    const spotEdge    = Math.log(safe(homeFatigueMult) / safe(awayFatigueMult));     // away more fatigued ⇒ toward home
    const suppEdge    = Math.log(safe(homeSuppMult) / safe(awaySuppMult));           // home scores more in its SP's starts ⇒ toward home
    const parkHandEdge= Math.log(safe(homeParkHand) / safe(awayParkHand));           // park tilts toward home lineup's hand
    // Handedness stacking — now LIVE (promoted from shadow), so part of netEdge.
    const handEdge    = Math.log(safe(homeHandMult) / safe(awayHandMult));           // away lineup more same-hand ⇒ toward home
    const homeEdge    = Math.log(HOME_ADV);
    const winFactors = {
      offEdge:      +offEdge.toFixed(4),
      pitchEdge:    +pitchEdge.toFixed(4),
      formEdge:     +formEdge.toFixed(4),
      defEdge:      +defEdge.toFixed(4),
      spotEdge:     +spotEdge.toFixed(4),
      suppEdge:     +suppEdge.toFixed(4),
      parkHandEdge: +parkHandEdge.toFixed(4),
      handEdge:     +handEdge.toFixed(4),
      homeEdge:     +homeEdge.toFixed(4),
      netEdge:      +(offEdge + pitchEdge + formEdge + defEdge + spotEdge + suppEdge + parkHandEdge + handEdge + homeEdge).toFixed(4),
    };
    // Shadow diagnostics — pure expected-stat signals, logged (not yet weighted) so
    // an audit script can compare their predictive lift to the live edges
    // before we lean on them harder. Toward HOME when positive.
    const pSav = getSavantPitcherData();
    const homeXera = pSav[homeSPId]?.xera, awayXera = pSav[awaySPId]?.xera;
    if (homeXwobaBased != null && awayXwobaBased != null)
      winFactors.offEdgeXwoba = +Math.log(safe(homeXwobaBased) / safe(awayXwobaBased)).toFixed(4);
    if (homeXera != null && awayXera != null)
      winFactors.pitchEdgeXera = +Math.log(safe(awayXera) / safe(homeXera)).toFixed(4); // away SP worse ⇒ toward home
    // Bullpen availability (depleted away pen ⇒ toward home). Its live effect already
    // flows through pitchEdge via bullpenProfile; logged separately to measure standalone lift.
    const homePenAvail = bullpenAvailability(homePitchingVsAway);
    const awayPenAvail = bullpenAvailability(awayPitchingVsHome);
    winFactors.penEdge = +Math.log(safe(homePenAvail) / safe(awayPenAvail)).toFixed(4);
    // High-leverage pen quality (Closer+Setup) — away's late arms worse ⇒ toward home.
    // Live effect already flows through pitchEdge via the leverage-weighted bullpenProfile;
    // logged separately to measure the standalone leverage signal.
    winFactors.penLeverageEdge = +Math.log(safe(awayPen.highLevEra) / safe(homePen.highLevEra)).toFixed(4);
    // TTO exposure delta (away SP more 3rd-time-exposed ⇒ toward home). Live effect
    // flows through pitchEdge; shadow-logged for standalone lift review.
    winFactors.ttoEdge = +Math.log(ttoMultiplier(awaySPId) / ttoMultiplier(homeSPId)).toFixed(4);
    // Fastball velocity — away SP slower/declining ⇒ toward home. Live in pitchEdge
    // via veloFactor; logged standalone for lift review.
    winFactors.veloEdge = +Math.log(safe(veloFactor(awaySPId)) / safe(veloFactor(homeSPId))).toFixed(4);
    // handEdge is LIVE (in netEdge above). arsenalEdge is SHADOW ONLY — historical lift
    // was 35% pointed-at-winner, so it is logged but NOT weighted
    // into the run means or netEdge until the direction validates on new slates.
    winFactors.arsenalEdge = +Math.log(safe(homeArsMult) / safe(awayArsMult)).toFixed(4);

    // Key factor — the most DECISIVE live moneyline contribution relative to its own range
    // (saturation = |contribution| / its clamp cap), used by the daily email for a one-line
    // "why". Ranking by saturation (not raw magnitude) lets a maxed-out intangible — run
    // support, defense — surface over a routine pitching edge, while a genuine pitching
    // blowout still wins. The constant home-field term is excluded (same every game).
    // `cap` ≈ each factor's notable (~p90) |ln contribution|, calibrated to its observed
    // value range so saturation is comparable across factors: pitching stays the usual
    // headline but elevated offense / run-support / defense take over when they're the real
    // story, and the tiny factors (schedule/handedness) headline only in true tossups.
    // Positive ⇒ toward home.
    const KEY_FACTORS = [
      { key: 'pitchEdge',    label: 'Pitching',      cap: 0.30 },
      { key: 'offEdge',      label: 'Offense',       cap: 0.12 },
      { key: 'suppEdge',     label: 'Run support',   cap: 0.09 },
      { key: 'defEdge',      label: 'Defense',       cap: 0.09 },
      { key: 'formEdge',     label: 'Recent form',   cap: 0.06 },
      { key: 'parkHandEdge', label: 'Park/hand',     cap: 0.06 },
      { key: 'spotEdge',     label: 'Schedule spot', cap: 0.04 },
      { key: 'handEdge',     label: 'Handedness',    cap: 0.04 },
    ];
    let keyFactor = null, bestSat = 0;
    for (const f of KEY_FACTORS) {
      const v = winFactors[f.key];
      if (v == null) continue;
      const sat = Math.abs(v) / f.cap;
      if (sat > bestSat) {
        bestSat   = sat;
        keyFactor = { label: f.label, side: v >= 0 ? 'home' : 'away', team: v >= 0 ? home.abbrev : away.abbrev };
      }
    }

    const awaySPIp = avgIpPerStart(awaySPId);
    const homeSPIp = avgIpPerStart(homeSPId);
    results.push({
      gamePk:   matchup.gamePk,
      gameTime: matchup.gameTime,
      status:   matchup.status,
      venueName,
      weatherLive: matchup.weatherLive || null,
      home: {
        ...home,
        winPct:     homeWinPct,
        odds:       fmtOdds(homeWinPct),
        expRuns:    +adjHomeExpRuns.toFixed(2),
        spName:     homeSPEntry.pitcher.name,
        spEra:      +homeSPEra.toFixed(2),
        spIpPerStart: +homeSPIp.toFixed(1),
        bpEra:      +homeBpEra.toFixed(2),
      },
      away: {
        ...away,
        winPct:     awayWinPct,
        odds:       fmtOdds(awayWinPct),
        expRuns:    +adjAwayExpRuns.toFixed(2),
        spName:     awaySPEntry.pitcher.name,
        spEra:      +awaySPEra.toFixed(2),
        spIpPerStart: +awaySPIp.toFixed(1),
        bpEra:      +awayBpEra.toFixed(2),
      },
      totalExpRuns: +totalExpRuns.toFixed(2),
      rawHomeWinPct: +rawHomeWinPct.toFixed(4),
      ouLine,
      overProb:     +overProb.toFixed(4),
      underProb:    +underProb.toFixed(4),
      ouCall:       overProb >= 0.50 ? 'OVER' : 'UNDER',
      homeCoversProb: +homeCoversProb.toFixed(4),
      awayCoversProb: +awayCoversProb.toFixed(4),
      spreadCall:     homeCoversProb >= awayCoversProb ? 'HOME' : 'AWAY',
      spreadCallProb: +Math.max(homeCoversProb, awayCoversProb).toFixed(4),
      keyFactor,
      winFactors,
      factors,
    });
  }

  results.sort((a, b) => (a.gameTime || '').localeCompare(b.gameTime || ''));
  return results;
}

module.exports = { computeWinPredictions, computeGameProbabilities };
