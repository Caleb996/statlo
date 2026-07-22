'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const {
  API, SEASON, GAME_CACHE_TTL_MS,
  gameCache, matchupCache, streakCache, batterSplitCache,
  localDate, addDays, isGameComplete, checkDayRollover,
  mlbGet, getTodaysGames, computeGameMatchups, generateMatchupDesc,
  tag, batterStreakInfo, pitcherStreakInfo, batterColdInfo, teamStreakInfo,
  getStandings, buildBullpenSide, getPitcherSeasonStats,
  loadSavantLeaderboard, getSavantData, getCareerVenueCached,
  pitcherStatCache, rpAppearanceCache, recentBatterCache,
} = require('./lib/mlbApi');

const { computeAllProbables, computeManagerTendency, rpRoleFor, RP_LEVERAGE_W } = require('./lib/probabilities');
const { computeDue, computeAllDue } = require('./lib/due');
const { computeWinPredictions } = require('./lib/winPrediction');
const { getSplitLeaders, getEliteSplitMaps, getEliteSplitMatchups } = require('./lib/splitLeaders');
const { recordHrLog, getHrLog } = require('./lib/hrLog');
const { getLeagueStreaks } = require('./lib/streaks');
const { getCyOldList, getCyOldIdSet } = require('./lib/cyOld');
const {
  ACCURACY_CATS, GRADED_EXTRA_CATS, ACCURACY_OCCURRED, LOCK_TO_CAT,
  getCorrectionFactors, getCalibrationHistory,
  appendCalibrationEntry, savePredictions, updateWinPredictions, selectCuratedSets,
  getLineupSurpriseProps,
} = require('./lib/accuracy');
// ---------------------------------------------------------------------------
// MLB Charts — data for the Charts view. Five chart families, all
// served from existing caches/files (no new upstream fetches beyond the extra
// savant columns): luck scatters (inputs vs outcomes — the Walker Edge thesis as
// a picture), pitcher xERA regression, model calibration transparency
// (calibration-history.json), and tonight's park×weather HR environment.
// ---------------------------------------------------------------------------
function chartShortName(n) {
  // Savant names come as "Last, First" — display as "F. Last".
  const m = /^(.+?),\s*(.+)$/.exec(n || '');
  return m ? `${m[2][0]}. ${m[1]}` : (n || '?');
}
function chartLsqFit(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x; }
  const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx);
  return { slope, intercept: (sy - slope * sx) / n };
}
router.get('/api/mlb-charts', async (req, res) => {
  try {
    const chart = req.query.chart || 'hrLuck';
    const { getSavantPitcherData, HR_PARK_FACTORS } = require('./lib/mlbApi');

    // Savant caches are lazy (normally warmed by the first matchup request) — make the
    // charts self-sufficient when hit on a fresh process.
    if (['hrLuck', 'xslgLuck', 'xbaLuck', 'xera'].includes(chart)
        && Object.keys(getSavantData()).length === 0) {
      await loadSavantLeaderboard();
    }

    if (chart === 'hrLuck' || chart === 'xslgLuck' || chart === 'xbaLuck') {
      const pts = [];
      for (const b of Object.values(getSavantData())) {
        if (!b.name || (b.pa || 0) < 150) continue;
        // `full` = raw "Last, First" — the search box matches against it (short labels
        // alone would make first-name searches miss).
        if (chart === 'hrLuck' && b.barrelRate != null && b.pa > 0)
          pts.push({ name: chartShortName(b.name), full: b.name, x: b.barrelRate, y: b.hr / b.pa });
        else if (chart === 'xslgLuck' && b.xslg != null && b.slg != null)
          pts.push({ name: chartShortName(b.name), full: b.name, x: b.xslg, y: b.slg });
        else if (chart === 'xbaLuck' && b.xba != null && b.avg != null)
          pts.push({ name: chartShortName(b.name), full: b.name, x: b.xba, y: b.avg });
      }
      // hrLuck's reference line is a live least-squares fit (the same shape the HR+
      // anchor regression uses); expected-vs-actual pairs use the y=x diagonal.
      const fit = chart === 'hrLuck' ? chartLsqFit(pts) : { slope: 1, intercept: 0 };
      return res.json({ chart, pts, fit });
    }

    if (chart === 'xera') {
      const pts = [];
      for (const p of Object.values(getSavantPitcherData())) {
        if (!p.name || p.xera == null || p.era == null) continue;
        pts.push({ name: chartShortName(p.name), full: p.name, x: p.xera, y: p.era });
      }
      return res.json({ chart, pts, fit: { slope: 1, intercept: 0 } });
    }

    if (chart === 'calibration') {
      const hist = getCalibrationHistory() || [];
      const agg = {};
      const entries = hist.slice(-14);
      for (const day of entries) {
        for (const [cat, c] of Object.entries(day.calibration || {})) {
          if (!c) continue; // some history days carry null category stubs
          const a = (agg[cat] = agg[cat] || { n: 0, predSum: 0, hitSum: 0, roiN: 0, units: 0 });
          if (c.n > 0 && c.avgPred != null && c.actualRate != null) {
            a.n += c.n; a.predSum += c.avgPred * c.n; a.hitSum += c.actualRate * c.n;
          }
        }
      }
      if (chart === 'calibration') {
        const pts = Object.entries(agg).filter(([, a]) => a.n >= 25)
          .map(([cat, a]) => ({ name: cat, x: a.predSum / a.n, y: a.hitSum / a.n, n: a.n }));
        return res.json({ chart, pts, fit: { slope: 1, intercept: 0 } });
      }
      const bars = Object.entries(agg).filter(([, a]) => a.roiN >= 10)
        .map(([cat, a]) => ({ name: cat, units: +a.units.toFixed(1), n: a.roiN, roiPct: +(a.units / a.roiN * 100).toFixed(1) }))
        .sort((x, y) => y.roiPct - x.roiPct);
      return res.json({ chart, bars });
    }

    if (chart === 'parks') {
      const { getGameWeather } = require('./lib/weather');
      const games = await getTodaysGames(localDate());
      const pts = [];
      for (const g of games) {
        if (!g.venueName) continue;
        let wx = null;
        try { wx = await getGameWeather(g.venueId, g.gameTime, false, g.weather?.condition); } catch { /* best-effort */ }
        pts.push({
          name: `${g.away?.abbrev || '?'}@${g.home?.abbrev || '?'}`,
          venue: g.venueName,
          x: HR_PARK_FACTORS[g.venueName.toLowerCase()] ?? 1.0,
          y: wx?.hrMult ?? 1.0,
          windDesc: wx?.windDesc || null, outWindMph: wx?.outWindMph ?? null, tempF: wx?.tempF ?? null,
        });
      }
      return res.json({ chart, pts, fit: null });
    }

    res.status(400).json({ error: 'unknown chart: ' + chart });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Games schedule
// ---------------------------------------------------------------------------
router.get('/api/games', async (req, res) => {
  try {
    checkDayRollover();
    const today = localDate();
    let date = req.query.date || today;

    const cacheStale = Date.now() - gameCache.fetchedAt > GAME_CACHE_TTL_MS;
    if (gameCache.date !== date || !gameCache.games || cacheStale) {
      gameCache.games     = await getTodaysGames(date);
      gameCache.date      = date;
      gameCache.fetchedAt = Date.now();
    }

    if (!req.query.date && gameCache.games.length > 0 &&
        gameCache.games.every(g => isGameComplete(g.status))) {
      date = addDays(today, 1);
      if (gameCache.date !== date) {
        gameCache.games = await getTodaysGames(date);
        gameCache.date  = date;
      }
    }

    // Attach weatherLive (incl. windTrend) from the already-computed matchup cache — the
    // schedule fetch itself only carries MLB's raw single-point weather report, but the
    // scoreboard cards want the forecast-based trend too. No extra fetch: matchupCache is
    // populated by preload/refreshWeather, this just merges what's already there.
    const gamesWithWeather = gameCache.games.map(g => ({
      ...g, weatherLive: matchupCache[g.gamePk]?.weatherLive ?? null,
    }));
    res.json({ date, games: gamesWithWeather });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Matchups for a specific game
// ---------------------------------------------------------------------------
router.get('/api/games/:gamePk/matchups', async (req, res) => {
  try {
    checkDayRollover();
    const pk = parseInt(req.params.gamePk);
    if (!matchupCache[pk] || req.query.force !== undefined) {
      const today = localDate();
      if (!gameCache.games) gameCache.games = await getTodaysGames(today);
      const game = gameCache.games.find(g => g.gamePk === pk);
      if (!game) return res.status(404).json({ error: 'game not found' });
      matchupCache[pk] = await computeGameMatchups(game);
    }
    await loadSavantLeaderboard();
    const savantMap = getSavantData();
    const eliteMaps = await getEliteSplitMaps().catch(() => null);
    const mc = matchupCache[pk];
    const enrichBatter = b => {
      const sv = savantMap[b.id] || {};
      const bs = batterSplitCache[b.id] || {};
      const cv = getCareerVenueCached(b.id, mc.venueId);
      return { ...b, hardHitPct: sv.hardHitPct ?? null, barrelRate: sv.barrelRate ?? null, babip: bs.babip ?? null, careerVenue: cv || null, yoyTrend: bs.yoyTrend ?? null };
    };
    // Elite split-matchup flag: batter is a top-10 hitter vs the EXACT hand of the SP faced.
    const enrichRows = rows => {
      if (!rows || !rows.length) return rows || [];
      const sp = rows[0].pitchers.find(p => p.pitcher.role === 'SP');
      const spHand = sp?.pitcher?.hand;
      const elite = eliteMaps && (spHand === 'L' ? eliteMaps.L : spHand === 'R' ? eliteMaps.R : null);
      return rows.map(r => {
        const batter = enrichBatter(r.batter);
        const e = elite && elite.get(batter.id);
        if (e) batter.eliteSplit = { vsHand: spHand, rank: e.rank, ops: e.ops, avg: e.avg };
        return { ...r, batter };
      });
    };
    res.json({
      ...mc,
      awayPitchingVsHome: enrichRows(mc.awayPitchingVsHome),
      homePitchingVsAway: enrichRows(mc.homePitchingVsAway),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// League-wide Streaks board (Research > Streaks) — hottest/coldest players across all of
// MLB, not just today's slate. Not gated on matchupCache/gamesLoaded (same as
// /api/splits-leaders) since it's independent of today's games. See lib/streaks.js.
// ---------------------------------------------------------------------------
router.get('/api/streaks-board', async (_req, res) => {
  try {
    checkDayRollover();
    const data = await getLeagueStreaks();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ---------------------------------------------------------------------------
// Cy Old (Research > Cy Old) — today's probable starters whose FIP says get your
// popcorn ready. See lib/cyOld.js for the entry/exit filter logic.
// ---------------------------------------------------------------------------
router.get('/api/cy-old', async (_req, res) => {
  try {
    checkDayRollover();
    const pitchers = await getCyOldList();
    res.json({ pitchers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Streaks / Hot / Cold (per-game — Notable Runs / Who Sucks)
// ---------------------------------------------------------------------------
router.get('/api/games/:gamePk/streaks', async (req, res) => {
  try {
    checkDayRollover();
    const pk = parseInt(req.params.gamePk);
    if (streakCache[pk]) return res.json(streakCache[pk]);
    const matchup = matchupCache[pk];
    if (!matchup) return res.status(404).json({ error: 'compute matchups first' });

    const batterMap = {}, pitcherMap = {};
    for (const pair of [...matchup.awayPitchingVsHome, ...matchup.homePitchingVsAway]) {
      const b = pair.batter;
      if (!batterMap[b.id]) batterMap[b.id] = { id: b.id, name: b.name, team: b.team };
      pair.pitchers.forEach(p => {
        const pit = p.pitcher;
        if (!pitcherMap[pit.id]) pitcherMap[pit.id] = { id: pit.id, name: pit.name, team: pit.team };
      });
    }
    const batters  = Object.values(batterMap);
    const pitchers = Object.values(pitcherMap);

    const [bLogs, pLogs, standings] = await Promise.all([
      Promise.all(batters.map(b =>
        mlbGet(`${API}/people/${b.id}/stats?stats=gameLog&season=${SEASON}&group=hitting`)
          .then(d => d?.stats?.[0]?.splits || []))),
      Promise.all(pitchers.map(p =>
        mlbGet(`${API}/people/${p.id}/stats?stats=gameLog&season=${SEASON}&group=pitching`)
          .then(d => d?.stats?.[0]?.splits || []))),
      getStandings(),
    ]);

    const teamEntries = [];
    for (const [teamId, teamName] of [[matchup.home.teamId, matchup.home.name], [matchup.away.teamId, matchup.away.name]]) {
      const tr = standings[teamId];
      if (tr) { const info = teamStreakInfo(tr, teamName); if (info) teamEntries.push(info); }
    }

    const hotBatters  = batters.map((b, i) => batterStreakInfo(bLogs[i], b.name, b.team)).filter(Boolean)
                               .sort((a, b) => (b.hitStreak || 0) - (a.hitStreak || 0));
    const coldBatters = batters.map((b, i) => batterColdInfo(bLogs[i],  b.name, b.team)).filter(Boolean);
    const allPitchers = pitchers.map((p, i) => pitcherStreakInfo(pLogs[i], p.name, p.team)).filter(Boolean);

    const notable = [...hotBatters, ...allPitchers.filter(p => p.isHot !== false), ...teamEntries.filter(t => t.isHot)];
    const sucks   = [...coldBatters, ...allPitchers.filter(p => p.isHot === false), ...teamEntries.filter(t => !t.isHot)];

    const { dueHit, dueHr } = computeDue(matchup);
    const result = { notable, sucks, dueHit, dueHr };
    streakCache[pk] = result;
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Top matchup rankings (cross-game, full-game — SP + likely bullpen blend)
// ---------------------------------------------------------------------------
router.get('/api/top-matchups', (_req, res) => {
  try {
    checkDayRollover();
    const gamesLoaded = Object.keys(matchupCache).length;
    const entries = [];

    const sides = [
      { rows: matchup => matchup.awayPitchingVsHome, lineupKey: 'home' },
      { rows: matchup => matchup.homePitchingVsAway, lineupKey: 'away' },
    ];
    for (const matchup of Object.values(matchupCache)) {
      for (const { rows: getRows, lineupKey } of sides) {
        const lineupConfirmed = matchup.lineupSource?.[lineupKey] === 'confirmed';
        const rows = getRows(matchup);
        if (!rows || !rows.length) continue;
        const spEntryForWt = rows[0].pitchers.find(p => p.pitcher.role === 'SP');
        const { spWt: SP_WT, rpWt: RP_WT, badScriptWt: BAD_SCRIPT_WT } = spEntryForWt
          ? computeManagerTendency(rows, spEntryForWt.pitcher.id)
          : { spWt: 1, rpWt: 0, badScriptWt: 0.15 };
        for (const batterRow of rows) {
          const spEntry = batterRow.pitchers.find(p => p.pitcher.role === 'SP');
          if (!spEntry) continue;

          const bvpPa    = spEntry.bvp?.pa || 0;
          const pitcher  = spEntry.pitcher;
          const bSplits  = batterSplitCache[batterRow.batter.id];
          const splitOps = pitcher.hand === 'L' ? (bSplits?.opsVsL || 0) : (bSplits?.opsVsR || 0);
          const splitPa  = pitcher.hand === 'L' ? (bSplits?.paVsL  || 0) : (bSplits?.paVsR  || 0);
          const splitPaOp= pitcher.hand === 'L' ? (bSplits?.paVsR  || 0) : (bSplits?.paVsL  || 0);

          const eliteSplit  = splitPa >= 50 && (splitOps >= 1.000 || splitOps <= 0.400);
          if (bvpPa < 5 && !eliteSplit) continue;

          const platoonRisk = !lineupConfirmed &&
            splitPa < 30 && splitPaOp > 60 && splitPaOp > splitPa * 2.5;

          // Blend the batter-vs-STARTER score with the batter-vs-BULLPEN score, weighted
          // by each side's expected share of the batter's PAs today (SP_WT/RP_WT, from the
          // starter's typical innings/9 — same split used to blend ERA/xSLG elsewhere).
          // Previously this rating was SP-only, so it ignored how the game actually plays
          // out once the starter exits. Bullpen side: true relievers only (gamesS<=2
          // excludes starters misclassified as RP on days they aren't confirmed starting),
          // excluded if pitched today, down-weighted by the same days-rest/pitch-load
          // availability tax used everywhere else in the bullpen system.
          // Leverage-tiered, mirroring probabilities.js's spPairScore blend: a short/
          // opener-type start (higher BAD_SCRIPT_WT) exposes the mop-up (Middle) tail
          // more; a deep-going starter leans on the leverage-weighted full pen.
          let levWSum = 0, levScoreSum = 0;
          let mopWSum = 0, mopScoreSum = 0;
          for (const pr of batterRow.pitchers) {
            if (pr.pitcher.role !== 'RP') continue;
            const rpSt = pitcherStatCache[pr.pitcher.id] || {};
            if ((rpSt.gamesS || 0) > 2) continue;
            const rest = rpAppearanceCache[pr.pitcher.id] || {};
            if (rest.daysRest === 0) continue;
            let availW = 1.0;
            if      (rest.daysRest === 1 && (rest.g3 || 0) >= 2) availW = 0.70;
            else if ((rest.pitches3 || 0) >= 40)                availW = 0.85;
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
          const bullpenScore = leveragePoolScore != null
            ? leveragePoolScore * (1 - BAD_SCRIPT_WT) + mopPoolScore * BAD_SCRIPT_WT
            : null;
          const blendedScore = bullpenScore != null
            ? +(spEntry.matchupScore * SP_WT + bullpenScore * RP_WT).toFixed(2)
            : spEntry.matchupScore;

          entries.push({
            batter:   batterRow.batter,
            pitcher:  spEntry.pitcher,
            bvp:      spEntry.bvp,
            score:    blendedScore,
            spScore:  spEntry.matchupScore,
            game:     `${matchup.away.name} @ ${matchup.home.name}`,
            splitOps,
            lineupConfirmed,
            paVsHand: splitPa,
            platoonRisk,
          });
        }
      }
    }

    const withDesc = e => ({ ...e, desc: generateMatchupDesc(e.batter, e.pitcher, e.bvp, e.score, e.splitOps) });
    const top    = entries.filter(e => e.score >= 7).sort((a, b) => b.score - a.score).slice(0, 20).map(withDesc);
    const bottom = entries.filter(e => e.score <= 3).sort((a, b) => a.score - b.score).slice(0, 20).map(withDesc);

    res.json({ top, bottom, gamesLoaded });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Due Up — all games
// ---------------------------------------------------------------------------
router.get('/api/due', (_req, res) => {
  try {
    checkDayRollover();
    const { dueHit, dueHr } = computeAllDue();
    function enrich(e) {
      const m = matchupCache[e.gamePk];
      return { ...e, game: m ? `${m.away.name} @ ${m.home.name}` : '' };
    }
    res.json({
      dueHit: dueHit.map(enrich),
      dueHr:  dueHr.map(enrich),
      gamesLoaded: Object.keys(matchupCache).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Probables
// ---------------------------------------------------------------------------
// Statcast leaderboard — today's slate ranked by barrel rate, hard hit %, BABIP
// ---------------------------------------------------------------------------
router.get('/api/statcast-leaders', async (_req, res) => {
  try {
    checkDayRollover();
    await loadSavantLeaderboard();
    const savantMap = getSavantData();
    const seen = new Set();
    const leaders = [];
    for (const mc of Object.values(matchupCache)) {
      for (const rows of [mc.awayPitchingVsHome, mc.homePitchingVsAway]) {
        if (!rows || !rows.length) continue;
        const spEntry = rows[0].pitchers?.find(p => p.pitcher.role === 'SP');
        const spName  = spEntry?.pitcher?.name ?? '?';
        const game    = `${mc.away?.abbrev ?? '?'} @ ${mc.home?.abbrev ?? '?'}`;
        for (const row of rows) {
          const b = row.batter;
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          const sv = savantMap[b.id] || {};
          const bs = batterSplitCache[b.id] || {};
          if (sv.hardHitPct == null && sv.barrelRate == null) continue;
          leaders.push({
            batterId: b.id, batter: b.name, team: b.team,
            game, vsPitcher: spName,
            hardHitPct:  sv.hardHitPct  ?? null,
            barrelRate:  sv.barrelRate  ?? null,
            exitVeloAvg: sv.exitVeloAvg ?? null,
            babip:       bs.babip       ?? null,
          });
        }
      }
    }
    const byBarrel  = [...leaders].sort((a,b) => (b.barrelRate  ?? -1) - (a.barrelRate  ?? -1)).slice(0, 15);
    const byHardHit = [...leaders].sort((a,b) => (b.hardHitPct ?? -1) - (a.hardHitPct ?? -1)).slice(0, 15);
    const byBabip   = leaders
      .filter(l => l.babip != null && l.hardHitPct != null && l.hardHitPct >= 35)
      .sort((a,b) => a.babip - b.babip).slice(0, 10);
    res.json({ byBarrel, byHardHit, byBabip, gamesLoaded: Object.keys(matchupCache).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// YoY regression/breakout leaders across today's slate
// ---------------------------------------------------------------------------
router.get('/api/yoy-trends', async (_req, res) => {
  try {
    checkDayRollover();
    await loadSavantLeaderboard();
    const savantMap = getSavantData();
    const seen = new Set();
    const regressions = [];
    const breakouts = [];
    for (const mc of Object.values(matchupCache)) {
      for (const rows of [mc.awayPitchingVsHome, mc.homePitchingVsAway]) {
        if (!rows || !rows.length) continue;
        const spEntry = rows[0].pitchers?.find(p => p.pitcher.role === 'SP');
        const spName  = spEntry?.pitcher?.name ?? '?';
        const game    = `${mc.away?.abbrev ?? '?'} @ ${mc.home?.abbrev ?? '?'}`;
        for (const row of rows) {
          const b = row.batter;
          if (seen.has(b.id)) continue;
          seen.add(b.id);
          const bs = batterSplitCache[b.id] || {};
          if (!bs.yoyTrend) continue;
          const sv = savantMap[b.id] || {};
          const entry = {
            batterId: b.id, batter: b.name, team: b.team,
            game, vsPitcher: spName,
            trend: bs.yoyTrend,
            woba: bs.woba, avg: bs.avg, obp: bs.obp,
            xwoba: sv.xwoba ?? null,
          };
          if (bs.yoyTrend.direction === 'regression') regressions.push(entry);
          else breakouts.push(entry);
        }
      }
    }
    regressions.sort((a, b) => a.trend.composite - b.trend.composite);
    breakouts.sort((a, b) => b.trend.composite - a.trend.composite);
    res.json({ regressions, breakouts, gamesLoaded: Object.keys(matchupCache).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lightweight per-category realized hit rates over the trailing window — feeds the
// category-header rate chips in the probables UI (UI pass). Reads the
// already-persisted calibration history; no boxscore fetches, instant.
router.get('/api/calibration-summary', (_req, res) => {
  try {
    const hist = getCalibrationHistory();
    const days = (Array.isArray(hist) ? hist : Object.values(hist))
      .filter(d => d && d.date).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-14);
    const out = {};
    for (const d of days) {
      const c = d.calibration || d;
      for (const cat of ACCURACY_CATS) {
        const g = c[cat];
        if (!g || !g.n) continue;
        out[cat] = out[cat] || { n: 0, hits: 0 };
        out[cat].n += g.n; out[cat].hits += g.actualRate * g.n;
      }
    }
    const rates = {};
    for (const cat in out) rates[cat] = { n: out[cat].n, hitRate: +(out[cat].hits / out[cat].n).toFixed(3) };
    res.json({ windowDays: days.length, rates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
router.get('/api/probables', async (_req, res) => {
  try {
    checkDayRollover();
    await loadSavantLeaderboard();
    const probResult = computeAllProbables();
    await savePredictions(probResult); // async since the freeze-time prop-odds attach; await preserves write-before-lineupSurprise ordering
    // Curated sets for display — same selection the freeze path grades, so
    // the board the user sees is the board the accuracy checker scores.
    probResult.todaysBest = selectCuratedSets(probResult);
    // Lineup-surprise props — computed AFTER savePredictions so it can never leak into
    // the frozen daily file. Diffed fresh on every request against whatever WAS frozen.
    probResult.lineupSurprise = getLineupSurpriseProps(probResult, localDate());
    // Cy Old cross-reference (descriptive only — never touches any probability): tag
    // leadoff/hits squad-combo players whose opposing SP is on today's Cy Old list.
    try {
      const cyOldIds = await getCyOldIdSet();
      for (const groups of [probResult.leadoffComboGroups, probResult.hitsComboGroups]) {
        for (const g of (groups || [])) {
          for (const p of (g.players || [])) p.cyOld = cyOldIds.has(p.pitcherId);
        }
      }
    } catch (_) { /* non-fatal — tag just won't show */ }
    res.json(probResult);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Daily HR log — actual home runs hit each day (read from cache; refresh today live)
// ---------------------------------------------------------------------------
router.get('/api/hr-log', async (req, res) => {
  try {
    const days  = Math.min(30, Math.max(1, parseInt(req.query.days) || 10));
    const today = localDate();
    // Refresh today's log on demand so the UI shows HRs as games play out.
    try { await recordHrLog(today); } catch (_) {}
    res.json({ days: getHrLog(days) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ---------------------------------------------------------------------------
// Bullpen
// ---------------------------------------------------------------------------
router.get('/api/games/:gamePk/bullpen', async (req, res) => {
  try {
    checkDayRollover();
    const pk = parseInt(req.params.gamePk);
    if (!matchupCache[pk]) {
      const today = localDate();
      if (!gameCache.games) gameCache.games = await getTodaysGames(today);
      const game = gameCache.games.find(g => g.gamePk === pk);
      if (!game) return res.status(404).json({ error: 'game not found' });
      matchupCache[pk] = await computeGameMatchups(game);
    }
    const m = matchupCache[pk];
    const allMatchupRows = [...(m.awayPitchingVsHome || []), ...(m.homePitchingVsAway || [])];
    const rpIds = new Set();
    for (const row of allMatchupRows)
      for (const pr of row.pitchers || [])
        if (pr.pitcher.role === 'RP') rpIds.add(pr.pitcher.id);
    await Promise.all([...rpIds].map(id => getPitcherSeasonStats(id)));
    res.json({
      gamePk: pk,
      away: { abbrev: m.away.abbrev, name: m.away.name, relievers: buildBullpenSide(m.awayPitchingVsHome) },
      home: { abbrev: m.home.abbrev, name: m.home.name, relievers: buildBullpenSide(m.homePitchingVsAway) },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Win predictions
// ---------------------------------------------------------------------------
router.get('/api/win-probabilities', async (_req, res) => {
  try {
    checkDayRollover();
    const predictions = computeWinPredictions();
    res.json({ predictions });
    // Persist win predictions into today's file after all games are loaded,
    setImmediate(async () => {
      try { updateWinPredictions(); } catch (_) {}
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});






router.get('/api/splits-leaders', async (_req, res) => {
  try {
    const data  = await getSplitLeaders();
    // Flag leaders who have an elite matchup TODAY (facing a starter of the hand they mash).
    const elite = await getEliteSplitMatchups().catch(() => []);
    const byId  = new Map(elite.map(e => [e.batterId, e]));
    for (const [key, wantHand] of [['vsLHP', 'L'], ['vsRHP', 'R']]) {
      for (const r of (data[key] || [])) {
        const e = byId.get(r.id);
        if (e && e.vsHand === wantHand) r.eliteToday = { pitcher: e.pitcher, gamePk: e.gamePk };
      }
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------
router.get('/api/calibration', (_req, res) => {
  const correctionFactors  = getCorrectionFactors();
  const calibrationHistory = getCalibrationHistory();
  const summary = {};
  for (const cat of ACCURACY_CATS) {
    const f    = correctionFactors[cat] ?? 1.0;
    const days = calibrationHistory.filter(e => (e.calibration?.[cat]?.n ?? 0) >= 10).length;
    summary[cat] = { factor: parseFloat(f.toFixed(4)), daysOfData: days };
  }
  res.json({ factors: summary, historyDays: calibrationHistory.length });
});

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------
router.get('/api/accuracy/dates', (_req, res) => {
  try {
    const dates = fs.readdirSync(__dirname)
      .filter(f => /^predictions-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('predictions-', '').replace('.json', ''))
      .sort().reverse();
    res.json({ dates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/accuracy', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: 'Pass ?date=YYYY-MM-DD' });

    const filePath = path.join(__dirname, `predictions-${date}.json`);
    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: `No predictions saved for ${date}` });

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    const gamePks = [...new Set([
      ...[...ACCURACY_CATS, ...GRADED_EXTRA_CATS].flatMap(cat => (saved[cat] || []).map(e => e.gamePk)),
      ...(saved.streakHot            || []).map(e => e.gamePk),
      ...(saved.streakCold           || []).map(e => e.gamePk),
      ...(saved.streakFire           || []).map(e => e.gamePk),
      ...(saved.gameOuPredictions    || []).map(e => e.gamePk),
      ...(saved.spreadPredictions    || []).map(e => e.gamePk),
      ...(saved.spProjectedK         || []).map(e => e.gamePk),
      ...(saved.moneylinePredictions  || []).map(e => e.gamePk),
      ...(saved.matchupPredictions   || []).map(e => e.gamePk),
      ...(saved.dueHit               || []).map(e => e.gamePk),
      ...(saved.dueHr                || []).map(e => e.gamePk),
      ...(saved.cyOld                || []).map(e => e.gamePk),
      ...(saved.streakTagsHot        || []).map(e => e.gamePk),
      ...(saved.streakTagsCold       || []).map(e => e.gamePk),
      ...(saved.streaksBoard ? [
        ...(saved.streaksBoard.battersHot   || []),
        ...(saved.streaksBoard.battersCold  || []),
        ...(saved.streaksBoard.pitchersHot  || []),
        ...(saved.streaksBoard.pitchersCold || []),
      ].map(e => e.gamePk) : []),
    ])].filter(Boolean);

    const actualStats = {};
    const actualPitcherStats = {};
    const teamScores  = {};
    const fetchedGamePks = new Set();
    for (const gamePk of gamePks) {
      const box = await mlbGet(`${API}/game/${gamePk}/boxscore`);
      if (!box) continue;
      fetchedGamePks.add(gamePk);
      // Team-level scores for O/U and spread (skip postponed/cancelled games with 0 AB)
      const homeRuns = parseInt(box.teams?.home?.teamStats?.batting?.runs ?? -1);
      const awayRuns = parseInt(box.teams?.away?.teamStats?.batting?.runs ?? -1);
      const homeAb   = parseInt(box.teams?.home?.teamStats?.batting?.atBats || 0);
      const awayAb   = parseInt(box.teams?.away?.teamStats?.batting?.atBats || 0);
      if (homeRuns >= 0 && awayRuns >= 0 && (homeAb + awayAb) > 0)
        teamScores[gamePk] = { homeRuns, awayRuns, totalRuns: homeRuns + awayRuns };
      // Player-level stats
      for (const side of ['home', 'away']) {
        for (const player of Object.values(box.teams?.[side]?.players || {})) {
          const id = player.person?.id;
          if (!id) continue;
          const s = player.stats?.batting || {};
          const ab = parseInt(s.atBats      || 0);
          const bb = parseInt(s.baseOnBalls || 0);
          const hbp = parseInt(s.hitByPitch || 0);
          const sf = parseInt(s.sacFlies    || 0);
          if (ab + bb + hbp + sf === 0) continue;
          actualStats[id] = {
            h:   parseInt(s.hits         || 0),
            so:  parseInt(s.strikeOuts   || 0),
            bb,
            sb:  parseInt(s.stolenBases  || 0),
            rbi: parseInt(s.rbi          || 0),
            r:   parseInt(s.runs         || 0),
            tb:  parseInt(s.totalBases   || 0),
            hr:  parseInt(s.homeRuns     || 0),
          };
        }
        // Pitcher-level stats — {so,ip} for spProjectedK grading (real Ks thrown that
        // outing); er added for Cy Old / streak-tag pitcher grading (quality-start check:
        // ip>=6 && er<=3, same definition used everywhere else in this app).
        for (const player of Object.values(box.teams?.[side]?.players || {})) {
          const id = player.person?.id;
          const ps = player.stats?.pitching;
          if (!id || !ps) continue;
          const ip = parseFloat(ps.inningsPitched || 0);
          if (ip <= 0) continue;
          actualPitcherStats[id] = { so: parseInt(ps.strikeOuts || 0), ip, er: parseInt(ps.earnedRuns || 0) };
        }
      }
    }

    const calibration = {};
    for (const cat of [...ACCURACY_CATS, ...GRADED_EXTRA_CATS]) {
      const catEntries = saved[cat] || [];
      let n = 0, sumPred = 0, hits = 0;
      // Resolved picks in saved (prob-desc) order — feeds the discrimination check below.
      const resolved = [];
      for (const e of catEntries) {
        const actual = actualStats[e.batterId];
        if (!actual) continue;
        n++;
        // Measure the RAW (pre-correction) probability so the correction factor is
        // computed against the model's own output, not its corrected output. Falls
        // back to prob for files saved before rawProb existed. recentK grades the
        // model's per-game K probability (kGameProb), not its displayed recent rate.
        sumPred += (cat === 'recentK')
          ? (e.kGameProb  != null ? e.kGameProb  : e.prob)
          : (cat === 'kMulti')
          ? (e.kTwoProb   != null ? e.kTwoProb   : e.prob)
          : (e.rawProb    != null ? e.rawProb     : e.prob);
        const won = ACCURACY_OCCURRED[cat](actual);
        if (won) hits++;
        resolved.push(won);
      }
      calibration[cat] = n > 0
        ? { n, avgPred: sumPred / n, actualRate: hits / n }
        : { n: 0 };
      // Discrimination: does the RANKING add value beyond the inclusion floor? Top-10 vs
      // bottom-10 realized rate of the surfaced list (saved order is prob-desc). Distinct
      // from calibration — a category can be well-calibrated on average while its ordering
      // carries no information. Generalized to every category (was hrp-only):
      // 1-2 weeks of these reads is the triage that decides which formulas get rebuilt
      // (rbiOver, factor 0.61, is the prime suspect) and which noise-tails get cut, the
      // same way the hrp read drove its cap. ≥20 resolved picks so the halves don't overlap.
      if (resolved.length >= 20) {
        const top10 = resolved.slice(0, 10), bot10 = resolved.slice(-10);
        const rate = a => a.filter(Boolean).length / a.length;
        calibration[cat].discrimination = {
          top10Rate: +rate(top10).toFixed(3),
          bottom10Rate: +rate(bot10).toFixed(3),
          lift: +(rate(top10) - rate(bot10)).toFixed(3),
        };
        if (cat === 'hrp') calibration.hrpDiscrimination = calibration[cat].discrimination; // keep the original key readers working
      }
    }

    // Curated-set grading : Today's Best board + Walker Edge picks, scored by
    // each pick's OWN category rule. Not in ACCURACY_CATS, so neither drives a correction
    // factor — pure track record for the two headline surfaces.
    {
      let bn = 0, bh = 0;
      for (const e of (saved.todaysBest || [])) {
        const occ = ACCURACY_OCCURRED[e.cat];
        const a = actualStats[e.batterId];
        if (!occ || !a) continue;
        bn++; if (occ(a)) bh++;
      }
      calibration.todaysBest = bn ? { n: bn, actualRate: +(bh / bn).toFixed(3) } : { n: 0 };
      let wn = 0, wh = 0;
      for (const cat of ACCURACY_CATS) {
        for (const e of (saved[cat] || [])) {
          if (!e.walkerEdge) continue;
          const a = actualStats[e.batterId];
          if (!a) continue;
          wn++; if (ACCURACY_OCCURRED[cat](a)) wh++;
        }
      }
      calibration.walkerEdge = wn ? { n: wn, actualRate: +(wh / wn).toFixed(3) } : { n: 0 };
    }

    // Game-level ML calibration
    {
      let n = 0, sumPred = 0, hits = 0;
      for (const g of (saved.moneylinePredictions || [])) {
        const score = teamScores[g.gamePk];
        if (!score || score.homeRuns === score.awayRuns) continue;
        n++;
        sumPred += g.moneylineCallProb;
        if (g.moneylineCall === 'HOME' ? score.homeRuns > score.awayRuns : score.awayRuns > score.homeRuns) hits++;
      }
      calibration['ml'] = n > 0 ? { n, avgPred: sumPred / n, actualRate: hits / n } : { n: 0 };
    }
    // Game-level spread (run-line ±1.5) calibration — did the called side cover?
    {
      let n = 0, sumPred = 0, hits = 0;
      for (const g of (saved.spreadPredictions || [])) {
        const score = teamScores[g.gamePk];
        if (!score) continue;
        n++;
        sumPred += g.spreadCallProb;
        const diff = score.homeRuns - score.awayRuns;
        if (g.spreadCall === 'HOME' ? diff >= 2 : diff <= -2) hits++;
      }
      calibration['spread'] = n > 0 ? { n, avgPred: sumPred / n, actualRate: hits / n } : { n: 0 };
    }
    // Run-total prediction accuracy — graded as a prediction (how close), NOT an O/U
    // bet. No market line needed: the projected total vs the actual total.
    let runTotalAccuracy = { n: 0 };
    {
      let n = 0, absErr = 0, within1 = 0, within2 = 0, signedErr = 0;
      for (const g of (saved.gameOuPredictions || [])) {
        const score = teamScores[g.gamePk];
        if (!score || g.totalExpRuns == null) continue;
        n++;
        const err = score.totalRuns - g.totalExpRuns;
        absErr += Math.abs(err); signedErr += err;
        if (Math.abs(err) <= 1) within1++;
        if (Math.abs(err) <= 2) within2++;
      }
      if (n > 0) runTotalAccuracy = {
        n, mae: +(absErr / n).toFixed(2), bias: +(signedErr / n).toFixed(2),
        within1Pct: +(within1 / n).toFixed(3), within2Pct: +(within2 / n).toFixed(3),
      };
    }

    // Projected-Ks (SP) accuracy — graded for visibility only (request), same
    // MAE/bias/within-N shape as runTotal since it's a magnitude prediction, not a boolean
    // pick. Never feeds a correction factor (spProjectedK is not in ACCURACY_CATS).
    let spProjectedKAccuracy = { n: 0 };
    const spProjectedKResults = [];
    {
      let n = 0, absErr = 0, within1 = 0, within2 = 0, signedErr = 0;
      for (const e of (saved.spProjectedK || [])) {
        const actual = actualPitcherStats[e.pitcherId];
        const dnp = !actual && fetchedGamePks.has(e.gamePk);
        let err = null;
        if (actual) {
          err = actual.so - e.projK;
          n++;
          absErr += Math.abs(err); signedErr += err;
          if (Math.abs(err) <= 1) within1++;
          if (Math.abs(err) <= 2) within2++;
        }
        spProjectedKResults.push({
          pitcher: e.pitcher, pitcherId: e.pitcherId, team: e.team, opponent: e.opponent,
          game: e.game, gamePk: e.gamePk, projK: e.projK,
          actualK: actual?.so ?? null, err: err != null ? +err.toFixed(1) : null, dnp,
        });
      }
      if (n > 0) spProjectedKAccuracy = {
        n, mae: +(absErr / n).toFixed(2), bias: +(signedErr / n).toFixed(2),
        within1Pct: +(within1 / n).toFixed(3), within2Pct: +(within2 / n).toFixed(3),
      };
    }

    const entries = {};
    for (const cat of [...ACCURACY_CATS, ...GRADED_EXTRA_CATS]) {
      entries[cat] = (saved[cat] || []).map(e => {
        const actual = actualStats[e.batterId];
        let won = null;
        if (actual) {
          won = ACCURACY_OCCURRED[cat](actual);
        }
        return { name: e.batter || e.name, batterId: e.batterId, gamePk: e.gamePk, prob: e.prob, won };
      });
    }
    // Curated-set per-pick entries — the Today's Best board and Walker Edge
    // picks graded pick-by-pick so the accuracy page can show them as first-class
    // sections, each pick judged by its own category's rule (labeled in the name).
    entries.todaysBest = (saved.todaysBest || []).map(e => {
      const actual = actualStats[e.batterId];
      const occ = ACCURACY_OCCURRED[e.cat];
      return { name: `${e.batter} (${e.cat})`, batterId: e.batterId, gamePk: e.gamePk, prob: e.prob,
        won: (actual && occ) ? occ(actual) : null };
    });
    entries.walkerEdge = [];
    for (const cat of ACCURACY_CATS) {
      for (const e of (saved[cat] || [])) {
        if (!e.walkerEdge) continue;
        const actual = actualStats[e.batterId];
        entries.walkerEdge.push({ name: `${e.batter} (${cat})`, batterId: e.batterId, gamePk: e.gamePk,
          prob: e.prob, won: actual ? ACCURACY_OCCURRED[cat](actual) : null });
      }
    }

    const streakResults = {
      hot:  (saved.streakHot  || []).map(e => {
        const a = actualStats[e.batterId];
        return { name: e.batter, batterId: e.batterId, team: e.team, hitStreak: e.hitStreak,
                 won: a != null ? a.h > 0 : null };
      }),
      cold: (saved.streakCold || []).map(e => {
        const a = actualStats[e.batterId];
        return { name: e.batter, batterId: e.batterId, team: e.team, hitlessStreak: e.hitlessStreak,
                 won: a != null ? a.h === 0 : null };
      }),
      fire: (saved.streakFire || []).map(e => {
        const a = actualStats[e.batterId];
        return { name: e.batter, batterId: e.batterId, team: e.team, avg7: e.avg7, ab7: e.ab7,
                 won: a != null ? a.h > 0 : null };
      }),
    };

    // Game-level spread results (run line ±1.5)
    const spreadResults = (saved.spreadPredictions || []).map(g => {
      const score = teamScores[g.gamePk];
      let won = null;
      if (score) {
        const diff = score.homeRuns - score.awayRuns;
        won = g.spreadCall === 'HOME' ? diff >= 2 : diff <= -2;
      }
      return {
        game: g.game, gamePk: g.gamePk,
        spreadCall: g.spreadCall, spreadCallProb: g.spreadCallProb,
        homeCoversProb: g.homeCoversProb, awayCoversProb: g.awayCoversProb,
        home: g.home, away: g.away,
        actualHome: teamScores[g.gamePk]?.homeRuns ?? null,
        actualAway: teamScores[g.gamePk]?.awayRuns ?? null,
        won,
      };
    });

    // Matchup score accuracy (TB threshold by score tier)
    function matchupTbThreshold(score) {
      if (score === 10) return 3; // HR or 2B+hit or 3 singles
      if (score >= 8)   return 2; // any XBH or 2+ hits
      if (score >= 5)   return 1; // any hit
      if (score <= 3)   return 0; // hitless = cold prediction correct
      return null;                // score 4 — ambiguous, skip
    }
    const matchupResults = (saved.matchupPredictions || []).map(e => {
      const actual = actualStats[e.batterId];
      const dnp    = !actual && fetchedGamePks.has(e.gamePk);
      const thresh = matchupTbThreshold(e.score);
      let won = null;
      if (actual !== undefined && thresh !== null)
        won = e.score <= 3 ? actual.tb === 0 : actual.tb >= thresh;
      return {
        batterId: e.batterId, batter: e.batter, team: e.team,
        gamePk: e.gamePk, game: e.game,
        pitcher: e.pitcher, pitcherHand: e.pitcherHand,
        score: e.score, tbThreshold: thresh,
        actualTb: actual?.tb ?? null,
        won, dnp,
      };
    }).filter(e => e.tbThreshold !== null);

    const dueHitResults = (saved.dueHit || []).map(e => {
      const actual = actualStats[e.batterId];
      const dnp    = !actual && fetchedGamePks.has(e.gamePk);
      return {
        name: e.batter, team: e.team, batterId: e.batterId, gamePk: e.gamePk,
        hitlessAbs: e.hitlessAbs, seasonAvg: e.seasonAvg, prob: e.prob,
        won: actual ? actual.h > 0 : null, dnp,
      };
    });

    const dueHrResults = (saved.dueHr || []).map(e => {
      const actual = actualStats[e.batterId];
      const dnp    = !actual && fetchedGamePks.has(e.gamePk);
      return {
        name: e.batter, team: e.team, batterId: e.batterId, gamePk: e.gamePk,
        absSinceHr: e.absSinceHr, expectedAbsPerHr: e.expectedAbsPerHr, multiple: e.multiple,
        won: actual ? actual.hr >= 1 : null, dnp,
      };
    });

    // ---------------------------------------------------------------------------
    // Observational-only grading — Cy Old, per-game streak tags, league-wide Streaks
    // board. None of these feed `calibration` / recomputeCorrectionFactors; they're their
    // own response keys + their own sibling entries in calibration-history.json, same
    // treatment as runTotalAccuracy/spProjectedKAccuracy above.
    // ---------------------------------------------------------------------------
    function winRate(results) {
      const decided = results.filter(r => r.won != null);
      if (!decided.length) return { n: 0 };
      const wins = decided.filter(r => r.won).length;
      return { n: decided.length, wins, rate: +(wins / decided.length).toFixed(3) };
    }

    // Cy Old — flag "holds up" if the pitcher failed to record a quality start (IP>=6,
    // ER<=3) that day, same QS definition used everywhere else in this app.
    const cyOldResults = (saved.cyOld || []).map(e => {
      const actual = actualPitcherStats[e.id];
      const dnp    = !actual && fetchedGamePks.has(e.gamePk);
      const won    = actual ? !(actual.ip >= 6 && actual.er <= 3) : null;
      return {
        name: e.name, team: e.team, opponent: e.opponent, pitcherId: e.id, gamePk: e.gamePk,
        seasonFip: e.seasonFip, trailingFip: e.trailingFip, reason: e.reason,
        actualIp: actual?.ip ?? null, actualEr: actual?.er ?? null,
        won, dnp,
      };
    });
    const cyOldAccuracy = winRate(cyOldResults);

    // Per-game Notable Runs/Who Sucks tags, frozen slate-wide (saveStreakTagPredictions).
    // "won" = the flag held up: hot batter -> got a hit; cold batter -> didn't; hot pitcher
    // -> quality start; cold pitcher -> not a quality start.
    function gradeStreakTags(list, wantHot) {
      return (list || []).map(e => {
        let actualFact = null, dnp = false;
        if (e.type === 'batter') {
          const actual = actualStats[e.batterId];
          dnp = !actual && fetchedGamePks.has(e.gamePk);
          actualFact = actual ? actual.h > 0 : null;
        } else {
          const actual = actualPitcherStats[e.pitcherId];
          dnp = !actual && fetchedGamePks.has(e.gamePk);
          actualFact = actual ? (actual.ip >= 6 && actual.er <= 3) : null;
        }
        const won = actualFact == null ? null : (wantHot ? actualFact : !actualFact);
        return { ...e, won, dnp };
      });
    }
    const streakTagHotResults  = gradeStreakTags(saved.streakTagsHot,  true);
    const streakTagColdResults = gradeStreakTags(saved.streakTagsCold, false);
    const streakTagAccuracy = winRate([...streakTagHotResults, ...streakTagColdResults]);

    // League-wide Streaks board (lib/streaks.js) — same won-semantics as above, entries
    // use `id` (not batterId/pitcherId) and are already split into 4 typed arrays.
    function gradeStreaksBoardList(list, wantHot, isPitcher) {
      return (list || []).map(e => {
        let actualFact = null, dnp = false;
        if (isPitcher) {
          const actual = actualPitcherStats[e.id];
          dnp = !actual && fetchedGamePks.has(e.gamePk);
          actualFact = actual ? (actual.ip >= 6 && actual.er <= 3) : null;
        } else {
          const actual = actualStats[e.id];
          dnp = !actual && fetchedGamePks.has(e.gamePk);
          actualFact = actual ? actual.h > 0 : null;
        }
        const won = actualFact == null ? null : (wantHot ? actualFact : !actualFact);
        return { ...e, won, dnp };
      });
    }
    const sbSaved = saved.streaksBoard || {};
    const streaksBoardResults = {
      battersHot:   gradeStreaksBoardList(sbSaved.battersHot,   true,  false),
      battersCold:  gradeStreaksBoardList(sbSaved.battersCold,  false, false),
      pitchersHot:  gradeStreaksBoardList(sbSaved.pitchersHot,  true,  true),
      pitchersCold: gradeStreaksBoardList(sbSaved.pitchersCold, false, true),
    };
    const streaksBoardAccuracy = winRate([
      ...streaksBoardResults.battersHot, ...streaksBoardResults.battersCold,
      ...streaksBoardResults.pitchersHot, ...streaksBoardResults.pitchersCold,
    ]);

    appendCalibrationEntry(date, calibration, gamePks.length, runTotalAccuracy, spProjectedKAccuracy,
      cyOldAccuracy, streakTagAccuracy, streaksBoardAccuracy);
    res.json({
      date, gamesChecked: gamePks.length, playersMatched: Object.keys(actualStats).length,
      calibration, entries,
      streaks: streakResults,
      spreadResults, matchupResults,
      runTotalAccuracy,
      spProjectedKAccuracy, spProjectedKResults,
      dueHitResults, dueHrResults,
      cyOldResults, cyOldAccuracy,
      streakTagHotResults, streakTagColdResults, streakTagAccuracy,
      streaksBoardResults, streaksBoardAccuracy,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});




// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------
// Ranks every batter currently in recentBatterCache (populated for anyone referenced in
// today's loaded matchups) by paRealizationRatio ascending — the batters whose last-15-game
// PA average falls furthest short of a full game, i.e. the strongest "gets pulled/pinch-hit
// for early" signal (see getRecentBatterStats in lib/mlbApi.js, added).
router.get('/api/debug/platoon-risk', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
  const nameMap = {};
  for (const matchup of Object.values(matchupCache)) {
    for (const [rows, teamAbbrev] of [
      [matchup.awayPitchingVsHome, matchup.home?.abbrev],
      [matchup.homePitchingVsAway, matchup.away?.abbrev],
    ]) {
      for (const r of (rows || [])) {
        if (r.batter?.id != null) nameMap[r.batter.id] = { name: r.batter.name, team: teamAbbrev };
      }
    }
  }
  const ranked = Object.entries(recentBatterCache)
    .filter(([, v]) => v && v.paRealizationRatio != null)
    .map(([id, v]) => ({
      batterId: +id,
      name: nameMap[id]?.name || null,
      team: nameMap[id]?.team || null,
      avgPa15: +v.avgPa15.toFixed(2),
      paRealizationRatio: v.paRealizationRatio,
      shortGames15: v.shortGames15,
    }))
    .sort((a, b) => a.paRealizationRatio - b.paRealizationRatio)
    .slice(0, limit);
  res.json({ n: Object.keys(recentBatterCache).length, ranked });
});

router.get('/api/bvp-debug', async (req, res) => {
  const { batterId, pitcherId } = req.query;
  if (!batterId || !pitcherId) return res.status(400).json({ error: 'Pass ?batterId=&pitcherId=' });
  const raw = await mlbGet(
    `${API}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}`
  );
  res.json(raw);
});

router.get('/api/splits-debug', async (req, res) => {
  const { batterId } = req.query;
  if (!batterId) return res.status(400).json({ error: 'Pass ?batterId=' });
  const { batterSplitCache, mlbGet: get, API: api, SEASON: s } = require('./lib/mlbApi');
  const [season, splits] = await Promise.all([
    mlbGet(`${API}/people/${batterId}/stats?stats=season&season=${SEASON}&group=hitting`),
    mlbGet(`${API}/people/${batterId}/stats?stats=statSplits&season=${SEASON}&group=hitting&sitCodes=vl,vr`),
  ]);
  const splitMap = {};
  for (const s of splits?.stats?.[0]?.splits || []) splitMap[s.split?.code] = s.stat;
  res.json({ season: season?.stats?.[0]?.splits?.[0]?.stat, splitRaw: splits?.stats?.[0]?.splits, splitMap, parsed: batterSplitCache[batterId] || null });
});


module.exports = router;
