'use strict';
// Daily home-run log. Collects every HR actually hit each day from the box scores and
// caches it to hr-log-<date>.json (same convention as predictions-<date>.json). Feeds the
// "HR Log" UI area. Re-running a day overwrites it, so today's log fills in live as games
// finalize. Decoupled from grading — only a few box-score fetches per day, cached to disk.
const fs   = require('fs');
const path = require('path');
const { API, mlbGet, localDate, addDays } = require('./mlbApi');

// Atomic write (temp file + rename) — same fix as lib/accuracy.js: a plain writeFileSync
// on a file that gets rewritten repeatedly through the day (this one live-updates as
// today's games finalize) is vulnerable to corruption from an interrupted write or
// OneDrive sync interference (this project lives in a OneDrive-synced folder).
function atomicWriteFileSync(filePath, data) {
  const tmpPath = `${filePath}.tmp${process.pid}`;
  fs.writeFileSync(tmpPath, data);
  fs.renameSync(tmpPath, filePath);
}

let teamAbbrevMap = null;
let teamAbbrevDay = null;
async function loadTeamAbbrev() {
  const today = localDate();
  if (teamAbbrevMap && teamAbbrevDay === today) return teamAbbrevMap;
  const data = await mlbGet(`${API}/teams?sportId=1`);
  const map = {};
  for (const t of data?.teams || []) map[t.id] = t.abbreviation || t.teamName || t.name;
  teamAbbrevMap = map; teamAbbrevDay = today;
  return map;
}

const fileFor = date => path.join(__dirname, '..', `hr-log-${date}.json`);

// Collect every HR hit on `date` from Live/Final box scores. Returns the day's record.
async function recordHrLog(date) {
  const abbr  = await loadTeamAbbrev();
  const sched = await mlbGet(`${API}/schedule?date=${date}&sportId=1`);
  const games = [];
  for (const d of sched?.dates || []) for (const g of d.games || []) games.push(g);
  const played = games.filter(g => {
    const s = g.status?.abstractGameState;
    return s === 'Final' || s === 'Live';
  });

  const hitters = [];
  let finalGames = 0;
  for (const g of played) {
    if (g.status?.abstractGameState === 'Final') finalGames++;
    let box;
    try { box = await mlbGet(`${API}/game/${g.gamePk}/boxscore`); } catch { continue; }
    const homeId = g.teams?.home?.team?.id, awayId = g.teams?.away?.team?.id;
    for (const side of ['home', 'away']) {
      const team   = box.teams?.[side];
      const teamId = team?.team?.id;
      const oppId  = side === 'home' ? awayId : homeId;
      for (const p of Object.values(team?.players || {})) {
        const hr = parseInt(p.stats?.batting?.homeRuns || 0);
        if (hr > 0) hitters.push({
          name: p.person?.fullName, id: p.person?.id,
          team: abbr[teamId] || team?.team?.name || '', opp: abbr[oppId] || '',
          hr, gamePk: g.gamePk,
        });
      }
    }
  }
  hitters.sort((a, b) => b.hr - a.hr || (a.name || '').localeCompare(b.name || ''));

  const data = {
    date, games: played.length, finalGames,
    totalHr: hitters.reduce((s, h) => s + h.hr, 0),
    players: hitters.length, hitters,
    updatedAt: new Date().toISOString(),
  };
  try { atomicWriteFileSync(fileFor(date), JSON.stringify(data)); } catch (_) { /* non-fatal */ }
  return data;
}

// Read cached HR logs for the last `days` days (most recent first). Missing days skipped.
function getHrLog(days = 10) {
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

module.exports = { recordHrLog, getHrLog };
