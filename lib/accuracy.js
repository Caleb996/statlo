'use strict';

const fs   = require('fs');
const path = require('path');

const { localDate, addDays, matchupCache, recentBatterCache, pitcherRecentCache } = require('./mlbApi');
const { getCyOldList } = require('./cyOld');
const { getLeagueStreaks } = require('./streaks');
const { computeWinPredictions } = require('./winPrediction');
const { computeAllDue } = require('./due');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CALIBRATION_FILE = path.join(__dirname, '..', 'calibration-history.json');

// Atomic write: write to a uniquely-named temp file, then rename over the target.
// Rename is atomic on the same filesystem, so a reader/killed-process/OneDrive-sync
// interruption can never observe (or leave behind) a half-written file — the target
// either has the old complete content or the new complete content, never a mix.
// Several functions in this file (savePredictions, updateWinPredictions,
// recordPropMarketLines, etc.) all read-modify-write the SAME predictions-{date}.json
// file throughout the day with no locking between them; a plain writeFileSync there
// left a real corruption window (confirmed : predictions-.json had
// 1KB of a leftover propMarketLines fragment appended after otherwise-valid JSON).
function atomicWriteFileSync(filePath, data) {
  const tmpPath = `${filePath}.tmp${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

const ACCURACY_CATS      = ['hit','k','cold','hrp','hrm','tb','tb2','walk','rbiOver','rbiUnder','runsOver','runsUnder','sb','bbUnder','kUnder'];
// Graded + displayed in the accuracy view but NOT fed into the correction-factor loop.
// recentK ("ice cold, 45%+ K last 7g") is a recent-FORM filter, not a calibrated daily
// probability — tracking its hit rate is useful, but multiplying it by a correction would
// be meaningless. Kept separate from ACCURACY_CATS so recomputeCorrectionFactors ignores it.
const GRADED_EXTRA_CATS  = ['recentK', 'kAutoOut', 'kMulti', 'vsTeamHr', 'vsTeamCareer', 'actionablesLeadoff', 'actionablesSecond', 'hrpLive'];
// Game-level corrected bets. 'ou' removed — the run total is now graded as a
// prediction (MAE / within-N in the accuracy route), not bet against its own line.
const GAME_ACCURACY_CATS = ['ml', 'spread'];

const ACCURACY_OCCURRED = {
  hit:        s => s.h   > 0,
  k:          s => s.so  > 0,
  walk:       s => s.bb  > 0,
  sb:         s => s.sb  > 0,
  tb:         s => s.tb  >  s.h,
  tb2:        s => s.tb  >= 2,
  rbiOver:    s => s.rbi >= 1,
  rbiUnder:   s => s.rbi === 0,
  runsOver:   s => s.r   >= 1,
  runsUnder:  s => s.r   === 0,
  hrp:        s => s.hr  >= 1,
  hrm:        s => s.hr  === 0,
  cold:       s => s.h   === 0,
  bbUnder:    s => s.bb  === 0,
  kUnder:     s => s.so  === 0,
  recentK:    s => s.so  > 0,   // "ice cold" pick hits if the flagged batter struck out
  kAutoOut:   s => s.so  > 0,   // auto-out matchup K pick hits if the batter struck out
  kMulti:     s => s.so  >= 2,  // multi-K pick hits only on K>=2 (the K1.5 prop bar)
  // Track-record only (GRADED_EXTRA_CATS — no corrective action, per request):
  vsTeamHr:        s => s.hr >= 1,  // "history of HR vs this team" pick hits on any HR tonight
  vsTeamCareer:    s => s.h  >  0,  // "historically owns this team" (career AVG/OPS) pick hits on any hit
  actionablesLeadoff: s => s.r >= 1, // "confirmed leadoff, favorable matchup" hits if they scored
  actionablesSecond:  s => s.r >= 1, // same bar, 2-hole
  hrpLive:    s => s.hr >= 1,        // weather-surfaced live HR+ candidate hits on any HR tonight
};

const LOCK_TO_CAT = {
  'XBH':'tb','1+TB':'tb','2+TB':'tb2','HIT':'hit','RBI+':'rbiOver','RBI-':'rbiUnder',
  'RUN+':'runsOver','RUN-':'runsUnder','BB':'walk','SB':'sb','K':'k','HIT-':'cold','HR+':'hrp',
  'BB-':'bbUnder','K-':'kUnder',
};

// ---------------------------------------------------------------------------
// Calibration state (module-level, mutated in place; use getters for imports)
// ---------------------------------------------------------------------------
let calibrationHistory = [];
let correctionFactors  = {};

function getCorrectionFactors()  { return correctionFactors;  }
function getCalibrationHistory() { return calibrationHistory; }

// ---------------------------------------------------------------------------
// Calibration I/O
// ---------------------------------------------------------------------------
function loadCalibrationHistory() {
  try {
    if (fs.existsSync(CALIBRATION_FILE))
      calibrationHistory = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
    console.log(`[calibration] Loaded ${calibrationHistory.length} day(s) of history`);
  } catch (e) {
    console.error(`[calibration] Load failed: ${e.message}`);
    calibrationHistory = [];
  }
  recomputeCorrectionFactors();
}

function appendCalibrationEntry(date, calibration, gamesLoaded = 0, runTotal = null, spProjectedK = null,
                                 cyOldAccuracy = null, streakTagAccuracy = null, streaksBoardAccuracy = null) {
  calibrationHistory = calibrationHistory.filter(e => e.date !== date);
  const entry = { date, calibration, gamesLoaded };
  if (runTotal && runTotal.n) entry.runTotal = runTotal; // run-total prediction accuracy (MAE/bias/within-N)
  // Projected-Ks (SP) accuracy — same MAE/bias/within-N shape as runTotal, since it's a
  // magnitude prediction (Ks), not a boolean pick. Graded for visibility only (
  // request): no correction factor, this never enters ACCURACY_CATS/recomputeCorrectionFactors.
  if (spProjectedK && spProjectedK.n) entry.spProjectedK = spProjectedK;
  // Observational-only win/loss trackers (request) — {n, wins, rate}, never fed
  // into recomputeCorrectionFactors (no category key, kept as sibling entries like above).
  if (cyOldAccuracy && cyOldAccuracy.n) entry.cyOldAccuracy = cyOldAccuracy;
  if (streakTagAccuracy && streakTagAccuracy.n) entry.streakTagAccuracy = streakTagAccuracy;
  if (streaksBoardAccuracy && streaksBoardAccuracy.n) entry.streaksBoardAccuracy = streaksBoardAccuracy;
  calibrationHistory.push(entry);
  calibrationHistory.sort((a, b) => a.date.localeCompare(b.date));
  const cutoff = addDays(localDate(), -60);
  calibrationHistory = calibrationHistory.filter(e => e.date >= cutoff);
  try {
    atomicWriteFileSync(CALIBRATION_FILE, JSON.stringify(calibrationHistory));
  } catch (e) {
    console.error(`[calibration] Save failed: ${e.message}`);
  }
  recomputeCorrectionFactors();
}

function recomputeCorrectionFactors() {
  const today = localDate();
  const factors = {};
  for (const cat of [...ACCURACY_CATS, ...GAME_ACCURACY_CATS]) {
    // POOLED (recency-weighted) calibration: accumulate predicted and actual "mass"
    // (rate x n) across all qualifying days, then take their ratio. This is the
    // proper calibration multiplier — it makes summed predictions match summed
    // outcomes. It replaces the old mean-of-per-day-ratios, which (a) was blown
    // around by noisy low-n days (a single ~20-pick HR day swings its ratio 0..3)
    // and (b) paired with a per-day n>=20 gate that silently discarded recent
    // sparse-category data — e.g. ~16 HR picks/day rarely cleared the gate, so hrp
    // stayed anchored to stale late-May low-HR days and over-corrected by 40%.
    let predMass = 0, actMass = 0, sampleN = 0, daysUsed = 0;
    for (const entry of calibrationHistory) {
      const daysAgo = Math.round(
        (new Date(today + 'T12:00:00') - new Date(entry.date + 'T12:00:00')) / 86400000
      );
      if (daysAgo < 1 || daysAgo > 21) continue;
      if (entry.gamesLoaded > 0 && entry.gamesLoaded < 10) continue;
      const cal = entry.calibration?.[cat];
      if (!cal || !cal.n || cal.avgPred == null) continue;
      // hrm avgPred was stored as P(HR) pre-fix — skip entries that reflect the old bug
      if (cat === 'hrm' && cal.avgPred < 0.50) continue;
      if (!isFinite(cal.actualRate) || !isFinite(cal.avgPred) || cal.avgPred <= 0) continue;
      const recency = Math.pow(0.88, daysAgo - 1);
      predMass += recency * cal.avgPred    * cal.n;
      actMass  += recency * cal.actualRate * cal.n;
      sampleN  += cal.n;
      daysUsed++;
    }
    // Gate on TOTAL accumulated sample (not per-day) + at least 3 contributing days.
    // Props need ~60 predictions (~3 days x 20); game-level (ml/spread) ~24 (~3 x 8),
    // since only ~8-18 games/day exist.
    const minSample = GAME_ACCURACY_CATS.includes(cat) ? 24 : 60;
    factors[cat] = (predMass > 0 && sampleN >= minSample && daysUsed >= 3)
      ? Math.max(0.55, Math.min(1.30, actMass / predMass))
      : 1.0;
  }
  correctionFactors = factors;
  const active = Object.entries(factors)
    .filter(([, v]) => Math.abs(v - 1.0) > 0.03)
    .map(([k, v]) => `${k}:${v.toFixed(2)}`);
  if (active.length) console.log(`[calibration] Active corrections — ${active.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Prediction persistence
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Curated-set selection : Today's Best + Walker Edge, computed SERVER-SIDE
// so they can be frozen and graded — the UI previously derived both at render time in
// the browser, which made them invisible to the accuracy checker. Shared by the freeze
// path (savePredictions) and the live /api/probables response so the graded set and the
// displayed set are the same selection.
const WALKER_EDGE_CATS = ['hit','hrp','tb','tb2','rbiOver','rbiUnder','runsOver','runsUnder','walk','bbUnder','k','kMulti','sb'];
function isWalkerEdgeEntry(e) {
  return !!(e && e.factors && (e.factors.anchor || 0) >= 0.10 && (e.factors.recent || 0) <= 0
    && e.market && e.market.edge != null && e.market.edge >= 0.04);
}
// Tags e.walkerEdge=true in place across the edge categories (so frozen per-category
// entries carry the flag), and returns the Today's Best board: Walker Edges first, then
// best market edges, then strong-flagged picks — deduped, capped at 10. Entries are
// trimmed copies carrying what the UI card and the grader both need.
function selectCuratedSets(payload) {
  const pool = [];
  for (const cat of WALKER_EDGE_CATS) {
    for (const e of (payload[cat] || [])) {
      if (isWalkerEdgeEntry(e)) e.walkerEdge = true;
      if (e.market && e.market.edge != null && e.market.edge >= 0.04) pool.push({ e, cat });
    }
  }
  pool.sort((a, b) => b.e.market.edge - a.e.market.edge);
  const best = [], seen = new Set();
  const push = (e, cat) => {
    const k = `${e.batterId}|${cat}`;
    if (seen.has(k) || best.length >= 10) return;
    seen.add(k);
    best.push({
      batterId: e.batterId, batter: e.batter, team: e.team, game: e.game, gamePk: e.gamePk,
      pitcher: e.pitcher, cat, prob: e.prob, strong: !!e.strong, market: e.market || null,
      walkerEdge: !!e.walkerEdge, stat: e.stat || '',
    });
  };
  for (const { e, cat } of pool) if (e.walkerEdge) push(e, cat);
  for (const { e, cat } of pool.slice(0, 6)) push(e, cat);
  for (const cat of ['hrp', 'tb2', 'hit', 'k']) {
    (payload[cat] || []).filter(x => x.strong).slice(0, 2).forEach(x => push(x, cat));
  }
  return best;
}

async function savePredictions(payload) {
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (fs.existsSync(filePath)) {
    // Freeze once genuinely published (has real player predictions). But if the
    // file was written at midnight before lineups/probables were set, the arrays
    // are empty — that's not a real publish, so allow overwrite.
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const hasRealData = (existing.k?.length || 0) + (existing.hit?.length || 0) + (existing.hrp?.length || 0) > 5;
      if (hasRealData) return;
    } catch { return; }
  }
  try {
    // Curated sets frozen for grading — must run AFTER the market attach
    // (Walker Edge and the board both need e.market.edge).
    payload.todaysBest = selectCuratedSets(payload);
    const winPreds        = computeWinPredictions();
    // hrpLive IS saved (: graded for track-record visibility, per user request —
    // "who did end up homering," but never a correction driver). It's still a genuinely
    // LIVE weather overlay though — wind conditions sharpen toward first pitch, so the
    // single freeze-time snapshot here would badly undercount the day's real candidates.
    // accumulateHrpLive (called from the 20-min cron in server.js) unions in newly
    // surfaced candidates from fresh computeAllProbables calls throughout the day.
    atomicWriteFileSync(filePath, JSON.stringify({
      date: dateStr, savedAt: new Date().toISOString(), ...payload,
      gameOuPredictions: [], spreadPredictions: [],
    }));
    console.log(`[predictions] Saved for ${dateStr}`);
  } catch (e) {
    console.error(`[predictions] Save failed: ${e.message}`);
  }
}

// Accumulate newly-surfaced hrpLive (weather-adjusted HR+) candidates into today's frozen
// predictions file. Called periodically (20-min cron in server.js) with a fresh hrpLive
// array from computeAllProbables — wind conditions sharpen toward first pitch, so a
// single freeze-time snapshot would badly undercount the day's real candidates. Unions by
// batterId+gamePk (never overwrites/removes existing entries) so every distinct player ever
// flagged live during the day ends up gradeable, while still being excluded from
// ACCURACY_CATS/recomputeCorrectionFactors — track-record only, per request.
function accumulateHrpLive(hrpLiveArr) {
  if (!hrpLiveArr || !hrpLiveArr.length) return;
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return; // nothing frozen yet to accumulate into
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = existing.hrpLive || [];
    const seen = new Set(list.map(e => `${e.batterId}-${e.gamePk}`));
    let added = 0;
    for (const e of hrpLiveArr) {
      const key = `${e.batterId}-${e.gamePk}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(e);
      added++;
    }
    if (added > 0) {
      existing.hrpLive = list;
      atomicWriteFileSync(filePath, JSON.stringify(existing));
      console.log(`[hrpLive] Accumulated ${added} new live HR+ candidate(s) for ${dateStr}`);
    }
  } catch (e) {
    console.error(`[hrpLive] Accumulate failed: ${e.message}`);
  }
}

// Lineup-surprise props: batter/category pairs present in a FRESH probables computation
// that were NOT in the day's frozen predictions-{date}.json snapshot — i.e. genuinely new
// since the slate locked in (a late lineup change, a catcher swap, a scratched starter
// replaced by someone else, etc.). Read-only against the frozen file — never written back
// into it, unlike hrpLive above which deliberately IS accumulated back in for grading.
// Computed fresh on every /api/probables call rather than cached, so it's never stale
// relative to whatever triggered the change.
function getLineupSurpriseProps(freshPayload, dateStr) {
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return [];
  let frozen;
  try { frozen = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return []; }

  const surprises = [];
  for (const cat of ACCURACY_CATS) {
    const frozenIds = new Set((frozen[cat] || []).map(e => e.batterId));
    for (const e of (freshPayload[cat] || [])) {
      if (e.batterId != null && !frozenIds.has(e.batterId)) {
        surprises.push({ ...e, _cat: cat });
      }
    }
  }
  return surprises.sort((a, b) => b.prob - a.prob).slice(0, 20);
}

// Called from /api/win-probabilities after matchupCache is fully populated.
// Updates the win prediction fields in today's file without touching player predictions.
function updateWinPredictions() {
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // FREEZE ONCE PUBLISHED: write win predictions exactly once per day, never overwrite.
    // The daily email goes out in the same first run that saves these; later server
    // restarts (or model changes) must NOT rewrite them, or the accuracy checker would
    // grade a different prediction than was published — which silently skews the record.
    if (existing.moneylinePredictions && existing.moneylinePredictions.length) {
      return;
    }
    const winPreds = computeWinPredictions();
    if (!winPreds.length) return;
    const gameOuPredictions = winPreds.map(g => ({
      gamePk: g.gamePk, game: g.away.abbrev + ' @ ' + g.home.abbrev,
      home: g.home.abbrev, away: g.away.abbrev,
      totalExpRuns: g.totalExpRuns, ouLine: g.ouLine,
      overProb: g.overProb, underProb: g.underProb, ouCall: g.ouCall,
    }));
    const spreadPredictions = winPreds.map(g => ({
      gamePk: g.gamePk, game: g.away.abbrev + ' @ ' + g.home.abbrev,
      home: g.home.abbrev, away: g.away.abbrev,
      homeCoversProb: g.homeCoversProb, awayCoversProb: g.awayCoversProb,
      spreadCall: g.spreadCall, spreadCallProb: g.spreadCallProb,
    }));
    const moneylinePredictions = winPreds.map(g => ({
      gamePk: g.gamePk, game: g.away.abbrev + ' @ ' + g.home.abbrev,
      home: g.home.abbrev, away: g.away.abbrev,
      homeName: g.home.name, awayName: g.away.name, // for market-odds join
      homeWinPct: +g.home.winPct.toFixed(4),
      awayWinPct: +g.away.winPct.toFixed(4),
      rawHomeWinPct: g.rawHomeWinPct ?? null, // pre-regression confidence (for raw-vs-calibrated AUC)
      moneylineCall:     g.home.winPct >= g.away.winPct ? 'HOME' : 'AWAY',
      moneylineCallProb: +Math.max(g.home.winPct, g.away.winPct).toFixed(4),
      winFactors:        g.winFactors, // signed factor contributions toward home (for lift analysis)
    }));
    atomicWriteFileSync(filePath, JSON.stringify({ ...existing, gameOuPredictions, spreadPredictions, moneylinePredictions }));
    console.log(`[predictions] Win predictions updated for ${dateStr} (${winPreds.length} games)`);
  } catch (e) {
    console.error(`[predictions] Win update failed: ${e.message}`);
  }
}

function saveMatchupPredictions() {
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (existing.matchupPredictions && existing.matchupPredictions.length) return; // freeze once published
    const entries = [];
    for (const matchup of Object.values(matchupCache)) {
      const sides = [
        { rows: matchup.awayPitchingVsHome },
        { rows: matchup.homePitchingVsAway },
      ];
      for (const { rows } of sides) {
        for (const row of rows) {
          const spEntry = row.pitchers.find(p => p.pitcher.role === 'SP');
          if (!spEntry) continue;
          entries.push({
            batterId:    row.batter.id,
            batter:      row.batter.name,
            team:        row.batter.team,
            gamePk:      matchup.gamePk,
            game:        `${matchup.away.name} @ ${matchup.home.name}`,
            pitcher:     spEntry.pitcher.name,
            pitcherId:   spEntry.pitcher.id,
            pitcherHand: spEntry.pitcher.hand,
            score:       spEntry.matchupScore,
          });
        }
      }
    }
    if (!entries.length) return;
    atomicWriteFileSync(filePath, JSON.stringify({ ...existing, matchupPredictions: entries }));
    console.log(`[predictions] Matchup predictions saved for ${dateStr} (${entries.length} entries)`);
  } catch (e) {
    console.error(`[predictions] Matchup save failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Observational-only freezes — Cy Old, per-game streak tags, league-wide Streaks board.
// None of these three feed a correction factor (their category keys never appear in
// ACCURACY_CATS/GAME_ACCURACY_CATS/recomputeCorrectionFactors) — they're tracked purely
// so "does this flag actually hold up" has a real answer, same spirit as dueHit/dueHr and
// matchupPredictions above. Same freeze-once-published guard, same atomic write.
// ---------------------------------------------------------------------------
async function saveCyOldPredictions() {
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (existing.cyOld && existing.cyOld.length) return;
    const list = await getCyOldList();
    if (!list.length) return;
    const fresh = JSON.parse(fs.readFileSync(filePath, 'utf8')); // re-read — getCyOldList() awaited above
    if (fresh.cyOld && fresh.cyOld.length) return;
    atomicWriteFileSync(filePath, JSON.stringify({ ...fresh, cyOld: list }));
    console.log(`[predictions] Cy Old predictions saved for ${dateStr} (${list.length} entries)`);
  } catch (e) {
    console.error(`[predictions] Cy Old save failed: ${e.message}`);
  }
}

// Per-game "Notable Runs / Who Sucks" tags (lib/mlbApi.js batterStreakInfo/batterColdInfo/
// pitcherStreakInfo), frozen for the WHOLE slate at once — the live per-game route computes
// these lazily per gamePk on request and was never meant to be a daily prediction. Sourced
// entirely from recentBatterCache/pitcherRecentCache, both already populated for every
// player in today's matchupCache by normal preload — zero new API calls. Threshold parity
// with the per-game tags is partial (HR-last-7/RBI-last-7 aren't cached anywhere and would
// need a fresh fetch to add — deliberately left out; hit-streak/hitless-streak/AVG-last-7/
// K%-last-7/recent-ERA/QS-streak, the primary signals, are all exact matches).
function saveStreakTagPredictions() {
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if ((existing.streakTagsHot && existing.streakTagsHot.length) || (existing.streakTagsCold && existing.streakTagsCold.length)) return;
    const hot = [], cold = [];
    const seenBatters = new Set(), seenPitchers = new Set();
    for (const matchup of Object.values(matchupCache)) {
      const game = `${matchup.away.name} @ ${matchup.home.name}`;
      for (const rows of [matchup.awayPitchingVsHome, matchup.homePitchingVsAway]) {
        for (const row of rows) {
          const b = row.batter;
          if (!seenBatters.has(b.id)) {
            seenBatters.add(b.id);
            const r = recentBatterCache[b.id];
            if (r) {
              const isHot  = r.hitStreak >= 7 || (r.avg7 != null && r.avg7 >= 0.350 && r.ab7 >= 15);
              const isCold = r.hitlessStreak >= 5 || (r.avg7 != null && r.avg7 <= 0.125 && r.ab7 >= 15)
                          || (r.kPct7 != null && r.kPct7 >= 0.45 && r.ab7 >= 15);
              if (isHot)  hot.push({ type: 'batter', batterId: b.id, name: b.name, team: b.team, gamePk: matchup.gamePk, game, hitStreak: r.hitStreak, avg7: r.avg7 });
              if (isCold) cold.push({ type: 'batter', batterId: b.id, name: b.name, team: b.team, gamePk: matchup.gamePk, game, hitlessStreak: r.hitlessStreak, avg7: r.avg7, kPct7: r.kPct7 });
            }
          }
          for (const p of row.pitchers) {
            const pit = p.pitcher;
            if (seenPitchers.has(pit.id)) continue;
            seenPitchers.add(pit.id);
            const r = pitcherRecentCache[pit.id];
            if (!r) continue;
            const isHot  = (r.recentEra != null && r.recentEra <= 2.00 && r.ip3 >= 12) || r.qsStreak >= 3;
            const isCold = r.recentEra != null && r.recentEra > 7.00 && r.ip3 >= 12;
            if (isHot)  hot.push({ type: 'pitcher', pitcherId: pit.id, name: pit.name, team: pit.team, gamePk: matchup.gamePk, game, recentEra: r.recentEra, qsStreak: r.qsStreak });
            if (isCold) cold.push({ type: 'pitcher', pitcherId: pit.id, name: pit.name, team: pit.team, gamePk: matchup.gamePk, game, recentEra: r.recentEra });
          }
        }
      }
    }
    if (!hot.length && !cold.length) return;
    atomicWriteFileSync(filePath, JSON.stringify({ ...existing, streakTagsHot: hot, streakTagsCold: cold }));
    console.log(`[predictions] Streak tag predictions saved for ${dateStr} (${hot.length} hot, ${cold.length} cold)`);
  } catch (e) {
    console.error(`[predictions] Streak tag save failed: ${e.message}`);
  }
}

// League-wide Streaks board (lib/streaks.js) — freezes the same board already computed
// (and cached) for the Research > Streaks tab. Trimmed to just the four player arrays;
// the wOBA/luck-gap detail stays for display, grading only needs id/gamePk/type/hot-cold.
async function saveStreaksBoardPredictions() {
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (existing.streaksBoard) return;
    const board = await getLeagueStreaks();
    const trimmed = {
      battersHot: board.battersHot, battersCold: board.battersCold,
      pitchersHot: board.pitchersHot, pitchersCold: board.pitchersCold,
    };
    const fresh = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (fresh.streaksBoard) return;
    atomicWriteFileSync(filePath, JSON.stringify({ ...fresh, streaksBoard: trimmed }));
    console.log(`[predictions] Streaks board predictions saved for ${dateStr}`);
  } catch (e) {
    console.error(`[predictions] Streaks board save failed: ${e.message}`);
  }
}

function saveDuePredictions() {
  const dateStr  = localDate();
  const filePath = path.join(__dirname, '..', `predictions-${dateStr}.json`);
  if (!fs.existsSync(filePath)) return;
  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // Freeze once published (guard before computeAllDue, which hits the API).
    if ((existing.dueHit && existing.dueHit.length) || (existing.dueHr && existing.dueHr.length)) return;
    const { dueHit, dueHr } = computeAllDue();
    if (!dueHit.length && !dueHr.length) return;
    atomicWriteFileSync(filePath, JSON.stringify({ ...existing, dueHit, dueHr }));
    console.log(`[predictions] Due predictions saved for ${dateStr} (${dueHit.length} hit, ${dueHr.length} HR)`);
  } catch (e) {
    console.error(`[predictions] Due save failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Market lines + CLV (closing line value). Persists the de-vigged book line and
// our edge per game into today's predictions file, refreshed each call so the
// last snapshot before a game starts approximates the true closing line. The
// open→close move on our pick (CLV) is the lowest-variance proof of real edge.
// ---------------------------------------------------------------------------
module.exports = {
  CALIBRATION_FILE, ACCURACY_CATS, GRADED_EXTRA_CATS, GAME_ACCURACY_CATS, ACCURACY_OCCURRED, LOCK_TO_CAT,
  getCorrectionFactors, getCalibrationHistory,
  loadCalibrationHistory, appendCalibrationEntry, recomputeCorrectionFactors,
  savePredictions, updateWinPredictions, saveDuePredictions, saveMatchupPredictions, getLineupSurpriseProps,
  saveCyOldPredictions, saveStreakTagPredictions, saveStreaksBoardPredictions,
  accumulateHrpLive, selectCuratedSets,
};
