'use strict';

const { batterSplitCache, recentBatterCache, pitcherStatCache, matchupCache, HR_PARK_FACTORS, getBatterVenueStats } = require('./mlbApi');

const HIT_MIN_ABS     = 8;
const HIT_PROB_THRESH = 0.05;
const HIT_MIN_AVG     = 0.220;
const HR_POWER_GATE   = 40;
const HR_DROUGHT_MULT = 2.0;
const MIN_SEASON_PA   = 50;

// ---------------------------------------------------------------------------
// Compute due-up data for one matchup (uses caches only, no API calls)
// ---------------------------------------------------------------------------
function computeDue(matchup) {
  const ctx = {};
  for (const row of matchup.awayPitchingVsHome) {
    if (!ctx[row.batter.id]) {
      const sp = row.pitchers.find(p => p.pitcher.role === 'SP');
      ctx[row.batter.id] = { batter: row.batter, sp: sp?.pitcher ?? null, bvp: sp?.bvp ?? null, isHome: true };
    }
  }
  for (const row of matchup.homePitchingVsAway) {
    if (!ctx[row.batter.id]) {
      const sp = row.pitchers.find(p => p.pitcher.role === 'SP');
      ctx[row.batter.id] = { batter: row.batter, sp: sp?.pitcher ?? null, bvp: sp?.bvp ?? null, isHome: false };
    }
  }

  const dueHit = [], dueHr = [];

  for (const [batterId, c] of Object.entries(ctx)) {
    const s = batterSplitCache[batterId] || {};
    const r = recentBatterCache[batterId] || {};
    if ((s.pa || 0) < MIN_SEASON_PA) continue;

    const hitlessAbs  = r.hitlessAbs  ?? 0;
    const absSinceHr  = r.absSinceHr  ?? 0;
    const gamesSinceHr = r.gamesSinceHr ?? 0;

    // ── Hit drought ──
    const ba = s.avg;
    if (ba != null && ba >= HIT_MIN_AVG && hitlessAbs >= HIT_MIN_ABS) {
      const prob = Math.pow(1 - ba, hitlessAbs);
      if (prob <= HIT_PROB_THRESH) {
        dueHit.push({
          batterId: +batterId,
          batter:   c.batter.name,
          team:     c.batter.team,
          gamePk:   matchup.gamePk,
          hitlessAbs,
          seasonAvg: +ba.toFixed(3),
          prob:      +prob.toFixed(4),
          factors:   hitFactors(c, s, matchup),
        });
      }
    }

    // ── HR drought ──
    const hrRate = s.hrRateTotal;
    if (hrRate != null && hrRate > 0) {
      const expectedAbsPerHr = 1 / hrRate;
      if (expectedAbsPerHr <= HR_POWER_GATE && absSinceHr >= expectedAbsPerHr * HR_DROUGHT_MULT) {
        dueHr.push({
          batterId: +batterId,
          batter:   c.batter.name,
          team:     c.batter.team,
          gamePk:   matchup.gamePk,
          absSinceHr,
          gamesSinceHr,
          expectedAbsPerHr: +expectedAbsPerHr.toFixed(1),
          multiple:         +(absSinceHr / expectedAbsPerHr).toFixed(1),
          factors:          hrFactors(c, s, matchup),
        });
      }
    }
  }

  dueHit.sort((a, b) => a.prob - b.prob);
  dueHr.sort((a, b) => b.multiple - a.multiple);
  return { dueHit, dueHr };
}

// Compute across all loaded matchups (used for saving predictions)
function computeAllDue() {
  const allHit = [], allHr = [];
  for (const matchup of Object.values(matchupCache)) {
    const { dueHit, dueHr } = computeDue(matchup);
    allHit.push(...dueHit);
    allHr.push(...dueHr);
  }
  return { dueHit: allHit, dueHr: allHr };
}

// ---------------------------------------------------------------------------
function hitFactors(c, s, matchup) {
  const tags = [];
  if (c.bvp && (c.bvp.ab || 0) >= 10 && (c.bvp.ops || 0) >= 0.800) {
    const avg3 = c.bvp.avg ? '.' + String(Math.round(c.bvp.avg * 1000)).padStart(3, '0') : '';
    tags.push({ text: `BvP edge ${avg3} / ${(c.bvp.ops||0).toFixed(3)} OPS (${c.bvp.ab}AB)`, cls: 'tag-hot' });
  }
  if (c.isHome && s.avgHome != null && s.avgAway != null && (s.paHome || 0) >= 30 && s.avgHome > s.avgAway + 0.030)
    tags.push({ text: `+${Math.round((s.avgHome - s.avgAway)*1000)} pts home avg`, cls: 'tag-hot' });
  else if (!c.isHome && s.avgHome != null && s.avgAway != null && (s.paAway || 0) >= 30 && s.avgAway > s.avgHome + 0.030)
    tags.push({ text: `+${Math.round((s.avgAway - s.avgHome)*1000)} pts away avg`, cls: 'tag-hot' });
  const vs = getBatterVenueStats(c.batter.id, matchup.venueId);
  if (vs && vs.avg >= 0.280)
    tags.push({ text: `${matchup.venueName} .${String(Math.round(vs.avg*1000)).padStart(3,'0')} avg (${vs.ab}AB)`, cls: 'tag-hot' });
  if (c.sp) {
    const spSt = pitcherStatCache[c.sp.id] || {};
    if (spSt.era != null && spSt.era >= 4.50)
      tags.push({ text: `${c.sp.name} ${spSt.era.toFixed(2)} ERA`, cls: 'tag-warm' });
  }
  const prf = HR_PARK_FACTORS[(matchup.venueName || '').toLowerCase()] ?? 1.0;
  if (prf >= 1.08) tags.push({ text: `${matchup.venueName} (+${Math.round((prf-1)*100)}% runs)`, cls: 'tag-warm' });
  return tags;
}

function hrFactors(c, s, matchup) {
  const tags = [];
  if (c.bvp && (c.bvp.ab || 0) >= 10 && (c.bvp.hr || 0) >= 2)
    tags.push({ text: `${c.bvp.hr} HR in ${c.bvp.ab} AB vs SP`, cls: 'tag-hot' });
  if (c.isHome) tags.push({ text: 'At home', cls: 'tag-warm' });
  const vs = getBatterVenueStats(c.batter.id, matchup.venueId);
  if (vs && vs.hr >= 2)
    tags.push({ text: `${vs.hr} HR at ${matchup.venueName} this season (${vs.ab}AB)`, cls: 'tag-hot' });
  else if (vs && vs.ops >= 0.850)
    tags.push({ text: `${matchup.venueName} .${String(Math.round(vs.avg*1000)).padStart(3,'0')}/.${String(Math.round(vs.ops*1000)).padStart(3,'0')} OPS (${vs.ab}AB)`, cls: 'tag-warm' });
  if (c.sp) {
    const spSt = pitcherStatCache[c.sp.id] || {};
    if (spSt.hr9 != null && spSt.hr9 >= 1.3)
      tags.push({ text: `${c.sp.name} ${spSt.hr9.toFixed(2)} HR/9`, cls: 'tag-hot' });
  }
  const prf = HR_PARK_FACTORS[(matchup.venueName || '').toLowerCase()] ?? 1.0;
  if (prf >= 1.10) tags.push({ text: `${matchup.venueName} (+${Math.round((prf-1)*100)}% HR)`, cls: 'tag-warm' });
  return tags;
}

module.exports = { computeDue, computeAllDue };
