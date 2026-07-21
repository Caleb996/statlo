'use strict';

// League-wide platoon-split leaderboards: the best hitters vs LHP and vs RHP this season,
// with prior-season split blended in so a thin current sample doesn't fluke onto the list
// (and a proven masher with a slow start still qualifies). Ranks by sample-regressed OPS.

const { mlbGet, API, SEASON, localDate, gameCache, getTodaysGames, getPitcherHand, getActiveRosterIds, getCrushHrMatchup, getBattingLineup } = require('./mlbApi');

let cache = { date: null, data: null };

async function fetchSplitBoard(season, sit) {
  // playerPool=ALL, not "qualified": the qualified pool requires ~3.1 PA/game over the
  // FULL season, which silently excludes part-time / platoon / rested hitters who have a
  // large sample vs ONE hand (e.g. Goldschmidt's 90+ PA vs LHP). Those are often the best
  // split hitters. We sort by OPS and apply our own ≥50-PA-vs-hand floor in build.
  const url = `${API}/stats?stats=statSplits&group=hitting&season=${season}`
    + `&sitCodes=${sit}&gameType=R&playerPool=all&limit=600&sortStat=onBasePlusSlugging`;
  const j = await mlbGet(url);
  const out = {};
  for (const s of (j?.stats?.[0]?.splits || [])) {
    const id = s.player?.id; if (!id) continue;
    out[id] = {
      name: s.player.fullName,
      team: s.team?.abbreviation || s.team?.triCode || s.team?.name || '',
      ops:  parseFloat(s.stat?.ops) || null,
      pa:   parseInt(s.stat?.plateAppearances) || 0,
      avg:  s.stat?.avg, obp: s.stat?.obp, slg: s.stat?.slg,
      hr:   parseInt(s.stat?.homeRuns) || 0,
      hand: s.player?.batSide?.code || null,
    };
  }
  return out;
}

// Rank by CURRENT-season split OPS (the user wants "best this season"). Require a real
// current sample (≥50 PA vs the hand) to avoid hot-streak flukes — OR a proven prior-season
// split (≥.850 over ≥150 PA) so an established masher with a thinner sample still qualifies.
// Prior OPS is shown as context, not used to demote a strong current performer.
const MIN_PA = 50;
function build(cur, pri) {
  const rows = [];
  for (const id of Object.keys(cur)) {
    const c = cur[id]; if (c.ops == null) continue;
    const p = pri[id];
    const provenPrior = p && p.ops != null && p.ops >= 0.850 && p.pa >= 150;
    if (c.pa < MIN_PA && !(provenPrior && c.pa >= 25)) continue;
    rows.push({
      id: Number(id), name: c.name, team: c.team,
      ops: c.ops, pa: c.pa,
      priorOps: p?.ops ?? null, priorPa: p?.pa ?? 0,
      smallSample: c.pa < MIN_PA,   // qualified via proven prior
      avg: c.avg, obp: c.obp, slg: c.slg, hr: c.hr,
    });
  }
  rows.sort((a, b) => b.ops - a.ops);
  return rows.slice(0, 10);
}

async function getSplitLeaders() {
  const today = localDate();
  if (cache.date === today && cache.data) return cache.data;
  const [curL, curR, priL, priR] = await Promise.all([
    fetchSplitBoard(SEASON, 'vl'), fetchSplitBoard(SEASON, 'vr'),
    fetchSplitBoard(SEASON - 1, 'vl').catch(() => ({})),
    fetchSplitBoard(SEASON - 1, 'vr').catch(() => ({})),
  ]);
  const data = {
    season: SEASON,
    vsLHP: build(curL, priL),
    vsRHP: build(curR, priR),
  };
  cache = { date: today, data };
  return data;
}

// Build { L: Map(id→leaderRow), R: Map(id→leaderRow) } from the cached leaders.
async function getEliteSplitMaps() {
  const d = await getSplitLeaders();
  return {
    L: new Map(d.vsLHP.map((r, i) => [r.id, { ...r, rank: i + 1 }])),
    R: new Map(d.vsRHP.map((r, i) => [r.id, { ...r, rank: i + 1 }])),
  };
}

// Players in today's slate who are a TOP-10 split hitter against the exact hand of the
// starter they're facing — an "elite split matchup" green flag. Driven by the SCHEDULE's
// probable pitchers (available immediately), NOT the per-game matchup compute — so a flag
// shows as soon as the slate loads rather than waiting for every game to finish preloading.
// When a lineup is confirmed we still drop a leader who's actually benched today. That
// lineup check alone isn't enough, though: a traded or injured player (e.g. on the IL)
// can still slip through until that specific game's lineup happens to post, since an
// unconfirmed lineup leaves `lineupIds` null and skips the check entirely. So we also
// cross-check MLB's actual active (26-man, non-IL) roster per team, independent of
// lineup-confirmation timing.
async function getEliteSplitMatchups() {
  const maps = await getEliteSplitMaps();
  let games = gameCache.games;
  if (!games || !games.length) { try { games = await getTodaysGames(localDate()); } catch { games = []; } }
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

  // batting-team(full name, normalized) → { hand of opposing SP, pitcher name, gamePk, lineupIds, teamId }
  const teamOpp = {};
  for (const g of games) {
    const setSide = async (battingTeam, oppProbable, battersRaw) => {
      if (!battingTeam?.name || !oppProbable?.id) return;
      const hand = await getPitcherHand(oppProbable.id).catch(() => null);
      if (!hand) return;
      const lineupIds = (battersRaw && battersRaw.length) ? new Set(battersRaw.map(b => b.id)) : null;
      teamOpp[norm(battingTeam.name)] = { hand, pitcher: oppProbable.fullName, gamePk: g.gamePk, lineupIds, teamId: battingTeam.teamId };
    };
    await setSide(g.home, g.away?.probable, g.home?.battersRaw); // home bats vs away SP
    await setSide(g.away, g.home?.probable, g.away?.battersRaw); // away bats vs home SP
  }

  // Active-roster check, cached per team per day — catches injured/traded/rehab players
  // that a lineup-confirmation-only filter would miss before that game's lineup posts.
  const teamIds = [...new Set(Object.values(teamOpp).map(o => o.teamId).filter(Boolean))];
  const activeRosters = {};
  await Promise.all(teamIds.map(async id => {
    activeRosters[id] = await getActiveRosterIds(id).catch(() => null);
  }));

  const out = [];
  for (const [hand, m] of [['L', maps.L], ['R', maps.R]]) {
    for (const [id, r] of m) {
      const opp = teamOpp[norm(r.team)];
      if (!opp || opp.hand !== hand) continue;
      if (opp.lineupIds && !opp.lineupIds.has(id)) continue; // confirmed out of the lineup → skip
      const activeSet = opp.teamId != null ? activeRosters[opp.teamId] : null;
      if (activeSet && !activeSet.has(id)) continue; // not on the active (non-IL) roster → skip
      out.push({
        batterId: id, batter: r.name, team: r.team,
        vsHand: hand, rank: r.rank, ops: r.ops, avg: r.avg, pa: r.pa,
        pitcher: opp.pitcher, gamePk: opp.gamePk,
      });
    }
  }
  out.sort((a, b) => b.ops - a.ops);
  return out;
}

// Crush Matchup Spotlight — today's batter/pitcher crush-group matches (batter's own
// established SLG>=.500 in a pitch group, SP throws that group >=25%), sorted by SLG
// descending. Built for the daily email as a same-day, model-native alternative to the
// generic season-OPS-based elite split matchups above — ties directly into the crush-
// matchup validation work rather than a plain platoon-split leaderboard.
//
// Uses getBattingLineup's confirmed-lineup-OR-active-roster-fallback (the same mechanism
// every other part of the app already relies on) instead of requiring battersRaw
// directly. Previously this required a CONFIRMED lineup with no fallback at all — at
// email-send time (well before most first pitches), only whichever 1-2 games had already
// posted a lineup would ever show up, clustering the whole section around one game.
// Each entry is tagged `confirmed: true/false` so the email can show which candidates are
// locked in vs. the team's most-likely-to-play regulars (roster-fallback, sorted by
// games played — same heuristic used everywhere else in the app).
async function getCrushMatchupSpotlight() {
  let games = gameCache.games;
  if (!games || !games.length) { try { games = await getTodaysGames(localDate()); } catch { games = []; } }
  const out = [];
  for (const g of games) {
    const checkSide = async (battingTeam, oppProbable) => {
      if (!battingTeam?.name || !oppProbable?.id) return;
      const confirmed = !!(battingTeam.battersRaw && battingTeam.battersRaw.length);
      let lineup;
      try { lineup = await getBattingLineup(battingTeam); } catch { return; }
      for (const b of lineup) {
        const crush = getCrushHrMatchup(b.id, oppProbable.id);
        if (crush && crush.matched) {
          out.push({
            batterId: b.id, batter: b.name, team: battingTeam.name,
            pitcher: oppProbable.fullName, group: crush.group, slg: crush.slg, usage: crush.usage,
            gamePk: g.gamePk, confirmed,
          });
        }
      }
    };
    await checkSide(g.home, g.away?.probable);
    await checkSide(g.away, g.home?.probable);
  }
  // Pure SLG-quality sort — NOT confirmed-first. A confirmed-first sort combined with the
  // cap below silently squeezed out every projected (later-game) entry whenever enough
  // early, already-confirmed games filled the cap on their own — exactly the "clusters
  // around one game" problem, just moved one step later in the pipeline. Also cap at 2
  // per game so one lineup's several matches can't crowd out the rest of the slate.
  out.sort((a, b) => b.slg - a.slg);
  const perGame = {};
  const capped = [];
  for (const e of out) {
    perGame[e.gamePk] = (perGame[e.gamePk] || 0) + 1;
    if (perGame[e.gamePk] > 2) continue;
    capped.push(e);
    if (capped.length >= 12) break;
  }
  return capped;
}

module.exports = { getSplitLeaders, getEliteSplitMaps, getEliteSplitMatchups, getCrushMatchupSpotlight };
