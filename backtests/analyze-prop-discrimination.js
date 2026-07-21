'use strict';

// Discrimination audit for player props — the ranking complement to
// an audit script. analyze-prop-factors asks "does this input improve the
// PROBABILITY (calibration / log-loss)?"; this asks "does this signal RANK winners
// above losers within the candidate pool (discrimination / AUC)?" — the property you
// need to FILTER a long elastic list down to the most-likely winners.
//
// For each category it pools every candidate across all prediction files, grades the
// outcome from box scores, and reports per-signal AUC (Mann-Whitney: P(random winner
// outranks random loser); 0.5 = no ranking power, >0.5 = higher signal -> more likely
// to win). It also builds a transparent combined discrimination score and shows the
// hit-rate lift of keeping only the top-N by it.
//
// Box scores are cached under .cache/box/ so re-runs are cheap. Signals present on only
// some model versions (e.g. factor.*) are scored on the days that carry them.

const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT      = __dirname;
const CACHE_DIR = path.join(ROOT, '.cache', 'box');

// over-event occurrence rules
const OCCURRED = {
  hrp:      s => s.hr  >= 1,
  hit:      s => s.h   >  0,
  tb:       s => s.tb  >  s.h,
  tb2:      s => s.tb  >= 2,
  walk:     s => s.bb  >  0,
  rbiOver:  s => s.rbi >= 1,
  runsOver: s => s.r   >= 1,
  sb:       s => s.sb  >  0,
};

// --- fetch + cache ----------------------------------------------------------
let lastCall = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'mlb-disc/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  });
}
async function boxStats(pk) {
  const cacheFile = path.join(CACHE_DIR, pk + '.json');
  if (fs.existsSync(cacheFile)) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  }
  const gap = Date.now() - lastCall; if (gap < 140) await sleep(140 - gap); lastCall = Date.now();
  let box = null;
  for (let i = 0; i < 3 && !box; i++) {
    try { box = await httpJson(`https://statsapi.mlb.com/api/v1/game/${pk}/boxscore`); }
    catch { await sleep(600 * (i + 1)); }
  }
  if (!box) return null;
  const out = {};
  for (const side of ['home', 'away']) {
    for (const p of Object.values(box.teams?.[side]?.players || {})) {
      const id = p.person?.id; const s = p.stats?.batting || {};
      const ab = +(s.atBats||0), bb = +(s.baseOnBalls||0), hbp = +(s.hitByPitch||0), sf = +(s.sacFlies||0);
      if (!id || ab+bb+hbp+sf === 0) continue;
      out[id] = { h:+(s.hits||0), so:+(s.strikeOuts||0), bb, sb:+(s.stolenBases||0),
                  rbi:+(s.rbi||0), r:+(s.runs||0), tb:+(s.totalBases||0), hr:+(s.homeRuns||0) };
    }
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  return out;
}

// --- AUC (Mann-Whitney rank-sum, tie-corrected) -----------------------------
function auc(rows, fn) {
  const v = rows.map(r => ({ v: fn(r), y: r.y })).filter(x => x.v != null && isFinite(x.v));
  const nW = v.filter(x => x.y === 1).length, nL = v.length - nW;
  if (nW < 5 || nL < 5) return null;
  v.sort((a, b) => a.v - b.v);
  let i = 0; const rk = new Array(v.length);
  while (i < v.length) {
    let j = i; while (j + 1 < v.length && v[j+1].v === v[i].v) j++;
    const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) rk[k] = r; i = j + 1;
  }
  let rs = 0; for (let k = 0; k < v.length; k++) if (v[k].y === 1) rs += rk[k];
  const a = (rs - nW * (nW + 1) / 2) / (nW * nL);
  return { auc: a, n: v.length, nW, se: Math.sqrt(a * (1 - a) / Math.min(nW, nL)) };
}

// signal extractors (null-safe; scored only where present)
const SIGNALS = {
  'prob':            e => e.prob,
  'bvpHr':           e => e.bvpHr,
  'bvpAb':           e => e.bvpAb,
  'lineupConfirmed': e => e.lineupConfirmed ? 1 : 0,
  'spTier':          e => e.spTier,
  'spNegTier':       e => e.spNegTier != null ? -e.spNegTier : null,  // higher (less negative) = better arm faced? test sign
  'f.base':          e => e.factors?.base,
  'f.pa':            e => e.factors?.pa,
  'f.park':          e => e.factors?.park,
  'f.pitcher':       e => e.factors?.pitcher,
  'f.bvp':           e => e.factors?.bvp,
  'f.barrel':        e => e.factors?.barrel,
  'f.hardhit':       e => e.factors?.hardhit,
  'f.xba':           e => e.factors?.xba,
  'f.recent':        e => e.factors?.recent,
};

// Combined discrimination score (transparent, env-inclusive). Weights are provisional —
// refine from the per-signal AUCs this tool prints. Env (park) + opportunity (PA) +
// matchup (pitcher faced) + player-specific BvP history.
function discScore(e) {
  const f = e.factors || {};
  let s = 0, any = false;
  const add = (v, w) => { if (v != null && isFinite(v)) { s += v * w; any = true; } };
  add(f.park, 1.0);                                   // game run-environment
  add(f.pa != null ? f.pa - 4.0 : null, 0.30);       // PA opportunity (centered)
  add(f.pitcher, 0.8);                               // pitcher faced (quality/matchup)
  add(e.bvpHr != null ? Math.min(e.bvpHr, 4) : null, 0.10); // confirmed BvP HR history
  add(e.bvpAb != null ? Math.min(e.bvpAb, 30) / 30 : null, 0.05);
  return any ? s : null;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(ROOT)
    .filter(f => /^predictions-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(12,22) < today).sort();

  const data = {}; const pks = new Set();
  for (const c of Object.keys(OCCURRED)) data[c] = [];
  for (const file of files) {
    let d; try { d = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { continue; }
    for (const c of Object.keys(OCCURRED)) {
      for (const e of (d[c] || [])) {
        if (e.batterId == null || e.gamePk == null) continue;
        data[c].push(e); pks.add(e.gamePk);
      }
    }
  }
  const pkArr = [...pks];
  console.log(`Files: ${files.length} (${files[0].slice(12,22)} → ${files[files.length-1].slice(12,22)})  unique games: ${pkArr.length}`);
  process.stdout.write('Fetching/caching box scores... ');
  const stats = {}; let cached = 0;
  for (let i = 0; i < pkArr.length; i++) {
    const r = await boxStats(pkArr[i]); if (r) { stats[pkArr[i]] = r; }
    if (i % 50 === 0) process.stdout.write(`${i}/${pkArr.length} `);
  }
  console.log('done.\n');

  const onlyCat = process.argv[2]; // optional: limit to one category
  for (const cat of Object.keys(OCCURRED)) {
    if (onlyCat && cat !== onlyCat) continue;
    const occ = OCCURRED[cat];
    const rows = [];
    for (const e of data[cat]) {
      const gs = stats[e.gamePk]; if (!gs) continue;
      const a = gs[e.batterId]; if (!a) continue;
      rows.push({ ...e, y: occ(a) ? 1 : 0 });
    }
    if (rows.length < 50) continue;
    const base = rows.filter(r => r.y === 1).length / rows.length;
    console.log('='.repeat(70));
    console.log(`${cat.toUpperCase()}   n=${rows.length}   base hit rate=${(base*100).toFixed(1)}%`);
    console.log('='.repeat(70));

    const scored = [];
    for (const [name, fn] of Object.entries(SIGNALS)) {
      const r = auc(rows, fn); if (r) scored.push({ name, ...r });
    }
    const ds = auc(rows, discScore); if (ds) scored.push({ name: '★ discScore', ...ds });
    scored.sort((x, y) => Math.abs(y.auc - 0.5) - Math.abs(x.auc - 0.5));

    console.log('signal'.padEnd(18) + 'AUC'.padStart(7) + '   ±SE'.padStart(7) + '   n'.padStart(6) + '   strength');
    console.log('-'.repeat(60));
    for (const s of scored) {
      const strength = Math.abs(s.auc - 0.5);
      const sig = strength > 2 * s.se ? (s.auc > 0.5 ? 'RANKS WINNERS' : 'inverse') : '(not sig)';
      console.log(s.name.padEnd(18) + s.auc.toFixed(3).padStart(7) + ('±'+s.se.toFixed(3)).padStart(8) + String(s.n).padStart(6) + '   ' + sig);
    }

    // top-N hit rate by discScore (and by prob for comparison)
    for (const [label, fn] of [['discScore', discScore], ['prob', e => e.prob]]) {
      const srt = rows.filter(r => fn(r) != null).sort((a, b) => fn(b) - fn(a));
      const parts = [];
      for (const frac of [0.1, 0.2, 0.33]) {
        const N = Math.max(5, Math.round(srt.length * frac));
        const hr = srt.slice(0, N).filter(r => r.y === 1).length;
        parts.push(`top${Math.round(frac*100)}% ${(hr/N*100).toFixed(0)}% (${(hr/N/base).toFixed(2)}x)`);
      }
      console.log(`  by ${label.padEnd(9)}: ` + parts.join('   '));
    }
    console.log('');
  }
  console.log('AUC>0.5 = signal ranks winners above losers (useful to filter). "x" = hit-rate lift vs base.');
}
main().catch(e => console.error('ERR', e));
