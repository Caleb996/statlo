var games=[], currentData=null, currentTab=0, sortCol='score', sortDir=-1, rankingsVisible=false, probablesVisible=false, accuracyVisible=false, notableVisible=false, sucksVisible=false, dueVisible=false, bullpenVisible=false, winOddsVisible=false, statcastVisible=false, yoyVisible=false, splitsVisible=false, streaksBoardVisible=false, cyOldVisible=false, hrLogVisible=false, chartsVisible=false, currentGamePk=null;
var winPredictions=[], currentDueData=null;

function lastName(n){ var p=n&&n.trim().split(' '); return p&&p.length?p[p.length-1]:'TBD'; }
function na(v){ return (v===null||v===undefined) ? '<span class="na">-</span>' : v; }
function pct(v){ return (v===null||v===undefined) ? '<span class="na">-</span>' : v+'%'; }
function dec3(v){ return (!v&&v!==0) ? '<span class="na">-</span>' : parseFloat(v).toFixed(3); }
function dec2(v){ return (!v&&v!==0) ? '<span class="na">-</span>' : parseFloat(v).toFixed(2); }

function getSortVal(p, col){
  var b=p.bvp;
  switch(col){
    case 'lineup': return p.batter.battingOrder != null ? p.batter.battingOrder : 99;
    case 'score':  return p.matchupScore;
    case 'pa':     return b ? b.pa  : -1;
    case 'ab':     return b ? b.ab  : -1;
    case 'h':       return b ? b.h       : -1;
    case 'doubles': return b ? b.doubles : -1;
    case 'triples': return b ? b.triples : -1;
    case 'hr':      return b ? b.hr      : -1;
    case 'rbi':    return b ? b.rbi : -1;
    case 'bso':    return b ? b.so  : -1;
    case 'kpct':   return b ? (parseFloat(b.kpct)  || -1) : -1;
    case 'bb':     return b ? b.bb  : -1;
    case 'bbpct':  return b ? (parseFloat(b.bbpct) || -1) : -1;
    case 'avg':    return b ? (b.avg || -1) : -1;
    case 'obp':    return b ? (b.obp || -1) : -1;
    case 'slg':    return b ? (b.slg || -1) : -1;
    case 'hh':     return p.batter.hardHitPct != null ? p.batter.hardHitPct : -1;
    case 'brl':    return p.batter.barrelRate  != null ? p.batter.barrelRate  : -1;
    case 'babip':  return p.batter.babip       != null ? p.batter.babip       : -1;
    default:       return p.matchupScore;
  }
}

function sortBy(col){
  if(sortCol===col){ sortDir*=-1; } else { sortCol=col; sortDir=-1; }
  renderTable();
}

function th(col, label){
  var arrow = sortCol===col ? (sortDir===-1 ? ' ▼' : ' ▲') : '';
  var cls = 'sortable' + (sortCol===col ? ' sort-active' : '');
  return '<th class="'+cls+'" onclick="sortBy(\''+col+'\')">'+label+arrow+'</th>';
}

async function init(){
  console.log('[init] starting');
  var list = document.getElementById('game-list');
  var d;
  try {
    console.log('[init] fetching /api/games');
    d = await fetch('/api/games').then(function(r){
      console.log('[init] got response', r.status);
      if(!r.ok) throw new Error('Server error '+r.status);
      return r.json();
    });
    console.log('[init] parsed JSON, games:', d && d.games && d.games.length);
  } catch(e) {
    console.error('[init] fetch error:', e);
    list.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load games.<br>'+e.message+'</p>';
    return;
  }
  games = d.games||[];
  if(!games.length){list.innerHTML='<p style="color:var(--ink-3);font-size:.82rem">No games today.</p>';return;}
  console.log('[init] rendering', games.length, 'games');
  list.innerHTML = games.map(function(g){
    var awayP = g.away&&g.away.probable ? lastName(g.away.probable.fullName) : 'TBD';
    var homeP = g.home&&g.home.probable ? lastName(g.home.probable.fullName) : 'TBD';
    return '<div class="game-card" id="gc-'+g.gamePk+'" onclick="loadGame('+g.gamePk+')">'+
      '<div class="game-teams">'+(g.away&&g.away.abbrev||'?')+' @ '+(g.home&&g.home.abbrev||'?')+'</div>'+
      '<div class="game-time">'+fmtTime(g.gameTime)+'</div>'+
      '<div class="game-pitchers">'+awayP+' vs '+homeP+'</div>'+
      '<div class="game-status '+statusCls(g.status)+'">'+(g.status||'Scheduled')+(scoreLine(g)?' · '+scoreLine(g):'')+'</div>'+
      fmtWeather(g)+
      '</div>';
  }).join('');
  console.log('[init] done');
  // Inject win prediction mini bars; retry up to 3x if not all games are covered yet
  function fetchWinBars(attemptsLeft){
    fetch('/api/win-probabilities').then(function(r){return r.json();}).then(function(d){
      winPredictions=d.predictions||[];
      updateGameCardWinBars();
      if(attemptsLeft>0 && winPredictions.length < games.length){
        setTimeout(function(){ fetchWinBars(attemptsLeft-1); }, 30000);
      }
    }).catch(function(){});
  }
  fetchWinBars(3);
}

function statusCls(s){
  if(!s)return 'status-pre';
  if(s.includes('Progress'))return 'status-live';
  if(s.includes('Final'))return 'status-final';
  return 'status-pre';
}

// Score only means anything once the game has actually started — a 0-0 "Scheduled"
// game would be misleading noise, not a real score.
function scoreLine(g){
  if(!g || g.away==null || g.home==null) return '';
  var s=g.status||'';
  if(!(s.includes('Progress')||s.includes('Final')||s.includes('Over'))) return '';
  if(g.away.score==null||g.home.score==null) return '';
  return g.away.score+'-'+g.home.score;
}

// Lightweight periodic refresh — re-fetches the game list (score/status only, same data
// already used for the sidebar cards) and updates the currently open game's header in
// place. Deliberately does NOT touch currentData/the matchup table (that's the expensive
// BvP computation and only needs the 20-min server-side lineup-refresh cadence) — this
// just keeps the score/status display current while a game is being watched live.
async function refreshLiveScores(){
  try{
    var d = await fetch('/api/games').then(function(r){return r.json();});
    games = d.games||[];
    games.forEach(function(g){
      var gc=document.getElementById('gc-'+g.gamePk);
      if(!gc) return;
      var statusEl=gc.querySelector('.game-status');
      if(statusEl){
        statusEl.className='game-status '+statusCls(g.status);
        var sl=scoreLine(g);
        statusEl.textContent=(g.status||'Scheduled')+(sl?' · '+sl:'');
      }
    });
    if(currentGamePk!=null){
      var cur=games.find(function(g){return g.gamePk===currentGamePk;});
      if(cur && currentData){
        currentData.status=cur.status;
        currentData.home.score=cur.home.score;
        currentData.away.score=cur.away.score;
        var statusLineEl=document.getElementById('game-status-line');
        if(statusLineEl){
          var sl=scoreLine(cur);
          statusLineEl.innerHTML=fmtTime(cur.gameTime)+' &nbsp;·&nbsp; '+(cur.status||'Scheduled')+(sl?' &nbsp;·&nbsp; <strong>'+sl+'</strong>':'');
        }
      }
    }
  }catch(e){ console.error('[refreshLiveScores] failed:', e.message); }
}
setInterval(refreshLiveScores, 30000);

async function loadGame(pk){
  document.querySelectorAll('.game-card').forEach(function(c){c.classList.remove('active');});
  var gc=document.getElementById('gc-'+pk);
  if(gc)gc.classList.add('active');
  closeAllNavPanelsAndMatchup();
  document.getElementById('main-header').innerHTML=
    '<h2>Loading matchups...</h2><p class="meta">Fetching BvP history for all pairings — this may take 1-2 min</p>';
  currentGamePk=pk;

  var d = await fetch('/api/games/'+pk+'/matchups').then(function(r){return r.json();});
  currentData=d; currentTab=0;

  var wH=d.lineupSource&&d.lineupSource.home==='roster-fallback'
    ?'<span class="lineup-warn"> Home lineup unconfirmed — auto-updating</span>'
    :d.lineupSource&&d.lineupSource.home==='confirmed'
    ?'<span class="lineup-ok"> ✓ Home lineup confirmed</span>':'';
  var wA=d.lineupSource&&d.lineupSource.away==='roster-fallback'
    ?'<span class="lineup-warn"> Away lineup unconfirmed — auto-updating</span>'
    :d.lineupSource&&d.lineupSource.away==='confirmed'
    ?'<span class="lineup-ok"> ✓ Away lineup confirmed</span>':'';

  var wxLine=fmtWeatherLive(d);
  var sl0=scoreLine(d);
  document.getElementById('main-header').innerHTML=
    '<h2>'+(d.away&&d.away.name||'')+' @ '+(d.home&&d.home.name||'')+'</h2>'+
    '<p class="meta"><span id="game-status-line">'+fmtTime(d.gameTime)+' &nbsp;·&nbsp; '+(d.status||'Scheduled')+(sl0?' &nbsp;·&nbsp; <strong>'+sl0+'</strong>':'')+'</span>'+wA+wH+'</p>'+
    (wxLine?'<p class="meta" style="color:var(--ink-3);font-size:.72rem;margin-top:-2px">'+wxLine+'</p>':'')+
    '<div class="in-game-actions">'+
      '<button class="in-game-btn in-game-btn-hot" onclick="showNotable()">Notable Runs</button>'+
      '<button class="in-game-btn in-game-btn-cold" onclick="showSucks()">Who Sucks</button>'+
      '<button class="in-game-btn in-game-btn-bullpen" onclick="showBullpen()">Bullpen</button>'+
    '</div>';
  document.getElementById('tabs').style.display='flex';
  renderTable();

  // Inline due-up strip — load async, no spinner visible
  currentDueData=null;
  document.getElementById('due-inline').style.display='none';
  fetch('/api/games/'+pk+'/streaks').then(function(r){return r.json();}).then(function(d){
    currentDueData=d;
    renderDueInline(d);
  }).catch(function(){});
}


function switchTab(t){
  currentTab=t;
  document.querySelectorAll('.tab').forEach(function(el,i){el.classList.toggle('active',i===t);});
  renderTable();
}

function renderTable(){
  if(!currentData)return;
  var batters = currentTab===0
    ? (currentData.awayPitchingVsHome||[])
    : (currentData.homePitchingVsAway||[]);

  if(!batters.length){
    document.getElementById('table-wrap').innerHTML='<p style="color:var(--ink-3);padding:20px 0">No data available.</p>';
    return;
  }

  var pitcherMap={}, pitcherOrder=[];
  batters.forEach(function(b){
    b.pitchers.forEach(function(p){
      var pid=p.pitcher.id;
      if(!pitcherMap[pid]){ pitcherMap[pid]={pitcher:p.pitcher,entries:[]}; pitcherOrder.push(pid); }
      pitcherMap[pid].entries.push({batter:b.batter,bvp:p.bvp,matchupScore:p.matchupScore});
    });
  });
  var groups=pitcherOrder.map(function(pid){return pitcherMap[pid];});
  groups.sort(function(a,b){
    if(a.pitcher.role!==b.pitcher.role) return a.pitcher.role==='SP'?-1:1;
    return (a.pitcher.era||99)-(b.pitcher.era||99);
  });
  groups.forEach(function(g){
    g.entries.sort(function(x,y){ return sortDir*(getSortVal(x,sortCol)-getSortVal(y,sortCol)); });
  });

  var thead=
    '<tr>'+
    '<th class="th-group"></th>'+
    '<th class="th-group"></th>'+
    '<th class="th-group">Score</th>'+
    '<th class="th-group" colspan="7">— Career BvP —</th>'+
    '<th class="th-group" colspan="4">— BvP Rates —</th>'+
    '<th class="th-group" colspan="3">— BvP Slash —</th>'+
    '<th class="th-group" colspan="3">— Contact Quality —</th>'+
    '</tr>'+
    '<tr>'+
    th('lineup','#')+
    '<th class="p0">Batter</th>'+
    th('score','Score')+
    th('pa','PA')+th('ab','AB')+th('h','H')+th('doubles','2B')+th('triples','3B')+th('hr','HR')+th('rbi','RBI')+
    th('bso','SO')+th('kpct','K%')+th('bb','BB')+th('bbpct','BB%')+
    th('avg','AVG')+th('obp','OBP')+th('slg','SLG')+
    th('hh','HH%')+th('brl','Brl%')+th('babip','BABIP')+
    '</tr>';

  var DASH='<td><span class="no-hist">-</span></td>';
  var rows='';
  groups.forEach(function(g){
    var pit=g.pitcher;
    var roleLabel=pit.role==='SP'?'<span class="role-sp">SP</span>':'<span class="role-rp">RP</span>';
    var statParts=[];
    if(pit.era !=null) statParts.push('ERA '+parseFloat(pit.era).toFixed(2));
    if(pit.fip !=null) statParts.push('FIP '+parseFloat(pit.fip).toFixed(2));
    if(pit.whip!=null) statParts.push('WHIP '+parseFloat(pit.whip).toFixed(2));
    if(pit.ip  !=null) { const _f=Math.floor(pit.ip),_o=Math.round((pit.ip-_f)*3); statParts.push(_f+'.'+_o+' IP'); }
    if(pit.kpct!=null) statParts.push(pit.kpct+'% K');
    if(pit.hr9 !=null) statParts.push(pit.hr9.toFixed(1)+' HR/9');
    var stats=statParts.length?' &nbsp;<span style="font-weight:400;font-size:.7rem;color:var(--ink-3)">'+statParts.join(' · ')+'</span>':'';
    rows+='<tr class="pitcher-row"><td colspan="20">'+
      roleLabel+' <span style="margin-left:4px">'+pit.name+'</span>'+
      '<span style="font-weight:400;font-size:.7rem;color:var(--ink-3);margin-left:8px">'+pit.team+' · '+pit.hand+'HP</span>'+
      stats+'</td></tr>';

    g.entries.forEach(function(e){
      var bvp=e.bvp, sc=e.matchupScore;
      var scCls=sc>=7?'score-high':sc<=3?'score-low':'score-mid';
      var star=bvp&&bvp.smallSample&&!bvp.noHistory?'<span class="small-sample" title="< 10 AB">*</span>':'';
      var bvpCells=(!bvp||bvp.noHistory)
        ? DASH+DASH+DASH+DASH+DASH+DASH+DASH+DASH+DASH+DASH+DASH+DASH+DASH+DASH
        : '<td>'+na(bvp.pa)+'</td>'+
          '<td>'+na(bvp.ab)+'</td>'+
          '<td>'+na(bvp.h)+'</td>'+
          '<td>'+na(bvp.doubles)+'</td>'+
          '<td>'+na(bvp.triples)+'</td>'+
          '<td>'+na(bvp.hr)+'</td>'+
          '<td>'+na(bvp.rbi)+'</td>'+
          '<td>'+na(bvp.so)+'</td>'+
          '<td>'+pct(bvp.kpct)+'</td>'+
          '<td>'+na(bvp.bb)+'</td>'+
          '<td>'+pct(bvp.bbpct)+'</td>'+
          '<td>'+dec3(bvp.avg)+star+'</td>'+
          '<td>'+dec3(bvp.obp)+'</td>'+
          '<td>'+dec3(bvp.slg)+'</td>';
      var hh=e.batter.hardHitPct,brl=e.batter.barrelRate,bab=e.batter.babip;
      var hhCls=hh!=null&&hh>=44?'style="color:var(--pos)"':hh!=null&&hh<30?'style="color:var(--neg)"':'';
      var brlCls=brl!=null&&brl>=10?'style="color:var(--pos)"':brl!=null&&brl<=4?'style="color:var(--neg)"':'';
      var babCls=bab!=null&&bab<0.270?'style="color:var(--pos)"':bab!=null&&bab>0.330?'style="color:var(--warn)"':'';
      var contactCells=
        '<td '+(hhCls||'')+'>'+(hh!=null?Math.round(hh)+'%':'<span class="no-hist">-</span>')+'</td>'+
        '<td '+(brlCls||'')+'>'+(brl!=null?brl.toFixed(1)+'%':'<span class="no-hist">-</span>')+'</td>'+
        '<td '+(babCls||'')+'>'+(bab!=null?'.'+String(Math.round(bab*1000)).padStart(3,'0'):'<span class="no-hist">-</span>')+'</td>';
      var cv=e.batter.careerVenue;
      var venueTag='';
      if(cv&&cv.pa>=20&&(cv.hr>=2||cv.avg>=0.295)){
        var cvAvg='.'+String(Math.round(cv.avg*1000)).padStart(3,'0');
        var cvParts=(cv.hr>=2?cv.hr+' HR · ':'')+cvAvg+' avg ('+cv.pa+' career PA)';
        venueTag='<br><span style="font-size:.63rem;color:var(--ink-2);font-weight:500">'+cvParts+'</span>';
      }
      var yoyTag='';
      if(e.batter.yoyTrend){
        var yoy=e.batter.yoyTrend;
        var isReg=yoy.direction==='regression';
        var yoyColor=isReg?'var(--neg)':'var(--pos)';
        var yoyBg=isReg?'var(--neg-soft)':'var(--pos-soft)';
        var arrow=isReg?'↓':'↑';
        var wobaChg=Math.abs(yoy.wobaDelta);
        var label=arrow+' '+(isReg?'YoY decline':'YoY breakout')+' (wOBA '+yoy.wobaPrior+' → '+yoy.wobaCurr+')';
        yoyTag='<br><span style="font-family:var(--f-display);font-size:.58rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;background:'+yoyBg+';color:'+yoyColor+';border:1px solid '+yoyColor+'">'+label+'</span>';
      }
      var eliteTag='';
      if(e.batter.eliteSplit){
        var es=e.batter.eliteSplit;
        eliteTag='<br><span title="Top-'+es.rank+' hitter vs '+es.vsHand+'HP this season — facing a '+es.vsHand+'HP starter" style="font-family:var(--f-display);font-size:.58rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:2px 6px;background:var(--pos);color:var(--paper);border-radius:2px">★ ELITE vs '+es.vsHand+'HP &middot; '+es.ops.toFixed(3)+' OPS</span>';
      }
      var lineupSlot=e.batter.battingOrder!=null
        ?'<span class="lineup-slot" title="Confirmed lineup spot">'+e.batter.battingOrder+'</span>'
        :'<span class="no-hist">-</span>';
      rows+='<tr class="data-row">'+
        '<td>'+lineupSlot+'</td>'+
        '<td class="p0">'+e.batter.name+'<br><span style="font-size:.68rem;color:var(--ink-3)">'+e.batter.team+' · '+e.batter.hand+'HB'+(e.batter.woba!=null?' · <span style="color:var(--ink-2)">wOBA '+e.batter.woba+'</span>':'')+'</span>'+eliteTag+yoyTag+venueTag+'</td>'+
        '<td><span class="score-badge '+scCls+'">'+sc+'</span></td>'+
        bvpCells+contactCells+'</tr>';
    });
  });

  document.getElementById('table-wrap').innerHTML=
    '<div class="tbl-wrap"><table><thead>'+thead+'</thead><tbody>'+rows+'</tbody></table></div>'+
    '<p class="asterisk-note">* Fewer than 10 AB — small sample, treat with caution</p>';
}


function makeDueHitCard(e){
  var name=e.batter||e.name||'?';
  var avg='.'+String(Math.round(e.seasonAvg*1000)).padStart(3,'0');
  var tags=(e.factors||[]).map(function(f){
    return '<span class="rank-badge" style="background:var(--paper-2);color:var(--ink-2);border:1px solid var(--rule-2);margin-top:4px">'+f.text+'</span>';
  }).join('');
  var gameLine=e.game?'<div class="rank-meta" style="margin-top:1px">'+e.game+'</div>':'';
  return '<div class="rank-card rank-top" style="border-left-color:var(--ink-2)">'+
    '<div class="rank-header">'+
      '<span class="score-badge" style="background:var(--paper-2);color:var(--ink-2);border:1px solid var(--rule-2);font-size:.72rem;width:auto;padding:0 8px;border-radius:6px;height:auto;line-height:1.8">0-for-'+e.hitlessAbs+'</span>'+
      '<div>'+
        '<div class="rank-names">'+name+'</div>'+
        '<div class="rank-meta">'+e.team+' &nbsp;·&nbsp; avg '+avg+'</div>'+
        gameLine+
      '</div>'+
    '</div>'+
    '<div class="rank-desc">Going 0-for-'+e.hitlessAbs+' reduces their hit probability to '+Math.round(e.prob*100)+'% — well below a batter hitting '+avg+'.</div>'+
    (tags?'<div class="rank-badges">'+tags+'</div>':'')+
  '</div>';
}

function makeDueHrCard(e){
  var name=e.batter||e.name||'?';
  var tags=(e.factors||[]).map(function(f){
    return '<span class="rank-badge" style="background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);margin-top:4px">'+f.text+'</span>';
  }).join('');
  var gameLine=e.game?'<div class="rank-meta" style="margin-top:1px">'+e.game+'</div>':'';
  return '<div class="rank-card rank-top" style="border-left-color:var(--accent)">'+
    '<div class="rank-header">'+
      '<span class="score-badge" style="background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent);font-size:.72rem;width:auto;padding:0 8px;border-radius:6px;height:auto;line-height:1.8">'+e.multiple+'×</span>'+
      '<div>'+
        '<div class="rank-names">'+name+'</div>'+
        '<div class="rank-meta">'+e.team+' &nbsp;·&nbsp; 1 HR / '+e.expectedAbsPerHr+' AB</div>'+
        gameLine+
      '</div>'+
    '</div>'+
    '<div class="rank-desc">'+e.absSinceHr+' AB without a HR — '+e.multiple+'× expected rate. '+e.gamesSinceHr+' games since last home run.</div>'+
    (tags?'<div class="rank-badges">'+tags+'</div>':'')+
  '</div>';
}

function renderDueGrid(dueHit, dueHr, emptyMsg){
  return '<div class="rankings-grid" style="margin-top:12px">'+
    '<div class="rankings-col">'+
      '<h3 style="color:var(--ink-2);border-color:var(--rule-2)">Hit Drought</h3>'+
      (dueHit.length ? dueHit.map(makeDueHitCard).join('') : '<p style="color:var(--ink-2);font-size:.78rem">'+emptyMsg+'</p>')+
    '</div>'+
    '<div class="rankings-col">'+
      '<h3 style="color:var(--accent);border-color:var(--accent)">HR Drought</h3>'+
      (dueHr.length ? dueHr.map(makeDueHrCard).join('') : '<p style="color:var(--ink-2);font-size:.78rem">'+emptyMsg+'</p>')+
    '</div>'+
  '</div>';
}

function renderDueInline(data){
  var el=document.getElementById('due-inline');
  if(!data){el.style.display='none';return;}
  var dueHit=(data.dueHit||[]).slice(0,20);
  var dueHr =(data.dueHr ||[]).slice(0,20);
  if(!dueHit.length&&!dueHr.length){el.style.display='none';return;}
  var total=dueHit.length+dueHr.length;
  el.innerHTML=
    '<div class="acc-section-hdr" onclick="toggleDueInlineBody(this)" style="margin-bottom:0;padding:8px 2px">'+
      '<span id="due-inline-arrow" style="font-size:.6rem;color:var(--ink-3)">▶</span>'+
      '<span style="color:var(--ink-2)">Due Up</span>'+
      '<span style="font-size:.62rem;color:var(--ink-3);margin-left:auto">'+total+' player'+(total!==1?'s':'')+' &nbsp;·&nbsp; click to expand</span>'+
    '</div>'+
    '<div id="due-inline-body" style="display:none">'+renderDueGrid(dueHit,dueHr,'No batters qualify for this game.')+'</div>';
  el.style.display='block';
}

function toggleDueInlineBody(hdr){
  var body=document.getElementById('due-inline-body');
  var arrow=document.getElementById('due-inline-arrow');
  var open=body.style.display==='none';
  body.style.display=open?'block':'none';
  if(arrow) arrow.textContent=open?'▼':'▶';
}

function renderStreakPanel(entries, panelId, title, accentColor, flagVar){
  var panel=document.getElementById(panelId);
  if(!entries||!entries.length){
    panel.innerHTML='<p style="color:var(--ink-2);font-size:.78rem;padding:4px 0">Nothing notable for this game right now.</p>';
    return;
  }
  var cards=entries.map(function(e){
    var tagHtml=e.tags.map(function(t){
      var cls=t.cls==='fire'?'streak-tag-fire':t.cls==='ice'?'streak-tag-ice':'streak-tag-neutral';
      return '<span class="streak-tag '+cls+'">'+t.text+'</span>';
    }).join('');
    var typeLabel=e.type==='batter'?'Batter':e.type==='pitcher'?'Pitcher':'Team';
    return '<div class="streak-card">'+
      '<div class="streak-name">'+(e.emoji?e.emoji+' ':'')+e.name+'</div>'+
      '<div class="streak-meta">'+e.team+' &nbsp;·&nbsp; '+typeLabel+'</div>'+
      '<div class="streak-tags">'+tagHtml+'</div>'+
      '</div>';
  }).join('');
  panel.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'+
      '<span style="font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:'+accentColor+'">'+title+'</span>'+
      '<button onclick="'+flagVar+'()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+
    '<div class="streak-grid">'+cards+'</div>';
}

function showNotable(){
  var panel=document.getElementById('streaks-hot-panel');
  if(notableVisible){panel.style.display='none';notableVisible=false;return;}
  notableVisible=true;panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading...</p>';
  fetch('/api/games/'+currentGamePk+'/streaks').then(function(r){return r.json();}).then(function(d){
    renderStreakPanel(d.notable,'streaks-hot-panel','Notable Runs','var(--accent)','showNotable');
  }).catch(function(){
    panel.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load streak data.</p>';
  });
}

function showSucks(){
  var panel=document.getElementById('streaks-cold-panel');
  if(sucksVisible){panel.style.display='none';sucksVisible=false;return;}
  sucksVisible=true;panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading...</p>';
  fetch('/api/games/'+currentGamePk+'/streaks').then(function(r){return r.json();}).then(function(d){
    renderStreakPanel(d.sucks,'streaks-cold-panel','Who Sucks','var(--ink-2)','showSucks');
  }).catch(function(){
    panel.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load streak data.</p>';
  });
}

function showDue(){
  var panel=document.getElementById('due-panel');
  if(dueVisible){panel.style.display='none';dueVisible=false;return;}
  dueVisible=true;panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading...</p>';
  fetch('/api/games/'+currentGamePk+'/streaks').then(function(r){return r.json();}).then(renderDuePanel).catch(function(){
    panel.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load due-up data.</p>';
  });
}

function renderDuePanel(data){
  var panel=document.getElementById('due-panel');
  var dueHit=data.dueHit||[];
  var dueHr=data.dueHr||[];
  if(!dueHit.length&&!dueHr.length){
    panel.innerHTML='<p style="color:var(--ink-2);font-size:.78rem;padding:4px 0">No statistically overdue batters for this game.</p>';
    return;
  }

  function pct(p){ return Math.round(p*100)+'%'; }
  function tagHtml(tags){
    return tags.map(function(t){ return '<span class="streak-tag '+t.cls+'">'+t.text+'</span>'; }).join('');
  }

  var html='<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'+
    '<span style="font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)">Due Up</span>'+
    '<button onclick="showDue()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
  '</div>';

  // ── Hit Drought section ──
  if(dueHit.length){
    html+='<div style="font-size:.65rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);margin-bottom:8px">Hit Drought</div>'+
      '<div class="streak-grid">';
    dueHit.forEach(function(e){
      var probPct=pct(e.prob);
      var name=e.batter||e.name||'?';
      html+='<div class="streak-card">'+
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'+
          '<span style="font-size:.72rem;font-weight:700;color:var(--ink)">'+name+'</span>'+
          '<span style="font-size:.65rem;color:var(--ink-3)">'+e.team+'</span>'+
        '</div>'+
        '<div style="font-size:.78rem;color:var(--neg);font-weight:600;margin-bottom:4px">'+
          '0-for-'+e.hitlessAbs+' &nbsp;·&nbsp; <span style="color:var(--ink-3);font-weight:400">'+probPct+' likely</span>'+
        '</div>'+
        '<div style="font-size:.65rem;color:var(--ink-3);margin-bottom:6px">Season avg: .'+String(Math.round(e.seasonAvg*1000)).padStart(3,'0')+'</div>'+
        (e.factors.length?'<div class="streak-tags">'+tagHtml(e.factors)+'</div>':'')+
      '</div>';
    });
    html+='</div>';
  }

  // ── HR Drought section ──
  if(dueHr.length){
    html+='<div style="font-size:.65rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:8px;'+(dueHit.length?'margin-top:18px':'')+'">HR Drought</div>'+
      '<div class="streak-grid">';
    dueHr.forEach(function(e){
      var name=e.batter||e.name||'?';
      html+='<div class="streak-card">'+
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">'+
          '<span style="font-size:.72rem;font-weight:700;color:var(--ink)">'+name+'</span>'+
          '<span style="font-size:.65rem;color:var(--ink-3)">'+e.team+'</span>'+
        '</div>'+
        '<div style="font-size:.78rem;color:var(--accent);font-weight:600;margin-bottom:4px">'+
          e.absSinceHr+' AB without HR &nbsp;·&nbsp; <span style="color:var(--ink-3);font-weight:400">'+e.multiple+'× expected</span>'+
        '</div>'+
        '<div style="font-size:.65rem;color:var(--ink-3);margin-bottom:6px">Expected 1 HR / '+e.expectedAbsPerHr+' AB &nbsp;·&nbsp; '+e.gamesSinceHr+' games</div>'+
        (e.factors.length?'<div class="streak-tags">'+tagHtml(e.factors)+'</div>':'')+
      '</div>';
    });
    html+='</div>';
  }

  panel.innerHTML=html;
}

function showBullpen(){
  var panel=document.getElementById('bullpen-panel');
  if(bullpenVisible){panel.style.display='none';bullpenVisible=false;return;}
  bullpenVisible=true;panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading bullpen data...</p>';
  fetch('/api/games/'+currentGamePk+'/bullpen').then(function(r){return r.json();}).then(renderBullpen).catch(function(){
    panel.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load bullpen data.</p>';
  });
}

function renderBullpen(data){
  var panel=document.getElementById('bullpen-panel');

  function roleBadge(role){
    var cls=role==='Closer'?'bp-role-closer':role==='Setup'?'bp-role-setup':'bp-role-middle';
    return '<span class="bp-role '+cls+'">'+role.toUpperCase()+'</span>';
  }
  function scoreClass(s){ return s>=7?'bp-matchup-score-hi':s>=4?'bp-matchup-score-mid':'bp-matchup-score-lo'; }
  function opsColor(ops){ return ops>=0.800?'var(--neg)':ops<=0.600?'var(--pos)':'var(--warn)'; }

  function renderTeam(side){
    if(!side||!side.relievers||!side.relievers.length)
      return '<p style="color:var(--ink-3);font-size:.75rem">No reliever data available.</p>';

    var html='<div class="bp-team-hdr">'+side.name+' Bullpen</div>';
    for(var i=0;i<side.relievers.length;i++){
      var rp=side.relievers[i];
      var era=rp.era!=null?rp.era.toFixed(2):'—';
      var whip=rp.whip!=null?rp.whip.toFixed(2):'—';
      var kpct=rp.kpct!=null?rp.kpct+'%':'—';
      var restBadge=rp.restClass
        ?'<span class="bp-rest '+rp.restClass+'">'+rp.restStatus+'</span>':
         '<span style="font-size:.65rem;color:var(--ink-2)">'+rp.restStatus+'</span>';
      var saveLine=rp.role==='Closer'?' · '+rp.saves+'SV/'+rp.saveOpps+'OPP'
        :rp.holds>=1?' · '+rp.holds+'HLD':'';
      var g7note=rp.g7>=3?' · '+rp.g7+'G last 7d':'';
      var p3note=rp.pitches3>=15?' · '+rp.pitches3+'P/3d':'';

      html+='<div class="bp-card">'+
        '<div class="bp-card-top">'+
          roleBadge(rp.role)+
          '<span class="bp-name">'+rp.name+' ('+rp.hand+'H)</span>'+
          restBadge+
        '</div>'+
        '<div class="bp-stats">ERA '+era+' &nbsp;·&nbsp; WHIP '+whip+' &nbsp;·&nbsp; K% '+kpct+saveLine+g7note+p3note+'</div>';

      if(rp.matchups&&rp.matchups.length){
        html+='<div class="bp-matchups"><div style="font-size:.62rem;color:var(--ink-2);margin-bottom:3px;letter-spacing:.04em">BvP vs lineup (≥3 AB)</div>';
        for(var j=0;j<rp.matchups.length;j++){
          var m=rp.matchups[j];
          var ops=m.bvpOps!=null?m.bvpOps.toFixed(3):'—';
          html+='<div class="bp-matchup-row">'+
            '<span class="bp-matchup-name">'+m.batter+'</span>'+
            '<span class="bp-matchup-ab">'+m.bvpAb+'AB</span>'+
            '<span class="bp-matchup-score '+scoreClass(m.score)+'">'+m.score+'/10</span>'+
            '<span style="font-size:.65rem;font-weight:600;color:'+opsColor(m.bvpOps)+'">'+ops+' OPS</span>'+
          '</div>';
        }
        html+='</div>';
      }
      html+='</div>';
    }
    return html;
  }

  panel.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'+
      '<span style="font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">Bullpen Report</span>'+
      '<button onclick="showBullpen()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+
    '<div class="bp-grid">'+
      '<div>'+renderTeam(data.away)+'</div>'+
      '<div>'+renderTeam(data.home)+'</div>'+
    '</div>';
}

function showProbables(){
  var was=probablesVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  probablesVisible=true; setActiveNav('nav-probables');
  var panel=document.getElementById('probables-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading probables...</p>';
  // DEMO MODE (?demo=1): swaps in the static /demo-probables.json INSTEAD of the API —
  // pure client-side, never touches the model, the API, or any saved prediction file.
  // Built (All-Star break, no games) to preview the UI. Remove by deleting
  // demo-probables.json; without ?demo=1 in the URL this branch is completely inert.
  var demoMode=/[?&]demo=1/.test(location.search);
  // Calibration summary fetched in parallel (cheap, file-backed) — feeds the honest
  // per-category hit-rate chips on accordion headers. Best-effort: render proceeds
  // without it if it fails.
  Promise.all([
    fetch(demoMode?'/demo-probables.json':'/api/probables').then(function(r){return r.json();}),
    fetch('/api/calibration-summary').then(function(r){return r.json();}).catch(function(){return null;}),
  ]).then(function(rs){
    window._calRates=(rs[1]&&rs[1].rates)||null;
    window._calWindow=(rs[1]&&rs[1].windowDays)||0;
    renderProbables(rs[0]);
  }).catch(function(){
    panel.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load probables.</p>';
  });
}

// Consolidated-nav dropdowns : plain click-toggle; selecting an item or
// clicking anywhere else closes the menu.
function toggleNavMenu(btn){
  var menu=btn.nextElementSibling;
  var opening=!menu.classList.contains('open');
  document.querySelectorAll('.nav-menu.open').forEach(function(m){ m.classList.remove('open'); });
  if(opening) menu.classList.add('open');
}
document.addEventListener('click', function(ev){
  // close when clicking outside any group, OR after choosing an item inside a menu
  var inGroup=ev.target.closest('.nav-group');
  var inMenu=ev.target.closest('.nav-menu');
  if(!inGroup || inMenu){
    document.querySelectorAll('.nav-menu.open').forEach(function(m){ m.classList.remove('open'); });
  }
});

function toggleProbAcc(hdr){
  var body=hdr.nextElementSibling;
  var arrow=hdr.querySelector('.prob-acc-arrow');
  var opening=!body.classList.contains('open');
  body.classList.toggle('open',opening);
  arrow.classList.toggle('open',opening);
  hdr.classList.toggle('open',opening);
}

// Every accordion section now starts CLOSED on each render (user request) so the
// Probables/Actionables panels open as a clean, scrollable list of headers — expand only what
// you want. Replaces the earlier "remember open/closed per section" persistence, which caused
// previously-opened sections (and the always-open Today's Best) to reappear expanded on load.
function applyAccMemory(_panel){ /* no-op — sections default closed, see note above */ }

function streakAcc(badgeCls, badgeLabel, title, items, valueFmt, valueColor) {
  if (!items || !items.length) return '';
  var cards = items.map(function(e) {
    return '<div class="prob-card">' +
      '<span class="prob-badge ' + badgeCls + '">' + badgeLabel + '</span>' +
      '<div class="prob-body">' +
        '<div class="prob-player">' + e.batter + ' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">' + e.team + '</span></div>' +
        '<div class="prob-detail">' + e.game + '</div>' +
      '</div>' +
      '<div style="font-size:.88rem;font-weight:700;color:' + valueColor + ';flex-shrink:0;text-align:right">' + valueFmt(e) + '</div>' +
    '</div>';
  }).join('');
  return '<div>' +
    '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">' +
      '<span class="prob-acc-arrow">▶</span>' +
      '<span class="prob-badge ' + badgeCls + '" style="pointer-events:none">' + badgeLabel + '</span>' +
      '<span class="prob-acc-title">' + title + '</span>' +
      '<span class="prob-acc-count">' + items.length + '</span>' +
    '</div>' +
    '<div class="prob-acc-body">' + cards + '</div>' +
  '</div>';
}

function projKAcc(items) {
  if (!items || !items.length) return '';
  var cards = items.map(function(e) {
    var relNote = e.reliability === 'medium'
      ? '<div class="prob-detail" style="color:var(--ink-2)">Medium reliability · directional projection, not a precise line — best used as over/under lean vs a posted total, not a standalone bet</div>'
      : '';
    return '<div class="prob-card">' +
      '<span class="prob-badge prob-badge-k">PROJ K</span>' +
      '<div class="prob-body">' +
        '<div class="prob-player">' + e.pitcher + ' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">' + e.team + '</span></div>' +
        '<div class="prob-detail">vs ' + e.opponent + ' &nbsp;·&nbsp; ' + e.game + '</div>' +
        '<div class="prob-detail" style="color:var(--ink-2)">' + e.note + '</div>' +
        relNote +
      '</div>' +
      '<div style="font-size:1.1rem;font-weight:900;color:var(--accent);flex-shrink:0;text-align:right">' + e.projK.toFixed(1) + '</div>' +
    '</div>';
  }).join('');
  return '<div>' +
    '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">' +
      '<span class="prob-acc-arrow">▶</span>' +
      '<span class="prob-badge prob-badge-k" style="pointer-events:none">PROJ K</span>' +
      '<span class="prob-acc-title">Projected Strikeouts (SP)</span>' +
      '<span class="prob-acc-count">' + items.length + '</span>' +
    '</div>' +
    '<div class="prob-acc-body">' + cards + '</div>' +
  '</div>';
}

function renderProbables(data){
  var panel=document.getElementById('probables-panel');
  if(!data.gamesLoaded){
    panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">No games preloaded yet — try again in a moment.</p>';
    return;
  }
  var progressNote='';
  if(data._demo){
    progressNote+='<div style="margin-bottom:12px;padding:8px 12px;border:2px solid var(--warn);background:var(--warn-soft);font-family:var(--f-display);font-size:.72rem;font-weight:800;letter-spacing:.08em;color:var(--warn)">⚠ DEMO MODE — SAMPLE DATA FOR UI PREVIEW ONLY. These are not real picks, players, or odds. Remove ?demo=1 from the URL for live data.</div>';
  }
  if(data.gamesLoaded < games.length){
    progressNote='<p style="color:var(--warn);font-size:.73rem;margin-bottom:12px">'+
      data.gamesLoaded+' of '+games.length+' games ready. '+
      '<span style="cursor:pointer;text-decoration:underline" onclick="showProbables();showProbables()">Refresh</span></p>';
  }

  // kMulti is a filtered VIEW of the k (1+ K) array (see probabilities.js) —.prob on
  // those objects is still the P(K>=1) rate; the real P(K>=2) is.kTwoProb. Remap once
  // here so every downstream use (the K2+ accordion below, and the Top Market Edges
  // board) displays/compares the correct probability instead of the 1+ rate.
  data.kMulti = (data.kMulti||[]).map(function(e){
    return e.kTwoProb!=null ? Object.assign({}, e, {prob: e.kTwoProb}) : e;
  });

  function propMarketLine(){ return ''; }  // no market layer in this build

  function card(e, badgeCls, badgeLabel, pctCls){
    var strongTag=e.strong
      ? '<span title="High-conviction play (clears the strong-play bar)" style="display:inline-block;margin-left:6px;font-family:var(--f-display);font-size:.54rem;font-weight:800;letter-spacing:.05em;color:var(--pos);border:1px solid var(--pos);border-radius:3px;padding:1px 4px;vertical-align:middle">★ STRONG</span>'
      : '';
    var warnTag=e.weatherWarn==='wind-in'
      ? '<span title="Wind now blowing in — conditions worsened since prediction was frozen" style="display:inline-block;margin-left:6px;font-size:.54rem;font-weight:700;color:var(--warn)">⚠ wind-in</span>'
      : '';
    var predTag=e.predictedLeadoff
      ? '<span title="Lineup not confirmed yet — leadoff slot projected from recent lineup history" style="display:inline-block;margin-left:6px;font-family:var(--f-display);font-size:.54rem;font-weight:700;letter-spacing:.05em;color:var(--warn);border:1px solid var(--warn);border-radius:3px;padding:1px 4px;vertical-align:middle">PREDICTED</span>'
      : '';
    return '<div class="prob-card">'+
      '<span class="prob-badge '+badgeCls+'">'+badgeLabel+'</span>'+
      '<div class="prob-body">'+
        '<div class="prob-player">'+e.batter+' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">'+e.team+'</span>'+strongTag+warnTag+predTag+'</div>'+
        '<div class="prob-detail">'+e.stat+' &nbsp;·&nbsp; vs '+e.pitcher+' &nbsp;·&nbsp; '+e.game+'</div>'+
        '<div class="prob-detail" style="color:var(--ink-2)">'+e.sampleNote+'</div>'+
        propMarketLine(e.market)+
      '</div>'+
      '<div class="prob-pct '+pctCls+'">'+(e.prob*100).toFixed(0)+'%</div>'+
    '</div>';
  }

  // accLive: weather-surfaced HR candidates only — never frozen, never graded.
  // Rendered inline (not via card) so the wind/temp line can be appended per entry.
  function accLive(badgeCls, badgeLabel, title, items, pctFn){
    if(!items.length) return '';
    var cards=items.map(function(e){
      var wx=e.weatherCtx||{};
      var windStr=wx.windLabel||(wx.outWindMph!=null&&wx.outWindMph>0?wx.outWindMph.toFixed(0)+' mph out':'');
      var tempStr=wx.tempF!=null?Math.round(wx.tempF)+'°F':'';
      var wxParts=[windStr,tempStr].filter(Boolean);
      var wxLine=wxParts.length
        ?'<div style="font-size:.60rem;color:'+windColor(wx.outWindMph)+';margin-top:2px;letter-spacing:.02em">⛅ '+wxParts.join(' · ')+' — weather surfaced</div>'
        :'';
      var pctCls=pctFn(e.prob);
      return '<div class="prob-card">'+
        '<span class="prob-badge '+badgeCls+'" style="opacity:.85">'+badgeLabel+'</span>'+
        '<div class="prob-body">'+
          '<div class="prob-player">'+e.batter+' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">'+e.team+'</span></div>'+
          '<div class="prob-detail">'+e.stat+' &nbsp;·&nbsp; vs '+e.pitcher+' &nbsp;·&nbsp; '+e.game+'</div>'+
          wxLine+
        '</div>'+
        '<div class="prob-pct '+pctCls+'">'+(e.prob*100).toFixed(0)+'%</div>'+
      '</div>';
    }).join('');
    return '<div>'+
      '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow">▶</span>'+
        '<span class="prob-badge '+badgeCls+'" style="pointer-events:none;opacity:.85">'+badgeLabel+'</span>'+
        '<span class="prob-acc-title">'+title+'</span>'+
        '<span class="prob-acc-count">'+items.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+cards+'</div>'+
    '</div>';
  }

  // Honest per-category realized hit rate over the trailing window (from
  // /api/calibration-summary), shown quietly on each header — real disclosure that also
  // teaches which categories to trust. Label → graded-category key.
  var LABEL_CAT = { 'HIT':'hit','HIT-':'cold','XBH':'tb','2+TB':'tb2','HR+':'hrp','HR-':'hrm',
    'RUN+':'runsOver','RUN-':'runsUnder','RBI+':'rbiOver','RBI-':'rbiUnder','BB':'walk',
    'SB':'sb','BB-':'bbUnder','K':'k','K-':'kUnder','K2+':'kMulti','K7':'recentK','K🎯':'kAutoOut' };
  function rateChip(badgeLabel){
    var cat=LABEL_CAT[badgeLabel];
    var r=cat&&window._calRates&&window._calRates[cat];
    if(!r||r.n<30) return '';
    return '<span style="font-size:.6rem;color:var(--ink-3);margin-left:8px;white-space:nowrap">'+
      (r.hitRate*100).toFixed(0)+'% hit · '+(window._calWindow||14)+'d</span>';
  }
  function acc(badgeCls, badgeLabel, title, items, pctFn){
    if(!items.length) return '';
    return '<div>'+
      '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow">▶</span>'+
        '<span class="prob-badge '+badgeCls+'" style="pointer-events:none">'+badgeLabel+'</span>'+
        '<span class="prob-acc-title">'+title+'</span>'+rateChip(badgeLabel)+
        '<span class="prob-acc-count">'+items.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+
        items.map(function(e){ return card(e, badgeCls, badgeLabel, pctFn(e.prob)); }).join('')+
      '</div>'+
    '</div>';
  }

  var header=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'+
      '<span style="font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">'+
        'Probables &nbsp;·&nbsp; '+data.gamesLoaded+' game'+(data.gamesLoaded!==1?'s':'')+' loaded'+
      '</span>'+
      '<button onclick="showProbables()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>';

  var hi=function(p){ return p>=0.85?'prob-pct-high':'prob-pct-mid'; };
  var lo=function(p){ return p<=0.60?'prob-pct-cold':'prob-pct-mid'; };

  var calDays=data.calibrationDays||0;
  var calFactors=data.correctionFactors||{};
  var activeCorr=Object.entries(calFactors).filter(function(kv){return Math.abs(kv[1]-1.0)>0.03;});
  var calNote='';
  if(calDays===0){
    calNote='<div style="font-size:.67rem;color:var(--ink-2);margin-bottom:10px">No calibration history yet — run Accuracy Check on past dates to train the model.</div>';
  } else {
    var corrBadges=activeCorr.map(function(kv){
      var pct=Math.round((kv[1]-1)*100);
      var col=kv[1]>1.05?'var(--pos)':kv[1]<0.95?'var(--neg)':'var(--warn)';
      return '<span style="background:var(--paper-3);border:1px solid var(--paper-3);border-radius:3px;padding:1px 5px;font-size:.60rem;font-weight:700;color:'+col+'">'+(kv[0].toUpperCase())+(pct>=0?'+':'')+pct+'%</span>';
    }).join(' ');
    calNote='<div style="font-size:.67rem;color:var(--ink-3);margin-bottom:10px">'+calDays+' day'+(calDays!==1?'s':'')+' calibrated'+
      (activeCorr.length?' &nbsp;·&nbsp; Corrections: '+corrBadges:' &nbsp;·&nbsp; Model well-calibrated, no corrections')+
    '</div>';
  }

  function lockAcc(items){
    if(!items.length) return '';
    var body=items.map(function(e){
      return '<div class="prob-card prob-card-lock">'+
        '<span class="prob-badge prob-badge-lock">'+e.lockLabel+'</span>'+
        '<div class="prob-body">'+
          '<div class="prob-player">'+e.batter+' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">'+e.team+'</span></div>'+
          '<div class="prob-detail">'+e.stat+' &nbsp;·&nbsp; vs '+e.pitcher+' &nbsp;·&nbsp; '+e.game+'</div>'+
          '<div class="prob-detail" style="color:var(--ink-2)">'+e.sampleNote+'</div>'+
        '</div>'+
        '<div class="prob-pct prob-pct-high">'+(e.prob*100).toFixed(0)+'%</div>'+
      '</div>';
    }).join('');
    return '<div>'+
      '<div class="prob-acc-hdr prob-acc-lock" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow" style="color:var(--warn)">▶</span>'+
        '<span class="prob-badge prob-badge-lock" style="pointer-events:none">LOCKS</span>'+
        '<span class="prob-acc-title" style="color:var(--warn)">90%+ Confidence</span>'+
        '<span class="prob-acc-count">'+items.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+body+'</div>'+
    '</div>';
  }

  // Leadoff Run Combo — groups of leadoff-type hitters whose COMBINED runs total is the
  // bet (request). Bespoke renderer since the data shape (groups of players,
  // not one prop per player) doesn't fit the generic acc/card helpers.
  // Generic squad-combo renderer — used for both the runs combo and the hits combo
  //, same grouping/math, different underlying stat. unitLabel is the noun
  // shown after the projected total ("runs" / "hits"); title/badgeText/badgeCls style
  // the accordion header per category.
  function squadComboAcc(groups, opts){
    if(!groups || !groups.length) return '';
    var unitLabel=opts.unitLabel, title=opts.title, badgeText=opts.badgeText, badgeCls=opts.badgeCls||'prob-badge-runs-over';
    var body=groups.map(function(g){
      var players=g.players.map(function(p){
        var tag=p.confirmed
          ? '<span style="color:var(--pos);font-size:.62rem;font-weight:700">CONFIRMED</span>'
          : '<span style="color:var(--warn);font-size:.62rem;font-weight:700">PREDICTED'+(p.predictionConfidence?' · '+p.predictionConfidence.toUpperCase():'')+'</span>';
        var cyOldTag=p.cyOld?' <span style="color:var(--accent);font-size:.6rem;font-weight:700;border:1px solid var(--accent);padding:1px 5px;border-radius:2px">CY OLD START</span>':'';
        return '<div class="prob-detail" style="display:flex;justify-content:space-between;gap:8px;padding:2px 0">'+
          '<span>'+p.batter+' <span style="color:var(--ink-3)">'+p.team+'</span> vs '+p.pitcher+cyOldTag+'</span>'+
          '<span>'+tag+' <span style="color:var(--ink-2)">'+Math.round(p.prob*100)+'%</span></span>'+
        '</div>';
      }).join('');
      var riskNote=g.lineupRisk
        ? '<div class="prob-detail" style="color:var(--warn);margin-top:4px">'+(g.players.length-g.confirmedCount)+' of '+g.players.length+' not yet lineup-confirmed — real lineup risk until posted.</div>'
        : '<div class="prob-detail" style="color:var(--pos);margin-top:4px">All '+g.players.length+' lineup-confirmed.</div>';
      return '<div class="prob-card" style="flex-direction:column;align-items:stretch;gap:6px">'+
        '<div style="display:flex;justify-content:space-between;align-items:baseline">'+
          '<span class="prob-badge '+badgeCls+'">TIER '+g.tier+'</span>'+
          '<span style="font-size:.9rem;font-weight:900">Proj '+g.projTotal+' '+unitLabel+' &nbsp;·&nbsp; Line '+g.line+' &nbsp;·&nbsp; Over '+Math.round(g.over*100)+'%</span>'+
        '</div>'+
        players+
        riskNote+
      '</div>';
    }).join('');
    return '<div>'+
      '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow">▶</span>'+
        '<span class="prob-badge '+badgeCls+'" style="pointer-events:none">'+badgeText+'</span>'+
        '<span class="prob-acc-title">'+title+'</span>'+
        '<span class="prob-acc-count">'+groups.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+body+'</div>'+
    '</div>';
  }
  function leadoffComboAcc(groups){
    return squadComboAcc(groups, { unitLabel: 'runs', title: 'Leadoff Run Combo (8-player groups)', badgeText: 'COMBO', badgeCls: 'prob-badge-runs-over' });
  }
  function hitsComboAcc(groups){
    return squadComboAcc(groups, { unitLabel: 'hits', title: 'Multi-Hit Squad Combo (8-player groups)', badgeText: 'COMBO', badgeCls: 'prob-badge-hit' });
  }

  // Cross-category "top edges" board — pulls from every category with a DK line
  // attached via attachPropEdge (hit/hrp/tb2 plus rbiOver/rbiUnder/runsOver/runsUnder/
  // walk/bbUnder/k/kMulti/sb), tags each with its origin category's existing badge, and
  // surfaces the best ones in one place instead of making you dig through every category
  // to spot a good price. Same +4pt threshold as the inline "+EV" tag in propMarketLine
  // above, for consistency. hrm/kUnder are deliberately excluded — those categories never
  // prices, so a naive complement wouldn't be a fair edge comparison).
  var EDGE_CATS = ['hit','hrp','tb2','rbiOver','rbiUnder','runsOver','runsUnder','walk','bbUnder','k','kMulti','sb'];
  var EDGE_CAT_BADGE = {
    hit: ['prob-badge-hit','HIT'], hrp: ['prob-badge-hrp','HR+'], tb2: ['prob-badge-tb2','2+TB'],
    rbiOver: ['prob-badge-rbi-over','RBI+'], rbiUnder: ['prob-badge-rbi-under','RBI-'],
    runsOver: ['prob-badge-runs-over','RUN+'], runsUnder: ['prob-badge-runs-under','RUN-'],
    walk: ['prob-badge-walk','BB'], bbUnder: ['prob-badge-bb-under','BB-'],
    k: ['prob-badge-k','K'], kMulti: ['prob-badge-k','K2+'], sb: ['prob-badge-sb','SB'],
  };
  function taggedCat(arr, cat){ return (arr||[]).map(function(e){ return Object.assign({_cat:cat}, e); }); }

  // Lineup-surprise props: batter/category pairs that showed up AFTER today's slate
  // already locked in — a late lineup change, a catcher swap, a scratched starter
  // replaced by someone else, etc. Never fed into the accuracy checker (see
  // getLineupSurpriseProps in lib/accuracy.js — read-only diff against the frozen file),
  // same guarantee as the HR+⛅ weather-live section above. Covers all 15 graded
  // categories (unlike EDGE_CAT_BADGE, which only covers the market-edge subset).
  var LINEUP_SURPRISE_BADGE = {
    hit: ['prob-badge-hit','HIT'], k: ['prob-badge-k','K'], cold: ['prob-badge-cold','HIT-'],
    hrp: ['prob-badge-hrp','HR+'], hrm: ['prob-badge-hrm','HR-'], tb: ['prob-badge-tb','XBH'],
    tb2: ['prob-badge-tb2','2+TB'], walk: ['prob-badge-walk','BB'],
    rbiOver: ['prob-badge-rbi-over','RBI+'], rbiUnder: ['prob-badge-rbi-under','RBI-'],
    runsOver: ['prob-badge-runs-over','RUN+'], runsUnder: ['prob-badge-runs-under','RUN-'],
    sb: ['prob-badge-sb','SB'], bbUnder: ['prob-badge-bb-under','BB-'], kUnder: ['prob-badge-k-under','K-'],
  };
  function lineupSurpriseAcc(items){
    if(!items.length) return '';
    var body=items.map(function(e){
      var b=LINEUP_SURPRISE_BADGE[e._cat]||['prob-badge-hit','?'];
      var pctCls=e.prob>=0.55?'prob-pct-high':'prob-pct-mid';
      return card(e, b[0], b[1], pctCls);
    }).join('');
    return '<div>'+
      '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow" style="color:var(--warn)">▶</span>'+
        '<span class="prob-badge" style="pointer-events:none;background:var(--warn-soft, rgba(230,160,40,.15));color:var(--warn);border:1px solid var(--warn)">🔄</span>'+
        '<span class="prob-acc-title" style="color:var(--warn)">Lineup Surprise · Not Graded</span>'+
        '<span class="prob-acc-count">'+items.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+body+'</div>'+
    '</div>';
  }

  function vsTeamAcc(items){
    if(!items.length) return '';
    var cards=items.map(function(e){
      var scCls=e.matchupScore>=7?'score-high':e.matchupScore<=3?'score-low':'score-mid';
      var rate=(e.hrPerGame).toFixed(2);
      var per=e.hrPerGame>0?'1 HR per '+(1/e.hrPerGame).toFixed(1)+'G':'—';
      return '<div class="prob-card">'+
        '<span class="prob-badge prob-badge-hrp">VS TEAM</span>'+
        '<div class="prob-body">'+
          '<div class="prob-player">'+e.batter+' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">'+e.team+'</span>'+
            ' <span class="score-badge '+scCls+'" style="font-size:.60rem;padding:1px 5px;margin-left:4px">'+e.matchupScore+'</span>'+
          '</div>'+
          '<div class="prob-detail">'+e.vsTeamHr+' HR in '+e.vsTeamG+'G vs '+e.opposingTeamAbbrev+
            ' &nbsp;·&nbsp; vs '+e.pitcher+' &nbsp;·&nbsp; '+e.game+'</div>'+
          '<div class="prob-detail" style="color:var(--ink-2)">'+per+'</div>'+
        '</div>'+
        '<div class="prob-pct prob-pct-high" style="font-size:.72rem;white-space:nowrap">'+rate+'/G</div>'+
      '</div>';
    }).join('');
    return '<div>'+
      '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow">▶</span>'+
        '<span class="prob-badge prob-badge-hrp" style="pointer-events:none">VS TEAM</span>'+
        '<span class="prob-acc-title">Career HR vs Opponent</span>'+
        '<span class="prob-acc-count">'+items.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+cards+'</div>'+
    '</div>';
  }

  // "Owns this team" — deliberately raw career numbers, no model score/matchup gate.
  // Just AVG/OPS/HR/RBI against the opposing FRANCHISE, at a real sample size (>=20 AB).
  function vsTeamCareerAcc(items){
    if(!items.length) return '';
    var cards=items.map(function(e){
      var avgStr='.'+String(Math.round(e.vsTeamAvg*1000)).padStart(3,'0');
      var opsStr='.'+String(Math.round(e.vsTeamOps*1000)).padStart(3,'0');
      return '<div class="prob-card">'+
        '<span class="prob-badge prob-badge-hrp">OWNS</span>'+
        '<div class="prob-body">'+
          '<div class="prob-player">'+e.batter+' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">'+e.team+'</span></div>'+
          '<div class="prob-detail">'+avgStr+'/'+opsStr+' OPS vs '+e.opposingTeamAbbrev+
            ' &nbsp;·&nbsp; '+e.vsTeamH+'H, '+e.vsTeamHrCount+'HR, '+e.vsTeamRbi+'RBI in '+e.vsTeamAb+' career AB ('+e.vsTeamG+'G)</div>'+
          '<div class="prob-detail" style="color:var(--ink-2)">Tonight vs '+e.pitcher+' &nbsp;·&nbsp; '+e.game+'</div>'+
        '</div>'+
        '<div class="prob-pct prob-pct-high" style="font-size:.72rem;white-space:nowrap">'+opsStr+'</div>'+
      '</div>';
    }).join('');
    return '<div>'+
      '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow">▶</span>'+
        '<span class="prob-badge prob-badge-hrp" style="pointer-events:none">OWNS</span>'+
        '<span class="prob-acc-title">Historically Owns This Team</span>'+
        '<span class="prob-acc-count">'+items.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+cards+'</div>'+
    '</div>';
  }

  // ── TODAY'S BEST — always-open, value-first block (UI pass). The single
  // most important information, statically first: Walker Edges, then the best market
  // edges, then the model's strong-flagged picks. Same cards, same badges, no new visual
  // language — this is pure hierarchy, not decoration.
  function bestAcc(){
    var items=[], seen={};
    function push(e){ var k=(e.batterId||e.batter)+'|'+(e._cat||''); if(seen[k])return; seen[k]=1; items.push(e); }
    // The model's own strong-flagged picks across the headline categories.
    ['hrp','tb2','hit','k','walk','runsOver'].forEach(function(c){
      (data[c]||[]).filter(function(e){return e.strong;}).slice(0,2)
        .forEach(function(e){ push(Object.assign({_cat:c}, e)); });
    });
    items=items.slice(0,10);
    if(!items.length) return '';
    var body=items.map(function(e){
      var b=EDGE_CAT_BADGE[e._cat]||['prob-badge-hit',(e._cat||'?').toUpperCase()];
      return card(e, b[0], b[1], e.prob>=0.55?'prob-pct-high':'prob-pct-mid');
    }).join('');
    return '<div>'+
      '<div class="prob-acc-hdr" onclick="toggleProbAcc(this)">'+
        '<span class="prob-acc-arrow" style="color:var(--accent)">▶</span>'+
        '<span class="prob-badge" style="pointer-events:none;background:var(--accent);color:var(--paper);border:1px solid var(--accent)">★</span>'+
        '<span class="prob-acc-title" style="color:var(--accent)">Highest-Confidence Projections</span>'+
        '<span class="prob-acc-count">'+items.length+'</span>'+
      '</div>'+
      '<div class="prob-acc-body">'+body+'</div>'+
    '</div>';
  }
  // Static tier rules — a table of contents built into the layout, in the existing
  // typographic voice (small caps, rule line, muted ink). Nothing moves, nothing animates.
  function tier(label, id){
    return '<div id="'+id+'" style="margin:18px 0 6px;padding-top:10px;border-top:1px solid var(--rule);font-family:var(--f-display);font-size:.66rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-2)">'+label+'</div>';
  }
  // Static jump bar — plain anchors in the existing chip voice; one tap to any tier.
  var jumpChip='display:inline-block;margin:0 6px 6px 0;padding:3px 10px;border:1px solid var(--rule);border-radius:3px;font-family:var(--f-display);font-size:.62rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);text-decoration:none;background:var(--paper-2)';
  var jumpBar='<div style="margin:4px 0 12px">'+
    '<a href="#tier-hitting" style="'+jumpChip+'">Hitting</a>'+
    '<a href="#tier-runs" style="'+jumpChip+'">Runs &amp; RBI</a>'+
    '<a href="#tier-pitching" style="'+jumpChip+'">Pitching</a>'+
    '<a href="#tier-history" style="'+jumpChip+'">History</a>'+
  '</div>';

  panel.innerHTML=
    progressNote+header+calNote+
    '<div class="prob-accordion">'+
      bestAcc()+
      jumpBar+
      tier('Highlights','tier-edges')+
      lockAcc(data.locks||[])+
      lineupSurpriseAcc(data.lineupSurprise||[])+
      acc('prob-badge-runs-over', 'LEADOFF', 'Actionables · Leadoff, Favorable Matchup', data.actionablesLeadoff||[], function(p){ return p>=0.45?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-runs-over', '2-HOLE',  'Actionables · Confirmed 2-Hole, Favorable Matchup',  data.actionablesSecond ||[], function(p){ return p>=0.45?'prob-pct-high':'prob-pct-mid'; })+
      leadoffComboAcc(data.leadoffComboGroups||[])+
      hitsComboAcc(data.hitsComboGroups||[])+
      tier('Hitting Props','tier-hitting')+
      streakAcc('prob-badge-streak-hot',  'HOT',  'Hit Streak (5+ games)',     data.streakHot  ||[], function(e){ return e.hitStreak+'G'; },    'var(--accent)')+
      streakAcc('prob-badge-streak-fire', 'FIRE', 'On Fire (.400+ last 7g)',   data.streakFire ||[], function(e){ return '.'+String(Math.round(e.avg7*1000)).padStart(3,'0')+' / '+e.ab7+'AB'; }, 'var(--pos)')+
      streakAcc('prob-badge-streak-cold', 'COLD', 'Hitless Streak (4+ games)', data.streakCold ||[], function(e){ return e.hitlessStreak+'G'; }, 'var(--ink-2)')+
      acc('prob-badge-hit',       'HIT',  'Likely Hit',            data.hit      ||[], hi)+
      acc('prob-badge-cold',      'HIT-', 'Hit Under 0.5',         data.cold     ||[], function(p){ return p>=0.55?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-tb',        'XBH',  'Extra-Base Hit',        data.tb       ||[], function(p){ return p>=0.55?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-tb2',       '2+TB', '2+ Total Bases',        data.tb2      ||[], function(p){ return p>=0.55?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-hrp',       'HR+',  'HR Likely',             data.hrp      ||[], function(p){ return p>=0.25?'prob-pct-high':'prob-pct-mid'; })+
      accLive('prob-badge-hrp',  'HR+⛅', 'HR+ Live · Weather-Adjusted · Not Graded', data.hrpLive||[], function(p){ return p>=0.25?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-hrm',       'HR-',  'HR Unlikely',           data.hrm      ||[], function(p){ return p>=0.93?'prob-pct-high':'prob-pct-mid'; })+
      tier('Runs, RBI & Situational','tier-runs')+
      acc('prob-badge-runs-over', 'RUN+', 'Runs Scored Over 0.5',  data.runsOver ||[], function(p){ return p>=0.45?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-runs-under','RUN-', 'Runs Under 0.5',        data.runsUnder||[], lo)+
      acc('prob-badge-rbi-over',  'RBI+', 'RBI Over 0.5',          data.rbiOver  ||[], function(p){ return p>=0.45?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-rbi-under', 'RBI-', 'RBI Under 0.5',         data.rbiUnder ||[], lo)+
      acc('prob-badge-walk',      'BB',   'Walk',                   data.walk     ||[], function(p){ return p>=0.40?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-sb',        'SB',   'Stolen Base',           data.sb       ||[], function(p){ return p>=0.25?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-bb-under',  'BB-',  'No Walk',               data.bbUnder  ||[], function(p){ return p>=0.87?'prob-pct-high':'prob-pct-mid'; })+
      tier('Pitching & Strikeouts','tier-pitching')+
      acc('prob-badge-k',         'K',    'Likely Strikeout',       data.k        ||[], hi)+
      acc('prob-badge-k',         'K🎯',  'Auto-Out Strikeout',    data.kAutoOut ||[], hi)+
      acc('prob-badge-k',         'K2+',  '2+ Strikeouts · Auto-Out whiff ≥46% OR owns the SP (BvP-K ≥25%, top-5)', data.kMulti||[], function(p){ return p>=0.40?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-k',         'K7',   'Ice Cold · 45%+ K last 7g', data.recentK||[], function(p){ return p>=0.55?'prob-pct-high':'prob-pct-mid'; })+
      acc('prob-badge-k-under',   'K-',   'No Strikeout',          data.kUnder   ||[], function(p){ return p>=0.70?'prob-pct-high':'prob-pct-mid'; })+
      projKAcc(data.spProjectedK||[])+
      tier('Track Record & History','tier-history')+
      vsTeamAcc(data.vsTeamHr||[])+
      vsTeamCareerAcc(data.vsTeamCareer||[])+
    '</div>';
  applyAccMemory(panel);
}






function showStatcast(){
  var was=statcastVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  statcastVisible=true; setActiveNav('nav-statcast');
  var panel=document.getElementById('statcast-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading Statcast leaders...</p>';
  fetch('/api/statcast-leaders').then(function(r){return r.json();}).then(renderStatcast).catch(function(){
    document.getElementById('statcast-panel').innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load — make sure matchups are preloaded first.</p>';
  });
}

function renderStatcast(data){
  var panel=document.getElementById('statcast-panel');
  if(!data.gamesLoaded){
    panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">No games preloaded yet — open a game first, then return here.</p>';
    return;
  }

  function scCard(e, primaryVal, primaryLabel, primaryCls){
    var hh=e.hardHitPct, brl=e.barrelRate, bab=e.babip;
    var badges='';
    if(hh!=null) badges+='<span class="prob-badge" style="background:var(--paper-2);color:var(--ink-2);border:1px solid var(--rule-2)">'+Math.round(hh)+'% HH</span> ';
    if(brl!=null) badges+='<span class="prob-badge" style="background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn)">'+brl.toFixed(1)+'% Brl</span> ';
    if(bab!=null) badges+='<span class="prob-badge" style="background:var(--paper-2);color:var(--ink-3);border:1px solid var(--rule-2)">.'+String(Math.round(bab*1000)).padStart(3,'0')+' BABIP</span>';
    return '<div class="straight-card" style="margin-bottom:8px">'+
      '<div class="straight-body">'+
        '<div class="straight-name">'+e.batter+' <span style="color:var(--ink-3);font-weight:400">('+e.team+')</span></div>'+
        '<div class="straight-detail">vs '+e.vsPitcher+' &nbsp;·&nbsp; '+e.game+'</div>'+
        '<div style="margin-top:6px">'+badges+'</div>'+
      '</div>'+
      '<span class="straight-pct '+primaryCls+'">'+primaryVal+'</span>'+
    '</div>';
  }

  function section(title, items, valFn, clsFn, emptyMsg){
    if(!items||!items.length) return '<div style="color:var(--ink-3);font-size:.82rem;padding:8px 0">'+emptyMsg+'</div>';
    var body=items.map(function(e){ return scCard(e, valFn(e), '', clsFn(e)); }).join('');
    var uid='sc-'+title.replace(/\W/g,'');
    return '<div style="margin-bottom:20px">'+
      '<div onclick="(function(el){el.nextElementSibling.style.display=el.nextElementSibling.style.display===\'none\'?\'block\':\'none\';})(this)" '+
           'style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'+
        '<span style="font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">'+title+'</span>'+
        '<span style="font-size:.7rem;color:var(--ink-2)">'+items.length+' players ▾</span>'+
      '</div>'+
      '<div>'+body+'</div>'+
    '</div>';
  }

  var html='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'+
    '<span style="font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">'+
      'Statcast Leaders &nbsp;·&nbsp; '+data.gamesLoaded+' game'+(data.gamesLoaded!==1?'s':'')+' loaded'+
    '</span>'+
    '<button onclick="showStatcast()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
  '</div>';

  html+=section('Power Hitters — Barrel Rate', data.byBarrel,
    function(e){ return e.barrelRate!=null?e.barrelRate.toFixed(1)+'%':'-'; },
    function(e){ return e.barrelRate!=null&&e.barrelRate>=10?'prob-pct-high':'prob-pct-mid'; },
    'No barrel data for today\'s slate.');

  html+=section('Hard Contact — Hard Hit Rate', data.byHardHit,
    function(e){ return e.hardHitPct!=null?Math.round(e.hardHitPct)+'%':'-'; },
    function(e){ return e.hardHitPct!=null&&e.hardHitPct>=44?'prob-pct-high':'prob-pct-mid'; },
    'No hard hit data for today\'s slate.');

  html+=section('Unlucky Hitters — Low BABIP + Hard Contact', data.byBabip,
    function(e){ return e.babip!=null?'.'+String(Math.round(e.babip*1000)).padStart(3,'0'):'-'; },
    function(){ return 'prob-pct-high'; },
    'No qualifying unlucky hitters today (need HH% ≥35%).');

  panel.innerHTML=html;
}

function showYoyTrends(){
  var was=yoyVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  yoyVisible=true; setActiveNav('nav-yoy');
  var panel=document.getElementById('yoy-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading YoY trends...</p>';
  fetch('/api/yoy-trends').then(function(r){return r.json();}).then(renderYoyTrends).catch(function(){
    document.getElementById('yoy-panel').innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load — make sure matchups are preloaded first.</p>';
  });
}

function renderYoyTrends(data){
  var panel=document.getElementById('yoy-panel');
  if(!data.gamesLoaded){
    panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">No games preloaded yet — open a game first, then return here.</p>';
    return;
  }

  function yoyCard(e){
    var t=e.trend;
    var isReg=t.direction==='regression';
    var arrow=isReg?'↓':'↑';
    var color=isReg?'var(--neg)':'var(--pos)';
    var bg=isReg?'var(--neg-soft)':'var(--pos-soft)';
    var sevLabel=t.severity==='severe'?'SEVERE':t.severity==='significant'?'SIGNIFICANT':'MODERATE';
    var badges='<span class="prob-badge" style="background:'+bg+';color:'+color+';border:1px solid '+color+'">'+arrow+' '+sevLabel+'</span> ';
    badges+='<span class="prob-badge" style="background:var(--paper-2);color:var(--ink-2);border:1px solid var(--rule-2)">wOBA '+t.wobaPrior+' → '+t.wobaCurr+'</span> ';
    if(t.opsDelta!=null) badges+='<span class="prob-badge" style="background:var(--paper-2);color:var(--ink-3);border:1px solid var(--rule-2)">OPS '+(t.opsDelta>0?'+':'')+t.opsDelta+'</span> ';
    if(t.avgDelta!=null){
      var avgSign=t.avgDelta>0?'+':'';
      badges+='<span class="prob-badge" style="background:var(--paper-2);color:var(--ink-3);border:1px solid var(--rule-2)">AVG '+avgSign+t.avgDelta+'</span> ';
    }
    if(t.kPctDelta!=null){
      var kSign=t.kPctDelta>0?'+':'';
      badges+='<span class="prob-badge" style="background:var(--paper-2);color:var(--ink-3);border:1px solid var(--rule-2)">K% '+kSign+(t.kPctDelta*100).toFixed(1)+'%</span>';
    }
    var wobaColor=e.woba!=null&&e.woba>=.340?'var(--pos)':e.woba!=null&&e.woba<.290?'var(--neg)':'var(--ink-2)';
    var pctVal=e.woba!=null?'.'+String(Math.round(e.woba*1000)).padStart(3,'0'):'—';
    return '<div class="straight-card" style="margin-bottom:8px">'+
      '<div class="straight-body">'+
        '<div class="straight-name">'+e.batter+' <span style="color:var(--ink-3);font-weight:400">('+e.team+')</span></div>'+
        '<div class="straight-detail">vs '+e.vsPitcher+' &nbsp;·&nbsp; '+e.game+'</div>'+
        '<div style="margin-top:6px">'+badges+'</div>'+
      '</div>'+
      '<span class="straight-pct" style="color:'+wobaColor+'">'+pctVal+'</span>'+
    '</div>';
  }

  function yoySection(title, items, emptyMsg){
    if(!items||!items.length) return '<div style="color:var(--ink-3);font-size:.82rem;padding:8px 0">'+emptyMsg+'</div>';
    var body=items.map(function(e){ return yoyCard(e); }).join('');
    return '<div style="margin-bottom:20px">'+
      '<div onclick="(function(el){el.nextElementSibling.style.display=el.nextElementSibling.style.display===\'none\'?\'block\':\'none\';})(this)" '+
           'style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">'+
        '<span style="font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">'+title+'</span>'+
        '<span style="font-size:.7rem;color:var(--ink-2)">'+items.length+' players ▾</span>'+
      '</div>'+
      '<div>'+body+'</div>'+
    '</div>';
  }

  var html='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'+
    '<span style="font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">'+
      'Year-over-Year Trends &nbsp;·&nbsp; '+data.gamesLoaded+' game'+(data.gamesLoaded!==1?'s':'')+' loaded'+
    '</span>'+
    '<button onclick="showYoyTrends()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
  '</div>';
  html+='<div style="font-size:.72rem;color:var(--ink-3);margin-bottom:14px;line-height:1.5">'+
    'Players whose production has meaningfully shifted from last season. Regression = fallen off; breakout = leveled up. '+
    'Based on wOBA + OPS composite change (≥200 prior PA, ≥80 current PA). Right column shows current wOBA.'+
  '</div>';

  html+=yoySection('Fallen Off — Year-over-Year Regression', data.regressions,
    'No regression candidates in today\'s slate.');

  html+=yoySection('Leveled Up — Year-over-Year Breakout', data.breakouts,
    'No breakout candidates in today\'s slate.');

  panel.innerHTML=html;
}

function showSplits(){
  var was=splitsVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  splitsVisible=true; setActiveNav('nav-splits');
  var panel=document.getElementById('splits-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading split leaders...</p>';
  fetch('/api/splits-leaders').then(function(r){return r.json();}).then(renderSplits).catch(function(){
    document.getElementById('splits-panel').innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load splits.</p>';
  });
}

function renderSplits(data){
  var panel=document.getElementById('splits-panel');
  function dec3(v){ if(v==null)return '—'; return (v>=1?'':'')+Number(v).toFixed(3); }
  function row(r,i){
    var opsCol=r.ops>=1.000?'var(--pos)':r.ops>=0.850?'var(--ink)':'var(--ink-2)';
    var priorTag=r.priorOps!=null
      ? '<span style="color:var(--ink-3);font-size:.62rem"> &nbsp;prior '+r.priorOps.toFixed(3)+'</span>'
      : '';
    var ss=r.smallSample?'<span title="Qualified via proven prior season" style="color:var(--warn);font-size:.58rem;font-weight:700"> &#9670;</span>':'';
    var elite=r.eliteToday;
    var eliteTag=elite
      ? '<span title="Facing a starter of the hand they crush TODAY" style="display:inline-block;margin-left:8px;font-family:var(--f-display);font-size:.56rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:1px 6px;background:var(--pos);color:var(--paper);border-radius:2px">★ Elite matchup today</span>'
      : '';
    var elitePitcher=elite?'<div style="font-size:.6rem;color:var(--pos);margin-top:1px">vs '+elite.pitcher+' today</div>':'';
    var rowStyle='display:flex;align-items:baseline;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--rule)'
      +(elite?';background:var(--pos-soft);border-left:3px solid var(--pos)':'');
    return '<div style="'+rowStyle+'">'+
      '<div><span style="font-family:var(--f-mono);color:var(--ink-3);font-size:.7rem">'+String(i+1).padStart(2)+'</span> '+
        '<span style="font-weight:600">'+r.name+'</span> '+
        '<span style="color:var(--ink-3);font-size:.66rem">'+(r.team||'')+'</span>'+ss+eliteTag+elitePitcher+'</div>'+
      '<div style="text-align:right">'+
        (r.avg?'<span style="font-family:var(--f-mono);color:var(--ink-2)">'+r.avg+'</span> AVG &nbsp;':'')+
        '<span style="font-family:var(--f-mono);font-weight:700;color:'+opsCol+'">'+r.ops.toFixed(3)+'</span> OPS'+
        '<span style="color:var(--ink-3);font-size:.62rem"> &nbsp;'+r.pa+' PA'+(r.hr?' · '+r.hr+' HR':'')+'</span>'+priorTag+
      '</div>'+
    '</div>';
  }
  function col(title,arr){
    return '<div style="flex:1;min-width:320px">'+
      '<div style="font-size:.74rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin-bottom:8px">'+title+'</div>'+
      (arr&&arr.length?arr.map(row).join(''):'<div style="color:var(--ink-3)">No data.</div>')+
    '</div>';
  }
  panel.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'+
      '<span style="font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">Best Platoon Splits &nbsp;·&nbsp; '+(data.season||'')+'</span>'+
      '<button onclick="showSplits()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+
    '<div style="font-size:.7rem;color:var(--ink-3);margin-bottom:14px;line-height:1.5">Top 10 hitters by OPS vs each pitcher hand this season (min 50 PA vs the hand; &#9670; = qualified via a proven prior season). Prior-season split shown for context.</div>'+
    '<div style="display:flex;gap:28px;flex-wrap:wrap">'+
      col('Best vs LHP', data.vsLHP)+
      col('Best vs RHP', data.vsRHP)+
    '</div>';
}



function showStreaksBoard(){
  var was=streaksBoardVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  streaksBoardVisible=true; setActiveNav('nav-streaks');
  var panel=document.getElementById('streaks-board-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading streaks board...</p>';
  fetch('/api/streaks-board').then(function(r){return r.json();}).then(renderStreaksBoard).catch(function(){
    document.getElementById('streaks-board-panel').innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load streaks.</p>';
  });
}

function renderStreaksBoard(data){
  var panel=document.getElementById('streaks-board-panel');

  var LUCK_LABEL={
    aheadOfExpected:'Ahead of expected',
    behindExpected:'Behind expected',
    inLineWithExpected:'In line with expected'
  };

  function tierBadge(tier,hot){
    if(!tier) return '';
    var color=hot?'var(--accent)':'var(--ink-2)';
    return '<span class="rank-badge" style="color:'+color+';border-color:'+color+';margin-left:8px">'+tier+'</span>';
  }

  function batterCard(e,hot){
    var tagCls=hot?'streak-tag-fire':'streak-tag-ice';
    var tags=[];
    tags.push('<span class="streak-tag '+tagCls+'">'+e.woba.toFixed(3)+' wOBA'+(hot?' last 10d':' last 10d')+'</span>');
    if(e.hitStreak) tags.push('<span class="streak-tag '+tagCls+'">'+e.hitStreak+'-game hit streak</span>');
    if(e.hitlessStreak) tags.push('<span class="streak-tag '+tagCls+'">'+e.hitlessStreak+'-game hitless streak</span>');
    if(!hot && e.kpct!=null) tags.push('<span class="streak-tag streak-tag-neutral">'+e.kpct+'% K rate</span>');
    if(e.luckLabel) tags.push('<span class="streak-tag streak-tag-neutral">'+LUCK_LABEL[e.luckLabel]+(e.gap!=null?' ('+(e.gap>0?'+':'')+e.gap.toFixed(3)+' vs season xwOBA)':'')+'</span>');
    return '<div class="streak-card">'+
      '<div class="streak-name">'+e.name+tierBadge(e.tier,hot)+'</div>'+
      '<div class="streak-meta">'+(e.team||'')+' &nbsp;·&nbsp; '+e.pa+' PA</div>'+
      '<div class="streak-tags">'+tags.join('')+'</div>'+
      '</div>';
  }

  function pitcherCard(e,hot){
    var tagCls=hot?'streak-tag-fire':'streak-tag-ice';
    var tags=[];
    tags.push('<span class="streak-tag '+tagCls+'">'+e.era.toFixed(2)+' ERA last '+e.ip+' IP</span>');
    if(hot && e.qsStreak) tags.push('<span class="streak-tag '+tagCls+'">'+e.qsStreak+' straight quality starts</span>');
    if(hot && e.whip!=null) tags.push('<span class="streak-tag streak-tag-neutral">'+e.whip.toFixed(2)+' WHIP</span>');
    if(!hot && e.hrAllowed) tags.push('<span class="streak-tag streak-tag-neutral">'+e.hrAllowed+' HR allowed</span>');
    if(e.bbpct!=null) tags.push('<span class="streak-tag streak-tag-neutral">'+e.bbpct+'% BB rate</span>');
    if(e.luckLabel) tags.push('<span class="streak-tag streak-tag-neutral">'+LUCK_LABEL[e.luckLabel]+(e.gap!=null?' ('+(e.gap>0?'+':'')+e.gap.toFixed(2)+' vs season xERA)':'')+'</span>');
    return '<div class="streak-card">'+
      '<div class="streak-name">'+e.name+tierBadge(e.tier,hot)+'</div>'+
      '<div class="streak-meta">'+(e.team||'')+' &nbsp;·&nbsp; '+e.gamesStarted+' GS</div>'+
      '<div class="streak-tags">'+tags.join('')+'</div>'+
      '</div>';
  }

  function section(title,arr,cardFn,hot){
    return '<div style="margin-bottom:22px">'+
      '<div style="font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:'+(hot?'var(--accent)':'var(--ink-2)')+';margin-bottom:8px">'+title+'</div>'+
      (arr&&arr.length?'<div class="streak-grid">'+arr.map(function(e){return cardFn(e,hot);}).join('')+'</div>':'<div style="color:var(--ink-3);font-size:.78rem">Nothing crossing the Notable bar right now.</div>')+
      '</div>';
  }

  panel.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'+
      '<span style="font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">Streaks &nbsp;·&nbsp; League-Wide</span>'+
      '<button onclick="showStreaksBoard()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+
    '<div style="font-size:.7rem;color:var(--ink-3);margin-bottom:16px;line-height:1.5">Tiered on trailing wOBA/ERA ('+
      (data.window?data.window.hitting.start+' to '+data.window.hitting.end:'')+' for hitters, '+
      (data.window?data.window.pitching.start+' to '+data.window.pitching.end:'')+' for pitchers) — already a step up from raw AVG. '+
      'Each card also compares against the player\'s SEASON expected stat (xwOBA/xERA) to flag whether the streak is backed by real quality of contact/process or running ahead of/behind it. '+
      'Descriptive tiers — the thresholds are illustrative defaults, not lift-validated.</div>'+
    section('Batters &mdash; Hot',data.battersHot,batterCard,true)+
    section('Batters &mdash; Cold',data.battersCold,batterCard,false)+
    section('Pitchers &mdash; Hot',data.pitchersHot,pitcherCard,true)+
    section('Pitchers &mdash; Cold',data.pitchersCold,pitcherCard,false);
}

function showCyOld(){
  var was=cyOldVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  cyOldVisible=true; setActiveNav('nav-cyold');
  var panel=document.getElementById('cyold-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading Cy Old...</p>';
  fetch('/api/cy-old').then(function(r){return r.json();}).then(renderCyOld).catch(function(){
    document.getElementById('cyold-panel').innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load Cy Old.</p>';
  });
}

function renderCyOld(data){
  var panel=document.getElementById('cyold-panel');
  var pitchers=(data&&data.pitchers)||[];

  function card(p){
    var reasonTag=p.reason==='trending'
      ? '<span class="streak-tag streak-tag-neutral">Trending toward atrocious</span>'
      : '<span class="streak-tag streak-tag-ice">Season-long problem</span>';
    var qsTag=p.qsStreak?'<span class="streak-tag streak-tag-neutral">'+p.qsStreak+' straight QS</span>':'';
    return '<div class="streak-card">'+
      '<div class="streak-name">'+p.name+'</div>'+
      '<div class="streak-meta">'+(p.team||'')+' vs '+(p.opponent||'')+'</div>'+
      '<div class="streak-tags">'+
        '<span class="streak-tag streak-tag-ice">'+p.seasonFip.toFixed(2)+' season FIP</span>'+
        (p.trailingFip!=null?'<span class="streak-tag streak-tag-ice">'+p.trailingFip.toFixed(2)+' FIP last '+p.trailingIp+' IP</span>':'')+
        (p.seasonEra!=null?'<span class="streak-tag streak-tag-neutral">'+p.seasonEra.toFixed(2)+' ERA</span>':'')+
        qsTag+reasonTag+
      '</div>'+
      '</div>';
  }

  panel.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">'+
      '<span style="font-size:1.3rem;font-weight:800;color:var(--ink);letter-spacing:-.01em">Cy Old</span>'+
      '<button onclick="showCyOld()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+
    '<div style="font-size:.74rem;font-style:italic;color:var(--ink-3);margin-bottom:16px">Starters whose season has been one long batting-practice session.</div>'+
    (pitchers.length?'<div class="streak-grid">'+pitchers.map(card).join('')+'</div>':'<div style="color:var(--ink-3);font-size:.78rem">No one clears the bar on today\'s slate.</div>');
}

function showHrLog(){
  var was=hrLogVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  hrLogVisible=true; setActiveNav('nav-hrlog');
  var panel=document.getElementById('hr-log-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading home-run log...</p>';
  fetch('/api/hr-log?days=10').then(function(r){return r.json();}).then(renderHrLog).catch(function(){
    document.getElementById('hr-log-panel').innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load HR log.</p>';
  });
}

function renderHrLog(data){
  var panel=document.getElementById('hr-log-panel');
  var days=(data&&data.days)||[];
  function chip(h){
    var multi=h.hr>1?'<span style="color:var(--pos);font-weight:800"> ×'+h.hr+'</span>':'';
    return '<span style="display:inline-block;background:var(--paper-3);border:1px solid var(--rule);border-radius:3px;padding:2px 7px;margin:2px 3px;font-size:.72rem">'+
      '<span style="font-weight:600">'+h.name+'</span> '+
      '<span style="color:var(--ink-3);font-size:.64rem">'+(h.team||'')+(h.opp?' vs '+h.opp:'')+'</span>'+multi+
      '</span>';
  }
  function dayBlock(d){
    var live=d.finalGames<d.games?'<span style="color:var(--warn);font-size:.62rem;font-weight:700"> · '+(d.games-d.finalGames)+' in progress</span>':'';
    return '<div style="margin-bottom:18px">'+
      '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px;border-bottom:1px solid var(--rule);padding-bottom:4px">'+
        '<span style="font-family:var(--f-mono);font-weight:700;color:var(--ink)">'+d.date+'</span>'+
        '<span style="font-size:.7rem;color:var(--accent);font-weight:700">'+d.totalHr+' HR</span>'+
        '<span style="font-size:.66rem;color:var(--ink-3)">'+d.players+' player'+(d.players!==1?'s':'')+' · '+d.games+' game'+(d.games!==1?'s':'')+'</span>'+live+
      '</div>'+
      (d.hitters&&d.hitters.length?d.hitters.map(chip).join(''):'<div style="color:var(--ink-3);font-size:.74rem;padding:2px 0">No home runs'+(d.finalGames<d.games?' yet':'')+'.</div>')+
    '</div>';
  }
  panel.innerHTML=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'+
      '<span style="font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">Home Run Log</span>'+
      '<button onclick="showHrLog()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+
    '<div style="font-size:.7rem;color:var(--ink-3);margin-bottom:14px;line-height:1.5">Every home run actually hit each day (most recent first). Today refreshes live as games play out.</div>'+
    (days.length?days.map(dayBlock).join(''):'<div style="color:var(--ink-3)">No HR log data yet.</div>');
}

function closeAllNavPanelsAndMatchup(){
  ['rankings-panel','probables-panel','win-panel','accuracy-panel','statcast-panel','yoy-panel','splits-panel','streaks-board-panel','cyold-panel','hr-log-panel','charts-panel'].forEach(function(id){
    document.getElementById(id).style.display='none';
  });
  rankingsVisible=false; probablesVisible=false; winOddsVisible=false; accuracyVisible=false; statcastVisible=false; yoyVisible=false; splitsVisible=false; streaksBoardVisible=false; cyOldVisible=false; hrLogVisible=false; chartsVisible=false;
  document.getElementById('tabs').style.display='none';
  document.getElementById('table-wrap').innerHTML='';
  ['streaks-hot-panel','streaks-cold-panel','due-panel','bullpen-panel'].forEach(function(id){
    document.getElementById(id).style.display='none';
  });
  notableVisible=false; sucksVisible=false; dueVisible=false; bullpenVisible=false;
  document.getElementById('due-inline').style.display='none';
  setActiveNav(null);
}

function restoreMatchupContent(){
  if(!currentData) return;
  document.getElementById('tabs').style.display='flex';
  renderTable();
  renderDueInline(currentDueData);
}

function setActiveNav(id){
  ['nav-matchups','nav-probables','nav-win','nav-options','nav-charts'].forEach(function(nid){
    var el=document.getElementById(nid);
    if(el) el.classList.toggle('nav-active', nid===id);
  });
}

// ---------------------------------------------------------------------------
// Charts view — player-luck scatters (the inputs-over-outcomes
// thesis as pictures), pitcher xERA regression, model calibration + ROI
// transparency, and tonight's park×weather HR environment. Same chart grammar
// as the NFL side: one series, text labels, reference line, hover, table view.
// ---------------------------------------------------------------------------
var mlbChartState={chart:'hrLuck', table:false, q:''};
var mlbChartCache={};
var mlbChartCtx=null; // live draw context {pts, X, Y, svg} — the search box re-paints through it
var MLB_CHARTS={
  hrLuck:{ chip:'Power Luck', xl:'Barrel rate', yl:'HR per PA',
    fx:function(v){return v.toFixed(1)+'%';}, fy:function(v){return (v*100).toFixed(1)+'%';},
    labelMode:'extremes',
    note:'Every qualified hitter (150+ PA). The line is the league fit of HR rate on barrel rate — the same relationship the HR+ model anchors on. ABOVE the line: home runs running ahead of contact quality (regression / fade risk). BELOW the line: barrels not yet paying off — the Jordan Walker profile the Walker Edge flags, power the books tend to underprice.'},
  xslgLuck:{ chip:'xSLG vs SLG', xl:'Expected SLG (xSLG)', yl:'Actual SLG',
    fx:function(v){return v.toFixed(3);}, fy:function(v){return v.toFixed(3);},
    labelMode:'extremes',
    note:'Diagonal = results match contact quality. Above: overperforming (hot/lucky). Below: underperforming — extra-base damage is coming if the contact holds.'},
  xbaLuck:{ chip:'xBA vs BA', xl:'Expected BA (xBA)', yl:'Actual BA',
    fx:function(v){return v.toFixed(3);}, fy:function(v){return v.toFixed(3);},
    labelMode:'extremes',
    note:'Diagonal = batting average matches contact quality. Below the line: hitting into bad luck — the profile behind many Hit-category picks.'},
  xera:{ chip:'Pitcher xERA', xl:'Expected ERA (xERA)', yl:'Actual ERA',
    fx:function(v){return v.toFixed(2);}, fy:function(v){return v.toFixed(2);},
    labelMode:'extremes',
    note:'Diagonal = ERA matches the quality of contact allowed. ABOVE: ERA worse than the stuff (positive-regression candidates — the model already blends 45% xERA for exactly this reason). BELOW: outperforming, due for correction.'},
  calibration:{ chip:'Calibration', xl:'Stated probability (avg)', yl:'Realized rate',
    fx:function(v){return (v*100).toFixed(0)+'%';}, fy:function(v){return (v*100).toFixed(0)+'%';},
    labelMode:'all',
    note:'Every graded category, last 14 days (min 25 picks). On the diagonal = the stated percentages are honest. Above: underselling. Below: overselling. This is the model grading itself — losses included.'},
  parks:{ chip:'Parks Tonight', xl:'Park HR factor', yl:'Weather HR multiplier (today)',
    fx:function(v){return v.toFixed(2);}, fy:function(v){return v.toFixed(2);},
    labelMode:'all', cross:{x:1,y:1},
    note:'Tonight\'s slate. Right = HR-friendly park, up = HR-friendly weather (wind/temp, per-park sensitivity). Top-right games are where the HR+ board lives; bottom-left suppresses power.'},
};

function showCharts(){
  var was=chartsVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  chartsVisible=true; setActiveNav('nav-charts');
  var panel=document.getElementById('charts-panel');
  panel.style.display='block';
  renderMlbChartShell();
  loadMlbChart();
}

function renderMlbChartShell(){
  var panel=document.getElementById('charts-panel');
  var chips='';
  Object.keys(MLB_CHARTS).forEach(function(k){
    chips+='<div class="chart-chip'+(k===mlbChartState.chart?' active':'')+'" onclick="mlbChartPick(\''+k+'\')">'+MLB_CHARTS[k].chip+'</div>';
  });
  chips+='<input class="chart-search" id="mlb-chart-search" type="text" placeholder="Find player…" value="'+mlbChartState.q.replace(/"/g,'&quot;')+'" oninput="mlbChartSearch(this.value)" style="margin-left:auto">'+
    '<span class="chart-found-n" id="mlb-chart-found"></span>'+
    '<div class="chart-chip'+(mlbChartState.table?' active':'')+'" onclick="mlbChartTable()">Table</div>';
  panel.innerHTML='<h2 style="font-family:var(--f-display);font-size:1.15rem;font-weight:900;margin-bottom:10px">Charts</h2>'+
    '<div class="chart-controls">'+chips+'</div>'+
    '<div class="chart-card" id="mlb-chart-card"><p style="color:var(--ink-3);font-family:var(--f-mono);font-size:.78rem;padding:14px">Loading chart…</p></div>'+
    '<div class="chart-note" id="mlb-chart-note"></div>';
}
function mlbChartPick(k){ mlbChartState.chart=k; renderMlbChartShell(); loadMlbChart(); }
function mlbChartTable(){ mlbChartState.table=!mlbChartState.table; renderMlbChartShell(); loadMlbChart(); }

// Live player search: fold accents/case, substring-match against short + full names,
// flip the.found class on matching dots and inject blue labels for them. Pure
// client-side re-paint of the existing SVG — no refetch, no redraw.
function mlbChartFold(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
function mlbChartSearch(q){
  mlbChartState.q=q;
  var ctx=mlbChartCtx, foundEl=document.getElementById('mlb-chart-found');
  if(!ctx||!ctx.svg||!document.body.contains(ctx.svg)){ if(foundEl) foundEl.textContent=''; return; }
  var needle=mlbChartFold(q.trim());
  var lblG=ctx.svg.querySelector('#cx-search-lbls');
  while(lblG&&lblG.firstChild) lblG.removeChild(lblG.firstChild);
  var circles=ctx.svg.querySelectorAll('.cx-dot');
  var nFound=0;
  circles.forEach(function(c){
    var p=ctx.pts[+c.getAttribute('data-i')];
    var hit=!!needle&&p&&(mlbChartFold(p.name).indexOf(needle)!==-1||mlbChartFold(p.full).indexOf(needle)!==-1);
    c.classList.toggle('found',hit);
    if(hit){
      nFound++;
      c.parentNode.appendChild(c); // raise above neighboring dots
      if(lblG&&nFound<=12){ // label the finds, but never flood the plot
        var t=document.createElementNS('http://www.w3.org/2000/svg','text');
        t.setAttribute('class','cx-lbl-found');
        t.setAttribute('x',ctx.X(p.x)+9); t.setAttribute('y',ctx.Y(p.y)-7);
        t.textContent=p.name;
        lblG.appendChild(t);
      }
    }
  });
  if(foundEl) foundEl.textContent=!needle?'':(nFound===0?'no match':nFound+' found');
}

function loadMlbChart(){
  var k=mlbChartState.chart;
  document.getElementById('mlb-chart-note').textContent=MLB_CHARTS[k].note||'';
  if(mlbChartCache[k]) return drawMlbChart(mlbChartCache[k]);
  fetch('/api/mlb-charts?chart='+k).then(function(r){return r.json();}).then(function(d){
    mlbChartCache[k]=d; drawMlbChart(d);
  }).catch(function(){
    document.getElementById('mlb-chart-card').innerHTML='<p style="color:var(--neg);font-size:.82rem;padding:14px">Failed to load chart data.</p>';
  });
}

function drawMlbChart(d){
  var card=document.getElementById('mlb-chart-card');
  if(!card) return;
  var cfg=MLB_CHARTS[mlbChartState.chart];
  if(cfg.bar) return drawMlbBars(card, d.bars||[]);
  var pts=d.pts||[];
  if(!pts.length){ card.innerHTML='<p style="color:var(--ink-3);font-family:var(--f-mono);font-size:.78rem;padding:14px">No data yet for this chart (Savant refresh or graded picks needed).</p>'; return; }

  if(mlbChartState.table){
    var rows='';
    pts.slice().sort(function(a,b){return b.y-a.y;}).forEach(function(p){
      rows+='<tr><td style="text-align:left;font-weight:700">'+p.name+'</td><td>'+cfg.fx(p.x)+'</td><td>'+cfg.fy(p.y)+'</td>'+(p.n!=null?'<td>'+p.n+'</td>':'')+'</tr>';
    });
    card.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-family:var(--f-mono);font-size:.74rem">'+
      '<thead><tr><th style="text-align:left;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">Name</th>'+
      '<th style="text-align:right;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">'+cfg.xl+'</th>'+
      '<th style="text-align:right;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">'+cfg.yl+'</th>'+
      (pts[0].n!=null?'<th style="text-align:right;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">n</th>':'')+
      '</tr></thead><tbody>'+rows+'</tbody></table></div>'+
      '<style>#mlb-chart-card td{padding:5px 10px;text-align:right;border-bottom:1px solid var(--rule)}</style>';
    return;
  }

  var W=920,H=560,M={l:64,r:26,t:18,b:50};
  var xs=pts.map(function(p){return p.x;}), ys=pts.map(function(p){return p.y;});
  function pad(lo,hi){ var dd=(hi-lo)||1; return [lo-dd*.07, hi+dd*.07]; }
  var xr=pad(Math.min.apply(null,xs),Math.max.apply(null,xs)), x0=xr[0], x1=xr[1];
  var yr=pad(Math.min.apply(null,ys),Math.max.apply(null,ys)), y0=yr[0], y1=yr[1];
  function X(v){ return M.l+(v-x0)/(x1-x0)*(W-M.l-M.r); }
  function Y(v){ return H-M.b-(v-y0)/(y1-y0)*(H-M.t-M.b); }
  function ticks(lo,hi,n){
    var step=Math.pow(10,Math.floor(Math.log10((hi-lo)/n)));
    var s=[1,2,5,10].map(function(m){return m*step;}).filter(function(m){return (hi-lo)/m<=n+1;})[0]||step*10;
    var out=[]; for(var v=Math.ceil(lo/s)*s; v<=hi+1e-9; v+=s) out.push(v);
    return out;
  }
  var g='';
  ticks(x0,x1,6).forEach(function(v){ g+='<line class="cx-grid" x1="'+X(v)+'" y1="'+M.t+'" x2="'+X(v)+'" y2="'+(H-M.b)+'"/><text class="cx-tick" x="'+X(v)+'" y="'+(H-M.b+16)+'" text-anchor="middle">'+cfg.fx(v)+'</text>'; });
  ticks(y0,y1,6).forEach(function(v){ g+='<line class="cx-grid" x1="'+M.l+'" y1="'+Y(v)+'" x2="'+(W-M.r)+'" y2="'+Y(v)+'"/><text class="cx-tick" x="'+(M.l-8)+'" y="'+(Y(v)+3)+'" text-anchor="end">'+cfg.fy(v)+'</text>'; });

  // reference: fitted/diagonal line (clipped to the plot) or neutral crosshairs
  var fit=d.fit;
  g+='<defs><clipPath id="cx-clip"><rect x="'+M.l+'" y="'+M.t+'" width="'+(W-M.l-M.r)+'" height="'+(H-M.t-M.b)+'"/></clipPath></defs>';
  if(fit){
    g+='<g clip-path="url(#cx-clip)"><line class="cx-refline" x1="'+X(x0)+'" y1="'+Y(fit.intercept+fit.slope*x0)+'" x2="'+X(x1)+'" y2="'+Y(fit.intercept+fit.slope*x1)+'"/></g>';
  }
  if(cfg.cross){
    g+='<line class="cx-avg" x1="'+X(cfg.cross.x)+'" y1="'+M.t+'" x2="'+X(cfg.cross.x)+'" y2="'+(H-M.b)+'"/>'+
       '<line class="cx-avg" x1="'+M.l+'" y1="'+Y(cfg.cross.y)+'" x2="'+(W-M.r)+'" y2="'+Y(cfg.cross.y)+'"/>'+
       '<text class="cx-avg-lbl" x="'+(X(cfg.cross.x)+4)+'" y="'+(M.t+10)+'">neutral</text>';
  }

  // which points get labels: everything on small charts, biggest residuals on big ones
  var labeled={};
  if(cfg.labelMode==='all'||pts.length<=40){ pts.forEach(function(p,i){labeled[i]=true;}); }
  else{
    var resid=pts.map(function(p,i){
      var ref=fit?(fit.intercept+fit.slope*p.x):((y0+y1)/2);
      return {i:i, r:Math.abs(p.y-ref)/((y1-y0)||1)};
    });
    resid.sort(function(a,b){return b.r-a.r;}).slice(0,14).forEach(function(o){labeled[o.i]=true;});
  }
  var dots='',lbls='',placed=[];
  pts.slice().sort(function(a,b){return a.y-b.y;}).forEach(function(p){
    var i=pts.indexOf(p), cx=X(p.x), cy=Y(p.y);
    dots+='<circle class="cx-dot'+(labeled[i]?'':' dim')+'" data-i="'+i+'" cx="'+cx+'" cy="'+cy+'" r="4.5"/>';
    if(labeled[i]){
      var lx=cx+8, ly=cy+3.5;
      placed.forEach(function(q){ if(Math.abs(lx-q.x)<44&&Math.abs(ly-q.y)<11) ly=q.y+11.5; });
      placed.push({x:lx,y:ly});
      lbls+='<text class="cx-lbl" x="'+lx+'" y="'+ly+'">'+p.name+'</text>';
    }
  });

  card.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+cfg.yl+' vs '+cfg.xl+'">'+g+dots+lbls+
    '<g id="cx-search-lbls"></g>'+
    '<text class="cx-axis-title" x="'+((M.l+W-M.r)/2)+'" y="'+(H-10)+'" text-anchor="middle">'+cfg.xl+'</text>'+
    '<text class="cx-axis-title" x="'+(-(M.t+H-M.b)/2)+'" y="16" transform="rotate(-90)" text-anchor="middle">'+cfg.yl+'</text>'+
    '</svg><div class="chart-tip" id="mlb-chart-tip"></div>';

  var svg=card.querySelector('svg'), tip=document.getElementById('mlb-chart-tip');
  mlbChartCtx={pts:pts, X:X, Y:Y, svg:svg};
  if(mlbChartState.q) mlbChartSearch(mlbChartState.q);
  var circles=[].slice.call(svg.querySelectorAll('.cx-dot'));
  svg.addEventListener('mousemove',function(ev){
    var r=svg.getBoundingClientRect();
    var sx=(ev.clientX-r.left)*W/r.width, sy=(ev.clientY-r.top)*H/r.height;
    var best=null, bd=32*32;
    pts.forEach(function(p){
      var dd=(X(p.x)-sx)*(X(p.x)-sx)+(Y(p.y)-sy)*(Y(p.y)-sy);
      if(dd<bd){bd=dd;best=p;}
    });
    circles.forEach(function(c){ c.classList.toggle('hi', best&&pts[+c.getAttribute('data-i')]===best); });
    if(!best){ tip.style.display='none'; return; }
    tip.textContent='';
    var b=document.createElement('b'); b.textContent=best.name+(best.venue?' — '+best.venue:''); tip.appendChild(b);
    [[cfg.xl,cfg.fx(best.x)],[cfg.yl,cfg.fy(best.y)]].forEach(function(row){
      var el=document.createElement('div');
      el.appendChild(document.createTextNode(row[0]+': '));
      var v=document.createElement('span'); v.className='v'; v.textContent=row[1]; el.appendChild(v);
      tip.appendChild(el);
    });
    if(best.n!=null){ var nEl=document.createElement('div'); nEl.textContent='n = '+best.n; tip.appendChild(nEl); }
    if(best.windDesc){ var wEl=document.createElement('div'); wEl.textContent='Wind: '+best.windDesc+(best.outWindMph!=null?' ('+best.outWindMph+' mph out)':'')+(best.tempF!=null?' · '+best.tempF+'°F':''); tip.appendChild(wEl); }
    var cr=card.getBoundingClientRect();
    tip.style.left=Math.min(ev.clientX-cr.left+14, cr.width-190)+'px';
    tip.style.top=(ev.clientY-cr.top+12)+'px';
    tip.style.display='block';
  });
  svg.addEventListener('mouseleave',function(){ tip.style.display='none'; circles.forEach(function(c){c.classList.remove('hi');}); });
}

// ROI diverging bars: category rows, bar length = flat-stake ROI %, zero line center.
function drawMlbBars(card, bars){
  if(!bars.length){ card.innerHTML='<p style="color:var(--ink-3);font-family:var(--f-mono);font-size:.78rem;padding:14px">No ROI data yet — market odds are saved at freeze time from 07-12 onward.</p>'; return; }
  if(mlbChartState.table){
    var rows='';
    bars.forEach(function(b){ rows+='<tr><td style="text-align:left;font-weight:700">'+b.name+'</td><td>'+(b.roiPct>0?'+':'')+b.roiPct+'%</td><td>'+(b.units>0?'+':'')+b.units+'u</td><td>'+b.n+'</td></tr>'; });
    card.innerHTML='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-family:var(--f-mono);font-size:.74rem">'+
      '<thead><tr><th style="text-align:left;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">Category</th>'+
      '<th style="text-align:right;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">ROI</th>'+
      '<th style="text-align:right;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">Units</th>'+
      '<th style="text-align:right;padding:7px 10px;border-bottom:2px solid var(--rule-ink)">Bets</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
      '<style>#mlb-chart-card td{padding:5px 10px;text-align:right;border-bottom:1px solid var(--rule)}</style>';
    return;
  }
  var W=920, rowH=30, M={l:170,r:120,t:14,b:34};
  var H=M.t+M.b+bars.length*rowH;
  var maxAbs=Math.max.apply(null,bars.map(function(b){return Math.abs(b.roiPct);}))||1;
  var zero=M.l+(W-M.l-M.r)/2, half=(W-M.l-M.r)/2;
  function BX(v){ return zero+(v/maxAbs)*half*0.92; }
  var g='<line class="cx-avg" x1="'+zero+'" y1="'+M.t+'" x2="'+zero+'" y2="'+(H-M.b)+'"/>'+
    '<text class="cx-tick" x="'+zero+'" y="'+(H-M.b+16)+'" text-anchor="middle">0%</text>'+
    '<text class="cx-tick" x="'+BX(maxAbs)+'" y="'+(H-M.b+16)+'" text-anchor="middle">+'+maxAbs.toFixed(0)+'%</text>'+
    '<text class="cx-tick" x="'+BX(-maxAbs)+'" y="'+(H-M.b+16)+'" text-anchor="middle">-'+maxAbs.toFixed(0)+'%</text>';
  bars.forEach(function(b,i){
    var y=M.t+i*rowH+5, h=rowH-10;
    var x=b.roiPct>=0?zero:BX(b.roiPct), w=Math.abs(BX(b.roiPct)-zero);
    var lblTxt=(b.roiPct>0?'+':'')+b.roiPct+'% · '+b.n+' bets';
    // Long negative bars: an end-label would collide with the category column —
    // move it inside the bar (paper ink, always clears contrast on the fill).
    var lblW=lblTxt.length*6.4;
    var inside=b.roiPct<0 && (BX(b.roiPct)-6-lblW)<(M.l+4);
    var lx=b.roiPct>=0?BX(b.roiPct)+6:(inside?BX(b.roiPct)+6:BX(b.roiPct)-6);
    var anchor=b.roiPct>=0?'start':(inside?'start':'end');
    g+='<text class="cx-bar-cat" x="'+(M.l-10)+'" y="'+(y+h/2+3.5)+'" text-anchor="end">'+b.name+'</text>'+
       '<rect class="'+(b.roiPct>=0?'cx-bar-pos':'cx-bar-neg')+'" x="'+x+'" y="'+y+'" width="'+Math.max(w,1)+'" height="'+h+'"/>'+
       '<text class="'+(inside?'cx-bar-lbl-in':'cx-bar-lbl')+'" x="'+lx+'" y="'+(y+h/2+3.5)+'" text-anchor="'+anchor+'">'+lblTxt+'</text>';
  });
  card.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Flat-stake ROI by category">'+g+'</svg>';
}

function showRankings(){
  var was=rankingsVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  rankingsVisible=true; setActiveNav('nav-matchups');
  var panel=document.getElementById('rankings-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading rankings...</p>';
  Promise.all([
    fetch('/api/top-matchups').then(function(r){return r.json();}),
    fetch('/api/due').then(function(r){return r.json();}).catch(function(){return {dueHit:[],dueHr:[]};})
  ]).then(function(results){ renderRankings(results[0], results[1]); }).catch(function(){
    panel.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load rankings.</p>';
  });
}

function renderRankings(data, dueData){
  var panel=document.getElementById('rankings-panel');
  if(!data.gamesLoaded){
    panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">No games preloaded yet — the server is still computing matchups. Try again in a minute.</p>';
    return;
  }

  var progressNote='';
  if(data.gamesLoaded < games.length){
    progressNote='<p style="color:var(--warn);font-size:.73rem;margin-bottom:12px">'+
      '⏳ Preloading in background — '+data.gamesLoaded+' of '+games.length+' games ready. '+
      '<span style="cursor:pointer;text-decoration:underline" onclick="showRankings()">Refresh</span></p>';
  }

  function makeCard(e, cls){
    var scCls=e.score>=7?'score-high':e.score<=3?'score-low':'score-mid';
    var emoji=e.score===10?'':e.score===1?'':'';
    var hand=e.pitcher.hand==='L'?'LHP':'RHP';
    var badges='';
    if(!e.lineupConfirmed) badges+='<span class="rank-badge rank-badge-tbd">LINEUP TBD</span>';
    if(e.platoonRisk) badges+='<span class="rank-badge rank-badge-platoon">PLATOON? ('+e.paVsHand+' PA vs '+hand+')</span>';
    return '<div class="rank-card '+cls+'">'+
      '<div class="rank-header">'+
        '<span class="score-badge '+scCls+'">'+e.score+'</span>'+
        '<div>'+
          '<div class="rank-names">'+emoji+e.batter.name+' vs '+e.pitcher.name+'</div>'+
          '<div class="rank-meta">'+e.game+' &nbsp;·&nbsp; '+hand+'</div>'+
          (badges?'<div class="rank-badges">'+badges+'</div>':'')+
        '</div>'+
      '</div>'+
      '<div class="rank-desc">'+e.desc+'</div>'+
      '</div>';
  }

  var topHtml=(data.top||[]).map(function(e){return makeCard(e,'rank-top');}).join('');
  var botHtml=(data.bottom||[]).map(function(e){return makeCard(e,'rank-bot');}).join('');

  // Due Up section
  var dueHit=(dueData&&dueData.dueHit)||[];
  var dueHr =(dueData&&dueData.dueHr )||[];
  var dueTotal=dueHit.length+dueHr.length;
  var dueSection='';
  if(dueTotal>0){
    dueSection=
      '<div style="margin-top:24px;padding-top:18px;border-top:1px solid var(--paper-2)">'+
        '<div class="acc-section-hdr" onclick="toggleRankingsDue(this)" style="margin-bottom:0;padding:8px 2px">'+
          '<span id="rankings-due-arrow" style="font-size:.6rem;color:var(--ink-3)">▶</span>'+
          '<span style="color:var(--ink-2)">Due Up</span>'+
          '<span style="font-size:.62rem;color:var(--ink-3);margin-left:auto">'+dueTotal+' player'+(dueTotal!==1?'s':'')+' across all games &nbsp;·&nbsp; click to expand</span>'+
        '</div>'+
        '<div id="rankings-due-body" style="display:none">'+
          renderDueGrid(dueHit, dueHr, 'None qualifying today.')+
        '</div>'+
      '</div>';
  }

  var matchupCount=(data.top||[]).length+(data.bottom||[]).length;

  panel.innerHTML=
    progressNote+
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'+
      '<span style="font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">'+
        'Matchups &nbsp;·&nbsp; '+data.gamesLoaded+' game'+(data.gamesLoaded!==1?'s':'')+' loaded'+
      '</span>'+
      '<button onclick="showRankings()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+
    '<div class="acc-section-hdr" onclick="toggleRankingsMatchups(this)" style="margin-bottom:0;padding:8px 2px">'+
      '<span id="rankings-matchups-arrow" style="font-size:.6rem;color:var(--ink-3)">▼</span>'+
      '<span style="color:var(--ink-3)">Best / Worst Matchups for Batters</span>'+
      '<span style="font-size:.62rem;color:var(--ink-3);margin-left:auto">SP matchups only &nbsp;·&nbsp; click to collapse</span>'+
    '</div>'+
    '<div id="rankings-matchups-body">'+
      '<div class="rankings-grid" style="margin-top:12px">'+
        '<div class="rankings-col"><h3 class="best">Best 20 Matchups for Batters</h3>'+topHtml+'</div>'+
        '<div class="rankings-col"><h3 class="worst">Worst 20 Matchups for Batters</h3>'+botHtml+'</div>'+
      '</div>'+
    '</div>'+
    dueSection;
}

function toggleRankingsMatchups(hdr){
  var body=document.getElementById('rankings-matchups-body');
  var arrow=document.getElementById('rankings-matchups-arrow');
  var open=body.style.display==='none';
  body.style.display=open?'block':'none';
  if(arrow) arrow.textContent=open?'▼':'▶';
}

function toggleRankingsDue(hdr){
  var body=document.getElementById('rankings-due-body');
  var arrow=document.getElementById('rankings-due-arrow');
  var open=body.style.display==='none';
  body.style.display=open?'block':'none';
  if(arrow) arrow.textContent=open?'▼':'▶';
}

function checkAccuracyDate(){ loadAccuracy(document.getElementById('acc-date-input').value); }

function showAccuracy(){
  var was=accuracyVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  accuracyVisible=true; setActiveNav('nav-options');
  var panel=document.getElementById('accuracy-panel');
  panel.style.display='block';
  // Default to TODAY (user request): grade the current slate LIVE — an ✗
  // flips to ✓ as at-bats happen, since MLB boxscores update in-game. A "still in
  // progress" note is shown for today (see loadAccuracy).
  var now=new Date();
  var yStr=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  panel.innerHTML=
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">'+
      '<span style="font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2)">Prediction Accuracy</span>'+
      '<input id="acc-date-input" type="date" value="'+yStr+'" style="background:var(--paper-3);border:1px solid var(--ink-2);border-radius:5px;color:var(--ink-2);padding:3px 8px;font-size:.78rem">'+
      '<button onclick="checkAccuracyDate()" style="padding:3px 12px;background:var(--paper-3);color:var(--ink-2);border:1px solid var(--ink-2);border-radius:5px;cursor:pointer;font-size:.75rem;font-weight:600">Check</button>'+
      '<button onclick="showAccuracy()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;margin-left:auto">✕</button>'+
    '</div>'+
    '<div id="ml-vs-book-summary"></div>'+
    '<div id="total-vs-book-summary"></div>'+
    '<div id="prop-edge-vs-book-summary"></div>'+
    '<div id="acc-results"><p style="color:var(--ink-3);font-size:.82rem">Select a date and click Check.</p></div>';
  loadAccuracy(yStr);
  loadMlVsBookSummary();
  loadTotalVsBookSummary();
  loadPropEdgeVsBookSummary();
}

function loadPropEdgeVsBookSummary(){
  var el=document.getElementById('prop-edge-vs-book-summary');
  if(!el) return;
  fetch('/api/prop-edge-vs-book?days=30')
    .then(function(r){ return r.json(); })
    .then(function(s){
      if(!s || !s.n){ el.innerHTML=''; return; }
      var diff=(s.actualRate-s.avgOurProb)*100, diffBook=(s.actualRate-s.avgBookProb)*100;
      // "Real edge" reads as good when the actual rate landed close to OUR number and
      // meaningfully above the book's — i.e. we weren't just overconfident vs the market.
      var trackCls = Math.abs(diff) < Math.abs(diffBook) ? 'var(--pos)' : 'var(--neg)';
      var trackNote = Math.abs(diff) < Math.abs(diffBook)
        ? 'tracks closer to OUR number — the edge looks real'
        : 'tracks closer to the BOOK\'s number — we may be overconfident vs the market';
      var catRows=Object.keys(s.byCat||{}).sort(function(a,b){return s.byCat[b].n-s.byCat[a].n;}).map(function(c){
        var b=s.byCat[c];
        return '<div style="display:flex;gap:10px;font-size:.68rem;color:var(--ink-3);padding:2px 0">'+
          '<span style="min-width:70px;font-weight:700;color:var(--ink-2)">'+c+'</span>'+
          '<span>n='+b.n+'</span><span>actual '+Math.round(b.actualRate*100)+'%</span>'+
          '<span>us '+Math.round(b.avgOurProb*100)+'%</span><span>book '+Math.round(b.avgBookProb*100)+'%</span>'+
        '</div>';
      }).join('');
      el.innerHTML='<div style="background:var(--paper-2);border:1px solid var(--ink-2);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:.78rem;color:var(--ink-2)">'+
        '<b>Last '+s.days+' days, Top Market Edges accuracy</b> ('+s.n+' flagged picks, edge ≥ 4pts): '+
        'actual hit rate <b>'+Math.round(s.actualRate*100)+'%</b> vs our claimed <b>'+Math.round(s.avgOurProb*100)+'%</b> vs book\'s <b>'+Math.round(s.avgBookProb*100)+'%</b> '+
        '<span style="color:'+trackCls+'">('+trackNote+')</span>'+
        (catRows?'<div style="margin-top:6px;border-top:1px solid var(--ink-2);padding-top:6px">'+catRows+'</div>':'')+
      '</div>';
    })
    .catch(function(){ el.innerHTML=''; });
}

function loadTotalVsBookSummary(){
  var el=document.getElementById('total-vs-book-summary');
  if(!el) return;
  fetch('/api/total-vs-book?days=30')
    .then(function(r){ return r.json(); })
    .then(function(s){
      if(!s || !s.n){ el.innerHTML=''; return; }
      var betterCls=(s.book.mae-s.us.mae)>0?'var(--pos)':(s.book.mae-s.us.mae)<0?'var(--neg)':'var(--ink-3)';
      var overPct=Math.round(s.bookOverRate*100);
      el.innerHTML='<div style="background:var(--paper-2);border:1px solid var(--ink-2);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:.78rem;color:var(--ink-2)">'+
        '<b>Last '+s.days+' days, run total vs. the book</b> ('+s.n+' games): '+
        'us MAE <b>'+s.us.mae+'</b> (bias '+(s.us.bias>0?'+':'')+s.us.bias+') vs book MAE <b>'+s.book.mae+'</b> (bias '+(s.book.bias>0?'+':'')+s.book.bias+') '+
        '<span style="color:'+betterCls+'">('+(s.book.mae-s.us.mae>=0?'we\'re closer':'book is closer')+')</span>'+
        '<br><span style="color:var(--ink-3)">Actual total landed OVER the book\'s line '+overPct+'% of the time — '+
        (Math.abs(overPct-50)<=5?'close to 50%, i.e. no consistent directional bias, just variance':'a persistent skew worth watching')+
        '.</span></div>';
    })
    .catch(function(){ el.innerHTML=''; });
}

function loadMlVsBookSummary(){
  var el=document.getElementById('ml-vs-book-summary');
  if(!el) return;
  fetch('/api/ml-vs-book?days=30')
    .then(function(r){ return r.json(); })
    .then(function(s){
      if(!s || !s.n){ el.innerHTML=''; return; }
      var usPct=Math.round(s.us.rate*100), bookPct=Math.round(s.book.rate*100);
      var beatBy=usPct-bookPct;
      var beatCls=beatBy>0?'var(--pos)':beatBy<0?'var(--neg)':'var(--ink-3)';
      var beatStr=beatBy>0?'+'+beatBy:String(beatBy);
      el.innerHTML='<div style="background:var(--paper-2);border:1px solid var(--ink-2);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:.78rem;color:var(--ink-2)">'+
        '<b>Last '+s.days+' days, moneyline vs. the book</b> ('+s.n+' decided games): '+
        'us <b>'+usPct+'%</b> vs book <b>'+bookPct+'%</b> '+
        '<span style="color:'+beatCls+'">('+beatStr+' pts)</span>'+
        '<br><span style="color:var(--ink-3)">Agreed with the book on '+s.agreeCount+'/'+s.n+' games'+
        (s.agreeWinRate!=null?' — won '+Math.round(s.agreeWinRate*100)+'% of those':'')+
        (s.disagreeCount?'; disagreed on '+s.disagreeCount+', our pick won '+Math.round((s.usWinRateOnDisagree||0)*100)+'% of those':'')+
        '.</span></div>';
    })
    .catch(function(){ el.innerHTML=''; });
}

function loadAccuracy(dateStr){
  if(!dateStr) return;
  var el=document.getElementById('acc-results');
  if(!el) return;
  el.innerHTML='<p style="color:var(--ink-3);font-size:.82rem">Loading...</p>';
  fetch('/api/accuracy?date='+encodeURIComponent(dateStr))
    .then(function(r){ return r.json(); })
    .then(renderAccuracy)
    .catch(function(){ el.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load accuracy data.</p>'; });
}

function renderAccuracy(data){
  var el=document.getElementById('acc-results');
  if(!el) return;
  if(data.error){ el.innerHTML='<p style="color:var(--neg);font-size:.82rem">'+data.error+'</p>'; return; }

  var CAT_LABELS={hit:'Hit',k:'Strikeout',kAutoOut:'Strikeout · Auto-Out 🎯',kMulti:'2+ Strikeouts (K1.5)',recentK:'Ice Cold K (45%+ 7g)',cold:'Hit Under',hrp:'HR+',hrm:'HR-',tb:'Extra-Base Hit',tb2:'2+ Total Bases',walk:'Walk',rbiOver:'RBI Over',rbiUnder:'RBI Under',runsOver:'Run Over',runsUnder:'Run Under',bbUnder:'No Walk',kUnder:'No Strikeout',sb:'Stolen Base',vsTeamHr:'Vs Team HR History (track record)',vsTeamCareer:'Historically Owns This Team (track record)',actionablesLeadoff:'Actionable · Leadoff',actionablesSecond:'Actionable · 2-Hole',hrpLive:'HR+ Live · Weather-Adjusted (track record)'};
  var _n=new Date();
  var _todayStr=_n.getFullYear()+'-'+String(_n.getMonth()+1).padStart(2,'0')+'-'+String(_n.getDate()).padStart(2,'0');
  var liveNote=data.date===_todayStr
    ? '<div style="margin-bottom:12px;padding:6px 10px;border:1px solid var(--warn);background:var(--warn-soft);font-size:.7rem;font-weight:600;color:var(--warn)">⏳ LIVE — today’s games are still in progress; results below update as at-bats happen and are final only after the last game ends.</div>'
    : '';
  var html=liveNote+'<p style="font-size:.75rem;color:var(--ink-3);margin-bottom:14px">'+
    data.date+' &nbsp;·&nbsp; '+data.gamesChecked+' game'+(data.gamesChecked!==1?'s':'')+' checked'+
    ' &nbsp;·&nbsp; '+data.playersMatched+' player-days matched</p>';

  // GRADED_EXTRA_CATS — must match lib/accuracy.js exactly. These are graded (shown with
  // Pred%/Actual%) but structurally excluded from recomputeCorrectionFactors, same as
  // every section further down this panel — this is the dividing line for the
  // Correctable/Observational split the whole panel is organized around.
  var GRADED_EXTRA_CATS=['recentK','kAutoOut','kMulti','vsTeamHr','vsTeamCareer','actionablesLeadoff','actionablesSecond','hrpLive'];
  var cal=data.calibration||{};
  function catCard(c){
    var d=cal[c],pred=Math.round(d.avgPred*100),actual=Math.round(d.actualRate*100),delta=actual-pred;
    var deltaCls=Math.abs(delta)<=5?'acc-delta-good':Math.abs(delta)<=10?'acc-delta-ok':'acc-delta-bad';
    return '<div class="acc-card"><div class="acc-card-label">'+CAT_LABELS[c]+'</div>'+
      '<div class="acc-card-stats">Pred: '+pred+'% &nbsp; Actual: '+actual+'% &nbsp; n='+d.n+'</div>'+
      '<div class="'+deltaCls+'">'+(delta>=0?'+':'')+delta+'%</div></div>';
  }
  var gradedCats=Object.keys(CAT_LABELS).filter(function(c){return cal[c]&&cal[c].n>0;});
  var correctableCats=gradedCats.filter(function(c){return GRADED_EXTRA_CATS.indexOf(c)===-1;});
  var observCats=gradedCats.filter(function(c){return GRADED_EXTRA_CATS.indexOf(c)!==-1;});
  html+='<div style="font-size:.68rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);margin-bottom:6px">Correctable &nbsp;<span style="font-weight:400;color:var(--ink-3);text-transform:none;letter-spacing:0">— feeds the live correction-factor loop</span></div>';
  html+=correctableCats.length?'<div class="acc-grid">'+correctableCats.map(catCard).join('')+'</div>':'<p style="color:var(--ink-3);font-size:.82rem">No matched predictions for this date.</p>';

  // ---------------------------------------------------------------------------
  // Observational Only — everything below this line is tracked purely for interest.
  // None of it feeds recomputeCorrectionFactors or any live probability.
  // ---------------------------------------------------------------------------
  html+='<div style="margin:22px 0 12px;padding-top:14px;border-top:2px solid var(--rule-2)">'+
    '<div style="font-size:.68rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2)">Observational Only</div>'+
    '<div style="font-size:.68rem;color:var(--ink-3);margin-top:2px">Tracked for interest — none of this feeds back into any live probability or correction factor.</div>'+
  '</div>';
  html+=observCats.length?'<div class="acc-grid">'+observCats.map(catCard).join('')+'</div>':'';



  var accStraights=data.straights||{};
  var stLabels={hrp:'HR+',walk:'BB',tb2:'2+ TB'};
  var stKeys=Object.keys(stLabels).filter(function(k){return (accStraights[k]||[]).length>0;});
  if(stKeys.length){
    var stWon=0,stTotal=0;
    stKeys.forEach(function(k){(accStraights[k]||[]).forEach(function(e){if(e.won!==null){stTotal++;if(e.won)stWon++;}});});
    var stRate=stTotal?Math.round(stWon/stTotal*100)+'%':'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-straights" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Straight Bets'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+stWon+'/'+stTotal+' correct ('+stRate+')</span>'+
      '</div>'+
      '<div id="acc-straights" style="display:none">';
    stKeys.forEach(function(k){
      var picks=accStraights[k]||[];
      var won=picks.filter(function(e){return e.won===true;}).length;
      var matched=picks.filter(function(e){return e.won!==null;}).length;
      html+='<div style="margin-bottom:8px"><div style="font-size:.68rem;color:var(--ink-3);margin-bottom:4px;font-weight:600">'+stLabels[k]+' &nbsp;'+won+'/'+matched+'</div>';
      picks.forEach(function(e){
        var occCls=e.won===true?'acc-occ-y':e.won===false?'acc-occ-n':'acc-occ-u';
        var occMark=e.won===true?'✓':e.won===false?'✗':'—';
        var odds=(e.americanOdds>0?'+':'')+e.americanOdds;
        html+='<div class="acc-detail-row">'+
          '<span class="'+occCls+'">'+occMark+'</span>'+
          '<span style="flex:1;color:var(--ink-2);font-size:.78rem">'+e.name+'</span>'+
          '<span style="color:var(--pos);font-size:.72rem;flex-shrink:0">'+odds+'</span>'+
          '<span style="color:var(--ink-3);font-size:.72rem;flex-shrink:0;margin-left:8px">'+Math.round(e.prob*100)+'%</span></div>';
      });
      html+='</div>';
    });
    html+='</div></div>';
  }

  var sk=data.streaks||{};
  var skSections=[
    {key:'hot',  list:sk.hot ||[], label:'HOT — Hit Streak Extended?', color:'var(--accent)', detail:function(e){return e.hitStreak+'g streak';}},
    {key:'fire', list:sk.fire||[], label:'FIRE — Still Hitting .400+?',  color:'var(--pos)', detail:function(e){return '.'+Math.round(e.avg7*1000)+' / '+e.ab7+'AB';}},
    {key:'cold', list:sk.cold||[], label:'COLD — Hitless Streak Continued?', color:'var(--ink-2)', detail:function(e){return e.hitlessStreak+'g hitless';}},
  ].filter(function(s){return s.list.length>0;});
  if(skSections.length){
    var skWon=0,skTotal=0;
    skSections.forEach(function(sec){sec.list.forEach(function(e){if(e.won!==null){skTotal++;if(e.won)skWon++;}});});
    var skRate=skTotal?Math.round(skWon/skTotal*100)+'%':'—';
    var skBlock='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-streaks" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Streaks'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+skWon+'/'+skTotal+' correct ('+skRate+')</span>'+
      '</div>'+
      '<div id="acc-streaks" style="display:none">';
    skSections.forEach(function(sec){
      var won=sec.list.filter(function(e){return e.won===true;}).length;
      var total=sec.list.filter(function(e){return e.won!==null;}).length;
      var pct=total?Math.round(won/total*100)+'%':'—';
      skBlock+='<div style="margin-bottom:10px"><div style="font-size:.68rem;color:'+sec.color+';margin-bottom:4px;font-weight:600">'+sec.label+' &nbsp;<span style="font-weight:400;color:var(--ink-3)">'+won+'/'+total+' ('+pct+')</span></div>';
      sec.list.forEach(function(e){
        var occCls=e.won===true?'acc-occ-y':e.won===false?'acc-occ-n':'acc-occ-u';
        var occMark=e.won===true?'✓':e.won===false?'✗':'—';
        skBlock+='<div class="acc-detail-row">'+
          '<span class="'+occCls+'">'+occMark+'</span>'+
          '<span style="flex:1;color:var(--ink-2);font-size:.78rem">'+e.name+' <span style="color:var(--ink-3)">('+e.team+')</span></span>'+
          '<span style="color:var(--ink-3);font-size:.72rem;flex-shrink:0">'+sec.detail(e)+'</span></div>';
      });
      skBlock+='</div>';
    });
    html+=skBlock+'</div></div>';
  }

  // ── Hit Drought section ──
  var dueHitRows=(data.dueHitResults||[]).filter(function(r){return !r.dnp;});
  if(dueHitRows.length){
    var dhWon=dueHitRows.filter(function(r){return r.won===true;}).length;
    var dhDone=dueHitRows.filter(function(r){return r.won!==null;}).length;
    var dhRate=dhDone>0?Math.round(dhWon/dhDone*100)+'%':'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-due-hit" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Hit Drought — Due Up'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+dhWon+'/'+dhDone+' got a hit ('+dhRate+')</span>'+
      '</div>'+
      '<div id="acc-due-hit" style="display:none">';
    dueHitRows.forEach(function(r){
      var occCls=r.won===true?'acc-occ-y':r.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=r.won===true?'✓':r.won===false?'✗':'—';
      var prob=Math.round(r.prob*100);
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.name+' <span style="color:var(--ink-3);font-size:.68rem">'+r.team+'</span></span>'+
        '<span class="acc-entry-prob" style="min-width:140px">0-for-'+r.hitlessAbs+' &nbsp;·&nbsp; .'+String(Math.round(r.seasonAvg*1000)).padStart(3,'0')+' avg</span>'+
        '<span class="acc-entry-prob" style="color:var(--neg)">'+prob+'% likely</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── HR Drought section ──
  var dueHrRows=(data.dueHrResults||[]).filter(function(r){return !r.dnp;});
  if(dueHrRows.length){
    var hrWon=dueHrRows.filter(function(r){return r.won===true;}).length;
    var hrDone=dueHrRows.filter(function(r){return r.won!==null;}).length;
    var hrRate=hrDone>0?Math.round(hrWon/hrDone*100)+'%':'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-due-hr" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> HR Drought — Due Up'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+hrWon+'/'+hrDone+' hit a HR ('+hrRate+')</span>'+
      '</div>'+
      '<div id="acc-due-hr" style="display:none">';
    dueHrRows.forEach(function(r){
      var occCls=r.won===true?'acc-occ-y':r.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=r.won===true?'✓':r.won===false?'✗':'—';
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.name+' <span style="color:var(--ink-3);font-size:.68rem">'+r.team+'</span></span>'+
        '<span class="acc-entry-prob" style="min-width:140px">'+r.absSinceHr+' AB dry &nbsp;·&nbsp; '+r.multiple+'× expected</span>'+
        '<span class="acc-entry-prob" style="color:var(--accent)">exp 1 HR/'+r.expectedAbsPerHr+' AB</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── Cy Old — did the flag hold up (no quality start that day)? ──
  var cyOldRows=(data.cyOldResults||[]).filter(function(r){return !r.dnp;});
  if(cyOldRows.length){
    var coWon=cyOldRows.filter(function(r){return r.won===true;}).length;
    var coDone=cyOldRows.filter(function(r){return r.won!==null;}).length;
    var coRate=coDone>0?Math.round(coWon/coDone*100)+'%':'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-cyold" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Cy Old'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+coWon+'/'+coDone+' failed to record a QS ('+coRate+')</span>'+
      '</div>'+
      '<div id="acc-cyold" style="display:none">';
    cyOldRows.forEach(function(r){
      var occCls=r.won===true?'acc-occ-y':r.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=r.won===true?'✓':r.won===false?'✗':'—';
      var actual=r.actualIp!=null?r.actualIp+' IP, '+r.actualEr+' ER':'—';
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.name+' <span style="color:var(--ink-3);font-size:.68rem">'+r.team+' vs '+r.opponent+'</span></span>'+
        '<span class="acc-entry-prob" style="min-width:140px">'+r.seasonFip.toFixed(2)+' season FIP</span>'+
        '<span class="acc-entry-prob" style="color:var(--ink-2)">'+actual+'</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── Per-game streak tags (Notable Runs/Who Sucks, frozen slate-wide) ──
  var stagRows=[].concat(data.streakTagHotResults||[], data.streakTagColdResults||[]).filter(function(r){return !r.dnp;});
  if(stagRows.length){
    var stagWon=stagRows.filter(function(r){return r.won===true;}).length;
    var stagDone=stagRows.filter(function(r){return r.won!==null;}).length;
    var stagRate=stagDone>0?Math.round(stagWon/stagDone*100)+'%':'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-streaktags" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Notable Runs / Who Sucks (per-game tags)'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+stagWon+'/'+stagDone+' held up ('+stagRate+')</span>'+
      '</div>'+
      '<div id="acc-streaktags" style="display:none">';
    stagRows.forEach(function(r){
      var occCls=r.won===true?'acc-occ-y':r.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=r.won===true?'✓':r.won===false?'✗':'—';
      var detail=r.type==='batter'
        ? (r.hitStreak?r.hitStreak+'g hit streak':r.hitlessStreak+'g hitless streak')
        : (r.recentEra!=null?r.recentEra.toFixed(2)+' ERA/3 starts':'—');
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.name+' <span style="color:var(--ink-3);font-size:.68rem">'+r.team+' · '+(r.type==='batter'?'batter':'pitcher')+'</span></span>'+
        '<span class="acc-entry-prob">'+detail+'</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── League-wide Streaks board (Research > Streaks) ──
  var sbData=data.streaksBoardResults||{};
  var sbRows=[].concat(sbData.battersHot||[], sbData.battersCold||[], sbData.pitchersHot||[], sbData.pitchersCold||[]).filter(function(r){return !r.dnp;});
  if(sbRows.length){
    var sbWon=sbRows.filter(function(r){return r.won===true;}).length;
    var sbDone=sbRows.filter(function(r){return r.won!==null;}).length;
    var sbRate=sbDone>0?Math.round(sbWon/sbDone*100)+'%':'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-streaksboard" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Streaks (league-wide board)'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+sbWon+'/'+sbDone+' held up ('+sbRate+')</span>'+
      '</div>'+
      '<div id="acc-streaksboard" style="display:none">';
    sbRows.forEach(function(r){
      var occCls=r.won===true?'acc-occ-y':r.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=r.won===true?'✓':r.won===false?'✗':'—';
      var isPitcher=r.era!=null;
      var detail=isPitcher?r.era.toFixed(2)+' ERA · '+r.tier:r.woba.toFixed(3)+' wOBA · '+r.tier;
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.name+' <span style="color:var(--ink-3);font-size:.68rem">'+r.team+'</span></span>'+
        '<span class="acc-entry-prob">'+detail+'</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── Matchup Score Accuracy ──
  var mqRows=(data.matchupResults||[]).filter(function(r){return !r.dnp;});
  if(mqRows.length){
    var mqWon=mqRows.filter(function(r){return r.won===true;}).length;
    var mqDone=mqRows.filter(function(r){return r.won!==null;}).length;
    var mqRate=mqDone>0?Math.round(mqWon/mqDone*100)+'%':'—';

    // Tier breakdown
    var tiers=[
      {label:'Score 10',   filter:function(r){return r.score===10;}, desc:'TB ≥ 3'},
      {label:'Score 8-9',  filter:function(r){return r.score>=8&&r.score<10;}, desc:'TB ≥ 2'},
      {label:'Score 5-7',  filter:function(r){return r.score>=5&&r.score<=7;}, desc:'TB ≥ 1'},
      {label:'Score 1-3',  filter:function(r){return r.score<=3;}, desc:'TB = 0'},
    ];
    var tierHtml='<div style="display:flex;gap:12px;flex-wrap:wrap;padding:8px 0 12px 0;border-bottom:1px solid var(--paper-2);margin-bottom:8px">';
    tiers.forEach(function(t){
      var rows=mqRows.filter(t.filter);
      var tw=rows.filter(function(r){return r.won===true;}).length;
      var td=rows.filter(function(r){return r.won!==null;}).length;
      var tr=td>0?Math.round(tw/td*100)+'%':'—';
      var clr=td>0?(tw/td>=0.60?'var(--pos)':tw/td>=0.40?'var(--warn)':'var(--neg)'):'var(--ink-3)';
      tierHtml+='<div style="background:var(--paper-2);border:1px solid var(--rule);border-radius:8px;padding:8px 12px;min-width:110px">'+
        '<div style="font-size:.65rem;color:var(--ink-3);font-weight:700;letter-spacing:.05em">'+t.label+'</div>'+
        '<div style="font-size:.88rem;font-weight:700;color:'+clr+';margin:2px 0">'+tw+'/'+td+' <span style="font-size:.7rem;font-weight:400">('+tr+')</span></div>'+
        '<div style="font-size:.62rem;color:var(--ink-2)">'+t.desc+'</div>'+
      '</div>';
    });
    tierHtml+='</div>';

    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-matchups" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Matchup Score Accuracy'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+mqWon+'/'+mqDone+' correct ('+mqRate+')</span>'+
      '</div>'+
      '<div id="acc-matchups" style="display:none">'+tierHtml;

    // Per-batter rows, grouped by score descending
    mqRows.slice().sort(function(a,b){return b.score-a.score;}).forEach(function(r){
      if(r.won===null) return;
      var occCls=r.won===true?'acc-occ-y':'acc-occ-n';
      var occMark=r.won===true?'✓':'✗';
      var tbLabel=r.score<=3?'Hitless needed':'TB ≥ '+r.tbThreshold+' needed';
      var actualStr=r.actualTb!=null?' · Got '+r.actualTb+' TB':'';
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span style="background:var(--paper-2);border-radius:4px;padding:1px 6px;font-size:.68rem;font-weight:700;color:var(--ink-3);flex-shrink:0">'+r.score+'</span>'+
        '<span class="acc-entry-name">'+r.batter+' <span style="color:var(--ink-2)">vs '+r.pitcher+' ('+r.pitcherHand+'HP)</span></span>'+
        '<span class="acc-entry-prob" style="min-width:130px">'+tbLabel+actualStr+'</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── Run Total (projection accuracy, not a bet) ──
  var ouRows=data.ouResults||[];
  if(ouRows.length){
    var rt=data.runTotalAccuracy||{};
    var rtHdr=rt.n?('MAE '+rt.mae+' · within 2: '+Math.round((rt.within2Pct||0)*100)+'% · bias '+(rt.bias>0?'+':'')+rt.bias):'—';
    var tvb=data.totalVsBookSummary||null;
    var vsBookStr2='';
    if(tvb && tvb.n){
      var maeDiff=(tvb.book.mae-tvb.us.mae);
      var betterCls=maeDiff>0?'var(--pos)':maeDiff<0?'var(--neg)':'var(--ink-3)';
      vsBookStr2=' · <span style="color:'+betterCls+'">us MAE '+tvb.us.mae+' vs book MAE '+tvb.book.mae+'</span>';
    }
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-ou" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Run Total (Projection)'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+rtHdr+vsBookStr2+'</span>'+
      '</div>'+
      '<div id="acc-ou" style="display:none">';
    if(tvb && tvb.n){
      html+='<div style="padding:6px 10px;font-size:.72rem;color:var(--ink-3);border-bottom:1px solid var(--ink-2)">'+
        'On '+tvb.n+' games with a book total: our MAE '+tvb.us.mae+' (bias '+(tvb.us.bias>0?'+':'')+tvb.us.bias+') vs '+
        'book MAE '+tvb.book.mae+' (bias '+(tvb.book.bias>0?'+':'')+tvb.book.bias+'). '+
        'Actual total landed OVER the book\'s line '+Math.round(tvb.bookOverRate*100)+'% of the time '+
        '(50% = no directional bias, just variance).</div>';
    }
    ouRows.forEach(function(r){
      var miss=r.actualTotal!=null?Math.abs(r.actualTotal-r.totalExpRuns):null;
      var occCls=miss==null?'acc-occ-u':miss<=2?'acc-occ-y':'acc-occ-n';
      var occMark=miss==null?'—':miss<=2?'✓':'✗';
      var actualStr=r.actualTotal!=null?' &nbsp;·&nbsp; Actual: '+r.actualTotal+' (miss '+miss.toFixed(1)+')':'';
      var bookStr='';
      if(r.bookTotal!=null){
        var bookMiss=r.actualTotal!=null?Math.abs(r.actualTotal-r.bookTotal):null;
        var bookCls=bookMiss==null?'acc-occ-u':bookMiss<=2?'acc-occ-y':'acc-occ-n';
        var bookMark=bookMiss==null?'—':bookMiss<=2?'✓':'✗';
        bookStr='<span class="acc-entry-prob" style="min-width:140px;color:var(--ink-3)">book: '+
          '<span class="'+bookCls+'">'+bookMark+'</span> '+r.bookTotal+' runs'+
          (bookMiss!=null?' (miss '+bookMiss.toFixed(1)+')':'')+'</span>';
      }
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.game+'</span>'+
        '<span class="acc-entry-prob" style="min-width:120px">Proj: '+r.totalExpRuns+' runs'+actualStr+'</span>'+
        bookStr+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── Projected Strikeouts (SP) — projection accuracy, not a bet ──
  var pkRows=data.spProjectedKResults||[];
  if(pkRows.length){
    var pka=data.spProjectedKAccuracy||{};
    var pkHdr=pka.n?('MAE '+pka.mae+' · within 2K: '+Math.round((pka.within2Pct||0)*100)+'% · bias '+(pka.bias>0?'+':'')+pka.bias):'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-projk" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Projected Strikeouts (SP)'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+pkHdr+'</span>'+
      '</div>'+
      '<div id="acc-projk" style="display:none">';
    pkRows.forEach(function(r){
      var miss=r.actualK!=null?Math.abs(r.actualK-r.projK):null;
      var occCls=miss==null?'acc-occ-u':miss<=2?'acc-occ-y':'acc-occ-n';
      var occMark=miss==null?'—':miss<=2?'✓':'✗';
      var actualStr=r.actualK!=null?' &nbsp;·&nbsp; Actual: '+r.actualK+'K (miss '+Math.abs(r.err).toFixed(1)+')':(r.dnp?' &nbsp;·&nbsp; DNP':'');
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.pitcher+' <span style="color:var(--ink-3);font-weight:400;font-size:.73rem">'+r.team+' vs '+r.opponent+'</span></span>'+
        '<span class="acc-entry-prob" style="min-width:140px">Proj: '+r.projK.toFixed(1)+'K'+actualStr+'</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── Moneyline section ──
  var mlRows=data.moneylineResults||[];
  if(mlRows.length){
    var mlWon=mlRows.filter(function(r){return r.won===true;}).length;
    var mlDone=mlRows.filter(function(r){return r.won!==null;}).length;
    var mlRate=mlDone>0?Math.round(mlWon/mlDone*100)+'%':'—';
    var mlSum=data.moneylineSummary||null;
    var vsBookStr='';
    if(mlSum && mlSum.n){
      var usPct=Math.round(mlSum.us.rate*100), bookPct=Math.round(mlSum.book.rate*100);
      var beatBy=usPct-bookPct;
      var beatCls=beatBy>0?'var(--pos)':beatBy<0?'var(--neg)':'var(--ink-3)';
      vsBookStr=' · <span style="color:'+beatCls+'">us '+usPct+'% vs book '+bookPct+'%</span>';
    }
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-ml" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Moneyline (Win Prediction)'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+mlWon+'/'+mlDone+' correct ('+mlRate+')'+vsBookStr+'</span>'+
      '</div>'+
      '<div id="acc-ml" style="display:none">';
    if(mlSum && mlSum.n){
      html+='<div style="padding:6px 10px;font-size:.72rem;color:var(--ink-3);border-bottom:1px solid var(--ink-2)">'+
        'On '+mlSum.n+' decided games: we picked the eventual winner '+mlSum.us.wins+'x ('+Math.round(mlSum.us.rate*100)+'%), '+
        'the book\'s de-vigged favorite won '+mlSum.book.wins+'x ('+Math.round(mlSum.book.rate*100)+'%). '+
        'We agreed with the book on '+mlSum.agreeCount+'/'+mlSum.n+' games'+
        (mlSum.agreeWinRate!=null?' (won '+Math.round(mlSum.agreeWinRate*100)+'% of those)':'')+
        (mlSum.disagreeCount?'; when we disagreed ('+mlSum.disagreeCount+'x), our pick won '+Math.round((mlSum.usWinRateOnDisagree||0)*100)+'% of the time':'')+
        '.</div>';
    }
    mlRows.forEach(function(r){
      var pct=Math.round(r.moneylineCallProb*100);
      var callLabel=r.moneylineCall==='HOME'?r.home+' ML':r.away+' ML';
      var occCls=r.won===true?'acc-occ-y':r.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=r.won===true?'✓':r.won===false?'✗':'—';
      var actualStr=r.actualHome!=null?' · '+r.away+' '+r.actualAway+', '+r.home+' '+r.actualHome:'';
      var bookStr='';
      if(r.bookPick){
        var bookPct2=r.bookPickProb!=null?Math.round(r.bookPickProb*100)+'%':'—';
        var bookOccCls=r.bookWon===true?'acc-occ-y':r.bookWon===false?'acc-occ-n':'acc-occ-u';
        var bookOccMark=r.bookWon===true?'✓':r.bookWon===false?'✗':'—';
        var agreeNote=r.agree===false?' <span style="color:var(--ink-3)">(disagree)</span>':'';
        bookStr='<span class="acc-entry-prob" style="min-width:150px;color:var(--ink-3)">book: '+
          '<span class="'+bookOccCls+'">'+bookOccMark+'</span> '+r.bookPick+' '+bookPct2+
          (r.bookPickML!=null?' ('+(r.bookPickML>0?'+':'')+r.bookPickML+')':'')+agreeNote+'</span>';
      }
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.game+'</span>'+
        '<span class="acc-entry-prob" style="min-width:140px">'+callLabel+actualStr+'</span>'+
        '<span class="acc-entry-prob">'+pct+'%</span>'+
        bookStr+
      '</div>';
    });
    html+='</div></div>';
  }

  // ── Game Spread section ──
  var spreadRows=data.spreadResults||[];
  if(spreadRows.length){
    var spWon=spreadRows.filter(function(r){return r.won===true;}).length;
    var spDone=spreadRows.filter(function(r){return r.won!==null;}).length;
    var spRate=spDone>0?Math.round(spWon/spDone*100)+'%':'—';
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="acc-spread" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> Run Line Spread (±1.5)'+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+spWon+'/'+spDone+' correct ('+spRate+')</span>'+
      '</div>'+
      '<div id="acc-spread" style="display:none">';
    spreadRows.forEach(function(r){
      var pct=Math.round(r.spreadCallProb*100);
      var callLabel=r.spreadCall==='HOME'?r.home+' −1.5':r.away+' +1.5';
      var occCls=r.won===true?'acc-occ-y':r.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=r.won===true?'✓':r.won===false?'✗':'—';
      var actualStr=r.actualHome!=null?' · '+r.away+' '+r.actualAway+', '+r.home+' '+r.actualHome:'';
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+r.game+'</span>'+
        '<span class="acc-entry-prob" style="min-width:120px">'+callLabel+actualStr+'</span>'+
        '<span class="acc-entry-prob">'+pct+'%</span>'+
      '</div>';
    });
    html+='</div></div>';
  }

  var entries=data.entries||{};
  // Ordered to MIRROR the probables tab's tiers : curated boards first, then
  // hitting, runs/situational, pitching, track record — the accuracy page reads in the
  // same order the picks are presented.
  var catOrder=['actionablesLeadoff','actionablesSecond',
    'hit','cold','tb','tb2','hrp','hrpLive','hrm',
    'runsOver','runsUnder','rbiOver','rbiUnder','walk','sb','bbUnder',
    'k','kAutoOut','kMulti','recentK','kUnder',
    'vsTeamHr','vsTeamCareer'];
  html+='<div style="margin-top:20px">';
  catOrder.forEach(function(cat){
    var list=entries[cat]||[];
    if(!list.length) return;
    var matched=list.filter(function(e){return e.won!==null;});
    var won=matched.filter(function(e){return e.won===true;}).length;
    var rate=matched.length>0?Math.round(won/matched.length*100)+'%':'—';
    var id='acc-cat-'+cat;
    html+='<div class="acc-section">'+
      '<div class="acc-section-hdr" data-catid="'+id+'" onclick="toggleAccCat(this.dataset.catid)">'+
        '<span>▶</span> '+CAT_LABELS[cat]+
        '<span style="color:var(--ink-3);font-weight:400;font-size:.72rem;margin-left:auto">'+won+'/'+matched.length+' correct ('+rate+')</span>'+
      '</div>'+
      '<div id="'+id+'" style="display:none">';
    list.forEach(function(e){
      var occCls=e.won===true?'acc-occ-y':e.won===false?'acc-occ-n':'acc-occ-u';
      var occMark=e.won===true?'✓':e.won===false?'✗':'—';
      html+='<div class="acc-entry-row">'+
        '<span class="'+occCls+'">'+occMark+'</span>'+
        '<span class="acc-entry-name">'+e.name+'</span>'+
        '<span class="acc-entry-prob">'+(e.prob!=null?Math.round(e.prob*100)+'%':'—')+'</span></div>';
    });
    html+='</div></div>';
  });
  html+='</div>';
  el.innerHTML=html;
}

function toggleAccCat(id){
  var el=document.getElementById(id);
  if(!el) return;
  var open=el.style.display!=='none';
  el.style.display=open?'none':'block';
  var hdr=el.previousElementSibling;
  if(hdr){
    var span=hdr.querySelector('span');
    if(span) span.textContent=open?'▶':'▼';
  }
}

function showWinOdds(){
  var was=winOddsVisible;
  closeAllNavPanelsAndMatchup();
  if(was){ restoreMatchupContent(); return; }
  winOddsVisible=true; setActiveNav('nav-win');
  var panel=document.getElementById('win-panel');
  panel.style.display='block';
  panel.innerHTML='<p style="color:var(--ink-3);font-size:.82rem;padding:6px 0">Loading win predictions...</p>';
  fetch('/api/win-probabilities').then(function(r){return r.json();}).then(function(d){
    winPredictions=d.predictions||[];
    updateGameCardWinBars();
    renderWinOdds(d);
  }).catch(function(){
    panel.innerHTML='<p style="color:var(--neg);font-size:.82rem">Failed to load win predictions.</p>';
  });
}

function fmtAmerican(n){ if(n==null)return '—'; return n>0?'+'+n:''+n; }
function fmtPts(x){ if(x==null)return '—'; var v=(x*100); return (v>=0?'+':'')+v.toFixed(1); }

function renderMarketBlock(m){
  if(!m||m.edge==null) return '';
  // Headline value = EV vs the actual price. >0 = +EV bet at this number.
  var ev=m.evVsPrice;
  var valCls = ev>=0.04 ? 'var(--pos)' : ev>=0.015 ? 'var(--warn)' : 'var(--ink-3)';
  var valBg  = ev>=0.04 ? 'var(--pos-soft)' : ev>=0.015 ? 'var(--warn-soft)' : 'var(--paper-2)';
  var valLabel = ev>=0.04 ? 'VALUE' : ev>=0.015 ? 'LEAN' : 'NO EDGE';
  var clvCls = m.clv==null ? 'var(--ink-3)' : m.clv>0 ? 'var(--pos)' : m.clv<0 ? 'var(--neg)' : 'var(--ink-3)';
  var clvStr = m.clv==null ? '' :
    '<span style="color:'+clvCls+'" title="Closing line value: how far the market has moved toward our pick since open">CLV '+fmtPts(m.clv)+'</span>';
  return '<div style="margin-top:8px;padding:7px 9px;border:1px solid var(--rule-2);border-left:3px solid '+valCls+';background:'+valBg+'">'+
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">'+
      '<div>'+
        '<span style="font-family:var(--f-display);font-size:.58rem;font-weight:800;letter-spacing:.06em;color:'+valCls+'">'+valLabel+'</span> '+
        '<span style="font-size:.74rem;font-weight:700;color:var(--ink)">'+m.pickAbbrev+' '+fmtAmerican(m.pickML)+'</span>'+
        '<span style="font-size:.64rem;color:var(--ink-3)"> &nbsp;'+(m.provider||'mkt')+'</span>'+
      '</div>'+
      '<div style="text-align:right">'+
        '<span style="font-size:.72rem;font-weight:700;color:'+valCls+'">edge '+fmtPts(m.edge)+'</span>'+
      '</div>'+
    '</div>'+
    '<div style="display:flex;justify-content:space-between;margin-top:3px;font-size:.63rem;color:var(--ink-2)">'+
      '<span>Model '+Math.round(m.ourPickProb*100)+'% &nbsp;vs&nbsp; Market '+Math.round(m.marketPickProb*100)+'% (fair)</span>'+
      clvStr+
    '</div>'+
  '</div>';
}

function renderWinOdds(data){
  var panel=document.getElementById('win-panel');
  var preds=data.predictions||[];
  // Surface the actionable edge-vs-market spots up top.
  var valuePlays=preds.filter(function(p){return p.market&&p.market.evVsPrice!=null&&p.market.evVsPrice>=0.04;})
    .sort(function(a,b){return b.market.evVsPrice-a.market.evVsPrice;});
  var edgeSummary='';
  if(preds.some(function(p){return p.market;})){
    if(valuePlays.length){
      var chips=valuePlays.map(function(p){
        return '<span style="display:inline-block;background:var(--pos-soft);color:var(--pos);border:1px solid var(--pos);border-radius:4px;padding:2px 7px;margin:2px 4px 2px 0;font-size:.66rem;font-weight:700">'+
          p.market.pickAbbrev+' '+fmtAmerican(p.market.pickML)+' &nbsp;'+fmtPts(p.market.evVsPrice)+'</span>';
      }).join('');
      edgeSummary='<div style="margin-bottom:12px;padding:8px 10px;background:var(--paper-2);border:1px solid var(--rule-2)">'+
        '<div style="font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin-bottom:4px">Value vs market ('+valuePlays.length+') — model edge ≥ +4pts at the price</div>'+
        chips+'</div>';
    } else {
      edgeSummary='<div style="margin-bottom:12px;padding:8px 10px;background:var(--paper-2);border:1px solid var(--rule-2);font-size:.66rem;color:var(--ink-3)">No +EV spots vs the market today — model agrees with the book on the full slate.</div>';
    }
  }
  var header=
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">'+
      '<span style="font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)">'+
        'Win Odds'+(preds.length?' &nbsp;·&nbsp; '+preds.length+' game'+(preds.length!==1?'s':''):'')+'</span>'+
      '<button onclick="showWinOdds()" style="background:none;border:none;color:var(--ink-3);cursor:pointer;font-size:.85rem;padding:0 4px">✕</button>'+
    '</div>'+edgeSummary;

  if(!preds.length){
    panel.innerHTML=header+'<p style="color:var(--ink-3);font-size:.82rem">No games preloaded yet — open any game matchup first, then reopen Win Odds.</p>';
    return;
  }

  var cards=preds.map(function(p){
    var hw=Math.round(p.home.winPct*100), aw=Math.round(p.away.winPct*100);
    var homeIsFav=p.home.winPct>=0.50;
    var gradStop=aw+'%';
    var barGrad='linear-gradient(to right,var(--ink-2) '+gradStop+',var(--accent) '+gradStop+')';
    var factors=p.factors.map(function(f){
      var cls='win-factor'+(f.side==='home'?' edge-home':f.side==='away'?' edge-away':'');
      return '<div class="'+cls+'"><span class="win-factor-label">'+f.label+':</span>'+f.detail+'</div>';
    }).join('');
    var marketBlock=renderMarketBlock(p.market);
    return '<div class="win-card">'+
      '<div class="win-card-title">'+p.away.abbrev+' @ '+p.home.abbrev+'</div>'+
      '<div class="win-card-sub">'+fmtTime(p.gameTime)+(p.venueName?' &nbsp;·&nbsp; '+p.venueName:'')+'</div>'+
      (fmtWeatherLive(p)?'<div class="win-card-sub" style="color:var(--ink-3);font-size:.66rem">'+fmtWeatherLive(p)+'</div>':'')+
      '<div class="win-bar-row">'+
        '<div class="win-bar-label">'+p.away.abbrev+' '+aw+'%</div>'+
        '<div class="win-bar-track"><div style="height:100%;background:'+barGrad+'"></div></div>'+
        '<div class="win-bar-label right">'+hw+'% '+p.home.abbrev+'</div>'+
      '</div>'+
      '<div class="win-odds-row">'+
        '<div class="win-odds-block">'+
          '<div class="wo-abbrev">'+p.away.abbrev+'</div>'+
          '<div class="wo-odds '+(homeIsFav?'dog':'fav')+'">'+p.away.odds+'</div>'+
        '</div>'+
        '<div class="win-sp-row">'+p.away.spName+' '+p.away.spEra+' ERA<br>vs<br>'+p.home.spName+' '+p.home.spEra+' ERA</div>'+
        '<div class="win-odds-block right">'+
          '<div class="wo-abbrev">'+p.home.abbrev+'</div>'+
          '<div class="wo-odds '+(homeIsFav?'fav':'dog')+'">'+p.home.odds+'</div>'+
        '</div>'+
      '</div>'+
      '<div class="win-factors">'+factors+'</div>'+
      marketBlock+
      '<div style="display:flex;gap:10px;margin-top:8px;padding-top:8px;border-top:1px solid var(--paper-2)">'+
        '<div style="flex:1;background:var(--paper-2);border-radius:6px;padding:6px 8px">'+
          '<div style="font-size:.58rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:2px">Projected Total</div>'+
          '<div style="font-size:.80rem;font-weight:700;color:var(--ink-2)">'+p.totalExpRuns+' runs</div>'+
          '<div style="font-size:.65rem;color:var(--ink-3)">model projection</div>'+
        '</div>'+
        '<div style="flex:1;background:var(--paper-2);border-radius:6px;padding:6px 8px">'+
          '<div style="font-size:.58rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-2);margin-bottom:2px">Run Line ±1.5</div>'+
          '<div style="font-size:.80rem;font-weight:700;color:var(--ink-2)">'+(p.spreadCall==='HOME'?p.home.abbrev+' −1.5':p.away.abbrev+' +1.5')+'</div>'+
          '<div style="font-size:.65rem;color:var(--ink-3)">'+(Math.round(p.spreadCallProb*100))+'% cover probability</div>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');

  panel.innerHTML=header+'<div class="win-grid">'+cards+'</div>';
}

function updateGameCardWinBars(){
  for(var i=0;i<winPredictions.length;i++){
    var p=winPredictions[i];
    var gc=document.getElementById('gc-'+p.gamePk);
    if(!gc) continue;
    var existing=gc.querySelector('.gc-win');
    if(existing) existing.remove();
    var hw=Math.round(p.home.winPct*100), aw=Math.round(p.away.winPct*100);
    var gradStop=aw+'%';
    var div=document.createElement('div');
    div.className='gc-win';
    div.innerHTML=
      '<div class="gc-win-teams"><span>'+p.away.abbrev+' '+aw+'%</span><span>'+hw+'% '+p.home.abbrev+'</span></div>'+
      '<div style="height:3px;background:linear-gradient(to right,var(--ink-2) '+gradStop+',var(--accent) '+gradStop+')"></div>'+
      '<div class="gc-win-odds"><span>'+p.away.odds+'</span><span>'+p.home.odds+'</span></div>';
    gc.appendChild(div);
  }
}

function fmtTime(iso){
  if(!iso)return 'TBD';
  return new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/Chicago',timeZoneName:'short'});
}

// Wind color scale tied to the model's own calibrated HR-effect formula (weatherHrMult in
// lib/weather.js: +1.8%/mph out-wind, capped +25%; in-wind suppresses, floored -55%) —
// not an arbitrary cutoff. Any in-wind is red (it's suppressing HR odds, full stop).
// Calm or an out-wind too weak to matter (<6mph out, ~<11% HR bump) is amber. A real,
// meaningful out-wind (6mph+, ~11%+ HR bump) is green.
function windColor(outWindMph){
  if(outWindMph == null) return 'var(--ink-3)';
  if(outWindMph < 0) return 'var(--neg)';
  if(outWindMph < 6) return 'var(--warn)';
  return 'var(--pos)';
}

function windDir(s){
  s=(s||'').toLowerCase();
  if(s.includes('out to cf'))  return '<span class="wx-wind-out">Out→CF</span>';
  if(s.includes('out to lf'))  return '<span class="wx-wind-out">Out→LF</span>';
  if(s.includes('out to rf'))  return '<span class="wx-wind-out">Out→RF</span>';
  if(s.includes('out'))        return '<span class="wx-wind-out">Blowing Out</span>';
  if(s.includes('in from cf')) return '<span class="wx-wind-in">In←CF</span>';
  if(s.includes('in from'))    return '<span class="wx-wind-in">Blowing In</span>';
  if(s.includes('l to r'))     return 'L→R';
  if(s.includes('r to l'))     return 'R→L';
  return '';
}

function fmtWeatherLive(g){
  var w=g&&g.weatherLive; if(!w||w.tempF==null) return '';
  var gameHour = g.gameTime ? parseInt(new Date(g.gameTime).toLocaleString('en-US',{hour:'numeric',hour12:false,timeZone:'America/Chicago'}),10) : -1;
  var isNight  = gameHour < 0 || gameHour >= 17 || gameHour < 11;
  var wind;
  if(w.roof==='Dome') wind='Roof closed';
  else if(w.roof==='Retractable' && w.windDesc==='Roof closed') wind='Roof closed';
  else {
    var wTxt = w.windLabel || (w.windMph!=null?w.windMph+'mph '+w.windDesc:'');
    wind = '<span style="color:'+windColor(w.outWindMph)+';font-weight:600">'+wTxt+'</span>';
  }
  // Precise, hour-by-hour breakdown instead of a vague "fading"/"building" label — each
  // point shows its own exact mph + park-relative direction (first pitch, +2h, +4h), each
  // colored on the same green/amber/red scale so the trend reads at a glance.
  var trend='';
  if(w.windTrend && w.windTrend.points && w.windTrend.points.length>1){
    var labels={0:'First pitch',2:'+2h',4:'+4h'};
    var pieces=w.windTrend.points.map(function(p){
      var ptTxt=(p.windLabel||Math.round(p.outWindMph)+'mph');
      return (labels[p.hoursFromStart]||('+'+p.hoursFromStart+'h'))+': <span style="color:'+windColor(p.outWindMph)+'">'+ptTxt+'</span>';
    });
    trend=' &nbsp;·&nbsp; <span style="color:var(--ink-3)" title="Live forecast, updates hourly">'+pieces.join(' &rarr; ')+'</span>';
  }
  var glare='';
  if(w.sunGlare && (w.sunGlare.rating==='high'||w.sunGlare.rating==='moderate')){
    var gc = w.sunGlare.rating==='high' ? 'var(--neg)' : 'var(--warn)';
    glare=' &nbsp;·&nbsp; <span style="color:'+gc+';font-weight:700" title="Sun low in the hitters\' sightline — tougher ABs, offense suppressed">&#9728; sun glare'+(w.sunGlare.rating==='high'?'':' (mod)')+'</span>';
  }
  var heat='';
  if(w.heatFlag==='extreme'||w.heatFlag==='hot'){
    var hc = w.heatFlag==='extreme' ? 'var(--neg)' : 'var(--warn)';
    heat=' &nbsp;·&nbsp; <span style="color:'+hc+';font-weight:700" title="Heat index (feels-like) — extreme >=100F. Open-park exposure; monitored for fatigue effect.">&#128293; feels '+w.feelsLikeF+'°F</span>';
  }
  return w.tempF+'°F &nbsp;·&nbsp; '+(isNight?'Night':'Day')+(wind?' &nbsp;·&nbsp; '+wind:'')+trend+glare+heat;
}

function fmtWeather(g){
  var gameHour = g.gameTime ? parseInt(new Date(g.gameTime).toLocaleString('en-US',{hour:'numeric',hour12:false,timeZone:'America/Chicago'}),10) : -1;
  var isNight  = gameHour < 0 || gameHour >= 17 || gameHour < 11;
  var wl = g.weatherLive;
  var w = g.weather;

  if((!wl || wl.tempF==null) && (!w || (!w.temp && !w.condition && !w.wind))){
    return '<div class="game-weather">'+(isNight?'Night':'Day')+'</div>';
  }

  var parts=[];
  // Prefer the live forecast (matches the header/prop-note source) over MLB's static,
  // one-time report — mixing the two was exactly what produced two different-looking
  // wind readings for the same game in the same view.
  if(wl && wl.tempF!=null){
    parts.push(wl.tempF+'°F');
    parts.push(isNight?'Night':'Day');
    if(wl.roof==='Dome' || (wl.roof==='Retractable' && wl.windDesc==='Roof closed')){
      parts.push('Roof closed');
    } else {
      var wlTxt = wl.windLabel || (wl.windMph!=null ? wl.windMph+'mph' : 'Calm');
      parts.push('<span style="color:'+windColor(wl.outWindMph)+';font-weight:600">'+wlTxt+'</span>');
    }
  } else {
    var temp = parseInt(w.temp)||0;
    parts.push(temp?temp+'°F':'—');
    parts.push(isNight?'Night':'Day');
    var windStr = w.wind||'';
    var mphMatch = windStr.match(/(\d+)/);
    var mph = mphMatch ? parseInt(mphMatch[1]) : 0;
    if(mph < 4){ parts.push('Calm'); }
    else { var dir = windDir(windStr); parts.push(mph+'mph'+(dir?' '+dir:'')); }
  }

  var cond = (w && w.condition || '').toLowerCase();
  if(cond.includes('rain')||cond.includes('shower'))
    parts.push('<span class="wx-rain">Rain</span>');
  else if(cond.includes('drizzle'))
    parts.push('<span class="wx-rain">Drizzle</span>');
  else if(cond.includes('snow'))
    parts.push('<span class="wx-snow">Snow</span>');
  else if(cond.includes('thunder')||cond.includes('storm'))
    parts.push('<span class="wx-rain">T-Storm</span>');

  return '<div class="game-weather">'+parts.join(' · ')+'</div>';
}

init();
// Deep links: #charts opens the Charts view directly (optionally #charts/<key>,
// e.g. #charts/roi) — linkable chart states, same idea as the NFL side.
(function(){
  var h=location.hash.slice(1);
  if(h.indexOf('charts')===0){
    var seg=h.split('/')[1]||'';           // "#charts/hrLuck:soto" — key + optional search
    var k=seg.split(':')[0], q=decodeURIComponent(seg.split(':')[1]||'');
    if(k&&MLB_CHARTS[k]) mlbChartState.chart=k;
    if(q) mlbChartState.q=q;
    showCharts();
  }
})();
