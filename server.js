'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cron    = require('node-cron');

const { loadCalibrationHistory, savePredictions, updateWinPredictions, saveDuePredictions, saveMatchupPredictions, accumulateHrpLive, saveCyOldPredictions, saveStreakTagPredictions, saveStreaksBoardPredictions } = require('./lib/accuracy');
const { localDate, addDays, gameCache, matchupCache, getTodaysGames, computeGameMatchups,
        loadSavantLeaderboard, getSavantData, getPitcherArsenal, getBatterArsenalWhiff, dataHealth, refreshWeather, getLeagueHrPerGame } = require('./lib/mlbApi');
const { computeAllProbables } = require('./lib/probabilities');
const { recordHrLog }         = require('./lib/hrLog');
const { getLeagueStreaks, recordStreaksLog } = require('./lib/streaks');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(require('./routes'));

// ---------------------------------------------------------------------------
// Lineup refresh — re-checks every pre-game matchup (not just roster-fallback ones)
// against a fresh lineup fetch and recomputes if the actual batters differ. Only runs
// for pre-game/scheduled games; skips anything already in progress or final.
//
// Previously this only caught the roster-fallback -> confirmed transition (a lineup
// posted for the first time). A lineup that was ALREADY confirmed but later gets AMENDED
// — a late scratch, a defensive reshuffle (e.g. a catcher/DH swap that puts a different
// player behind the plate and a different player into the batting 9) — was never
// re-checked at all, since the filter only looked at games still marked roster-fallback.
// That meant the app kept serving the original lineup's batters/BvP stats all night even
// after a real change, silently missing whoever actually ended up in the game. Now any
// pre-game matchup gets its cached batter-ID set diffed against a fresh fetch each cycle,
// so a genuine substitution is caught and recomputed regardless of whether the lineup was
// already "confirmed" at the time of the change.
// ---------------------------------------------------------------------------
function battersIdKey(arr) {
  return (arr || []).map(p => p.id).sort((a, b) => a - b).join(',');
}

async function refreshUnconfirmedLineups() {
  const today = localDate();
  if (!Object.keys(matchupCache).length) return;

  // Single fresh schedule fetch to get current lineup state for all games.
  const freshGames = await getTodaysGames(today).catch(() => null);
  if (!freshGames) return;

  let anyUpdated = false;
  for (const pkStr of Object.keys(matchupCache)) {
    const pk = parseInt(pkStr);
    const fresh = freshGames.find(g => g.gamePk === pk);
    if (!fresh) continue;

    // Skip games already underway — the lineup is locked in now.
    const status = (fresh.status || '').toLowerCase();
    if (status.includes('progress') || status.includes('final') || status.includes('game over')) continue;

    const cachedGame = gameCache.games && gameCache.games.find(g => g.gamePk === pk);
    if (!cachedGame) continue;

    const homeFreshConfirmed = fresh.home.battersRaw && fresh.home.battersRaw.length > 0;
    const awayFreshConfirmed = fresh.away.battersRaw && fresh.away.battersRaw.length > 0;
    const homeLineupChanged = homeFreshConfirmed && battersIdKey(fresh.home.battersRaw) !== battersIdKey(cachedGame.home.battersRaw);
    const awayLineupChanged = awayFreshConfirmed && battersIdKey(fresh.away.battersRaw) !== battersIdKey(cachedGame.away.battersRaw);
    // Also detect a probable-STARTER change — most importantly TBD -> announced, which the
    // batter-only diff never caught. A game whose SP was TBD at preload built its matchup with
    // NO starter (getPitchingStaff returns bullpen-only when probable is null), so the table
    // showed BvP vs a reliever until the real SP posted. Covers TBD->announced, a late
    // scratch/swap, either side. (— reported: LAD@NYY G2 showed a reliever's BvP.)
    const homeSpChanged = (fresh.home.probable?.id ?? null) !== (cachedGame.home.probable?.id ?? null);
    const awaySpChanged = (fresh.away.probable?.id ?? null) !== (cachedGame.away.probable?.id ?? null);
    const homeChanged = homeLineupChanged || homeSpChanged;
    const awayChanged = awayLineupChanged || awaySpChanged;
    if (!homeChanged && !awayChanged) continue;

    const sides = [];
    if (homeChanged) sides.push('home' + (homeSpChanged ? ' SP' : ''));
    if (awayChanged) sides.push('away' + (awaySpChanged ? ' SP' : ''));
    console.log(`[lineup] Change detected for gamePk ${pk} (${sides.join(', ')}) — recomputing matchup`);

    if (homeLineupChanged) cachedGame.home.battersRaw = fresh.home.battersRaw;
    if (awayLineupChanged) cachedGame.away.battersRaw = fresh.away.battersRaw;
    if (homeSpChanged) cachedGame.home.probable = fresh.home.probable;
    if (awaySpChanged) cachedGame.away.probable = fresh.away.probable;

    try {
      matchupCache[pk] = await computeGameMatchups(cachedGame);
      console.log(`[lineup] ✓ gamePk ${pk} recomputed with updated lineup`);
      anyUpdated = true;
    } catch (e) {
      console.error(`[lineup] ✗ gamePk ${pk} recompute failed: ${e.message}`);
    }
  }

  if (anyUpdated) {
    const probResult = computeAllProbables();
    await savePredictions(probResult);
    updateWinPredictions();
    saveMatchupPredictions();
    console.log('[lineup] Predictions updated after lineup change');
  }
}

// ---------------------------------------------------------------------------
// Background preload
// ---------------------------------------------------------------------------
async function preloadAllMatchups() {
  try {
    const today = localDate();
    const predictionsFile = path.join(__dirname, `predictions-${today}.json`);
    const isFirstRunToday = !fs.existsSync(predictionsFile);

    if (!gameCache.games) {
      gameCache.games     = await getTodaysGames(today);
      gameCache.date      = today;
      gameCache.fetchedAt = Date.now();
    }
    const games = gameCache.games;
    if (!games.length) { console.log('[preload] No games today'); return; }

    // Load the Savant/Statcast layer BEFORE computing matchups & probables. Route
    // handlers load it lazily, but the preload path freezes the daily predictions
    // (graded + emailed) — without this, every Statcast-sourced factor (xwOBA/xERA,
    // hard-hit, barrel, team defense, pitch-arsenal/whiff) silently defaults to neutral.
    try {
      await loadSavantLeaderboard();
      const sav   = Object.keys(getSavantData()).length;
      const ars   = Object.keys(getPitcherArsenal()).length;
      const whiff = Object.keys(getBatterArsenalWhiff()).length;
      if (sav > 0)
        console.log(`[preload] Statcast ready — ${sav} batters, ${ars} pitcher arsenals, ${whiff} batter whiff`);
      else
        console.warn('[preload] WARNING: Statcast layer EMPTY — predictions will lack hard-hit/barrel/arsenal/expected-stats');
    } catch (e) {
      console.error(`[preload] Savant load failed: ${e.message}`);
    }

    console.log(`[preload] Starting background preload for ${games.length} games`);
    for (const game of games) {
      if (matchupCache[game.gamePk]) continue;
      const label = `${game.away.name} @ ${game.home.name}`;
      console.log(`[preload] Computing ${label}...`);
      try {
        matchupCache[game.gamePk] = await computeGameMatchups(game);
        console.log(`[preload] ✓ ${label}`);
      } catch (e) {
        console.error(`[preload] ✗ ${label}: ${e.message}`);
      }
    }
    console.log('[preload] All games preloaded');
    try { await getLeagueHrPerGame(); } catch (e) { console.error(`[hrcal] league rate fetch failed: ${e.message}`); }
    try { dataHealth(); } catch (e) { console.error(`[health] check failed: ${e.message}`); }
    // Save player predictions (no-op if file already exists) then win predictions
    const probResult = computeAllProbables();
    await savePredictions(probResult);
    updateWinPredictions();
    saveDuePredictions();
    saveMatchupPredictions();
    try { saveStreakTagPredictions(); } catch (e) { console.error(`[predictions] streak tag save failed: ${e.message}`); }
    try { await recordHrLog(today); } catch (e) { console.error(`[hrlog] today record failed: ${e.message}`); }
    try { await getLeagueStreaks(); await recordStreaksLog(today); await saveStreaksBoardPredictions(); } catch (e) { console.error(`[streaks] today record failed: ${e.message}`); }
    try { await saveCyOldPredictions(); } catch (e) { console.error(`[predictions] Cy Old save failed: ${e.message}`); }

  } catch (e) {
    console.error('[preload] Fatal:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Automatic daily grading — appends to calibration-history so accuracy is tracked
// without anyone opening the app. Grades the prior 2 days (catches late finals) by
// hitting the local /api/accuracy route, which resolves outcomes and persists.
// ---------------------------------------------------------------------------
async function gradeRecentDays() {
  for (const back of [1, 2]) {
    const date = addDays(localDate(), -back);
    try {
      const r = await fetch(`http://localhost:${PORT}/api/accuracy?date=${date}`);
      if (r.ok) {
        const j = await r.json();
        console.log(`[grade] ${date}: ${j.gamesChecked} games${j.runTotalAccuracy?.n ? `, run-total MAE ${j.runTotalAccuracy.mae} bias ${j.runTotalAccuracy.bias}` : ''}`);
      }
    } catch (e) { console.error(`[grade] ${date} failed: ${e.message}`); }
    try { await recordHrLog(date); } catch (e) { console.error(`[hrlog] ${date} record failed: ${e.message}`); }
  }
}

app.listen(PORT, function () {
  console.log('MLB matchups -> http://localhost:' + PORT);
  loadCalibrationHistory();
  preloadAllMatchups();
  // Grade yesterday shortly after startup, then daily at 11:00 AM CT (all prior-day final).
  gradeRecentDays();
  cron.schedule('0 11 * * *', gradeRecentDays, { timezone: 'America/Chicago' });
  // Refresh market lines every 20 min so the last snapshot before each game start
  // approximates the true closing line (for CLV). No-op until today's file exists.
  cron.schedule('*/20 * * * *', () => {
    recordHrLog(localDate()).catch(e => console.error(`[hrlog] refresh failed: ${e.message}`));
    refreshUnconfirmedLineups().catch(e => console.error(`[lineup] refresh failed: ${e.message}`));
    try { accumulateHrpLive(computeAllProbables().hrpLive); } catch (e) { console.error(`[hrpLive] accumulate failed: ${e.message}`); }
  }, { timezone: 'America/Chicago' });
  // Refresh forecast weather every 30 min — conditions sharpen toward first pitch. Updates
  // matchup.weatherLive (display + live recompute); frozen daily predictions are untouched.
  cron.schedule('*/30 * * * *', () => {
    refreshWeather().catch(e => console.error(`[weather] refresh failed: ${e.message}`));
  }, { timezone: 'America/Chicago' });
});
