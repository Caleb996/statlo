'use strict';

// ---------------------------------------------------------------------------
// Predicts a team's likely batters in the TOP FOUR lineup slots BEFORE the official
// lineup posts, from real recent lineup history — built specifically to solve the
// timing problem where early games' lineups aren't out yet when a bet has to go down,
// but the late games' are (request, extended from leadoff-only to
// slots 1-4: batting order strongly drives plate-appearance count — PA_BY_ORDER in
// mlbApi.js runs 4.7/4.5/4.3/4.1 for slots 1-4 — so multi-hit-style props specifically
// need real order awareness beyond just "who leads off," not only leadoff-specific ones).
//
// Two real patterns, both handled, independently per slot:
// - STABLE: the same player has batted in that slot in most of the team's recent
// games regardless of opponent (the common case — e.g. JJ Wetherholt/Cardinals,
// James Wood/Nationals, Elly De La Cruz/Reds, Trea Turner/Phillies at leadoff).
// - PLATOON: the team alternates who bats that slot by the opposing starter's
// throwing hand (e.g. the user's Yankees leadoff example — Trent Grisham vs RHP, a
// different player vs LHP). Detected by splitting recent games by opposing-SP hand
// and checking for a consistent player within each hand bucket.
// Anything that doesn't cleanly fit either pattern is reported 'uncertain' — no guess
// is forced; the caller should NOT treat an uncertain slot as bettable pre-lineup.
// ---------------------------------------------------------------------------

const { mlbGet, API, SEASON, getPitcherHand, getPlayerStatus, localDate, addDays } = require('./mlbApi');

const STABLE_THRESHOLD  = 0.70;   // same player in >=70% of recent games -> stable
const PLATOON_THRESHOLD = 0.70;   // same player in >=70% of games vs ONE hand -> platoon leg
const MIN_GAMES_FOR_HAND_BUCKET = 2;
const ORDER_CODES = { 1: '100', 2: '200', 3: '300', 4: '400' };

const historyCache = {}; // `${teamId}:${date}` -> history array (recomputed daily)

// Real recent lineup history for a team: last `n` completed games, who batted in EACH
// of slots 1-4, and the opposing starting pitcher's hand for that game.
async function getRecentOrderHistory(teamId, n = 10) {
  const today = localDate();
  const cacheKey = `${teamId}:${today}`;
  if (historyCache[cacheKey]) return historyCache[cacheKey];

  const start = addDays(today, -21); // wide enough window to reliably find n completed games
  let sched;
  try {
    sched = await mlbGet(`${API}/schedule?sportId=1&teamId=${teamId}&startDate=${start}&endDate=${addDays(today, -1)}`);
  } catch (e) {
    console.error(`[leadoffPredictor] schedule fetch failed for team ${teamId}: ${e.message}`);
    historyCache[cacheKey] = [];
    return [];
  }
  const games = [];
  for (const d of sched?.dates || []) {
    for (const g of d.games || []) {
      if (g.status?.abstractGameState === 'Final' && g.gameType === 'R') games.push(g);
    }
  }
  games.sort((a, b) => b.gameDate.localeCompare(a.gameDate));
  const recent = games.slice(0, n);

  const history = [];
  for (const g of recent) {
    let box;
    try { box = await mlbGet(`${API}/game/${g.gamePk}/boxscore`); } catch { continue; }
    if (!box) continue;
    const isHome = g.teams?.home?.team?.id === teamId;
    const ownSide = isHome ? 'home' : 'away';
    const oppSide = isHome ? 'away' : 'home';

    const bySlot = {};
    for (const pid in box.teams[ownSide]?.players || {}) {
      const p = box.teams[ownSide].players[pid];
      const bo = String(p.battingOrder);
      for (const slot of [1, 2, 3, 4]) {
        if (bo === ORDER_CODES[slot]) bySlot[slot] = { id: p.person.id, name: p.person.fullName };
      }
    }
    if (!Object.keys(bySlot).length) continue;

    // Opposing starter: first entry in the opposing side's `pitchers` id list is the
    // starter (boxscore convention — same assumption used elsewhere in this codebase).
    const oppPitcherId = box.teams[oppSide]?.pitchers?.[0];
    let oppHand = null;
    if (oppPitcherId) {
      try { oppHand = await getPitcherHand(oppPitcherId); } catch { oppHand = null; }
    }
    history.push({ date: g.gameDate?.slice(0, 10), bySlot, oppHand });
  }
  historyCache[cacheKey] = history;
  return history;
}

// Decide stable / platoon / uncertain for ONE batting-order slot from real history, then
// resolve against TODAY's opposing starter's hand (for the platoon case). Wraps the raw
// prediction with a real current-status check — recent lineup history can
// point confidently at someone who's since been traded, injured, optioned, or DFA'd (a
// real case that surfaced this session: Brendan Donovan traded to Seattle AND on the
// 10-day IL there); a 'stable'/'platoon' result is only trustworthy if that person is
// still actually on THIS team and active right now.
async function predictBattingOrder(teamId, oppHandToday, order = 1) {
  const raw = await predictBattingOrderRaw(teamId, oppHandToday, order);
  if ((raw.confidence !== 'stable' && raw.confidence !== 'platoon') || !raw.playerId) return raw;
  let status;
  try { status = await getPlayerStatus(raw.playerId); }
  catch { return raw; } // status check itself failing shouldn't block an otherwise-good prediction
  if (!status.found) return raw; // couldn't verify either way — don't punish the prediction for a lookup gap
  if (status.currentTeamId !== teamId) {
    return { order, confidence: 'uncertain', reason: `${raw.playerName} was the recent-history pick but is no longer on this team (now ${status.currentTeamName || 'elsewhere'}) — real roster change since the sampled games` };
  }
  if (status.isInjured || !status.isActive) {
    return { order, confidence: 'uncertain', reason: `${raw.playerName} was the recent-history pick but current status is "${status.statusDescription || 'inactive'}" — not trustworthy pre-lineup` };
  }
  return raw;
}

async function predictBattingOrderRaw(teamId, oppHandToday, order = 1) {
  const fullHistory = await getRecentOrderHistory(teamId, 10);
  const history = fullHistory
    .filter(h => h.bySlot[order])
    .map(h => ({ date: h.date, playerId: h.bySlot[order].id, playerName: h.bySlot[order].name, oppHand: h.oppHand }));

  if (history.length < 3) {
    return { order, confidence: 'uncertain', reason: `not enough recent completed games with a resolvable order-${order} hitter` };
  }

  const counts = {};
  for (const h of history) counts[h.playerId] = (counts[h.playerId] || 0) + 1;
  const [topId, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const topRatio = topCount / history.length;

  if (topRatio >= STABLE_THRESHOLD) {
    const name = history.find(h => String(h.playerId) === String(topId))?.playerName;
    return {
      order, confidence: 'stable', playerId: Number(topId), playerName: name,
      reason: `batted order-${order} in ${topCount}/${history.length} recent games regardless of opponent`,
    };
  }

  // Platoon check: split by opposing-SP hand, look for a consistent player per bucket.
  const byHand = { L: [], R: [] };
  for (const h of history) if (h.oppHand === 'L' || h.oppHand === 'R') byHand[h.oppHand].push(h);

  const handPrediction = {};
  for (const hand of ['L', 'R']) {
    const bucket = byHand[hand];
    if (bucket.length < MIN_GAMES_FOR_HAND_BUCKET) continue;
    const c = {};
    for (const h of bucket) c[h.playerId] = (c[h.playerId] || 0) + 1;
    const [id, cnt] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    if (cnt / bucket.length >= PLATOON_THRESHOLD) {
      handPrediction[hand] = { playerId: Number(id), playerName: bucket.find(h => String(h.playerId) === String(id))?.playerName, n: bucket.length, ratio: cnt / bucket.length };
    }
  }

  const isRealPlatoon = handPrediction.L && handPrediction.R && handPrediction.L.playerId !== handPrediction.R.playerId;
  if (isRealPlatoon) {
    if (oppHandToday !== 'L' && oppHandToday !== 'R') {
      return { order, confidence: 'uncertain', reason: `platoon slot-${order} but today's opposing SP hand is unknown` };
    }
    const pick = handPrediction[oppHandToday];
    return {
      order, confidence: 'platoon', playerId: pick.playerId, playerName: pick.playerName,
      reason: `platoon order-${order} — vs ${oppHandToday}HP: ${pick.playerName} in ${pick.n} of last ${pick.n} such games (other hand goes to ${handPrediction[oppHandToday === 'L' ? 'R' : 'L'].playerName})`,
    };
  }

  return {
    order, confidence: 'uncertain',
    reason: `no player used in >=${Math.round(STABLE_THRESHOLD*100)}% of recent order-${order} games overall or within either hand split — top candidate ${history.find(h=>String(h.playerId)===String(topId))?.playerName} only ${(topRatio*100).toFixed(0)}%`,
  };
}

// Predict ALL of slots 1-4 in one pass (shares the underlying history fetch across
// slots — one schedule+boxscore pull covers all four, not four separate pulls).
async function predictTopOrder(teamId, oppHandToday) {
  const preds = {};
  for (const order of [1, 2, 3, 4]) preds[order] = await predictBattingOrder(teamId, oppHandToday, order);
  return preds;
}

// Backward-compatible leadoff-only entry point (existing callers, e.g. the runs combo's
// order===1 logic, keep working unchanged).
async function predictLeadoff(teamId, oppHandToday) {
  return predictBattingOrder(teamId, oppHandToday, 1);
}

module.exports = { getRecentOrderHistory, predictBattingOrder, predictTopOrder, predictLeadoff };
