"use strict";
(function(){
  var BASE="ayso-coach-v2";   // localStorage namespace
  var KEY=BASE;               // becomes BASE + ":" + teamId once a team is known
  var TEAM=null;              // team token (also the share-link id); null = local-only
  var CID_REV=0;              // last-synced rev of the coach team-list (device sync)
  var linkCid=null;           // a cid arriving in the URL (#c=…) to adopt at boot

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

  // Defaults, the migration of older docs and the read live in state.js, behind
  // node --test — a migration bug is silent and permanent, so it gets tests.
  function load(){ return SaveState.load(KEY); }
  var fixup=SaveState.fixup;
  function loadMeta(){ try{ return JSON.parse(localStorage.getItem(KEY+":meta"))||{rev:0,updatedAt:0,syncedAt:0}; }catch(e){ return {rev:0,updatedAt:0,syncedAt:0}; } }
  function saveMeta(){ try{ localStorage.setItem(KEY+":meta",JSON.stringify(meta)); }catch(e){} }
  function saveLocal(){ try{ localStorage.setItem(KEY,JSON.stringify(state)); }catch(e){} }
  // save() = persist locally, mark this device ahead of the server, and schedule a sync push.
  function save(){ saveLocal(); if(meta){ meta.updatedAt=nowMs(); saveMeta(); } schedulePush(); }

  var $=function(s,r){return (r||document).querySelector(s);};
  var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  // Toasts stack. A sticky one (subs, period changes, format switches — the
  // things a coach has to act on) stays until it is tapped away; everything
  // else still self-clears. Tap anywhere on a toast to dismiss it.
  function toast(msg,sticky){
    var box=$("#toast"); if(!box) return;
    var el=document.createElement("div");
    el.className="toast"+(sticky?" stick":"");
    el._at=nowMs();
    el.innerHTML='<span class="tmsg">'+esc(msg)+'</span><span class="tage">now</span>'+(sticky?'<span class="x">✕</span>':'');
    el.addEventListener("click",function(){ dropToast(el); });
    box.appendChild(el);
    requestAnimationFrame(function(){ el.classList.add("show"); });
    if(!sticky) setTimeout(function(){ dropToast(el); },1900);
    var live=$$("#toast .toast");
    while(live.length>4){ box.removeChild(live.shift()); }   // the bar is not a toast, never evict it
    syncToastBar();
  }
  function dropToast(el){
    if(!el||el._gone) return; el._gone=true;
    el.classList.remove("show");
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); syncToastBar(); },250);
    syncToastBar();
  }
  /* ---------- ask(): the app's only confirmation ----------
     confirm()/prompt() block the whole page — the game clock stops repainting
     and the tick can't run — so every question goes through this instead.
     Resolves true/false, or the trimmed string / null when opts.input is set. */
  var askDone=null, askIsText=false;
  function askClose(v){
    var f=askDone; askDone=null;
    var dlg=$("#askDialog"); if(dlg&&dlg.open) dlg.close();
    if(f) f(v);
  }
  function askYes(){
    var inp=$("#askInput");
    if(inp){ var v=(inp.value||"").trim(); askClose(v||null); return; }
    askClose(true);
  }
  function ask(o){
    o=o||{};
    var isText=(o.input!=null);
    return new Promise(function(resolve){
      var dlg=$("#askDialog");
      if(!dlg||!dlg.showModal){ resolve(isText?(o.input||null):true); return; }
      if(askDone) askClose(askIsText?null:false);   // never stack two questions
      askDone=resolve; askIsText=isText;
      dlg.innerHTML='<h4>'+esc(o.title||"Are you sure?")+'</h4>'
        +(o.body?'<p>'+esc(o.body).replace(/\n/g,"<br>")+'</p>':"")
        // o.pass masks the field and turns off the phone keyboard's "helpful"
        // capitalisation — an autocapitalised passphrase silently fails to match.
        +(isText?'<input type="'+(o.pass?"password":"text")+'" id="askInput" value="'+esc(o.input)+'" placeholder="'+esc(o.placeholder||"")+'" autocomplete="off"'
          +(o.pass?' autocapitalize="none" autocorrect="off" spellcheck="false"':"")+'>':"")
        +'<div class="btns"><button class="btn ghost" data-act="ask-no">'+esc(o.cancel||"Cancel")+'</button>'
        +'<button class="btn'+(o.danger?" cone":"")+'" style="flex:2" data-act="ask-yes">'+esc(o.ok||"Yes")+'</button></div>';
      dlg.showModal();
      var inp=$("#askInput");
      if(inp){
        inp.focus(); inp.select();
        inp.addEventListener("keydown",function(e){ if(e.key==="Enter"){ e.preventDefault(); askYes(); } });
      }
    });
  }

  // Sticky toasts outlive the moment they describe — "2m ago" is the difference
  // between a sub you already made and one you are about to make.
  function ageTxt(ms){
    var s=Math.max(0,Math.round(ms/1000));
    if(s<10) return "now";
    if(s<60) return s+"s ago";
    var m=Math.round(s/60);
    if(m<60) return m+"m ago";
    return Math.round(m/60)+"h ago";
  }
  function tickToastAges(){
    var n=nowMs();
    $$("#toast .toast").forEach(function(el){
      var tag=el.querySelector(".tage");
      if(tag&&el._at) tag.textContent=ageTxt(n-el._at);
    });
  }
  function clearToasts(){
    $$("#toast .toast").forEach(dropToast);
    var bar=$("#toastBar"); if(bar&&bar.parentNode) bar.parentNode.removeChild(bar);
  }
  // Only worth the space once messages are actually piling up.
  function syncToastBar(){
    var box=$("#toast"); if(!box) return;
    var bar=$("#toastBar"), n=$$("#toast .toast").filter(function(t){ return !t._gone; }).length;
    if(n<2){ if(bar&&bar.parentNode) bar.parentNode.removeChild(bar); return; }
    if(!bar){
      bar=document.createElement("div");
      bar.id="toastBar"; bar.className="toastbar";
      bar.innerHTML='<button type="button" data-act="toast-clear"></button>';
      box.insertBefore(bar,box.firstChild);
    }
    if(box.firstChild!==bar) box.insertBefore(bar,box.firstChild);
    bar.firstChild.textContent="Clear all ("+n+")";
  }
  // Android/Chrome only — iOS Safari has never shipped the Vibration API, so
  // this is a no-op there and beep() stays the alarm. Guarded, never throws.
  function buzz(pat){ try{ if(navigator.vibrate) navigator.vibrate(pat); }catch(e){} }

  /* ---------- tabs (lower-left FAB speed-dial) ---------- */
  var tabNav=$("#tabNav"), fabToggle=$("#fabToggle"), fabBack=$("#fabBack");
  function closeFabNav(){ if(tabNav){ tabNav.classList.remove("open"); } if(fabBack){ fabBack.hidden=true; }
    if(fabToggle){ fabToggle.setAttribute("aria-expanded","false"); fabToggle.textContent="☰"; } }
  if(fabToggle){
    fabToggle.addEventListener("click",function(){
      var open=tabNav.classList.toggle("open");
      if(fabBack) fabBack.hidden=!open;
      fabToggle.setAttribute("aria-expanded",open?"true":"false");
      fabToggle.textContent=open?"✕":"☰";
    });
  }
  // Tap-away closes the menu and nothing else. A document-level listener let the
  // same tap through to whatever control sat underneath — on Game Day that is a
  // score button or a player chip, so closing the menu changed the game.
  if(fabBack) fabBack.addEventListener("click",closeFabNav);
  /* Tabs are history entries: the hash carries "p=<tab>" alongside the team
     token, so Back leaves a tab instead of leaving the app, and a link can
     point at one. The hash (not a path) because the token already lives there,
     it needs no worker route or SW change, and it survives an offline launch. */
  var TABS=["lineup","practice","drills","game","season","rules"];
  function activeTab(){ var b=$('.tab[aria-selected="true"]'); return b?b.dataset.tab:"lineup"; }
  function tabFromHash(){
    var m=(location.hash||"").match(/[#&]p=([a-z]+)/);
    return (m&&TABS.indexOf(m[1])>=0)?m[1]:null;
  }
  function hashFor(tab,tok){
    var t=tok||TEAM, s=t?("t="+t):"";
    if(tab&&tab!=="lineup") s+=(s?"&":"")+"p="+tab;   // lineup is the default, keep its URL clean
    return s?("#"+s):"#";
  }
  function showTab(tab){
    if(TABS.indexOf(tab)<0) tab="lineup";
    $$(".tab").forEach(function(x){ x.setAttribute("aria-selected",String(x.dataset.tab===tab)); });
    $$(".panel").forEach(function(p){ p.classList.toggle("active",p.id==="p-"+tab); });
    if(tab==="game") renderGame();
    if(tab==="season") renderLog();
    if(tab==="practice") renderBurn();
    closeFabNav();
  }
  function selectTab(tab){
    if(tab===activeTab()){ closeFabNav(); return; }   // no history entry for a no-op
    showTab(tab);
    try{ history.pushState({tab:tab},"",hashFor(tab)); }catch(e){ location.hash=hashFor(tab).slice(1); }
  }
  $$(".tab").forEach(function(b){ b.addEventListener("click",function(){ selectTab(b.dataset.tab); }); });
  window.addEventListener("popstate",function(){ showTab(tabFromHash()||"lineup"); });
  // a hand-edited URL fires hashchange but not popstate
  window.addEventListener("hashchange",function(){
    var t=tabFromHash()||"lineup";
    if(t!==activeTab()) showTab(t);
  });

  /* ---------- roster ---------- */
  // Tri-state: IN (playing) -> LATE (expected, not here for the build) -> OUT (not
  // coming). LATE behaves like OUT for the lineup builder; flipping a late arrival
  // to IN just runs through refreshLineup() like any other roster edit.
  function rosterState(p){ return p.present?"in":(p.late?"late":"out"); }
  function renderRoster(){
    var ul=$("#rosterList");
    // The whole row is the toggle — a bare "IN" label didn't read as tappable.
    ul.innerHTML=state.roster.map(function(p,i){
      var st=rosterState(p), label=st==="in"?"IN":(st==="late"?"LATE":"OUT");
      return '<li class="'+(st==="in"?"":st)+'" data-id="'+p.id+'">'
        +'<button class="rowtog" data-act="toggle-present" data-id="'+p.id+'"'
        +' aria-label="'+esc(p.name)+' is '+label+' — tap to change">'
        +'<span class="pnum">'+esc(p.num||(i+1))+'</span>'
        +'<span class="pname">'+esc(p.name)+'</span>'
        +'<span class="state">'+label+'</span>'
        +'</button>'
        // The full-screen framing of the player card (1b) — the roster row is
        // already the IN/LATE/OUT toggle, so the card needs its own target.
        +'<button class="rowinfo no-print" data-act="card" data-id="'+p.id+'" title="Player card" aria-label="'+esc(p.name)+' — player card">ⓘ</button>'
        +'<button class="icon no-print" data-act="del-player" data-id="'+p.id+'" title="Remove">×</button>'
        +'</li>';
    }).join("");
    renderGoLive();
    var n=state.roster.filter(function(p){return p.present;}).length;
    var late=state.roster.filter(function(p){return rosterState(p)==="late";}).length;
    $("#presentCount").innerHTML="<b>"+n+"</b> present of "+state.roster.length
      +(late?" · <b>"+late+"</b> running late":"")
      +" · field size "+state.onfield+" ⇒ "+Math.max(0,n-state.onfield)+" on the bench each period";
  }

  // A game is "live" from the first Start until full time is stamped.
  function gameUnderway(){
    var g=state.game;
    return !!(state.lineup && !g.endedAt && (g.started||g.period>1||g.us||g.them));
  }
  function renderGoLive(){
    var b=$("#goLive"); if(!b) return;
    var live=gameUnderway();
    // Same signal drives the FAB's Game Day tab: cone = a game is live now.
    var t=$('.tab[data-tab="game"]'); if(t) t.classList.toggle("live",live);
    b.hidden=!live;
    if(!live) return;
    var g=state.game;
    // one text node: .btn is a flex row, so extra children get spread apart
    b.innerHTML='<span class="lv"></span><span>Game in progress · Period '+g.period+' of '+maxPeriods()
      +' · '+g.us+'–'+g.them+' — go to Game Day</span>';
  }

  /* ---------- lineup ---------- */
  // Fairness runs across games, and it runs on time ACTUALLY played, not on the plan:
  //   state.played / state.kept   career periods from games already finished
  //   lu.actual / lu.gkActual     this game only — fractional once anyone subs mid-period
  // "Build lineup" starts a new game and banks the outgoing game's ledger into the career
  // totals. Everything else (reshuffle, roster edit, settings) redraws the SAME game, and
  // only ever rewrites periods that haven't been played yet.
  function totPlayed(lu,id){ return (state.played[id]||0) + ((lu&&lu.actual[id])||0); }
  // Periods ACTUALLY kept. Not lu.gkActual — tally() stamps every planned keeper
  // period at build time, so that silenced "Never in goal" for a child merely
  // penciled in for P4, which is the one pill that exists to say "give them a turn".
  function totKept(lu,id){ return (state.kept[id]||0) + (lu?LineupCore.playedThrough(lu,curPi(),id,curPi(),remFrac(),"GK"):0); }
  // The season position ratio every display reads: capped at periods played, so
  // the plan never colours the D/F strip a coach picks a position off.
  function posTotals(lu){
    if(!lu) return LineupCore.positionTotals(null,state.posTotals);   // archive only — curPi() needs a lineup
    return LineupCore.positionTotals(lu,state.posTotals,curPi()+1,curPi(),remFrac());
  }

  var tally=LineupCore.tally;   // extracted behind node --test (plan item 4)
  function commitGame(lu){
    if(!lu) return;
    // A practice/test game never banks minutes into the career fairness ledgers.
    if(state.game && state.game.test) return;
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
    // The "start a new game?" question lives at the click site now — ask() is
    // async and buildLineup has to stay synchronous for its boolean contract.
    var keep = replace ? frozenUpto() : 0;
    var present=state.roster.filter(function(p){return p.present;});
    if(present.length < state.onfield){
      if(state.lineup && keep){
        // Mid-game and short-handed: keep what was played, blank the periods we can't fill.
        tally(state.lineup,keep,-1);
        state.lineup.periods.length=keep; state.lineup.gk.length=keep;
        (state.lineup.app=state.lineup.app||[]).length=keep;
        LineupCore.ivTruncate(state.lineup,keep);
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
    if(keep){ tally(lu,keep,-1); lu.periods.length=keep; lu.gk.length=keep; (lu.app=lu.app||[]).length=keep; LineupCore.ivTruncate(lu,keep); }

    var order=present.slice();
    if(reshuffle){ for(var i=order.length-1;i>0;i--){ var j=Math.floor(Math.random()*(i+1)); var t=order[i];order[i]=order[j];order[j]=t; } }
    // Most-owed first, counting what's already happened this game. Stable: ties keep roster/shuffle order.
    order.sort(function(a,b){ return totPlayed(lu,a.id)-totPlayed(lu,b.id); });

    var Q=state.periods, N=state.onfield;
    // Mid-game the keeper setting belongs to the game, not the team (t5) — a
    // redraw must not resurrect a keeper the coach switched off on the field.
    var keeperFlag=(keep>0 && lu.keeper!=null) ? lu.keeper : fmt().keeper;
    // Keeper (fewest career keeps, one period max) and D/F seeding (least
    // experience at the position first — decision 4) both live in the core.
    LineupCore.buildPeriods(lu, order.map(function(p){return p.id;}),
      {keep:keep, Q:Q, N:N, keeper:keeperFlag, kept:state.kept, posTotals:state.posTotals});
    // Anyone who played a frozen period stays on the sheet even if they've since gone home.
    var ids=order.map(function(p){return p.id;});
    for(var z=0;z<keep;z++){ lu.periods[z].forEach(function(id){ if(ids.indexOf(id)<0) ids.push(id); }); }
    lu.playerOrder=ids; lu.Q=Q; lu.N=N; lu.minsper=state.minsper; lu.keeper=keeperFlag;
    lu.handEdited=false;
    tally(lu,keep,1);

    state.lineup=lu;
    if(!replace){
      g.period=1; g.us=0; g.them=0; g.running=false; g.started=false; g.secs=state.minsper*60;
      g.gid=genToken(); g.startedAt=0; g.endedAt=0;   // archive identity — kickoff works offline
      g.recent=[]; g.stoppedAt=0;                     // Fix-a-mistake starts clean each game
      g.goals=[];                                     // every goal this game, newest first
      g.onBreak=false; g.breakKind=null; g.playerStats={};
      // Carry the coach's game link (test / linked schedule game) forward as the
      // pre-game intent. But a scheduled game that is already over drops back to
      // practice, so the next game doesn't silently re-count last week's opponent.
      if(g.sched && g.sched.startsAt && g.sched.startsAt < nowMs()-4*3600e3){ g.test=true; g.sched=null; }
      if(g.test===undefined) g.test=true;
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
    var pi=editPi(), future=onBreakNext(), frac=editFrac();
    if(!LineupCore.applySub(lu,pi,outId,inId,frac)) return;
    if(future) lu.handEdited=true;
    logEvent("sub",{out:outId,"in":inId,frac:Math.round(frac*1000)/1000,forPeriod:pi+1},inId);
    queueAppearances(curPi()+1);   // only periods actually played reach the ledger
    save(); renderLineup(); renderGame();
    // Before kickoff the clock hasn't run, so nothing is earned yet — it's a sheet
    // edit. Saying "10 min credited" there read as a mystery reward (finding: toast).
    var msg=future
      ? nameOf(inId)+" starts period "+(pi+1)+" in place of "+nameOf(outId)+" — full period"
      : (state.game.started
        ? nameOf(inId)+" on for "+nameOf(outId)+" — credited the rest of period "+(pi+1)+" ("+r1(frac*state.minsper)+" min), booked now. Another change re-splits it."
        : nameOf(inId)+" in for "+nameOf(outId)+" in period "+(pi+1)+" — not started, nothing played yet");
    // The sub may already be down for a period in goal later; the guide caps that at one.
    if((lu.gkActual[inId]||0)>1.0001) msg+=". Careful — that puts them over a period in goal.";
    buzz(40);
    toast(msg,true);
  }
  function curPi(){ return Math.min(state.game.period-1, state.lineup.Q-1); }
  // During an inter-period break g.period has not advanced yet, so curPi() still
  // points at the period that just ENDED — showing those players under "On the
  // field" is what made the break confusing. AYSO wants substitutions made at
  // these stops, and the break is when the coach briefs the team, so the panel
  // switches to the period about to START and edits that one.
  function onBreakNext(){
    var g=state.game, lu=state.lineup;
    return !!(lu && g.onBreak && curPi()+1 < lu.Q);
  }
  function editPi(){ return onBreakNext() ? curPi()+1 : curPi(); }
  // A period that hasn't kicked off is edited whole; a live one splits at the clock.
  function editFrac(){
    if(onBreakNext()) return 1;
    return Math.min(1,Math.max(0, state.game.secs/Math.max(1,state.minsper*60)));
  }

  // Requirement 1: swap who's in goal without anyone leaving the field.
  function swapKeeper(newId){
    var lu=state.lineup; if(!lu||!lu.keeper||!newId) return;
    var pi=editPi(), future=onBreakNext(), old=lu.gk[pi];
    var frac=editFrac();
    if(!LineupCore.applyKeeperSwap(lu,pi,newId,frac)) return;
    if(!state.game.started||future) lu.handEdited=true;
    logEvent("keeper",{out:old,"in":newId,frac:Math.round(frac*1000)/1000,forPeriod:pi+1},newId);
    queueAppearances(curPi()+1);
    save(); renderLineup(); renderGame();
    var msg=future
      ? nameOf(newId)+" takes the goal for period "+(pi+1)+" instead of "+nameOf(old)
      : (state.game.started
        // "gets the last 5.5 min" read as a promise about the future. The credit
        // is booked NOW against the rest of the period; a further change in the
        // same period overwrites the split, it does not add to it.
        ? nameOf(newId)+" in goal for "+nameOf(old)+" — credited the rest of period "+(pi+1)+" in goal ("+r1(frac*state.minsper)+" min), booked now. Another change re-splits it."
        : nameOf(newId)+" in goal for period "+(pi+1)+" instead of "+nameOf(old)+" — not started yet");
    if((lu.gkActual[newId]||0)>1.0001) msg+=". Careful — that puts them over a period in goal.";
    buzz(40);
    toast(msg,true);
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
    var pi=editPi();
    if(a.where==="field"&&where==="field"){
      var gkNow=lu.gk[pi];
      if(id===gkNow){ swapKeeper(a.id); }
      else if(a.id===gkNow){ swapKeeper(id); }
      else if(LineupCore.applyPosSwap(lu,pi,a.id,id)){
        if(!state.game.started||onBreakNext()) lu.handEdited=true;
        queueAppearances(curPi()+1);
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
    // ponytail: the column shows lu.actual, which is the PLAN (periods each kid
    // is down to play this game) until finalizeAtElapsed clips it at full time —
    // so the label is "Scheduled", not "played". The internal key stays `actual`;
    // renaming it buys nothing and churns the test suite. (§2.1)
    var counts=players.map(function(p){ return lu.actual[p.id]||0; });
    var mx=counts.length?Math.max.apply(null,counts):0;
    var seasons=players.map(function(p){ return totPlayed(lu,p.id); });
    var loS=seasons.length?Math.min.apply(null,seasons):0, hiS=seasons.length?Math.max.apply(null,seasons):0;
    var owedSet={};   // whoever is furthest behind goes to the front of the next sheet
    if(hiS-loS>1e-9) players.forEach(function(p,i){ if(seasons[i]<=loS+1e-9) owedSet[p.id]=1; });
    // Season position ratio (decision 6: one decimal, the honest number) —
    // archive cache plus this game's ledger.
    var posTot=posTotals(lu);
    var head="<tr><th>Player</th>";
    for(var q=0;q<Q;q++){ head+="<th>P"+(q+1)+"</th>"; }
    head+="<th>Scheduled</th><th>Season</th><th>D · F</th></tr>";
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
    if(!state.practice.length){ ol.innerHTML=""; empty.style.display="block"; $("#planTotal").textContent="0"; renderBurn(); return; }
    empty.style.display="none";
    var run=state.practiceRun||{}, live=!!run.startedAt;
    var acc=0, total=state.practice.reduce(function(a,x){return a+(x.mins||0);},0);
    ol.innerHTML=state.practice.map(function(item,i){
      var d=drill(item.id); if(!d) return "";
      var start=acc; acc+=item.mins||0;
      var cls=live?(i<run.idx?"done":(i===run.idx?"cur":"")):"";
      return '<li class="'+cls+'" data-i="'+i+'">'
        +'<span class="clock tnum">'+fmtClock(start)+'</span>'
        +'<span class="pt"><button class="nm linklike" data-act="view-drill" data-id="'+item.id+'">'+esc(d.name)+'</button><span class="sk"> '+d.skills.join(" · ")+'</span></span>'
        +'<span class="mins"><input type="number" min="1" max="30" value="'+(item.mins||d.mins)+'" data-act="set-mins" data-i="'+i+'"><span class="hint">min</span></span>'
        +'<span class="mv"><button class="icon" data-act="mv" data-i="'+i+'" data-d="-1" title="Up">↑</button>'
        +'<button class="icon" data-act="mv" data-i="'+i+'" data-d="1" title="Down">↓</button>'
        +'<button class="icon" data-act="rm-drill" data-i="'+i+'" title="Remove">×</button></span>'
        +'</li>';
    }).join("");
    $("#planTotal").textContent=total;
    renderBurn();
  }
  function fmtClock(m){ var mm=Math.floor(m); return Math.floor(mm/60)+":"+(mm%60<10?"0":"")+(mm%60); }

  /* ---------- practice burn-down ----------
     Work remaining (minutes) against wall-clock elapsed. The plan line is what
     the sheet promises; the actual line is where you really are, stepped each
     time you tap Next drill. Water breaks and re-explaining a drill are never
     in the plan — they show up here as the gap, which is the whole point. */
  function planTotal(){ return state.practice.reduce(function(a,x){ return a+(x.mins||0); },0); }
  function plannedStart(i){ return state.practice.slice(0,i).reduce(function(a,x){ return a+(x.mins||0); },0); }
  function elapsedMin(){
    var run=state.practiceRun;
    return (!run||!run.startedAt) ? 0 : (nowMs()-run.startedAt)/60000;
  }
  // Minutes of the PLAN that are actually in the bank. Finished drills count
  // in full; the one running counts only up to its planned length, so a drill
  // that overruns stops earning credit — that stall is the "behind" number.
  function workDone(){
    var run=state.practiceRun, n=state.practice.length, idx=Math.min(run.idx||0,n);
    var done=plannedStart(idx);
    if(idx<n){
      var since=idx>0?((run.marks||[])[idx-1]||0):0;
      done+=Math.min(Math.max(0,elapsedMin()-since), state.practice[idx].mins||0);
    }
    return done;
  }
  function renderBurn(){
    var box=$("#burnBox"); if(!box) return;
    var run=state.practiceRun||{startedAt:0,idx:0,marks:[]}, total=planTotal();
    if(!state.practice.length){ box.innerHTML=""; return; }
    if(!run.startedAt){
      box.innerHTML='<div class="burn-idle"><div><b>'+total+' min planned.</b> Start the clock when the first drill kicks off — '
        +'the chart then tracks whether you are ahead or behind, water breaks and all.</div>'
        +'<button class="btn" data-act="practice-start">▶ Start practice</button></div>';
      return;
    }
    var el=elapsedMin(), n=state.practice.length, idx=Math.min(run.idx,n);
    var banked=workDone(), done=idx>=n;
    // behind = the plan minutes you should have banked by now, minus what you have
    var behind=done ? (el-total) : (Math.min(el,total)-banked);   // + = late, − = early
    var W=300, H=92, PL=4, PR=4, PT=8, PB=14;
    var maxX=Math.max(total, el)*1.04||1;
    var X=function(m){ return PL+(m/maxX)*(W-PL-PR); };
    var Y=function(v){ return PT+(1-(v/(total||1)))*(H-PT-PB); };
    // planned: total → 0 over the planned duration
    var plan='<line class="pl" x1="'+X(0)+'" y1="'+Y(total)+'" x2="'+X(total)+'" y2="'+Y(0)+'"/>';
    // actual: a step per completed drill, then a leg out to "now"
    var pts=[[0,total]];
    (run.marks||[]).forEach(function(m,i){ pts.push([m,total-plannedStart(i+1)]); });
    pts.push([el,total-banked]);
    var actual='<polyline class="ac'+(behind>1?" late":"")+'" points="'+pts.map(function(p){ return X(p[0])+","+Y(p[1]); }).join(" ")+'"/>';
    var head=done
      ? (behind>1?"Ran "+Math.round(behind)+" min long":(behind<-1?"Finished "+Math.round(-behind)+" min early":"Finished on time"))
      : (Math.abs(behind)<1?"On schedule":(behind>0?Math.round(behind)+" min behind":Math.round(-behind)+" min ahead"));
    var cur=done?null:state.practice[idx];
    box.innerHTML='<div class="burn-head"><span class="st'+(behind>1?" late":(behind<-1?" early":""))+'">'+head+'</span>'
      +'<span class="hint tnum">'+Math.round(el)+' of '+total+' min elapsed</span></div>'
      +'<svg class="burn-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" aria-hidden="true">'
      +'<line class="ax" x1="'+X(0)+'" y1="'+Y(0)+'" x2="'+X(maxX)+'" y2="'+Y(0)+'"/>'+plan+actual
      +'<circle class="now'+(behind>1?" late":"")+'" cx="'+X(el)+'" cy="'+Y(total-banked)+'" r="3.5"/></svg>'
      +'<div class="burn-legend"><span><i class="pl"></i> plan</span><span><i class="ac"></i> actual</span>'
      +'<span class="hint">water breaks show up as the gap</span></div>'
      +'<div class="burn-btns">'
      +(cur?'<button class="btn" data-act="practice-next">✓ Done — next drill</button>'
           :'<span class="burn-done">Practice complete.</span>')
      +'<button class="btn ghost" style="flex:0 0 auto" data-act="practice-reset">Reset</button></div>'
      +(cur?'<div class="burn-now">Now: <b>'+esc((drill(cur.id)||{}).name||"—")+'</b> · '+(cur.mins||0)+' min</div>':"");
  }
  function practiceStart(){
    state.practiceRun={startedAt:nowMs(),idx:0,marks:[]};
    save(); renderPractice();
    toast("Practice clock started");
  }
  function practiceNext(){
    var run=state.practiceRun; if(!run||!run.startedAt) return;
    if(run.idx>=state.practice.length) return;
    (run.marks=run.marks||[]).push(Math.round(elapsedMin()*10)/10);
    run.idx++;
    save(); renderPractice();
  }
  function practiceReset(){
    ask({title:"Reset the practice clock?", body:"The plan itself is not changed.", ok:"Reset the clock", danger:true})
      .then(function(ok){
        if(!ok) return;
        state.practiceRun={startedAt:0,idx:0,marks:[]};
        save(); renderPractice();
      });
  }

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
  function mmssTxt(s){ s=Math.max(0,s); var mm=Math.floor(s/60), ss=s%60; return mm+":"+(ss<10?"0":"")+ss; }
  function renderGame(){
    var g=state.game;
    $("#usName").textContent=state.team||"Our team";
    $("#usVenue").textContent=state.venue==="away"?"Away":"Home";
    $("#usScore").textContent=g.us; $("#themScore").textContent=g.them;
    var tn=$("#themName"); if(tn) tn.textContent=(g.sched&&g.sched.opponent)||"Visitors";
    var pt=$("#practiceTag"); if(pt) pt.hidden=!g.test;
    renderGamePicker();
    var pill=$("#periodPill");
    pill.classList.toggle("break",!!g.onBreak);
    pill.textContent = gameOver() ? "Full time"
      : (g.onBreak ? (g.breakKind==="half"?"Halftime":"Sub break") : "Period "+g.period+" of "+maxPeriods());
    updateClock();
    // At full time Start is the wrong verb — there is nothing left to start.
    // The button becomes the one correct action; a period that ended by mistake
    // is Fix a mistake's job, not this button's.
    var ft=atFullTime(), over=gameOver();
    var tb=$("#timerBtn");
    tb.innerHTML=over?("🏁 Final "+g.us+"–"+g.them):(ft?"🏁 Finish the game":(g.running?"⏸ Pause":"▶ Start"));
    tb.className="btn "+(ft||over?"btn-finish":(g.running?"btn-pause":"btn-start"));
    tb.disabled=over;
    var pd=$("#periodPlus"); if(pd) pd.disabled=over;
    var bb=$("#bandBtn"); if(bb) bb.innerHTML=ft?"🏁 Finish":"▶ Start";
    renderOnField();
    renderNudge();
    renderFmtCard();
    renderFixCard();
    renderGoLive();
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
    var g=state.game, s=Math.max(0,g.secs), txt=mmssTxt(s);
    var el=$("#clock");
    el.textContent=txt;
    // Requirement 6: a stopped clock mid-game must be loud — fired on manual
    // pause AND period expiry (the case the requirement actually names).
    var stopped=!!(g.started&&!g.running&&!gameOver());   // a finished game is not an alarm
    el.className="clock-big tnum"+(!stopped&&g.running?" run":"")+(!stopped&&s<=30&&s>0?" warn":"")+(stopped?" stopped":"");
    // 1b's alarm, kept in 1d: the stopped clock becomes a band with Start inside it.
    var band=$("#clockBand");
    if(band){
      band.hidden=!stopped;
      if(stopped){
        $("#bandClock").textContent=txt;
        $("#bandNote").textContent = atFullTime() ? "🏁 FULL TIME — FINISH THE GAME"
          : (s===0 ? "⏸ PERIOD OVER — TAP START" : "⏸ CLOCK STOPPED — TAP START");
      }
    }
    // Gated here rather than in renderGame because tick() only comes through
    // updateClock — otherwise Reset would stay hidden for a whole running period.
    // Both clock tags are absolute, so toggling this shifts nothing.
    var rt=$("#resetTag"); if(rt) rt.hidden=!canReset();
    updateFieldLive();   // 8b: live segment, verdicts and just-on move with the clock
    renderEnds();
    paintLock(txt);   // no-op unless the pocket lock is up
  }
  function maxPeriods(){ return state.lineup?state.lineup.Q:state.periods; }
  // Last period, clock at zero, no break running: the game is over and the only
  // correct action is to close it out. Start would silently re-run the final
  // period on a fresh 10:00 and quietly credit everyone a period they didn't play.
  function atFullTime(){
    var g=state.game;
    return !!(g.started && !g.endedAt && !g.onBreak && g.secs<=0 && g.period>=maxPeriods());
  }
  // Full time is stamped: the game is read-only until a new lineup replaces it.
  // Every clock and period action goes through this — otherwise Start would
  // re-run the last period on a fresh 10:00 and Period + would re-end a game
  // whose archive row is already closed.
  function gameOver(){ return !!state.game.endedAt; }
  // Requirement 5 (as walked back, decision 1): a secondary wall-clock readout.
  // ponytail: labelled an estimate on purpose — between-period breaks aren't modelled.
  function renderEnds(){
    var g=state.game, el=$("#endsAt"); if(!el) return;
    if(gameOver()){ el.textContent="full time"; return; }
    var left=Math.max(0,g.secs)+Math.max(0,maxPeriods()-g.period)*state.minsper*60;
    var d=new Date(nowMs()+left*1000);
    var h=d.getHours(), m=d.getMinutes(), ap=h>=12?"pm":"am"; h=h%12||12;
    el.textContent="ends ≈ "+h+":"+(m<10?"0":"")+m+" "+ap;
  }
  function tick(){
    var g=state.game;
    if(gameOver()){ g.running=false; stopTicker(); return; }   // a ticker left over from a restored doc
    if(!g.running) return;
    var elapsed=Math.floor((nowMs()-anchor)/1000);   // wall-clock anchored: a backgrounded phone doesn't run the period long
    if(elapsed<1) return;
    anchor+=elapsed*1000;
    g.secs-=elapsed;
    if(g.secs>0){ updateClock(); saveLocal(); return; }   // ponytail: local only — a full save() every second would spam the sync push
    g.secs=0;
    if(g.onBreak) advancePeriod(); else periodExpired();
  }
  // Guide: 2–3 min sub break between quarters, 5 min at halftime (10 on a hot
  // day — Fix a mistake's clock-set covers that manually). The break runs on
  // its own; only live play needs the coach's Start tap.
  function periodExpired(){
    var g=state.game, ended=g.period;
    beep();
    if(state.lineup) LineupCore.ivClose(state.lineup,curPi());   // open interval runs end with the period
    logEvent("clock",{running:false,expired:true});
    if(ended>=maxPeriods()){
      g.running=false; g.onBreak=false; g.stoppedAt=nowMs(); stopTicker();
      save(); renderGame();
      toast("Period "+ended+" over — that's full time. Tap Period + to close out the game.",true);
      return;
    }
    logEvent("period",{ended:ended});
    queueAppearances(ended);
    var half=(maxPeriods()%2===0 && ended===maxPeriods()/2);
    g.onBreak=true; g.breakKind=half?"half":"sub"; g.running=true; g.secs=half?300:150;
    anchor=nowMs(); startTicker();
    save(); renderGame();
    toast(half?"Halftime — 5 min break":"Sub break — 2–3 min, then Period "+(ended+1),true);
  }
  function advancePeriod(){
    var g=state.game, lu=state.lineup;
    var gkFn=function(p){ return (lu&&lu.keeper) ? (lu.gk||[])[Math.min(p-1,lu.Q-1)] : null; };
    var prevGk=gkFn(g.period);
    g.onBreak=false; g.running=false; g.stoppedAt=nowMs(); stopTicker();
    g.period++; g.secs=state.minsper*60;
    if(lu) LineupCore.ivOpen(lu,curPi());   // the new period's runs open at 0 — nothing elapses until Start
    beep();
    save(); renderGame();
    // The sheet rotates the keeper on its own at every period boundary — that
    // is a change to the field the coach never tapped for, so it gets said.
    var newGk=gkFn(g.period);
    if(newGk && newGk!==prevGk){
      toast("Goalkeeper change — "+nameOf(newGk)+" goes in goal for period "+g.period
        +(prevGk?", "+nameOf(prevGk)+" comes out":"")+".",true);
    }
    toast("Period "+g.period+" — tap Start when ready",true);
  }
  function startTicker(){ if(!ticker){ anchor=nowMs(); ticker=setInterval(tick,1000); } syncWake(); syncAlarm(); }
  function stopTicker(){ if(ticker){clearInterval(ticker);ticker=null;} syncWake(); syncAlarm(); }
  function beep(){
    // The Goalie-app "you cannot miss this" buzz, where the platform allows it.
    buzz([400,150,400,150,700]);
    try{
      var Ctx=window.AudioContext||window.webkitAudioContext; if(!Ctx)return;
      var ac=new Ctx(); var o=ac.createOscillator(), gain=ac.createGain();
      o.type="square"; o.frequency.value=880; o.connect(gain); gain.connect(ac.destination);
      gain.gain.setValueAtTime(.0001,ac.currentTime); gain.gain.exponentialRampToValueAtTime(.25,ac.currentTime+.02);
      gain.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+.5);
      o.start(); o.stop(ac.currentTime+.5);
    }catch(e){}
  }

  /* ---------- screen wake lock ---------- */
  // A sleeping screen kills the period alarm — beep() only fires while the page
  // is alive. Safari 16.4+ and Chrome both have this; anywhere else it's a
  // silent no-op. iOS drops the lock on backgrounding without telling us, so it
  // is re-requested on every return to visible.
  var wake=null;
  function wantAwake(){ return !!(state.game.running||lockOn); }
  async function keepAwake(on){
    try{
      if(!navigator.wakeLock) return;
      if(on && !wake){ wake=await navigator.wakeLock.request("screen"); wake.addEventListener("release",function(){ wake=null; }); }
      else if(!on && wake){ var w=wake; wake=null; await w.release(); }
    }catch(e){ wake=null; }
  }
  function syncWake(){ keepAwake(wantAwake()); }
  // The coach locks the phone out of habit, which freezes this page and the
  // local alarm with it. tick() is wall-clock anchored so the clock itself
  // catches up, but the whistle was missed — say so on the way back in.
  var hidWhileRunning=false;
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState!=="visible"){ hidWhileRunning=state.game.running; return; }
    wake=null; syncWake();
    if(!hidWhileRunning) return;
    hidWhileRunning=false;
    toast(alertsOn
      ? "Clock caught up. Tap 🔒 Lock instead of locking the phone — the alarm only sounds while the app is awake."
      : "Clock caught up. Locking the phone silences the alarm — tap 🔒 Lock instead, or turn on 🔔 Wrist alerts.",true);
  });

  /* ---------- wrist alerts (web push) ---------- */
  // A locked phone runs none of our JS, so the whistle has to come from the
  // server: every clock start registers the deadline with the Worker, every
  // stop cancels it. The push itself carries no payload — sw.js holds the text.
  var VAPID_PUB="BMGDRavQ7gT3bi95TPOAzA2N-MDyKHKSkLsUUV9w6i5uyDuoFx4FRtDWEGWxxNj4x3hCIGkXwN793rtydRsK6MQ";
  var alertsOn=false;
  function b64uToU8(s){
    var p=(s+"=".repeat((4-s.length%4)%4)).replace(/-/g,"+").replace(/_/g,"/");
    var raw=atob(p), out=new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i);
    return out;
  }
  function pushOk(){ return !!(TEAM && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window); }
  function renderAlertBtn(){
    var b=$("#alertBtn"); if(!b) return;
    b.hidden=!pushOk();
    if(b.hidden) return;
    b.textContent=alertsOn?"🔔 Wrist alerts on":"🔕 Wrist alerts off";
    b.setAttribute("aria-pressed",alertsOn?"true":"false");
  }
  // Arm or cancel the server-side alarm. Called from startTicker/stopTicker, so
  // every running-state change funnels through it exactly like the wake lock.
  function syncAlarm(){
    if(!pushOk()||!alertsOn) return;
    var g=state.game;
    var at=(g.running&&g.secs>0)?nowMs()+g.secs*1000:0;
    fetch("/api/team/"+encodeURIComponent(TEAM)+"/alarm",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({at:at})
    }).catch(function(){});   // offline: the local alarm still covers the awake case
  }
  async function toggleAlerts(){
    if(!pushOk()) return;
    var base="/api/team/"+encodeURIComponent(TEAM)+"/push";
    try{
      var reg=await navigator.serviceWorker.ready;
      var sub=await reg.pushManager.getSubscription();
      if(sub){
        await fetch(base,{method:"DELETE",headers:{"content-type":"application/json"},
          body:JSON.stringify({endpoint:sub.endpoint})}).catch(function(){});
        await sub.unsubscribe();
        alertsOn=false; renderAlertBtn(); toast("Wrist alerts off");
        return;
      }
      // Must be a direct tap — iOS only shows the permission sheet on a gesture,
      // and only for a PWA that was added to the Home Screen.
      var perm=await Notification.requestPermission();
      if(perm!=="granted"){
        toast(perm==="denied"
          ? "Notifications are blocked for this app — turn them back on in Settings."
          : "Notifications weren't allowed, so alerts stay off.",true);
        return;
      }
      sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64uToU8(VAPID_PUB)});
      var r=await fetch(base,{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({sub:sub.toJSON()})});
      if(!r.ok) throw new Error((await r.json().catch(function(){return{};})).error||("HTTP "+r.status));
      alertsOn=true; renderAlertBtn(); syncAlarm();
      toast("Wrist alerts on — the whistle reaches your watch with the phone locked.",true);
    }catch(e){
      alertsOn=false; renderAlertBtn();
      toast("Couldn't turn on alerts: "+(e&&e.message||e),true);
    }
  }
  // The subscription outlives a reload, so trust it rather than a saved flag.
  // Called from boot(), which is where TEAM finally has a value.
  function initAlerts(){
    renderAlertBtn();
    if(!pushOk()) return;
    navigator.serviceWorker.ready
      .then(function(reg){ return reg.pushManager.getSubscription(); })
      .then(function(s){ alertsOn=!!s&&Notification.permission==="granted"; renderAlertBtn(); })
      .catch(function(){});
  }

  /* ---------- pocket lock ---------- */
  // Explicit, never automatic: the coach taps subs and goals constantly, so a
  // lock that armed itself on Start would fight them. Armed when the phone goes
  // in a pocket; the clock underneath runs and still sounds the alarm.
  var lockOn=false, lockHold=null, lockEl=$("#lockScreen");
  function paintLock(txt){
    if(!lockOn||!lockEl) return;
    var g=state.game;
    var c=$("#lkClock");
    c.textContent = txt||mmssTxt(Math.max(0,g.secs));
    c.className = "lk-clock tnum display"+(g.running?"":" stopped");
    $("#lkPeriod").textContent = g.onBreak ? (g.breakKind==="half"?"Halftime":"Sub break") : "Period "+g.period+" of "+maxPeriods();
    $("#lkScore").textContent = g.us+" – "+g.them;
  }
  function setLock(on){
    if(!lockEl) return;
    lockOn=on;
    lockEl.hidden=!on;
    lockEl.classList.remove("holding");
    clearTimeout(lockHold);
    paintLock();
    syncWake();   // stay awake while locked even if the clock is paused
  }
  if(lockEl){
    lockEl.addEventListener("pointerdown",function(){
      lockEl.classList.add("holding");
      clearTimeout(lockHold);
      lockHold=setTimeout(function(){ setLock(false); buzz(40); toast("Unlocked"); },800);
    });
    ["pointerup","pointercancel","pointerleave"].forEach(function(ev){
      lockEl.addEventListener(ev,function(){ clearTimeout(lockHold); lockEl.classList.remove("holding"); });
    });
    document.addEventListener("keydown",function(e){ if(lockOn&&e.key==="Escape") setLock(false); });
  }
  /* ---------- 1d chip anatomy: this-game credit + season D/F needle ---------- */
  // Fraction of the period on the clock that has NOT been played yet.
  //   before kickoff  -> 1 (nothing has run)
  //   on a break      -> 0 (g.secs is the BREAK's countdown, and the period it
  //                     belongs to is already over — see curPi())
  function remFrac(){
    var g=state.game;
    if(!g.started) return 1;
    if(g.onBreak) return 0;
    return Math.min(1,Math.max(0, g.secs/Math.max(1,state.minsper*60)));
  }
  // Periods ACTUALLY PLAYED so far — see LineupCore.playedThrough. The raw app
  // fracs are what a player is down to play (frac:1 from build time), so the
  // live period has to be discounted by whatever is still on the clock.
  function playedSoFar(lu,pi,id){
    return LineupCore.playedThrough(lu,pi,id,curPi(),remFrac());
  }
  // Deliberately NOT elapsed: this backs the "one period in goal each" cap, and
  // a keeper halfway through their period must already count as capped or the
  // next-keeper picker would offer them a second one.
  function keptSoFar(lu,pi,id){
    var n=0;
    (lu.app||[]).slice(0,pi+1).forEach(function(es){ es.forEach(function(e){ if(e.id===id&&e.pos==="GK"&&e.frac>1e-9) n+=e.frac; }); });
    return n;
  }
  /* ---------- 8b chip anatomy: season D/F strip + verdict + interval track ---------- */
  // Season D/F strip: F block over D block, heights = season shares from
  // positionTotals. Solid blocks replaced 2c's needle — same data, less ink.
  function stripHtml(t){
    var d=(t&&t.D)||0, f=(t&&t.F)||0, tot=d+f;
    var fp=tot?Math.round(f/tot*100):0, dp=tot?Math.round(d/tot*100):0;
    return '<span class="dfstrip"><i class="f" style="height:'+fp+'%"></i><i class="d" style="height:'+dp+'%"></i></span>';
  }
  // How far through the period on the clock, 0..1 — remFrac's complement, so
  // the break and pre-kickoff cases are already right.
  function periodT(){ return 1-remFrac(); }
  // Verdict + "just on" badge for the name row. One source of markup: the full
  // render and the 1 Hz live update both come through here.
  function liveHtml(lu,id,api,pt){
    var v=LineupCore.minVerdict(LineupCore.ivPlayed(lu,id,api,pt),lu.Q,api+pt);
    return (LineupCore.ivJustOn(lu,id,api,pt,lu.minsper)?'<span class="badge-juston">just on</span>':'')
      +'<span class="verdict '+v.k+'">'+v.label+'</span>';
  }
  // The four-segment track: the dark fill sits WHERE the minutes happened, so a
  // leave-and-return shows a real break. Texture carries the meaning, not hue —
  // dark = played, flat grey = elapsed while they sat, stripes = not yet.
  function trackHtml(lu,id,api,pt){
    var Q=lu.Q, MIN=Q>1?Q-1:Q, iv=lu.iv||[], out="";
    function spans(q,cap){
      return ((iv[q]||{})[id]||[]).map(function(v){
        var a=v[0], b=v[1]==null?cap:Math.min(v[1],cap);
        return b-a>0.0005?'<i class="iv" style="left:'+r1(a*100)+'%;width:'+r1((b-a)*100)+'%"></i>':"";
      }).join("");
    }
    for(var q=0;q<Q;q++){
      if(q<api||(q===api&&pt>=0.999)) out+='<span class="seg past">'+spans(q,1)+'</span>';
      else if(q===api) out+='<span class="seg live"><i class="el" style="width:'+r1(pt*100)+'%"></i><i class="fut" style="left:'+r1(pt*100)+'%"></i>'+spans(q,pt)+'</span>';
      else out+='<span class="seg fut"></span>';
    }
    return '<span class="track">'+out+'<i class="notch" style="left:'+(MIN/Q*100)+'%"></i></span>';
  }
  // 8b render cadence: the live segment, verdicts and the just-on badge move
  // with the clock, but rebuilding #onFieldChips innerHTML every second would
  // drop the tap-selection state — so only the pieces inside each existing
  // chip are rewritten. Full renderOnField stays on sub/swap/period/build.
  function updateFieldLive(){
    var lu=state.lineup, prog=$("#fmProg");
    if(!lu){ if(prog) prog.textContent=""; return; }
    var api=curPi(), pt=periodT(), gone=Math.min(lu.Q,api+pt);
    if(prog) prog.textContent=r1(gone)+"p played · "+r1(lu.Q-gone)+"p left";
    $$(".field-mini .jchip[data-id]").forEach(function(ch){
      var id=ch.dataset.id;
      var lv=ch.querySelector(".jlive"); if(lv) lv.innerHTML=liveHtml(lu,id,api,pt);
      var tr=ch.querySelector(".track"); if(tr) tr.outerHTML=trackHtml(lu,id,api,pt);
    });
  }

  var nkOpen=false;
  var ROW_STATS=false;   // per-row ⚽/🥅 loggers — hidden for now, feature kept
  function renderOnField(){
    var box=$("#onFieldChips"), sub=$("#subLine"), note=$("#benchNote"), hintEl=$("#fmHint"), fmtChip=$("#fmtChip");
    if(!state.lineup){
      box.className="onfield";
      box.innerHTML='<span class="hint" style="color:rgba(255,255,255,.7)">Build a lineup on the first tab to see who\'s on.</span>';
      sub.innerHTML=""; note.innerHTML=""; if(hintEl) hintEl.hidden=true; if(fmtChip) fmtChip.hidden=true;
      var prog0=$("#fmProg"); if(prog0) prog0.textContent="";
      return;
    }
    // api = periods actually played (what the "1.5p" numbers count).
    // pi  = the period being shown and edited — the next one during a break.
    var lu=state.lineup, brk=onBreakNext(), api=curPi(), pi=editPi();
    // Belt-and-braces for a doc written by a pre-iv shell (or a mixed SW cache
    // serving an old state.js): synthesize the interval ledger before reading
    // it, or every verdict reads "on from now" off an empty lu.iv. Idempotent.
    LineupCore.ensureIv(lu, state.game.started?Math.min(state.game.period,lu.periods.length):0);
    function nm(id){ if(!id) return "—"; var p=byId(id); return p?p.name:"?"; }
    var onNow=lu.periods[pi]||[], gkNow=(lu.gk||[])[pi];
    var posTot=posTotals(lu);

    if(fmtChip){ fmtChip.hidden=false; $("#fmtLabel").textContent=lu.keeper?"With keeper":"No keeper"; }
    var titleEl=$("#fmTitle");
    if(titleEl) titleEl.textContent = brk ? "Starting period "+(pi+1) : "On the field";
    var panel=$(".field-mini"); if(panel) panel.classList.toggle("break",brk);
    // Fixed-length copy, no names: the hint sits above the chips, so a line
    // break here shoves the whole field panel down mid-tap.
    if(hintEl){
      hintEl.hidden=false;
      hintEl.classList.toggle("armed",!!sel);
      hintEl.textContent = sel
        ? (brk ? "Tap a teammate to swap, or a bench name to sub." : "Tap a teammate to swap, or a bench name to sub.")
        : (brk ? "This is who starts the next period — change it now, while you have them."
               : "Tap a player, then tap who takes their place.");
    }

    // Next sub, computed from time actually played (1d port note): longest on
    // goes off — keeper excluded, they finish the period in goal — and the
    // least-played bench player comes on. Ties break by season-owed (totPlayed,
    // the builder's own metric), NOT by name: an alphabetical tie-break made
    // the same kids the #1 rec every game and drifted their season a dozen
    // periods (bug-118, measured in test/season.test.mjs). Owed-aware ties
    // make rec-followed subs repay the season instead of shaving it.
    var offSorted=onNow.filter(function(id){ return id!==gkNow; })
      .map(function(id){ return {id:id, v:playedSoFar(lu,api,id)}; })
      .sort(function(a,b){ return b.v-a.v || totPlayed(lu,b.id)-totPlayed(lu,a.id) || nm(a.id).localeCompare(nm(b.id)); });
    var benchSorted=state.roster.filter(function(p){ return p.present && onNow.indexOf(p.id)<0; })
      .map(function(p){ return {id:p.id, v:playedSoFar(lu,api,p.id)}; })
      .sort(function(a,b){ return a.v-b.v || totPlayed(lu,a.id)-totPlayed(lu,b.id) || nm(a.id).localeCompare(nm(b.id)); });
    var nPairs=Math.min(offSorted.length,benchSorted.length);
    var offList=offSorted.slice(0,nPairs), onList=benchSorted.slice(0,nPairs);

    function selCls(id,where){ return (sel&&sel.id===id&&sel.where===where)?" sel":""; }
    function posOf(id){ return id===gkNow?"GK":(LineupCore.posInPeriod(lu,pi,id)||"F"); }
    var pt=periodT();
    updateFieldLive();   // the h3 "1.4p played · 2.6p left" readout
    function fieldChip(id,bench){
      var where=bench?"bench":"field";
      return '<button class="jchip'+(bench?" bench":"")+selCls(id,where)+'" data-act="chip" data-where="'+where+'" data-id="'+id+'">'
        +stripHtml(posTot[id])
        +'<span class="jbody">'
        +'<span class="jname"><span class="nm">'+esc(nm(id))+'</span><span class="jlive">'+liveHtml(lu,id,api,pt)+'</span></span>'
        +trackHtml(lu,id,api,pt)
        +'</span></button>';
    }
    function chip1(id){
      var st=(state.game.playerStats||{})[id]||{goals:0,sog:0};
      return '<div class="jrow">'+fieldChip(id,false)
        // Hidden for now, NOT retired: sogTap, openGoalDialog and the delegated
        // goal/sog acts stay wired — flip ROW_STATS to bring the column back.
        +(ROW_STATS?'<span class="jstat">'
          +'<button class="statbtn" data-act="goal" data-id="'+id+'" title="Goal">⚽<b>'+st.goals+'</b></button>'
          +'<button class="statbtn" data-act="sog" data-id="'+id+'" title="Shot on goal">🥅<b>'+st.sog+'</b></button>'
          +'</span>':"")
        +'</div>';
    }
    // Rows are never re-sorted by played time: group order is fixed GK, D, F,
    // and within a group the existing period order holds.
    box.className="onfield";
    var groups={GK:[],D:[],F:[]};
    onNow.forEach(function(id){ groups[posOf(id)].push(id); });
    box.innerHTML=["GK","D","F"].filter(function(k){ return groups[k].length; }).map(function(k){
      return '<div class="posrow"><div class="rail '+k.toLowerCase()+'">'+k+'</div><div class="stack">'
        +groups[k].map(chip1).join("")+'</div></div>';
    }).join("");

    var rows;
    if(brk){
      // The break briefing: what actually changes between the period that just
      // ended and the one about to start. This is the list read out to the team.
      var prev=lu.periods[pi-1]||[], gkPrev=(lu.gk||[])[pi-1];
      var comingOff=prev.filter(function(id){ return onNow.indexOf(id)<0; });
      var comingOn=onNow.filter(function(id){ return prev.indexOf(id)<0; });
      var kChange=lu.keeper && gkNow && gkNow!==gkPrev;
      var line=function(cls,lab,ids){
        return '<div class="chg-row '+cls+'"><span class="lab">'+lab+'</span><b>'
          +(ids.length?ids.map(function(id){ return esc(nm(id)); }).join(", "):"nobody")+'</b></div>';
      };
      rows='<div class="sph">Changes for period '+(pi+1)+'</div><div class="changes">'
        +line("off","Coming off",comingOff)
        +line("on","Going on",comingOn)
        +(kChange?'<div class="chg-row gk"><span class="lab">In goal</span><b>'+esc(nm(gkNow))
          +'</b><span class="was">'+(gkPrev?"was "+esc(nm(gkPrev)):"")+'</span></div>':"")
        +'</div>'
        +'<div class="why">'+(comingOff.length||comingOn.length||kChange
          ? "Tell them now — the whistle does not wait. Tap any two players to change this before the period starts."
          : "Same eleven back out. Tap any two players to change that before the period starts.")+'</div>';
    } else {
      // The top three swaps, ranked — a coach glances once and reads them off.
      var pairs=[]; for(var pz=0; pz<nPairs && pz<3; pz++){ pairs.push([offList[pz],onList[pz]]); }
      rows='<div class="sph">Next subs — in priority order</div>'
        +(pairs.length
          ? '<div class="subpairs">'+pairs.map(function(pr,i){
              return '<div class="sp"><span class="rk">'+(i+1)+'</span>'
                +'<span class="sd off"><span class="who">'+esc(nm(pr[0].id))+'</span><span class="pv">'+r1(pr[0].v)+'p</span></span>'
                +'<span class="ar">→</span>'
                +'<span class="sd on"><span class="who">'+esc(nm(pr[1].id))+'</span><span class="pv">'+r1(pr[1].v)+'p</span></span>'
                +'</div>';
            }).join("")+'</div>'
          : '<div class="why">No swaps available — the bench is empty.</div>')
        +'<div class="why">Longest on the field goes off; least played comes on.'
        +(lu.keeper&&gkNow?" "+esc(nm(gkNow))+" stays in goal until the period ends.":"")+'</div>';
    }
    // Next keeper is an editable button + collapsed picker (1d port note:
    // picking writes lu.gk[pi+1] — a future period, no credit change).
    // Hidden during a break: the keeper for the period starting is in the
    // changes list above, and a second keeper row would read as the same thing.
    if(lu.keeper && !brk && pi+1<lu.Q){
      var nk=(lu.gk||[])[pi+1];
      rows+='<button class="nk-btn" data-act="nk-toggle"><span class="lab">Next keeper</span><b>'+esc(nm(nk))+'</b><span class="chg">Change ▾</span></button>';
      if(nkOpen){
        rows+='<div class="nk-pick">'+(lu.periods[pi+1]||[]).map(function(id){
          var used=keptSoFar(lu,api,id), capped=used>=0.999&&id!==nk;
          if(capped) return '<span class="kchip capped">'+esc(nm(id))+'<span class="lb">capped</span></span>';
          return '<button class="kchip'+(id===nk?" sel":"")+'" data-act="nk-pick" data-id="'+id+'">'+esc(nm(id))+'<span class="lb">'+r1(used)+' in goal</span></button>';
        }).join("")+'</div>'
        +'<div class="nk-note">One period in goal each — anyone already at 1.0 is capped and greyed. Picking here only sets the next period; tap the GK chip and a field player to change the keeper right now.</div>';
      }
    }
    sub.innerHTML=rows;

    if(benchSorted.length){
      note.innerHTML='<div class="bhrow"><span class="bh">'+(brk?"Sitting out period "+(pi+1):"Bench")+'</span>'
        +'<span class="bkey">Notch = '+(lu.Q>1?lu.Q-1:lu.Q)+'-period minimum</span></div>'
        +'<div class="benchchips">'+benchSorted.map(function(b){ return fieldChip(b.id,true); }).join("")+'</div>';
    } else {
      note.innerHTML='<span class="bh">Everyone\'s on the field this period.</span> Tap two players to swap positions.';
    }
  }

  // Port note (1d): the keeper picker writes lu.gk[pi+1] — a future period,
  // so no played credit moves; only the plan and its projection ledger do.
  function pickNextKeeper(id){
    var lu=state.lineup; if(!lu||!lu.keeper) return;
    var q=curPi()+1; if(q>=lu.Q) return;
    var res=LineupCore.setFutureKeeper(lu,q,id);
    nkOpen=false;
    if(!res){ renderOnField(); return; }
    lu.handEdited=true;
    logEvent("keeper_next",{out:res.out,"in":id,forPeriod:q+1},id);
    save(); renderLineup(); renderOnField();
    toast(nameOf(id)+" set to keep period "+(q+1));
  }

  /* ---------- clock edit: tap → confirm → set-clock sheet (1d) ---------- */
  var clkStep=null, clkDraft=0;
  function drawClkDialog(){
    var dlg=$("#clkDialog"); if(!dlg) return;
    var cur=mmssTxt(state.game.secs);
    if(clkStep==="confirm"){
      dlg.innerHTML='<h4>Edit the clock?</h4>'
        +'<p>The clock is what credits playing time. An edit is logged as a correction at '+cur+' and can be undone from Fix a mistake.</p>'
        +'<div class="btns"><button class="btn ghost" data-act="clk-cancel">Cancel</button><button class="btn cone" data-act="clk-yes">Yes, edit</button></div>';
    } else {
      dlg.innerHTML='<div class="hd"><h4>Set the clock</h4><span class="was tnum">was '+cur+'</span></div>'
        +'<div class="clock-big tnum draft">'+mmssTxt(clkDraft)+'</div>'
        +'<div class="steps">'
        +'<div><span class="lab">Minutes</span><div class="pair"><button data-act="clk-d" data-d="-60">−</button><button data-act="clk-d" data-d="60">+</button></div></div>'
        +'<div><span class="lab">Seconds</span><div class="pair"><button data-act="clk-d" data-d="-10">−</button><button data-act="clk-d" data-d="10">+</button></div></div>'
        +'</div>'
        +'<p>Saving pauses the clock at '+mmssTxt(clkDraft)+'. Playing time already credited is not changed.</p>'
        +'<div class="btns"><button class="btn ghost" data-act="clk-cancel">Cancel</button><button class="btn" style="flex:2" data-act="clk-save">Save clock</button></div>';
    }
  }
  function openClockEdit(){
    var dlg=$("#clkDialog"); if(!dlg||!dlg.showModal) return;
    clkStep="confirm"; drawClkDialog();
    if(!dlg.open) dlg.showModal();
  }
  function closeClk(){ var dlg=$("#clkDialog"); clkStep=null; if(dlg&&dlg.open) dlg.close(); }
  function saveClock(){
    var g=state.game, from=Math.max(0,g.secs);
    g.secs=clkDraft; g.running=false; stopTicker(); if(g.started) g.stoppedAt=nowMs();
    logEvent("clock_set",{from:from,to:clkDraft});
    closeClk(); save(); renderGame();
    toast("Clock set to "+mmssTxt(clkDraft)+" — paused");
  }

  /* ---------- player card ----------
     One sheet, three framings. The design ships 1a (over Game Day), 1b (full
     screen from the Roster) and 1c (a child who isn't playing today) — but its
     own note says "blocks and their order are identical in all three; only the
     chrome and the dismiss change". So this is ONE render: the blocks decide for
     themselves whether they have anything to say, and the action bar drops the
     rows that don't apply. ponytail: three layouts would be three things to keep
     in step for one difference nobody can see side by side on a phone.

     Everything here is derived from what the app already stores — lu.app,
     lu.periods, state.played/kept, posTotals and g.recent — except the two
     genuinely new fields, p.num (jersey) and p.notes. The third "new" in the
     design, stamped attendance, is DERIVED instead: a player with appearance
     rows in a game played it. That skips a schema change for a number the
     archive can already answer. */
  var card=null;              // player id while the sheet is open
  function minPeriods(){ return Math.ceil(maxPeriods()*0.75); }   // the guide's 3-of-4
  function posName(p){ return p==="GK"?"in goal":(p==="D"?"defense":"forward"); }
  // Season periods played: banked games plus what has ACTUALLY run this game.
  // Not totPlayed() — lu.actual is a whole-game projection and would credit a
  // player periods they have not walked onto the field for yet.
  function seasonPlayed(id){
    var lu=state.lineup;
    return (state.played[id]||0) + (lu?playedSoFar(lu,curPi(),id):0);
  }
  // Per-period share for one player, from the ledger the chips already read.
  function fracIn(q,id){
    var n=0;
    (((state.lineup||{}).app||[])[q]||[]).forEach(function(e){ if(e.id===id&&e.frac>1e-9) n+=e.frac; });
    return n;
  }
  function posIn(q,id){
    var by={}, best=null;
    (((state.lineup||{}).app||[])[q]||[]).forEach(function(e){ if(e.id===id&&e.frac>1e-9) by[e.pos]=(by[e.pos]||0)+e.frac; });
    Object.keys(by).forEach(function(p){ if(!best||by[p]>by[best]) best=p; });
    return best;
  }

  // Per-game appearance rows, cached in the archive (device-local, like games)
  // rather than on the synced doc — roster x games x positions is too much to
  // push through the save file every keystroke.
  function cardGames(id){
    var arch=loadArchive(), by={};
    (arch.byGame||[]).forEach(function(r){
      if(r.player_id!==id) return;
      var e=by[r.game_id]=by[r.game_id]||{periods:0,pos:{}};
      e.periods+=(+r.periods||0); e.pos[r.pos]=(e.pos[r.pos]||0)+(+r.periods||0);
    });
    return (arch.games||[]).filter(function(g){ return g.id!==(state.game&&state.game.gid); })
      .map(function(g){ return {g:g, a:by[g.id]||null}; });
  }
  async function loadCardData(){
    if(!BACKEND||!TEAM) return;
    var base="/api/team/"+encodeURIComponent(TEAM), season=encodeURIComponent(state.season||"");
    var gid=encodeURIComponent((state.game&&state.game.gid)||"");
    try{
      var arch=loadArchive();
      var rg=await fetch(base+"/games?season="+season);
      if(rg.ok) arch.games=(await rg.json()).games||[];
      var rp=await fetch(base+"/positions?season="+season+"&exclude="+gid+"&byGame=1");
      if(rp.ok){
        var j=await rp.json(), map={};
        (j.positions||[]).forEach(function(r){ (map[r.player_id]=map[r.player_id]||{})[r.pos]=r.periods; });
        state.posTotals=map; saveLocal();     // cache only — must not re-trigger the push cycle
        arch.byGame=j.byGame||[];
      }
      saveArchive(arch);
      if(card) drawCard();
    }catch(e){}
  }

  function openCard(id){
    if(!byId(id)) return;
    card=id;
    var dlg=$("#cardDialog");
    if(dlg&&dlg.showModal&&!dlg.open) dlg.showModal();
    drawCard();
    loadCardData();
  }
  function closeCard(){ card=null; var d=$("#cardDialog"); if(d&&d.open) d.close(); }

  function drawCard(){
    var dlg=$("#cardDialog"), id=card; if(!dlg||!id) return;
    var p=byId(id); if(!p){ closeCard(); return; }
    var lu=state.lineup, g=state.game, Q=maxPeriods(), mp=minPeriods();
    var pi=lu?editPi():0, api=lu?curPi():0;
    var onField=!!(lu && (lu.periods[pi]||[]).indexOf(id)>=0);
    var isGk=!!(lu && lu.keeper && (lu.gk||[])[pi]===id);
    var sheetOf=!!(lu && rosterState(p)==="in");             // on today's sheet at all
    var today=lu?playedSoFar(lu,api,id):0;
    var kept=totKept(lu,id);
    var tot=posTotals(lu)[id]||{GK:0,D:0,F:0};
    var season=seasonPlayed(id);

    // Rank: the squad ordered by season periods. "6th of 8" is the sentence the
    // design leads with, and it is the only comparison a parent ever asks about.
    var squad=state.roster.map(function(x){ return {id:x.id, v:seasonPlayed(x.id)}; })
      .sort(function(a,b){ return b.v-a.v; });
    var rank=squad.map(function(x){ return x.id; }).indexOf(id)+1;
    var avg=squad.reduce(function(a,x){ return a+x.v; },0)/Math.max(1,squad.length);
    var top=squad.length?squad[0].v:0;

    // Periods still to play in this game, and how many of them this child needs
    // to clear the minimum. Positive spare = they can sit; negative = they must
    // go back on. This is the number the whole Today block exists for.
    var left=lu?((Q-1-api)+remFrac()):0;
    var need=Math.max(0,mp-today), spare=left-need;

    function pill(cls,txt){ return '<span class="cpill '+cls+'">'+esc(txt)+'</span>'; }
    function tile(v,lab,cls){ return '<div class="ctile"><b class="'+(cls||"")+'">'+esc(v)+'</b><i>'+esc(lab)+'</i></div>'; }

    /* -- head -- */
    var sub;
    if(!sheetOf) sub="Marked "+(rosterState(p)==="late"?"late":"out")+" today";
    else if(!lu) sub="No lineup built yet";
    else if(onField) sub=(isGk?"In goal":posName(posIn(pi,id)||"F").replace(/^./,function(c){return c.toUpperCase();}))
      +" · on the field · period "+(pi+1)+" of "+Q;
    else sub="On the bench · period "+(pi+1)+" of "+Q;

    var pills="";
    if(!sheetOf) pills+=pill("mute","Out today");
    else if(onField) pills+=pill("go",isGk?"In goal":"On the field");
    else pills+=pill("mute","On the bench");
    if(lu&&lu.keeper&&kept<0.05) pills+=pill("warn","Never in goal");
    else if(kept>0.05) pills+=pill("mute",r1(kept)+"p in goal this season");
    if(sheetOf&&lu&&today+left<mp-1e-9) pills+=pill("warn","Short of the minimum");

    // "Name and number go grey when a child isn't in today's squad — the only
    // colour change between states" (design 1c).
    var head='<div class="chead'+(sheetOf?"":" out")+'">'
      +'<div class="ctitle">'
      +'<span class="nm">'+esc(p.name)+'</span>'
      +'<button class="cnum" data-act="card-num">'+(p.num?"#"+esc(p.num):"+ #")+'</button>'
      +'</div>'
      +'<div class="csub">'+esc(sub)+'</div>'
      +'<div class="cpills">'+pills+'</div>'
      +'<button class="cclose" data-act="card-close" aria-label="Close">×</button>'
      +'</div>';

    /* -- today -- */
    var todayBody;
    if(!lu){
      todayBody='<p class="cnote">No lineup for today yet. Build one on Roster &amp; Lineup and this fills in.</p>';
    } else if(!sheetOf){
      todayBody='<p class="cnote">Not on today\'s sheet. They were marked out before the lineup was built, so nothing is counted against them — the season figures below are unaffected.</p>';
    } else {
      var bars="";
      for(var q=0;q<Q;q++){
        var f=Math.min(1,fracIn(q,id));
        var cls = q<api ? "done" : (q===api ? "live" : "plan");
        bars+='<span class="cbar '+cls+'"><i style="width:'+Math.round(f*100)+'%"></i></span>';
      }
      var labs=""; for(var q2=0;q2<Q;q2++) labs+='<span>P'+(q2+1)+'</span>';
      var verdict = spare>=0
        ? '<b class="ok">+'+r1(spare)+'p spare.</b> They can sit '+r1(spare)+' of a period more and still clear the '+mp+'-period minimum.'
        : '<b class="bad">'+r1(-spare)+'p short.</b> There is not enough game left to reach the '+mp+'-period minimum — put them on now.';
      var dom=posIn(api,id)||posIn(pi,id);
      todayBody='<div class="cbars">'+bars+'<span class="cnotch" style="left:'+(mp/Q*100)+'%"></span></div>'
        +'<div class="cbarlabs">'+labs+'</div>'
        +'<p class="cnote">'+verdict+' The notch is the minimum.</p>'
        +'<div class="ctiles">'
        +tile(Math.round(today*state.minsper),"minutes")
        +tile(r1(today)+"p","of "+Q+" periods")
        +tile(dom||"—",dom?posName(dom):"not on yet",dom==="GK"?"gk":(dom==="D"?"d":"f"))
        +'</div>'
        +'<div class="clist">'+cardTimeline(id).map(function(r){
          return '<div class="crow"><span class="k">'+esc(r.k)+'</span><span class="v">'+r.v+'</span></div>';
        }).join("")+'</div>';
    }

    /* -- season -- */
    var gsplit=tot.GK||0, dsplit=tot.D||0, fsplit=tot.F||0, gtot=Math.max(1e-9,gsplit+dsplit+fsplit);
    var seasonBody='<div class="cbig"><b class="tnum">'+r1(season)+'</b>'
      +'<span>periods played · <b>'+rank+ordinal(rank)+' of '+squad.length+'</b><br>'
      +(Math.abs(season-avg)<0.05&&Math.abs(season-top)<0.05
        ? "level with the whole squad"
        : cmpTxt(season-avg,"the squad average")+", "+cmpTxt(season-top,"the top"))+'</span></div>'
      +'<div class="csplit">'
      +'<span class="d" style="width:'+(dsplit/gtot*100)+'%"></span>'
      +'<span class="f" style="width:'+(fsplit/gtot*100)+'%"></span>'
      +'<span class="gk" style="width:'+(gsplit/gtot*100)+'%"></span></div>'
      +'<div class="ckey"><span><i class="d"></i>D '+r1(dsplit)+'</span><span><i class="f"></i>F '+r1(fsplit)
      +'</span><span><i class="gk"></i>GK '+r1(gsplit)+'</span></div>';
    if(lu&&lu.keeper&&kept<0.05){
      var others=state.roster.filter(function(x){ return x.id!==id && totKept(lu,x.id)>0.05; }).length;
      seasonBody+='<p class="cnote"><b class="bad">Never in goal.</b> '
        +(others===state.roster.length-1?"The only player on the squad yet to take a turn.":others+" of the squad have had a turn.")+'</p>';
    }
    var played=cardGames(id), gp=played.filter(function(x){ return x.a; }).length;
    seasonBody+='<div class="ctiles">'
      +tile(played.length?(gp+" of "+played.length):"—","games played")
      +tile(gp?Math.round((season-today)*state.minsper/gp):"—","avg min / game")
      +tile(r1(kept),"periods in goal")+'</div>';

    /* -- game over game -- */
    var gog="";
    if(lu&&sheetOf&&g.gid) gog+='<div class="crow live"><span class="k">now</span><span class="v">'
      +esc(state.venue==="away"?"Away":"Home")+' · <b>'+r1(today)+'p</b> so far</span><span class="lv">live</span></div>';
    gog+=played.slice(0,8).map(function(x){
      var d=new Date(x.g.started_at), when=(d.getMonth()+1)+"/"+d.getDate();
      if(!x.a) return '<div class="crow out"><span class="k">'+when+'</span><span class="v">Did not play</span></div>';
      var poss=["GK","D","F"].filter(function(k){ return x.a.pos[k]>0.05; }).join(" ");
      return '<div class="crow"><span class="k">'+when+'</span><span class="v"><b>'+r1(x.a.periods)+'p</b> · '
        +esc(poss)+' · '+x.g.us+'–'+x.g.them+'</span></div>';
    }).join("");
    if(!played.length) gog+='<div class="cempty">No archived games yet this season.</div>';

    /* -- notes -- */
    var notes=(p.notes||[]).map(function(n,i){
      var d=new Date(n.at), when=(d.getMonth()+1)+"/"+d.getDate();
      return '<div class="cnoteitem '+(n.kind||"")+'"><span class="k">'+when+(n.period?" · P"+n.period:"")+'</span>'
        +'<span class="t">'+esc(n.text)+'</span>'
        +'<button class="x" data-act="card-note-del" data-i="'+i+'" aria-label="Delete note">×</button></div>';
    }).join("") || '<div class="cempty">No notes yet. ✎ adds one against today\'s period.</div>';

    /* -- actions: a row withdraws itself rather than sitting there wrong -- */
    var acts="";
    // The keeper is sub-able like anyone else — applySub carries the goal with
    // them — so this is on-field vs not, never on-field-and-not-keeper. A keeper
    // with no primary action at all was the first thing this got wrong.
    if(onField&&lu) acts+='<button class="btn" data-act="card-sub">Sub now</button>';
    else if(sheetOf&&lu) acts+='<button class="btn" data-act="card-sub">Put on now</button>';
    if(onField&&lu&&lu.keeper&&!isGk) acts+='<button class="btn ghost" data-act="card-gk">Into goal</button>';
    acts+='<button class="btn ghost sq" data-act="card-note" title="Add a note">✎</button>'
      +'<button class="btn ghost sq" data-act="card-copy" title="Copy summary">⧉</button>';
    // With no sub to offer, the roster's own IN/LATE/OUT toggle takes the slot —
    // for a child who isn't playing, that IS the action worth having here.
    if(!sheetOf||!lu) acts+='<button class="btn ghost" data-act="toggle-present" data-id="'+id+'">'
      +(rosterState(p)==="in"?"Mark late":(rosterState(p)==="late"?"Mark out":"Mark in"))+'</button>';

    // innerHTML rebuild loses the scroll position, and every action in here
    // (a note, a number, a sub) redraws — landing the coach back at the top.
    var keep=dlg.querySelector(".cbody"); keep=keep?keep.scrollTop:0;
    dlg.innerHTML=head
      +'<div class="cbody">'
      +'<div class="cblk"><div class="chd"><span>Today</span><span class="w">'+esc(g.onBreak?"break":"period "+(pi+1))+'</span></div>'+todayBody+'</div>'
      +'<div class="cblk"><div class="chd"><span>Season</span><span class="w">'+esc(state.season||"")+'</span></div>'+seasonBody+'</div>'
      +'<div class="cblk"><div class="chd"><span>Game over game</span></div><div class="clist">'+gog+'</div></div>'
      +'<div class="cblk"><div class="chd"><span>Notes</span></div><div class="cnotes">'+notes+'</div></div>'
      +'</div>'
      +'<div class="cacts">'+acts+'</div>';
    if(keep) dlg.querySelector(".cbody").scrollTop=keep;
  }
  function ordinal(n){ var s=["th","st","nd","rd"], v=n%100; return s[(v-20)%10]||s[v]||s[0]; }
  function cmpTxt(d,what){
    if(Math.abs(d)<0.05) return "level with "+what;
    return r1(Math.abs(d))+(d>0?" ahead of ":" behind ")+what;
  }
  // Period rows from the ledger, interleaved with this game's sub/keeper events.
  // g.recent is capped at 8, so the period rows carry the shape and the events
  // add the clock detail wherever it is still in the buffer.
  function cardTimeline(id){
    var lu=state.lineup, rows=[], last=curPi();
    for(var q=0;q<=last&&q<maxPeriods();q++){
      var f=fracIn(q,id), pos=posIn(q,id);
      rows.push({period:q+1, secs:1e9,
        k:"P"+(q+1), v:f>1e-9 ? '<b>'+r1(Math.min(f,1))+'p</b> · '+esc(posName(pos)) : "sat out"});
    }
    (state.game.recent||[]).forEach(function(ev){
      var d=ev.detail||{};
      if(ev.kind==="sub"&&d.out===id) rows.push({period:ev.period,secs:ev.secs,k:"P"+ev.period+" · "+mmssTxt(ev.secs),v:"Off — "+esc(nameOf(d["in"]))+" on"});
      if(ev.kind==="sub"&&d["in"]===id) rows.push({period:ev.period,secs:ev.secs,k:"P"+ev.period+" · "+mmssTxt(ev.secs),v:"On for "+esc(nameOf(d.out))});
      if(ev.kind==="keeper"&&d["in"]===id) rows.push({period:ev.period,secs:ev.secs,k:"P"+ev.period+" · "+mmssTxt(ev.secs),v:"Into goal for "+esc(nameOf(d.out))});
    });
    return rows.sort(function(a,b){ return (a.period-b.period)||(b.secs-a.secs); });
  }

  function cardSummary(id){
    var p=byId(id), lu=state.lineup, tot=posTotals(lu)[id]||{};
    return p.name+(p.num?" #"+p.num:"")+" — "+(state.season||"season")+"\n"
      +"Today: "+r1(lu?playedSoFar(lu,curPi(),id):0)+" of "+maxPeriods()+" periods ("+Math.round((lu?playedSoFar(lu,curPi(),id):0)*state.minsper)+" min)\n"
      +"Season: "+r1(seasonPlayed(id))+" periods · "+r1(totKept(lu,id))+" in goal\n"
      +"Positions: D "+r1(tot.D||0)+" · F "+r1(tot.F||0)+" · GK "+r1(tot.GK||0);
  }

  function cardAddNote(){
    var id=card; if(!id) return;
    ask({title:"Note about "+nameOf(id), body:"Kept on this device and synced with the team doc. Injuries, requests, anything you want next Saturday's you to know.",
      input:"", placeholder:"e.g. asked to play in goal", ok:"Save note"}).then(function(txt){
      if(!txt) return;
      var p=byId(id); if(!p) return;
      (p.notes=p.notes||[]).unshift({at:nowMs(), period:state.game.period, text:txt});
      if(p.notes.length>20) p.notes.length=20;
      save(); drawCard(); toast("Note saved against "+p.name);
    });
  }
  function cardSetNum(){
    var p=byId(card); if(!p) return;
    ask({title:"Jersey number", body:"Shown on the card and in the copied summary.", input:p.num||"", placeholder:"e.g. 7", ok:"Save"})
      .then(function(v){
        if(v===null) return;
        p.num=String(v).replace(/[^0-9]/g,"").slice(0,3)||"";
        save(); drawCard(); renderRoster();
      });
  }
  // Sub straight from the card: the partner is the app's own recommendation, so
  // this is the ranked list's top pair with one of its ends already chosen.
  function cardSub(){
    var lu=state.lineup, id=card; if(!lu||!id) return;
    var pi=editPi(), on=(lu.periods[pi]||[]).indexOf(id)>=0;
    var pool=state.roster.filter(function(x){
      return x.present && ((lu.periods[pi]||[]).indexOf(x.id)>=0)!==on && x.id!==id;
    }).map(function(x){ return {id:x.id, v:playedSoFar(lu,curPi(),x.id)}; })
      .sort(function(a,b){ return on ? a.v-b.v : b.v-a.v; });
    if(!pool.length){ toast(on?"Nobody on the bench to bring on.":"Nobody to come off."); return; }
    var other=pool[0].id;
    var outId=on?id:other, inId=on?other:id;
    ask({title:nameOf(inId)+" on for "+nameOf(outId)+"?",
      body:nameOf(inId)+" has played "+r1(playedSoFar(lu,curPi(),inId))+"p, "+nameOf(outId)+" "+r1(playedSoFar(lu,curPi(),outId))+"p."
        +"\n\nThis is the app's own next-sub pick. Cancel and use the field panel to choose someone else.",
      ok:"Make the sub"}).then(function(ok){
      if(!ok) return;
      subNow(outId,inId); drawCard();
    });
  }

  /* ---------- Fix a mistake (3a): corrections, never deletions ---------- */
  var fixOpen=null;
  function fixLabel(ev){
    var d=ev.detail||{};
    if(ev.kind==="goal") return d.side==="us"?(d.playerId?nameOf(d.playerId)+" scores":"Goal — "+(state.team||"us")):"Goal — Visitors";
    if(ev.kind==="sog") return nameOf(d.playerId)+" — shot on goal";
    if(ev.kind==="sub") return nameOf(d["in"])+" on for "+nameOf(d.out);
    if(ev.kind==="keeper") return nameOf(d["in"])+" into goal";
    if(ev.kind==="clock_set") return "Clock set to "+mmssTxt(d.to||0);
    if(ev.kind==="format") return "Format — no keeper";
    return ev.kind;
  }
  function fixConseq(ev){
    var g=state.game, d=ev.detail||{};
    if(ev.kind==="goal"){
      var us=g.us-(d.side==="us"?1:0), them=g.them-(d.side==="them"?1:0);
      return "Score goes back to "+Math.max(0,us)+"–"+Math.max(0,them)+".";
    }
    if(ev.kind==="sog"){
      var sc=((g.playerStats||{})[d.playerId]||{}).sog||0;
      return nameOf(d.playerId)+"'s shot count goes back to "+Math.max(0,sc-1)+". The score is not affected.";
    }
    if(ev.kind==="sub") return nameOf(d.out)+" goes back on. "+nameOf(d["in"])+"'s "+r1(d.frac||0)+" of a period returns to "+nameOf(d.out)+".";
    if(ev.kind==="keeper") return nameOf(d.out)+" goes back in goal; the goal time returns with them.";
    if(ev.kind==="clock_set") return "Clock goes back to "+mmssTxt(d.from||0)+", paused.";
    if(ev.kind==="format") return nameOf(d.off)+" comes back on"+(d.gk?" and "+nameOf(d.gk)+" goes back in goal":"")+".";
    return "";
  }
  function renderFixCard(){
    var card=$("#fixCard"); if(!card) return;
    var g=state.game, lu=state.lineup, rec=g.recent||[];
    var show=!!lu&&(g.started||rec.length>0);
    card.hidden=!show; if(!show) return;
    var qf=[];
    if(g.started&&!g.running&&g.stoppedAt&&g.secs>0){
      var since=Math.min(Math.round((nowMs()-g.stoppedAt)/1000),Math.max(0,g.secs));
      if(since>=30) qf.push('<button data-act="fix-addback"><span>Clock was stopped during play</span><span class="do">count '+mmssTxt(since)+' as played</span></button>');
    }
    qf.push('<button data-act="clock-edit"><span>Clock is wrong — ran through a break, or off a bit</span><span class="do">set the clock</span></button>');
    if(g.started&&g.period>1) qf.push('<button data-act="fix-period"><span>Wrong period showing</span><span class="do">set to '+(g.period-1)+'</span></button>');
    // Deliberately last and plainly worded — a goal logged late (at the break,
    // or after full time) is the rare case, not a sideline action.
    if((g.goals||[]).length) qf.push('<button data-act="goal-fixtime"><span>A goal is logged at the wrong time</span><span class="do">pick the goal</span></button>');
    $("#quickFixes").innerHTML=qf.join("");
    $("#recentHead").hidden=!rec.length;
    $("#recentFixes").innerHTML=rec.map(function(ev,i){
      var open=fixOpen===i;
      return '<div class="logrow'+(open?" open":"")+'">'
        +'<button class="loghead" data-act="fix-open" data-i="'+i+'"><span><span class="tnum" style="color:var(--muted);margin-right:8px">P'+ev.period+' · '+mmssTxt(ev.secs)+'</span>'+esc(fixLabel(ev))+'</span><span class="undo">Undo</span></button>'
        +(open?'<div class="fixbody"><div class="conseq">'+esc(fixConseq(ev))+'</div><div class="btns">'
          +'<button class="btn cone" data-act="fix-undo" data-i="'+i+'">Undo this</button>'
          +'<button class="btn ghost" style="flex:0 0 auto" data-act="fix-open" data-i="'+i+'">Keep it</button>'
          +'</div></div>':'')
        +'</div>';
    }).join("");
  }
  function undoFix(i){
    var g=state.game, lu=state.lineup, rec=g.recent||[], ev=rec[i];
    if(!ev||!lu) return;
    var d=ev.detail||{}, ok=false, msg="";
    if(ev.kind==="goal"){
      if(g[d.side]>0){
        // playerId rides along so the correcting row names the scorer — the
        // season rollup nets goals by SUM(detail.d) and can't match a NULL.
        // scoreChange only credits playerStats when d>0, so this can't double-count.
        scoreChange(d.side,-1,d.playerId,d.assistId);
        if(d.playerId){ var ps=(g.playerStats||{})[d.playerId]; if(ps&&ps.goals>0) ps.goals--; }
        if(d.assistId){ var as=(g.playerStats||{})[d.assistId]; if(as&&as.assists>0) as.assists--; }
        // keep the goal list in step — it is what the +/− modals read from
        if(ev.id) g.goals=(g.goals||[]).filter(function(x){ return x.evId!==ev.id; });
        ok=true; msg="Goal removed — "+g.us+"–"+g.them;
      }
      else msg="That side is already at 0.";
    } else if(ev.kind==="sog"){
      var ss=(g.playerStats||{})[d.playerId];
      if(ss&&ss.sog>0){
        ss.sog--;
        logEvent("sog",{playerId:d.playerId,correction:true},d.playerId);
        ok=true; msg="Shot removed — "+nameOf(d.playerId)+" on "+ss.sog;
      } else msg="No shots left to remove for "+nameOf(d.playerId)+".";
    } else if(ev.kind==="sub"){
      if(LineupCore.applySub(lu,ev.period-1,d["in"],d.out,d.frac||0)){
        logEvent("sub",{out:d["in"],"in":d.out,frac:d.frac,correction:true},d.out);
        queueAppearances(ev.period); ok=true; msg="Sub undone — "+nameOf(d.out)+" back on";
      } else msg="Can't undo that sub — the field has changed since.";
    } else if(ev.kind==="keeper"){
      if(lu.gk[ev.period-1]===d["in"]&&d.frac!=null&&LineupCore.applyKeeperSwap(lu,ev.period-1,d.out,d.frac)){
        logEvent("keeper",{out:d["in"],"in":d.out,frac:d.frac,correction:true},d.out);
        queueAppearances(ev.period); ok=true; msg=nameOf(d.out)+" back in goal";
      } else msg="Can't undo that keeper change — goal has changed since.";
    } else if(ev.kind==="clock_set"){
      g.secs=d.from||0; g.running=false; stopTicker(); if(g.started) g.stoppedAt=nowMs();
      logEvent("clock_set",{from:d.to,to:g.secs,correction:true});
      ok=true; msg="Clock back to "+mmssTxt(g.secs);
    } else if(ev.kind==="format"){
      ok=undoFormatSwitch(ev);
      msg=ok?"Keeper format restored":"A format change can only be undone in the same period.";
    }
    if(ok){ rec.splice(i,1); fixOpen=null; save(); renderRoster(); renderLineup(); renderGame(); }
    toast(msg,ok);
  }
  function fixAddBack(){
    var g=state.game; if(!g.stoppedAt||g.running) return;
    var since=Math.min(Math.round((nowMs()-g.stoppedAt)/1000),Math.max(0,g.secs));
    if(since<1) return;
    ask({title:"Count "+mmssTxt(since)+" as played?",
      body:"That time comes off period "+g.period+" and is credited to whoever is on the field. The clock restarts.",
      ok:"Count it as played", danger:true}).then(function(ok){
      if(!ok) return;
      var from=Math.max(0,g.secs);
      g.secs=Math.max(0,g.secs-since);   // that time was played, so it comes off the period
      logEvent("clock_set",{from:from,to:g.secs,played:since});
      if(g.secs>0){ toggleTimer(); } else { g.stoppedAt=nowMs(); save(); renderGame(); }
      toast("Counted "+mmssTxt(since)+" as played");
    });
  }
  function fixPeriodBack(){
    var g=state.game; if(g.period<=1) return;
    ask({title:"Go back to period "+(g.period-1)+"?",
      body:"The clock resets to "+mmssTxt(state.minsper*60)+" and stops. Playing time already credited is not changed.",
      ok:"Go back a period", danger:true}).then(function(ok){
      if(!ok) return;
      g.period--; g.running=false; stopTicker(); g.secs=state.minsper*60; g.stoppedAt=0;
      logEvent("period",{fixedTo:g.period,correction:true});
      save(); renderGame();
      toast("Back to period "+g.period);
    });
  }

  /* ---------- game format — t5: keeper or no keeper, mid-game ---------- */
  var fmtOpen=false, fmtMode=null, fmtOffId=null;
  function renderFmtCard(){
    var card=$("#fmtCard"); if(!card) return;
    var lu=state.lineup, g=state.game;
    var show=fmtOpen&&!!lu;
    card.hidden=!show; if(!show) return;
    var pi=curPi(), gkNow=(lu.gk||[])[pi];
    $("#fmtWhen").textContent="Period "+g.period+" · "+mmssTxt(g.secs);
    var current=lu.keeper?"keeper":"none", mode=fmtMode||current;
    $("#fmtBtnKeeper").setAttribute("aria-pressed",String(mode==="keeper"));
    $("#fmtBtnNone").setAttribute("aria-pressed",String(mode==="none"));
    var html="";
    if(mode===current){
      html='<p class="lead" style="margin:0">'+(lu.keeper
        ? esc(nameOf(gkNow))+" is in goal this period."+((lu.gk||[])[pi+1]?" "+esc(nameOf(lu.gk[pi+1]))+" is set for the next one.":"")
        : "Everyone plays out — time balances across D and F only.")+'</p>';
    } else if(mode==="none"){
      // Switching off the keeper takes a player off the field, so the sheet
      // names the consequences and makes you pick who sits before it commits.
      var newN=lu.N-1, nD=LineupCore.posSplit(newN,false), nF=newN-nD;
      var chips=(lu.periods[pi]||[]).map(function(id){ return {id:id, v:playedSoFar(lu,pi,id)}; })
        .sort(function(a,b){ return b.v-a.v || nameOf(a.id).localeCompare(nameOf(b.id)); });
      html='<div class="fmt-consec"><div class="hd">Switching now, at '+mmssTxt(g.secs)+' of period '+g.period+'</div>'
        +(gkNow?'<div>'+esc(nameOf(gkNow))+' comes out of goal and keeps the time already credited there.</div>':'')
        +'<div>The field becomes '+newN+' out — '+nD+' D · '+nF+' F — so one player goes to the bench and starts earning bench time.</div>'
        +'<div>Recorded as “Format — no keeper” and undoable from Fix a mistake.</div></div>'
        +'<div class="fmt-who">Who goes to the bench — most played first</div>'
        +'<div class="fmt-off">'+chips.map(function(c){
          return '<button class="'+(fmtOffId===c.id?"sel":"")+'" data-act="fmt-off" data-id="'+c.id+'">'
            +(c.id===gkNow?'<span class="gkb">GK</span>':'')
            +esc(nameOf(c.id))+'<span class="lb">'+r1(c.v)+'p</span></button>';
        }).join("")+'</div>'
        +'<div class="fmt-apply"><button class="btn ghost" style="flex:0 0 auto" data-act="fmt-cancel">Cancel</button>'
        +(fmtOffId
          ?'<button class="btn cone" style="flex:1" data-act="fmt-apply">Switch now — '+esc(nameOf(fmtOffId))+' to the bench</button>'
          :'<span class="wait">Pick who goes to the bench</span>')
        +'</div>';
    } else {
      html='<p class="lead" style="margin:0 0 12px">Switching back to a keeper mid-game isn\'t built yet — if the referee turns up, rebuild the lineup on the Roster tab.</p>'
        +'<div class="fmt-apply"><button class="btn ghost" style="flex:0 0 auto" data-act="fmt-cancel">Close</button></div>';
    }
    $("#fmtBody").innerHTML=html;
  }
  function applyNoKeeper(){
    var lu=state.lineup, g=state.game; if(!lu||!lu.keeper||!fmtOffId) return;
    var pi=curPi(), frac=Math.min(1,Math.max(0,g.secs/Math.max(1,state.minsper*60)));
    var res=LineupCore.applyFormatOff(lu,pi,fmtOffId,frac);
    if(!res){ toast("Couldn't switch — try again"); return; }
    redrawFuture(lu,pi,lu.N-1,false);
    logEvent("format",{keeper:false,off:fmtOffId,offPos:res.offPos,gk:res.gk,frac:Math.round(frac*1000)/1000},fmtOffId);
    var offName=nameOf(fmtOffId);
    fmtOpen=false; fmtMode=null; fmtOffId=null;
    save(); renderRoster(); renderLineup(); renderGame();
    buzz(40);
    toast("No keeper — "+offName+" to the bench, "+lu.N+" on the field",true);
  }
  function undoFormatSwitch(ev){
    var lu=state.lineup, g=state.game, d=ev.detail||{};
    if(!lu||lu.keeper||ev.period!==g.period) return false;
    var pi=curPi();
    if(!LineupCore.applyFormatOn(lu,pi,d.off,d.offPos||"D",d.gk||null,d.frac||0)) return false;
    redrawFuture(lu,pi,lu.N+1,!!d.gk);
    logEvent("format",{keeper:true,correction:true});
    return true;
  }
  function presentIdsByOwed(lu){
    return state.roster.filter(function(p){ return p.present; }).map(function(p){ return p.id; })
      .sort(function(a,b){ return totPlayed(lu,a)-totPlayed(lu,b); });
  }
  // The redraw itself is LineupCore.redrawFrom; what stays here is the settings
  // side of it — the field size is a team setting the coach can see and edit.
  function redrawFuture(lu,pi,N,keeper){
    LineupCore.redrawFrom(lu,pi,presentIdsByOwed(lu),
      {N:N, keeper:keeper, kept:state.kept, posTotals:state.posTotals});
    state.onfield=N;
    var of=$("#onfield"); if(of) of.value=N;
  }

  /* ---------- events ---------- */
  document.addEventListener("click",function(e){
    var t=e.target.closest("[data-act]"); if(!t) return;
    var act=t.dataset.act;
    if(act==="add-player"){ addPlayer(); }
    else if(act==="del-player"){
      var dp=byId(t.dataset.id), dpid=t.dataset.id;
      if(dp) ask({title:"Remove "+dp.name+"?", body:"They come off the roster for good. This can't be undone.",
        ok:"Remove "+dp.name, danger:true}).then(function(ok){
        if(!ok) return;
        state.roster=state.roster.filter(function(p){ return p.id!==dpid; });
        save(); renderRoster(); refreshLineup();
      });
    }
    else if(act==="toggle-present"){
      var p=byId(t.dataset.id);
      if(p){
        if(p.present){ p.present=false; p.late=true; }
        else if(p.late){ p.late=false; }
        else { p.present=true; p.late=false; }
        save(); renderRoster(); refreshLineup();
        if(card) drawCard();   // the card owns this toggle too when it has no sub to offer
      }
    }
    else if(act==="build-lineup"){
      syncSettings(true);
      var bg=state.game, run=function(){ if(buildLineup(false,false)) toast("Lineup ready — check Game Day"); };
      if(state.lineup && (bg.period>1||bg.us||bg.them)){
        ask({title:"Start a new game?", body:"The score and period reset.\n\nTo redraw this game's sheet instead, cancel and use ↻ Reshuffle.",
          ok:"Start new game", danger:true}).then(function(ok){ if(ok) run(); });
      } else run();
    }
    else if(act==="reshuffle"){ syncSettings(true); buildLineup(true,true); }
    else if(act==="print-lineup"){ printPanel("p-lineup"); }
    else if(act==="add-drill"){ state.practice.push({id:t.dataset.id, mins:drill(t.dataset.id).mins}); save(); renderPractice(); toast("Added to practice plan"); }
    else if(act==="rm-drill"){ state.practice.splice(+t.dataset.i,1); save(); renderPractice(); }
    else if(act==="mv"){ moveDrill(+t.dataset.i,+t.dataset.d); }
    else if(act==="practice-start"){ practiceStart(); }
    else if(act==="practice-next"){ practiceNext(); }
    else if(act==="practice-reset"){ practiceReset(); }
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
    else if(act==="passphrase"){ passphraseFlow(); }
    else if(act==="ask-yes"){ askYes(); }
    else if(act==="ask-no"){ askClose(askIsText?null:false); }
    else if(act==="toast-clear"){ clearToasts(); }
    else if(act==="go-live"){ $('.tab[data-tab="game"]').click(); }
    else if(act==="score"){ scoreTap(t.dataset.side,+t.dataset.d); }
    else if(act==="goal"){ openGoalDialog("assist",{side:"us",scorerId:t.dataset.id}); }
    else if(act==="goal-pick"){
      if(gd.step==="scorer"){ gd.scorerId=t.dataset.id; gd.step="assist"; drawGoalDialog(); }
      else { gd.assistId=t.dataset.id; commitGoal(); }
    }
    else if(act==="goal-skip"){
      if(gd.step==="scorer"){ gd.scorerId=null; gd.step="assist"; drawGoalDialog(); }
      else { gd.assistId=null; commitGoal(); }
    }
    else if(act==="goal-del"){ removeGoal(+t.dataset.i); }
    else if(act==="goal-dec"){
      var sd=gd.side;
      ask({title:"Take one goal off the "+(sd==="us"?(state.team||"our"):"visitors'")+" score?",
        body:"No player record changes — use this only for a goal that was never attributed.",
        ok:"Take one off", danger:true}).then(function(ok){
        if(!ok) return;
        closeGoal(); scoreChange(sd,-1); renderGame();
      });
    }
    else if(act==="goal-time"){
      var go=(state.game.goals||[])[+t.dataset.i]||{};
      gd.step="time"; gd.idx=+t.dataset.i; gd.period=go.period||1; gd.secs=go.secs||0;
      drawGoalDialog();
    }
    else if(act==="gt-p"){ gd.period=Math.max(1,Math.min(maxPeriods(),gd.period+(+t.dataset.d))); drawGoalDialog(); }
    else if(act==="gt-s"){ gd.secs=Math.max(0,Math.min(3599,gd.secs+(+t.dataset.d))); drawGoalDialog(); }
    else if(act==="gt-save"){ saveGoalTime(); }
    else if(act==="goal-cancel"){ closeGoal(); }
    else if(act==="goal-fixtime"){ openGoalDialog("remove",{side:"us"}); }
    else if(act==="sog"){ sogTap(t.dataset.id); }
    else if(act==="timer-toggle"){ toggleTimer(); }
    else if(act==="lock-on"){ setLock(true); }
    else if(act==="alerts"){ toggleAlerts(); }
    else if(act==="timer-reset"){ resetTimer(); }
    else if(act==="period-next"){ nextPeriod(); }
    else if(act==="chip"){ tapChip(t.dataset.id,t.dataset.where); }
    else if(act==="clock-edit"){ openClockEdit(); }
    else if(act==="clk-cancel"){ closeClk(); }
    else if(act==="clk-yes"){ clkStep="edit"; clkDraft=Math.max(0,state.game.secs); drawClkDialog(); }
    else if(act==="clk-d"){ clkDraft=Math.max(0,Math.min(3599,clkDraft+(+t.dataset.d))); drawClkDialog(); }
    else if(act==="clk-save"){ saveClock(); }
    else if(act==="nk-toggle"){ nkOpen=!nkOpen; renderOnField(); }
    else if(act==="nk-pick"){ pickNextKeeper(t.dataset.id); }
    else if(act==="fmt-open"){ fmtOpen=!fmtOpen; fmtMode=null; fmtOffId=null; renderFmtCard(); if(fmtOpen){ var fc=$("#fmtCard"); if(fc&&fc.scrollIntoView) fc.scrollIntoView({block:"nearest"}); } }
    else if(act==="fmt-mode"){ fmtMode=t.dataset.mode; fmtOffId=null; renderFmtCard(); }
    else if(act==="fmt-off"){ fmtOffId=(fmtOffId===t.dataset.id)?null:t.dataset.id; renderFmtCard(); }
    else if(act==="fmt-cancel"){ fmtOpen=false; fmtMode=null; fmtOffId=null; renderFmtCard(); }
    else if(act==="fmt-apply"){ applyNoKeeper(); }
    else if(act==="fix-open"){ fixOpen=(fixOpen===+t.dataset.i)?null:+t.dataset.i; renderFixCard(); }
    else if(act==="fix-undo"){
      // every Fix-a-mistake action is confirmed, and the prompt states the
      // consequence — these all rewrite a ledger the season totals depend on
      var uev=(state.game.recent||[])[+t.dataset.i], ui=+t.dataset.i;
      if(uev) ask({title:"Undo: "+fixLabel(uev)+"?", body:fixConseq(uev), ok:"Undo it", danger:true})
        .then(function(ok){ if(ok) undoFix(ui); });
    }
    else if(act==="fix-addback"){ fixAddBack(); }
    else if(act==="fix-period"){ fixPeriodBack(); }
    else if(act==="new-season"){ startNewSeason(); }
    else if(act==="log-game"){ toggleLogGame(t.dataset.gid); }
    else if(act==="copy-link"){ copyTeamLink(); }
    else if(act==="link-device"){ copyDeviceLink(); }
    else if(act==="snack-link"){ copySnackLink(); }
    else if(act==="gc-link"){ connectSchedule(); }
    else if(act==="refresh-games"){ refreshGames(); }
    else if(act==="ref-toggle"){ toggleReferees(); }
    else if(act==="card"){ openCard(t.dataset.id); }
    else if(act==="card-close"){ closeCard(); }
    else if(act==="card-num"){ cardSetNum(); }
    else if(act==="card-note"){ cardAddNote(); }
    else if(act==="card-note-del"){
      var np=byId(card), ni=+t.dataset.i;
      if(np) ask({title:"Delete this note?", body:(np.notes[ni]||{}).text||"", ok:"Delete", danger:true}).then(function(ok){
        if(!ok) return;
        np.notes.splice(ni,1); save(); drawCard();
      });
    }
    else if(act==="card-sub"){ cardSub(); }
    else if(act==="card-gk"){ var cg=card; swapKeeper(cg); drawCard(); }
    else if(act==="card-copy"){
      var txt=cardSummary(card);
      if(navigator.clipboard&&navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(function(){ toast("Summary copied"); },function(){ toast("Copy failed"); });
      else toast("Clipboard not available on this browser");
    }
  });
  // The design opens the card by HOLDING a chip — the tap itself is already the
  // select-for-sub gesture and can't be taken. Same 500ms hold everywhere a
  // player's name appears, so there is one gesture to learn, not three.
  var holdTimer=null, holdFrom=null;
  function holdStart(e){
    var chip=e.target.closest(".jchip[data-id]"); if(!chip) return;
    holdFrom={x:e.clientX,y:e.clientY};
    holdTimer=setTimeout(function(){
      holdTimer=null; buzz(15); openCard(chip.dataset.id);
    },500);
  }
  function holdEnd(){ if(holdTimer){ clearTimeout(holdTimer); holdTimer=null; } holdFrom=null; }
  document.addEventListener("pointerdown",holdStart);
  document.addEventListener("pointerup",holdEnd);
  document.addEventListener("pointercancel",holdEnd);
  document.addEventListener("pointermove",function(e){
    if(holdTimer&&holdFrom&&(Math.abs(e.clientX-holdFrom.x)>8||Math.abs(e.clientY-holdFrom.y)>8)) holdEnd();
  });
  // A hold that opened the card must not also fire the chip's tap-to-select.
  document.addEventListener("click",function(e){
    if(card&&e.target.closest(".jchip[data-id]")){ e.stopPropagation(); e.preventDefault(); }
  },true);
  (function(){
    var d=$("#cardDialog");
    if(d){
      d.addEventListener("close",function(){ card=null; });
      // click on the backdrop = outside the sheet's own box
      d.addEventListener("click",function(e){ if(e.target===d) closeCard(); });
    }
  })();
  document.addEventListener("input",function(e){
    var t=e.target.closest("[data-act]"); if(!t) return;
    if(t.dataset.act==="set-mins"){ var i=+t.dataset.i; state.practice[i].mins=Math.max(1,+t.value||1); save(); renderPractice(); }
  });
  $("#newName").addEventListener("keydown",function(e){ if(e.key==="Enter") addPlayer(); });
  $("#teamName").addEventListener("input",function(e){
    state.team=e.target.value; save(); var u=$("#usName"); if(u) u.textContent=state.team||"Our team";
    var h=$("#hdrTitle"); if(h) h.textContent=state.team||"Coach's Sideline";
    if(TEAM){ var l=loadTeamList(); l.forEach(function(t){ if(t.tok===TEAM) t.name=state.team; }); saveTeamList(l); renderTeamSel(); scheduleCoachName(); }
  });
  $("#seasonName").addEventListener("input",function(e){ state.season=e.target.value; save(); });
  $("#venue").addEventListener("change",function(e){ state.venue=e.target.value; save(); renderGame(); });
  $("#gameSel").addEventListener("change",function(e){ pickGame(e.target.value); });
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
      ask({title:"Start a brand-new team?", body:"It gets its own link and its own roster. This team stays where it is.",
        ok:"Create the team"}).then(function(ok){
        if(!ok){ renderTeamSel(); return; }
        var tok=genToken(), l=loadTeamList();
        l.push({tok:tok,name:""}); saveTeamList(l);
        // A brand-new team starts empty — seed its key with a blank doc so boot()
        // loads that rather than falling back to defaults()' seed roster.
        var blank=SaveState.defaults(); blank.roster=[];
        try{ localStorage.setItem(BASE+":"+tok,JSON.stringify(blank)); }catch(err){}
        switchTeam(tok);
      });
      return;
    }
    if(v==="__del"){
      var cur=loadTeamList().filter(function(t){ return t.tok===TEAM; })[0];
      var nm=(cur&&cur.name)||"this team";
      ask({title:"Delete "+nm+"?", body:"Removes it from this device — its roster, season and games here are erased. The share link stops working once no one has it. This can't be undone.",
        ok:"Delete "+nm, danger:true}).then(function(ok){
        if(!ok){ renderTeamSel(); return; }
        deleteTeam(TEAM);
      });
      return;
    }
    if(v===TEAM) return;
    switchTeam(v);
  });

  // Erase a team's local footprint and switch to whatever remains. Purely local —
  // the backend copy (if any) is left alone; the link just goes unshared.
  async function deleteTeam(tok){
    var l=loadTeamList().filter(function(t){ return t.tok!==tok; });
    saveTeamList(l);
    var k=BASE+":"+tok;
    ["", ":meta", ":archive"].forEach(function(sfx){ try{ localStorage.removeItem(k+sfx); }catch(e){} });
    var next=l[0]?l[0].tok:null;
    try{ if(next) localStorage.setItem(BASE+":lastTeam",next); else localStorage.removeItem(BASE+":lastTeam"); }catch(e){}
    // Drop it from the synced list too, or coachSyncPull re-adds it on reload.
    // Best-effort: offline, the delete stays local and the team reappears next
    // time this device syncs — acceptable, and the coach can delete again.
    try{ await coachRemoveTeam(tok); }catch(e){}
    setHashToken(next||"");
    location.reload();
  }

  function switchTeam(tok){
    try{ localStorage.setItem(BASE+":lastTeam",tok); }catch(err){}
    setHashToken(tok);
    // ponytail: re-entering boot()/initSync() in place is where the bugs would live; a reload is free here.
    location.reload();
  }
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
  function pstat(id){
    var g=state.game; g.playerStats=g.playerStats||{};
    var ps=g.playerStats[id]=g.playerStats[id]||{goals:0,sog:0,assists:0};
    if(ps.assists==null) ps.assists=0;   // docs written before assists existed
    return ps;
  }
  function scoreChange(side,d,playerId,assistId){
    var g=state.game; g[side]=Math.max(0,g[side]+d);
    $("#"+(side==="us"?"usScore":"themScore")).textContent=g[side];
    if(side==="us" && d>0){
      if(playerId) pstat(playerId).goals+=d;
      if(assistId) pstat(assistId).assists+=d;
    }
    var evId=logEvent("goal",{side:side,d:d,playerId:playerId||null,assistId:assistId||null},playerId||null);
    queueGameRow();   // the archive row carries the score
    // logEvent just changed g.recent — redraw it. renderGoLive too: the first
    // goal can be what makes gameUnderway() true, and that drives the FAB tab.
    save(); renderNudge(); renderFixCard(); renderGoLive();
    if(playerId||assistId) renderOnField();   // refresh the scorer's goal/SOG badge
    return evId;
  }

  /* ---------- goals: who scored, who assisted, and fixing both after ----------
     state.game.goals is the one list the + modal, the − modal and the
     timestamp editor all read. Every entry keeps the archive event id it
     wrote, so a correction can name the row it corrects. */
  var gd=null;   // {step, side, scorerId, assistId, idx, period, secs}
  function onFieldIds(){
    var lu=state.lineup;
    if(lu && lu.periods && lu.periods.length) return (lu.periods[curPi()]||[]).slice();
    return state.roster.filter(function(p){ return p.present; }).map(function(p){ return p.id; });
  }
  function goalsFor(side){
    return (state.game.goals||[]).map(function(go,i){ return {go:go,i:i}; })
      .filter(function(x){ return x.go.side===side; });
  }
  function openGoalDialog(step,seed){
    var dlg=$("#goalDialog"); if(!dlg||!dlg.showModal) return false;
    gd=Object.assign({step:step,side:"us",scorerId:null,assistId:null,idx:-1},seed||{});
    drawGoalDialog();
    if(!dlg.open) dlg.showModal();
    return true;
  }
  function closeGoal(){ var dlg=$("#goalDialog"); gd=null; if(dlg&&dlg.open) dlg.close(); }
  function goalWhen(go){ return "P"+go.period+" · "+mmssTxt(go.secs||0); }
  function goalWho(go){
    if(go.side!=="us") return "Visitors";
    if(!go.playerId) return "Unattributed goal";
    return nameOf(go.playerId)+(go.assistId?" (assist "+nameOf(go.assistId)+")":"");
  }
  function drawGoalDialog(){
    var dlg=$("#goalDialog"); if(!dlg||!gd) return;
    var g=state.game, html="";
    if(gd.step==="scorer"||gd.step==="assist"){
      var pick=gd.step==="scorer";
      var ids=onFieldIds().filter(function(id){ return pick||id!==gd.scorerId; });
      html='<div class="hd"><h4>'+(pick?"Who scored?":"Assisted by?")+'</h4><span class="was tnum">'+"P"+g.period+" · "+mmssTxt(g.secs)+'</span></div>'
        +(pick?'':'<p style="margin:8px 0 0">'+esc(nameOf(gd.scorerId))+' scored. Tap whoever set it up, or skip.</p>')
        +'<div class="gpick">'+ids.map(function(id){
          var sel=pick?(gd.scorerId===id):(gd.assistId===id);
          return '<button class="gp'+(sel?" sel":"")+'" data-act="goal-pick" data-id="'+id+'">'+esc(nameOf(id))+'</button>';
        }).join("")+'</div>'
        +'<div class="btns"><button class="btn ghost" data-act="goal-cancel">Cancel</button>'
        +'<button class="btn" style="flex:2" data-act="goal-skip">'+(pick?"No scorer — just the goal":"No assist — save goal")+'</button></div>';
    } else if(gd.step==="remove"){
      var list=goalsFor(gd.side);
      html='<div class="hd"><h4>Remove which goal?</h4><span class="was tnum">'+g.us+'–'+g.them+'</span></div>'
        +'<p>The goal comes off the score and off that player\'s record. It is logged as a correction, never deleted.</p>'
        +(list.length
          ? '<div class="glist">'+list.map(function(x){
              return '<div class="grow"><button class="gmain" data-act="goal-del" data-i="'+x.i+'">'
                +'<span class="gw">'+esc(goalWho(x.go))+'</span><span class="gt tnum">'+goalWhen(x.go)+'</span>'
                +'<span class="gx">Remove</span></button>'
                +'<button class="gtime" data-act="goal-time" data-i="'+x.i+'" title="Correct the time of this goal">🕑</button></div>';
            }).join("")+'</div>'
          : '<div class="empty">No goals recorded for this side. Use the score buttons to correct the number directly.</div>')
        +'<div class="btns"><button class="btn ghost" style="flex:1" data-act="goal-cancel">Close</button>'
        +(g[gd.side]>0?'<button class="btn cone" style="flex:1" data-act="goal-dec">Just take one off the score</button>':'')+'</div>';
    } else if(gd.step==="time"){
      var go=(g.goals||[])[gd.idx]||{};
      html='<div class="hd"><h4>When was it scored?</h4><span class="was tnum">was '+goalWhen(go)+'</span></div>'
        +'<p>'+esc(goalWho(go))+'. Only the game-log time changes — the score and the player\'s record stay as they are.</p>'
        +'<div class="clock-big tnum draft">P'+gd.period+' · '+mmssTxt(gd.secs)+'</div>'
        +'<div class="steps">'
        +'<div><span class="lab">Period</span><div class="pair"><button data-act="gt-p" data-d="-1">−</button><button data-act="gt-p" data-d="1">+</button></div></div>'
        +'<div><span class="lab">Minutes</span><div class="pair"><button data-act="gt-s" data-d="-60">−</button><button data-act="gt-s" data-d="60">+</button></div></div>'
        +'</div>'
        +'<div class="steps" style="margin-top:8px"><div style="grid-column:1/-1"><span class="lab">Seconds</span>'
        +'<div class="pair"><button data-act="gt-s" data-d="-10">−</button><button data-act="gt-s" data-d="10">+</button></div></div></div>'
        +'<div class="btns"><button class="btn ghost" data-act="goal-cancel">Cancel</button>'
        +'<button class="btn" style="flex:2" data-act="gt-save">Save the time</button></div>';
    }
    dlg.innerHTML=html;
  }
  function commitGoal(){
    var g=state.game, side=gd.side, scorer=gd.scorerId, assist=gd.assistId;
    var evId=scoreChange(side,1,scorer,assist);
    (g.goals=g.goals||[]).unshift({evId:evId,side:side,playerId:scorer||null,assistId:assist||null,
      period:g.period, secs:Math.max(0,g.secs), at:nowMs()});
    closeGoal(); save(); renderGame();
    buzz(40);
    toast(scorer
      ? nameOf(scorer)+" scores"+(assist?" — assist "+nameOf(assist):"")+". "+g.us+"–"+g.them
      : "Goal — "+(state.team||"us")+". "+g.us+"–"+g.them, true);
  }
  // Removing is a correction, exactly like Fix a mistake: the score, the
  // scorer's goal and the assister's assist all come back off together.
  function removeGoal(i){
    var g=state.game, go=(g.goals||[])[i]; if(!go) return;
    if(g[go.side]<=0){ toast("That side is already at 0."); return; }
    ask({title:"Remove this goal?",
      body:goalWho(go)+" — "+goalWhen(go)+"\n\nThe score goes to "
        +(go.side==="us"?(g.us-1)+"–"+g.them:g.us+"–"+(g.them-1))
        +(go.playerId?", and it comes off "+nameOf(go.playerId)+"'s record":"")
        +(go.assistId?" and "+nameOf(go.assistId)+"'s assists":"")+".",
      ok:"Remove the goal", danger:true}).then(function(ok){ if(ok) doRemoveGoal(i); });
  }
  function doRemoveGoal(i){
    var g=state.game, go=(g.goals||[])[i]; if(!go) return;
    g[go.side]=Math.max(0,g[go.side]-1);
    if(go.playerId){ var ps=(g.playerStats||{})[go.playerId]; if(ps&&ps.goals>0) ps.goals--; }
    if(go.assistId){ var as=(g.playerStats||{})[go.assistId]; if(as&&as.assists>0) as.assists--; }
    logEvent("goal",{side:go.side,d:-1,playerId:go.playerId||null,assistId:go.assistId||null,
      correction:true,ofEvent:go.evId||null},go.playerId||null);
    g.goals.splice(i,1);
    // the same goal sitting in the undo list would decrement it a second time
    if(go.evId) g.recent=(g.recent||[]).filter(function(r){ return !(r.kind==="goal"&&r.id===go.evId); });
    queueGameRow(); closeGoal(); save(); renderGame(); renderLineup();
    toast(goalWho(go)+" — goal removed. "+g.us+"–"+g.them, true);
  }
  function saveGoalTime(){
    var g=state.game, go=(g.goals||[])[gd.idx]; if(!go){ closeGoal(); return; }
    var was=goalWhen(go);
    if(was==="P"+gd.period+" · "+mmssTxt(gd.secs)){ closeGoal(); return; }   // nothing to change
    var to={period:gd.period,secs:gd.secs};
    ask({title:"Move this goal to P"+to.period+" · "+mmssTxt(to.secs)+"?",
      body:goalWho(go)+" — currently logged at "+was+". Only the game-log time changes.",
      ok:"Move it"}).then(function(ok){ if(ok) doSaveGoalTime(go,to,was); });
  }
  function doSaveGoalTime(go,to,was){
    var g=state.game;
    go.period=to.period; go.secs=to.secs;
    // append-only: the original row stays, this names it and carries the fix
    logEvent("goal_time",{ofEvent:go.evId||null,period:go.period,secs:go.secs},go.playerId||null);
    var r=(g.recent||[]).filter(function(x){ return x.id===go.evId; })[0];
    if(r){ r.period=go.period; r.secs=go.secs; }
    closeGoal(); save(); renderGame();
    toast(goalWho(go)+" — goal moved from "+was+" to "+goalWhen(go),true);
  }
  // Our goals go through the who-scored sheet; the visitors have no players to
  // credit, so their + stays a single tap. Either side's − opens the goal list
  // when there is something recorded to pick from.
  function scoreTap(side,d){
    if(d>0){
      if(side==="us" && openGoalDialog("scorer",{side:side})) return;
      scoreChange(side,d); renderGame(); return;
    }
    if(goalsFor(side).length && openGoalDialog("remove",{side:side})) return;
    scoreChange(side,d); renderGame();
  }
  // Shots on goal don't touch the team score, but they are undoable like
  // anything else that lands in the ledger — a mis-tap has to be fixable.
  function sogTap(id){
    var g=state.game;
    g.playerStats=g.playerStats||{};
    var ps=g.playerStats[id]=g.playerStats[id]||{goals:0,sog:0};
    ps.sog+=1;
    logEvent("sog",{playerId:id},id);
    save(); renderOnField(); renderFixCard();
  }
  function toggleTimer(){
    var g=state.game;
    if(gameOver()){ toast("That game is finished — build a lineup to start the next one."); return; }
    if(atFullTime()){ nextPeriod(); return; }   // Start is now Finish the game
    if(g.secs<=0){ g.secs=state.minsper*60; }
    g.running=!g.running; g.started=true;   // from here on, rebuilds must not rewrite this period
    if(g.running&&state.lineup&&!g.onBreak) LineupCore.ivOpen(state.lineup,curPi());   // kickoff of a period opens its interval runs
    g.stoppedAt=g.running?0:nowMs();        // lets Fix a mistake offer "count that stop as played"
    if(g.running&&!g.startedAt){
      g.startedAt=nowMs();                  // kickoff: the game gets its archive row
      if(!g.gid) g.gid=genToken();          // games built before this version have no id yet
      queueGameRow();
    }
    logEvent("clock",{running:g.running});
    if(g.running) startTicker(); else stopTicker();
    save(); renderGame();
  }
  // Reset is a false-start tool — the ref wasn't ready and some clock bled off
  // before kickoff. Once the period's clock has been used as a credit boundary
  // (any sub, keeper swap or format switch splits an app entry at g.secs),
  // resetting it inflates the frac of every later split in that period. From
  // there the right tool is Set the clock, which is logged and undoable.
  // Read the split off lu.app, not g.recent — that list is capped at 8 and is
  // spliced on undo, so an early sub would fall off it and re-enable Reset.
  function canReset(){
    var g=state.game, lu=state.lineup;
    if(g.onBreak||gameOver()) return false;
    if(g.secs>=state.minsper*60) return false;          // nothing to reset
    var es=(lu&&lu.app&&lu.app[curPi()])||[];
    return !es.some(function(e){ return e.frac<1-1e-9; });
  }
  // Reset and Period + both throw away clock the coach can't get back, so both
  // are gated — and each sits on the thing it changes (the clock, the period badge).
  function resetTimer(){
    var g=state.game;
    if(!canReset()) return;
    ask({title:"Reset the clock to "+mmssTxt(state.minsper*60)+"?",
      body:"The period, the score and playing time already credited stay as they are.",
      ok:"Reset the clock", danger:true}).then(function(ok){
      if(!ok||!canReset()) return;                      // the clock runs on while the sheet is open
      var from=Math.max(0,g.secs);
      g.running=false; stopTicker(); g.secs=state.minsper*60; g.stoppedAt=0;
      logEvent("clock_set",{from:from,to:g.secs});      // undoable like every other clock change
      save(); renderGame();
    });
  }
  // Manual override, rarely needed now that periods advance on their own:
  // skip straight to wherever auto-advance would land — end the period now,
  // skip the rest of a break, or (on the last period) close out full time.
  function nextPeriod(){
    var g=state.game, last=g.period>=maxPeriods();
    if(gameOver()){ toast("That game is finished — build a lineup to start the next one."); return; }
    var q = last
      ? {title:"End the game now?", body:"Final score "+g.us+"–"+g.them+". The game is stamped full time and goes to the archive.", ok:"End the game"}
      : (g.onBreak
        ? {title:"Start period "+(g.period+1)+" now?", body:"The rest of the break is skipped.", ok:"Start the period"}
        : {title:"End period "+g.period+" now?", body:mmssTxt(g.secs)+" is still on the clock.", ok:"End the period"});
    q.danger=true;
    ask(q).then(function(ok){
      if(!ok||gameOver()) return;             // a second tap while the sheet was open
      if(last){
        g.running=false; g.onBreak=false; stopTicker();
        closeGameRow();                       // full time: stamp the archive row, flush the last period
        save(); renderGame(); renderLog();
        toast("Game over — final "+g.us+"–"+g.them+". Build a lineup to start the next one.",true);
        return;
      }
      if(g.onBreak) advancePeriod(); else periodExpired();
    });
  }
  // A game leaves the live doc through here exactly once: full time, a new
  // game replacing it, or a season rollover.
  function closeGameRow(){
    var g=state.game, lu=state.lineup;
    if(!g||!g.gid||!g.startedAt||g.endedAt||!lu) return;
    g.endedAt=nowMs();
    LineupCore.ivClose(lu,curPi());   // a manual full-time end skips periodExpired
    // Clip the ledgers to elapsed clock time BEFORE anything is banked: a game
    // that ends early must not archive, or commit to careers, periods that were
    // never played. No-op at a period boundary / full time (rem 0). (§1.1)
    LineupCore.finalizeAtElapsed(lu,curPi(),remFrac());
    logEvent("period",{final:true,us:g.us,them:g.them});
    queueGameRow();
    queueAppearances(Math.min(g.period,lu.Q));
  }
  // Seasons are a reset boundary for the career ledgers, nothing more.
  function startNewSeason(){
    ask({title:"Start a new season?", body:"The fairness ledgers reset; this season's games stay in the archive. Name it:",
      input:state.season||"", placeholder:"e.g. Spring 2027", ok:"Start the season", danger:true})
      .then(function(nm){ if(nm) doNewSeason(nm); });
  }
  function doNewSeason(nm){
    closeGameRow();
    commitGame(state.lineup);               // bank the outgoing game through the path that already exists
    state.lineup=null; state.played={}; state.kept={}; state.posTotals={};
    state.season=nm.trim();
    state.game={us:0,them:0,period:1,secs:state.minsper*60,running:false,onBreak:false,playerStats:{}};
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
  function hashCid(){ var m=(location.hash||"").match(/[#&]c=([A-Za-z0-9_-]{8,64})/); return m?m[1]:null; }
  // replaceState, and it must not drop the tab the coach is already on
  function setHashToken(tok){
    var h=hashFor(activeTab(),tok);
    try{ history.replaceState(null,"",h); }catch(e){ location.hash=h.slice(1); }
  }

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

  /* ---------- team passphrase (optional login) ----------
     Opt-in per team: a team with no passphrase behaves exactly as it always
     did, so no existing link stops working. LOCKED means the server refused us
     and the coach hasn't (or can't) unlock — the app then runs entirely local,
     which is what local-first is for. It is never a reason to stop working. */
  var AUTH={exists:false,locked:false,authed:true}, LOCKED=false;

  function authUrl(){ return "/api/team/"+encodeURIComponent(TEAM)+"/auth"; }

  async function loadAuth(){
    try{
      var r=await fetch(authUrl(),{headers:{accept:"application/json"}});
      if(!r.ok) return false;
      AUTH=await r.json(); return true;
    }catch(e){ return false; }
  }

  async function postAuth(body){
    try{
      var r=await fetch(authUrl(),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      return {ok:r.ok,status:r.status};
    }catch(e){ return {ok:false,status:0}; }
  }

  // True once the API is usable — the team is open, or this device now holds a
  // session. Three tries, then the app just runs local-only.
  async function unlock(why){
    for(var i=0;i<3;i++){
      var p=await ask({
        title:"🔒 Team passphrase",
        body:why||"This team is passphrase-protected. Enter it to sync with the other coaches' devices.",
        input:"", pass:true, placeholder:"Passphrase", ok:"Unlock", cancel:"Not now"});
      if(!p) return false;
      var res=await postAuth({pass:p});
      if(res.ok){ AUTH={exists:true,locked:true,authed:true}; LOCKED=false; renderAuthBtn(); return true; }
      why = res.status===429 ? "Too many tries. Wait a minute, then try again."
          : res.status===0   ? "No signal — the app keeps working offline. Try again later."
          : "That didn't match. Try again.";
      if(res.status===0) return false;
    }
    return false;
  }

  function goLocalOnly(){ LOCKED=true; setPill("off","Locked — not syncing"); renderAuthBtn(); }

  async function ensureAuth(){
    if(!BACKEND||!TEAM) return true;
    if(!(await loadAuth())) return true;              // no answer: let the sync path report offline
    if(!AUTH.locked||AUTH.authed){ LOCKED=false; return true; }
    if(await unlock()) return true;
    goLocalOnly(); return false;
  }

  // Every doc sync goes through this. A 30-day session can expire mid-season,
  // and the right answer to a 401 is one prompt, not a silent stall.
  async function authFetch(url,opts){
    var r=await fetch(url,opts);
    if(r.status!==401||LOCKED) return r;
    if(!(await unlock("Your session expired. Enter the team passphrase to keep syncing."))){ goLocalOnly(); return r; }
    return fetch(url,opts);
  }

  function renderAuthBtn(){
    var b=$("#lockBtn"); if(!b) return;
    b.hidden=!(BACKEND&&TEAM);
    b.textContent = LOCKED ? "🔒 Locked — unlock"
      : AUTH.locked ? "🔒 Passphrase on"
      : "🔓 Add a passphrase";
  }

  // Locking or unlocking flips the answer for requests that were already in
  // flight — the season fetches are fire-and-forget, so one of them can come
  // back 401 and leave the Season tab a refresh behind. Re-read once, after.
  function afterLockChange(){ renderLog(); refreshPositions(); }

  async function passphraseFlow(){
    if(!BACKEND||!TEAM){ toast("Passphrases need the backend — this device is running local-only."); return; }
    await loadAuth();
    if(AUTH.locked&&!AUTH.authed){ if(await unlock()){ pull(); } return; }
    if(AUTH.locked){
      var off=await ask({
        title:"🔒 This team has a passphrase",
        body:"Every device opening the team link has to enter it. Remove it and the link on its own opens the team again.",
        ok:"Remove the passphrase", cancel:"Keep it", danger:true});
      if(!off) return;
      var r=await postAuth({newPass:null});
      if(r.ok){ AUTH={exists:true,locked:false,authed:true}; renderAuthBtn(); afterLockChange(); toast("Passphrase removed — the team link is the only gate again.",true); }
      else toast("Couldn't remove it — try again when you're online.");
      return;
    }
    var p1=await ask({
      title:"🔓 Add a passphrase",
      body:"A second gate on top of the team link: you, the other coaches and your other phones each type it once.\n\nThere is no reset. Forget it and the team can only be unlocked from the database.",
      input:"", pass:true, placeholder:"At least 6 characters", ok:"Next", cancel:"Cancel"});
    if(!p1) return;
    var p2=await ask({title:"Type it again", input:"", pass:true, placeholder:"Confirm", ok:"Lock the team", cancel:"Cancel"});
    if(!p2) return;
    if(p1!==p2){ toast("Those two didn't match — nothing changed."); return; }
    var res=await postAuth({newPass:p1});
    if(res.ok){ AUTH={exists:true,locked:true,authed:true}; renderAuthBtn(); afterLockChange(); toast("Passphrase set. Every other device will ask for it the next time it syncs.",true); }
    else if(res.status===400) toast("Too short — use at least 6 characters.");
    else if(res.status===404) toast("This team hasn't reached the server yet — try again in a moment.");
    else toast("Couldn't set it — try again when you're online.");
  }

  async function push(force){
    if(!BACKEND||!TEAM||pushing||LOCKED) return;
    pushing=true;
    var sentAt=(meta.updatedAt||nowMs());
    try{
      var res=await authFetch("/api/team/"+encodeURIComponent(TEAM)+(force?"?force=1":""),{
        method:"PUT", headers:{"content-type":"application/json"},
        body:JSON.stringify({ doc:JSON.stringify(state), baseRev:(meta.rev||0) })
      });
      if(res.status===409){
        var cur=await res.json(); pushing=false;
        // Labelled buttons instead of OK/Cancel — nobody should have to work out
        // which way round a yes/no maps onto losing a device's changes.
        var useTheirs=await ask({
          title:"Changed on another device",
          body:"“"+(state.team||"This team")+"” was edited somewhere else. Only one version can win — the other is discarded.",
          ok:"Use the other device's version",
          cancel:"Keep this device's",
          danger:true});
        if(!useTheirs){ return push(true); }
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
    if(!BACKEND||!TEAM||LOCKED) return;
    try{
      var res=await authFetch("/api/team/"+encodeURIComponent(TEAM),{headers:{accept:"application/json"}});
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
     The queue and its flush live in outbox.js, behind node --test — the
     re-read-after-await discipline in there once cost a real goal. What stays
     here is what needs the app: which rows to queue, and when. */
  function loadOutbox(){ return Outbox.load(KEY); }
  function saveOutbox(ob){ Outbox.save(KEY,ob); }

  // Returns the archive event id so a caller can point back at this row later
  // (a goal record keeps it, and a timestamp correction names it).
  function logEvent(kind,detail,playerId){
    var g=state.game; if(!g||!g.gid) return null;
    var evId="e"+nowMs().toString(36)+Math.floor(Math.random()*1679616).toString(36);
    // A practice game keeps its evId and its local Fix-a-mistake / goal list (the
    // clock, subs and scoring all work) but nothing is queued for the archive.
    if(!g.test){
      var ob=loadOutbox();
      ob.events.push({
        id:evId,
        game_id:g.gid, at:nowMs(), period:g.period, secs:Math.max(0,g.secs), kind:kind,
        player_id:playerId||null, detail:detail?JSON.stringify(detail):null
      });
      saveOutbox(ob);
    }
    // Mirror the undoable kinds for Fix a mistake (3a). Corrections never
    // re-enter the undo list, or undoing an undo would ping-pong forever.
    var undoable = !(detail&&detail.correction) &&
      ((kind==="goal"&&detail&&detail.d>0) || kind==="sog" || kind==="sub" || kind==="keeper" || kind==="clock_set" || kind==="format");
    if(undoable){
      var rec=(g.recent=g.recent||[]);
      // id lets the goal modal and the undo list stay in step — removing a goal
      // in one has to drop the matching row from the other.
      rec.unshift({id:evId, period:g.period, secs:Math.max(0,g.secs), kind:kind, detail:detail||{}});
      if(rec.length>8) rec.length=8;
      fixOpen=null;
    }
    return evId;
  }
  function queueGameRow(){
    var g=state.game, lu=state.lineup; if(!g.gid||!g.startedAt||!lu) return;
    if(g.test) return;   // practice game — never archived
    var ob=loadOutbox();
    ob.games[g.gid]={
      id:g.gid, team_id:TEAM||"", season:state.season||"", format:state.format||"u8",
      // Opponent comes from the linked schedule game; venue stays the manual value
      // (the GC feed lags, so Home/Away on the Roster tab is authoritative).
      started_at:g.startedAt, ended_at:g.endedAt||null, opponent:(g.sched&&g.sched.opponent)||null,
      venue:state.venue==="away"?"away":"home",
      us:g.us, them:g.them, periods:lu.Q, onfield:lu.N, minsper:lu.minsper
    };
    saveOutbox(ob);
  }
  // Only periods that have actually been played reach the season ledger; the
  // planned future is redrawn freely and must never be archived.
  function queueAppearances(upto){
    var g=state.game, lu=state.lineup; if(!g.gid||!g.startedAt||!lu) return;
    if(g.test) return;   // practice game — no appearances reach the season ledger
    var ob=loadOutbox();
    LineupCore.appearanceRows(lu,g.gid,upto).forEach(function(r){
      ob.appearances[r.game_id+"|"+r.player_id+"|"+r.period+"|"+r.pos]=r;
    });
    saveOutbox(ob);
  }

  async function flushOutbox(){
    if(!BACKEND||!TEAM) return;
    if(await Outbox.flush(KEY,"/api/team/"+encodeURIComponent(TEAM))) refreshPositions();
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
    // The archive is the whole Season tab now, so an empty state has to say
    // why rather than leaving the coach on a blank page.
    if(!BACKEND||!TEAM){
      $("#seasonLeaders").innerHTML="";
      $("#seasonLog").innerHTML='<div class="empty">Local-only on this device — no season archive. Games are archived when the app is served with its backend.</div>';
      return;
    }
    var arch=loadArchive();
    drawLog(arch); drawLeaders(arch);   // cached copy first — the sideline case
    var base="/api/team/"+encodeURIComponent(TEAM), season=encodeURIComponent(state.season||"");
    try{
      var r=await fetch(base+"/games?season="+season);
      if(r.ok){ arch.games=(await r.json()).games||[]; saveArchive(arch); drawLog(arch); }
    }catch(e){}
    try{
      var rs=await fetch(base+"/stats?season="+season);
      if(rs.ok){ arch.stats=(await rs.json()).stats||[]; saveArchive(arch); drawLeaders(arch); }
    }catch(e){}
  }
  // The netting of goals/shots out of the append-only log lives in stats.js.
  // Shared by the per-game rollup and the season leaders — same shape, same sort.
  function statRows(by,cls){
    var ids=Object.keys(by).filter(function(id){ return (by[id].goals>0)||(by[id].shots>0)||(by[id].assists>0); });
    if(!ids.length) return "";
    ids.sort(function(a,b){ return (by[b].goals-by[a].goals)||((by[b].assists||0)-(by[a].assists||0))
      ||(by[b].shots-by[a].shots)||nameOf(a).localeCompare(nameOf(b)); });
    return '<div class="statlist '+(cls||"")+'">'+ids.map(function(id,i){
      var r=by[id];
      return '<div class="sr">'+(cls==="lead"?'<span class="rk">'+(i+1)+'</span>':'')
        +'<span class="who">'+esc(nameOf(id))+'</span>'
        +'<span class="v"><span title="Goals">⚽ <b>'+Math.max(0,r.goals)+'</b></span>'
        +'<span title="Assists">🅐 <b>'+Math.max(0,r.assists||0)+'</b></span>'
        +'<span title="Shots on goal">🥅 <b>'+Math.max(0,r.shots)+'</b></span></span></div>';
    }).join("")+'</div>';
  }
  function drawLeaders(arch){
    var box=$("#seasonLeaders"); if(!box) return;
    var by={};
    (arch.stats||[]).forEach(function(s){ by[s.player_id]={goals:+s.goals||0,shots:+s.shots||0,assists:+s.assists||0}; });
    box.innerHTML=statRows(by,"lead")
      || '<div class="empty">No goals or shots on goal recorded yet this season. Tap the ⚽ and 🥅 buttons on a player\'s chip during a game.</div>';
  }
  function drawLog(arch){
    var box=$("#seasonLog"); if(!box) return;
    if(!arch.games.length){ box.innerHTML='<div class="empty">No games archived yet — a game lands here at kickoff.</div>'; return; }
    box.innerHTML=arch.games.map(function(g){
      var d=new Date(g.started_at), when=(d.getMonth()+1)+"/"+d.getDate();
      var vs=g.opponent?(" "+(g.venue==="away"?"@":"vs")+" "+g.opponent):"";
      var open=(g.id===openGid);
      return '<div class="logrow'+(open?" open":"")+'">'
        +'<button class="loghead" data-act="log-game" data-gid="'+g.id+'">'
        +'<span>'+when+esc(vs)+(g.ended_at?"":" · in progress")+'</span><b class="tnum">'+g.us+"–"+g.them+"</b></button>"
        +(open?logEventsHtml(arch,g):"")
        +"</div>";
    }).join("");
  }
  function logEventsHtml(arch,g){
    var evs=arch.events[g.id];
    if(!evs) return '<div class="hint" style="padding:6px 2px">Loading…</div>';
    if(!evs.length) return '<div class="hint" style="padding:6px 2px">No events recorded.</div>';
    var shown=ArchiveStats.withTimeFixes(evs);
    return statRows(ArchiveStats.rollupEvents(evs),"game")
      +'<ul class="loglist">'+shown.map(function(ev){
      var s=Math.max(0,ev.secs||0), mm=Math.floor(s/60), ss=s%60;
      return '<li><span class="tnum">P'+ev.period+" · "+mm+":"+(ss<10?"0":"")+ss+"</span> "+esc(evText(ev))
        +(ev.moved?' <span class="hint">(time corrected)</span>':"")+"</li>";
    }).join("")+"</ul>";
  }
  function evText(ev){
    var d=ArchiveStats.detailOf(ev);
    if(ev.kind==="goal") return d.d<0
      ? (ev.player_id ? nameOf(ev.player_id)+"'s goal removed" : "Score correction ("+d.side+")")
      : (d.side==="us"
        ? (ev.player_id?nameOf(ev.player_id)+" scores"+(d.assistId?", assist "+nameOf(d.assistId):"")+" — "+(state.team||"us"):"Goal — "+(state.team||"us"))
        : "Goal — them");
    if(ev.kind==="goal_time") return "Goal time corrected to P"+d.period+" · "+mmssTxt(d.secs||0);
    if(ev.kind==="sog") return nameOf(ev.player_id)+" — shot on goal"+(d.correction?" (undo)":"");
    if(ev.kind==="sub") return nameOf(ev.player_id)+" on for "+nameOf(d.out)+(d.correction?" (undo)":"");
    if(ev.kind==="keeper") return nameOf(ev.player_id)+" into goal for "+nameOf(d.out)+(d.correction?" (undo)":"");
    if(ev.kind==="keeper_next") return nameOf(ev.player_id)+" set as next keeper";
    if(ev.kind==="period") return d.final ? "Full time "+d.us+"–"+d.them : (d.correction ? "Period set back to "+d.fixedTo : "End of period "+d.ended);
    if(ev.kind==="clock") return d.expired ? "Period clock expired" : (d.running ? "Clock started" : "Clock stopped");
    if(ev.kind==="clock_set") return "Clock set to "+mmssTxt(d.to||0)+(d.correction?" (undo)":(d.played?" — "+mmssTxt(d.played)+" counted as played":""));
    if(ev.kind==="format") return d.keeper ? "Format — keeper"+(d.correction?" (undo)":"") : "Format — no keeper";
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

  /* ---------- coach team-list sync (across a coach's own devices) ----------
     The team LIST is device-local; only each team's doc syncs. A coach id (cid)
     — a third capability token, minted per device and shared once via "Link
     another device" (#c=…) — owns a server copy of the list so every linked
     device shows the same teams. See migrations/0004_coaches.sql. */
  function loadCid(){ try{ return localStorage.getItem(BASE+":cid")||""; }catch(e){ return ""; } }
  function saveCid(c){ try{ localStorage.setItem(BASE+":cid",c); }catch(e){} }
  function ensureCid(){ var c=loadCid(); if(!c){ c=genToken(); saveCid(c); } return c; }
  function loadCidRev(){ try{ return +((JSON.parse(localStorage.getItem(BASE+":cidmeta"))||{}).rev)||0; }catch(e){ return 0; } }
  function saveCidRev(r){ CID_REV=r; try{ localStorage.setItem(BASE+":cidmeta",JSON.stringify({rev:r})); }catch(e){} }

  // Union two lists by token; `base` wins the name when both carry one.
  function unionTeams(base,extra){
    var map={}, order=[];
    function add(t){ if(!t||!t.tok) return;
      if(!map[t.tok]){ map[t.tok]={tok:t.tok,name:t.name||""}; order.push(t.tok); }
      else if(!map[t.tok].name && t.name){ map[t.tok].name=t.name; } }
    (base||[]).forEach(add); (extra||[]).forEach(add);
    return order.map(function(k){ return map[k]; });
  }

  // Read-modify-write the server list under a mutate(list)->list function, with
  // the same baseRev retry the team doc uses. `mutate` returning null aborts.
  async function coachRmw(mutate){
    if(!BACKEND) return null;
    var cid=ensureCid();
    for(var attempt=0; attempt<4; attempt++){
      var gr; try{ gr=await fetch("/api/coach/"+encodeURIComponent(cid),{headers:{accept:"application/json"}}); }catch(e){ return null; }
      if(!gr.ok) return null;
      var j=await gr.json(); var server=[]; try{ server=j.doc?JSON.parse(j.doc):[]; }catch(e){}
      saveCidRev(j.rev||0);
      var next=mutate(server.slice());
      if(next===null) return null;
      var pr; try{
        pr=await fetch("/api/coach/"+encodeURIComponent(cid),{method:"PUT",headers:{"content-type":"application/json"},
          body:JSON.stringify({doc:JSON.stringify(next),baseRev:CID_REV})});
      }catch(e){ return null; }
      if(pr.status===409){ continue; }      // someone else wrote; re-read and retry
      if(!pr.ok) return null;
      var out=await pr.json(); saveCidRev(out.rev||0);
      return next;
    }
    return null;
  }

  // Reconcile this device's list with the server: upload any team the server is
  // missing (the first-link case — the phone's lone team joins the set), then
  // adopt the server list as the shared truth. Called at init and on every
  // foreground, so a team added on another device shows up here.
  async function coachSyncPull(){
    if(!BACKEND) return;
    var cid=ensureCid();
    var gr; try{ gr=await fetch("/api/coach/"+encodeURIComponent(cid),{headers:{accept:"application/json"}}); }catch(e){ return; }
    if(!gr.ok) return;
    var j=await gr.json(); var server=[]; try{ server=j.doc?JSON.parse(j.doc):[]; }catch(e){}
    saveCidRev(j.rev||0);
    var local=loadTeamList();
    var have={}; server.forEach(function(t){ if(t&&t.tok) have[t.tok]=1; });
    var localOnly=local.filter(function(t){ return t&&t.tok&&!have[t.tok]; });
    var adopt;
    if(localOnly.length){
      var res=await coachRmw(function(srv){ return unionTeams(srv,localOnly); });
      adopt = res || unionTeams(server,localOnly);
    } else {
      adopt = server;
    }
    // Keep a local name when the server has none yet, so a just-renamed team
    // doesn't flash back to "Team ab12cd" before its doc sync catches up.
    var byLocal={}; local.forEach(function(t){ if(t&&t.tok) byLocal[t.tok]=t; });
    adopt=adopt.map(function(t){ return (!t.name && byLocal[t.tok] && byLocal[t.tok].name) ? {tok:t.tok,name:byLocal[t.tok].name} : t; });
    saveTeamList(adopt); renderTeamSel();
  }

  // Explicit list edits go through rmw so a concurrent device can't clobber them.
  function coachRemoveTeam(tok){ return coachRmw(function(srv){ return srv.filter(function(t){ return t&&t.tok!==tok; }); }); }
  var coachNameTimer=null;
  function scheduleCoachName(){   // renaming fires per keystroke; push the settled name once
    if(!BACKEND||!TEAM) return;
    if(coachNameTimer) clearTimeout(coachNameTimer);
    coachNameTimer=setTimeout(function(){ coachNameTimer=null; coachSetName(TEAM,state.team||""); },1500);
  }
  function coachSetName(tok,name){
    return coachRmw(function(srv){
      var hit=false, out=srv.map(function(t){ if(t&&t.tok===tok){ hit=true; return {tok:tok,name:name||""}; } return t; });
      if(!hit) out.push({tok:tok,name:name||""});
      return out;
    });
  }
  function renderTeamSel(){
    var el=$("#teamSel"); if(!el) return;
    var list=loadTeamList();
    if(!TEAM||!BACKEND){ el.hidden=true; return; }
    el.hidden=false;
    el.innerHTML=list.map(function(t){
      return '<option value="'+t.tok+'"'+(t.tok===TEAM?" selected":"")+'>'+esc(t.name||("Team "+t.tok.slice(0,6)))+'</option>';
    }).join("")+'<option value="__new">＋ New team…</option>'
      +(list.length>1?'<option value="__del">🗑 Delete this team…</option>':"");
  }

  function copyTeamLink(){
    var url=location.href;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(
        function(){ toast("Team link copied — open it on your phone"); },
        function(){ toast("Copy failed — long-press the address bar to copy"); });
    } else { toast("Copy this page's URL to share the team"); }
  }

  // Copy a device-link (#c=<cid>) to open once on another phone. That device
  // adopts this cid and both stay in sync from then on. Push the list first so
  // the link actually has this device's teams to hand over.
  function copyDeviceLink(){
    var url=location.origin+"/#c="+ensureCid();
    coachSyncPull();   // ensure this device's teams are on the server behind the cid
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(url).then(
        function(){ toast("Device link copied — open it once on your other phone to sync every team",true); },
        function(){ toast("Copy failed — long-press the address bar to copy this page's URL after adding #c="+ensureCid()); });
    } else { toast("Open this on your other device: "+url,true); }
  }

  // Render the always-visible parents' link under the button: an Open link the
  // coach can tap straight through to the board, plus the raw URL to long-press.
  function showSnackLink(board){
    var out=$("#snackLinkOut"); if(!out||!board) return "";
    var url=location.origin+"/snacks#b="+board;
    out.innerHTML='Parents\' snack sign-up: <a href="'+esc(url)+'" target="_blank" rel="noopener">Open the board ↗</a><br><span style="color:var(--muted);font-size:.85em">'+esc(url)+'</span>';
    out.hidden=false;
    return url;
  }

  // Reflect the per-team referee-signup toggle on its button.
  function applyRefToggle(on){
    var b=$("#refToggleBtn"); if(!b) return;
    b.setAttribute("aria-pressed", on?"true":"false");
    b.textContent="🙋 Referee sign-up: "+(on?"On":"Off");
  }

  // On team load, show the link if the board is already minted — no tap needed —
  // and sync the referee toggle. GET never mints, so a team without a board stays
  // quiet until the coach taps 🍊 (referees defaults on for a team with no board).
  async function refreshSnackLink(){
    if(!BACKEND||!TEAM) return;
    try{
      var r=await authFetch("/api/team/"+encodeURIComponent(TEAM)+"/snacks",{headers:{accept:"application/json"}});
      if(!r.ok) return;
      var j=await r.json();
      if(j&&j.board) showSnackLink(j.board);
      if(j&&typeof j.referees==="boolean") applyRefToggle(j.referees);
    }catch(e){}
  }

  // The coach's per-team switch for the parents' referee sign-up. Off only hides
  // the slot; the server keeps who already volunteered, so it can come back on.
  async function toggleReferees(){
    if(!BACKEND||!TEAM){ toast("Referee sign-up needs the backend — this device is running local-only."); return; }
    var b=$("#refToggleBtn");
    var next=!(b&&b.getAttribute("aria-pressed")==="true");
    if(b) b.disabled=true;
    try{
      var r=await authFetch("/api/team/"+encodeURIComponent(TEAM)+"/snacks",{method:"PUT",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({referees:next})});
      if(!r.ok){ toast("Couldn't update referee sign-up ("+r.status+")"); return; }
      var j=await r.json();
      applyRefToggle(!!j.referees);
      toast(j.referees?"Referee sign-up is on — home games show it":"Referee sign-up is off — hidden on the parents' board");
    }catch(e){ toast("Couldn't update referee sign-up"); }
    finally{ if(b) b.disabled=false; }
  }

  // The parents' snack board is a second link, minted once per team on the
  // server. It is never the team token — that one grants every write to the
  // doc, which is exactly what a link texted to twelve families must not.
  // The link is also written under the button: iOS only allows a clipboard
  // write inside the tap itself, and by the time the fetch returns the tap is
  // over, so a visible link the coach can long-press is the reliable path.
  async function copySnackLink(){
    if(!BACKEND||!TEAM){ toast("The snack sign-up needs the backend — this device is running local-only."); return; }
    try{
      var r=await authFetch("/api/team/"+encodeURIComponent(TEAM)+"/snacks",{method:"POST",headers:{accept:"application/json"}});
      if(!r.ok){ toast("Couldn't set up the snack sign-up ("+r.status+")"); return; }
      var j=await r.json();
      if(!j.board){ toast("Couldn't set up the snack sign-up"); return; }
      var url=showSnackLink(j.board);
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(url).then(
          function(){ toast("Snack sign-up link copied — text it to the parents"); },
          function(){ toast("Long-press the link below to copy it"); });
      } else { toast("Long-press the link below to copy it"); }
    }catch(e){ toast("Couldn't set up the snack sign-up"); }
  }

  // One GameChanger feed per team. The server secret can only describe one
  // team, so a coach with two pastes each team's "Subscribe to calendar" link
  // here; it is kept on the team row and wins over the secret. The snack
  // sign-up's game list comes from whichever applies.
  async function connectSchedule(){
    if(!BACKEND||!TEAM){ toast("Connecting a schedule needs the backend — this device is running local-only."); return; }
    var url=await ask({
      title:"📅 Connect GameChanger schedule",
      body:"In GameChanger open the team's Schedule, tap ⋮ → Subscribe to calendar, copy the link and paste it here. The snack sign-up lists this team's games from it.\nType \"disconnect\" to remove a link you set earlier.",
      input:"", placeholder:"webcal://…", ok:"Connect", cancel:"Cancel"});
    if(!url) return;
    var body={url: url.toLowerCase()==="disconnect" ? null : url};
    try{
      var r=await authFetch("/api/team/"+encodeURIComponent(TEAM)+"/schedule",{method:"PUT",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify(body)});
      if(r.status===400){ toast("That doesn't look like a calendar link — it should start with webcal:// or https://"); return; }
      if(r.status===502){ toast("That link didn't return a calendar — copy it again from GameChanger"); return; }
      if(!r.ok){ toast("Couldn't save the schedule link ("+r.status+")"); return; }
      var j=await r.json();
      if(body.url===null) toast(j.connected?"This team's link removed — using the shared schedule":"Schedule disconnected");
      else toast("Schedule connected — "+(j.games||0)+" games for the snack sign-up");
    }catch(e){ toast("Couldn't save the schedule link"); }
  }

  // Force a fresh pull from GameChanger, skipping the 30-min cache, so a game the
  // coach just changed shows on the parents' board right away. ?fresh=1 revalidates
  // the feed with the origin AND replaces the shared cache the board reads.
  async function refreshGames(){
    if(!BACKEND||!TEAM){ toast("Refreshing games needs the backend — this device is running local-only."); return; }
    var btn=$("#refreshGamesBtn"); if(btn) btn.disabled=true;
    try{
      var r=await authFetch("/api/team/"+encodeURIComponent(TEAM)+"/schedule?fresh=1",{headers:{accept:"application/json"}});
      if(r.status===501){ toast("No schedule connected yet — tap 📅 Connect schedule first"); return; }
      if(!r.ok){ toast("Couldn't refresh the games ("+r.status+")"); return; }
      var j=await r.json();
      calGames=(j.events||[]).filter(function(e){ return e.uid && e.venue && e.startsAt; });
      renderGamePicker();
      toast("Games refreshed — "+(j.games||0)+" on the schedule");
    }catch(e){ toast("Couldn't refresh the games"); }
    finally{ if(btn) btn.disabled=false; }
  }

  /* ---------- schedule → Game Day ----------
     The coach picks the GameChanger game they're about to coach; it stamps venue +
     opponent and makes the game count. No pick (or "Practice") = a test game that
     never touches the archive or fairness ledgers. calGames is the feed's games
     (venue set = a real match, not a practice/event), nearest date first. */
  var calGames=[];

  async function loadSchedule(){
    if(!BACKEND||!TEAM) return;
    try{
      var r=await fetch("/api/team/"+encodeURIComponent(TEAM)+"/schedule",{headers:{accept:"application/json"}});
      if(!r.ok) return;   // 501 = no feed connected yet; picker keeps Practice/Manual only
      var j=await r.json();
      calGames=(j.events||[]).filter(function(e){ return e.uid && e.venue && e.startsAt; });
      renderGamePicker();
    }catch(e){}
  }

  function gameLabel(e){
    var d=new Date(e.startsAt), md=(d.getMonth()+1)+"/"+d.getDate();
    var t=d.toLocaleTimeString([], {hour:"numeric", minute:"2-digit"});
    var vs=e.venue==="away"?"@":"vs";
    return md+" "+t+" "+vs+" "+(e.opponent||"TBD");
  }

  // Rebuild the option list (Practice + upcoming/recent games + Manual) and select
  // the option that matches the current game's link.
  function renderGamePicker(){
    var sel=$("#gameSel"); if(!sel) return;
    var g=state.game;
    var now=nowMs();
    // Show games from ~1 day ago onward so a same-day or slightly-past game is still pickable.
    var upcoming=calGames.filter(function(e){ return e.startsAt >= now-24*3600e3; });
    // If the linked game is older than that window, keep it in the list so it stays selectable.
    if(g.sched && g.sched.uid && !upcoming.some(function(e){return e.uid===g.sched.uid;})){
      upcoming=[{uid:g.sched.uid, startsAt:g.sched.startsAt, opponent:g.sched.opponent, venue:g.sched.venue}].concat(upcoming);
    }
    var opts='<option value="__test">🧪 Practice — won\'t count</option>';
    if(upcoming.length){
      opts+='<optgroup label="Scheduled games (counts)">';
      upcoming.forEach(function(e){ opts+='<option value="'+esc(e.uid)+'">'+esc(gameLabel(e))+'</option>'; });
      opts+='</optgroup>';
    }
    opts+='<option value="__manual">✏️ Real game — not on the list</option>';
    sel.innerHTML=opts;
    sel.value = g.test ? "__test" : (g.sched&&g.sched.uid ? g.sched.uid : "__manual");
    if(!sel.value) sel.value="__test";   // linked game no longer in the feed → fall back visibly
  }

  // Apply the coach's pick to the CURRENT game. Linking a scheduled game pre-fills
  // Home/Away (still hand-overridable) and the opponent, and makes the game count.
  function pickGame(v){
    var g=state.game;
    if(v==="__test"){ g.test=true; g.sched=null; }
    else if(v==="__manual"){ g.test=false; g.sched=null; }
    else {
      var e=calGames.find(function(x){return x.uid===v;}) || (g.sched&&g.sched.uid===v?g.sched:null);
      if(!e){ g.test=true; g.sched=null; }
      else {
        g.test=false;
        g.sched={uid:e.uid, opponent:e.opponent||null, startsAt:e.startsAt||0, venue:e.venue||null};
        if(e.venue==="home"||e.venue==="away"){ state.venue=e.venue; var vs=$("#venue"); if(vs) vs.value=e.venue; }
      }
    }
    save(); renderGame();
    toast(g.test?"Practice game — this won't affect season stats"
      :(g.sched?"Linked "+gameLabel(g.sched)+" — this game counts":"Real game — this game counts"));
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
    $("#venue").value=state.venue||"home";
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
    var linkDeviceBtn=$("#linkDeviceBtn"); if(linkDeviceBtn) linkDeviceBtn.hidden=false;
    var snackBtn=$("#snackBtn"); if(snackBtn) snackBtn.hidden=false;
    var gcBtn=$("#gcBtn"); if(gcBtn) gcBtn.hidden=false;
    var refreshBtn=$("#refreshGamesBtn"); if(refreshBtn) refreshBtn.hidden=false;
    var refToggle=$("#refToggleBtn"); if(refToggle) refToggle.hidden=false;

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

    // Device sync: adopt a cid that arrived in the URL (overwriting this
    // device's own), then reconcile the team list with the server. Adoption
    // resets the rev so the merge fetches the linked device's list fresh.
    if(linkCid){ saveCid(linkCid); saveCidRev(0); linkCid=null; toast("Linked — syncing your teams to this device…",true); }
    else { CID_REV=loadCidRev(); }
    coachSyncPull();

    setPill("saving","Syncing…");
    await ensureAuth();          // a locked team asks once, here, before anything syncs
    renderAuthBtn();
    await pull();
    renderLog();
    refreshSnackLink();          // show the parents' link straight away if the board is already minted
    loadSchedule();              // fill the Game Day picker with this team's scheduled games
    window.addEventListener("online", function(){ if(isDirty()) push(); else { pull(); flushOutbox(); } coachSyncPull(); });
    document.addEventListener("visibilitychange", function(){ if(document.visibilityState==="visible"){ if(isDirty()) push(); else pull(); coachSyncPull(); } });
  }

  /* ---------- boot ---------- */
  function boot(){
    TEAM=hashToken();
    linkCid=hashCid();          // #c=… : a device-link URL to adopt before syncing the list
    KEY=TEAM?(BASE+":"+TEAM):BASE;
    state=load(); meta=loadMeta();
    if(state.game.secs==null) state.game.secs=state.minsper*60;
    state.game.running=false;   // never resume a live clock on reload
    renderAll();
    showTab(tabFromHash()||"lineup");   // deep link / reload lands on the tab in the URL
    setInterval(renderEnds,30000);   // "ends ≈" stays fresh while paused — tick() won't run then
    // the burn-down is wall-clock, so it drifts out of date on its own
    setInterval(function(){
      if(state.practiceRun&&state.practiceRun.startedAt&&$("#p-practice").classList.contains("active")) renderBurn();
    },15000);
    setInterval(tickToastAges,5000);   // cheap: a no-op when nothing is on screen
    // Esc (or any other close) answers "no" rather than leaving a dangling promise
    var askDlg=$("#askDialog");
    if(askDlg) askDlg.addEventListener("close",function(){ if(askDone) askClose(askIsText?null:false); });
    initSync();                 // async — reconciles with the backend if one is present
    initAlerts();               // needs TEAM, so it cannot run at parse time
  }
  boot();

  if("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function(){});
})();
