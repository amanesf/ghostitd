// -*- coding: utf-8 -*-
// pipeline_lib/skeleton.py の BONES/BHIER + stage_skeleton()(ピボット計算)のJS移植。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

var BONES = ['hips','torso','chest','neck','head',
  'clavicle_L','upperarm_L','forearm_L','wrist_L','hand_L',
  'clavicle_R','upperarm_R','forearm_R','wrist_R','hand_R',
  'thigh_L','shin_L','foot_L','toe_L',
  'thigh_R','shin_R','foot_R','toe_R'];

var BHIER = {hips:null,torso:'hips',chest:'torso',neck:'chest',head:'neck',
  clavicle_L:'chest',upperarm_L:'clavicle_L',forearm_L:'upperarm_L',wrist_L:'forearm_L',hand_L:'wrist_L',
  clavicle_R:'chest',upperarm_R:'clavicle_R',forearm_R:'upperarm_R',wrist_R:'forearm_R',hand_R:'wrist_R',
  thigh_L:'hips',shin_L:'thigh_L',foot_L:'shin_L',toe_L:'foot_L',
  thigh_R:'hips',shin_R:'thigh_R',foot_R:'shin_R',toe_R:'foot_R'};

var BIDX = {}; BONES.forEach(function(b,i){BIDX[b]=i;});
P3D.BONES=BONES; P3D.BHIER=BHIER; P3D.BIDX=BIDX;

function rowRuns(mask, w, y, gap){ return P3D.findRuns(mask.subarray(y*w,y*w+w), gap||1); }

function smooth1(vals, win){
  win = win||5;
  var n=vals.length;
  if(n < Math.max(6, win+1)) return vals.slice();
  var k=win>>1, out=new Array(n);
  for(var i=0;i<n;i++){
    var a=Math.max(0,i-k), b=Math.min(n,i+k+1), s=0;
    for(var j=a;j<b;j++) s+=vals[j];
    out[i]=s/(b-a);
  }
  return out;
}

/**
 * fa: Uint8Array(W*H) 前面2値シルエット, W,H: サイズ
 * YTOP,YBOT,CX: profile.jsonのmeta相当, SCALE=YBOT-YTOP
 * LM: landmarks.json相当のオブジェクト(下記フィールドを使う)
 *   head_bottom_v, shoulder_v, merge_end_v, shoulder_hw_px, waist_v, hip_v,
 *   chest_v(無ければ計算), knee_v, ankle_v, elbow_frac(既定0.47),
 *   wrist_L_mx/wrist_R_mx(任意), elbow_L_mx/elbow_R_mx(任意), toe_v(無ければ計算),
 *   clavicle_L_m/clavicle_R_m(任意、[x,y,z]),
 *   arm_m_L/arm_m_R(任意、{sh,el,wr:[mx,my]}: あれば腕トレースの代わりに直接使用),
 *   leg_m_L/leg_m_R(任意、{hip,knee,ankle,toe:[mx,my]}: あれば脚トレースの代わりに直接使用)
 * 戻り値: {pivots:{boneName:[x,y,z]}, extraPivots:{name:[x,y,z]}}
 */
function computePivots(fa, W, H, YTOP, YBOT, CX, LM){
  var SCALE = YBOT-YTOP;
  function pyOf(v){ return Math.round(YTOP+v*SCALE); }
  function MX(px){ return (px-CX)/SCALE; }
  function MY(py){ return (YBOT-py)/SCALE; }

  var HEAD_BOTTOM_V=LM.head_bottom_v, SHOULDER_V=LM.shoulder_v, MERGE_END_V=LM.merge_end_v;
  var SHOULDER_HW=LM.shoulder_hw_px, WAIST_V=LM.waist_v, HIP_V=LM.hip_v;
  var CHEST_V = (LM.chest_v!==undefined) ? LM.chest_v : SHOULDER_V+0.45*(WAIST_V-SHOULDER_V);
  var KNEE_V=LM.knee_v, ANKLE_V=LM.ankle_v, ELBOW_FRAC=(LM.elbow_frac!==undefined)?LM.elbow_frac:0.47;
  var WRIST_MX={L:LM.wrist_L_mx, R:LM.wrist_R_mx};
  var ELBOW_MX={L:LM.elbow_L_mx, R:LM.elbow_R_mx};
  var TOE_V = (LM.toe_v!==undefined) ? LM.toe_v : ANKLE_V+0.85*(1.0-ANKLE_V);

  var pivots={}, extraPivots={};

  pivots.head=[0.0, MY(pyOf(HEAD_BOTTOM_V)), 0.0];
  pivots.neck=[0.0, MY(pyOf(SHOULDER_V)), 0.0];
  pivots.chest=[0.0, MY(pyOf(CHEST_V)), 0.0];
  pivots.torso=[0.0, MY(pyOf(WAIST_V)), 0.0];
  var hipsPivotV = WAIST_V+0.3*(HIP_V-WAIST_V);
  pivots.hips=[0.0, MY(pyOf(hipsPivotV)), 0.0];

  ['L','R'].forEach(function(s){
    var c = LM['clavicle_'+s+'_m'];
    if(!c){
      var sgn = (s==='L') ? -1.0 : 1.0;
      c=[sgn*SHOULDER_HW*0.45/SCALE, 1.0-SHOULDER_V, 0.0];
    }
    extraPivots['clavicle_'+s]=[c[0],c[1],c[2]];
  });

  // ---- arms ----
  function colThickness(x,y0,y1){
    var top=-1, bot=-1;
    for(var y=y0;y<y1;y++){ if(fa[y*W+x]){ if(top<0)top=y; bot=y; } }
    if(top<0) return null;
    return [top,bot];
  }
  var armMargin = Math.round(0.3*SHOULDER_HW);
  var ay0=pyOf(SHOULDER_V)-armMargin, ay1=pyOf(MERGE_END_V)+armMargin;
  var shHalf=Math.round(SHOULDER_HW);
  ['L','R'].forEach(function(side){
    // ★2026-07-04: ユーザーが肩/肘/手首のランドマーク点を置いている場合は、
    // シルエットの列トレースをせず点そのものをピボットにする(髪や袖が腕に
    // 重なるとトレースの中心線がずれるため。点はpipeline.jsのbuildDerived
    // Landmarksがモデル座標に変換して渡してくる)。
    var am=LM['arm_m_'+side];
    if(am){
      pivots['upperarm_'+side]=[am.sh[0], am.sh[1], 0.0];
      pivots['forearm_'+side]=[am.el[0], am.el[1], 0.0];
      pivots['wrist_'+side]=[am.wr[0], am.wr[1], 0.0];
      extraPivots['hand_'+side]=[am.wr[0], am.wr[1], 0.0];
      return;
    }
    var xs=[];
    if(side==='R'){ for(var x=CX+shHalf; x<W-2; x++) xs.push(x); }
    else{ for(var x=CX-shHalf; x>2; x--) xs.push(x); }
    var cols=[];
    for(var i=0;i<xs.length;i++){
      var x=xs[i];
      if(x<0||x>=W) continue;
      var tb=colThickness(x,Math.max(ay0,0),Math.min(ay1,H));
      if(tb) cols.push([x,(tb[0]+tb[1])/2,(tb[1]-tb[0])/2]);
    }
    if(cols.length<6){ console.warn("arm cols few",side,cols.length); return; }
    var xMin=cols[0][0], xMax=cols[cols.length-1][0];
    var ne=22;
    var xq=P3D.linspace(xMin,xMax,ne);
    // np.interp(xq, cols[:,0], cols[:,1])。R側はcols[:,0]昇順のまま、L側は
    // xがCXから離れる向き(降順)に格納されているため反転して昇順にする。
    var colsForInterp = (side==='R') ? cols : cols.slice().reverse();
    var xp = colsForInterp.map(function(c){return c[0];});
    var yp = colsForInterp.map(function(c){return c[1];});
    var cyq=[];
    for(var q=0;q<ne;q++) cyq.push(Math.round(P3D.interp1d(xq[q], xp, yp)));
    cyq = smooth1(cyq.map(function(py){return MY(py);}));
    var mxs=[]; for(var q2=0;q2<ne;q2++) mxs.push(MX(xq[q2]));
    var emx=ELBOW_MX[side];
    var ke;
    if(emx===undefined || emx===null){ ke=Math.round(ne*ELBOW_FRAC); }
    else{
      var best=0,bd=Infinity;
      for(var k=0;k<ne;k++){ var d=Math.abs(mxs[k]-emx); if(d<bd){bd=d;best=k;} }
      ke=best;
    }
    ke = Math.max(1, Math.min(ke, ne-4));
    var wmx=WRIST_MX[side];
    var kw;
    if(wmx===undefined || wmx===null){ kw=Math.round(ne*0.78); }
    else{
      var best2=0,bd2=Infinity;
      for(var k2=0;k2<ne;k2++){ var d2=Math.abs(mxs[k2]-wmx); if(d2<bd2){bd2=d2;best2=k2;} }
      kw=best2;
    }
    kw = Math.max(ke+2, Math.min(kw, ne-3));
    var shoulder=[mxs[0], cyq[0], 0.0];
    var elbow=[mxs[ke], cyq[ke], 0.0];
    var wrist=[mxs[kw], cyq[kw], 0.0];
    pivots['upperarm_'+side]=shoulder;
    pivots['forearm_'+side]=elbow;
    pivots['wrist_'+side]=wrist;
    extraPivots['hand_'+side]=[wrist[0],wrist[1],wrist[2]];
  });

  // ---- legs ----
  function legRuns(v){
    var r=rowRuns(fa, W, Math.min(Math.max(pyOf(v),0),H-1), 1).filter(function(rr){return rr[1]-rr[0]>6;});
    var L=r.filter(function(rr){ return (rr[0]+rr[1])/2<CX; });
    var R=r.filter(function(rr){ return (rr[0]+rr[1])/2>=CX; });
    function pick(lst){
      if(!lst.length) return null;
      var best=lst[0];
      for(var i=1;i<lst.length;i++){ if(lst[i][1]-lst[i][0] > best[1]-best[0]) best=lst[i]; }
      return best;
    }
    return [pick(L), pick(R)];
  }
  ['L','R'].forEach(function(side){
    // ★2026-07-04: 膝/足首/つま先(+股)のランドマーク点があれば脚も点から直接
    // ピボットを決める。従来の「行runの最大幅を脚とみなす」トレースはスカート
    // で両脚が1本のrunに融合すると壊れる(実測: thigh_Lが体の中心x、thigh_R
    // 欠落、膝Lが0.13ズレ)。腿の付け根は股(hip点)の高さで、x=股と膝の中間。
    var lm=LM['leg_m_'+side];
    if(lm){
      pivots['thigh_'+side]=[(lm.hip[0]+lm.knee[0])/2, lm.hip[1], 0.0];
      pivots['shin_'+side]=[lm.knee[0], lm.knee[1], 0.0];
      pivots['foot_'+side]=[lm.ankle[0], lm.ankle[1], 0.0];
      pivots['toe_'+side]=[lm.toe[0], lm.toe[1], 0.0];
      return;
    }
    var sel = (side==='L') ? 0 : 1;
    function legCenterAt(v){
      var runs=legRuns(v), rn=runs[sel];
      if(!rn) return null;
      var a=rn[0], b=rn[1];
      return [MX((a+b)/2), MY(pyOf(v)), v];
    }
    function segCenters(v0,v1,n){
      var out=[];
      for(var i=0;i<n;i++){
        var v=v0+(v1-v0)*i/(n-1);
        var c=legCenterAt(v);
        if(c) out.push(c);
      }
      return out;
    }
    var thigh=segCenters(HIP_V, KNEE_V+0.010, 12);
    var shin=segCenters(KNEE_V-0.010, ANKLE_V+0.010, 10);
    var ankleC=legCenterAt(ANKLE_V);
    if(shin.length && ankleC) shin[shin.length-1]=ankleC;
    function smoothCx(pts){
      if(pts.length<6) return pts;
      var xs=smooth1(pts.map(function(p){return p[0];}));
      return pts.map(function(p,i){ return [xs[i],p[1],p[2]]; });
    }
    thigh=smoothCx(thigh); shin=smoothCx(shin);
    var FOOT_BOT=0.998;
    var footFull=segCenters(ANKLE_V-0.010, FOOT_BOT, 9);
    if(footFull.length && ankleC) footFull[0]=ankleC;
    var footBotC=legCenterAt(FOOT_BOT);
    if(footFull.length && footBotC) footFull[footFull.length-1]=footBotC;
    var ksp=0;
    if(footFull.length){
      // ★2026-07-04: 元コード(skeleton.py)はMY値(モデル座標)とv系(画像上端
      // からの比率)のTOE_Vを直接比較する単位不一致のバグがあり、実質
      // ksp=nf-2付近に固定されてつま先ボーンの位置がおかしくなっていた。
      // footFull各点の第3要素(v、legCenterAt()が返す画像座標系の比率)を
      // TOE_Vと比較するよう修正。
      var footVs=footFull.map(function(p){return p[2];});
      var best3=0, bd3=Infinity;
      for(var k3=0;k3<footVs.length;k3++){ var d3=Math.abs(footVs[k3]-TOE_V); if(d3<bd3){bd3=d3;best3=k3;} }
      ksp=Math.max(1, Math.min(best3, footFull.length-2));
    }
    if(thigh.length) pivots['thigh_'+side]=[thigh[0][0],thigh[0][1],0.0];
    if(shin.length) pivots['shin_'+side]=[shin[0][0],shin[0][1],0.0];
    if(footFull.length){
      pivots['foot_'+side]=[footFull[0][0],footFull[0][1],0.0];
      pivots['toe_'+side]=[footFull[ksp][0],footFull[ksp][1],0.0];
    }
  });

  return {pivots:pivots, extraPivots:extraPivots};
}
P3D.computePivots = computePivots;

// ---- スキニングウェイト(visual_hull.py/accessories.pyの共通ロジック) ----

// 各頂点から最も近いボーン線分(親ピボット→自ピボット)までの距離でk近傍
// ウェイトを決める(nearest-bone-segment方式)。
// V: Float32Array(N*3), pivots:{bone:[x,y,z]}, boneSubset: 対象ボーン名配列, k: 近傍数
// 戻り値: {J:Uint16Array(N*4), W:Float32Array(N*4)}
function nearestBoneSegmentSkin(V, pivots, boneSubset, k){
  k = k || 4;
  var subset = boneSubset.filter(function(b){ return pivots[b]; });
  var m=subset.length;
  k=Math.min(k,m);
  var A=new Float64Array(m*3), Bp=new Float64Array(m*3), AB=new Float64Array(m*3), L2=new Float64Array(m);
  subset.forEach(function(b,i){
    var par=P3D.BHIER[b];
    var a = (par && pivots[par]) ? pivots[par] : pivots[b];
    var p = pivots[b];
    A[i*3]=a[0];A[i*3+1]=a[1];A[i*3+2]=a[2];
    Bp[i*3]=p[0];Bp[i*3+1]=p[1];Bp[i*3+2]=p[2];
    var abx=p[0]-a[0], aby=p[1]-a[1], abz=p[2]-a[2];
    AB[i*3]=abx;AB[i*3+1]=aby;AB[i*3+2]=abz;
    L2[i]=abx*abx+aby*aby+abz*abz;
  });
  var n=V.length/3;
  var J=new Uint16Array(n*4), W=new Float32Array(n*4);
  var idxmap = subset.map(function(b){ return P3D.BIDX[b]; });
  var dists=new Float64Array(m);
  // 首/頭の座標が分かる場合のみ、鎖骨などへの誤割り当てを補正する(下記参照)。
  // 閾値はキャラのスケールに比例させる: Y_GATE=首の高さ、DIST_THRESH=頭〜腰の距離。
  var neckSubIdx = subset.indexOf('neck'), headSubIdx = subset.indexOf('head');
  var yGate=null, distThresh=null;
  if(neckSubIdx>=0 && headSubIdx>=0 && pivots.hips){
    yGate = pivots.neck[1];
    var hp=pivots.hips, hd=pivots.head;
    var dhx=hd[0]-hp[0], dhy=hd[1]-hp[1], dhz=hd[2]-hp[2];
    distThresh = Math.sqrt(dhx*dhx+dhy*dhy+dhz*dhz);
  }
  for(var v=0; v<n; v++){
    var vx=V[v*3], vy=V[v*3+1], vz=V[v*3+2];
    for(var i2=0;i2<m;i2++){
      var d;
      if(L2[i2]<1e-12){
        var dx=vx-Bp[i2*3], dy=vy-Bp[i2*3+1], dz=vz-Bp[i2*3+2];
        d=Math.sqrt(dx*dx+dy*dy+dz*dz);
      }else{
        var t=((vx-A[i2*3])*AB[i2*3]+(vy-A[i2*3+1])*AB[i2*3+1]+(vz-A[i2*3+2])*AB[i2*3+2])/L2[i2];
        if(t<0)t=0; if(t>1)t=1;
        var cxp=A[i2*3]+t*AB[i2*3], cyp=A[i2*3+1]+t*AB[i2*3+1], czp=A[i2*3+2]+t*AB[i2*3+2];
        var dx2=vx-cxp, dy2=vy-cyp, dz2=vz-czp;
        d=Math.sqrt(dx2*dx2+dy2*dy2+dz2*dz2);
      }
      dists[i2]=d;
    }
    // k近傍(距離昇順)をO(m log m)で求める(m<=23なので十分高速)
    var order=Array.from({length:m}, function(_,i){return i;});
    order.sort(function(a,b){ return dists[a]-dists[b]; });
    var wsum=0, ws=new Float64Array(k);
    for(var c=0;c<k;c++){
      var dd=dists[order[c]];
      ws[c]=1.0/(dd*dd+1e-6);
      wsum+=ws[c];
    }
    for(var c2=0;c2<k;c2++){
      J[v*4+c2]=idxmap[order[c2]];
      W[v*4+c2]=ws[c2]/wsum;
    }
    for(var c3=k;c3<4;c3++){ J[v*4+c3]=idxmap[order[0]]; W[v*4+c3]=0; }
    // 首/頭が優勢な頂点は、鎖骨など空間的に近いだけで骨格上は無関係な骨まで
    // k近傍に混ざり込みやすい(肩と首の付け根が近いため)。腕を振ると首や頭の
    // 一部がその骨に引っ張られてちぎれたように見えるため、髪(アクセサリー)を
    // 頭に完全固定しているのと同じ考え方で、首/頭が最大ウェイトの頂点は
    // その骨100%の剛体ウェイトに丸める。
    var domIdx=0; for(var dci=1;dci<4;dci++){ if(W[v*4+dci]>W[v*4+domIdx])domIdx=dci; }
    var domBone=P3D.BONES[J[v*4+domIdx]];
    var rigidBone=null;
    if(domBone==='neck'||domBone==='head'){
      rigidBone=domBone;
    }else if(yGate!==null && vy>yGate && Math.min(dists[neckSubIdx],dists[headSubIdx])<distThresh){
      // 逆に、首/頭が優勢にならなかった頂点でも、顔・頬・耳のように首の高さより
      // 上にあって首/頭のすぐ近く(体格に比例した範囲内)にあるものは、
      // 実際には顔の一部なのに鎖骨/二の腕の端点の方がわずかに近いという理由だけで
      // 誤って腕側に割り当てられてしまうことがある(頬が肩や肘にくっついて
      // 見える不具合の原因)。首の高さより上・かつ首/頭にごく近い頂点は
      // 首/頭のうち近い方へ強制的に寄せる。
      rigidBone = dists[neckSubIdx]<dists[headSubIdx] ? 'neck' : 'head';
    }
    if(rigidBone){
      var domJ = rigidBone==='neck' ? idxmap[neckSubIdx] : idxmap[headSubIdx];
      J[v*4]=domJ;J[v*4+1]=domJ;J[v*4+2]=domJ;J[v*4+3]=domJ;
      W[v*4]=1;W[v*4+1]=0;W[v*4+2]=0;W[v*4+3]=0;
    }
  }
  return {J:J, W:W};
}
P3D.nearestBoneSegmentSkin = nearestBoneSegmentSkin;

// rigid(1ボーン100%ウェイト)スキニング
function rigidSkin(V, bone){
  var n=V.length/3;
  var J=new Uint16Array(n*4), W=new Float32Array(n*4);
  var bi = P3D.BIDX[bone] !== undefined ? P3D.BIDX[bone] : P3D.BIDX['head'];
  for(var v=0;v<n;v++){ J[v*4]=bi; W[v*4]=1.0; }
  return {J:J, W:W};
}
P3D.rigidSkin = rigidSkin;

})(window);
