'use strict';
// League-wide hot/cold streak board (Research > Streaks). Design summary:
// - Tier severity (Notable/Strong/Extreme) is set on TRAILING-WINDOW ACTUAL wOBA
// (batters) / ERA (pitchers), from a bulk MLB Stats API byDateRange+playerPool=all
// pull — already a real upgrade over raw AVG (weights BB/XBH/HR correctly).
// - Every entry also gets a luck-gap label vs the player's already-loaded SEASON
// xwOBA/xERA (getSavantData/getSavantPitcherData — no new fetch), matching how the
// rest of this app (matchup score, win model) treats actual-vs-expected splits.
// - Streak LENGTH (consecutive-game facts: hit streak, hitless streak, quality-start
// streak) can't come from either bulk source — fetched via per-player gameLog, but
// ONLY for players who already cleared the wOBA/ERA screen (the shortlist), not the
// full league.
// - Two Statcast/MLB-API assumptions were smoke-tested live before this was written:
// Baseball Savant's leaderboard/custom endpoint ignores startDate/endDate (confirmed
// dead end); the MLB Stats API's stats=byDateRange DOES combine with playerPool=all
// (confirmed working, real trailing-window box lines returned).
const fs   = require('fs');
const path = require('path');
const {
  API, mlbGet, localDate, addDays,
  getStandings, getActiveRosterIds,
  getSavantData, getSavantPitcherData,
  parseIp, getTodaysGames, gameCache,
} = require('./mlbApi');

// ---------------------------------------------------------------------------
// Persistence (mirrors lib/hrLog.js exactly)
// ---------------------------------------------------------------------------
function atomicWriteFileSync(filePath, data) {
  const tmpPath = `${filePath}.tmp${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}
const fileFor = date => path.join(__dirname, '..', `streaks-log-${date}.json`);

function getStreaksLog(days = 10) {
  const out = [];
  const today = localDate();
  for (let i = 0; i < days; i++) {
    const date = addDays(today, -i);
    const f = fileFor(date);
    if (!fs.existsSync(f)) continue;
    try { out.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (_) {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiering helpers
// ---------------------------------------------------------------------------
const TIER_RANK = { Notable: 1, Strong: 2, Extreme: 3 };
function maxTier(...tiers) {
  let best = null;
  for (const t of tiers) if (t && (!best || TIER_RANK[t] > TIER_RANK[best])) best = t;
  return best;
}
// value counts as MORE extreme the HIGHER it is (e.g. hot wOBA, hit streak length)
function tierGte(value, notable, strong, extreme) {
  if (value == null) return null;
  if (value >= extreme) return 'Extreme';
  if (value >= strong)  return 'Strong';
  if (value >= notable) return 'Notable';
  return null;
}
// value counts as MORE extreme the LOWER it is (e.g. cold wOBA, hot ERA)
function tierLte(value, notable, strong, extreme) {
  if (value == null) return null;
  if (value <= extreme) return 'Extreme';
  if (value <= strong)  return 'Strong';
  if (value <= notable) return 'Notable';
  return null;
}

// Standard wOBA linear weights — a fixed approximation (same spirit as this app's other
// static league constants, e.g. LG_OPS_AGAINST), not refit per season.
const WOBA_W = { uBB: 0.69, HBP: 0.72, SINGLE: 0.89, DOUBLE: 1.27, TRIPLE: 1.62, HR: 2.10 };
function trailingWoba(stat) {
  const ab  = parseInt(stat.atBats || 0);
  const bb  = parseInt(stat.baseOnBalls || 0);
  const ibb = parseInt(stat.intentionalWalks || 0);
  const hbp = parseInt(stat.hitByPitch || 0);
  const sf  = parseInt(stat.sacFlies || 0);
  const h   = parseInt(stat.hits || 0);
  const d2  = parseInt(stat.doubles || 0);
  const d3  = parseInt(stat.triples || 0);
  const hr  = parseInt(stat.homeRuns || 0);
  const single = h - d2 - d3 - hr;
  const uBB = bb - ibb;
  const denom = ab + bb - ibb + sf + hbp;
  if (denom <= 0) return null;
  const numer = WOBA_W.uBB * uBB + WOBA_W.HBP * hbp + WOBA_W.SINGLE * single
              + WOBA_W.DOUBLE * d2 + WOBA_W.TRIPLE * d3 + WOBA_W.HR * hr;
  return numer / denom;
}

// Positive perfGap = outperforming the season expected stat (regression-risk-down for
// hitters running hot / regression-risk-up i.e. bounce-back for hitters running cold).
// Negative perfGap = underperforming it. Uniform sign convention across batters/pitchers
// even though "better" points opposite ways for wOBA (higher) vs ERA (lower).
function perfLabel(gap, threshold) {
  if (gap == null) return null;
  if (gap >= threshold)  return 'aheadOfExpected';
  if (gap <= -threshold) return 'behindExpected';
  return 'inLineWithExpected';
}

// ---------------------------------------------------------------------------
// Active-roster full-league ID set (cached per day alongside the bulk pulls below)
// ---------------------------------------------------------------------------
async function getActiveLeagueIds() {
  const standings = await getStandings();
  const teamIds = Object.keys(standings).map(Number);
  const sets = await Promise.all(teamIds.map(id => getActiveRosterIds(id).catch(() => new Set())));
  const all = new Set();
  for (const s of sets) for (const id of s) all.add(id);
  return all;
}

// ---------------------------------------------------------------------------
// Bulk trailing-window pulls
// ---------------------------------------------------------------------------
async function fetchTrailingHitting(startDate, endDate) {
  const url = `${API}/stats?stats=byDateRange&startDate=${startDate}&endDate=${endDate}`
    + `&group=hitting&sportId=1&gameType=R&playerPool=all&limit=1500&sortStat=onBasePlusSlugging`;
  const j = await mlbGet(url);
  return j?.stats?.[0]?.splits || [];
}
async function fetchTrailingPitching(startDate, endDate) {
  const url = `${API}/stats?stats=byDateRange&startDate=${startDate}&endDate=${endDate}`
    + `&group=pitching&sportId=1&gameType=R&playerPool=all&limit=1500&sortStat=earnedRunAverage`;
  const j = await mlbGet(url);
  return j?.stats?.[0]?.splits || [];
}

const SHORTLIST_CAP = 70;
const BATTER_PA_GATE = 15;
const PITCHER_IP_GATE = 12;
const BATTER_GAP_THRESHOLD  = 0.050; // wOBA points
const PITCHER_GAP_THRESHOLD = 1.000; // ERA points — different scale than wOBA

function screenBatters(rows, activeIds, hot) {
  const savant = getSavantData();
  const out = [];
  for (const s of rows) {
    const id = s.player?.id;
    if (!id || !activeIds.has(id)) continue;
    const stat = s.stat || {};
    const pa = parseInt(stat.plateAppearances || 0);
    if (pa < BATTER_PA_GATE) continue;
    const woba = trailingWoba(stat);
    if (woba == null) continue;
    const wobaTier = hot
      ? tierGte(woba, 0.400, 0.450, 0.500)
      : tierLte(woba, 0.260, 0.230, 0.200);
    if (!wobaTier) continue;
    const ab = parseInt(stat.atBats || 0);
    const kpct = ab > 0 ? parseInt(stat.strikeOuts || 0) / ab : null;
    const kTier = !hot ? tierGte(kpct, 0.45, 0.55, 0.65) : null;
    const seasonXwoba = savant[id]?.xwoba ?? null;
    const gap = seasonXwoba != null ? +(woba - seasonXwoba).toFixed(3) : null;
    out.push({
      id, name: s.player.fullName, team: s.team?.abbreviation || s.team?.name || '',
      pa, avg: stat.avg, hr: parseInt(stat.homeRuns || 0),
      woba: +woba.toFixed(3), seasonXwoba, gap,
      luckLabel: perfLabel(gap, BATTER_GAP_THRESHOLD),
      kpct: kpct != null ? +(kpct * 100).toFixed(1) : null,
      wobaTier, kTier,
    });
  }
  out.sort((a, b) => hot ? b.woba - a.woba : a.woba - b.woba);
  return out.slice(0, SHORTLIST_CAP);
}

function screenPitchers(rows, activeIds, hot) {
  const savant = getSavantPitcherData();
  const out = [];
  for (const s of rows) {
    const id = s.player?.id;
    if (!id || !activeIds.has(id)) continue;
    const stat = s.stat || {};
    const ip = parseIp(stat.inningsPitched);
    if (ip < PITCHER_IP_GATE) continue;
    const era = parseFloat(stat.era);
    if (isNaN(era)) continue;
    const eraTier = hot
      ? tierLte(era, 2.00, 1.50, 0.75)
      : tierGte(era, 5.50, 7.00, 9.00);
    if (!eraTier) continue;
    const bf = parseInt(stat.battersFaced || 0);
    const kpct = bf > 0 ? parseInt(stat.strikeOuts || 0) / bf : null;
    const bbpct = bf > 0 ? parseInt(stat.baseOnBalls || 0) / bf : null;
    const seasonXera = savant[id]?.xera ?? null;
    const gap = seasonXera != null ? +(seasonXera - era).toFixed(2) : null; // positive = outperforming (ERA below xERA)
    out.push({
      id, name: s.player.fullName, team: s.team?.abbreviation || s.team?.name || '',
      ip: +ip.toFixed(1), gamesStarted: parseInt(stat.gamesStarted || 0),
      era: +era.toFixed(2), whip: parseFloat(stat.whip) || null,
      hrAllowed: parseInt(stat.homeRuns || 0),
      seasonXera, gap, luckLabel: perfLabel(gap, PITCHER_GAP_THRESHOLD),
      kpct: kpct != null ? +(kpct * 100).toFixed(1) : null,
      bbpct: bbpct != null ? +(bbpct * 100).toFixed(1) : null,
      eraTier,
    });
  }
  out.sort((a, b) => hot ? a.era - b.era : b.era - a.era);
  return out.slice(0, SHORTLIST_CAP);
}

// ---------------------------------------------------------------------------
// Streak-length enrichment (gameLog, shortlist only) — fresh logic, deliberately NOT
// reusing batterStreakInfo/batterColdInfo/pitcherStreakInfo (those drive the existing
// per-game Notable Runs/Who Sucks feature; left untouched so it can't regress).
// ---------------------------------------------------------------------------
function hitStreakLen(splits) {
  let n = 0;
  for (let i = splits.length - 1; i >= 0; i--) {
    if (parseInt(splits[i].stat?.hits || 0) > 0) n++; else break;
  }
  return n;
}
function hitlessStreakLen(splits) {
  const withAB = splits.filter(g => parseInt(g.stat?.atBats || 0) > 0);
  let n = 0;
  for (let i = withAB.length - 1; i >= 0; i--) {
    if (parseInt(withAB[i].stat?.hits || 0) === 0) n++; else break;
  }
  return n;
}
function qsStreakLen(splits) {
  const starts = splits.filter(g => parseIp(g.stat?.inningsPitched) >= 4);
  let n = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    const ip = parseIp(starts[i].stat?.inningsPitched);
    const er = parseInt(starts[i].stat?.earnedRuns || 0);
    if (ip >= 6 && er <= 3) n++; else break;
  }
  return n;
}

// Fetch in modest batches rather than one giant Promise.all — this codebase has no
// existing precedent for a 100+-request fan-out in one call (matchup preload spreads
// its per-player fetches across a whole slate compute, not one burst).
async function mapBatched(items, batchSize, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    out.push(...await Promise.all(batch.map(fn)));
  }
  return out;
}

async function enrichBatters(entries, season) {
  const logs = await mapBatched(entries, 40, e =>
    mlbGet(`${API}/people/${e.id}/stats?stats=gameLog&season=${season}&group=hitting`)
      .then(d => d?.stats?.[0]?.splits || []).catch(() => []));
  entries.forEach((e, i) => {
    const splits = logs[i];
    e.hitStreak = hitStreakLen(splits);
    e.hitlessStreak = hitlessStreakLen(splits);
    const streakTier = e.hitStreak
      ? tierGte(e.hitStreak, 7, 12, 18)
      : tierGte(e.hitlessStreak, 5, 10, 15);
    e.tier = maxTier(e.wobaTier, e.kTier, streakTier);
    delete e.wobaTier; delete e.kTier;
  });
  return entries;
}

async function enrichPitchers(entries, season) {
  const logs = await mapBatched(entries, 40, e =>
    mlbGet(`${API}/people/${e.id}/stats?stats=gameLog&season=${season}&group=pitching`)
      .then(d => d?.stats?.[0]?.splits || []).catch(() => []));
  entries.forEach((e, i) => {
    const splits = logs[i];
    e.qsStreak = qsStreakLen(splits);
    const streakTier = tierGte(e.qsStreak, 3, 5, 8);
    e.tier = maxTier(e.eraTier, streakTier);
    delete e.eraTier;
  });
  return entries;
}

// Attach today's gamePk to each entry (team-name match against today's schedule) so the
// accuracy checker can later resolve a flagged player against the right boxscore. Streaks
// entries are built from bulk league stats, not per-game data, so they don't carry a
// gamePk otherwise. A team without a game today (off day) simply gets no gamePk — those
// entries are un-gradeable and skipped downstream, not an error.
async function attachGamePks(entries) {
  const today = localDate();
  let games = gameCache.games;
  if (!games || !games.length) games = await getTodaysGames(today).catch(() => []);
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const byTeam = {};
  for (const g of games || []) {
    if (g.home?.name) byTeam[norm(g.home.name)] = g.gamePk;
    if (g.away?.name) byTeam[norm(g.away.name)] = g.gamePk;
  }
  for (const e of entries) e.gamePk = byTeam[norm(e.team)] ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
let cache = { date: null, data: null };

async function getLeagueStreaks() {
  const today = localDate();
  if (cache.date === today && cache.data) return cache.data;

  const SEASON = require('./mlbApi').SEASON;
  const hitStart = addDays(today, -10);
  const pitchStart = addDays(today, -21);

  const [activeIds, hittingRows, pitchingRows] = await Promise.all([
    getActiveLeagueIds(),
    fetchTrailingHitting(hitStart, today),
    fetchTrailingPitching(pitchStart, today),
  ]);

  const battersHotShort  = screenBatters(hittingRows, activeIds, true);
  const battersColdShort = screenBatters(hittingRows, activeIds, false);
  const pitchersHotShort  = screenPitchers(pitchingRows, activeIds, true);
  const pitchersColdShort = screenPitchers(pitchingRows, activeIds, false);

  const [battersHot, battersCold, pitchersHot, pitchersCold] = await Promise.all([
    enrichBatters(battersHotShort, SEASON),
    enrichBatters(battersColdShort, SEASON),
    enrichPitchers(pitchersHotShort, SEASON),
    enrichPitchers(pitchersColdShort, SEASON),
  ]);

  await Promise.all([battersHot, battersCold, pitchersHot, pitchersCold].map(attachGamePks));

  const data = {
    asOf: new Date().toISOString(),
    window: { hitting: { start: hitStart, end: today }, pitching: { start: pitchStart, end: today } },
    battersHot, battersCold, pitchersHot, pitchersCold,
  };
  cache = { date: today, data };
  console.log(`[streaks] board built — batters hot ${battersHot.length}/cold ${battersCold.length}, pitchers hot ${pitchersHot.length}/cold ${pitchersCold.length}`);
  return data;
}

async function recordStreaksLog(date) {
  try {
    const board = await getLeagueStreaks();
    const data = { date, ...board };
    atomicWriteFileSync(fileFor(date), JSON.stringify(data));
    return data;
  } catch (e) {
    console.warn('[streaks] recordStreaksLog failed:', e.message);
    return null;
  }
}

module.exports = { getLeagueStreaks, recordStreaksLog, getStreaksLog };
