'use strict';

// Prop-side analog of the moneyline confidence-bucket audit.
// For each player-prop category, buckets the model's SURFACED PICKS by predicted
// probability and grades realized rate per band — exposing BOTH failure modes the
// moneyline audit found: calibration (avgPred vs realized) and discrimination
// (does a higher predicted prob actually win more often?).
//
// Reads completed predictions-YYYY-MM-DD.json files, fetches boxscores, resolves
// outcomes with the same ACCURACY_OCCURRED rules as lib/accuracy.js.
//
// Caveat: the saved per-category arrays are only the BADGED picks (already above a
// threshold), so each category's prob range is compressed — discrimination signal
// is necessarily weaker than the moneyline's (which logs every game). This audits
// "are our surfaced picks calibrated, and do they rank within themselves," not the
// full reliability curve from 0..1.
//
// Buckets by rawProb (pre-correction, model-native) when present (>=),
// else falls back to the corrected prob. avgCorrected is shown alongside so the
// effect of the calibration multiplier is visible.

const fs   = require('fs');
const path = require('path');

const API  = 'https://statsapi.mlb.com/api/v1';
const ROOT = __dirname;

// --- outcome rules (kept in sync with lib/accuracy.js) ----------------------
const ACCURACY_CATS = ['hit','k','cold','hrp','hrm','tb','tb2','walk','rbiOver','rbiUnder','runsOver','runsUnder','sb','bbUnder','kUnder'];
const ACCURACY_OCCURRED = {
  hit:       s => s.h   > 0,
  k:         s => s.so  > 0,
  walk:      s => s.bb  > 0,
  sb:        s => s.sb  > 0,
  tb:        s => s.tb  >  s.h,
  tb2:       s => s.tb  >= 2,
  rbiOver:   s => s.rbi >= 1,
  rbiUnder:  s => s.rbi === 0,
  runsOver:  s => s.r   >= 1,
  runsUnder: s => s.r   === 0,
  hrp:       s => s.hr  >= 1,
  hrm:       s => s.hr  === 0,
  cold:      s => s.h   === 0,
  bbUnder:   s => s.bb  === 0,
  kUnder:    s => s.so  === 0,
};
// human-readable event description per category
const CAT_DESC = {
  hit:'h>0', k:'so>0', cold:'h=0', hrp:'hr>=1', hrm:'hr=0', tb:'tb>h', tb2:'tb>=2',
  walk:'bb>0', rbiOver:'rbi>=1', rbiUnder:'rbi=0', runsOver:'r>=1', runsUnder:'r=0',
  sb:'sb>0', bbUnder:'bb=0', kUnder:'so=0',
};

// --- fetch wrapper (same rate-limit pattern as an audit script) -------------
let lastCall = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mlbGet(url) {
  const gap = Date.now() - lastCall;
  if (gap < 150) await sleep(150 - gap);
  lastCall = Date.now();
  for (let i = 0; i < 3; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'mlb-prop-audit/1.0' }, signal: controller.signal });
      clearTimeout(timer);
      if (r.ok) return r.json();
      if (r.status === 429) await sleep(2000 * (i + 1));
    } catch {
      clearTimeout(timer);
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

async function fetchBoxscoreStats(gamePk) {
  const box = await mlbGet(`${API}/game/${gamePk}/boxscore`);
  if (!box) return null;
  const stats = {};
  for (const side of ['home', 'away']) {
    for (const player of Object.values(box.teams?.[side]?.players || {})) {
      const id = player.person?.id;
      if (!id) continue;
      const s   = player.stats?.batting || {};
      const ab  = parseInt(s.atBats      || 0);
      const bb  = parseInt(s.baseOnBalls || 0);
      const hbp = parseInt(s.hitByPitch  || 0);
      const sf  = parseInt(s.sacFlies    || 0);
      if (ab + bb + hbp + sf === 0) continue; // DNP
      stats[id] = {
        h:   parseInt(s.hits       || 0),
        so:  parseInt(s.strikeOuts || 0),
        bb,
        sb:  parseInt(s.stolenBases || 0),
        rbi: parseInt(s.rbi        || 0),
        r:   parseInt(s.runs       || 0),
        tb:  parseInt(s.totalBases || 0),
        hr:  parseInt(s.homeRuns   || 0),
      };
    }
  }
  return stats;
}

// --- formatting helpers -----------------------------------------------------
const pct  = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + '%' : ' N/A ';
const f3   = x => (x >= 0 ? ' ' : '-') + Math.abs(x).toFixed(3).replace(/^0/, '');
const pad  = (s, w) => String(s).padStart(w);
const padE = (s, w) => String(s).padEnd(w);

// --- main -------------------------------------------------------------------
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(ROOT)
    .filter(f => /^predictions-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter(f => f.slice(12, 22) < today) // only resolved days
    .sort();

  if (!files.length) { console.log('No completed prediction files found.'); return; }

  // Collect per-category picks and the union of gamePks to fetch.
  const picks = {};                 // cat -> [{ batterId, pred, corrected, gamePk }]
  for (const c of ACCURACY_CATS) picks[c] = [];
  const gamePkSet = new Set();
  let rawDays = 0, totalDays = 0;

  for (const file of files) {
    const date = file.slice(12, 22);
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { continue; }
    totalDays++;
    let sawRaw = false;
    for (const cat of ACCURACY_CATS) {
      for (const e of (data[cat] || [])) {
        if (e.batterId == null || e.gamePk == null) continue;
        const corrected = e.prob;
        if (corrected == null) continue;
        // hrm pre-fix bug: old files stored P(HR) (~0.03) instead of P(no HR).
        // Same guard as recomputeCorrectionFactors in lib/accuracy.js.
        if (cat === 'hrm' && corrected < 0.50) continue;
        const pred = (e.rawProb != null ? e.rawProb : e.prob);
        if (e.rawProb != null) sawRaw = true;
        picks[cat].push({ batterId: e.batterId, pred, corrected, gamePk: e.gamePk });
        gamePkSet.add(e.gamePk);
      }
    }
    if (sawRaw) rawDays++;
  }

  console.log(`\nFound ${totalDays} completed day(s): ${files[0].slice(12, 22)} -> ${files[files.length - 1].slice(12, 22)}`);
  console.log(`(${rawDays} day(s) carry rawProb; older days bucket by corrected prob)`);
  console.log(`Unique games to fetch: ${gamePkSet.size}\n`);

  // Fetch boxscores deduped by gamePk.
  const gameStats = {};
  const gamePks = [...gamePkSet].sort();
  let fetchFailed = 0;
  for (let i = 0; i < gamePks.length; i++) {
    process.stdout.write(`\r  ${i + 1}/${gamePks.length} boxscores`);
    const res = await fetchBoxscoreStats(gamePks[i]);
    if (res === null) { fetchFailed++; continue; }
    gameStats[gamePks[i]] = res;
  }
  console.log(`\n  ${fetchFailed} fetch failure(s)\n`);

  // Resolve outcomes; drop unmatched (DNP / missing boxscore).
  for (const cat of ACCURACY_CATS) {
    const occurred = ACCURACY_OCCURRED[cat];
    const resolved = [];
    for (const p of picks[cat]) {
      const actual = gameStats[p.gamePk]?.[p.batterId];
      if (!actual) continue;
      resolved.push({ ...p, won: occurred(actual) ? 1 : 0 });
    }
    picks[cat] = resolved;
  }

  // Per-category report: probability bands + calibration + discrimination.
  const BANDS = [0.50, 0.60, 0.70, 0.80, 0.90, 1.01]; // edges; sub-.50 lumped below
  const summary = [];

  for (const cat of ACCURACY_CATS) {
    const rows = picks[cat];
    if (!rows.length) { continue; }

    rows.sort((a, b) => a.pred - b.pred);
    const n = rows.length;
    const avgPred  = rows.reduce((s, r) => s + r.pred, 0) / n;
    const avgCorr  = rows.reduce((s, r) => s + r.corrected, 0) / n;
    const actual   = rows.reduce((s, r) => s + r.won, 0) / n;

    // Discrimination: split at the median predicted prob, compare realized rates.
    const mid = Math.floor(n / 2);
    const lo = rows.slice(0, mid), hi = rows.slice(mid);
    const loActual = lo.length ? lo.reduce((s, r) => s + r.won, 0) / lo.length : null;
    const hiActual = hi.length ? hi.reduce((s, r) => s + r.won, 0) / hi.length : null;
    const discrim  = (loActual != null && hiActual != null) ? hiActual - loActual : null;

    console.log('===================================================================');
    console.log(` ${cat.toUpperCase().padEnd(10)} (${CAT_DESC[cat]})   n=${n}`);
    console.log('-------------------------------------------------------------------');
    console.log('  band        n   avgPred  actual    gap');

    // bands keyed by lower edge; collect <.50 separately
    const bandStats = {};
    let below = { n: 0, sp: 0, won: 0 };
    for (const r of rows) {
      if (r.pred < BANDS[0]) { below.n++; below.sp += r.pred; below.won += r.won; continue; }
      let lower = BANDS[0];
      for (let i = 0; i < BANDS.length - 1; i++) if (r.pred >= BANDS[i]) lower = BANDS[i];
      (bandStats[lower] ||= { n: 0, sp: 0, won: 0 });
      bandStats[lower].n++; bandStats[lower].sp += r.pred; bandStats[lower].won += r.won;
    }
    if (below.n) {
      const ap = below.sp / below.n, ar = below.won / below.n;
      console.log(`  <.50     ${pad(below.n, 4)}   ${f3(ap)}   ${f3(ar)}   ${f3(ar - ap)}`);
    }
    for (let i = 0; i < BANDS.length - 1; i++) {
      const b = bandStats[BANDS[i]];
      if (!b) continue;
      const lbl = `.${String(Math.round(BANDS[i] * 100)).padStart(2, '0')}-.${String(Math.round(BANDS[i + 1] * 100)).padStart(2, '0')}`;
      const ap = b.sp / b.n, ar = b.won / b.n;
      console.log(`  ${padE(lbl, 8)} ${pad(b.n, 4)}   ${f3(ap)}   ${f3(ar)}   ${f3(ar - ap)}`);
    }
    console.log('-------------------------------------------------------------------');
    console.log(`  OVERALL  ${pad(n, 4)}   ${f3(avgPred)}   ${f3(actual)}   ${f3(actual - avgPred)}   (corrected avgPred ${f3(avgCorr)})`);
    if (discrim != null) {
      const flag = hi.length < 8 || lo.length < 8 ? ' [small n]' : (discrim > 0.02 ? ' ranks +' : discrim < -0.02 ? ' INVERTED' : ' flat');
      console.log(`  discrimination: lower-half ${f3(loActual)} (n=${lo.length})  vs  upper-half ${f3(hiActual)} (n=${hi.length})  =>${f3(discrim)}${flag}`);
    }
    console.log('');

    summary.push({ cat, n, avgPred, avgCorr, actual, gap: actual - avgPred, corrGap: actual - avgCorr, discrim });
  }

  // Compact summary table across categories.
  console.log('\n===================================================================');
  console.log(' SUMMARY (sorted by sample size)');
  console.log('===================================================================');
  console.log(' cat          n   avgPred  actual   gap(raw)  gap(corr)  rank');
  summary.sort((a, b) => b.n - a.n);
  for (const s of summary) {
    const rank = s.discrim == null ? '  -  '
      : s.discrim > 0.02 ? '  +  ' : s.discrim < -0.02 ? ' INV ' : ' flat';
    console.log(
      ` ${padE(s.cat, 10)} ${pad(s.n, 4)}   ${f3(s.avgPred)}   ${f3(s.actual)}   ${f3(s.gap)}   ${f3(s.corrGap)}   ${rank}`
    );
  }
  console.log('-------------------------------------------------------------------');
  console.log(' gap(raw)  = actual - model raw prob  (negative => overconfident)');
  console.log(' gap(corr) = actual - corrected prob  (should be ~0 if calibration works)');
  console.log(' rank: + = higher picks win more (discriminates); INV = inverted; flat = no separation');
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
