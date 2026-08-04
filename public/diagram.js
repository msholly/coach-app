// SVG drill diagrams: spec -> markup string. Pure — no DOM, no app state.
// Carries its own esc() so this file depends on nothing else.
var diagram = (function(){
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}

  function diagram(spec){
    var svg='<svg viewBox="0 0 300 170" role="img" aria-label="Drill diagram">';
    // pitch texture
    svg+='<rect x="0" y="0" width="300" height="170" fill="var(--accent-deep)"/>';
    (spec.items||[]).forEach(function(it){ svg+=drawItem(it); });
    svg+='</svg>';
    return svg;
  }
  function drawItem(it){
    var C={us:"#ffffff", them:"#0f1f16"};
    if(it.t==="zone") return '<rect x="'+it.x+'" y="'+it.y+'" width="'+it.w+'" height="'+it.h+'" rx="10" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6" stroke-dasharray="6 5"/>'
      +'<line x1="150" y1="'+it.y+'" x2="150" y2="'+(it.y+it.h)+'" stroke="rgba(255,255,255,.18)" stroke-width="1.2"/>';
    if(it.t==="line") return '<line x1="'+it.x1+'" y1="'+it.y1+'" x2="'+it.x2+'" y2="'+it.y2+'" stroke="rgba(255,255,255,.55)" stroke-width="2"/>';
    if(it.t==="cone") return '<path d="M'+it.x+' '+(it.y-9)+' L'+(it.x+7)+' '+(it.y+4)+' L'+(it.x-7)+' '+(it.y+4)+' Z" fill="#e8622c" stroke="#b64715" stroke-width=".8"/>';
    if(it.t==="ball") return '<circle cx="'+it.x+'" cy="'+it.y+'" r="4.2" fill="#fff" stroke="#0f1f16" stroke-width="1"/><path d="M'+it.x+' '+(it.y-3)+' l2.6 2 -1 3 -3.2 0 -1-3 z" fill="#0f1f16"/>';
    if(it.t==="player"){
      var isUs=it.c!=="them";
      return '<circle cx="'+it.x+'" cy="'+it.y+'" r="9" fill="'+(isUs?"#ffffff":"#12271b")+'" stroke="'+(isUs?"#2f7d4f":"#cbd6cd")+'" stroke-width="2.4"/>';
    }
    if(it.t==="goal"){
      var w=it.w||20, left=(it.dir==="l");
      var gx=it.x;
      return '<rect x="'+gx+'" y="'+it.y+'" width="'+w+'" height="34" fill="none" stroke="#fff" stroke-width="2"/>'
        +'<path d="'+netPath(gx,it.y,w,34)+'" stroke="rgba(255,255,255,.35)" stroke-width=".6" fill="none"/>';
    }
    if(it.t==="arrow") return arrow(it.x1,it.y1,it.x2,it.y2,it.s);
    if(it.t==="label") return '<text x="'+it.x+'" y="'+it.y+'" text-anchor="middle" fill="rgba(255,255,255,.85)" font-size="10" font-family="Bahnschrift,system-ui,sans-serif" letter-spacing="1">'+esc(it.text)+'</text>';
    return "";
  }
  function netPath(x,y,w,h){ var p=""; for(var i=1;i<4;i++){p+="M"+(x+i*w/4)+" "+y+"L"+(x+i*w/4)+" "+(y+h);} for(var j=1;j<4;j++){p+="M"+x+" "+(y+j*h/4)+"L"+(x+w)+" "+(y+j*h/4);} return p; }
  function arrow(x1,y1,x2,y2,style){
    var a=Math.atan2(y2-y1,x2-x1), L=9, th=0.42;
    var p1x=x2-L*Math.cos(a-th), p1y=y2-L*Math.sin(a-th);
    var p2x=x2-L*Math.cos(a+th), p2y=y2-L*Math.sin(a+th);
    var dash= style==="pass"?'stroke-dasharray="7 4"': style==="drib"?'stroke-dasharray="1.5 4"':'';
    var col="rgba(255,255,255,.92)";
    return '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="'+col+'" stroke-width="2" stroke-linecap="round" '+dash+'/>'
      +'<path d="M'+x2+' '+y2+' L'+p1x.toFixed(1)+' '+p1y.toFixed(1)+' L'+p2x.toFixed(1)+' '+p2y.toFixed(1)+' Z" fill="'+col+'"/>';
  }
  return diagram;
})();
