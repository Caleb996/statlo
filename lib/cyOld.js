'use strict';
// "Cy Old" — today's probable starters whose FIP says the offense should feast (the
// anti-Cy-Young board). Symmetric two-sided filter, both sides using FIP (not ERA) so the
// screen and the escape/entry hatch are the same metric, just windowed differently:
// - IN if season FIP >= ATROCIOUS_SEASON_FIP, UNLESS recent form says they've fixed it
// (trailing-3-start FIP <= ESCAPE_TRAILING_FIP, or a 3+ quality-start streak).
// - ALSO IN if season FIP is merely mediocre (4.00-4.99) but trailing-3-start FIP has
// cratered (>= TREND_TRAILING_FIP) — "trending toward atrocious."
// - NEVER eligible below ENTRY_SEASON_FIP (season FIP 4.00) regardless of a rough recent
// stretch — protects a true ace (e.g. a sub-3.00 FIP arm) from a couple of bad starts
// landing them on a "who's gonna get shelled" list.
// Thresholds were hand-tuned against a live slate during design — this is deliberately NOT a
// backtested feature, just a readable filter on an already well-understood stat (FIP).
const {
  API, SEASON, mlbGet, localDate, getTodaysGames, gameCache,
  getPitcherSeasonStats, parseIp,
} = require('./mlbApi');

const FIP_CONSTANT = 3.17;
const MIN_GS = 8;                    // season sample gate — real rotation starters only
const ENTRY_SEASON_FIP = 4.00;       // floor — below this, never eligible (protects aces)
const ATROCIOUS_SEASON_FIP = 5.00;   // season-long "in" bar
const ESCAPE_TRAILING_FIP = 4.75;    // trailing-3 FIP at/below this = "already fixed"
const ESCAPE_QS_STREAK = 3;          // 3+ straight quality starts = also escapes
const TREND_TRAILING_FIP = 6.00;     // trailing-3 FIP at/above this (mid-band guys) = "trending toward atrocious"

function trailingPitchingLine(splits) {
  const starts = splits.filter(g => parseIp(g.stat?.inningsPitched) >= 1);
  const last3 = starts.slice(-3);
  let ip = 0, hr = 0, bb = 0, ibb = 0, hbp = 0, so = 0;
  for (const g of last3) {
    ip  += parseIp(g.stat?.inningsPitched);
    hr  += parseInt(g.stat?.homeRuns || 0);
    bb  += parseInt(g.stat?.baseOnBalls || 0);
    ibb += parseInt(g.stat?.intentionalWalks || 0);
    hbp += parseInt(g.stat?.hitByPitch || 0);
    so  += parseInt(g.stat?.strikeOuts || 0);
  }
  const fip = ip > 0 ? (13 * hr + 3 * (bb - ibb + hbp) - 2 * so) / ip + FIP_CONSTANT : null;
  let qsStreak = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const gip = parseIp(starts[i].stat?.inningsPitched);
    const er  = parseInt(starts[i].stat?.earnedRuns || 0);
    if (gip >= 6 && er <= 3) qsStreak++; else break;
  }
  return { ip: +ip.toFixed(1), fip: fip != null ? +fip.toFixed(2) : null, qsStreak };
}

async function getTodaysProbableStarters() {
  const today = localDate();
  let games = gameCache.games;
  if (!games || !games.length) games = await getTodaysGames(today).catch(() => []);
  const out = [];
  const seen = new Set();
  for (const g of games || []) {
    for (const side of ['home', 'away']) {
      const p = g[side]?.probable;
      if (!p?.id || seen.has(p.id)) continue;
      seen.add(p.id);
      const oppSide = side === 'home' ? 'away' : 'home';
      out.push({
        id: p.id, name: p.fullName, team: g[side]?.name || '',
        opponent: g[oppSide]?.name || '', gamePk: g.gamePk,
      });
    }
  }
  return out;
}

let cache = { date: null, data: null };

async function getCyOldList() {
  const today = localDate();
  if (cache.date === today && cache.data) return cache.data;

  const starters = await getTodaysProbableStarters();
  // Season stats + game log are independent per pitcher — fetch every probable starter's
  // pair in parallel rather than one at a time. Sequential was fine at design time (~15-30
  // starters looked small) but is really ~2×N round trips end-to-end, which measured out
  // to 1-3 minutes of real preload time on a full 15-game slate. Batched, same spirit as
  // lib/streaks.js's mapBatched (small pool here, so a flat Promise.all is fine).
  const fetched = await Promise.all(starters.map(async p => {
    const st = await getPitcherSeasonStats(p.id).catch(() => null);
    if (!st || st.fip == null || (st.gamesS || 0) < MIN_GS) return null;
    if (st.fip < ENTRY_SEASON_FIP) return null; // never eligible — protects aces having a rough patch
    const logs = await mlbGet(`${API}/people/${p.id}/stats?stats=gameLog&season=${SEASON}&group=pitching`)
      .then(d => d?.stats?.[0]?.splits || []).catch(() => []);
    return { p, st, trailing: trailingPitchingLine(logs) };
  }));

  const out = [];
  for (const entry of fetched) {
    if (!entry) continue;
    const { p, st, trailing } = entry;
    let reason = null;
    if (st.fip >= ATROCIOUS_SEASON_FIP) {
      const escaped = (trailing.fip != null && trailing.fip <= ESCAPE_TRAILING_FIP) || trailing.qsStreak >= ESCAPE_QS_STREAK;
      if (!escaped) reason = 'season';
    } else if (trailing.fip != null && trailing.fip >= TREND_TRAILING_FIP) {
      reason = 'trending';
    }
    if (!reason) continue;

    out.push({
      id: p.id, name: p.name, team: p.team, opponent: p.opponent, gamePk: p.gamePk,
      seasonFip: st.fip, seasonEra: st.era, gamesStarted: st.gamesS,
      trailingFip: trailing.fip, trailingIp: trailing.ip, qsStreak: trailing.qsStreak,
      reason,
    });
  }
  out.sort((a, b) => b.seasonFip - a.seasonFip);
  cache = { date: today, data: out };
  return out;
}

// Set of today's Cy Old pitcher IDs — for cheap cross-referencing elsewhere (e.g. tagging
// a "Cy Old start" note on the leadoff/hits squad-combo groups when the opposing SP is on
// the list). Purely descriptive; never feeds back into any probability.
async function getCyOldIdSet() {
  const list = await getCyOldList();
  return new Set(list.map(p => p.id));
}

module.exports = { getCyOldList, getCyOldIdSet };
