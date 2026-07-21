'use strict';

const fs   = require('fs');
const path = require('path');
const { getGameWeather } = require('./weather');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// MLB API returns inningsPitched in baseball notation: "59.2" = 59 full innings
// + 2 outs = 59.667 true innings. parseFloat("59.2") = 59.2 is wrong for math.
function parseIp(val) {
  const s = String(val || 0);
  const dot = s.indexOf('.');
  if (dot === -1) return parseInt(s, 10) || 0;
  const full = parseInt(s.slice(0, dot), 10) || 0;
  const outs = parseInt(s.slice(dot + 1, dot + 2) || '0', 10);
  return full + outs / 3;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const API    = 'https://statsapi.mlb.com/api/v1';
const SEASON = new Date().getFullYear();

const HR_PARK_FACTORS = {
  'coors field':                 1.28,
  'great american ball park':    1.17,
  'citizens bank park':          1.13,
  'globe life field':            1.11,
  'yankee stadium':              1.10,
  'american family field':       1.08,
  'fenway park':                 1.08,
  'truist park':                 1.05,
  'angel stadium of anaheim':    1.04,
  'chase field':                 1.03,
  'minute maid park':            1.02,
  'guaranteed rate field':       1.01,
  'wrigley field':               1.00,
  'citi field':                  0.97,
  'dodger stadium':              0.97,
  'target field':                0.97,
  'tropicana field':             0.96,
  'kauffman stadium':            0.95,
  'oriole park at camden yards': 0.95,
  'pnc park':                    0.94,
  'busch stadium':               0.93,
  'nationals park':              0.93,
  'progressive field':           0.93,
  'rogers centre':               0.92,
  'comerica park':               0.90,
  't-mobile park':               0.90,
  'petco park':                  0.89,
  'loandepot park':              0.88,
  'oracle park':                 0.85,
  'sutter health park':          1.18,
};

const GAME_CACHE_TTL_MS = 20 * 60 * 1000;

const LG_OPS_AGAINST = 0.730;
const LG_KPCT_P      = 22.5;
const LG_BBPCT_P     = 8.2;

const UMP_TENDENCIES = {
  'Laz Diaz':        { kAdj:  3.0, bbAdj: -1.2 },
  'Angel Hernandez': { kAdj:  2.0, bbAdj: -0.8 },
  'Joe West':        { kAdj:  2.0, bbAdj: -0.8 },
  'Greg Gibson':     { kAdj:  2.0, bbAdj: -0.8 },
  'Mark Carlson':    { kAdj:  1.5, bbAdj: -0.5 },
  'Tom Hallion':     { kAdj:  1.5, bbAdj: -0.5 },
  'Ted Barrett':     { kAdj: -1.0, bbAdj:  0.8 },
  'Jordan Baker':    { kAdj: -1.2, bbAdj:  1.0 },
  'Phil Cuzzi':      { kAdj: -1.0, bbAdj:  0.8 },
  'Dan Iassogna':    { kAdj: -1.2, bbAdj:  1.0 },
};

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------
const gameCache          = { date: null, games: null, fetchedAt: 0 };
const matchupCache       = {};
const streakCache        = {};
const rpAppearanceCache  = {};
const standingsCache     = { date: null, data: null };
const activeRosterCache  = {}; // teamId -> { date, ids: Set }
const bvpCache           = {};
const recentBatterCache  = {};
const pitcherRecentCache = {};
const pitcherSplitCache  = {};
const pitcherHandCache   = {};
const batterHandCache    = {}; // batterId → bat side code (L/R/S) — confirmed lineups lack it
const playerStatusCache  = {}; // playerId → { ts, data } — current team + active/injury status, TTL'd
const pitcherStatCache   = {};
const batterSplitCache   = {};
const catcherCSCache     = {};
const vsTeamCache        = {};
const careerVenueCache   = {};
const teamHittingLogCache = {}; // teamId → { date, map:{gamePk:runs}, rsPerG }
const spRunSupportCache   = {}; // `${spId}:${teamId}` → { date, starts, avgRs, ratio }
const CAREER_VENUE_TTL   = 7 * 24 * 60 * 60 * 1000;
// teamId → home venueId. gameLog splits carry isHome/team/opponent but NOT the game
// venue, so per-venue batter stats are derived from the home team's park via this map.
let   teamVenueMap       = null;
let   teamVenuePromise   = null;
let   cacheDay           = localDate();
let   savantData         = {};  // batterId  → { exitVeloAvg, hardHitPct, barrelRate, xwoba, woba, xba, xslg, fbPct, pullPct, batSpeed, swingLen, fastSwingPct, chaseRate, zContactPct, oContactPct }
let   savantPitcherData  = {};  // pitcherId → { xera, xwoba, woba, xslg, xbaAllowed, kPct, bbPct, whiffPct, hardHitPctAllowed, barrelPctAllowed, kbb, chaseRateInduced, zContactPctAllowed, oContactPctAllowed }
let   savantPitcherPriorData = {}; // pitcherId → { xwoba } from SEASON-1 — static, fetched once per process
let   teamDefenseData    = {};  // nickname(lower) → { oaa, frp } season-cumulative team defense
let   teamKPctData       = {};  // teamId → team's own season strikeout rate as BATTERS (SO/PA)
let   leagueKPctAvg      = 0.221;  // league-avg team K% (batting), fallback matches observed 2026 value
let   leagueWhiffAvg     = 25.5;   // league-avg pitcher whiff%, fallback matches observed 2026 value
let   pitcherArsenalData = {};  // pitcherId → { pitchType → usagePct }
let   batterArsenalData  = {};  // batterId  → { pitchType → runValuePer100 (batter perspective) }
let   batterArsenalWhiff = {};  // batterId  → { pitchType → whiffRate (0-1) by pitch type }
let   batterArsenalGroups= {};  // batterId  → { FB|BRK|OFF → { slg, whiff(0-1), pa } } for crush/auto-out tags

// Pitch-type → coarse group. Auto-out (K) and crush (HR) tags operate at the group level.
const PITCH_GROUP = pt =>
  /^(FF|SI|FC)$/.test(pt)        ? 'FB'
  : /^(SL|CU|ST|KC|SV|CS)$/.test(pt) ? 'BRK'
  : /^(CH|FS|EP|KN|FO)$/.test(pt)    ? 'OFF'
  : null;
let   pitcherFbVeloData  = {};  // pitcherId → max pitch velocity (mph) ≈ fastball velo
let   savantDate         = null;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function localDate() {
  // Slate date rolls over on US Central time (en-CA gives YYYY-MM-DD).
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function isGameComplete(status) {
  return /^(Final|Game Over|Completed|Postponed|Cancelled|Suspended)/i.test(status || '');
}

function getUmpTendency(name) {
  return UMP_TENDENCIES[name] || { kAdj: 0, bbAdj: 0 };
}

function parseWeather(weather) {
  const windStr = weather?.wind || '';
  const tempStr = weather?.temp || '';

  const mphMatch = windStr.match(/(\d+)\s*mph/i);
  const mph = mphMatch ? parseInt(mphMatch[1]) : 0;
  const dir = windStr.toLowerCase();
  const blowingOut = dir.includes('out');
  const blowingIn  = dir.includes('in from');

  let windHrMult = 1.0;
  if (mph >= 5) {
    const strength = Math.min(0.22, mph * 0.011);
    if (blowingOut)     windHrMult = 1 + strength;
    else if (blowingIn) windHrMult = 1 - strength;
    else                windHrMult = 1 + strength * 0.12;
  }
  const windOpsAdj = blowingOut ? Math.min(0.012, mph * 0.0007)
                   : blowingIn  ? Math.max(-0.012, -mph * 0.0007)
                   : 0;

  const tempF      = parseInt(tempStr) || 72;
  const tempHrMult = Math.max(0.80, Math.min(1.20, 1 + (tempF - 72) * 0.002));
  const tempOpsAdj = Math.max(-0.018, Math.min(0.018, (tempF - 72) * 0.0004));

  return { mph, windHrMult, windOpsAdj, tempF, tempHrMult, tempOpsAdj };
}

// League-average team runs/game — the anchor for the PA-context scale.
const LG_RS_PER_G = 4.5;
// Expected plate appearances for a lineup slot. The base table is order-only and sums
// to ~35.7 (a ~36-PA, average-offense game). `ctx` makes it elastic to game context —
// the single biggest lever for "needs to happen" props, since prob = 1-(1-rate)^PA:
// - teamRsPerG: a higher-scoring lineup turns over more → more PAs for every slot.
// - isHome: the home team skips the bottom 9th when leading after 8 → ~fewer PAs;
// the road team always bats all 9.
function estimatedPAs(battingOrder, ctx) {
  const PA_BY_ORDER = [4.7, 4.5, 4.3, 4.1, 3.9, 3.7, 3.5, 3.3, 3.1];
  const base = (!battingOrder || battingOrder < 1 || battingOrder > 9) ? 3.9 : PA_BY_ORDER[battingOrder - 1];
  if (!ctx) return base;
  let scale = 1.0;
  if (ctx.teamRsPerG != null && ctx.teamRsPerG > 0) {
    scale *= Math.max(0.90, Math.min(1.12, Math.sqrt(ctx.teamRsPerG / LG_RS_PER_G)));
  }
  if (ctx.isHome === true)  scale *= 0.99;
  else if (ctx.isHome === false) scale *= 1.01;
  return +(base * scale).toFixed(3);
}

function opsTo10(ops) {
  const clamped = Math.max(0.450, Math.min(1.050, ops || 0));
  return Math.round(1 + (clamped - 0.450) / 0.600 * 9);
}

// ---------------------------------------------------------------------------
// Matchup effective OPS — the spine of the 1–10 score (overhauled;
// BvP gate + pitcher small-sample regression revised).
// MATCHUP-CENTRIC, not batter-centric: batter skill (luck-stripped) SCALED by the
// pitcher's quality vs the batter's hand. BvP ramps in from ~12 AB (capped 0.22), and a
// low-IP pitcher line is regressed toward its xwOBA mark.
// ---------------------------------------------------------------------------
async function matchupEffectiveOps(splitOps, batterId, batterHand, pitcherId, bvpOps, bvpAb, pitcherKPct) {
  // 1. Batter skill (OPS vs the SP's hand), luck-stripped + Savant quality layer.
  let batterSkill = splitOps && splitOps > 0 ? splitOps : 0.700;
  const bSav = getSavantData()[batterId];
  if (bSav && bSav.xwoba != null && bSav.woba > 0) {
    batterSkill *= Math.max(0.90, Math.min(1.10, bSav.xwoba / bSav.woba));
  }
  // xSLG absolute quality — best single TB discriminator (a small edge, HR+ backtest).
  // LG avg xSLG ~0.390. Separates power bats from contact bats with identical OPS,
  // addressing the top-of-scale compression confirmed in an audit script.
  if (bSav && bSav.xslg != null) {
    batterSkill *= Math.max(0.88, Math.min(1.12, bSav.xslg / 0.390));
  }
  // 2. Pitcher quality vs the BATTER's hand. The handed split is noisy on low IP
  // (e.g. an ace just back from injury), so regress it toward the pitcher's
  // de-lucked season xwOBA mark by split sample, then let a confirmed high-K
  // arm keep its suppression — K% stabilizes fast and reads "the stuff is back".
  const pSplit = pitcherSplitCache[pitcherId] || {};
  const pSav   = getSavantPitcherData()[pitcherId];
  const opsAllowed = batterHand === 'L' ? pSplit.opsVsL : pSplit.opsVsR;
  const splitPA    = (batterHand === 'L' ? pSplit.paVsL : pSplit.paVsR) || 0;
  // Current-season xwOBA-allowed mark, when Savant's min-BF leaderboard floor is cleared.
  const currentXwobaFactor = (pSav && pSav.xwoba != null) ? pSav.xwoba / 0.318 : null;
  // Thin-current-season fallback : a pitcher returning from a long injury
  // absence (e.g. Hunter Greene's 2026 season-debut start, 3.1 IP/21.60 ERA) doesn't clear
  // Savant's min=20-BF leaderboard floor, so currentXwobaFactor was silently null and the
  // model defaulted to flat league-average (1.0) — modeling him as neither his bad debut
  // NOR his real established talent. Blend toward the pitcher's PRIOR-season xwOBA mark,
  // weighted by how much current-season sample actually exists (BF>=60 ≈ fully trust current).
  const currentBf = pitcherStatCache[pitcherId]?.bf || 0;
  let xwobaFactor;
  if (currentBf >= 60 && currentXwobaFactor != null) {
    xwobaFactor = currentXwobaFactor;
  } else {
    const priorData = await getSavantPitcherPriorData();
    const priorXwoba = priorData[pitcherId]?.xwoba;
    let priorXwobaFactor = priorXwoba != null ? priorXwoba / 0.318 : null;
    // Rust discount (user-requested): don't just assume a pitcher with a
    // near-empty current season is fully back to his prior-season form — a guy making his
    // 1st-4th start deep into the season (not a normal early-April small sample) is likely
    // still returning from a long absence and probably isn't sharp yet. Regress the
    // prior-season mark toward league-average (1.0) for his first ~5 starts back, fading
    // out as he builds a real current-season track record. Gated on daysIntoSeason so this
    // does NOT fire for a routine early-season sample, where 2-3 starts is normal, not rust.
    if (priorXwobaFactor != null) {
      const gamesStarted = pitcherStatCache[pitcherId]?.gamesS || 0;
      const daysIntoSeason = Math.floor((new Date(localDate()) - new Date(`${SEASON}-03-25`)) / 86400000);
      if (daysIntoSeason > 45 && gamesStarted <= 4) {
        const rustFactor = gamesStarted / 5; // 0 at 0 starts back, 1.0 at 5+ starts back
        priorXwobaFactor = priorXwobaFactor * rustFactor + 1.0 * (1 - rustFactor);
      }
    }
    if (priorXwobaFactor != null) {
      const wCur = Math.min(1, currentBf / 60);
      const curPart = currentXwobaFactor != null ? currentXwobaFactor : priorXwobaFactor;
      xwobaFactor = curPart * wCur + priorXwobaFactor * (1 - wCur);
    } else {
      xwobaFactor = currentXwobaFactor != null ? currentXwobaFactor : 1.0; // no prior data either — last resort
    }
  }
  const splitFactor = (opsAllowed != null && opsAllowed > 0)
    ? opsAllowed / LG_OPS_AGAINST : xwobaFactor;
  const w = splitPA / (splitPA + 120);                       // ~35 PA → ~0.23 weight on the split
  let pitcherFactor = splitFactor * w + xwobaFactor * (1 - w);
  // K% floor: each point of K% over league shaves the factor (more suppressive),
  // capped at 12% — only protects a dominant arm, never inflates a soft one.
  const kp = parseFloat(pitcherKPct);
  if (!isNaN(kp) && kp > LG_KPCT_P) {
    pitcherFactor *= 1 - Math.min(0.12, (kp - LG_KPCT_P) / 100 * 1.5);
  }
  pitcherFactor = Math.max(0.80, Math.min(1.25, pitcherFactor));
  let eff = batterSkill * pitcherFactor;
  // 3. BvP: two-segment ramp. A re-audit over a month of frozen predictions, bucketing the
  // correlation between matchup score and actual total bases by real batter-vs-pitcher sample
  // size, found the signal strengthens materially once the BvP sample is non-trivial —
  // overturning an earlier, coarser audit that had concluded BvP was pure noise in that range.
  // The lesson worth keeping: the earlier read failed because its AB buckets were too wide, not
  // because the effect was absent. Bucket granularity is itself a modeling decision.
  // precisely-measured inflection point, so 15 is a reasonable adjustment to that same
  // boundary rather than independently re-verified. 30+ AB buckets are too thin
  // to trust individually, so the cap moves up only modestly (0.22 -> 0.30) rather than
  // chasing the 40+ AB spike.
  let bvpW;
  if (bvpAb < 8) bvpW = 0;
  else if (bvpAb < 15) bvpW = (bvpAb - 8) / 140;                       // unchanged — matches flat low-AB corr
  else bvpW = Math.min(0.30, (15 - 8) / 140 + (bvpAb - 15) / 55);      // steeper — matches the real elevated-AB jump
  if (bvpW > 0 && bvpOps > 0) eff = eff * (1 - bvpW) + bvpOps * bvpW;
  return eff;
}

// ---------------------------------------------------------------------------
// Scoring adjustments (used by computeGameMatchups — must stay here to avoid
// a circular dependency between mlbApi ↔ probabilities)
// ---------------------------------------------------------------------------
function computeScoreAdj(batterHand, pSt, pRecent, pSplit, bRecent, bSplits, pWeather, umpTend, pXwoba) {
  let adj = 0;

  if (pRecent?.recentEra != null && pSt.era != null && pRecent.ip3 >= 8) {
    adj += Math.max(-0.045, Math.min(0.045, (pRecent.recentEra - pSt.era) * 0.015));
  }

  if (pSplit) {
    const splitPa           = batterHand === 'L' ? pSplit.paVsL : pSplit.paVsR;
    const pitcherOpsAgainst = batterHand === 'L' ? pSplit.opsVsL : pSplit.opsVsR;
    if (pitcherOpsAgainst != null && splitPa >= 30) {
      // Luck-stripped: raw split OPS-against alone correlates just 0.144 with real
      // future OPS-against (129 real starters, time-sliced); blending with
      // xwOBA the same way getMatchupQuality already does raises that to 0.308. Weight
      // shifts toward the de-lucked xwOBA mark as the split sample thins out.
      const xwobaFactor = pXwoba != null ? pXwoba / 0.318 : 1.0;
      const w = splitPa / (splitPa + 120);
      const blendedOps = pitcherOpsAgainst * w + (xwobaFactor * LG_OPS_AGAINST) * (1 - w);
      adj += Math.max(-0.040, Math.min(0.040, (blendedOps - LG_OPS_AGAINST) * 0.5));
    }
  }

  if (bRecent?.pa14 >= 20 && bSplits?.obp != null && bRecent.obp14 != null) {
    adj += Math.max(-0.060, Math.min(0.060, (bRecent.obp14 - bSplits.obp) * 0.80));
  }
  if (bRecent?.avg7 != null && bRecent.ab7 >= 15) {
    if      (bRecent.avg7 >= 0.400) adj += 0.050;
    else if (bRecent.avg7 >= 0.350) adj += 0.025;
    else if (bRecent.avg7 <= 0.100) adj -= 0.055;
    else if (bRecent.avg7 <= 0.150) adj -= 0.030;
  }
  if (bRecent) {
    if      (bRecent.hitStreak    >= 12) adj += 0.050;
    else if (bRecent.hitStreak    >=  7) adj += 0.030;
    else if (bRecent.hitStreak    >=  4) adj += 0.015;
    if      (bRecent.hitlessStreak >= 5) adj -= 0.045;
    else if (bRecent.hitlessStreak >= 3) adj -= 0.025;
  }

  if (pSt.kpct != null && pSt.bbpct != null && pSt.bf >= 50) {
    const kAdj  = -(parseFloat(pSt.kpct)  - LG_KPCT_P)  * 0.0025;
    const bbAdj =  (parseFloat(pSt.bbpct) - LG_BBPCT_P) * 0.003;
    adj += Math.max(-0.035, Math.min(0.035, kAdj + bbAdj));
  }

  if (pWeather) {
    adj += pWeather.tempOpsAdj;
    adj += pWeather.windOpsAdj;
  }

  if (umpTend) {
    adj += Math.max(-0.020, Math.min(0.020, umpTend.bbAdj * 0.010 - umpTend.kAdj * 0.0025));
  }

  return Math.max(-0.160, Math.min(0.160, adj));
}

function computeProbablesAdj(batterHand, pSt, pRecent, pSplit, bRecent, bSplits, pWeather, umpTend, pXwoba) {
  let kMult  = 1.0;
  let obpAdj = 0.0;
  let avgAdj = 0.0;
  let hrMult = 1.0;

  if (pRecent && pRecent.ip3 >= 8) {
    if (pRecent.recentKPct != null && pSt.kpct != null) {
      const diff = pRecent.recentKPct - parseFloat(pSt.kpct) / 100;
      kMult = Math.max(0.75, Math.min(1.25, 1 + diff * 0.45));
    }
    if (pRecent.recentEra != null && pSt.era != null && pSt.era > 0) {
      const eraRatio = pRecent.recentEra / pSt.era;
      const dominanceBonus = (pRecent.recentEra <= 2.00 && pRecent.ip3 >= 15) ? -0.030 : 0;
      const struggleBonus  = (pRecent.recentEra >  7.00 && pRecent.ip3 >= 12) ?  0.025 : 0;
      obpAdj += Math.max(-0.040, Math.min(0.040, (eraRatio - 1) * 0.035)) + dominanceBonus + struggleBonus;
      avgAdj += Math.max(-0.035, Math.min(0.035, (eraRatio - 1) * 0.030)) + dominanceBonus + struggleBonus;
    }
  }

  if (pSplit) {
    const splitPa           = batterHand === 'L' ? pSplit.paVsL : pSplit.paVsR;
    const pitcherOpsAgainst = batterHand === 'L' ? pSplit.opsVsL : pSplit.opsVsR;
    if (pitcherOpsAgainst != null && splitPa >= 30) {
      // Luck-stripped — same xwOBA blend as computeScoreAdj; see note there for the
      // validation numbers (raw split OPS correlation vs blended 0.308 with real
      // future OPS-against, 129 starters).
      const xwobaFactor = pXwoba != null ? pXwoba / 0.318 : 1.0;
      const w = splitPa / (splitPa + 120);
      const blendedOps = pitcherOpsAgainst * w + (xwobaFactor * LG_OPS_AGAINST) * (1 - w);
      const dev = (blendedOps - LG_OPS_AGAINST) * 0.30;
      obpAdj += Math.max(-0.020, Math.min(0.020, dev * 0.4));
      avgAdj += Math.max(-0.015, Math.min(0.015, dev * 0.3));
    }
  }

  if (bRecent && bRecent.pa14 >= 20) {
    if (bRecent.obp14 != null && bSplits?.obp != null)
      obpAdj += Math.max(-0.035, Math.min(0.035, (bRecent.obp14 - bSplits.obp) * 0.60));
    if (bRecent.avg14 != null && bSplits?.avg != null)
      avgAdj += Math.max(-0.030, Math.min(0.030, (bRecent.avg14 - bSplits.avg) * 0.60));
  }
  if (bRecent?.avg7 != null && bRecent.ab7 >= 15) {
    if      (bRecent.avg7 >= 0.400) { avgAdj += 0.045; obpAdj += 0.030; }
    else if (bRecent.avg7 >= 0.350) { avgAdj += 0.025; obpAdj += 0.015; }
    else if (bRecent.avg7 <= 0.100) { avgAdj -= 0.050; obpAdj -= 0.030; }
    else if (bRecent.avg7 <= 0.150) { avgAdj -= 0.030; obpAdj -= 0.020; }
  }

  if (bRecent) {
    if      (bRecent.hitStreak >= 12) { avgAdj += 0.055; obpAdj += 0.035; }
    else if (bRecent.hitStreak >=  7) { avgAdj += 0.035; obpAdj += 0.020; }
    else if (bRecent.hitStreak >=  4) { avgAdj += 0.015; obpAdj += 0.010; }
    if      (bRecent.hitlessStreak >= 5) { avgAdj -= 0.045; obpAdj -= 0.025; }
    else if (bRecent.hitlessStreak >= 3) { avgAdj -= 0.025; obpAdj -= 0.015; }
  }

  if (bRecent && bRecent.kPct14 != null && bSplits?.kPct != null) {
    const kDiff = bRecent.kPct14 - bSplits.kPct;
    kMult = Math.max(0.82, Math.min(1.18, kMult + kDiff * 0.40));
  }

  if (umpTend) {
    kMult   = Math.max(0.82, Math.min(1.18, kMult * (1 + umpTend.kAdj / 100)));
    obpAdj += Math.max(-0.015, Math.min(0.015, umpTend.bbAdj * 0.010));
  }

  // Weather HR multiplier down-weighted (ablation: HR+ `adj` −13/active) —
  // the old 0.55–1.90 range overstated wind/temp; compress the deviation and tighten.
  if (pWeather) {
    const wRaw = pWeather.tempHrMult * pWeather.windHrMult;
    hrMult = Math.max(0.80, Math.min(1.35, 1 + (wRaw - 1) * 0.55));
  }

  // avgAdj/obpAdj contextual stack shrunk (ablation: HIT `adj` −36/active) —
  // the form/streak/split adjustments net to noise at full weight; scale to ~0.6 and
  // tighten the final clamps so context nudges the base rather than swinging it.
  const ADJ_SHRINK = 0.6;
  return {
    kMult:  Math.max(0.70, Math.min(1.30, kMult)),
    obpAdj: Math.max(-0.050, Math.min(0.050, obpAdj * ADJ_SHRINK)),
    avgAdj: Math.max(-0.045, Math.min(0.045, avgAdj * ADJ_SHRINK)),
    hrMult,
  };
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------
let lastCall = 0;
async function mlbGet(url) {
  const gap = Date.now() - lastCall;
  if (gap < 130) await sleep(130 - gap);
  lastCall = Date.now();
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'mlb-matchups/1.0' }, signal: controller.signal });
      clearTimeout(timer);
      if (r.ok) return r.json();
      if (r.status === 429) await sleep(1500 * (i + 1));
    } catch { clearTimeout(timer); await sleep(600 * (i + 1)); }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------
async function getTodaysGames(dateStr) {
  const date = dateStr || localDate();
  const data = await mlbGet(
    `${API}/schedule?sportId=1&date=${date}` +
    `&hydrate=probablePitcher,lineups,team,linescore,weather,officials`
  );
  if (!data) return [];
  const games = [];
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      const { home, away } = g.teams;
      games.push({
        gamePk:    g.gamePk,
        gameTime:  g.gameDate,
        status:    g.status?.detailedState,
        venueName: g.venue?.name || null,
        venueId:   g.venue?.id   || null,
        weather:   g.weather || null,
        umpire:    (g.officials || []).find(o => o.officialType === 'Home Plate')?.official?.fullName || null,
        home: {
          teamId:     home.team.id,
          name:       home.team.name,
          abbrev:     home.team.abbreviation,
          probable:   home.probablePitcher || null,
          battersRaw: g.lineups?.homePlayers || null,
          score:      home.score ?? null,
        },
        away: {
          teamId:     away.team.id,
          name:       away.team.name,
          abbrev:     away.team.abbreviation,
          probable:   away.probablePitcher || null,
          battersRaw: g.lineups?.awayPlayers || null,
          score:      away.score ?? null,
        },
      });
    }
  }
  return games;
}

// ---------------------------------------------------------------------------
// Rosters
// ---------------------------------------------------------------------------
async function getPitchingStaff(teamId, probable) {
  const data = await mlbGet(`${API}/teams/${teamId}/roster?rosterType=active`);
  if (!data) return probable ? [{ id: probable.id, name: probable.fullName || probable.name || 'TBD', role: 'SP' }] : [];
  const pitchers = (data.roster || [])
    .filter(p => p.position?.code === '1')
    .map(p => ({
      id:   p.person.id,
      name: p.person.fullName || p.person.name || 'Unknown',
      role: p.person.id === probable?.id ? 'SP' : 'RP',
    }));
  if (probable && !pitchers.find(p => p.id === probable.id))
    pitchers.unshift({ id: probable.id, name: probable.fullName || probable.name || 'TBD', role: 'SP' });
  return pitchers;
}

async function getBattingLineup(team, oppProbable) {
  if (team.battersRaw && team.battersRaw.length) {
    // Confirmed lineup players from the schedule feed lack batSide — resolve it per id
    // (cached) so handedness isn't silently defaulted to RHB for the whole lineup.
    return Promise.all(team.battersRaw.map(async (p, i) => ({
      id: p.id, name: p.fullName,
      batSide: p.batSide?.code || await getBatterHand(p.id),
      source: 'confirmed', battingOrder: i + 1,
    })));
  }
  const data = await mlbGet(
    `${API}/teams/${team.teamId}/roster?rosterType=active` +
    `&hydrate=person(stats(type=season,season=${SEASON},group=hitting))`
  );
  if (!data) return [];
  const fallback = (data.roster || [])
    .filter(p => p.person?.primaryPosition?.code !== '1')
    .map(p => {
      const st = p.person?.stats?.[0]?.splits?.[0]?.stat || {};
      return {
        id: p.person.id, name: p.person.fullName,
        batSide: p.person.batSide?.code || 'R',
        gamesPlayed: st.gamesPlayed || 0, source: 'roster-fallback',
      };
    })
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed)
    .slice(0, 9);

  // Pre-lineup TOP-ORDER prediction (extended from leadoff-only to
  // slots 1-4): before the real lineup posts, guess who's likely to bat in each of the
  // top 4 spots from real recent history (see lib/leadoffPredictor.js) — only when
  // confidence is 'stable' or 'platoon' for that specific slot, never a forced guess
  // ('uncertain' slots are left alone, no order assigned). This matters beyond just
  // leadoff: batting-order slot directly drives the PA estimate used everywhere
  // (estimatedPAs' PA_BY_ORDER table), so a slot-3/4 hitter left with no predicted order
  // silently falls back to a flat, order-blind PA guess — exactly the gap that made the
  // multi-hit combo unable to tell a real cleanup hitter from a bench guy before lineups
  // post. Lazy require to break the circular mlbApi<->leadoffPredictor dependency (both
  // modules need to be fully loaded before either's exports are safe to destructure).
  // Tagged `source: 'predicted-leadoff'` for ALL predicted slots (not just order 1) —
  // deliberately NOT the same as 'confirmed', so lineupConfirmed-gated logic elsewhere
  // (runsOver, actionablesLeadoff/2Hole) does not silently treat a prediction as a real
  // posted lineup. Known limitation: does not check injury/IL status — a player stable
  // in recent games who was JUST injured could still be predicted until enough new games
  // age the old data out of the 10-game window.
  try {
    const { predictTopOrder } = require('./leadoffPredictor');
    const oppHand = oppProbable ? await getPitcherHand(oppProbable.id) : null;
    const preds = await predictTopOrder(team.teamId, oppHand);
    for (const order of [1, 2, 3, 4]) {
      const pred = preds[order];
      if (!((pred.confidence === 'stable' || pred.confidence === 'platoon') && pred.playerId)) continue;
      const idx = fallback.findIndex(p => p.id === pred.playerId);
      if (idx >= 0) {
        fallback[idx] = { ...fallback[idx], battingOrder: order, source: 'predicted-leadoff', predictionConfidence: pred.confidence, predictionReason: pred.reason };
      } else {
        // Predicted player wasn't in the top-9-by-games-played cut — add them explicitly,
        // since they're specifically who we expect to bat this slot.
        fallback.unshift({ id: pred.playerId, name: pred.playerName, batSide: 'R', gamesPlayed: 0, battingOrder: order, source: 'predicted-leadoff', predictionConfidence: pred.confidence, predictionReason: pred.reason });
      }
    }
  } catch (e) {
    console.error(`[leadoffPredictor] prediction failed for team ${team.teamId}: ${e.message}`);
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Pitcher caches
// ---------------------------------------------------------------------------
async function getPitcherHand(id) {
  if (pitcherHandCache[id]) return pitcherHandCache[id];
  const data = await mlbGet(`${API}/people/${id}`);
  const hand = data?.people?.[0]?.pitchHand?.code || 'R';
  pitcherHandCache[id] = hand;
  return hand;
}

// Batter bat side (L/R/S). Needed because the schedule's confirmed-lineup player objects
// (g.lineups.homePlayers) omit batSide, so confirmed lineups otherwise default everyone to
// RHB — silently killing every handedness signal (and skewing the prop matchup model).
async function getBatterHand(id) {
  if (batterHandCache[id]) return batterHandCache[id];
  const data = await mlbGet(`${API}/people/${id}`);
  const hand = data?.people?.[0]?.batSide?.code || 'R';
  batterHandCache[id] = hand;
  return hand;
}

// Real current team + roster/injury status for a player (reusable app-wide —
// built after a concrete real bug: Brendan Donovan had been traded to Seattle AND was on
// the 10-day IL there, while a stale team assumption elsewhere still had him with his old
// team, and general leaderboards/splits pages don't check active-roster status at all so
// injured/optioned/DFA'd players can keep showing up). `people/{id}?hydrate=currentTeam,
// rosterEntries` gives both in one call — rosterEntries[0] is the most current entry, its
// status.code is 'A' for active, anything starting with 'D' is an injured-list stint
// (D10/D15/D60), and other codes cover optioned/DFA'd/suspended etc. TTL'd (not
// permanent) since a player's status can change same-day.
const PLAYER_STATUS_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
async function getPlayerStatus(playerId) {
  const cached = playerStatusCache[playerId];
  if (cached && Date.now() - cached.ts < PLAYER_STATUS_TTL_MS) return cached.data;
  let data;
  try {
    const p = await mlbGet(`${API}/people/${playerId}?hydrate=currentTeam,rosterEntries`);
    const person = p?.people?.[0];
    const entry = person?.rosterEntries?.[0] || null;
    const statusCode = entry?.status?.code || null;
    data = {
      playerId, found: !!person,
      currentTeamId: person?.currentTeam?.id ?? null,
      currentTeamName: person?.currentTeam?.name ?? null,
      statusCode, statusDescription: entry?.status?.description ?? null,
      isActive: statusCode ? statusCode === 'A' : !!person?.active,
      isInjured: !!statusCode && statusCode.startsWith('D'),
    };
  } catch (e) {
    console.error(`[playerStatus] lookup failed for ${playerId}: ${e.message}`);
    data = { playerId, found: false, currentTeamId: null, currentTeamName: null, statusCode: null, statusDescription: null, isActive: true, isInjured: false };
  }
  playerStatusCache[playerId] = { ts: Date.now(), data };
  return data;
}

const PITCHER_STAT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

async function getPitcherSeasonStats(id) {
  const cached = pitcherStatCache[id];
  if (cached && Date.now() - (cached._ts || 0) < PITCHER_STAT_TTL_MS) return cached;
  const data = await mlbGet(`${API}/people/${id}/stats?stats=season&season=${SEASON}&group=pitching`);
  const st = data?.stats?.[0]?.splits?.[0]?.stat || {};
  const bf       = parseInt(st.battersFaced      || 0);
  const so       = parseInt(st.strikeOuts        || 0);
  const bb       = parseInt(st.baseOnBalls       || 0);
  const ibb      = parseInt(st.intentionalWalks  || 0);
  const hr       = parseInt(st.homeRuns          || 0);
  const hbp      = parseInt(st.hitBatsmen        || st.hitByPitch || 0);
  const ip       = parseIp(st.inningsPitched) || null;
  const saves    = parseInt(st.saves             || 0);
  const saveOpps = parseInt(st.saveOpportunities || 0);
  const holds    = parseInt(st.holds             || 0);
  const gamesP   = parseInt(st.gamesPitched      || 0);
  const gamesS   = parseInt(st.gamesStarted      || 0);
  const FIP_CONSTANT = 3.17;
  // Standard FIP excludes intentional walks (IBB) — same as Baseball Reference/FanGraphs
  const uiBb = bb - ibb;
  const fip = ip && ip >= 10
    ? +((13 * hr + 3 * (uiBb + hbp) - 2 * so) / ip + FIP_CONSTANT).toFixed(2)
    : null;
  const sbAllowed = parseInt(st.stolenBases    || 0);
  const csAllowed = parseInt(st.caughtStealing || 0);
  const result = {
    era:    parseFloat(st.era  || 0) || null,
    whip:   parseFloat(st.whip || 0) || null,
    ip, so, bb, bf, hr, hbp, fip,
    kpct:   bf > 0 ? (so / bf * 100).toFixed(1) : null,
    bbpct:  bf > 0 ? (bb / bf * 100).toFixed(1) : null,
    avg:    parseFloat(st.avg  || 0) || null,
    hr9:    ip && ip > 0 ? hr / ip * 9 : null,
    hrRate: bf > 0 ? hr / bf : null,
    saves, saveOpps, holds, gamesP, gamesS,
    sbAllowed, csAllowed,
    sbSuccAllowed: (sbAllowed + csAllowed) >= 10 ? sbAllowed / (sbAllowed + csAllowed) : null,
    _ts: Date.now(),
  };
  pitcherStatCache[id] = result;
  return result;
}

async function getPitcherRecentStats(id) {
  if (pitcherRecentCache[id] !== undefined) return pitcherRecentCache[id];
  const data = await mlbGet(`${API}/people/${id}/stats?stats=gameLog&season=${SEASON}&group=pitching`);
  const splits = data?.stats?.[0]?.splits || [];

  const starts = splits.filter(g => parseIp(g.stat?.inningsPitched) >= 4);
  const last3  = starts.slice(-3);
  const ip3    = last3.reduce((s, g) => s + parseIp(g.stat?.inningsPitched), 0);
  const er3    = last3.reduce((s, g) => s + parseInt(g.stat?.earnedRuns       || 0), 0);
  const k3     = last3.reduce((s, g) => s + parseInt(g.stat?.strikeOuts       || 0), 0);
  const bf3    = last3.reduce((s, g) => s + parseInt(g.stat?.battersFaced     || 0), 0);
  // Current quality-start streak — same definition as pitcherStreakInfo's per-game tag
  // (IP>=6, ER<=3). `starts` (all starts, not just last3) is already in scope from the
  // filter above, so this is free — no extra fetch.
  let qsStreak = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const ip = parseIp(starts[i].stat?.inningsPitched);
    const er = parseInt(starts[i].stat?.earnedRuns || 0);
    if (ip >= 6 && er <= 3) qsStreak++; else break;
  }
  const result = {
    recentEra:  ip3 >= 6  ? er3 * 9 / ip3 : null,
    recentKPct: bf3 >= 15 ? k3 / bf3       : null,
    ip3, bf3, starts: last3.length, qsStreak,
  };
  pitcherRecentCache[id] = result;

  if (!rpAppearanceCache[id]) {
    const today = localDate();
    const appearances = splits.filter(g => parseIp(g.stat?.inningsPitched) > 0);
    const recent = appearances.slice(-15);
    const lastApp  = recent.length > 0 ? recent[recent.length - 1] : null;
    const lastDate = lastApp?.date ?? null;
    function daysDiff(d) {
      if (!d) return null;
      return Math.round((new Date(today + 'T12:00:00') - new Date(d + 'T12:00:00')) / 86400000);
    }
    const daysRest = daysDiff(lastDate);
    const g3 = recent.filter(g => g.date && daysDiff(g.date) <= 3).length;
    const g7 = recent.filter(g => g.date && daysDiff(g.date) <= 7).length;
    const pitches3 = recent
      .filter(g => g.date && daysDiff(g.date) <= 3)
      .reduce((s, g) => s + parseInt(g.stat?.numberOfPitches || 0), 0);
    let consecCount = 0;
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1].date, curr = recent[i].date;
      if (prev && curr) {
        const gap = Math.round((new Date(curr + 'T12:00:00') - new Date(prev + 'T12:00:00')) / 86400000);
        if (gap <= 1) consecCount++;
      }
    }
    const consecRate = recent.length > 1 ? consecCount / (recent.length - 1) : null;
    rpAppearanceCache[id] = { daysRest, g3, g7, pitches3, lastDate, consecRate };
  }

  return result;
}

async function getPitcherSplits(id) {
  if (pitcherSplitCache[id] !== undefined) return pitcherSplitCache[id];
  const data = await mlbGet(
    `${API}/people/${id}/stats?stats=statSplits&season=${SEASON}&group=pitching&sitCodes=vl,vr,h,a`
  );
  const splitMap = {};
  for (const s of data?.stats?.[0]?.splits || []) splitMap[s.split?.code] = s.stat;
  const parseEra = st => parseFloat(st?.era || 0) || null;
  const parseIpSplit = st => parseIp(st?.inningsPitched) || 0;
  const result = {
    opsVsL:  parseFloat(splitMap['vl']?.ops || 0) || null,
    opsVsR:  parseFloat(splitMap['vr']?.ops || 0) || null,
    paVsL:   parseInt(splitMap['vl']?.plateAppearances || 0),
    paVsR:   parseInt(splitMap['vr']?.plateAppearances || 0),
    eraHome: parseEra(splitMap['h']),
    ipHome:  parseIpSplit(splitMap['h']),
    eraAway: parseEra(splitMap['a']),
    ipAway:  parseIpSplit(splitMap['a']),
  };
  pitcherSplitCache[id] = result;
  return result;
}

// ---------------------------------------------------------------------------
// Baseball Savant leaderboards — cached daily.
// Batter & pitcher expected/descriptive stats (xwOBA, xERA, whiff%, etc.).
// ---------------------------------------------------------------------------
// Header-aware row parser. The first column is the quoted "last_name, first_name"
// (which itself contains a comma); every remaining column is comma-separated with
// no internal commas, so we slice past the name then split. Returns an array of
// objects keyed by header column name (raw string values).
function parseSavantRows(text) {
  const lines = text.replace(/^﻿/, '').split('\n');
  let hi = 0;
  while (hi < lines.length && !lines[hi].trim()) hi++;
  const hMark = lines[hi]?.indexOf('",');
  if (hMark == null || hMark === -1) return [];
  const cols = lines[hi].slice(hMark + 2).split(',').map(s => s.replace(/"/g, '').trim());
  const rows = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.indexOf('",');
    if (m === -1) continue;
    const vals = line.slice(m + 2).split(',');
    const obj = {};
    // The sliced-off first column IS the player name ("Last, First") — preserve it
    // under a reserved key (Charts view needs display names).
    obj.__name = line.slice(0, m).replace(/^"/, '').trim();
    cols.forEach((c, j) => { obj[c] = (vals[j] || '').replace(/"/g, '').trim(); });
    rows.push(obj);
  }
  return rows;
}

const SAVANT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchSavantRows(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': SAVANT_UA }, signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) { console.warn(`[savant] HTTP ${r.status}`); return []; }
    return parseSavantRows(await r.text());
  } catch (e) {
    clearTimeout(timer);
    console.warn('[savant] fetch failed:', e.message);
    return [];
  }
}

const num = v => { const n = parseFloat(String(v).replace(/"/g, '')); return isNaN(n) ? null : n; };

async function loadSavantLeaderboard() {
  const today = localDate();
  if (savantDate === today && Object.keys(savantData).length > 0) return;
  const base = `https://baseballsavant.mlb.com/leaderboard/custom?year=${SEASON}&filter=&csv=true&sort=1&sortDir=desc`;
  // slg_percent/batting_avg/home_run/pa (+p_era pitcher-side) added for the
  // Charts view — the ACTUAL outcomes that pair with the expected stats in luck scatters.
  const batterUrl  = `${base}&type=batter&min=20&selections=exit_velocity_avg,hard_hit_percent,barrel_batted_rate,xwoba,woba,xba,xslg,flyballs_percent,pull_percent,straightaway_percent,opposite_percent,avg_swing_speed,avg_swing_length,fast_swing_rate,sprint_speed,oz_swing_percent,z_swing_miss_percent,oz_swing_miss_percent,attack_direction,slg_percent,batting_avg,home_run,pa`;
  const pitcherUrl = `${base}&type=pitcher&min=20&selections=xera,p_era,xwoba,woba,k_percent,bb_percent,whiff_percent,xslg,xba,hard_hit_percent,barrel_batted_rate,oz_swing_percent,z_swing_miss_percent,oz_swing_miss_percent`;

  const oaaUrl  = `https://baseballsavant.mlb.com/leaderboard/outs_above_average?type=Fielder&year=${SEASON}&min=q&team=&csv=true`;
  const arsPUrl = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&pitchType=&year=${SEASON}&team=&min=50&csv=true`;
  const arsBUrl = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=batter&pitchType=&year=${SEASON}&team=&min=10&csv=true`;
  // Pitch-movement feed carries avg_speed per pitch type (the arsenal feed has no speed
  // column — that's why veloEdge was silently dead). Max avg_speed/pitcher ≈ fastball velo.
  const moveUrl = `https://baseballsavant.mlb.com/leaderboard/pitch-movement?year=${SEASON}&team=&min=q&pitch_type=&csv=true`;

  const [batters, pitchers, fielders, arsP, arsB, movement] = await Promise.all([
    fetchSavantRows(batterUrl), fetchSavantRows(pitcherUrl), fetchSavantRows(oaaUrl),
    fetchSavantRows(arsPUrl), fetchSavantRows(arsBUrl), fetchSavantRows(moveUrl),
  ]);

  if (batters.length > 10) {
    const parsed = {};
    for (const r of batters) {
      const id = parseInt(r.player_id);
      if (!id) continue;
      const br = num(r.barrel_batted_rate);
      const zMiss = num(r.z_swing_miss_percent), ozMiss = num(r.oz_swing_miss_percent);
      parsed[id] = {
        exitVeloAvg: num(r.exit_velocity_avg),
        hardHitPct:  num(r.hard_hit_percent),
        barrelRate:  br === null ? null : br,
        xwoba:       num(r.xwoba),
        woba:        num(r.woba),
        xba:         num(r.xba),
        xslg:        num(r.xslg),
        fbPct:       num(r.flyballs_percent),
        pullPct:     num(r.pull_percent),
        // Spray split — lets wind be modeled toward each batter's REAL
        // dominant field instead of just interpolating between pull and dead-CF. An
        // oppo-heavy hitter's wind exposure looks nothing like a pull hitter's mirrored
        // — it's a genuinely different direction, not "less pull." Real example that
        // prompted this: J.D. Martinez lost 10 HRs to wind across SIX different parks in
        // 2023-24 (MLB Statcast/Weather Applied Metrics), attributed to his oppo-heavy
        // approach rather than any one bad home park — a park-level fix can't catch that,
        // only a per-batter spray-direction wind model can.
        straightPct: num(r.straightaway_percent),
        oppoPct:     num(r.opposite_percent),
        batSpeed:    num(r.avg_swing_speed),    // Statcast bat-tracking: avg swing speed (mph)
        swingLen:    num(r.avg_swing_length),   // avg swing length (ft)
        fastSwingPct: num(r.fast_swing_rate),   // % of swings ≥75 mph
        // Bat-tracking swing direction : degrees the barrel points at contact,
        // NEGATIVE = pull side (Savant convention, confirmed corr -0.70 vs pull%). Used as
        // the swing-change leading indicator in probabilities.js — mechanics move weeks
        // before outcome spray does (validated: 2025 mechanics-vs-outcomes divergence →
        // 2026 pull change correlation; top-decile divergers +3.6pts pull vs +0.2 rest).
        attackDirection: num(r.attack_direction),
        sprintSpeed: num(r.sprint_speed),       // ft/sec — speed axis for BABIP/infield hits
        // Plate discipline (Statcast attack-zone swing/take data). chaseRate = O-Swing%,
        // swing rate on pitches outside the zone — one of the best individual predictors
        // of K risk, since it's a swing-DECISION quality signal rather than an outcome
        // that already bakes in contact luck. zContactPct/oContactPct split contact
        // quality by zone (Savant only exposes the miss-rate complement, hence 100-x).
        chaseRate:   num(r.oz_swing_percent),
        zContactPct: zMiss  != null ? +(100 - zMiss).toFixed(1)  : null,
        oContactPct: ozMiss != null ? +(100 - ozMiss).toFixed(1) : null,
        // Charts view : actuals for the luck scatters + a display name
        // (from parseSavantRows' reserved __name key — the raw header column is
        // sliced off before splitting, see that function).
        name:  r.__name || null,
        slg:   num(r.slg_percent),
        avg:   num(r.batting_avg),
        hr:    parseInt(r.home_run) || 0,
        pa:    parseInt(r.pa) || 0,
      };
    }
    savantData = parsed;
    savantDate = today;
    console.log(`[savant] Loaded ${Object.keys(parsed).length} batters (+ expected stats)`);
  }

  if (pitchers.length > 10) {
    const parsed = {};
    for (const r of pitchers) {
      const id = parseInt(r.player_id);
      if (!id) continue;
      const kp = num(r.k_percent), bbp = num(r.bb_percent);
      parsed[id] = {
        xera:     num(r.xera),
        xwoba:    num(r.xwoba),   // xwOBA allowed
        woba:     num(r.woba),    // wOBA allowed
        xslg:     num(r.xslg),    // xSLG allowed — slugging permitted; the TB-correct pitcher stat
        xbaAllowed: num(r.xba),   // xBA allowed — the direct pitcher-side mirror of the batter xBA already used for Hit
        kPct:     kp,
        bbPct:    bbp,
        whiffPct: num(r.whiff_percent),
        hardHitPctAllowed: num(r.hard_hit_percent),  // contact quality allowed (same field the batter side already uses)
        barrelPctAllowed:  num(r.barrel_batted_rate), // barrels allowed — near-direct HR/XBH predictor
        // K/BB ratio: a stickier, more predictive command signal than ERA or K%/BB% alone.
        // Both rates were already fetched separately for other purposes but never combined.
        kbb: (kp != null && bbp != null && bbp > 0) ? +(kp / bbp).toFixed(2) : null,
        // Plate discipline INDUCED — this pitcher's own chase/contact-suppression stuff,
        // the mirror of the batter-side fields above.
        chaseRateInduced: num(r.oz_swing_percent),
        zContactPctAllowed: (() => { const v = num(r.z_swing_miss_percent);  return v != null ? +(100 - v).toFixed(1) : null; })(),
        oContactPctAllowed: (() => { const v = num(r.oz_swing_miss_percent); return v != null ? +(100 - v).toFixed(1) : null; })(),
        // Charts view : actual ERA + display name for the xERA luck scatter.
        era:  num(r.p_era),
        name: r.__name || null,
      };
    }
    savantPitcherData = parsed;
    const whiffVals = Object.values(parsed).map(p => p.whiffPct).filter(v => v != null);
    if (whiffVals.length > 10) leagueWhiffAvg = whiffVals.reduce((a, b) => a + b, 0) / whiffVals.length;
    console.log(`[savant] Loaded ${Object.keys(parsed).length} pitchers (expected stats)`);
  }

  if (fielders.length > 50) {
    const byTeam = {};
    for (const r of fielders) {
      const team = (r.display_team_name || '').trim().toLowerCase();
      if (!team) continue;
      const oaa = num(r.outs_above_average);
      const frp = num(r.fielding_runs_prevented);
      if (!byTeam[team]) byTeam[team] = { oaa: 0, frp: 0 };
      if (oaa != null) byTeam[team].oaa += oaa;
      if (frp != null) byTeam[team].frp += frp;
    }
    if (Object.keys(byTeam).length >= 20) {
      teamDefenseData = byTeam;
      console.log(`[savant] Loaded team defense for ${Object.keys(byTeam).length} teams`);
    }
  }

  // Pitch arsenals — multiple rows per player (one per pitch type), grouped by id.
  if (arsP.length > 50) {
    const m = {};
    for (const r of arsP) {
      const id = parseInt(r.player_id); const pt = r.pitch_type; const usage = num(r.pitch_usage);
      if (!id || !pt || usage == null) continue;
      (m[id] ||= {})[pt] = usage;
    }
    pitcherArsenalData = m;
    console.log(`[savant] Loaded arsenals for ${Object.keys(m).length} pitchers`);
  }

  // Fastball velocity from the pitch-movement feed — max avg_speed per pitcher ≈ the
  // fastest offering's average (≈ 4-seam/sinker velo). Column: pitcher_id, avg_speed.
  if (movement.length > 50) {
    const velo = {};
    for (const r of movement) {
      const id = parseInt(r.pitcher_id);
      const sp = num(r.avg_speed);
      if (!id || sp == null || sp <= 0) continue;
      velo[id] = Math.max(velo[id] ?? 0, sp);
    }
    pitcherFbVeloData = velo;
    console.log(`[savant] Loaded fastball velo for ${Object.keys(velo).length} pitchers`);
  }
  if (arsB.length > 50) {
    const m = {}, w = {}, grp = {};
    for (const r of arsB) {
      const id = parseInt(r.player_id); const pt = r.pitch_type;
      if (!id || !pt) continue;
      const rv = num(r.run_value_per_100);
      if (rv != null) (m[id] ||= {})[pt] = rv;
      // whiff_percent is per-pitch-type whiff rate; normalize to a 0-1 fraction.
      const wf = num(r.whiff_percent);
      const wff = wf == null ? null : (wf > 1 ? wf / 100 : wf);
      if (wff != null) (w[id] ||= {})[pt] = wff;
      // PA-weighted aggregation by pitch GROUP for crush/auto-out tags.
      const g = PITCH_GROUP(pt); const pa = num(r.pa); const slg = num(r.slg);
      if (g && pa != null && pa > 0) {
        const gg = ((grp[id] ||= {})[g] ||= { pa: 0, _tb: 0, _wh: 0 });
        gg.pa += pa;
        if (slg != null) gg._tb += slg * pa;
        if (wff != null) gg._wh += wff * pa;
      }
    }
    for (const id in grp) for (const g in grp[id]) {
      const gg = grp[id][g];
      grp[id][g] = { pa: gg.pa, slg: gg.pa ? gg._tb / gg.pa : null, whiff: gg.pa ? gg._wh / gg.pa : null };
    }
    batterArsenalData   = m;
    batterArsenalWhiff  = w;
    batterArsenalGroups = grp;
    console.log(`[savant] Loaded pitch-type run values for ${Object.keys(m).length} batters (+ whiff ${Object.keys(w).length}, group tags ${Object.keys(grp).length})`);
  }

  // Team K% (as batters) — MLB Stats API, not Savant. Needed for the SP projected-K
  // formula's "opponent K-vulnerability" factor (validated : real, if modest,
  // improvement — 0.349→0.380 correlation in a 1,509-start leakage-free backtest).
  try {
    const teamHit = await mlbGet(`${API}/teams/stats?season=${SEASON}&sportIds=1&group=hitting&stats=season`);
    const out = {};
    for (const s of (teamHit?.stats?.[0]?.splits || [])) {
      const teamId = s.team?.id;
      const pa = parseInt(s.stat?.plateAppearances || 0);
      const so = parseInt(s.stat?.strikeOuts || 0);
      if (teamId && pa > 0) out[teamId] = so / pa;
    }
    if (Object.keys(out).length > 10) {
      teamKPctData = out;
      const kVals = Object.values(out);
      leagueKPctAvg = kVals.reduce((a, b) => a + b, 0) / kVals.length;
      console.log(`[savant] Loaded team K% (batting) for ${Object.keys(out).length} teams`);
    }
  } catch (e) { console.error(`[savant] Team K% load failed: ${e.message}`); }
}

function getSavantData()        { return savantData; }
function getSavantPitcherData() { return savantPitcherData; }

// Prior-season (SEASON-1) pitcher xwOBA-allowed — real established talent mark for a
// pitcher whose CURRENT season is too thin to trust (e.g. a season-debut return from a long
// injury absence). Concrete case that surfaced this : Hunter Greene's 2026 line
// was ONE start (3.1 IP, 21.60 ERA) — below Savant's min=20-BF leaderboard floor, so
// getSavantPitcherData[id] was simply undefined and matchupEffectiveOps silently defaulted
// to flat league-average (1.0), modeling him as neither his bad debut NOR his real track
// record. Static/historical — fetched once per process (no daily refresh needed).
let savantPitcherPriorLoading = null;
async function getSavantPitcherPriorData() {
  if (Object.keys(savantPitcherPriorData).length) return savantPitcherPriorData;
  if (savantPitcherPriorLoading) return savantPitcherPriorLoading;
  savantPitcherPriorLoading = (async () => {
    try {
      const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${SEASON - 1}&filter=&csv=true&sort=1&sortDir=desc&type=pitcher&min=20&selections=xwoba`;
      const rows = await fetchSavantRows(url);
      const parsed = {};
      for (const r of rows) {
        const id = parseInt(r.player_id);
        if (!id) continue;
        parsed[id] = { xwoba: num(r.xwoba) };
      }
      savantPitcherPriorData = parsed;
      console.log(`[savant] Loaded ${Object.keys(parsed).length} pitchers' prior-season (${SEASON - 1}) xwOBA`);
    } catch (e) {
      console.error(`[savant] Prior-season pitcher load failed: ${e.message}`);
    }
    return savantPitcherPriorData;
  })();
  return savantPitcherPriorLoading;
}
function getPitcherArsenal()    { return pitcherArsenalData; }
function getPitcherFbVelo()     { return pitcherFbVeloData; }
function getBatterArsenal()     { return batterArsenalData; }
function getBatterArsenalWhiff(){ return batterArsenalWhiff; }

// Per-batter pitch-arsenal matchup vs ONE pitcher's pitch mix. Returns
// { rv, coverage }: rv = the batter's run_value/100 (batter-positive) averaged over
// THIS pitcher's pitch types, weighted by how often the pitcher throws each (so a
// batter who crushes sliders gets a big boost vs a slider-heavy arm); coverage =
// fraction of the pitcher's usage covered by pitch types we have batter data for.
// null when either side lacks arsenal data. Used by the player-prop model (the win
// model has its own lineup-level arsenalMatchup).
function getBatterArsenalValue(batterId, pitcherId) {
  const arsenal = pitcherArsenalData[pitcherId];
  const bv      = batterArsenalData[batterId];
  if (!arsenal || !bv) return null;
  const usageTotal = Object.values(arsenal).reduce((s, u) => s + u, 0) || 1;
  let score = 0, covered = 0;
  for (const [pt, usage] of Object.entries(arsenal)) {
    if (bv[pt] == null) continue;
    score += bv[pt] * usage; covered += usage;
  }
  if (covered <= 0) return null;
  return { rv: score / covered, coverage: covered / usageTotal };
}

// Per-batter whiff matchup vs ONE pitcher's pitch mix. Returns { whiff, coverage }:
// whiff = the batter's whiff rate (0-1) averaged over THIS pitcher's pitch types,
// usage-weighted (so a batter who whiffs on sliders gets exposed by a slider-heavy
// arm). The direct K signal, vs the composite run_value used for offense. null when
// either side lacks arsenal data.
function getBatterWhiffValue(batterId, pitcherId) {
  const arsenal = pitcherArsenalData[pitcherId];
  const wv      = batterArsenalWhiff[batterId];
  if (!arsenal || !wv) return null;
  const usageTotal = Object.values(arsenal).reduce((s, u) => s + u, 0) || 1;
  let score = 0, covered = 0;
  for (const [pt, usage] of Object.entries(arsenal)) {
    if (wv[pt] == null) continue;
    score += wv[pt] * usage; covered += usage;
  }
  if (covered <= 0) return null;
  return { whiff: score / covered, coverage: covered / usageTotal };
}

// Pitcher pitch-mix as FB/BRK/OFF usage fractions (0-1). null if no arsenal.
// NOTE: the Savant arsenal CSV filters each pitch-type row by min PA ENDING on that
// pitch (not raw pitch count) — a pitcher who hasn't yet faced 50 PAs on his slider
// this season simply has no SL row, even though pitch_usage on the surviving rows is
// already a % of his TRUE season-total pitches. Renormalizing over just the surviving
// rows (dividing by their sum) would inflate a low-innings pitcher's fastball share
// toward 100% whenever his secondary pitches haven't cleared that PA bar yet. Instead,
// treat each row's usage as already-absolute (divide by 100, not by the visible sum) —
// missing groups correctly read as underrepresented rather than the visible group
// reading as overrepresented.
function pitcherGroupUsage(pitcherId) {
  const ars = pitcherArsenalData[pitcherId];
  if (!ars) return null;
  const g = { FB: 0, BRK: 0, OFF: 0 };
  for (const [pt, u] of Object.entries(ars)) {
    const grp = PITCH_GROUP(pt); if (grp) g[grp] += u;
  }
  return { FB: g.FB / 100, BRK: g.BRK / 100, OFF: g.OFF / 100 };
}

// AUTO-OUT K matchup: does the SP throw the hitter's auto-out pitch group heavily? A group is
// an auto-out when the batter whiffs ≥40% AND slugs ≤.400 against it (a true contact hole).
// Validated 6/18-27: when the SP throws it ≥25%, the batter K's far more (K≥1 75.9% vs 57.5%
// base, K≥2 32.4% vs 20.7%). Returns the strongest matched hole, else { matched:false }.
function getAutoOutKMatchup(batterId, pitcherId) {
  const groups = batterArsenalGroups[batterId];
  const usage  = pitcherGroupUsage(pitcherId);
  if (!groups || !usage) return null;
  let best = null;
  for (const g of ['FB', 'BRK', 'OFF']) {
    const bg = groups[g];
    if (!bg || bg.pa < 20 || bg.whiff == null || bg.slg == null) continue;
    if (!(bg.whiff >= 0.40 && bg.slg <= 0.400)) continue;   // not a true hole
    const u = usage[g] || 0;
    if (u >= 0.25 && (!best || u > best.usage)) best = { matched: true, group: g, usage: u, whiff: bg.whiff, slg: bg.slg };
  }
  return best || { matched: false };
}

// CRUSH HR matchup: does the SP throw a pitch group the hitter CRUSHES (group SLG ≥.500) heavily?
// Validated 6/14-27 at the GROUP level (won a 3-group vs 5-shape vs pitch-type bake-off): when
// the SP throws the hitter's crush group ≥25%, HR rate ~1.47x (17.5% vs 11-12%). Returns the
// strongest matched crush group, else { matched:false }.
function getCrushHrMatchup(batterId, pitcherId) {
  const groups = batterArsenalGroups[batterId];
  const usage  = pitcherGroupUsage(pitcherId);
  if (!groups || !usage) return null;
  let best = null;
  for (const g of ['FB', 'BRK', 'OFF']) {
    const bg = groups[g];
    if (!bg || bg.pa < 20 || bg.slg == null || bg.slg < 0.500) continue;
    const u = usage[g] || 0;
    if (u >= 0.25 && (!best || u > best.usage)) best = { matched: true, group: g, usage: u, slg: bg.slg };
  }
  return best || { matched: false };
}

// Read-only accessor for testing/debugging alternate thresholds against the raw
// per-batter arsenal-group data, without duplicating getCrushHrMatchup's internal state.
function getBatterArsenalGroups() { return batterArsenalGroups; }

// Team defense by full MLB name (e.g. "Washington Nationals"); Savant keys are
// nicknames (e.g. "nationals"), so match by the full name ending with a nickname.
function getTeamDefense(fullName) {
  const n = (fullName || '').toLowerCase();
  if (!n) return null;
  for (const nick of Object.keys(teamDefenseData)) {
    if (n.endsWith(nick) || n.includes(nick)) return teamDefenseData[nick];
  }
  return null;
}

function getTeamKPct(teamId) { return teamId != null ? (teamKPctData[teamId] ?? null) : null; }
function getLeagueKPctAvg() { return leagueKPctAvg; }
function getLeagueWhiffAvg() { return leagueWhiffAvg; }

// ---------------------------------------------------------------------------
// Batter caches
// ---------------------------------------------------------------------------
// Build (and cache) a teamId → home venueId map once. Deduped across concurrent
// callers via a shared promise so a lineup's parallel batter fetches trigger one call.
async function loadTeamVenues() {
  if (teamVenueMap) return teamVenueMap;
  if (teamVenuePromise) return teamVenuePromise;
  teamVenuePromise = (async () => {
    const data = await mlbGet(`${API}/teams?sportId=1`);
    const map = {};
    for (const t of (data?.teams || [])) if (t.id && t.venue?.id) map[t.id] = t.venue.id;
    if (Object.keys(map).length >= 25) teamVenueMap = map;
    return teamVenueMap || {};
  })();
  return teamVenuePromise;
}

// gameLog split → game venueId, derived from the home team (isHome ? team : opponent).
function splitVenueId(g) {
  const m = teamVenueMap; if (!m) return null;
  const tid = g.isHome ? g.team?.id : g.opponent?.id;
  return tid != null ? m[tid] : null;
}

async function getRecentBatterStats(batterId) {
  if (recentBatterCache[batterId] !== undefined) return recentBatterCache[batterId];
  await loadTeamVenues();
  const data = await mlbGet(`${API}/people/${batterId}/stats?stats=gameLog&season=${SEASON}&group=hitting`);
  const splits = data?.stats?.[0]?.splits || [];
  const last14 = splits.slice(-14);
  const hr14  = last14.reduce((s, g) => s + parseInt(g.stat?.homeRuns   || 0), 0);
  const h14   = last14.reduce((s, g) => s + parseInt(g.stat?.hits        || 0), 0);
  const ab14  = last14.reduce((s, g) => s + parseInt(g.stat?.atBats      || 0), 0);
  const bb14  = last14.reduce((s, g) => s + parseInt(g.stat?.baseOnBalls || 0), 0);
  const hbp14 = last14.reduce((s, g) => s + parseInt(g.stat?.hitByPitch  || 0), 0);
  const sf14  = last14.reduce((s, g) => s + parseInt(g.stat?.sacFlies    || 0), 0);
  const so14  = last14.reduce((s, g) => s + parseInt(g.stat?.strikeOuts  || 0), 0);
  const pa14  = ab14 + bb14 + hbp14 + sf14;

  const recent = [...splits].reverse();
  let hitStreak = 0, hitlessStreak = 0, streakDone = false, coldDone = false;
  let hitlessAbs = 0, absSinceHr = 0, gamesSinceHr = 0;
  let hitlessAbsDone = false, hrDone = false;
  for (const g of recent) {
    const ab = parseInt(g.stat?.atBats   || 0);
    const h  = parseInt(g.stat?.hits     || 0);
    const hr = parseInt(g.stat?.homeRuns || 0);
    if (ab === 0) continue;
    if (!streakDone)    { if (h > 0)  hitStreak++;     else streakDone    = true; }
    if (!coldDone)      { if (h === 0) hitlessStreak++; else coldDone     = true; }
    if (!hitlessAbsDone){ if (h > 0)  hitlessAbsDone = true; else hitlessAbs += ab; }
    if (!hrDone)        { if (hr > 0) hrDone = true;   else { absSinceHr += ab; gamesSinceHr++; } }
    if (streakDone && coldDone && hitlessAbsDone && hrDone) break;
  }

  const last7  = splits.slice(-7);
  const h7     = last7.reduce((s, g) => s + parseInt(g.stat?.hits        || 0), 0);
  const ab7    = last7.reduce((s, g) => s + parseInt(g.stat?.atBats      || 0), 0);
  const bb7    = last7.reduce((s, g) => s + parseInt(g.stat?.baseOnBalls || 0), 0);
  const hbp7   = last7.reduce((s, g) => s + parseInt(g.stat?.hitByPitch  || 0), 0);
  const sf7    = last7.reduce((s, g) => s + parseInt(g.stat?.sacFlies    || 0), 0);
  const so7    = last7.reduce((s, g) => s + parseInt(g.stat?.strikeOuts  || 0), 0);
  const pa7    = ab7 + bb7 + hbp7 + sf7;
  const rGames7 = last7.filter(g => parseInt(g.stat?.runs || 0) > 0 && parseInt(g.stat?.atBats || 0) > 0).length;

  // Build venue-specific stats map from full season log
  const venueMap = {};
  for (const g of splits) {
    const vid = splitVenueId(g);
    if (!vid) continue;
    if (!venueMap[vid]) venueMap[vid] = { ab: 0, h: 0, hr: 0, bb: 0, hbp: 0, sf: 0, d: 0, t: 0, so: 0 };
    const v = venueMap[vid];
    v.ab  += parseInt(g.stat?.atBats        || 0);
    v.h   += parseInt(g.stat?.hits          || 0);
    v.hr  += parseInt(g.stat?.homeRuns      || 0);
    v.bb  += parseInt(g.stat?.baseOnBalls   || 0);
    v.hbp += parseInt(g.stat?.hitByPitch    || 0);
    v.sf  += parseInt(g.stat?.sacFlies      || 0);
    v.d   += parseInt(g.stat?.doubles       || 0);
    v.t   += parseInt(g.stat?.triples       || 0);
    v.so  += parseInt(g.stat?.strikeOuts    || 0);
  }

  // Early-hook / platoon-pull risk : a short-side platoon bat (e.g. an R-handed
  // masher who struggles vs RHP) is often started against a favorable-hand starter, then
  // pinch-hit for or defensively subbed out once the opponent brings in an unfavorable-hand
  // reliever mid-game — long before batting-order slot alone would predict. Validated same
  // day on real data: Randal Grichuk and Nelson Velázquez (both flagged by the user) averaged
  // 2.5-2.6 PA/game with 7-8 sub-3-PA outings across their last 15 appearances, vs 4.3-4.5 PA
  // and 0-1 short outings for everyday hitters (Witt Jr, Freeman) — a clean, large gap using
  // data already fetched here, no new API calls. Only counts games the batter actually
  // appeared in (PA>=1) — full rest days are a different signal (lineup slot), not this one.
  const appeared15 = splits.filter(g => (parseInt(g.stat?.plateAppearances || 0)) >= 1).slice(-15);
  const LG_AVG_PA_PER_GAME = 4.1;
  let avgPa15 = null, paRealizationRatio = null, shortGames15 = 0;
  if (appeared15.length >= 8) {
    const paSum = appeared15.reduce((s, g) => s + parseInt(g.stat?.plateAppearances || 0), 0);
    avgPa15 = paSum / appeared15.length;
    shortGames15 = appeared15.filter(g => parseInt(g.stat?.plateAppearances || 0) <= 2).length;
    paRealizationRatio = +Math.max(0.55, Math.min(1.15, avgPa15 / LG_AVG_PA_PER_GAME)).toFixed(3);
  }

  const result = {
    hr14, g14: last14.length, pa14, so14,
    avgPa15, paRealizationRatio, shortGames15,
    obp14:        pa14 > 0 ? (h14 + bb14 + hbp14) / pa14 : null,
    avg14:        ab14 > 0 ? h14 / ab14                   : null,
    kPct14:       pa14 >= 15 ? so14 / pa14                : null,
    avg7:         ab7  >= 15 ? h7 / ab7                   : null,
    obp7:         pa7  >= 15 ? (h7 + bb7 + hbp7) / pa7   : null,
    // Recent strikeout form (last 7 games) — feeds the "ice cold / 45%+ K" pick area.
    // Min 10 PA so a 1-of-2 fluke can't qualify; a true cold everyday bat clears it easily.
    so7, pa7, kPct7: pa7 >= 10 ? so7 / pa7 : null,
    ab7, rGames7,
    hitStreak,
    hitlessStreak,
    hitlessAbs,
    absSinceHr,
    gamesSinceHr,
    venueMap,
  };
  recentBatterCache[batterId] = result;
  return result;
}

function getBatterVenueStats(batterId, venueId) {
  if (!venueId) return null;
  const r = recentBatterCache[batterId];
  const v = r?.venueMap?.[venueId];
  if (!v || v.ab < 8) return null;
  const avg = v.h / v.ab;
  const pa  = v.ab + v.bb + v.hbp + v.sf;
  const obp = pa > 0 ? (v.h + v.bb + v.hbp) / pa : 0;
  const tb  = v.h - v.d - v.t - v.hr + 2 * v.d + 3 * v.t + 4 * v.hr;
  const slg = v.ab > 0 ? tb / v.ab : 0;
  return { ab: v.ab, h: v.h, hr: v.hr, avg, obp, slg, ops: obp + slg };
}

// Fetch last 3 seasons' game logs and aggregate per-venue stats — cached 7 days
async function getCareerVenueStats(batterId) {
  const cached = careerVenueCache[batterId];
  if (cached && Date.now() < cached.exp) return cached.data;

  await loadTeamVenues();
  const years = [SEASON - 1, SEASON - 2, SEASON - 3];
  const venueMap = {};

  await Promise.all(years.map(async year => {
    try {
      const data = await mlbGet(`${API}/people/${batterId}/stats?stats=gameLog&season=${year}&group=hitting`);
      for (const g of data?.stats?.[0]?.splits || []) {
        const vid = splitVenueId(g);
        if (!vid) continue;
        if (!venueMap[vid]) venueMap[vid] = { ab: 0, h: 0, hr: 0, bb: 0, hbp: 0, sf: 0, so: 0 };
        const v = venueMap[vid];
        const s = g.stat || {};
        v.ab  += parseInt(s.atBats      || 0);
        v.h   += parseInt(s.hits        || 0);
        v.hr  += parseInt(s.homeRuns    || 0);
        v.bb  += parseInt(s.baseOnBalls || 0);
        v.hbp += parseInt(s.hitByPitch  || 0);
        v.sf  += parseInt(s.sacFlies    || 0);
        v.so  += parseInt(s.strikeOuts  || 0);
      }
    } catch {}
  }));

  const result = {};
  for (const [vid, v] of Object.entries(venueMap)) {
    if (v.ab < 8) continue;
    const pa = v.ab + v.bb + v.hbp + v.sf;
    result[vid] = {
      ab: v.ab, pa, h: v.h, hr: v.hr, so: v.so,
      avg:    v.h / v.ab,
      hrRate: pa > 0 ? v.hr / pa : 0,
      kRate:  pa > 0 ? v.so / pa : 0,
      obp:    pa > 0 ? (v.h + v.bb + v.hbp) / pa : 0,
    };
  }

  careerVenueCache[batterId] = { data: result, exp: Date.now() + CAREER_VENUE_TTL };
  return result;
}

// Sync read — merges 3-year historical with current season from recentBatterCache
function getCareerVenueCached(batterId, venueId) {
  if (!venueId) return null;
  const career = careerVenueCache[batterId]?.data?.[venueId];
  const cur    = recentBatterCache[batterId]?.venueMap?.[venueId];
  if (!career && !cur) return null;

  const ab  = (career?.ab  || 0) + (cur?.ab  || 0);
  if (ab < 10) return null;
  const h   = (career?.h   || 0) + (cur?.h   || 0);
  const hr  = (career?.hr  || 0) + (cur?.hr  || 0);
  const bb  = (career?.bb  || 0) + (cur?.bb  || 0);
  const hbp = (career?.hbp || 0) + (cur?.hbp || 0);
  const sf  = (career?.sf  || 0) + (cur?.sf  || 0);
  const so  = (career?.so  || 0) + (cur?.so  || 0);
  const pa  = ab + bb + hbp + sf;

  return { ab, pa, hr, so,
    avg:    h / ab,
    hrRate: pa > 0 ? hr / pa : 0,
    kRate:  pa > 0 ? so / pa : 0,
    obp:    pa > 0 ? (h + bb + hbp) / pa : 0,
  };
}

async function getBatterVsTeamStats(batterId, opposingTeamId) {
  const key = `${batterId}-t${opposingTeamId}`;
  if (vsTeamCache[key] !== undefined) return vsTeamCache[key];
  try {
    // opposingTeamId MUST be passed as a query param — without it this endpoint silently
    // returns zero splits (confirmed : same call minus this param returned an
    // empty split list for a real, established vs-team history). Was missing before,
    // meaning this — and the vsTeamHr category built on it — had been quietly returning
    // no data all along.
    const data = await mlbGet(`${API}/people/${batterId}/stats?stats=vsTeam&group=hitting&opposingTeamId=${opposingTeamId}`);
    const found = data?.stats?.[0]?.splits?.[0];
    if (!found) { vsTeamCache[key] = null; return null; }
    const s = found.stat;
    const g   = parseInt(s.gamesPlayed || 0);
    const ab  = parseInt(s.atBats      || 0);
    const hr  = parseInt(s.homeRuns    || 0);
    const h   = parseInt(s.hits        || 0);
    const rbi = parseInt(s.rbi         || 0);
    const avg = parseFloat(s.avg || 0) || null;
    const ops = parseFloat(s.ops || 0) || null;
    vsTeamCache[key] = { g, ab, hr, h, rbi, avg, ops };
  } catch (e) {
    vsTeamCache[key] = null;
  }
  return vsTeamCache[key];
}

// Attempt to parse and validate BvP splits from an API response.
// Returns a result object on success, or null if the response is invalid.
// Identity validation reworked (Soto-vs-Nola bug): split.opponent holds the
// opposing TEAM in current API responses, so matching it against a player id rejected
// perfectly valid data. Validate the split's own batter/pitcher fields instead — they
// name both players explicitly in every observed response shape.
function parseBvpSplits(data, batterId, pitcherId) {
  const totalGroup  = (data?.stats || []).find(sg => sg.type?.displayName === 'vsPlayerTotal');
  const seasonGroup = (data?.stats || []).find(sg => sg.type?.displayName === 'vsPlayer');
  const isTotal = !!totalGroup?.splits?.length;
  const splits = isTotal ? totalGroup.splits
               : seasonGroup?.splits?.length ? seasonGroup.splits
               : null;
  if (!splits) return null;

  // If any split names a different batter or pitcher than the pair we asked for, the
  // opposingPlayerId filter silently failed — reject the entire response. Fall back to
  // the opponent field only when neither player field is present (older response shapes).
  for (const split of splits) {
    if (split?.pitcher?.id != null && String(split.pitcher.id) !== String(pitcherId)) return null;
    if (split?.batter?.id  != null && String(split.batter.id)  !== String(batterId))  return null;
    if (split?.pitcher?.id == null && split?.batter?.id == null) {
      const oppId = split?.opponent?.id;
      if (oppId != null && String(oppId) !== String(pitcherId) && String(oppId) !== String(batterId)) return null;
    }
  }

  let ab = 0, h = 0, doubles = 0, triples = 0, hr = 0, rbi = 0, so = 0, bb = 0, hbp = 0, sf = 0;
  for (const split of splits) {
    const s = split.stat || {};
    const splitAb = parseInt(s.atBats || 0);
    // Per-season cap: >40 AB vs one pitcher in a single SEASON means the filter returned
    // broader stats. Career-total splits (vsPlayerTotal) are legitimately >40 AB for
    // veterans vs division rivals — capping those erased exactly the richest histories
    // (Soto ~59 PA vs Nola); the >100 AB career cap below still guards the total path.
    if (!isTotal && splitAb > 40) return null;
    ab      += splitAb;
    h       += parseInt(s.hits         || 0);
    doubles += parseInt(s.doubles      || 0);
    triples += parseInt(s.triples      || 0);
    hr      += parseInt(s.homeRuns     || 0);
    rbi     += parseInt(s.rbi          || 0);
    so      += parseInt(s.strikeOuts   || 0);
    bb      += parseInt(s.baseOnBalls  || 0);
    hbp     += parseInt(s.hitByPitch   || 0);
    sf      += parseInt(s.sacFlies     || 0);
  }
  if (ab === 0) return null;
  // Career cap: >100 AB vs one pitcher is implausible for an active player.
  if (ab > 100) return null;

  const pa  = ab + bb + hbp + sf;
  const avg = ab > 0 ? h / ab : null;
  const obp = pa > 0 ? (h + bb + hbp) / pa : null;
  const tb  = (h - doubles - triples - hr) + doubles * 2 + triples * 3 + hr * 4;
  const slg = ab > 0 ? tb / ab : null;
  const ops = obp != null && slg != null ? obp + slg : null;
  return {
    pa, ab, h, doubles, triples, hr, rbi, so, bb,
    avg, obp, slg, ops,
    kpct:  pa > 0 ? (so / pa * 100).toFixed(1) : null,
    bbpct: pa > 0 ? (bb / pa * 100).toFixed(1) : null,
    smallSample: ab < 10,
    noHistory:   false,
  };
}

async function getBvp(batterId, pitcherId) {
  const key = batterId + '-' + pitcherId;
  if (bvpCache[key] !== undefined) return bvpCache[key];

  // Attempt 1: batter-perspective (hitting group, batter is the subject)
  const batterData = await mlbGet(
    `${API}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}`
  );
  const result = parseBvpSplits(batterData, batterId, pitcherId);
  if (result) { bvpCache[key] = result; return result; }

  // Attempt 2: pitcher-perspective fallback (pitching group, pitcher is the subject).
  // The two directions use different internal API routing — a filter failure on one
  // side does not guarantee failure on the other. parseBvpSplits validates the split's
  // batter/pitcher fields itself, and the stat field names are identical across groups
  // (atBats, hits, homeRuns,...), so the same parser serves both perspectives.
  const pitcherData = await mlbGet(
    `${API}/people/${pitcherId}/stats?stats=vsPlayer&group=pitching&opposingPlayerId=${batterId}`
  );
  const fallback = parseBvpSplits(pitcherData, batterId, pitcherId);
  if (fallback) { bvpCache[key] = fallback; return fallback; }

  bvpCache[key] = null;
  return null;
}

function calcSplitStats(s) {
  if (!s) return null;
  const ab  = parseInt(s.atBats          || 0);
  const h   = parseInt(s.hits            || 0);
  const bb  = parseInt(s.baseOnBalls     || 0);
  const hbp = parseInt(s.hitByPitch      || 0);
  const sf  = parseInt(s.sacFlies        || 0);
  const d   = parseInt(s.doubles         || 0);
  const t   = parseInt(s.triples         || 0);
  const hr  = parseInt(s.homeRuns        || 0);
  const so  = parseInt(s.strikeOuts      || 0);
  const pa  = parseInt(s.plateAppearances|| 0);
  const denom = ab + bb + hbp + sf;
  const obp = denom > 0 ? (h + bb + hbp) / denom : 0;
  const slg = ab    > 0 ? (h + d + 2*t + 3*hr) / ab : 0;
  return { ab, h, bb, hbp, sf, d, t, hr, so, pa, obp, slg, ops: obp + slg, avg: ab > 0 ? h / ab : 0 };
}

async function getBatterSplits(id) {
  if (batterSplitCache[id]) return batterSplitCache[id];
  const [season, splits, homeAway, priorSeason] = await Promise.all([
    mlbGet(`${API}/people/${id}/stats?stats=season&season=${SEASON}&group=hitting`),
    mlbGet(`${API}/people/${id}/stats?stats=statSplits&season=${SEASON}&group=hitting&sitCodes=vl,vr`),
    mlbGet(`${API}/people/${id}/stats?stats=statSplits&season=${SEASON}&group=hitting&sitCodes=h,a`),
    // Prior-season line — anchors small current-season samples (regressed in the win model)
    mlbGet(`${API}/people/${id}/stats?stats=season&season=${SEASON - 1}&group=hitting`),
  ]);
  const st = season?.stats?.[0]?.splits?.[0]?.stat || {};
  const splitMap = {};
  for (const s of splits?.stats?.[0]?.splits || []) splitMap[s.split?.code] = s.stat;
  const vl = calcSplitStats(splitMap['vl']);
  const vr = calcSplitStats(splitMap['vr']);
  const haMap = {};
  for (const s of homeAway?.stats?.[0]?.splits || []) haMap[s.split?.code] = s.stat;
  const hm = calcSplitStats(haMap['h']);
  const aw = calcSplitStats(haMap['a']);
  const pst      = priorSeason?.stats?.[0]?.splits?.[0]?.stat || {};
  const opsPrior = parseFloat(pst.ops || 0) || null;
  const paPrior  = parseInt(pst.plateAppearances || 0);

  // Prior-season detail for YoY regression/breakout detection
  const pAb   = parseInt(pst.atBats       || 0);
  const pH    = parseInt(pst.hits         || 0);
  const pD    = parseInt(pst.doubles      || 0);
  const pT    = parseInt(pst.triples      || 0);
  const pHr   = parseInt(pst.homeRuns     || 0);
  const pK    = parseInt(pst.strikeOuts   || 0);
  const pBb   = parseInt(pst.baseOnBalls  || 0);
  const pIbb  = parseInt(pst.intentionalWalks || 0);
  const pHbp  = parseInt(pst.hitByPitch   || 0);
  const pSf   = parseInt(pst.sacFlies     || 0);
  const pDenom = pAb + pBb - pIbb + pSf + pHbp;
  const p1b    = Math.max(0, pH - pD - pT - pHr);
  const wobaPrior = pDenom >= 50
    ? +((0.697*(pBb-pIbb) + 0.727*pHbp + 0.892*p1b + 1.277*pD + 1.623*pT + 2.101*pHr) / pDenom).toFixed(3)
    : null;
  const avgPrior  = pAb >= 50 ? +(pH / pAb).toFixed(3) : null;
  const kPctPrior = paPrior > 0 ? +(pK / paPrior).toFixed(3) : null;
  const hrRatePrior = paPrior > 0 ? +(pHr / paPrior).toFixed(4) : null;
  const totalPa  = parseInt(st.plateAppearances || 0);
  const sbSeason = parseInt(st.stolenBases    || 0);
  const csSeason = parseInt(st.caughtStealing || 0);
  const wAb   = parseInt(st.atBats          || 0);
  const wH    = parseInt(st.hits            || 0);
  const wD    = parseInt(st.doubles         || 0);
  const wT    = parseInt(st.triples         || 0);
  const wHr   = parseInt(st.homeRuns        || 0);
  const wK    = parseInt(st.strikeOuts      || 0);
  const wBb   = parseInt(st.baseOnBalls     || 0);
  const wIbb  = parseInt(st.intentionalWalks|| 0);
  const wHbp  = parseInt(st.hitByPitch      || 0);
  const wSf   = parseInt(st.sacFlies        || 0);
  const babipDenom = wAb - wK - wHr + wSf;
  const babip      = babipDenom >= 80 ? +((wH - wHr) / babipDenom).toFixed(3) : null;
  const wDenom = wAb + wBb - wIbb + wSf + wHbp;
  const w1b   = Math.max(0, wH - wD - wT - wHr);
  const woba  = wDenom >= 50
    ? +((0.697*(wBb-wIbb) + 0.727*wHbp + 0.892*w1b + 1.277*wD + 1.623*wT + 2.101*wHr) / wDenom).toFixed(3)
    : null;
  // YoY regression/breakout: requires ≥200 prior PA and ≥80 current PA
  let yoyTrend = null;
  if (paPrior >= 200 && totalPa >= 80 && woba != null && wobaPrior != null) {
    const wobaDelta = woba - wobaPrior;
    const opsDelta  = opsPrior != null ? (parseFloat(st.ops || 0) || 0) - opsPrior : null;
    const avgDelta  = avgPrior != null && parseFloat(st.avg || 0) ? parseFloat(st.avg) - avgPrior : null;
    const kPctDelta = kPctPrior != null && totalPa > 0 ? (parseInt(st.strikeOuts || 0) / totalPa) - kPctPrior : null;
    // Composite score: wOBA-weighted (primary), OPS as tiebreak. Positive = better this year.
    const composite = wobaDelta + (opsDelta != null ? opsDelta * 0.15 : 0);
    // Thresholds: ≥0.025 composite = meaningful breakout; ≤-0.025 = regression
    if (Math.abs(composite) >= 0.025) {
      const dir = composite > 0 ? 'breakout' : 'regression';
      const severity = Math.abs(composite) >= 0.060 ? 'severe' : Math.abs(composite) >= 0.040 ? 'significant' : 'moderate';
      yoyTrend = {
        direction: dir,
        severity,
        composite:  +composite.toFixed(3),
        wobaDelta:  +wobaDelta.toFixed(3),
        opsDelta:   opsDelta != null ? +opsDelta.toFixed(3) : null,
        avgDelta:   avgDelta != null ? +avgDelta.toFixed(3) : null,
        kPctDelta:  kPctDelta != null ? +kPctDelta.toFixed(3) : null,
        wobaPrior,
        wobaCurr:   woba,
        paPrior,
      };
    }
  }

  const result = {
    ab:           parseInt(st.atBats || 0),
    pa:           totalPa,
    obp:          parseFloat(st.obp  || 0) || null,
    kPct:         totalPa > 0 ? parseInt(st.strikeOuts || 0) / totalPa : null,
    opsVsL:       vl?.ops  ?? null,
    opsVsR:       vr?.ops  ?? null,
    paVsL:        vl?.pa   ?? 0,
    paVsR:        vr?.pa   ?? 0,
    kPctVsL:      vl && vl.pa > 0 ? vl.so / vl.pa : null,
    kPctVsR:      vr && vr.pa > 0 ? vr.so / vr.pa : null,
    obpVsL:       vl?.obp  ?? null,
    obpVsR:       vr?.obp  ?? null,
    avg:          parseFloat(st.avg || 0) || null,
    avgVsL:       vl && vl.ab > 0 ? vl.avg : null,
    avgVsR:       vr && vr.ab > 0 ? vr.avg : null,
    hrRateTotal:  totalPa > 0 ? parseInt(st.homeRuns || 0) / totalPa : null,
    hrRateVsL:    vl && vl.pa > 0 ? vl.hr / vl.pa : null,
    hrRateVsR:    vr && vr.pa > 0 ? vr.hr / vr.pa : null,
    xbhRate:      totalPa > 0 ? (parseInt(st.doubles || 0) + parseInt(st.triples || 0) + parseInt(st.homeRuns || 0)) / totalPa : null,
    xbhRateVsL:   vl && vl.pa > 0 ? (vl.d + vl.t + vl.hr) / vl.pa : null,
    xbhRateVsR:   vr && vr.pa > 0 ? (vr.d + vr.t + vr.hr) / vr.pa : null,
    singlesRate:   totalPa > 0 ? Math.max(0, parseInt(st.hits || 0) - parseInt(st.doubles || 0) - parseInt(st.triples || 0) - parseInt(st.homeRuns || 0)) / totalPa : null,
    singlesRateVsL: vl && vl.pa > 0 ? Math.max(0, vl.h - vl.d - vl.t - vl.hr) / vl.pa : null,
    singlesRateVsR: vr && vr.pa > 0 ? Math.max(0, vr.h - vr.d - vr.t - vr.hr) / vr.pa : null,
    bbPct:        totalPa > 0 ? parseInt(st.baseOnBalls || 0) / totalPa : 0,
    bbPctVsL:     vl && vl.pa > 0 ? vl.bb / vl.pa : null,
    bbPctVsR:     vr && vr.pa > 0 ? vr.bb / vr.pa : null,
    // K/BB ratio — plate-discipline signal distinct from either rate alone: a batter can
    // have an average K% but a poor K/BB (walks rarely relative to his Ks), or vice versa.
    kbb:          (totalPa > 0 && parseInt(st.baseOnBalls || 0) > 0)
                    ? +((parseInt(st.strikeOuts || 0) / parseInt(st.baseOnBalls || 0))).toFixed(2)
                    : null,
    rbiPct:       totalPa > 0 ? parseInt(st.rbi  || 0) / totalPa : 0,
    runsPct:      totalPa > 0 ? parseInt(st.runs || 0) / totalPa : 0,
    sbAttemptRate: totalPa > 0 ? (sbSeason + csSeason) / totalPa : 0,
    sbAttempts:    sbSeason + csSeason, // raw count — needed to weight the sprint-speed stabilizer by real sample size
    sbSuccessRate: (sbSeason + csSeason) > 0 ? sbSeason / (sbSeason + csSeason) : 0.72,
    avgHome: hm && hm.ab >= 20 ? hm.avg : null,
    avgAway: aw && aw.ab >= 20 ? aw.avg : null,
    obpHome: hm && hm.pa >= 20 ? hm.obp : null,
    obpAway: aw && aw.pa >= 20 ? aw.obp : null,
    paHome:  hm?.pa ?? 0,
    paAway:  aw?.pa ?? 0,
    opsPrior, paPrior,
    wobaPrior, avgPrior, kPctPrior, hrRatePrior,
    woba, babip,
    yoyTrend,
  };
  batterSplitCache[id] = result;
  return result;
}

// A specific catcher's season CS rate (cs / attempts), cached by player id.
async function getCatcherCSById(playerId) {
  if (playerId == null) return 0.28;
  const key = 'p' + playerId;
  if (catcherCSCache[key] !== undefined) return catcherCSCache[key];
  const stats = await mlbGet(`${API}/people/${playerId}/stats?stats=season&season=${SEASON}&group=catching`);
  const st = stats?.stats?.[0]?.splits?.[0]?.stat;
  let cs = 0.28;
  if (st) {
    const csN = parseInt(st.caughtStealing || 0), sbN = parseInt(st.stolenBases || 0), total = csN + sbN;
    if (total >= 10) cs = csN / total;
  }
  catcherCSCache[key] = cs;
  return cs;
}

// Team's primary (roster) catcher CS — the fallback when no lineup is confirmed.
async function getCatcherCS(teamId) {
  if (catcherCSCache[teamId] !== undefined) return catcherCSCache[teamId];
  const roster = await mlbGet(`${API}/teams/${teamId}/roster?rosterType=active`);
  const catchers = (roster?.roster || []).filter(p => p.position?.code === '2');
  const cs = catchers.length ? await getCatcherCSById(catchers[0].person.id) : 0.28;
  catcherCSCache[teamId] = cs;
  return cs;
}

// "Personal catcher" pattern — validated (1,392 completed games, 161 starters
// with >=8 starts): 30.4% of starters have one catcher behind the plate for >=70% of
// their starts, 57.1% for >=60%. Confirmed concretely for St. Louis: Andre Pallante and
// Michael McGreevy each throw to Iván Herrera in 15/17 starts (88%). Used as a smarter
// pre-confirmation guess for who's catching tonight — reduces reliance on the crude
// "team's first-listed catcher" fallback before the real lineup posts.
const personalCatcherCache = {};
async function getPersonalCatcher(pitcherId) {
  if (pitcherId == null) return null;
  if (personalCatcherCache[pitcherId] !== undefined) return personalCatcherCache[pitcherId];

  let result = null;
  try {
    const log = await mlbGet(`${API}/people/${pitcherId}/stats?stats=gameLog&season=${SEASON}&group=pitching`);
    // Most recent 12 starts only — bounds request volume per pitcher (this was firing
    // 15-20 sequential box-score fetches per pitcher, ~2.5s each, on every cold-cache
    // lookup — confirmed as a real, serious latency regression) and keeps the
    // read current in case a personal-catcher pairing changes mid-season.
    const starts = (log?.stats?.[0]?.splits || [])
      .filter(s => (parseFloat(s.stat?.inningsPitched) || 0) >= 2 && s.stat?.gamesStarted >= 1 && s.game?.gamePk)
      .slice(-12);

    const counts = {};
    let identified = 0;
    const CONCURRENCY = 4; // batched, not all-at-once — mlbGet already rate-limits itself
    for (let i = 0; i < starts.length; i += CONCURRENCY) {
      const batch = starts.slice(i, i + CONCURRENCY);
      const boxes = await Promise.all(batch.map(s =>
        mlbGet(`${API}/game/${s.game.gamePk}/boxscore`).catch(() => null)
      ));
      batch.forEach((s, idx) => {
        const box = boxes[idx];
        const side = s.isHome ? box?.teams?.home : box?.teams?.away;
        for (const id of (side?.battingOrder || [])) {
          const p = side.players?.['ID' + id];
          if (p?.position?.code === '2') {
            counts[p.person.id] = (counts[p.person.id] || 0) + 1;
            identified++;
            break;
          }
        }
      });
    }
    if (identified >= 8) {
      const [topCatcherId, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      result = { catcherId: parseInt(topCatcherId), concentration: topCount / identified, starts: identified };
    }
  } catch { /* leave result null — falls through to the team-level fallback */ }

  personalCatcherCache[pitcherId] = result;
  return result;
}

// CS% of the catcher actually STARTING today (from the confirmed lineup), so a backup
// behind the plate is priced correctly. Falls back to the team's primary catcher when the
// lineup isn't confirmed yet or no catcher is found in it.
//
// Tries the per-game box score first — it carries each player's ACTUAL defensive
// assignment for THIS game, unlike the schedule's lineups hydrate (team.battersRaw),
// which only has each player's season-aggregate primaryPosition. That distinction matters
// for a two-way player who splits time between catching and DHing: validated
// with Ivan Herrera, who showed up as DH in one game of a doubleheader and C in the other
// (same day, same player) — while his season-level primaryPosition now just reads "DH"
// since he's DH'd more than caught this year, so the old battersRaw-only check would
// silently miss him on the very nights he's actually catching and fall back to a
// different catcher entirely (e.g. the roster's first-listed catcher, not the real one).
async function getStartingCatcherCS(team, gamePk, isHome) {
  if (gamePk) {
    try {
      const box = await mlbGet(`${API}/game/${gamePk}/boxscore`);
      const side = isHome ? box?.teams?.home : box?.teams?.away;
      for (const id of (side?.battingOrder || [])) {
        const p = side.players?.['ID' + id];
        if (p?.position?.code === '2') return getCatcherCSById(p.person.id);
      }
    } catch { /* fall through to the lineup-hydrate/roster fallback below */ }
  }
  const c = (team?.battersRaw || []).find(b => b.primaryPosition?.code === '2');
  if (c) return getCatcherCSById(c.id);
  // No confirmed lineup yet — before defaulting to the team's generic primary catcher,
  // check whether tonight's probable starter has a strong personal-catcher pattern.
  if (team?.probable?.id) {
    const personal = await getPersonalCatcher(team.probable.id);
    if (personal && personal.concentration >= 0.70 && personal.starts >= 8) {
      return getCatcherCSById(personal.catcherId);
    }
  }
  return getCatcherCS(team?.teamId);
}

// Recent (trailing 14-day) league HR per GAME (both teams) — the physical anchor for the
// slate-level HR calibration. Recent, not season-to-date, so it tracks the summer HR spike.
let leagueHrCache = { date: null, value: null };
async function getLeagueHrPerGame() {
  const today = localDate();
  if (leagueHrCache.date === today && leagueHrCache.value != null) return leagueHrCache.value;
  let val = 2.45;  // summer-ish fallback
  try {
    const start = addDays(today, -14), end = addDays(today, -1);
    const d = await mlbGet(`${API}/teams/stats?season=${SEASON}&sportIds=1&group=hitting&stats=byDateRange&startDate=${start}&endDate=${end}`);
    let hr = 0, gp = 0;
    for (const s of (d?.stats?.[0]?.splits || [])) { hr += parseInt(s.stat?.homeRuns || 0); gp += parseInt(s.stat?.gamesPlayed || 0); }
    if (gp > 60) val = +(2 * hr / gp).toFixed(3);   // ÷ (team-games/2) = per actual game
  } catch { /* keep fallback */ }
  leagueHrCache = { date: today, value: val };
  console.log(`[hrcal] recent league HR/game = ${val}`);
  return val;
}
function getLeagueHrPerGameSync() { return leagueHrCache.value ?? 2.45; }

async function getStandings() {
  const today = localDate();
  if (standingsCache.date === today && standingsCache.data) return standingsCache.data;
  const data = await mlbGet(`${API}/standings?leagueId=103,104&season=${SEASON}&hydrate=team,record`);
  const records = {};
  for (const div of data?.records || []) {
    for (const tr of div.teamRecords || []) records[tr.team.id] = tr;
  }
  standingsCache.date = today;
  standingsCache.data = records;
  return records;
}

// The team's active (26-man, non-IL) roster, as a Set of player IDs. Cached daily.
// rosterType=active naturally excludes anyone on the injured list, rehab assignment,
// bereavement/paternity list, etc. — a direct injury-status check, independent of
// whether today's lineup has been confirmed yet (a traded/injured player can otherwise
// slip through a lineup-based-only filter until the specific game's lineup posts).
async function getActiveRosterIds(teamId) {
  const today = localDate();
  const c = activeRosterCache[teamId];
  if (c && c.date === today) return c.ids;
  const d = await mlbGet(`${API}/teams/${teamId}/roster?rosterType=active`);
  const ids = new Set((d?.roster || []).map(r => r.person?.id).filter(Boolean));
  activeRosterCache[teamId] = { date: today, ids };
  return ids;
}

// Team runs scored per game (gamePk → runs) for the season + season RS/G. Cached daily.
// Used to compute SP run support (the team's scoring in a given starter's games).
async function getTeamHittingLog(teamId) {
  const today = localDate();
  const c = teamHittingLogCache[teamId];
  if (c && c.date === today) return c;
  const d = await mlbGet(`${API}/teams/${teamId}/stats?stats=gameLog&season=${SEASON}&group=hitting`);
  const map = {};
  for (const s of (d?.stats?.[0]?.splits || [])) {
    const pk = s.game?.gamePk, r = s.stat?.runs;
    if (pk != null && r != null) map[pk] = r;
  }
  const vals = Object.values(map);
  const rsPerG = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const entry = { date: today, map, rsPerG };
  teamHittingLogCache[teamId] = entry;
  return entry;
}

// SP run support: the team's average runs scored in this starter's games vs their season
// RS/G. ratio < 1 ⇒ the team scores less when he pitches (ace-vs-ace clustering, etc.) —
// the "great pitcher, team keeps losing" pattern the independent offense/pitching factors
// miss. Self-normalized to the team, so it captures only the SP-specific deviation (no
// double-count with the offense level). Cached per SP+team per day.
async function getSpRunSupport(spId, teamId) {
  if (!spId || !teamId) return null;
  const today = localDate();
  const key = `${spId}:${teamId}`;
  const c = spRunSupportCache[key];
  if (c && c.date === today) return c;
  const [pl, tl] = await Promise.all([
    mlbGet(`${API}/people/${spId}/stats?stats=gameLog&season=${SEASON}&group=pitching`),
    getTeamHittingLog(teamId),
  ]);
  const starts = (pl?.stats?.[0]?.splits || []).filter(s => (s.stat?.gamesStarted || 0) >= 1);
  let tot = 0, n = 0;
  for (const st of starts) {
    const rs = tl.map[st.game?.gamePk];
    if (rs == null) continue;
    tot += rs; n++;
  }
  const ratio = (n > 0 && tl.rsPerG) ? (tot / n) / tl.rsPerG : null;
  const entry = {
    date: today, starts: n,
    avgRs: n ? +(tot / n).toFixed(2) : null,
    ratio: ratio != null ? +ratio.toFixed(3) : null,
  };
  spRunSupportCache[key] = entry;
  return entry;
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------
function clearAllCaches() {
  for (const k of Object.keys(bvpCache))          delete bvpCache[k];
  for (const k of Object.keys(vsTeamCache))       delete vsTeamCache[k];
  for (const k of Object.keys(pitcherStatCache))  delete pitcherStatCache[k];
  for (const k of Object.keys(batterSplitCache))  delete batterSplitCache[k];
  for (const k of Object.keys(pitcherHandCache))  delete pitcherHandCache[k];
  for (const k of Object.keys(batterHandCache))   delete batterHandCache[k];
  for (const k of Object.keys(matchupCache))      delete matchupCache[k];
  for (const k of Object.keys(streakCache))       delete streakCache[k];
  for (const k of Object.keys(recentBatterCache)) delete recentBatterCache[k];
  for (const k of Object.keys(pitcherRecentCache))delete pitcherRecentCache[k];
  for (const k of Object.keys(rpAppearanceCache)) delete rpAppearanceCache[k];
  for (const k of Object.keys(pitcherSplitCache)) delete pitcherSplitCache[k];
  for (const k of Object.keys(catcherCSCache))    delete catcherCSCache[k];
  for (const k of Object.keys(personalCatcherCache)) delete personalCatcherCache[k];
  standingsCache.date = null; standingsCache.data = null;
  gameCache.date  = null;
  gameCache.games = null;
  savantData = {}; savantPitcherData = {}; teamDefenseData = {}; teamKPctData = {};
  pitcherArsenalData = {}; batterArsenalData = {}; batterArsenalWhiff = {}; batterArsenalGroups = {}; pitcherFbVeloData = {}; savantDate = null;
  console.log(`[${new Date().toISOString()}] Day rolled over — all caches cleared`);
}

function checkDayRollover() {
  const today = localDate();
  if (today !== cacheDay) { cacheDay = today; clearAllCaches(); }
}

// ---------------------------------------------------------------------------
// Team schedule context — rest/fatigue/travel spot from recent games.
// Cached per team per day. Returns neutral on any failure.
// ---------------------------------------------------------------------------
const scheduleContextCache = {};
async function getTeamScheduleContext(teamId, today) {
  const key = `${teamId}-${today}`;
  if (scheduleContextCache[key] !== undefined) return scheduleContextCache[key];
  const result = { restDays: 1, gamesIn10: 0, consecutive: 1, awayLast7: 0 };
  try {
    const start = addDays(today, -10);
    const data  = await mlbGet(`${API}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${today}`);
    const past  = [];
    for (const d of (data?.dates || [])) {
      if (d.date >= today) continue;
      for (const g of (d.games || [])) {
        if (!/final|completed|game over/i.test(g.status?.detailedState || '')) continue;
        past.push({ date: d.date, isHome: g.teams?.home?.team?.id === teamId });
      }
    }
    past.sort((a, b) => a.date.localeCompare(b.date));
    if (past.length) {
      const last = past[past.length - 1].date;
      result.restDays  = Math.min(5, Math.round((new Date(today + 'T12:00') - new Date(last + 'T12:00')) / 86400000));
      result.gamesIn10 = past.length;
      let consec = 1;
      for (let i = past.length - 1; i > 0; i--) {
        const diff = Math.round((new Date(past[i].date + 'T12:00') - new Date(past[i - 1].date + 'T12:00')) / 86400000);
        if (diff === 1) consec++; else break;
      }
      result.consecutive = consec;
      result.awayLast7   = past.slice(-7).filter(g => !g.isHome).length;
    }
  } catch { /* neutral */ }
  scheduleContextCache[key] = result;
  return result;
}

// ---------------------------------------------------------------------------
// Main matchup compute
// ---------------------------------------------------------------------------
async function computeGameMatchups(game) {
  const [homeBatters, awayBatters, homePitchers, awayPitchers] = await Promise.all([
    getBattingLineup(game.home, game.away.probable),
    getBattingLineup(game.away, game.home.probable),
    getPitchingStaff(game.home.teamId, game.home.probable),
    getPitchingStaff(game.away.teamId, game.away.probable),
  ]);

  await Promise.all([
    ...[...homePitchers, ...awayPitchers].map(async p => {
      p.hand = await getPitcherHand(p.id);
      await getPitcherSeasonStats(p.id);
    }),
    ...[...homePitchers, ...awayPitchers].map(p => getPitcherRecentStats(p.id)),
    ...[...homePitchers, ...awayPitchers].map(p => getPitcherSplits(p.id)),
    ...[...homeBatters, ...awayBatters].map(b => getBatterSplits(b.id)),
    ...[...homeBatters, ...awayBatters].map(b => getRecentBatterStats(b.id)),
    ...homeBatters.map(b => getBatterVsTeamStats(b.id, game.away.teamId)),
    ...awayBatters.map(b => getBatterVsTeamStats(b.id, game.home.teamId)),
    ...[...homeBatters, ...awayBatters].map(b => getCareerVenueStats(b.id)),
  ]);

  async function buildPairings(batters, pitchers, batterTeamName, pitcherTeamName) {
    const pWeather = parseWeather(game.weather);
    const umpTend  = getUmpTendency(game.umpire);
    const pairs = [];
    for (const b of batters) {
      const bSplits = batterSplitCache[b.id];
      if (!bSplits || bSplits.ab < 20) continue;

      const pitcherRows = await Promise.all(pitchers.map(async p => {
        const bvp      = await getBvp(b.id, p.id);
        const pSt      = pitcherStatCache[p.id] || {};
        const hand     = p.hand || 'R';
        const splitOps = hand === 'L' ? bSplits.opsVsL : bSplits.opsVsR;
        const bvpOps   = bvp?.ops || 0;
        const bvpAb    = bvp?.ab  || 0;
        // Matchup-centric effective OPS: batter skill scaled by pitcher quality;
        // BvP ramps in from ~12 AB; low-IP pitcher line regressed.
        const effectiveOps = await matchupEffectiveOps(splitOps, b.id, b.batSide || 'R', p.id, bvpOps, bvpAb, pSt.kpct);
        const pRecent  = pitcherRecentCache[p.id];
        const pSplit   = pitcherSplitCache[p.id];
        const bRecent  = recentBatterCache[b.id];
        const scoreAdj = computeScoreAdj(b.batSide || 'R', pSt, pRecent, pSplit, bRecent, bSplits, pWeather, umpTend, getSavantPitcherData()[p.id]?.xwoba ?? null);
        // Pitch-group matchup adjustment: crush match boosts score, auto-out match lowers it.
        // Validated signals (/30): crush 1.47x TB lift, auto-out 1.24x K lift (damage
        // suppressed). These are orthogonal to OPS/xSLG — captured here, not in batterSkill.
        const _aoScore  = getAutoOutKMatchup(b.id, p.id);
        const _crScore  = getCrushHrMatchup(b.id, p.id);
        const pgAdj     = (_crScore?.matched ? 0.035 : 0) - (_aoScore?.matched ? 0.040 : 0);
        const score = opsTo10(effectiveOps + scoreAdj + pgAdj);
        return {
          pitcher: {
            id:    p.id,
            name:  p.name,
            team:  pitcherTeamName,
            role:  p.role,
            hand:  hand,
            era:   pSt.era,
            whip:  pSt.whip,
            ip:    pSt.ip,
            kpct:  pSt.kpct,
            bbpct: pSt.bbpct,
            fip:   pSt.fip,
            hr9:   pSt.hr9,
          },
          bvp,
          matchupScore: score,
        };
      }));

      pairs.push({
        batter: {
          id:           b.id,
          name:         b.name,
          team:         batterTeamName,
          hand:         b.batSide || 'R',
          battingOrder: b.battingOrder || null,
          woba:         bSplits.woba ?? null,
          // 'confirmed' | 'roster-fallback' | 'predicted-leadoff' — see getBattingLineup.
          // Deliberately kept distinct from a real confirmed lineup everywhere downstream.
          source:       b.source || null,
          predictionConfidence: b.predictionConfidence || null,
        },
        pitchers: pitcherRows.sort((a, b) => {
          if (a.pitcher.role !== b.pitcher.role) return a.pitcher.role === 'SP' ? -1 : 1;
          return b.matchupScore - a.matchupScore;
        }),
      });
    }
    return pairs;
  }

  const [awayVsHome, homeVsAway, catcherCSAway, catcherCSHome] = await Promise.all([
    buildPairings(homeBatters, awayPitchers, game.home.name, game.away.name),
    buildPairings(awayBatters, homePitchers, game.away.name, game.home.name),
    getStartingCatcherCS(game.away, game.gamePk, false),
    getStartingCatcherCS(game.home, game.gamePk, true),
  ]);

  // SP run support per team (team scoring in this starter's games). getStandings is
  // awaited here too so standingsCache is populated before computeWinPredictions runs —
  // without it the team-defense factor (defEdge) silently defaulted to neutral.
  const homeSP = homePitchers.find(p => p.role === 'SP');
  const awaySP = awayPitchers.find(p => p.role === 'SP');
  const [homeSchedule, awaySchedule, homeSpRunSupport, awaySpRunSupport, , weatherLive] = await Promise.all([
    getTeamScheduleContext(game.home.teamId, localDate()),
    getTeamScheduleContext(game.away.teamId, localDate()),
    homeSP ? getSpRunSupport(homeSP.id, game.home.teamId) : Promise.resolve(null),
    awaySP ? getSpRunSupport(awaySP.id, game.away.teamId) : Promise.resolve(null),
    getStandings(),
    // Live forecast weather (Open-Meteo) — wind-relative-to-field + temp for the HR model.
    // Pass MLB's own weather.condition so retractable-roof venues use the ACTUAL reported
    // roof state for this game (e.g. "Roof Closed") instead of always assuming shut.
    game.venueId ? getGameWeather(game.venueId, game.gameTime, false, game.weather?.condition).catch(() => null) : Promise.resolve(null),
  ]);

  return {
    gamePk: game.gamePk, gameTime: game.gameTime, status: game.status,
    venueName: game.venueName || null,
    venueId:   game.venueId   || null,
    weather:   game.weather   || null,
    weatherLive: weatherLive || null,
    umpire:    game.umpire    || null,
    homeSchedule, awaySchedule,
    homeSpRunSupport, awaySpRunSupport,
    home: { teamId: game.home.teamId, name: game.home.name, abbrev: game.home.abbrev, score: game.home.score ?? null },
    away: { teamId: game.away.teamId, name: game.away.name, abbrev: game.away.abbrev, score: game.away.score ?? null },
    lineupSource: {
      home: game.home.battersRaw && game.home.battersRaw.length ? 'confirmed' : 'roster-fallback',
      away: game.away.battersRaw && game.away.battersRaw.length ? 'confirmed' : 'roster-fallback',
    },
    catcherCS: {
      forHomeBatters: catcherCSAway ?? 0.28,
      forAwayBatters: catcherCSHome ?? 0.28,
    },
    awayPitchingVsHome: awayVsHome,
    homePitchingVsAway: homeVsAway,
  };
}

// ---------------------------------------------------------------------------
// Match description for top-matchups
// ---------------------------------------------------------------------------
function generateMatchupDesc(batter, pitcher, bvp, score, splitOps) {
  const bvpAb  = bvp?.ab  || 0;
  const avg3   = bvp?.avg  ? parseFloat(bvp.avg).toFixed(3)  : null;
  const ops3   = bvp?.ops  ? parseFloat(bvp.ops).toFixed(3)  : null;
  const slg3   = bvp?.slg  ? parseFloat(bvp.slg).toFixed(3)  : null;
  const hr     = bvp?.hr   || 0;
  const hand   = pitcher.hand === 'L' ? 'LHP' : 'RHP';

  const pSt     = pitcherStatCache[pitcher.id] || {};
  const pRecent = pitcherRecentCache[pitcher.id];

  // Pitcher display stats
  const era   = pSt.era  ? parseFloat(pSt.era).toFixed(2)  : null;
  const fip   = pSt.fip  ? parseFloat(pSt.fip).toFixed(2)  : null;
  const whip  = pSt.whip ? parseFloat(pSt.whip).toFixed(2) : null;
  const kpct  = pSt.kpct ? parseFloat(pSt.kpct).toFixed(1) : null;
  const recentEraFmt = (pRecent?.recentEra != null && pRecent.ip3 >= 8)
    ? parseFloat(pRecent.recentEra).toFixed(2) : null;

  // SP tier — FIP-blended ERA (35/65), matching probabilities.js thresholds
  const spSeasonEra = (pSt.era != null && pSt.fip != null)
    ? pSt.era * 0.35 + pSt.fip * 0.65
    : (pSt.era ?? null);
  const spRecentEra = (pRecent?.recentEra != null && pRecent.ip3 >= 12) ? pRecent.recentEra : null;
  const spBEra      = spRecentEra != null ? spSeasonEra * 0.55 + spRecentEra * 0.45 : spSeasonEra;
  const spKNum      = pSt.kpct ? parseFloat(pSt.kpct) / 100 : 0;
  let spTier = 0, spNegTier = 0;
  if ((pSt.bf || 0) >= 50 && spBEra != null) {
    if      (spBEra <= 2.70 && spKNum >= 0.28 && (pSt.whip || 99) <= 1.10) spTier = 3;
    else if (spBEra <= 3.40 && spKNum >= 0.25)                               spTier = 2;
    else if (spBEra <= 4.00 && spKNum >= 0.22)                               spTier = 1;
    if (spTier === 0) {
      if      (spBEra >= 6.50)                         spNegTier = 3;
      else if (spBEra >= 5.50 && spKNum <= 0.19)       spNegTier = 2;
      else if (spBEra >= 4.80 && spKNum <= 0.20)       spNegTier = 1;
    }
  }
  const tierLabel  = spTier === 3 ? 'Ace SP' : spTier === 2 ? 'Elite SP' : spTier === 1 ? 'Strong SP'
                   : spNegTier === 3 ? 'Struggling SP' : spNegTier === 2 ? 'Weak SP' : spNegTier === 1 ? 'Below-Avg SP' : '';
  const tierSuffix = tierLabel ? ` · vs ${tierLabel}` : '';
  function t(desc) {
    if (!tierSuffix) return desc;
    return desc.endsWith('.') ? desc.slice(0, -1) + tierSuffix + '.' : desc + tierSuffix;
  }

  // Contextual pitcher notes
  const eraFipGap  = era && fip ? parseFloat(fip) - parseFloat(era) : 0;
  const fipNote    = fip && eraFipGap >= 0.60 ? ` (${fip} FIP suggests ERA may be unsustainably low)` : fip ? ` (${fip} FIP)` : '';
  const kNote      = kpct && parseFloat(kpct) >= 25 ? `, ${kpct}% K rate` : '';
  const whipNote   = whip && parseFloat(whip) >= 1.30 ? `, ${whip} WHIP` : '';
  const recentNote = recentEraFmt ? ` Running a ${recentEraFmt} ERA over his last 3 starts.` : '';
  const splitFmt   = splitOps ? splitOps.toFixed(3) : null;

  if (score >= 7) {
    if (bvpAb >= 20) {
      const hrNote = hr > 0 ? ` with ${hr} HR` : '';
      const slgNote = slg3 ? ` (${slg3} SLG)` : '';
      return t(`${batter.name} owns a ${ops3} OPS in ${bvpAb} career AB against ${pitcher.name}${hrNote}${slgNote}.`);
    }
    if (bvpAb >= 10) {
      const slgNote = slg3 ? `, ${slg3} SLG` : '';
      return t(`${batter.name} bats ${avg3} AVG${slgNote} in ${bvpAb} AB vs ${pitcher.name}. Season OPS vs ${hand}: ${splitFmt || 'strong'}.`);
    }
    if (splitOps && splitOps >= 1.000) {
      return t(`${batter.name} is slashing a ${splitFmt} OPS vs ${hand} this season${era ? ` against a ${pitcher.name} ERA of ${era}${fipNote}` : ''}.`);
    }
    return t(`${batter.name} projects favorably vs ${hand} (${splitFmt || 'strong'} OPS this season). ${pitcher.name}: ${era ? `${era} ERA${fipNote}` : 'stats limited'}${kNote}.`);
  }

  if (score <= 3) {
    // Only claim the pitcher has "held" the batter down if the BvP AVG actually IS low —
    // the composite score can land <=3 for reasons unrelated to BvP (season-skill inputs,
    // or here in the Top Matchups view, a blended-in bullpen score) even when the batter
    // has a genuinely strong personal history (e.g..450/20 AB) against THIS pitcher. That
    // combination used to unconditionally get this branch's suppression-framed sentence,
    // which directly contradicted the AVG shown right next to it (real bug).
    if (bvpAb >= 20 && parseFloat(avg3) <= 0.250) {
      return t(`${pitcher.name} has held ${batter.name} to a ${avg3} AVG over ${bvpAb} career AB${kNote ? ` — ${kpct}% K rate` : ''}.`);
    }
    if (era && parseFloat(era) <= 3.50) {
      return t(`${pitcher.name} carries a ${era} ERA${fipNote}${kNote}${whipNote} this season. ${batter.name} has a ${splitFmt || 'weak'} OPS vs ${hand}.${recentNote}`);
    }
    if (kpct && parseFloat(kpct) >= 25) {
      return t(`${pitcher.name} posts a ${kpct}% K rate${whipNote}${era ? `, ${era} ERA` : ''}. ${batter.name} carries a ${splitFmt || 'weak'} OPS vs ${hand} this season.`);
    }
    if (splitOps && splitOps <= 0.600) {
      return t(`${batter.name} has posted a ${splitFmt} OPS vs ${hand} this year. ${pitcher.name}${era ? `: ${era} ERA${fipNote}` : ' presents a tough draw'}.`);
    }
    return t(`${batter.name}'s splits vs ${hand} are weak. ${pitcher.name}${era ? ` carries a ${era} ERA${fipNote}` : ' projects as a difficult draw'}.`);
  }

  // Neutral 4-6
  const pitcherCtx = era ? `${pitcher.name}: ${era} ERA${fip ? ` / ${fip} FIP` : ''}${kNote}` : pitcher.name;
  const batterCtx  = splitFmt ? `${batter.name}: ${splitFmt} OPS vs ${hand}` : batter.name;
  return t(`${batterCtx} this season. ${pitcherCtx}.`);
}

// ---------------------------------------------------------------------------
// Streak helpers
// ---------------------------------------------------------------------------
function tag(text, cls) { return { text, cls }; }

function batterStreakInfo(splits, name, team) {
  if (!splits.length) return null;
  let hitStreak = 0;
  for (let i = splits.length - 1; i >= 0; i--) {
    if (parseInt(splits[i].stat?.hits || 0) > 0) hitStreak++;
    else break;
  }
  const last7 = splits.slice(-7);
  const ab7  = last7.reduce((s, g) => s + parseInt(g.stat?.atBats   || 0), 0);
  const h7   = last7.reduce((s, g) => s + parseInt(g.stat?.hits     || 0), 0);
  const hr7  = last7.reduce((s, g) => s + parseInt(g.stat?.homeRuns || 0), 0);
  const rbi7 = last7.reduce((s, g) => s + parseInt(g.stat?.rbi      || 0), 0);
  const avg7 = ab7 > 0 ? h7 / ab7 : 0;

  const tags = [];
  if (hitStreak >= 7)              tags.push(tag(`${hitStreak}-game hitting streak`, hitStreak >= 12 ? 'fire' : ''));
  if (avg7 >= 0.350 && ab7 >= 15) tags.push(tag(`.${Math.round(avg7 * 1000)} AVG last 7 games`, avg7 >= 0.400 ? 'fire' : ''));
  if (hr7 >= 3)                    tags.push(tag(`${hr7} HR last 7 games`, hr7 >= 5 ? 'fire' : ''));
  if (rbi7 >= 10)                  tags.push(tag(`${rbi7} RBI last 7 games`, ''));
  if (!tags.length) return null;

  const onFire = hitStreak >= 12 || avg7 >= 0.400 || hr7 >= 5;
  return { name, team, type: 'batter', tags, hitStreak, emoji: onFire ? '🔥' : '', isHot: true };
}

function pitcherStreakInfo(splits, name, team) {
  const starts = splits.filter(g => parseIp(g.stat?.inningsPitched) >= 4);
  if (starts.length < 2) return null;
  const last3 = starts.slice(-3);
  const ip3  = last3.reduce((s, g) => s + parseIp(g.stat?.inningsPitched), 0);
  const er3  = last3.reduce((s, g) => s + parseInt(g.stat?.earnedRuns    || 0), 0);
  const k3   = last3.reduce((s, g) => s + parseInt(g.stat?.strikeOuts    || 0), 0);
  const era3 = ip3 > 0 ? er3 * 9 / ip3 : 99;
  const k9   = ip3 > 0 ? k3  * 9 / ip3 : 0;

  let qsStreak = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const ip = parseIp(starts[i].stat?.inningsPitched);
    const er = parseInt(starts[i].stat?.earnedRuns       || 0);
    if (ip >= 6 && er <= 3) qsStreak++;
    else break;
  }

  const struggling = era3 > 7.00 && ip3 >= 12;

  const tags = [];
  if (era3 <= 2.00 && ip3 >= 12) tags.push(tag(`${era3.toFixed(2)} ERA last 3 starts`, 'fire'));
  if (k9   >= 11   && ip3 >= 12) tags.push(tag(`${k9.toFixed(1)} K/9 last 3 starts`,   'fire'));
  if (qsStreak >= 3)             tags.push(tag(`${qsStreak} straight quality starts`,   qsStreak >= 5 ? 'fire' : ''));
  if (struggling)                tags.push(tag(`${era3.toFixed(2)} ERA last 3 starts`,  'ice'));
  if (!tags.length) return null;

  const emoji = (era3 <= 1.50 && ip3 >= 12) || qsStreak >= 5 ? '🔥'
              : struggling ? '🧊' : '';
  return { name, team, type: 'pitcher', tags, emoji, isHot: !struggling };
}

function batterColdInfo(splits, name, team) {
  if (!splits.length) return null;
  const withAB = splits.filter(g => parseInt(g.stat?.atBats || 0) > 0);

  let hitlessStreak = 0;
  for (let i = withAB.length - 1; i >= 0; i--) {
    if (parseInt(withAB[i].stat?.hits || 0) === 0) hitlessStreak++;
    else break;
  }

  const last7 = splits.slice(-7);
  const ab7   = last7.reduce((s, g) => s + parseInt(g.stat?.atBats    || 0), 0);
  const h7    = last7.reduce((s, g) => s + parseInt(g.stat?.hits      || 0), 0);
  const so7   = last7.reduce((s, g) => s + parseInt(g.stat?.strikeOuts|| 0), 0);
  const avg7  = ab7 > 0 ? h7  / ab7 : null;
  const kpct7 = ab7 > 0 ? so7 / ab7 : null;

  const tags = [];
  if (hitlessStreak >= 5)
    tags.push(tag(`${hitlessStreak}-game hitless streak`, hitlessStreak >= 10 ? 'ice' : ''));
  if (avg7 !== null && avg7 <= 0.125 && ab7 >= 15)
    tags.push(tag(`.${String(Math.round(avg7 * 1000)).padStart(3, '0')} AVG last 7 games`, avg7 < 0.075 ? 'ice' : ''));
  if (kpct7 !== null && kpct7 >= 0.45 && ab7 >= 15)
    tags.push(tag(`${Math.round(kpct7 * 100)}% K rate last 7 games`, kpct7 >= 0.55 ? 'ice' : ''));
  if (!tags.length) return null;

  const emoji = hitlessStreak >= 10 || (avg7 !== null && avg7 < 0.075) || (kpct7 !== null && kpct7 >= 0.55) ? '🧊' : '';
  return { name, team, type: 'batter', tags, emoji, isHot: false };
}

function teamStreakInfo(teamRecord, name) {
  const streak     = teamRecord.streak || {};
  const streakType = streak.streakType;
  const streakN    = parseInt(streak.streakNumber || 0);
  const l10  = (teamRecord.records?.splitRecords || []).find(r => r.type === 'lastTen');
  const l10W = parseInt(l10?.wins   || 0);
  const l10L = parseInt(l10?.losses || 0);

  const tags = [];
  let isHot = null;

  if (streakType === 'W' && streakN >= 5) {
    tags.push(tag(`${streakN}-game winning streak`, streakN >= 8 ? 'fire' : ''));
    isHot = true;
  } else if (streakType === 'L' && streakN >= 5) {
    tags.push(tag(`${streakN}-game losing streak`, streakN >= 8 ? 'ice' : ''));
    isHot = false;
  }

  if (l10W >= 8) {
    tags.push(tag(`${l10W}-${l10L} in last 10`, l10W >= 9 ? 'fire' : ''));
    if (isHot === null) isHot = true;
  } else if (l10L >= 8) {
    tags.push(tag(`${l10W}-${l10L} in last 10`, l10L >= 9 ? 'ice' : ''));
    if (isHot === null) isHot = false;
  }

  if (!tags.length || isHot === null) return null;

  const emoji = (streakType === 'W' && streakN >= 8) || l10W >= 9 ? '🔥'
              : (streakType === 'L' && streakN >= 8) || l10L >= 9 ? '🧊' : '';
  return { name, type: 'team', tags, emoji, isHot };
}

// ---------------------------------------------------------------------------
// Bullpen panel data builder
// ---------------------------------------------------------------------------
function buildBullpenSide(rows) {
  const roleOrder = { Closer: 0, Setup: 1, Middle: 2 };
  const rpMap = new Map();

  for (const row of rows) {
    for (const pr of row.pitchers) {
      if (pr.pitcher.role !== 'RP') continue;
      const pid = pr.pitcher.id;
      const pSt0 = pitcherStatCache[pid] || {};
      // Rotation starters are tagged 'RP' on every day they aren't today's confirmed
      // starter (no other signal available), but a real starter essentially never
      // actually pitches in relief outside deep extras — and their last START (e.g.
      // 100 pitches 2 days ago) isn't bullpen workload. Exclude them from the card.
      if ((pSt0.gamesS || 0) > 2) continue;
      if (!rpMap.has(pid)) {
        const pSt  = pSt0;
        const rest = rpAppearanceCache[pid] || {};
        const dr   = rest.daysRest;

        const p3 = rest.pitches3 || 0;
        let restStatus, restClass;
        if      (dr === 0)                             { restStatus = 'Pitched Today'; restClass = 'bp-rest-tired'; }
        else if (dr === 1 && (rest.g3 || 0) >= 2)     { restStatus = 'Tired';         restClass = 'bp-rest-tired'; }
        else if (dr === 1)                             { restStatus = '1-Day Rest';    restClass = 'bp-rest-ques';  }
        else if (dr !== null && dr >= 2 && p3 >= 40)  { restStatus = 'Heavy Load';    restClass = 'bp-rest-ques';  }
        else if (dr !== null && dr >= 2)               { restStatus = 'Ready';         restClass = 'bp-rest-ready'; }
        else                                           { restStatus = '—';             restClass = '';              }

        let role;
        if ((pSt.saves || 0) >= 5 || (pSt.saveOpps || 0) >= 5) role = 'Closer';
        else if ((pSt.holds || 0) >= 5)                          role = 'Setup';
        else                                                      role = 'Middle';

        rpMap.set(pid, {
          id: pid, name: pr.pitcher.name || pr.pitcher.fullName || 'Unknown', hand: pr.pitcher.hand || 'R', role,
          era: pSt.era ?? pr.pitcher.era, whip: pSt.whip ?? pr.pitcher.whip, kpct: pSt.kpct ?? pr.pitcher.kpct,
          saves: pSt.saves || 0, saveOpps: pSt.saveOpps || 0, holds: pSt.holds || 0,
          g7: rest.g7 || 0, daysRest: dr, pitches3: p3, restStatus, restClass,
          matchups: [],
        });
      }
      const rp = rpMap.get(pid);
      if ((pr.bvp?.ab || 0) >= 3) {
        rp.matchups.push({
          batter: row.batter.name, bvpAb: pr.bvp.ab,
          bvpOps: pr.bvp.ops, bvpAvg: pr.bvp.avg, score: pr.matchupScore,
        });
      }
    }
  }

  for (const rp of rpMap.values()) {
    rp.matchups.sort((a, b) => b.bvpAb - a.bvpAb);
    rp.matchups = rp.matchups.slice(0, 5);
  }

  return [...rpMap.values()].sort((a, b) => {
    if (roleOrder[a.role] !== roleOrder[b.role]) return roleOrder[a.role] - roleOrder[b.role];
    return (a.era || 99) - (b.era || 99);
  });
}

// ---------------------------------------------------------------------------
// Data-coverage health check. Defends against the "silent default" failure mode —
// where a data source goes empty (API rename, CSV column change, feed not populated
// yet) and factors quietly fall back to neutral with no error. Run at preload: each
// source must PROVE it's populated; anything at/near zero is flagged loudly so it
// surfaces in the log on day one instead of waiting for a manual probe.
// ---------------------------------------------------------------------------
function dataHealth() {
  const games = Object.values(matchupCache);
  const n = games.length;
  const rows = [];
  const add = (name, count, floor, unit) => rows.push({ name, count, unit: unit || '', ok: count >= floor });

  add('savant batters',    Object.keys(savantData).length,        200);
  add('savant pitchers',   Object.keys(savantPitcherData).length, 100);
  add('pitcher arsenals',  Object.keys(pitcherArsenalData).length, 80);
  add('batter whiff',      Object.keys(batterArsenalWhiff).length, 200);
  add('pitcher FB velo',   Object.keys(pitcherFbVeloData).length,  80);
  add('team defense OAA',  Object.keys(teamDefenseData).length,    25, ' teams');
  add('standings',         Object.keys(standingsCache.data || {}).length, 25, ' teams');
  if (n) {
    const wx = games.filter(g => g.weatherLive).length;
    add('weather',         wx, Math.ceil(n * 0.7), `/${n} games`);
    const conf = games.filter(g => g.lineupSource && (g.lineupSource.home === 'confirmed' || g.lineupSource.away === 'confirmed')).length;
    rows.push({ name: 'lineups confirmed', count: conf, unit: `/${n} games`, ok: true }); // confirm late; report only
  }

  console.log(`[health] data coverage (${n} games):`);
  for (const r of rows) {
    console.log(`  ${r.ok ? ' ' : '⚠'} ${r.name.padEnd(20)} ${String(r.count).padStart(5)}${r.unit}  ${r.ok ? '✓' : '✗ LOW'}`);
  }
  const failed = rows.filter(r => !r.ok);
  if (failed.length) console.warn(`[health] WARNING — ${failed.length} source(s) below expected coverage: ${failed.map(r => r.name).join(', ')} (check the feed/parser)`);
  return rows;
}

// Re-fetch live forecast weather for not-yet-started games and update matchup.weatherLive.
// Forecasts sharpen as first pitch nears, so the displayed conditions (and any LIVE
// recompute of win/prop probabilities) track the latest data. The FROZEN daily predictions
// are not touched — those stay locked at their preload snapshot for grading integrity.
async function refreshWeather() {
  const now = Date.now();
  let updated = 0;
  for (const m of Object.values(matchupCache)) {
    if (!m.venueId) continue;
    const start = m.gameTime ? new Date(m.gameTime).getTime() : 0;
    if (start && start < now) continue;            // skip games already underway/final
    try {
      const wx = await getGameWeather(m.venueId, m.gameTime, false, m.weather?.condition);
      if (wx) { m.weatherLive = wx; updated++; }
    } catch { /* leave existing weatherLive in place on a transient failure */ }
  }
  if (updated) console.log(`[weather] refreshed ${updated} game(s)`);
  return updated;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  API, SEASON, HR_PARK_FACTORS, GAME_CACHE_TTL_MS,
  LG_OPS_AGAINST, LG_KPCT_P, LG_BBPCT_P, UMP_TENDENCIES,
  gameCache, matchupCache, streakCache, rpAppearanceCache, standingsCache,
  bvpCache, recentBatterCache, pitcherRecentCache, pitcherSplitCache,
  pitcherHandCache, pitcherStatCache, batterSplitCache, catcherCSCache, vsTeamCache,
  sleep, localDate, addDays, isGameComplete, parseIp,
  getUmpTendency, parseWeather, estimatedPAs, opsTo10,
  computeScoreAdj, computeProbablesAdj, calcSplitStats,
  mlbGet, getTodaysGames, getPitchingStaff, getBattingLineup,
  getPitcherHand, getBatterHand, getPlayerStatus, getPitcherSeasonStats, getPitcherRecentStats, getPitcherSplits,
  getRecentBatterStats, getBatterVenueStats, getCareerVenueCached, getBatterVsTeamStats, getBvp, getBatterSplits, getCatcherCS, getStartingCatcherCS, getPersonalCatcher, getStandings, getActiveRosterIds,
  getLeagueHrPerGame, getLeagueHrPerGameSync,
  clearAllCaches, checkDayRollover, dataHealth, refreshWeather, loadSavantLeaderboard, getSavantData, getSavantPitcherData, getSavantPitcherPriorData, getTeamDefense, getTeamKPct, getLeagueKPctAvg, getLeagueWhiffAvg,
  getPitcherArsenal, getPitcherFbVelo, getBatterArsenal, getBatterArsenalWhiff, getBatterArsenalValue, getBatterWhiffValue,
  getAutoOutKMatchup, getCrushHrMatchup, pitcherGroupUsage, getBatterArsenalGroups,
  computeGameMatchups, generateMatchupDesc,
  tag, batterStreakInfo, pitcherStreakInfo, batterColdInfo, teamStreakInfo,
  buildBullpenSide,
};
