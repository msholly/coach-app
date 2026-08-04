"use strict";
(function(){
  var BASE="ayso-coach-v2";   // localStorage namespace
  var KEY=BASE;               // becomes BASE + ":" + teamId once a team is known
  var TEAM=null;              // team token (also the share-link id); null = local-only

  /* drill data lives in drills.js (global DRILLS) */


  /* ---------- state ---------- */
  var state=null, meta=null;     // assigned in boot()
  function nowMs(){ return Date.now(); }

  // One flag serves the BU5 season permanently and a ref-less U8 Saturday
  // occasionally — a format preset, not a second app (decision 7).
  // ⚠ The BU5 numbers are a best guess: Region 630's BU5 format isn't in the
  // U8 guide. They're editable in the UI, so a wrong default is a nuisance.
  var FORMATS={
    u8:  {label:"U8 · 6v6 w/ keeper", keeper:true,  periods:4, onfield:6, minsper:10},
    bu5: {label:"BU5 · no keeper",    keeper:false, periods:4, onfield:4, minsper:8}
  };
  function fmt(){ return FORMATS[state.format]||FORMATS.u8; }

  function load(){
    try{ var s=JSON.parse(localStorage.getItem(KEY)); if(s&&s.roster){ fixup(s); migrate(s); return s; } }catch(e){}
    return {
      team:"",
      roster:["Bearett","Neel","Jeffrey","Oliver","Reyansh","Zendrix","Connor","George"]
        .map(function(n,i){return {id:"seed"+i,name:n,present:true};}),
      periods:4, onfield:6, minsper:10,
      format:"u8",
      season:"Fall 2026",       // the ledger-reset boundary, stamped on every archive row
      posTotals:{},             // season D/F/GK periods from the archive — cached for offline
      practice:[], lineup:null,
      played:{},   // career periods played, by player id — drives "rotate this responsibility"
      kept:{},     // career periods in goal, by player id
      game:{us:0,them:0,period:1,secs:600,running:false}
    };
  }
  // Docs written by older versions of the app (or another device mid-upgrade).
  function fixup(s){
    if(!s.played) s.played={};
    if(!s.kept) s.kept={};
    if(!s.format) s.format="u8";
    if(!s.season) s.season="Fall 2026";
    if(!s.posTotals) s.posTotals={};
    if(s.lineup){
      if(s.lineup.keeper==null) s.lineup.keeper=true;   // every pre-format lineup was U8
      LineupCore.ensureApp(s.lineup);
    }
  }
  // Older saves banked the plan straight into the career totals. Move the live game back
  // out into its own ledger so it can be corrected before it's committed.
  function migrate(s){
    if(!s.lineup || s.lineup.actual) return;
    s.lineup.actual={}; s.lineup.gkActual={};
    (s.lineup.periods||[]).forEach(function(f){ f.forEach(function(id){
      s.lineup.actual[id]=(s.lineup.actual[id]||0)+1; s.played[id]=(s.played[id]||0)-1; }); });
    (s.lineup.gk||[]).forEach(function(id){ if(id){
      s.lineup.gkActual[id]=(s.lineup.gkActual[id]||0)+1; s.kept[id]=(s.kept[id]||0)-1; } });
  }
  function loadMeta(){ try{ return JSON.parse(localStorage.getItem(KEY+":meta"))||{rev:0,updatedAt:0,syncedAt:0}; }catch(e){ return {rev:0,updatedAt:0,syncedAt:0}; } }
  function saveMeta(){ try{ localStorage.setItem(KEY+":meta",JSON.stringify(meta)); }catch(e){} }
  function saveLocal(){ try{ localStorage.setItem(KEY,JSON.stringify(state)); }catch(e){} }
  // save() = persist locally, mark this device ahead of the server, and schedule a sync push.
  function save(){ saveLocal(); if(meta){ meta.updatedAt=nowMs(); saveMeta(); } schedulePush(); }

  var $=function(s,r){return (r||document).querySelector(s);};
  var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  function toast(msg){ var t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(t._t); t._t=setTimeout(function(){t.classList.remove("show");},1900); }

  /* ---------- tabs ---------- */
  $$(".tab").forEach(function(b){
    b.addEventListener("click",function(){
      $$(".tab").forEach(function(x){x.setAttribute("aria-selected","false");});
      b.setAttribute("aria-selected","true");
      $$(".panel").forEach(function(p){p.classList.remove("active");});
      $("#p-"+b.dataset.tab).classList.add("active");
      if(b.dataset.tab==="game"){ renderGame(); renderLog(); }
    });
  });

  /* ---------- roster ---------- */
  function renderRoster(){
    var ul=$("#rosterList");
    ul.innerHTML=state.roster.map(function(p,i){
      return '<li class="'+(p.present?"":"out")+'" data-id="'+p.id+'">'
        +'<span class="pnum">'+(i+1)+'</span>'
        +'<span class="pname">'+esc(p.name)+'</span>'
        +'<button class="toggle no-print" data-act="toggle-present" data-id="'+p.id+'">'+(p.present?"IN":"OUT")+'</button>'
        +'<button class="icon no-print" data-act="del-player" data-id="'+p.id+'" title="Remove">×</button>'
        +'</li>';
    }).join("");
    var n=state.roster.filter(function(p){return p.present;}).length;
    $("#presentCount").innerHTML="<b>"+n+"</b> present of "+state.roster.length+" · field size "+state.onfield+" ⇒ "+Math.max(0,n-state.onfield)+" on the bench each period";
  }

  /* ---------- lineup ---------- */
  // Fairness runs across games, and it runs on time ACTUALLY played, not on the plan:
  //   state.played / state.kept   career periods from games already finished
  //   lu.actual / lu.gkActual     this game only — fractional once anyone subs mid-period
  // "Build lineup" starts a new game and banks the outgoing game's ledger into the career
  // totals. Everything else (reshuffle, roster edit, settings) redraws the SAME game, and
  // only ever rewrites periods that haven't been played yet.
  function totPlayed(lu,id){ return (state.played[id]||0) + ((lu&&lu.actual[id])||0); }
  function totKept(lu,id){ return (state.kept[id]||0) + ((lu&&lu.gkActual[id])||0); }

  var tally=LineupCore.tally;   // extracted behind node --test (plan item 4)
  function commitGame(lu){
    if(!lu) return;
    Object.keys(lu.actual||{}).forEach(function(id){ state.played[id]=(state.played[id]||0)+lu.actual[id]; });
    Object.keys(lu.gkActual||{}).forEach(function(id){ state.kept[id]=(state.kept[id]||0)+lu.gkActual[id]; });
  }
  // Periods already played — and the one being played right now — are history. A rebuild
  // must not rewrite them, or the minutes those kids actually got vanish from the ledger.
  function frozenUpto(){
    var g=state.game;
    if(!state.lineup) return 0;
    var underway = g.started || g.period>1 || g.us || g.them;
    return underway ? Math.min(g.period, state.lineup.Q, state.periods) : 0;
  }

  function buildLineup(reshuffle,replace){
    var g=state.game;
    if(!replace && state.lineup && (g.period>1||g.us||g.them)
       && !confirm("Start a new game? The score and period reset.\n\nTo redraw this game's sheet instead, cancel and use ↻ Reshuffle.")) return false;

    var keep = replace ? frozenUpto() : 0;
    var present=state.roster.filter(function(p){return p.present;});
    if(present.length < state.onfield){
      if(state.lineup && keep){
        // Mid-game and short-handed: keep what was played, blank the periods we can't fill.
        tally(state.lineup,keep,-1);
        state.lineup.periods.length=keep; state.lineup.gk.length=keep;
        (state.lineup.app=state.lineup.app||[]).length=keep;
        while(state.lineup.periods.length<state.lineup.Q){ state.lineup.periods.push([]); state.lineup.gk.push(null); state.lineup.app.push([]); }
      } else if(state.lineup){ state.lineup=null; }
      save(); renderLineup(); renderGame();
      toast("Need at least "+state.onfield+" present players");
      return false;
    }

    if(!replace){
      closeGameRow();                        // the outgoing game's archive row gets its full-time stamp
      commitGame(state.lineup);              // new game: last game's actual minutes go on the books
    }
    var lu = keep ? state.lineup : {periods:[],gk:[],actual:{},gkActual:{},app:[]};
    var wasHandEdited = keep===0 && !!(state.lineup&&state.lineup.handEdited);
    if(keep){ tally(lu,keep,-1); lu.periods.length=keep; lu.gk.length=keep; (lu.app=lu.app||[]).length=keep; }

    var order=present.slice();
    if(reshuffle){ for(var i=order.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=order[i];order[i]=order[j];order[j]=t; } }
    // Most-owed first, counting what's already happened this game. Stable: ties keep roster/shuffle order.
    order.sort(function(a,b){ return totPlayed(lu,a.id)-totPlayed(lu,b.id); });

    var Q=state.periods, N=state.onfield;
    // Keeper (fewest career keeps, one period max) and D/F seeding (least
    // experience at the position first — decision 4) both live in the core.
    LineupCore.buildPeriods(lu, order.map(function(p){return p.id;}),
      {keep:keep, Q:Q, N:N, keeper:fmt().keeper, kept:state.kept, posTotals:state.posTotals});
    // Anyone who played a frozen period stays on the sheet even if they've since gone home.
    var ids=order.map(function(p){return p.id;});
    for(var z=0;z<keep;z++){ lu.periods[z].forEach(function(id){ if(ids.indexOf(id)<0) ids.push(id); }); }
    lu.playerOrder=ids; lu.Q=Q; lu.N=N; lu.minsper=state.minsper; lu.keeper=fmt().keeper;
    lu.handEdited=false;
    tally(lu,keep,1);

    state.lineup=lu;
    if(!replace){
      g.period=1; g.us=0; g.them=0; g.running=false; g.started=false; g.secs=state.minsper*60;
      g.gid=genToken(); g.startedAt=0; g.endedAt=0;   // archive identity — kickoff works offline
      stopTicker();
    }
    save(); renderLineup(); renderGame();
    // Finding 2.1's stopgap: a pre-kickoff rebuild redraws hand-placed positions — say so.
    if(replace && wasHandEdited) toast("Sheet redrawn — hand-placed keeper/positions were reset.");
    return true;
  }

  // Any roster or settings change makes the future of the sheet wrong. Redraw that part.
  function refreshLineup(){ if(state.lineup) buildLineup(false,true); }

  // Guide line 46: safety and injury subs at any time, re-entry allowed in the same period.
  // The period's credit splits at the clock, so the season ledger reflects real minutes.
  function subNow(outId,inId){
    var lu=state.lineup; if(!lu) return;
    var pi=curPi();
    var frac=Math.min(1,Math.max(0, state.game.secs/Math.max(1,state.minsper*60)));   // what's left is what the sub plays
    if(!LineupCore.applySub(lu,pi,outId,inId,frac)) return;
    logEvent("sub",{out:outId,"in":inId,frac:Math.round(frac*1000)/1000},inId);
    queueAppearances(pi+1);
    save(); renderLineup(); renderGame();
    var msg=nameOf(inId)+" on for "+nameOf(outId)+" — "+r1(frac*state.minsper)+" min credited";
    // The sub may already be down for a period in goal later; the guide caps that at one.
    if((lu.gkActual[inId]||0)>1.0001) msg+=". Careful — that puts them over a period in goal.";
    toast(msg);
  }
  function curPi(){ return Math.min(state.game.period-1, state.lineup.Q-1); }

  // Requirement 1: swap who's in goal without anyone leaving the field.
  function swapKeeper(newId){
    var lu=state.lineup; if(!lu||!lu.keeper||!newId) return;
    var pi=curPi(), old=lu.gk[pi];
    var frac=Math.min(1,Math.max(0, state.game.secs/Math.max(1,state.minsper*60)));
    if(!LineupCore.applyKeeperSwap(lu,pi,newId,frac)) return;
    if(!state.game.started) lu.handEdited=true;
    logEvent("keeper",{out:old,"in":newId},newId);
    queueAppearances(pi+1);
    save(); renderLineup(); renderGame();
    var msg=nameOf(newId)+" in goal for "+nameOf(old)+" — "+r1(frac*state.minsper)+" min in goal credited";
    if((lu.gkActual[newId]||0)>1.0001) msg+=". Careful — that puts them over a period in goal.";
    toast(msg);
  }

  // Tap-to-select, tap-to-place (decision on req 4: forgiving beats drag on a
  // sideline). Field+field = position swap (GK involved → keeper swap);
  // field+bench in either order = a sub.
  var sel=null;   // {id, where:"field"|"bench"}
  function tapChip(id,where){
    var lu=state.lineup; if(!lu) return;
    if(sel&&sel.id===id&&sel.where===where){ sel=null; renderOnField(); return; }
    if(!sel){ sel={id:id,where:where}; renderOnField(); return; }
    var a=sel; sel=null;
    var pi=curPi();
    if(a.where==="field"&&where==="field"){
      var gkNow=lu.gk[pi];
      if(id===gkNow){ swapKeeper(a.id); }
      else if(a.id===gkNow){ swapKeeper(id); }
      else if(LineupCore.applyPosSwap(lu,pi,a.id,id)){
        if(!state.game.started) lu.handEdited=true;
        queueAppearances(pi+1);
        save(); renderLineup(); renderGame();
        toast(nameOf(a.id)+" ↔ "+nameOf(id));
      } else renderOnField();
    }
    else if(a.where==="field"&&where==="bench"){ subNow(a.id,id); }
    else if(a.where==="bench"&&where==="field"){ subNow(id,a.id); }
    else renderOnField();
  }
  function r1(v){ return Math.round(v*10)/10; }

  function renderLineup(){
    var out=$("#lineupOut");
    if(!state.lineup){ out.innerHTML='<div class="empty">Mark who\'s present, then <b>Build lineup</b> to see the rotation sheet.</div>'; return; }
    var lu=state.lineup, Q=lu.Q, mp=lu.minsper, gk=lu.gk||[];
    var players=lu.playerOrder.map(function(id){return state.roster.filter(function(p){return p.id===id;})[0];}).filter(Boolean);
    // "Plays" is actual time, not the plan — a mid-period sub shows up as a fraction.
    var counts=players.map(function(p){ return lu.actual[p.id]||0; });
    var mx=counts.length?Math.max.apply(null,counts):0;
    var seasons=players.map(function(p){ return totPlayed(lu,p.id); });
    var loS=seasons.length?Math.min.apply(null,seasons):0, hiS=seasons.length?Math.max.apply(null,seasons):0;
    var owedSet={};   // whoever is furthest behind goes to the front of the next sheet
    if(hiS-loS>1e-9) players.forEach(function(p,i){ if(seasons[i]<=loS+1e-9) owedSet[p.id]=1; });
    // Season position ratio (decision 6: one decimal, the honest number) —
    // archive cache plus this game's ledger.
    var posTot=LineupCore.positionTotals(lu,state.posTotals);
    var head="<tr><th>Player</th>";
    for(var q=0;q<Q;q++){ head+="<th>P"+(q+1)+"</th>"; }
    head+="<th>Plays</th><th>Season</th><th>D · F</th></tr>";
    var body=players.map(function(p,i){
      var cells="";
      for(var q=0;q<Q;q++){
        if(lu.periods[q].indexOf(p.id)<0) cells+='<td class="bench"></td>';
        else if(gk[q]===p.id) cells+='<td><span class="on gk">GK</span></td>';
        else cells+='<td><span class="on">'+(LineupCore.posInPeriod(lu,q,p.id)||"✓")+'</span></td>';
      }
      // AYSO is comparative — nobody gets a full slate until everyone is within one of it.
      // The rotation keeps counts within 1, so this is a guard, not a routine warning.
      var under = mx>=Q && counts[i]<Q-1;
      var t=posTot[p.id]||{D:0,F:0};
      var emptyBucket=(t.D<1e-9||t.F<1e-9);   // requirement 3: colour when a bucket is empty
      return '<tr class="'+(under?"under":"")+'"><th>'+esc(p.name)+'</th>'+cells
        +'<td class="tot">'+r1(counts[i])+" of "+Q+"</td>"
        +'<td class="tot season'+(owedSet[p.id]?" owed":"")+'">'+r1(seasons[i])+"</td>"
        +'<td class="pos'+(emptyBucket?" owed":"")+'">'+r1(t.D)+" · "+r1(t.F)+"</td></tr>";
    }).join("");
    var foot="<tr><td>On field</td>";
    for(var q2=0;q2<Q;q2++){ foot+="<td>"+lu.periods[q2].length+"</td>"; }
    foot+="<td></td><td></td><td></td></tr>";
    out.innerHTML='<div class="tablewrap"><table class="lineup"><thead>'+head+'</thead><tbody>'+body+'</tbody><tfoot>'+foot+'</tfoot></table></div>'
      +'<div class="legend-min"><span><b>'+(Q*mp)+' min</b> game · '+mp+' min/period</span>'
      +'<span><span class="on" style="width:14px;height:14px;line-height:14px;font-size:9px">D</span> defense · <span class="on" style="width:14px;height:14px;line-height:14px;font-size:9px">F</span> forward</span>'
      +(lu.keeper?'<span><span class="on gk" style="width:20px;height:14px;line-height:14px;font-size:8px">GK</span> in goal — one period each</span>':'')
      +'<span><b>Season</b> = periods played all season, this game included. The builder starts the next sheet with whoever is lowest.</span>'
      +'<span><b>D · F</b> = season periods by position — a ratio to inform the call, not a rule. Swap on Game Day by tapping two players.</span></div>'
      +'<div class="slack">'+slackNote(players,counts,seasons,lu)+'</div>';
  }

  // A game hands out Q x N field-periods among however many turn up. When that divides
  // evenly there is no spare period, so the builder has nothing to repay an owed player
  // with — worth saying out loud, because 8 present at 6v6 x 4 divides exactly and a coach
  // with full attendance would otherwise think the season ledger does nothing.
  function slackNote(players,counts,seasons,lu){
    if(!players.length) return "";
    var Q=lu.Q, N=lu.N, L=players.length, slots=Q*N;
    var hi=Math.max.apply(null,counts), lo=Math.min.apply(null,counts);
    var nHi=counts.filter(function(v){return v>hi-1e-9;}).length;
    var txt;
    if(hi-lo<1e-9){
      txt="<b>No spare periods this game.</b> "+slots+" field-periods ÷ "+L+" present = "+r1(hi)
         +" each, exactly. The rotation has no room to pay anyone back, so anything owed carries.";
      // Only turnouts this squad can actually field are worth naming.
      var can=[]; for(var t=N;t<=state.roster.length;t++){ if(slots%t!==0) can.push(t); }
      txt+= can.length
        ? " With "+state.roster.length+" on the roster, a spare period only turns up when "+can.join(" or ")+" are available."
        : " No turnout this squad can field leaves a spare period, so the ledger only moves through mid-period subs.";
    } else {
      txt="<b>"+nHi+" play "+r1(hi)+", "+(L-nHi)+" play "+r1(lo)+".</b> The spare periods went to whoever was furthest behind on the season.";
    }
    var loS=Math.min.apply(null,seasons), hiS=Math.max.apply(null,seasons);
    if(hiS-loS>1e-9){
      var owed=players.filter(function(p,i){return seasons[i]<=loS+1e-9;}).map(function(p){return p.name;});
      var shown=owed.slice(0,3).join(", ")+(owed.length>3?" and "+(owed.length-3)+" more":"");
      txt+=" <b>Owed most:</b> "+esc(shown)+" on "+r1(loS)+" against "+r1(hiS)
        +" for the team's highest — they go to the front of the next sheet.";
    }
    return txt;
  }

  function renderFormatNote(){
    var f=fmt(), Q=state.periods, N=state.onfield, mp=state.minsper;
    var std=(Q===f.periods&&N===f.onfield);
    if(state.format==="bu5"){
      $("#fmtHint").innerHTML = "<b>BU5 · no goalkeepers.</b> Everyone still plays and time is shared evenly. ⚠ The preset numbers are a best guess — confirm periods, field count and period length with Region 630 before the first game.";
      $("#ruleNote").textContent = "BU5: no goalkeepers, everyone plays. The builder shares bench time evenly and remembers who sat last game.";
    } else {
      $("#fmtHint").innerHTML = std
        ? "AYSO Region 630 U8: 6v6 with keeper · every player ≥3 of 4 quarters before anyone gets a 4th · goalkeepers rotate, one quarter each — the builder picks them."
        : "<b>Non-standard format.</b> Region 630 U8 is 6v6 across 4 quarters; you have "+N+"v"+N+" across "+Q+" periods. Time is still shared evenly, but the printed sheet is not the AYSO default.";
      $("#ruleNote").textContent = std
        ? "AYSO Region 630 U8: every player gets at least 3 of 4 quarters before anyone plays a 4th; goalkeepers rotate, one quarter each. The builder shares bench time evenly and remembers who sat last game."
        : "Region 630 U8 standard is 4 quarters of 6v6; this sheet is set to "+Q+" periods of "+N+"v"+N+". Bench time is still shared evenly, and the builder remembers who sat last game.";
    }
    $("#fmtNote").textContent = "Set to "+Q+" × "+mp+" min ("+(Q*mp)+" min total), "+N+"v"+N+(f.keeper?" with a keeper":" — no keeper")+", ball size 3.";
  }

  /* ---------- practice ---------- */
  function drill(id){ return DRILLS.filter(function(d){return d.id===id;})[0]; }
  function renderPractice(){
    var ol=$("#planList"), empty=$("#planEmpty");
    if(!state.practice.length){ ol.innerHTML=""; empty.style.display="block"; $("#planTotal").textContent="0"; return; }
    empty.style.display="none";
    var acc=0, total=state.practice.reduce(function(a,x){return a+(x.mins||0);},0);
    ol.innerHTML=state.practice.map(function(item,i){
      var d=drill(item.id); if(!d) return "";
      var start=acc; acc+=item.mins||0;
      return '<li data-i="'+i+'">'
        +'<span class="clock tnum">'+fmtClock(start)+'</span>'
        +'<span class="pt"><button class="nm linklike" data-act="view-drill" data-id="'+item.id+'">'+esc(d.name)+'</button><span class="sk"> '+d.skills.join(" · ")+'</span></span>'
        +'<span class="mins"><input type="number" min="1" max="30" value="'+(item.mins||d.mins)+'" data-act="set-mins" data-i="'+i+'"><span class="hint">min</span></span>'
        +'<span class="mv"><button class="icon" data-act="mv" data-i="'+i+'" data-d="-1" title="Up">↑</button>'
        +'<button class="icon" data-act="mv" data-i="'+i+'" data-d="1" title="Down">↓</button>'
        +'<button class="icon" data-act="rm-drill" data-i="'+i+'" title="Remove">×</button></span>'
        +'</li>';
    }).join("");
    $("#planTotal").textContent=total;
  }
  function fmtClock(m){ var mm=Math.floor(m); return Math.floor(mm/60)+":"+(mm%60<10?"0":"")+(mm%60); }

  /* ---------- drills ---------- */
  var activeFilter="All";
  var FILTERS=["All","Dribbling","Passing","Shooting","Goalkeeper","Games","Warmup","Fun"];
  function renderFilters(){
    $("#filters").innerHTML=FILTERS.map(function(f){
      return '<button class="chip" data-act="filter" data-f="'+f+'" aria-pressed="'+(f===activeFilter)+'">'+f+'</button>';
    }).join("");
  }
  function renderDrills(){
    var list=DRILLS.filter(function(d){return activeFilter==="All"||d.skills.indexOf(activeFilter)>-1;});
    $("#drillGrid").innerHTML=list.map(function(d){
      return '<article class="drill" id="drill-'+d.id+'">'
        +'<div class="diag">'+diagram(d.diag)+'</div>'
        +'<div class="body">'
        +'<h3>'+esc(d.name)+'</h3>'
        +'<div class="tags">'+d.skills.map(function(s){var fun=(s==="Fun"||s==="Warmup");return '<span class="tag'+(fun?" fun":"")+'">'+s+'</span>';}).join("")+'</div>'
        +'<div class="meta"><span>⏱ <b>'+d.mins+' min</b></span><span>👥 '+esc(d.players)+'</span></div>'
        +'<p class="how">'+esc(d.how)+'</p>'
        +'<ul class="points">'+d.points.map(function(p){return "<li>"+esc(p)+"</li>";}).join("")+'</ul>'
        +'<div class="foot"><button class="btn sm" data-act="add-drill" data-id="'+d.id+'">+ Add to practice</button></div>'
        +'</div></article>';
    }).join("");
  }

  /* svg drill diagrams live in diagram.js (global diagram()) */

  /* ---------- game day ---------- */
  var ticker=null, anchor=0;
  function renderGame(){
    var g=state.game;
    $("#usName").textContent=state.team||"Home";
    $("#usScore").textContent=g.us; $("#themScore").textContent=g.them;
    $("#periodPill").textContent="Period "+g.period;
    updateClock();
    $("#timerBtn").innerHTML=g.running?"⏸ Pause":"▶ Start";
    $("#timerBtn").className="btn "+(g.running?"btn-pause":"btn-start");
    renderOnField();
    renderNudge();
  }
  // Guide: the remedy for a lopsided game is fewer players on the dominant side.
  function renderNudge(){
    var g=state.game, el=$("#blowoutNudge"), d=g.us-g.them;
    if(Math.abs(d)<4){ el.hidden=true; return; }
    el.hidden=false;
    el.textContent = d>0
      ? "Up by "+d+". The guide's remedy is to drop the dominant side to "+Math.max(3,state.onfield-1)+" on the field — change On field on the Roster tab and rebuild."
      : "Down by "+(-d)+". Nothing to change on your side; keep it positive and keep coaching.";
  }
  function updateClock(){
    var g=state.game, s=Math.max(0,g.secs);
    var mm=Math.floor(s/60), ss=s%60;
    var el=$("#clock");
    el.textContent=mm+":"+(ss<10?"0":"")+ss;
    // Requirement 6: a stopped clock mid-game must be loud — fired on manual
    // pause AND period expiry (the case the requirement actually names).
    var stopped=!!(g.started&&!g.running);
    el.className="clock-big tnum"+(g.running?" run":"")+(s<=30&&s>0?" warn":"")+(stopped?" stopped":"");
    var note=$("#clockNote"); if(note) note.hidden=!stopped;
    renderEnds();
  }
  function maxPeriods(){ return state.lineup?state.lineup.Q:state.periods; }
  // Requirement 5 (as walked back, decision 1): a secondary wall-clock readout.
  // ponytail: labelled an estimate on purpose — between-period breaks aren't modelled.
  function renderEnds(){
    var g=state.game, el=$("#endsAt"); if(!el) return;
    var left=Math.max(0,g.secs)+Math.max(0,maxPeriods()-g.period)*state.minsper*60;
    var d=new Date(nowMs()+left*1000);
    var h=d.getHours(), m=d.getMinutes(), ap=h>=12?"pm":"am"; h=h%12||12;
    el.textContent="ends ≈ "+h+":"+(m<10?"0":"")+m+" "+ap;
  }
  function tick(){
    var g=state.game;
    if(!g.running) return;
    var elapsed=Math.floor((nowMs()-anchor)/1000);   // wall-clock anchored: a backgrounded phone doesn't run the period long
    if(elapsed<1) return;
    anchor+=elapsed*1000;
    g.secs-=elapsed;
    if(g.secs<=0){ g.secs=0; g.running=false; stopTicker(); beep(); logEvent("clock",{running:false,expired:true}); toast("Period "+g.period+" over — sub time!"); renderGame(); save(); return; }
    updateClock();
    saveLocal();   // ponytail: local only — a full save() every second would spam the sync push
  }
  function startTicker(){ if(ticker)return; anchor=nowMs(); ticker=setInterval(tick,1000); }
  function stopTicker(){ if(ticker){clearInterval(ticker);ticker=null;} }
  function beep(){
    try{
      var Ctx=window.AudioContext||window.webkitAudioContext; if(!Ctx)return;
      var ac=new Ctx(); var o=ac.createOscillator(), gain=ac.createGain();
      o.type="square"; o.frequency.value=880; o.connect(gain); gain.connect(ac.destination);
      gain.gain.setValueAtTime(.0001,ac.currentTime); gain.gain.exponentialRampToValueAtTime(.25,ac.currentTime+.02);
      gain.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+.5);
      o.start(); o.stop(ac.currentTime+.5);
    }catch(e){}
  }
  function renderOnField(){
    var box=$("#onFieldChips"), sub=$("#subLine"), note=$("#benchNote");
    if(!state.lineup){ box.innerHTML='<span class="hint" style="color:rgba(255,255,255,.7)">Build a lineup on the first tab to see who\'s on.</span>'; sub.innerHTML=""; $("#ofPeriod").textContent=""; note.textContent=""; return; }
    var lu=state.lineup, pi=Math.min(state.game.period-1, lu.Q-1);
    $("#ofPeriod").textContent="· Period "+(pi+1);
    function nm(id){ if(!id) return "—"; var p=state.roster.filter(function(x){return x.id===id;})[0]; return p?p.name:"?"; }
    var onNow=lu.periods[pi]||[], gkNow=(lu.gk||[])[pi];
    box.innerHTML=onNow.map(function(id){
      var isGk=(id===gkNow);
      var pos=isGk?"GK":(LineupCore.posInPeriod(lu,pi,id)||"·");
      var s=(sel&&sel.id===id&&sel.where==="field")?" sel":"";
      return '<button class="jchip'+(isGk?" gk":"")+s+'" data-act="chip" data-where="field" data-id="'+id+'"><span class="jn">'+pos+'</span>'+esc(nm(id))+'</button>';
    }).join("");
    // subs vs next period — keeper rows only exist in a keeper format
    var rows=lu.keeper?'<div class="r"><span class="lab">In goal</span><b>'+(gkNow?esc(nm(gkNow)):"—")+'</b></div>':'';
    if(pi+1<lu.Q){
      var nxt=lu.periods[pi+1];
      var coming=nxt.filter(function(id){return onNow.indexOf(id)<0;}).map(nm);
      var going=onNow.filter(function(id){return nxt.indexOf(id)<0;}).map(nm);
      sub.innerHTML=rows+((going.length||coming.length)
        ? '<div class="r off"><span class="lab">Coming off</span><b>'+(going.length?esc(going.join(", ")):"—")+'</b></div>'
          +'<div class="r on"><span class="lab">Going on</span><b>'+(coming.length?esc(coming.join(", ")):"—")+'</b></div>'
        : '<div class="r"><span class="lab">Next period</span>no changes</div>')
        +(lu.keeper?'<div class="r"><span class="lab">Next keeper</span><b>'+esc(nm((lu.gk||[])[pi+1]))+'</b></div>':'');
    } else {
      sub.innerHTML=rows+'<div class="r"><span class="lab">Last period</span>final rotation</div>';
    }
    var bench=state.roster.filter(function(p){return p.present && onNow.indexOf(p.id)<0;});
    note.innerHTML=bench.length
      ? '<span class="hint">Bench — tap a field player, then a name here to sub. Tap two field players to swap positions.</span><div class="benchchips">'
        +bench.map(function(p){
          var s=(sel&&sel.id===p.id&&sel.where==="bench")?" sel":"";
          return '<button class="jchip bench'+s+'" data-act="chip" data-where="bench" data-id="'+p.id+'">'+esc(p.name)+'</button>';
        }).join("")+'</div>'
      : "Everyone's on the field this period. Tap two players to swap positions.";

    $("#subOut").innerHTML=onNow.map(function(id){ return '<option value="'+id+'">'+esc(nm(id))+(id===gkNow?" (GK)":"")+'</option>'; }).join("");
    $("#subIn").innerHTML=bench.map(function(p){ return '<option value="'+p.id+'">'+esc(p.name)+'</option>'; }).join("");
    $("#subNow").hidden = !bench.length || !onNow.length;

    // Keeper swap picker (req 1) — its own card, because #subNow hides whenever
    // there's no bench and a keeper swap needs none (finding 3.4).
    var gkCard=$("#gkCard");
    if(gkCard){
      gkCard.hidden = !lu.keeper || !onNow.length || !gkNow;
      if(!gkCard.hidden){
        // The per-game number the guide caps at one — not career totals (finding 1.2).
        $("#gkSel").innerHTML=onNow.filter(function(id){ return id!==gkNow; }).map(function(id){
          return '<option value="'+id+'">'+esc(nm(id))+" — "+r1(lu.gkActual[id]||0)+" in goal this game</option>";
        }).join("");
      }
    }
  }

  /* ---------- events ---------- */
  document.addEventListener("click",function(e){
    var t=e.target.closest("[data-act]"); if(!t) return;
    var act=t.dataset.act;
    if(act==="add-player"){ addPlayer(); }
    else if(act==="del-player"){ var dp=byId(t.dataset.id); if(dp && confirm("Remove "+dp.name+" from the roster? This can't be undone.")){ state.roster=state.roster.filter(function(p){return p.id!==t.dataset.id;}); save(); renderRoster(); refreshLineup(); } }
    else if(act==="toggle-present"){ var p=byId(t.dataset.id); if(p){p.present=!p.present; save(); renderRoster(); refreshLineup();} }
    else if(act==="build-lineup"){ syncSettings(true); if(buildLineup(false,false)) toast("Lineup ready — check Game Day"); }
    else if(act==="reshuffle"){ syncSettings(true); buildLineup(true,true); }
    else if(act==="print-lineup"){ printPanel("p-lineup"); }
    else if(act==="add-drill"){ state.practice.push({id:t.dataset.id, mins:drill(t.dataset.id).mins}); save(); renderPractice(); toast("Added to practice plan"); }
    else if(act==="rm-drill"){ state.practice.splice(+t.dataset.i,1); save(); renderPractice(); }
    else if(act==="mv"){ moveDrill(+t.dataset.i,+t.dataset.d); }
    else if(act==="template-practice"){ templatePractice(); }
    else if(act==="clear-practice"){ state.practice=[]; save(); renderPractice(); }
    else if(act==="print-practice"){ printPanel("p-practice"); }
    else if(act==="filter"){ activeFilter=t.dataset.f; renderFilters(); renderDrills(); }
    else if(act==="view-drill"){
      activeFilter="All"; renderFilters(); renderDrills();
      $('.tab[data-tab="drills"]').click();
      var card=document.getElementById("drill-"+t.dataset.id);
      if(card) card.scrollIntoView({block:"start"});
    }
    else if(act==="score"){ scoreChange(t.dataset.side,+t.dataset.d); }
    else if(act==="timer-toggle"){ toggleTimer(); }
    else if(act==="timer-reset"){ resetTimer(); }
    else if(act==="period-next"){ nextPeriod(); }
    else if(act==="sub-now"){ subNow($("#subOut").value,$("#subIn").value); }
    else if(act==="gk-swap"){ swapKeeper($("#gkSel").value); }
    else if(act==="chip"){ tapChip(t.dataset.id,t.dataset.where); }
    else if(act==="new-season"){ startNewSeason(); }
    else if(act==="log-game"){ toggleLogGame(t.dataset.gid); }
    else if(act==="copy-link"){ copyTeamLink(); }
  });
  document.addEventListener("input",function(e){
    var t=e.target.closest("[data-act]"); if(!t) return;
    if(t.dataset.act==="set-mins"){ var i=+t.dataset.i; state.practice[i].mins=Math.max(1,+t.value||1); save(); renderPractice(); }
  });
  $("#newName").addEventListener("keydown",function(e){ if(e.key==="Enter") addPlayer(); });
  $("#teamName").addEventListener("input",function(e){
    state.team=e.target.value; save(); var u=$("#usName"); if(u) u.textContent=state.team||"Home";
    var h=$("#hdrTitle"); if(h) h.textContent=state.team||"Coach's Sideline";
    if(TEAM){ var l=loadTeamList(); l.forEach(function(t){ if(t.tok===TEAM) t.name=state.team; }); saveTeamList(l); renderTeamSel(); }
  });
  $("#seasonName").addEventListener("input",function(e){ state.season=e.target.value; save(); });
  $$("#periods,#onfield,#minsper").forEach(function(el){ el.addEventListener("change",syncSettings); });
  $("#format").addEventListener("change",function(e){
    state.format=e.target.value;
    var f=fmt();   // switching format loads its defaults; all three stay editable
    $("#periods").value=f.periods; $("#onfield").value=f.onfield; $("#minsper").value=f.minsper;
    syncSettings();
    applyFormatChrome();
  });
  $("#teamSel").addEventListener("change",function(e){
    var v=e.target.value;
    if(v==="__new"){
      if(!confirm("Start a brand-new team with its own link and roster?")){ renderTeamSel(); return; }
      v=genToken();
      var l=loadTeamList(); l.push({tok:v,name:""}); saveTeamList(l);
    }
    if(v===TEAM) return;
    try{ localStorage.setItem(BASE+":lastTeam",v); }catch(err){}
    setHashToken(v);
    // ponytail: re-entering boot()/initSync() in place is where the bugs would live; a reload is free here.
    location.reload();
  });

  function byId(id){ return state.roster.filter(function(p){return p.id===id;})[0]; }
  function nameOf(id){ var p=byId(id); return p?p.name:"?"; }
  function addPlayer(){
    var inp=$("#newName"), v=inp.value.trim(); if(!v) return;
    state.roster.push({id:"p"+Date.now()+Math.floor(Math.random()*99), name:v, present:true});
    inp.value=""; inp.focus(); save(); renderRoster(); refreshLineup();
  }
  function syncSettings(quiet){
    state.periods=+$("#periods").value; state.onfield=+$("#onfield").value;
    state.minsper=Math.max(4,Math.min(20,+$("#minsper").value||10));
    if(!state.game.running) state.game.secs=state.minsper*60;   // the clock has to follow Min/period
    save(); renderRoster(); renderFormatNote();
    if(!quiet) refreshLineup();                                 // quiet = the caller is about to build anyway
    renderGame();
  }
  function moveDrill(i,d){ var j=i+d; if(j<0||j>=state.practice.length) return; var a=state.practice; var t=a[i];a[i]=a[j];a[j]=t; save(); renderPractice(); }
  function templatePractice(){
    // 60 min, sized for the 8-player team the guide assumes — 4v4 at the end, not 6v6.
    state.practice=[{id:"warmup-tag",mins:8},{id:"slalom",mins:8},{id:"throwin",mins:6},{id:"gates",mins:9},{id:"keeper",mins:8},{id:"gallery",mins:9},{id:"smallsided",mins:12}];
    save(); renderPractice(); toast("60-minute plan loaded — tweak away");
  }
  function scoreChange(side,d){
    var g=state.game; g[side]=Math.max(0,g[side]+d);
    $("#"+(side==="us"?"usScore":"themScore")).textContent=g[side];
    logEvent("goal",{side:side,d:d});
    queueGameRow();   // the archive row carries the score
    save(); renderNudge();
  }
  function toggleTimer(){
    var g=state.game;
    if(g.secs<=0){ g.secs=state.minsper*60; }
    g.running=!g.running; g.started=true;   // from here on, rebuilds must not rewrite this period
    if(g.running&&!g.startedAt){
      g.startedAt=nowMs();                  // kickoff: the game gets its archive row
      if(!g.gid) g.gid=genToken();          // games built before this version have no id yet
      queueGameRow();
    }
    logEvent("clock",{running:g.running});
    if(g.running) startTicker(); else stopTicker();
    save(); renderGame();
  }
  function resetTimer(){ var g=state.game; g.running=false; stopTicker(); g.secs=state.minsper*60; save(); renderGame(); }
  function nextPeriod(){
    var g=state.game, maxP=maxPeriods();
    if(g.period>=maxP){
      g.running=false; stopTicker();
      closeGameRow();                       // full time: stamp the archive row, flush the last period
      save(); renderGame(); renderLog();
      toast("Game over — final "+g.us+"–"+g.them+". Build a lineup to start the next one.");
      return;
    }
    var ended=g.period;
    logEvent("period",{ended:ended});
    queueAppearances(ended);                // the finished period's positions go to the season ledger
    g.period++; g.running=false; stopTicker(); g.secs=state.minsper*60;
    save(); renderGame();
    // Guide: 2–3 min sub break between quarters, 5 min at halftime (10 when it's hot).
    toast((maxP%2===0 && ended===maxP/2)
      ? "Halftime — 5 min break (10 on a hot day)"
      : "Sub break — 2–3 min, then Period "+g.period);
  }
  // A game leaves the live doc through here exactly once: full time, a new
  // game replacing it, or a season rollover.
  function closeGameRow(){
    var g=state.game, lu=state.lineup;
    if(!g||!g.gid||!g.startedAt||g.endedAt||!lu) return;
    g.endedAt=nowMs();
    logEvent("period",{final:true,us:g.us,them:g.them});
    queueGameRow();
    queueAppearances(Math.min(g.period,lu.Q));
  }
  // Seasons are a reset boundary for the career ledgers, nothing more.
  function startNewSeason(){
    var nm=prompt("Name the new season. The fairness ledgers reset; this season's games stay in the archive.", state.season||"");
    if(!nm||!nm.trim()) return;
    closeGameRow();
    commitGame(state.lineup);               // bank the outgoing game through the path that already exists
    state.lineup=null; state.played={}; state.kept={}; state.posTotals={};
    state.season=nm.trim();
    state.game={us:0,them:0,period:1,secs:state.minsper*60,running:false};
    stopTicker();
    save(); renderAll(); renderLog();
    toast("New season: "+state.season+" — ledgers reset, roster kept");
  }

  function printPanel(id){
    $$(".panel").forEach(function(p){p.classList.remove("print-me");});
    $("#"+id).classList.add("print-me");
    window.print();
  }

  /* ---------- cloud sync (local-first; a no-op when there's no backend) ---------- */
  var BACKEND=false, pushing=false, pushTimer=null, retryTimer=null;

  function isDirty(){ return meta && (meta.updatedAt||0) > (meta.syncedAt||0); }
  function setPill(kind,text){ var p=$("#syncPill"); if(!p) return; p.setAttribute("data-state",kind); if(text) $("#syncText").textContent=text; }

  function genToken(){
    var b=new Uint8Array(16); (self.crypto||window.crypto).getRandomValues(b);
    var s=""; for(var i=0;i<b.length;i++){ s+=("0"+b[i].toString(16)).slice(-2); }
    return s; // 32 hex chars — inside the server's [A-Za-z0-9_-]{8,64}
  }
  function hashToken(){ var m=(location.hash||"").match(/[#&]t=([A-Za-z0-9_-]{8,64})/); return m?m[1]:null; }
  function setHashToken(tok){ try{ history.replaceState(null,"","#t="+tok); }catch(e){ location.hash="t="+tok; } }

  async function detectBackend(){
    try{
      var r=await fetch("/api/health",{headers:{accept:"application/json"}});
      if(!r.ok) return false;
      var j=await r.json();
      return !!(j && j.app==="coach-sideline");
    }catch(e){ return false; }
  }

  function scheduleRetry(){ if(retryTimer) return; retryTimer=setTimeout(function(){ retryTimer=null; if(isDirty()) push(); },15000); }
  function schedulePush(){
    if(!BACKEND||!TEAM) return;
    setPill("saving","Saving…");
    if(pushTimer) clearTimeout(pushTimer);
    pushTimer=setTimeout(function(){ pushTimer=null; push(); },1200);
  }

  async function push(force){
    if(!BACKEND||!TEAM||pushing) return;
    pushing=true;
    var sentAt=(meta.updatedAt||nowMs());
    try{
      var res=await fetch("/api/team/"+encodeURIComponent(TEAM)+(force?"?force=1":""),{
        method:"PUT", headers:{"content-type":"application/json"},
        body:JSON.stringify({ doc:JSON.stringify(state), baseRev:(meta.rev||0) })
      });
      if(res.status===409){
        var cur=await res.json(); pushing=false;
        var keepMine=!confirm(
          "“"+(state.team||"This team")+"” was changed on another device.\n\n"+
          "OK = use the OTHER device’s version (discard the unsynced changes here)\n"+
          "Cancel = keep THIS device’s version and overwrite the other");
        if(keepMine){ return push(true); }
        adoptServer(cur); setPill("ok","Synced"); return;
      }
      if(!res.ok) throw new Error("http "+res.status);
      var out=await res.json();
      meta.rev=out.rev; meta.syncedAt=sentAt; saveMeta();
      flushOutbox();   // the doc landed, so the archive rows can follow
      if(isDirty()){ schedulePush(); } else { setPill("ok","Synced"); }
    }catch(e){
      setPill("off","Offline — will sync"); scheduleRetry();
    }finally{ pushing=false; }
  }

  async function pull(){
    if(!BACKEND||!TEAM) return;
    try{
      var res=await fetch("/api/team/"+encodeURIComponent(TEAM),{headers:{accept:"application/json"}});
      if(res.status===404){ return push(true); }           // first write creates the team
      if(!res.ok) throw new Error("http "+res.status);
      var data=await res.json();
      if(isDirty()){ return push(); }                        // local edits pending → push (handles conflicts)
      if((data.rev||0)!==(meta.rev||0)){ adoptServer(data); }
      setPill("ok","Synced");
      flushOutbox();
    }catch(e){ setPill("off","Offline — will sync"); }
  }

  function adoptServer(data){
    var incoming; try{ incoming=JSON.parse(data.doc); }catch(e){ return; }
    if(!incoming||!incoming.roster) return;
    state=incoming;
    fixup(state);
    state.game.running=false; stopTicker();   // a synced clock is never live on this device
    meta.rev=data.rev||0; meta.updatedAt=data.updatedAt||0; meta.syncedAt=data.updatedAt||0;
    saveLocal(); saveMeta(); renderAll();
  }

  /* ---------- archive outbox (item 5) ----------
     Append-only rows with client-generated ids, written locally first and
     flushed opportunistically on the existing push cadence. Retry is free —
     INSERT OR IGNORE / keyed upserts make every POST idempotent — so game day
     still depends on nothing. The outbox is per-team local state, never synced. */
  var flushing=false;
  function loadOutbox(){ try{ var o=JSON.parse(localStorage.getItem(KEY+":outbox")); if(o&&o.events) return o; }catch(e){} return {games:{},events:[],appearances:{}}; }
  function saveOutbox(ob){ try{ localStorage.setItem(KEY+":outbox",JSON.stringify(ob)); }catch(e){} }

  function logEvent(kind,detail,playerId){
    var g=state.game; if(!g||!g.gid) return;
    var ob=loadOutbox();
    ob.events.push({
      id:"e"+nowMs().toString(36)+Math.floor(Math.random()*1679616).toString(36),
      game_id:g.gid, at:nowMs(), period:g.period, secs:Math.max(0,g.secs), kind:kind,
      player_id:playerId||null, detail:detail?JSON.stringify(detail):null
    });
    saveOutbox(ob);
  }
  function queueGameRow(){
    var g=state.game, lu=state.lineup; if(!g.gid||!g.startedAt||!lu) return;
    var ob=loadOutbox();
    ob.games[g.gid]={
      id:g.gid, team_id:TEAM||"", season:state.season||"", format:state.format||"u8",
      started_at:g.startedAt, ended_at:g.endedAt||null, opponent:null,
      us:g.us, them:g.them, periods:lu.Q, onfield:lu.N, minsper:lu.minsper
    };
    saveOutbox(ob);
  }
  // Only periods that have actually been played reach the season ledger; the
  // planned future is redrawn freely and must never be archived.
  function queueAppearances(upto){
    var g=state.game, lu=state.lineup; if(!g.gid||!g.startedAt||!lu) return;
    var ob=loadOutbox();
    LineupCore.appearanceRows(lu,g.gid,upto).forEach(function(r){
      ob.appearances[r.game_id+"|"+r.player_id+"|"+r.period+"|"+r.pos]=r;
    });
    saveOutbox(ob);
  }

  async function flushOutbox(){
    if(!BACKEND||!TEAM||flushing) return;
    flushing=true;
    try{
      var ob=loadOutbox(), base="/api/team/"+encodeURIComponent(TEAM);
      var post=function(p,body){ return fetch(base+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); };
      // Game rows first: events and appearances only exist under a games row,
      // and flushing them before it lands would silently drop them server-side.
      var gids=Object.keys(ob.games), gamesOk=true;
      for(var i=0;i<gids.length;i++){
        var rg=await post("/games",ob.games[gids[i]]);
        if(rg.ok){ delete ob.games[gids[i]]; saveOutbox(ob); } else { gamesOk=false; }
      }
      while(gamesOk&&ob.events.length){
        var batch=ob.events.slice(0,200);
        var re=await post("/events",{events:batch});
        if(!re.ok) break;
        ob.events.splice(0,batch.length); saveOutbox(ob);
      }
      while(gamesOk&&Object.keys(ob.appearances).length){
        var keys=Object.keys(ob.appearances).slice(0,200);
        var ra=await post("/appearances",{rows:keys.map(function(k){ return ob.appearances[k]; })});
        if(!ra.ok) break;
        keys.forEach(function(k){ delete ob.appearances[k]; }); saveOutbox(ob);
      }
      refreshPositions();
    }catch(e){}finally{ flushing=false; }
  }

  // Season position totals from the archive, cached on the doc so a
  // signal-less Saturday still shows last week's numbers (decision on req 3).
  // The current game is excluded server-side — its periods live in lu.app.
  async function refreshPositions(){
    if(!BACKEND||!TEAM) return;
    try{
      var r=await fetch("/api/team/"+encodeURIComponent(TEAM)+"/positions?season="+encodeURIComponent(state.season||"")
        +"&exclude="+encodeURIComponent((state.game&&state.game.gid)||""));
      if(!r.ok) return;
      var j=await r.json(), map={};
      (j.positions||[]).forEach(function(row){ (map[row.player_id]=map[row.player_id]||{})[row.pos]=row.periods; });
      state.posTotals=map;
      saveLocal();   // cache only — must not re-trigger the push cycle
      renderLineup();
    }catch(e){}
  }

  /* ---------- game log read view (req 2 — §2.2e) ---------- */
  var openGid=null;
  function loadArchive(){ try{ return JSON.parse(localStorage.getItem(KEY+":archive"))||{games:[],events:{}}; }catch(e){ return {games:[],events:{}}; } }
  function saveArchive(a){
    // keep cached events only for games still in the list — localStorage is finite
    Object.keys(a.events).forEach(function(k){ if(!a.games.some(function(g){return g.id===k;})) delete a.events[k]; });
    try{ localStorage.setItem(KEY+":archive",JSON.stringify(a)); }catch(e){}
  }
  async function renderLog(){
    var card=$("#logCard"); if(!card) return;
    if(!BACKEND||!TEAM){ card.hidden=true; return; }
    card.hidden=false;
    var arch=loadArchive();
    drawLog(arch);   // cached copy first — the sideline case
    try{
      var r=await fetch("/api/team/"+encodeURIComponent(TEAM)+"/games?season="+encodeURIComponent(state.season||""));
      if(r.ok){ arch.games=(await r.json()).games||[]; saveArchive(arch); drawLog(arch); }
    }catch(e){}
  }
  function drawLog(arch){
    var box=$("#seasonLog"); if(!box) return;
    if(!arch.games.length){ box.innerHTML='<div class="empty">No games archived yet — a game lands here at kickoff.</div>'; return; }
    box.innerHTML=arch.games.map(function(g){
      var d=new Date(g.started_at), when=(d.getMonth()+1)+"/"+d.getDate();
      var open=(g.id===openGid);
      return '<div class="logrow'+(open?" open":"")+'">'
        +'<button class="loghead" data-act="log-game" data-gid="'+g.id+'">'
        +'<span>'+when+(g.ended_at?"":" · in progress")+'</span><b class="tnum">'+g.us+"–"+g.them+"</b></button>"
        +(open?logEventsHtml(arch,g):"")
        +"</div>";
    }).join("");
  }
  function logEventsHtml(arch,g){
    var evs=arch.events[g.id];
    if(!evs) return '<div class="hint" style="padding:6px 2px">Loading…</div>';
    if(!evs.length) return '<div class="hint" style="padding:6px 2px">No events recorded.</div>';
    return '<ul class="loglist">'+evs.map(function(ev){
      var s=Math.max(0,ev.secs||0), mm=Math.floor(s/60), ss=s%60;
      return '<li><span class="tnum">P'+ev.period+" · "+mm+":"+(ss<10?"0":"")+ss+"</span> "+esc(evText(ev))+"</li>";
    }).join("")+"</ul>";
  }
  function evText(ev){
    var d={}; try{ d=JSON.parse(ev.detail)||{}; }catch(e){}
    if(ev.kind==="goal") return d.d<0 ? "Score correction ("+d.side+")" : (d.side==="us" ? "Goal — "+(state.team||"us") : "Goal — them");
    if(ev.kind==="sub") return nameOf(ev.player_id)+" on for "+nameOf(d.out);
    if(ev.kind==="keeper") return nameOf(ev.player_id)+" into goal for "+nameOf(d.out);
    if(ev.kind==="period") return d.final ? "Full time "+d.us+"–"+d.them : "End of period "+d.ended;
    if(ev.kind==="clock") return d.expired ? "Period clock expired" : (d.running ? "Clock started" : "Clock stopped");
    return ev.kind;
  }
  async function toggleLogGame(gid){
    openGid = (openGid===gid) ? null : gid;
    var arch=loadArchive();
    drawLog(arch);
    if(openGid && !arch.events[gid] && BACKEND && TEAM){
      try{
        var r=await fetch("/api/team/"+encodeURIComponent(TEAM)+"/games/"+encodeURIComponent(gid));
        if(r.ok){ arch.events[gid]=(await r.json()).events||[]; saveArchive(arch); }
      }catch(e){}
      drawLog(loadArchive());
    }
  }

  /* ---------- team switcher (item 4.5) ----------
     The token already namespaces everything; the whole feature is extending
     the single ":lastTeam" key to a list. The list lives only on this device —
     the tokens themselves are the only real handle, as the README documents. */
  function loadTeamList(){ try{ return JSON.parse(localStorage.getItem(BASE+":teams"))||[]; }catch(e){ return []; } }
  function saveTeamList(l){ try{ localStorage.setItem(BASE+":teams",JSON.stringify(l)); }catch(e){} }
  function renderTeamSel(){
    var el=$("#teamSel"); if(!el) return;
    var list=loadTeamList();
    if(!TEAM||!BACKEND){ el.hidden=true; return; }
    el.hidden=false;
    el.innerHTML=list.map(function(t){
      return '<option value="'+t.tok+'"'+(t.tok===TEAM?" selected":"")+'>'+esc(t.name||("Team "+t.tok.slice(0,6)))+'</option>';
    }).join("")+'<option value="__new">＋ New team…</option>';
  }

  function copyTeamLink(){
    var url=location.href;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(
        function(){ toast("Team link copied — open it on your phone"); },
        function(){ toast("Copy failed — long-press the address bar to copy"); });
    } else { toast("Copy this page's URL to share the team"); }
  }

  // Format-dependent chrome outside the render cycle: header line, the U8-only
  // checklist item, and which rules card shows.
  function applyFormatChrome(){
    var f=fmt();
    var h=$("#hdrTitle"); if(h) h.textContent=state.team||"Coach's Sideline";
    var sub=$(".brand .sub"); if(sub) sub.textContent=f.label+" · Everyone plays";
    var ck=$("#ckRef"); if(ck) ck.hidden=!f.keeper;
    var bu=$("#bu5Rules"); if(bu) bu.hidden=(state.format!=="bu5");
    var u8=$("#u8Rules"); if(u8) u8.hidden=(state.format==="bu5");
  }

  function renderAll(){
    $("#periods").value=state.periods; $("#onfield").value=state.onfield; $("#minsper").value=state.minsper;
    $("#teamName").value=state.team||"";
    $("#format").value=state.format||"u8";
    $("#seasonName").value=state.season||"";
    applyFormatChrome(); renderTeamSel();
    renderFormatNote();
    renderRoster(); renderLineup(); renderPractice(); renderFilters(); renderDrills(); renderGame();
  }

  async function initSync(){
    BACKEND=await detectBackend();
    var tools=$("#syncTools"), copyBtn=$("#copyLink");
    if(tools) tools.hidden=false;
    if(!BACKEND){ setPill("local","Local only — this device"); return; }  // e.g. Claude Artifact: behaves exactly as before
    if(copyBtn) copyBtn.hidden=false;

    if(!TEAM){
      var last=null; try{ last=localStorage.getItem(BASE+":lastTeam"); }catch(e){}
      if(last){
        TEAM=last; KEY=BASE+":"+last;
        state=load(); meta=loadMeta();     // reuse this device's last team + its cache
        setHashToken(last); renderAll();
      } else {
        var tok=genToken();
        TEAM=tok; KEY=BASE+":"+tok;
        saveLocal();                        // promote current state as this team's seed
        meta={rev:0,updatedAt:nowMs(),syncedAt:0}; saveMeta();
        setHashToken(tok);
      }
    }
    // Team list: promote the legacy single ":lastTeam" key (read BEFORE it is
    // overwritten below), make sure the current team is on it, keep its name fresh.
    var list=loadTeamList();
    try{
      var legacy=localStorage.getItem(BASE+":lastTeam");
      if(legacy&&legacy!==TEAM&&!list.some(function(t){return t.tok===legacy;})) list.push({tok:legacy,name:""});
    }catch(e){}
    try{ localStorage.setItem(BASE+":lastTeam",TEAM); }catch(e){}
    if(!list.some(function(t){return t.tok===TEAM;})) list.push({tok:TEAM,name:state.team||""});
    list.forEach(function(t){ if(t.tok===TEAM&&state.team) t.name=state.team; });
    saveTeamList(list); renderTeamSel();

    setPill("saving","Syncing…");
    await pull();
    renderLog();
    window.addEventListener("online", function(){ if(isDirty()) push(); else { pull(); flushOutbox(); } });
    document.addEventListener("visibilitychange", function(){ if(document.visibilityState==="visible"){ if(isDirty()) push(); else pull(); } });
  }

  /* ---------- boot ---------- */
  function boot(){
    TEAM=hashToken();
    KEY=TEAM?(BASE+":"+TEAM):BASE;
    state=load(); meta=loadMeta();
    if(state.game.secs==null) state.game.secs=state.minsper*60;
    state.game.running=false;   // never resume a live clock on reload
    renderAll();
    setInterval(renderEnds,30000);   // "ends ≈" stays fresh while paused — tick() won't run then
    initSync();                 // async — reconciles with the backend if one is present
  }
  boot();

  if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function(){});
})();
