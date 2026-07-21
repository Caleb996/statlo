'use strict';

// Input-contribution audit for player props — the prop-side analog of
// an audit script. For each prop category it ablates every logged input
// (propFactors): removes that one factor's effect from the model's per-PA rate,
// recomputes the prediction, and compares log-loss WITH vs WITHOUT the factor
// against actual outcomes. ΔlogLoss = loss(without) - loss(with):
//   positive  -> removing the input HURTS  => the input is helping (keep)
//   negative  -> removing the input HELPS  => the input is adding noise (prune/flip)
//
// Works in "over-rate" space: under categories (cold/hrm/kUnder/...) are mapped to
// their over event and their negated contributions flipped back, so an input's lift
// is measured once per underlying rate. Requires predictions files with `factors`
// (logged from  forward; older files are skipped).
//
// Reuses the boxscore-fetch pattern of an audit script / an audit script.

const fs   = require('fs');
const path = require('path');

const API  = 'https://statsapi.mlb.com/api/v1';
const ROOT = __dirname;

// over-event occurrence rules (keyed by the OVER category)
const OCCURRED = {
  hit:     s => s.h   > 0,
  k:       s => s.so  > 0,
  hrp:     s => s.hr  >= 1,
  tb:      s => s.tb  >  s.h,
  tb2:     s => s.tb  >= 2,
  walk:    s => s.bb  > 0,
  rbiOver: s => s.rbi >= 1,
  runsOver:s => s.r   >= 1,
  sb:      s => s.sb  > 0,
};
// under category -> its over twin (same underlying per-PA rate)
const UNDER_TO_OVER = {
  cold: 'hit', hrm: 'hrp', kUnder: 'k', bbUnder: 'walk',
  rbiUnder: 'rbiOver', runsUnder: 'runsOver',
};
const ALL_CATS = [...Object.keys(OCCURRED), ...Object.keys(UNDER_TO_OVER)];
const META = new Set(['base', 'rate', 'pa']);
const SKIP_ABLATION = new Set(['hotrunner']); // applies to under prob, not the over rate

// --- fetch wrapper ----------------------------------------------------------
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
      const r = await fetch(url, { headers: { 'User-Agent': 'mlb-prop-factor-audit/1.0' }, signal: controller.signal });
      clearTimeout(timer);
      if (r.ok) return r.json();
      if (r.status === 429) await sleep(2000 * (i + 1));
    } catch { clearTimeout(timer); await sleep(800 * (i + 1)); }
  }
  return null;
}
async function fetchBoxscoreStats(gamePk) {
  const box = await mlbGet(`${API}/game/${gamePk}/boxscore`);
  if (!box) return null;
  const stats = {};
  for (const side of ['home', 'away']) {
    for (const player of Object.values(box.teams?.[side]?.players || {})) {
      const id = player.person?.id; if (!id) continue;
      const s = player.stats?.batting || {};
      const ab = +(s.atBats || 0), bb = +(s.baseOnBalls || 0), hbp = +(s.hitByPitch || 0), sf = +(s.sacFlies || 0);
      if (ab + bb + hbp + sf === 0) continue;
      stats[id] = { h:+(s.hits||0), so:+(s.strikeOuts||0), bb, sb:+(s.stolenBases||0),
                    rbi:+(s.rbi||0), r:+(s.runs||0), tb:+(s.totalBases||0), hr:+(s.homeRuns||0) };
    }
  }
  return stats;
}

// --- math -------------------------------------------------------------------
const clampP = p => Math.max(1e-4, Math.min(1 - 1e-4, p));
const logLoss = (p, y) => { p = clampP(p); return -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); };
const pEvent = (rate, pa) => 1 - Math.pow(1 - Math.max(0, Math.min(1, rate)), pa); // P(>=1 over-event)
const pad = (s, w) => String(s).padStart(w);
const padE = (s, w) => String(s).padEnd(w);
const sgn = x => (x >= 0 ? '+' : '');

// --- main -------------------------------------------------------------------
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(ROOT)
    .filter(f => /^predictions-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter(f => f.slice(12, 22) < today)
    .sort();
  if (!files.length) { console.log('No completed prediction files found.'); return; }

  // collect entries that carry factors, keyed by OVER category
  const data = {};            // overCat -> [{ batterId, gamePk, factors }]
  for (const c of Object.keys(OCCURRED)) data[c] = [];
  const gamePkSet = new Set();
  let daysWithFactors = 0;

  for (const file of files) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { continue; }
    let sawFactors = false;
    for (const cat of ALL_CATS) {
      const overCat = OCCURRED[cat] ? cat : UNDER_TO_OVER[cat];
      const isUnder = !OCCURRED[cat];
      for (const e of (d[cat] || [])) {
        if (!e.factors || e.batterId == null || e.gamePk == null) continue;
        sawFactors = true;
        // canonicalize contributions to OVER direction
        const f = e.factors;
        const over = { base: f.base, rate: f.rate, pa: f.pa };
        for (const k in f) if (!META.has(k)) over[k] = isUnder ? -f[k] : f[k];
        data[overCat].push({ batterId: e.batterId, gamePk: e.gamePk, f: over });
        gamePkSet.add(e.gamePk);
      }
    }
    if (sawFactors) daysWithFactors++;
  }

  const totalEntries = Object.values(data).reduce((s, a) => s + a.length, 0);
  console.log(`\nFound ${files.length} completed day(s); ${daysWithFactors} carry propFactors.`);
  if (!totalEntries) {
    console.log('No entries with propFactors yet. Freeze a few slates first, then re-run.');
    return;
  }
  console.log(`Entries with factors: ${totalEntries}   Unique games: ${gamePkSet.size}\n`);

  // fetch outcomes
  const gameStats = {};
  const pks = [...gamePkSet].sort();
  let fail = 0;
  for (let i = 0; i < pks.length; i++) {
    process.stdout.write(`\r  ${i + 1}/${pks.length} boxscores`);
    const r = await fetchBoxscoreStats(pks[i]); if (r === null) { fail++; continue; }
    gameStats[pks[i]] = r;
  }
  console.log(`\n  ${fail} fetch failure(s)\n`);

  // per category: ablate each factor
  const summaryBvp = [];
  for (const overCat of Object.keys(OCCURRED)) {
    const rows = data[overCat];
    if (!rows.length) continue;
    const occurred = OCCURRED[overCat];

    // resolve outcomes
    const resolved = [];
    for (const r of rows) {
      const a = gameStats[r.gamePk]?.[r.batterId];
      if (!a) continue;
      resolved.push({ f: r.f, y: occurred(a) ? 1 : 0 });
    }
    if (resolved.length < 10) { console.log(`${overCat}: only ${resolved.length} resolved — skipping\n`); continue; }

    // factor keys present in this category
    const keys = new Set();
    for (const r of resolved) for (const k in r.f) if (!META.has(k) && !SKIP_ABLATION.has(k)) keys.add(k);

    const baseRate = resolved.reduce((s, r) => s + (r.y), 0) / resolved.length;
    console.log('===================================================================');
    console.log(` ${overCat.toUpperCase()}   n=${resolved.length}   actual=${baseRate.toFixed(3)}`);
    console.log(' factor      nActive  avg|contrib|  dLogLoss/active(x1000)  verdict');
    console.log('-------------------------------------------------------------------');

    const catRows = [];
    for (const key of [...keys].sort()) {
      let nActive = 0, sumAbs = 0, sumDelta = 0, sumDeltaAll = 0;
      for (const r of resolved) {
        const c = r.f[key]; if (c == null) continue;
        const pWith = pEvent(r.f.rate, r.f.pa);
        const rateWo = r.f.rate / Math.exp(c);                 // remove this factor from the rate
        const pWo   = pEvent(rateWo, r.f.pa);
        const dl = logLoss(pWo, r.y) - logLoss(pWith, r.y);    // >0 => factor helps
        sumDeltaAll += dl;
        if (Math.abs(c) > 0.005) { nActive++; sumAbs += Math.abs(c); sumDelta += dl; }
      }
      const perActive = nActive ? (sumDelta / nActive) * 1000 : 0;
      const verdict = nActive < 20 ? 'thin'
        : perActive > 0.5 ? 'HELPS'
        : perActive < -0.5 ? 'HURTS <-'
        : 'flat';
      catRows.push({ key, nActive, avgAbs: nActive ? sumAbs / nActive : 0, perActive, verdict });
    }
    catRows.sort((a, b) => a.perActive - b.perActive); // worst (most negative) first
    for (const r of catRows) {
      console.log(' ' + padE(r.key, 11) + pad(r.nActive, 6) + '   ' + r.avgAbs.toFixed(4).padStart(8)
        + '      ' + (sgn(r.perActive) + r.perActive.toFixed(2)).padStart(10) + '         ' + r.verdict);
      if (r.key === 'bvp') summaryBvp.push({ cat: overCat, ...r });
    }
    console.log('');
  }

  // headline: BvP across categories (the input most suspected of adding noise)
  if (summaryBvp.length) {
    console.log('===================================================================');
    console.log(' BvP BLEND across categories (the headline suspect)');
    console.log('===================================================================');
    console.log(' cat        nActive  avg|contrib|  dLogLoss/active(x1000)  verdict');
    for (const r of summaryBvp.sort((a, b) => a.perActive - b.perActive))
      console.log(' ' + padE(r.cat, 11) + pad(r.nActive, 6) + '   ' + r.avgAbs.toFixed(4).padStart(8)
        + '      ' + (sgn(r.perActive) + r.perActive.toFixed(2)).padStart(10) + '         ' + r.verdict);
  }
  console.log('\ndLogLoss/active > 0 => input improves predictions (keep); < 0 => adds noise (prune/flip).');
  console.log('"thin" = <20 active entries; let more slates accumulate.');
}

main().catch(e => { console.error('\nFatal:', e.message, e.stack); process.exit(1); });
