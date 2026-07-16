// -*- coding: utf-8 -*-
// pipeline_lib/carving.py の carve_region() のJS移植(3DtoolJS)。
// Python版はnumpyのブロードキャストで(nx,nz)全域に対して行/セグメントごとに
// 疑似SDFを書き込むが、JSは素朴なループになるため、影響が及ぶ範囲(セグメントの
// 半幅/半奥行きのbound_factor倍以内)だけを更新するローカルbbox最適化を入れて
// 実用的な速度にする(結果は数式的に同一、計算を省くだけ)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};
var Common = P3D; // common.jsの関数はP3D直下にあるので、そのままローカル別名として使う
var EPS = 1e-4;

function intersectIntervals(runs, allowed){
  if(!allowed || !allowed.length) return runs;
  var out=[];
  for(var i=0;i<runs.length;i++){
    var a0=runs[i][0], a1=runs[i][1];
    for(var j=0;j<allowed.length;j++){
      var b0=allowed[j][0], b1=allowed[j][1];
      var lo=Math.max(a0,b0), hi=Math.min(a1,b1);
      if(hi>lo) out.push([lo,hi]);
    }
  }
  return out;
}

// 2本の区間リストの和集合(重なる/接する区間はマージする)。front/backそれぞれの
// runを「両方が一致した範囲だけ採用(積集合)」ではなく「どちらかにあれば採用
// (和集合)」に使う。マフラーや髪の毛のように front/back で重なり方が違う絵柄は、
// 積集合だとその重なった部分だけ幅が削れて本体に穴が空く(引き算になってしまう)。
function unionIntervals(a, b){
  var all=a.concat(b);
  if(!all.length) return [];
  all.sort(function(p,q){ return p[0]-q[0]; });
  var out=[[all[0][0], all[0][1]]];
  for(var i=1;i<all.length;i++){
    var last=out[out.length-1];
    if(all[i][0]<=last[1]){ if(all[i][1]>last[1]) last[1]=all[i][1]; }
    else out.push([all[i][0], all[i][1]]);
  }
  return out;
}

// V:Float32Array(N*3), F:Uint32Array(M*3) -> 最大連結成分に対しminFrac未満の
// 断片を除去(union-find)。extraVertArrays: {name: TypedArray(N個、頂点ごとに
// 1個の値)}を渡すと、Vと同じ頂点remapを適用した結果をextra.<name>として
// 返す(★2026-07-10: marching_cubesのvertOwnerのような頂点並行配列を、
// 頂点の生き残り/並び替えに追従させるため)。
function dropSmallFragments(V, F, minFrac, extraVertArrays){
  minFrac = (minFrac===undefined)?0.05:minFrac;
  var n=V.length/3;
  var parent=new Int32Array(n); for(var i=0;i<n;i++)parent[i]=i;
  function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
  function union(a,b){ var ra=find(a),rb=find(b); if(ra!==rb) parent[ra]=rb; }
  var nf=F.length/3;
  for(var f=0;f<nf;f++){
    union(F[f*3],F[f*3+1]); union(F[f*3+1],F[f*3+2]);
  }
  var sizeMap=new Map();
  for(var v=0;v<n;v++){ var r=find(v); sizeMap.set(r,(sizeMap.get(r)||0)+1); }
  var maxSize=0; sizeMap.forEach(function(s){ if(s>maxSize)maxSize=s; });
  var keepRoots=new Set();
  sizeMap.forEach(function(s,r){ if(s>=maxSize*minFrac) keepRoots.add(r); });
  var keepVert=new Uint8Array(n);
  var allKept=true;
  for(var v2=0;v2<n;v2++){ var r2=find(v2); if(keepRoots.has(r2)){keepVert[v2]=1;} else allKept=false; }
  function remapExtra(remapArr, cnt2){
    if(!extraVertArrays) return undefined;
    var out={};
    Object.keys(extraVertArrays).forEach(function(name){
      var src=extraVertArrays[name];
      var Ctor=src.constructor;
      var dst=new Ctor(cnt2);
      for(var i=0;i<n;i++){ if(remapArr[i]>=0) dst[remapArr[i]]=src[i]; }
      out[name]=dst;
    });
    return out;
  }
  if(allKept) return {V:V,F:F,extra:extraVertArrays};
  var remap=new Int32Array(n).fill(-1);
  var cnt=0;
  for(var v3=0;v3<n;v3++){ if(keepVert[v3]){ remap[v3]=cnt++; } }
  var V2=new Float32Array(cnt*3);
  for(var v4=0;v4<n;v4++){ if(keepVert[v4]){ var ni=remap[v4]; V2[ni*3]=V[v4*3];V2[ni*3+1]=V[v4*3+1];V2[ni*3+2]=V[v4*3+2]; } }
  var faceOut=[];
  for(var f2=0;f2<nf;f2++){
    var a=F[f2*3],b=F[f2*3+1],c=F[f2*3+2];
    if(keepVert[a]&&keepVert[b]&&keepVert[c]){ faceOut.push(remap[a],remap[b],remap[c]); }
  }
  return {V:V2, F:Uint32Array.from(faceOut), extra:remapExtra(remap, cnt)};
}
P3D.dropSmallFragments = dropSmallFragments;

// 頂点間引き(carving.py _decimate相当)。Python版はtrimesh+fast_simplification
// のquadric error decimationを使うが、ブラウザ版はthree.js examples付属の
// SimplifyModifier(同じくquadric error簡略化のedge collapse実装)を使う。
// ★2026-07-04〜07-12の経緯(SIMPLIFY_DECIMATE_PLAN.md参照): SimplifyModifierは
// 頂点数が数万を大きく超える巨大メッシュで"Cannot read properties of
// undefined (reading 'hasVertex')"を投げて不安定になる不具合があり、体+全
// アクセサリー統合メッシュ(実測163,982頂点)は常にgridClusterDecimate(曲率を
// 見ない機械的な頂点クラスタリング)にフォールバックしていた。2026-07-12、
// js/vendor/SimplifyModifier.jsのクラッシュの直接原因(mergeVertices後に残る
// 縮退三角形を半エッジ構造の構築前に除外していなかったこと)を実サンプルの
// ログ計測で特定・修正し、あわせてminimumCostEdgeの二分ヒープ化(O(n)→
// O(log n))で実用的な速度にした(163,982頂点→10,000頂点相当の間引きが
// 約190秒→約95秒に短縮)。実機で163,982頂点の完走・結果メッシュの健全性
// (縮退三角形/NaN無し)を確認したため、頂点数によるフォールバック
// (旧SIMPLIFY_SAFE_LIMIT)を廃止し、SimplifyModifierを常に試す唯一の間引き
// 経路にした。gridClusterDecimateは「万一SimplifyModifierが例外を投げた
// 場合」だけの最終フォールバックとして残す。

// 頂点クラスタリングによる間引き(Rossignac&Borrel方式の簡易版、非常時の
// フォールバック専用)。バウンディングボックスを立方体グリッドに分割し、
// 同じセルに落ちる頂点をその重心1点にまとめる。quadric error decimationより
// 形状精度が落ちるが、edge collapseのような複雑な半エッジ構造を作らないため
// 頂点数に関わらず必ず動作する。
// ★2026-07-11〜12: 体+アクセサリー統合間引きでこの関数が主経路になっていた
// 間、パーツの境目凍結・パーツ別セルサイズという複雑化を行っていた(コミット
// 33feffd)。2026-07-12にSimplifyModifier側の根本原因を修正して唯一の主経路に
// 戻したことで、この関数はSimplifyModifierが例外を投げた場合だけの非常時
// フォールバックに戻ったため、発動頻度の低さに複雑化の維持コストが見合わなく
// なり、単一セルサイズの元の方式に戻した(ユーザー承認済み、
// SIMPLIFY_DECIMATE_PLAN.md「5. gridClusterDecimateの扱い」参照)。
// owner(頂点ごとの所属パーツID、Int32Array)を渡すと、同じセルに集約される
// 頂点群の多数決(同数ならownerId昇順を優先する決定的なタイブレーク)でセルの
// 代表ownerを決め、間引き後の頂点にもowner配列を付けて返す(未指定時は従来
// 通り{V,F}のみ)。
function gridClusterDecimate(V, F, targetVerts, owner){
  var n = V.length/3;
  var lo=[Infinity,Infinity,Infinity], hi=[-Infinity,-Infinity,-Infinity];
  for(var i=0;i<n;i++){
    for(var a=0;a<3;a++){ var x=V[i*3+a]; if(x<lo[a])lo[a]=x; if(x>hi[a])hi[a]=x; }
  }
  var dx=Math.max(hi[0]-lo[0],1e-6), dy=Math.max(hi[1]-lo[1],1e-6), dz=Math.max(hi[2]-lo[2],1e-6);
  var surfaceArea = 2*(dx*dy+dy*dz+dz*dx);
  var cs = Math.sqrt(surfaceArea/Math.max(4,targetVerts));
  if(!isFinite(cs) || cs<=0) cs = Math.max(dx,dy,dz)/64;

  function cellKey(x,y,z){
    var ix=Math.floor((x-lo[0])/cs), iy=Math.floor((y-lo[1])/cs), iz=Math.floor((z-lo[2])/cs);
    return ix+","+iy+","+iz;
  }
  var cellMap = new Map();
  for(var v=0;v<n;v++){
    var x2=V[v*3],y2=V[v*3+1],z2=V[v*3+2];
    var key = cellKey(x2,y2,z2);
    var c = cellMap.get(key);
    if(!c){ c={sx:0,sy:0,sz:0,count:0,idx:-1,ownerVotes:owner?new Map():null}; cellMap.set(key,c); }
    c.sx+=x2; c.sy+=y2; c.sz+=z2; c.count++;
    if(owner){ var ov2=owner[v]; c.ownerVotes.set(ov2, (c.ownerVotes.get(ov2)||0)+1); }
  }
  var newV = new Float32Array(cellMap.size*3);
  var newOwner = owner ? new Int32Array(cellMap.size) : null;
  var vi=0;
  cellMap.forEach(function(c){
    newV[vi*3]=c.sx/c.count; newV[vi*3+1]=c.sy/c.count; newV[vi*3+2]=c.sz/c.count;
    if(owner){
      var bestOwner=-1, bestCount=-1;
      c.ownerVotes.forEach(function(cnt, ownerId){
        if(cnt>bestCount || (cnt===bestCount && ownerId<bestOwner)){ bestCount=cnt; bestOwner=ownerId; }
      });
      newOwner[vi]=bestOwner;
    }
    c.idx=vi; vi++;
  });
  var remap = new Int32Array(n);
  for(var v3=0;v3<n;v3++){
    remap[v3] = cellMap.get(cellKey(V[v3*3],V[v3*3+1],V[v3*3+2])).idx;
  }
  var nf = F.length/3;
  var newFArr = [];
  for(var f=0;f<nf;f++){
    var a=remap[F[f*3]], b=remap[F[f*3+1]], c2=remap[F[f*3+2]];
    if(a===b||b===c2||a===c2) continue; // 縮退三角形(セル統合で潰れた面)を除去
    newFArr.push(a,b,c2);
  }
  return owner ? {V:newV, F:Uint32Array.from(newFArr), owner:newOwner} : {V:newV, F:Uint32Array.from(newFArr)};
}
P3D.gridClusterDecimate = gridClusterDecimate;

// three.js SimplifyModifierを使ったquadric error簡略化。失敗した場合は例外を
//投げる(呼び出し元decimateMesh()がgridClusterDecimateにフォールバックする)。
// ★2026-07-11追加(体+アクセサリー統合間引き対応): owner(頂点ごとの所属
// パーツID)を渡すと間引き後の頂点にもowner配列を付けて返す。
// ★2026-07-12追加(ユーザー指摘「ツインテールの造形が粗い、間引き前は綺麗
// だった」対応): 体+全アクセサリーを1つのメッシュとして一括で間引くと、
// 体よりずっと細いパーツ(房状の髪飾り等)が不釣り合いに粗くなる/穴が空く。
// 当初は「パーツ内部の辺の平均長」を相対スケールの目安にしようとしたが、
// この彫刻パイプラインは全パーツを同じボクセルグリッド(marching cubes)から
// 抽出するため、辺の長さはボクセルサイズにほぼ比例し、パーツの太さとは
// 無関係にどのパーツでもほぼ同じ値になってしまい、指標として機能しなかった
// (実測: 体と各アクセサリーの重みがどれも1.0〜1.04程度にしかならず、効果が
// 出なかった)。実際に効くのは「パーツ自身のバウンディングボックスの最小
// 辺」(=断面の細さの目安、房のように細長い形状ならこれが断面の太さに
// 近い)を体のそれと比較する方法で、細いパーツほど大きな重みになる。
var OWNER_WEIGHT_CAP = 12;
function computeOwnerScaleWeights(V, F, owner){
  if(!owner) return null;
  var minB=new Map(), maxB=new Map(); // ownerId -> [minX,minY,minZ]/[maxX,maxY,maxZ]
  var n=V.length/3;
  for(var i=0;i<n;i++){
    var oid=owner[i], x=V[i*3], y=V[i*3+1], z=V[i*3+2];
    var mn=minB.get(oid), mx=maxB.get(oid);
    if(!mn){ mn=[x,y,z]; minB.set(oid,mn); mx=[x,y,z]; maxB.set(oid,mx); }
    else{
      if(x<mn[0])mn[0]=x; if(y<mn[1])mn[1]=y; if(z<mn[2])mn[2]=z;
      if(x>mx[0])mx[0]=x; if(y>mx[1])mx[1]=y; if(z>mx[2])mx[2]=z;
    }
  }
  function minExtent(oid){
    var mn=minB.get(oid), mx=maxB.get(oid);
    return Math.min(mx[0]-mn[0], mx[1]-mn[1], mx[2]-mn[2]);
  }
  var bodyExtent = minB.has(0) ? minExtent(0) : null;
  if(!bodyExtent){
    // 体(owner=0)の頂点が無い(通常起こらない)場合は全パーツ中の最大値で代用する。
    bodyExtent = 0;
    minB.forEach(function(_,oid){ bodyExtent=Math.max(bodyExtent, minExtent(oid)); });
    if(!(bodyExtent>0)) bodyExtent=1;
  }
  var weightByOwner=new Map();
  minB.forEach(function(_,oid){
    var ext = minExtent(oid);
    var w = ext>0 ? bodyExtent/ext : OWNER_WEIGHT_CAP;
    weightByOwner.set(oid, Math.max(1, Math.min(OWNER_WEIGHT_CAP, w)));
  });
  var weights=new Float32Array(n);
  for(var i2=0;i2<n;i2++) weights[i2]=weightByOwner.get(owner[i2])||1;
  return weights;
}

// js/vendor/SimplifyModifier.jsのcollapse()は頂点位置を一切ブレンドせず、
// 生き残る頂点は必ず入力頂点のいずれかと完全に同じ座標になる(統合彫刻の
// marching cubes直後の入力は重複座標を持たない=1頂点1ownerが保証されている)
// ため、座標一致だけで曖昧さ無くownerを復元できる(nearest-neighbor探索は
// 不要)。
// ★2026-07-12改変: targetVerts(目標頂点数)ではなくmaxCost(許容誤差の上限、
// js/vendor/SimplifyModifier.jsのcomputeEdgeCollapseCostと同じスケール)を
// 受け取るように変更した(SIMPLIFY_DECIMATE_PLAN.md「4. UIの再設計」)。
// countは間引きが際限なく続かないための安全上限であって目標ではない
// (実際にどこで止まるかはmaxCostが決める)。
// ★2026-07-19追加(スパイク対策、SPIKE_INVESTIGATION参照): spikeGuardMax
// (省略可、0/未指定で無効)は1頂点が吸収してよい間引き回数の上限
// (js/vendor/SimplifyModifier.jsのabsorbCount/_spikeGuardCap参照)。
function simplifyModifierDecimate(V, F, maxCost, owner, spikeGuardMax){
  if(!(maxCost>0)) return owner ? {V:V,F:F,owner:owner} : {V:V,F:F};
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(V), 3));
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(F), 1));
  var curVerts = V.length/3;
  var safeCount = Math.max(0, curVerts-4); // 安全上限。実際の停止点はmaxCostが決める
  var modifier = new THREE.SimplifyModifier();
  var ownerWeights = computeOwnerScaleWeights(V, F, owner);
  var simplified = modifier.modify(geo, safeCount, ownerWeights, maxCost, spikeGuardMax);
  var pos = simplified.attributes.position.array;
  var idxAttr = simplified.index;
  var nTri, rawF;
  if(idxAttr){
    rawF = idxAttr.array;
    nTri = rawF.length/3;
  }else{
    // 非indexed(三角形ごとに3頂点独立)の場合はそのままtriple-index化
    nTri = pos.length/9;
    rawF = new Uint32Array(nTri*3);
    for(var i=0;i<nTri*3;i++) rawF[i]=i;
  }
  // 位置ベースで頂点を再統合(同一メッシュ頂点が別indexに重複して出力される
  // 場合があるため、出力頂点数を本当に間引いた分だけに戻す)
  var posN = pos.length/3;
  var key2idx = new Map();
  var newV = [];
  var remap = new Int32Array(posN);
  for(var v=0; v<posN; v++){
    var x=pos[v*3], y=pos[v*3+1], z=pos[v*3+2];
    var key = x.toFixed(6)+"_"+y.toFixed(6)+"_"+z.toFixed(6);
    var ni = key2idx.get(key);
    if(ni===undefined){ ni=newV.length/3; newV.push(x,y,z); key2idx.set(key,ni); }
    remap[v]=ni;
  }
  var newF = new Uint32Array(rawF.length);
  for(var i2=0;i2<rawF.length;i2++) newF[i2]=remap[rawF[i2]];
  var V2=Float32Array.from(newV);
  if(V2.length/3 < 4 || newF.length < 12){
    throw new Error("簡略化結果が不正(頂点/面数が少なすぎる)");
  }
  if(!owner) return {V:V2, F:newF};
  var origKey2Owner = new Map();
  var origN = V.length/3;
  for(var ov=0; ov<origN; ov++){
    var okey = V[ov*3].toFixed(6)+"_"+V[ov*3+1].toFixed(6)+"_"+V[ov*3+2].toFixed(6);
    if(!origKey2Owner.has(okey)) origKey2Owner.set(okey, owner[ov]);
  }
  var newOwner = new Int32Array(V2.length/3);
  for(var nv=0; nv<newOwner.length; nv++){
    var nkey = V2[nv*3].toFixed(6)+"_"+V2[nv*3+1].toFixed(6)+"_"+V2[nv*3+2].toFixed(6);
    var oid = origKey2Owner.get(nkey);
    newOwner[nv] = (oid===undefined) ? 0 : oid; // 見つからない場合のみ安全側(body)に倒す
  }
  return {V:V2, F:newF, owner:newOwner};
}

// モデル全体のバウンディングボックス対角線長。「間引きの強さ」を絶対誤差では
// なくモデルの大きさに対する相対値に変換するための基準スケール(体格差の
// 異なるキャラクターで同じ強さ設定の効き方が変わらないようにする、
// SIMPLIFY_DECIMATE_PLAN.md「4. UIの再設計」参照)。
function meshBBoxDiag(V){
  var n=V.length/3;
  var lo=[Infinity,Infinity,Infinity], hi=[-Infinity,-Infinity,-Infinity];
  for(var i=0;i<n;i++){
    for(var a=0;a<3;a++){ var x=V[i*3+a]; if(x<lo[a])lo[a]=x; if(x>hi[a])hi[a]=x; }
  }
  return Math.hypot(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]);
}

// 「間引きの強さ」(0〜1)→SimplifyModifierのmaxCostへの変換。実サンプル
// (体+全アクセサリー統合、163,982頂点)でcollapseCostの実測分布(間引き
// 開始直後は約diag×1.4e-6、94%間引いた時点で約diag×2.4e-3)を基に、
// 指数的にmaxCostが増えるようにした(strength=0でほぼ無効化、strength=1で
// このサンプルなら約95%間引く強い設定になる)。
var DECIMATE_STRENGTH_EXP_MIN = -6, DECIMATE_STRENGTH_EXP_RANGE = 3.5;
function strengthToMaxCost(strength, V){
  var s = Math.min(1, Math.max(0, strength||0));
  if(s<=0) return 0;
  var diag = meshBBoxDiag(V);
  return diag * Math.pow(10, DECIMATE_STRENGTH_EXP_MIN + DECIMATE_STRENGTH_EXP_RANGE*s);
}
P3D.strengthToMaxCost = strengthToMaxCost;

// 「間引きの強さ」→「だいたい何%頂点が減るか」の目安(概算)。実際の削減率は
// メッシュの形状(平らな面が多いか、細かい凹凸が多いか)に強く依存し、厳密な
// 計算にはメッシュ全体の間引きを実行する必要があるため、これは正確な予測では
// ない。このセッション中の実測(strength=0.85で約85〜92%削減)と、
// strengthToMaxCostのコメントにある実測(strength=1で約95%削減)を通る
// べき乗カーブで補間した「雰囲気」の目安。生成前のUIで間引き後の頂点数感を
// 大まかに掴むためだけに使う。
function approxDecimateReductionPct(strength){
  var s = Math.min(1, Math.max(0, strength||0));
  if(s<=0) return 0;
  return 95 * Math.pow(s, 0.683);
}
P3D.approxDecimateReductionPct = approxDecimateReductionPct;

// gridClusterDecimate(非常時フォールバック)はセルサイズ方式のため誤差閾値を
// 直接扱えない。「強さ」から目安の目標頂点数を作る簡易な換算式を別途用意する
// (フォールバックは非常時のみ発動する想定のため、strengthToMaxCostほど
// 厳密な対応関係は求めない)。
function strengthToFallbackTargetVerts(strength, curVerts){
  var s = Math.min(1, Math.max(0, strength||0));
  var t = Math.round(curVerts * Math.pow(1-s, 2));
  return Math.max(500, Math.min(curVerts, t));
}

// V:Float32Array(N*3), F:Uint32Array(M*3), strength: 間引きの強さ(0〜1、
// 0で間引き無効/1で最も強く間引く。SimplifyModifierのmaxCostに変換して使う。
// SIMPLIFY_DECIMATE_PLAN.md「4. UIの再設計」参照)。
// owner: 省略可、Int32Array(N) 頂点ごとの所属パーツID
// 戻り値: {V,F}(ownerを渡した場合は{V,F,owner}。SimplifyModifierが例外を
// 投げた場合のみgridClusterDecimateにフォールバックする)
// ★2026-07-11追加: ownerを通すことで、体+全アクセサリーを1つの連続した
// メッシュのまま間引ける(パーツ分割はこの後の平滑化まで終えてから行う。
// js/pipeline.jsのdecimateStage/meshFinishStage参照)。
// ★2026-07-19追加: spikeGuardMax(省略可、0/未指定で無効)はsimplifyModifierDecimate
// にそのまま渡す(gridClusterDecimateフォールバックには効かない。あちらは
// セルクラスタリング方式でそもそも1頂点吸収集中が起きないため対象外)。
function decimateMesh(V, F, strength, owner, spikeGuardMax){
  if(!(strength>0)) return owner ? {V:V, F:F, owner:owner} : {V:V, F:F};
  var curVerts = V.length/3;
  if(typeof THREE !== "undefined" && THREE.SimplifyModifier){
    try{
      var maxCost = strengthToMaxCost(strength, V);
      return simplifyModifierDecimate(V, F, maxCost, owner, spikeGuardMax);
    }catch(e){
      console.warn("  decimateMesh: SimplifyModifierに失敗、頂点クラスタリングにフォールバックします:", e);
    }
  }else{
    console.warn("  decimateMesh: THREE.SimplifyModifier未読み込み、頂点クラスタリングを使用します");
  }
  return gridClusterDecimate(V, F, strengthToFallbackTargetVerts(strength, curVerts), owner);
}
P3D.decimateMesh = decimateMesh;

// HC-Laplacian平滑化(Vollmer et al. 1999)。carving.pyの_laplacian_smooth移植。
function laplacianSmooth(V, F, iters, alpha, beta){
  alpha = (alpha===undefined)?0.1:alpha; beta=(beta===undefined)?0.6:beta;
  var n=V.length/3, nf=F.length/3;
  var deg=new Float32Array(n);
  // 隣接リスト(重複込みでOK、Python版もnp.add.atで重複エッジをそのまま加算している)
  var adjIdx=[]; // 各頂点の隣接頂点index配列
  for(var i=0;i<n;i++) adjIdx.push([]);
  for(var f=0;f<nf;f++){
    var a=F[f*3],b=F[f*3+1],c=F[f*3+2];
    adjIdx[a].push(b); adjIdx[b].push(c); adjIdx[c].push(a);
    adjIdx[b].push(a); adjIdx[c].push(b); adjIdx[a].push(c);
  }
  for(var v=0;v<n;v++) deg[v]=adjIdx[v].length || 1;
  function neighborAvg(X, out){
    for(var v2=0; v2<n; v2++){
      var sx=0,sy=0,sz=0, nb=adjIdx[v2];
      for(var k=0;k<nb.length;k++){ var j=nb[k]*3; sx+=X[j];sy+=X[j+1];sz+=X[j+2]; }
      var d=deg[v2];
      out[v2*3]=sx/d; out[v2*3+1]=sy/d; out[v2*3+2]=sz/d;
    }
  }
  var Vo=Float32Array.from(V);
  var Vc=Float32Array.from(V);
  var Vn=new Float32Array(n*3), B=new Float32Array(n*3), Bavg=new Float32Array(n*3);
  for(var it=0; it<iters; it++){
    neighborAvg(Vc, Vn);
    for(var i2=0;i2<n*3;i2++) B[i2]=Vn[i2]-(alpha*Vo[i2]+(1.0-alpha)*Vc[i2]);
    neighborAvg(B, Bavg);
    for(var i3=0;i3<n*3;i3++) Vc[i3]=Vn[i3]-(beta*B[i3]+(1.0-beta)*Bavg[i3]);
  }
  return Vc;
}
P3D.laplacianSmooth = laplacianSmooth;

// ★2026-07-10(ユーザー指摘「体に隙間が空く」対応): HC-Laplacianは通常の
// Laplacian平滑化より縮小を抑える設計だが、完全にはゼロにならない(反復回数
// が多いほど輪郭が内側に丸まって縮む)。体本体とアクセサリーは別々の
// タイミング・別々の反復回数(body_smooth_iters/acc_smooth_iters)・別々の
// ボクセル解像度(body_vox/acc_vox)で彫刻・平滑化されるため、この残留縮小率が
// 双方で食い違うと、本来は同じ元絵のシルエットに沿って接していたはずの面同士
// (体とアクセサリーの境界)に隙間が空く。彫刻直後の生メッシュ(平滑化前)と
// 平滑化後のメッシュの軸ごとのバウンディングボックスを比較し、平滑化後の
// メッシュを軸ごとに原点(中心)基準でリスケールして平滑化前と同じ外寸に
// 戻すことで、「境界のガタつき(角ばり)」だけを削り、輪郭が丸まることによる
// 実質的なサイズの縮小(=隙間の原因)は打ち消す。
function restoreExtentAfterSmooth(Vsmoothed, Voriginal){
  var n = Vsmoothed.length/3;
  var lo0=[Infinity,Infinity,Infinity], hi0=[-Infinity,-Infinity,-Infinity];
  var lo1=[Infinity,Infinity,Infinity], hi1=[-Infinity,-Infinity,-Infinity];
  for(var i=0;i<n;i++){
    for(var a=0;a<3;a++){
      var o=Voriginal[i*3+a], s=Vsmoothed[i*3+a];
      if(o<lo0[a])lo0[a]=o; if(o>hi0[a])hi0[a]=o;
      if(s<lo1[a])lo1[a]=s; if(s>hi1[a])hi1[a]=s;
    }
  }
  var out=new Float32Array(Vsmoothed.length);
  for(var a2=0;a2<3;a2++){
    var span0=hi0[a2]-lo0[a2], span1=hi1[a2]-lo1[a2];
    // span1がほぼ0(退化したメッシュ)ならスケール補正をかけない(1.0=そのまま)。
    var scale=(span1>1e-9)?(span0/span1):1.0;
    var c1=(lo1[a2]+hi1[a2])/2, c0=(lo0[a2]+hi0[a2])/2;
    for(var i2=0;i2<n;i2++){
      out[i2*3+a2] = (Vsmoothed[i2*3+a2]-c1)*scale + c0;
    }
  }
  return out;
}
function laplacianSmoothPreserveExtent(V, F, iters, alpha, beta){
  var Vs = laplacianSmooth(V, F, iters, alpha, beta);
  return restoreExtentAfterSmooth(Vs, V);
}
P3D.laplacianSmoothPreserveExtent = laplacianSmoothPreserveExtent;

// 面法線から頂点法線を再計算し、符号付き体積で外向きか判定して巻きを補正する。
// ★2026-07-10: 全身シルエットの黒(体色)一致判定により、体が複数の独立した
// 閉曲面(頭部/胴体/脚等)に分かれることがある(js/pipeline.js/js/common.js
// のclassifySilhouetteRaw参照)。以前は符号付き体積をメッシュ全体で1回だけ
// 計算していたため、最大の成分(胴体)の符号に引きずられ、marching cubesが
// たまたま逆巻きで生成した小さい成分(頭部等)の法線が直らないまま裏返り、
// バックフェイスカリングでその部分が透けて見える(または消えて見える)
// 不具合があった。連結成分(面の頂点共有によるunion-find)ごとに符号付き
// 体積を判定し、成分単位で巻きを補正する。
function computeNormalsFixWinding(V, F){
  var n=V.length/3, nf=F.length/3;
  function faceCross(ia,ib,ic){
    var ax=V[ia*3],ay=V[ia*3+1],az=V[ia*3+2];
    var bx=V[ib*3],by=V[ib*3+1],bz=V[ib*3+2];
    var cx=V[ic*3],cy=V[ic*3+1],cz=V[ic*3+2];
    var ux=bx-ax, uy=by-ay, uz=bz-az;
    var wx=cx-ax, wy=cy-ay, wz=cz-az;
    return { nx:uy*wz-uz*wy, ny:uz*wx-ux*wz, nz:ux*wy-uy*wx, ax:ax,ay:ay,az:az, bx:bx,by:by,bz:bz, cx:cx,cy:cy,cz:cz };
  }
  // 連結成分ごとにfaceインデックスをグルーピング(頂点共有ベース、union-find)。
  var parent=new Int32Array(n); for(var i=0;i<n;i++)parent[i]=i;
  function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
  function union(a,b){ var ra=find(a),rb=find(b); if(ra!==rb) parent[ra]=rb; }
  for(var f0=0;f0<nf;f0++){ union(F[f0*3],F[f0*3+1]); union(F[f0*3+1],F[f0*3+2]); }
  var compOfFace=new Int32Array(nf);
  var volOfComp=new Map();
  for(var f1=0;f1<nf;f1++){
    var root=find(F[f1*3]);
    compOfFace[f1]=root;
    var c=faceCross(F[f1*3],F[f1*3+1],F[f1*3+2]);
    var cxv=c.by*c.cz-c.bz*c.cy, cyv=c.bz*c.cx-c.bx*c.cz, czv=c.bx*c.cy-c.by*c.cx;
    var contrib=(c.ax*cxv+c.ay*cyv+c.az*czv)/6.0;
    volOfComp.set(root, (volOfComp.get(root)||0)+contrib);
  }
  // 成分の符号付き体積が負(=内向き巻き)なら、その成分に属する面だけ巻きを反転する。
  var F2=new Uint32Array(F.length);
  for(var f2=0;f2<nf;f2++){
    var root2=compOfFace[f2];
    var flip=(volOfComp.get(root2)||0)<0;
    if(flip){ F2[f2*3]=F[f2*3]; F2[f2*3+1]=F[f2*3+2]; F2[f2*3+2]=F[f2*3+1]; }
    else{ F2[f2*3]=F[f2*3]; F2[f2*3+1]=F[f2*3+1]; F2[f2*3+2]=F[f2*3+2]; }
  }
  var Nv=new Float32Array(n*3);
  for(var f3=0;f3<nf;f3++){
    var ia=F2[f3*3],ib=F2[f3*3+1],ic=F2[f3*3+2];
    var c2=faceCross(ia,ib,ic);
    Nv[ia*3]+=c2.nx;Nv[ia*3+1]+=c2.ny;Nv[ia*3+2]+=c2.nz;
    Nv[ib*3]+=c2.nx;Nv[ib*3+1]+=c2.ny;Nv[ib*3+2]+=c2.nz;
    Nv[ic*3]+=c2.nx;Nv[ic*3+1]+=c2.ny;Nv[ic*3+2]+=c2.nz;
  }
  for(var v=0;v<n;v++){
    var x=Nv[v*3],y=Nv[v*3+1],z=Nv[v*3+2];
    var len=Math.sqrt(x*x+y*y+z*z)+1e-9;
    Nv[v*3]=x/len;Nv[v*3+1]=y/len;Nv[v*3+2]=z/len;
  }
  return {N:Nv, F:F2};
}
P3D.computeNormalsFixWinding = computeNormalsFixWinding;

// (旧findArmCrossings: 行ごとの骨線分X交点方式は削除。腕の太さの測定は
// carveRegion内のbuildBoneProfiles(列ごとのy方向走査)に置き換えた。)

// ★2026-07-10(ユーザー指摘「前髪がぐちゃぐちゃ」対応): front画像とback画像
// (mirroring済み)を1枚の前景ラスタに合成する。carveRegion内の行ごとの
// unionIntervals(fr,br)と数式的に同じ変換(back画像のpx座標→front座標系)を
// 画素単位・全行に対して行う。既存のfy/byBack(行ごとの整数pxオフセット)は
// vox解像度でサンプリングされた一部の行にしか定義されないため、ここでは
// carveRegion内のfy/byBack導出元の式(YBOT-my*SCALE(+backOffsetY))を
// 逆算し、任意のfront行fyに対応するback行を直接 fy+backOffsetY として
// 導出する(この2つは同じ点をfront/back双方の基準で表しているだけなので、
// 定数オフセットの関係になる)。
function buildCombinedFrontRaster(fa, ba, faW, faH, backOffsetX, backOffsetY){
  var out = new Uint8Array(faW*faH);
  var boY = Math.round(backOffsetY||0), boX = Math.round(backOffsetX||0);
  for(var fy=0; fy<faH; fy++){
    var by = fy + boY;
    var byOk = (by>=0 && by<faH);
    var rowOff = fy*faW, byOff = by*faW;
    for(var fx=0; fx<faW; fx++){
      var v = fa[rowOff+fx];
      if(!v && byOk){
        var bx = faW - fx + boX;
        if(bx>=0 && bx<faW) v = ba[byOff+bx];
      }
      out[rowOff+fx] = v?1:0;
    }
  }
  return out;
}

// 2値ラスタ(W*H)の8連結成分ラベリング(Union-Find)。戻り値はInt32Array(W*H)
// で、背景=-1、前景は各連結成分の代表pixel indexをラベルIDとして持つ。
// ★2026-07-10: 従来のbuildWidthTracksは行→行の距離ベース貪欲マッチングで
// track(房)を追跡していたため、房が画像上で交差/接近すると別の房のtrackを
// 誤って繋いでしまい、ねじれた/破綻した形状になっていた(特に前髪で顕著)。
// 実際にピクセルが繋がっている範囲だけを同一の塊とみなす連結成分ラベリング
// は、しきい値・推定に依存しない厳密な位相判定であり、この誤結合を構造的に
// 排除する。
function labelConnectedComponents(mask, W, H){
  var n = W*H;
  var parent = new Int32Array(n);
  for(var i=0;i<n;i++) parent[i]=i;
  function find(x){ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; }
  function union(a,b){ var ra=find(a),rb=find(b); if(ra!==rb) parent[ra]=rb; }
  for(var y=0;y<H;y++){
    var rowOff=y*W;
    for(var x=0;x<W;x++){
      var idx=rowOff+x;
      if(!mask[idx]) continue;
      if(x>0 && mask[idx-1]) union(idx, idx-1);
      if(y>0){
        var upOff=idx-W;
        if(mask[upOff]) union(idx, upOff);
        if(x>0 && mask[upOff-1]) union(idx, upOff-1);
        if(x<W-1 && mask[upOff+1]) union(idx, upOff+1);
      }
    }
  }
  var labels=new Int32Array(n).fill(-1);
  for(var i2=0;i2<n;i2++){ if(mask[i2]) labels[i2]=find(i2); }
  return labels;
}
P3D.buildCombinedFrontRaster = buildCombinedFrontRaster;
P3D.labelConnectedComponents = labelConnectedComponents;

// linspace(min,max,n)相当(n>=2前提、Python np.linspaceと同じ: 端点を含みn-1等分)
function linspace(a,b,n){
  var out=new Float64Array(n);
  if(n===1){ out[0]=a; return out; }
  var step=(b-a)/(n-1);
  for(var i=0;i<n;i++) out[i]=a+step*i;
  return out;
}
P3D.linspace = linspace;

// ★2026-07-10(体+アクセサリー統合彫刻対応): 体とアクセサリーを別々の
// ボクセルグリッドで独立に彫っていたことが、隙間(パーツ間の接合不整合)の
// 主因の一つだった(体色以外の画素は最初から体シルエットに含めない設計の
// ため、体とアクセサリーの境界は「たまたま同じ輪郭線から彫られていれば
// 大体合う」程度の保証しかなかった)。体+全アクセサリーの外接範囲を1つの
// 共有グリッド(buildGrid)にまとめ、carveRegion側はこのグリッドへ蓄積彫刻
// する(carveUnifiedRegions参照)ことで、彫刻段階そのものでは接合不整合が
// 原理的に起きなくなる。
// ★2026-07-14追加(ユーザー指摘「横方向は490頂点も要らない。丸みは数式で
// 合成してるだけだから細かく作る必要ない。縦方向は画像の実測値だから重要」):
// 縦(Y、高さ方向)と横/奥行き(X・Z)で別々の解像度を持てるようにした。
// Y方向の行位置(iy)はfront/side/back画像の実ピクセル行をそのままサンプル
// するため実測データそのものだが、各行のX/Z断面はcarveSdfField内で
// Math.pow(Math.abs(xv-cx2)/hw3, rowPsq)というなめらかな数式(superellipse)
// で合成しているだけなので、細かく刻んでも滑らかな曲線を無駄に高頻度で
// 標本化するだけで実質的な情報は増えない。voxXZ(X・Z軸)をvoxY(Y軸)より
// 粗くすることで、頂点数・メモリを大きく減らせる(js/pipeline.jsの
// runCarvingStages、js/common.jsのbody_vox/body_vox_xz参照)。
// voxY省略時はvoxXZと同じ値を使う(後方互換)。
function buildGrid(mxBounds, myBounds, mzBounds, voxXZ, voxY){
  if(voxY===undefined || voxY===null) voxY=voxXZ;
  var mxMin=mxBounds[0],mxMax=mxBounds[1], myMin=myBounds[0],myMax=myBounds[1], mzMin=mzBounds[0],mzMax=mzBounds[1];
  var nx=Math.max(Math.round((mxMax-mxMin)/voxXZ),4);
  var ny=Math.max(Math.round((myMax-myMin)/voxY),4);
  var nz=Math.max(Math.round((mzMax-mzMin)/voxXZ),4);
  var mx=linspace(mxMin,mxMax,nx), my=linspace(myMin,myMax,ny), mz=linspace(mzMin,mzMax,nz);
  return {mx:mx,my:my,mz:mz,nx:nx,ny:ny,nz:nz,
    mxMin:mxMin,mxMax:mxMax,myMin:myMin,myMax:myMax,mzMin:mzMin,mzMax:mzMax};
}
P3D.buildGrid = buildGrid;

/**
 * carve_region()のJS移植。
 * opts: {
 *   fa,ba,sa: Uint8Array(w*h) 2値シルエット(front/back/side、1=前景)
 *   faW,faH: front/backの画像サイズ(back/frontは同サイズ前提, side別サイズ)
 *   saW,saH: side画像のサイズ
 *   faCont,baCont,saCont: 連続値配列(Float32Array、サブピクセル補正用、無ければnull)
 *   SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF: キャリブレーション値
 *   mxBounds,myBounds,mzBounds: [min,max]
 *   vox, smoothIters
 *   psqHead,psqTorso,psqLegs,psqArms,psqHands: 部位別の断面スーパー楕円指数
 *     (neckY/hipsYで行(myv)がどの部位相当かを判定してpsqHead/psqTorso/psqLegs
 *     を使い分ける。neckY/hipsY省略時は常にpsqTorsoを使う=アクセサリー等の
 *     部位分けが不要な呼び出し元はpsqHead/psqTorso/psqLegs/psqArms/psqHandsに
 *     同じ値を渡せばよい)
 *   neckY,hipsY: 頭/胴体、胴体/脚の境界となるモデル座標y(省略可)
 *   armLines: [[[x0,y0],[x1,y1]],...] | null (肩→肘→手首の骨線分。腕の円形断面用)
 *   armMaxHw: 腕とみなす断面半径(傾き補正後)の上限
 *   handLines: [[[x0,y0],[x1,y1]],...] | null (手首→指先方向の線分。手の押し出し用)
 *   handDepthHw: 手の押し出しの半奥行き(model単位)
 *   handMaxHw: 手とみなす縦半幅の上限
 *   whiteThr
 * }
 * 戻り値: {V,N,F} (Float32Array/Uint32Array) または null(彫れなかった場合)
 */
function carveRegion(opts){
  var fa=opts.fa, ba=opts.ba, sa=opts.sa;
  var faW=opts.faW, faH=opts.faH, saW=opts.saW, saH=opts.saH;
  var faCont=opts.faCont, baCont=opts.baCont, saCont=opts.saCont;
  var SCALE=opts.SCALE, CX=opts.CX, YBOT=opts.YBOT, SYTOP=opts.SYTOP, SYBOT=opts.SYBOT, SIDE_REF=opts.SIDE_REF;
  var mxB=opts.mxBounds, myB=opts.myBounds, mzB=opts.mzBounds;
  var vox=opts.vox;
  var psqHead=opts.psqHead, psqTorso=opts.psqTorso, psqLegs=opts.psqLegs;
  var psqArms=opts.psqArms, psqHands=opts.psqHands;
  var neckY=opts.neckY, hipsY=opts.hipsY;
  // 行の高さ(myv)から部位を判定して該当する指数を返す。neckY/hipsYが
  // 渡されない呼び出し(アクセサリー等)は常にpsqTorsoを使う。
  function regionPsq(myv){
    if(neckY!=null && myv>neckY) return psqHead;
    if(hipsY!=null && myv<hipsY) return psqLegs;
    return psqTorso;
  }
  var smoothIters=opts.smoothIters||0;
  var armLines=opts.armLines||null, armMaxHw=opts.armMaxHw||0.07;
  var handLines=opts.handLines||null, handDepthHw=opts.handDepthHw||0.02, handMaxHw=opts.handMaxHw||0.06;
  var whiteThr=opts.whiteThr!==undefined?opts.whiteThr:250;
  // ★2026-07-05: 背面/側面写真は前面基準のCX/SCALE/YBOT等を鏡像/流用して
  // 変換しているため、素材ごとの微妙なズレが残ることがある。自動推定は
  // 後れ毛等のノイズを拾って暴れるため、ユーザーが見た目で追い込める単純な
  // 定数pxオフセットとして受け取る(既定0=補正なし)。
  var backOffsetX=opts.backOffsetX||0, backOffsetY=opts.backOffsetY||0;
  var sideOffsetX=opts.sideOffsetX||0, sideOffsetY=opts.sideOffsetY||0;

  // ★2026-07-10(体+アクセサリー統合彫刻対応): opts.gridで共有グリッド
  // (buildGrid参照)が渡された場合はそれをそのまま使い、この呼び出し
  // (1パーツ分)専用のグリッドを新たに割り付けない。未指定時(単体呼び出し、
  // 後方互換用)は従来通りmxBounds/myBounds/mzBounds/voxから自前で作る。
  var grid = opts.grid;
  var mxMin,mxMax,myMin,myMax,mzMin,mzMax,nx,ny,nz,mx,my,mz;
  if(grid){
    mxMin=grid.mxMin;mxMax=grid.mxMax;myMin=grid.myMin;myMax=grid.myMax;mzMin=grid.mzMin;mzMax=grid.mzMax;
    nx=grid.nx;ny=grid.ny;nz=grid.nz;mx=grid.mx;my=grid.my;mz=grid.mz;
  }else{
    mxMin=mxB[0];mxMax=mxB[1];myMin=myB[0];myMax=myB[1];mzMin=mzB[0];mzMax=mzB[1];
    nx=Math.max(Math.round((mxMax-mxMin)/vox),4);
    ny=Math.max(Math.round((myMax-myMin)/vox),4);
    nz=Math.max(Math.round((mzMax-mzMin)/vox),4);
    mx=linspace(mxMin,mxMax,nx); my=linspace(myMin,myMax,ny); mz=linspace(mzMin,mzMax,nz);
  }

  function rowOf1d(arr, w, y){ return arr.subarray(y*w, y*w+w); }

  var fy=new Int32Array(ny), byBack=new Int32Array(ny), spy=new Int32Array(ny);
  for(var iy0=0;iy0<ny;iy0++){
    fy[iy0]=Math.min(Math.max(Math.round(YBOT-my[iy0]*SCALE),0),faH-1);
    byBack[iy0]=Math.min(Math.max(Math.round(YBOT-my[iy0]*SCALE+backOffsetY),0),faH-1);
    var v_=1.0-my[iy0];
    spy[iy0]=Math.min(Math.max(Math.round(SYTOP+v_*(SYBOT-SYTOP)+sideOffsetY),0),saH-1);
  }
  // ★2026-07-10: mxLim/mzLimは「このパーツ自身の範囲」でなければならない
  // (共有グリッド使用時はmx[0]/mx[nx-1]がグリッド全体の外接範囲になってしまい、
  // このパーツの範囲より広くなる)。常にこの呼び出しのmxBounds/mzBoundsを使う。
  var mxLim=[[mxB[0],mxB[1]]];
  var mzLim=[[mzB[0],mzB[1]]];

  // ---- 1) 行ごとの幅セグメント(front/back)、連結成分ベースのtrack判定+
  //         中央値フィルタ ----
  // carveRegionのローカル変数(fa/ba/fy/byBack/CX/SCALE/mxLim等)を
  // クロージャでそのまま参照する内部関数として切り出す(引数の受け渡しミスに
  // よる数値ズレを避けるため、あえてトップレベル関数への外出しはしない)。
  // ★2026-07-10(ユーザー指摘「前髪がぐちゃぐちゃ」対応): 以前は行→行の
  // 距離ベース貪欲マッチングでtrack(房)を追跡しており、房が画像上で交差/
  // 接近すると別の房のtrackを誤って繋いでしまっていた。front∪back合成
  // ラスタの連結成分ラベリング(labelConnectedComponents、画像全体に対する
  // 厳密な位相判定)でtrackを決めることで、この誤結合を構造的に排除する。
  var combinedRaster = buildCombinedFrontRaster(fa, ba, faW, faH, backOffsetX, backOffsetY);
  var trackLabels = labelConnectedComponents(combinedRaster, faW, faH);
  function buildWidthTracks(){
    var tracksByLabel=new Map(); // label -> {rows:[],cx:[],hw:[]}
    var fallbackSeq=0;
    for(var iy=0; iy<ny; iy++){
      var faRow=rowOf1d(fa, faW, fy[iy]), baRow=rowOf1d(ba, faW, byBack[iy]);
      var frPx = faCont ? Common.findRunsSubpixel(faRow, rowOf1d(faCont,faW,fy[iy]), whiteThr) : Common.findRuns(faRow);
      var brPx = baCont ? Common.findRunsSubpixel(baRow, rowOf1d(baCont,faW,byBack[iy]), whiteThr) : Common.findRuns(baRow);
      var fr=frPx.map(function(pq){ return [(pq[0]-CX)/SCALE, (pq[1]-CX)/SCALE]; });
      var br=brPx.map(function(pq){ return [(faW-pq[1]-CX+backOffsetX)/SCALE, (faW-pq[0]-CX+backOffsetX)/SCALE]; });
      // ★2026-07-08: front/backのrunは積集合(両方が重なった範囲だけ採用)ではなく
      // 和集合にする。積集合だと、マフラーや髪の毛のようにfront/backで重なり方が
      // 食い違う絵柄で、重なった行の幅がその場で削れて本体に穴が空いていた
      // (front基準の幅からbackが「引き算」していた)。和集合ならbackはfrontに
      // 無い範囲を「足す」方向にしか働かず、食い違いがあっても穴にならない。
      var runsVal = intersectIntervals(unionIntervals(fr,br), mxLim);
      var segs=[];
      for(var i=0;i<runsVal.length;i++){
        var r0=runsVal[i][0], r1=runsVal[i][1];
        if(r1-r0>=vox) segs.push([(r0+r1)/2.0, Math.max((r1-r0)/2.0, EPS)]);
      }
      var rowPx = fy[iy], rowOff=rowPx*faW;
      for(var s=0;s<segs.length;s++){
        var cx=segs[s][0], hw=segs[s][1];
        var px = Math.max(0, Math.min(faW-1, Math.round(cx*SCALE+CX)));
        var label = trackLabels[rowOff+px];
        // ラベル未設定(ラスタ化誤差でこの1点だけ背景側に落ちた等)は近傍±2px
        // まで探して救済する。それでも見つからなければ独立扱い(一意ラベル)。
        for(var d=1; d<=2 && label<0; d++){
          if(px-d>=0 && trackLabels[rowOff+px-d]>=0) label=trackLabels[rowOff+px-d];
          else if(px+d<faW && trackLabels[rowOff+px+d]>=0) label=trackLabels[rowOff+px+d];
        }
        if(label<0) label = -1-(fallbackSeq++);
        var tr = tracksByLabel.get(label);
        if(!tr){ tr={rows:[],cx:[],hw:[]}; tracksByLabel.set(label,tr); }
        tr.rows.push(iy); tr.cx.push(cx); tr.hw.push(hw);
      }
    }
    var smoothByRow=new Map(); // iy -> [[cx,hw],...]
    tracksByLabel.forEach(function(tr3){
      for(var i2=0;i2<tr3.rows.length;i2++){
        var iyk=tr3.rows[i2];
        if(!smoothByRow.has(iyk)) smoothByRow.set(iyk, []);
        smoothByRow.get(iyk).push([tr3.cx[i2], tr3.hw[i2]]);
      }
    });
    return smoothByRow;
  }
  // ★2026-07-16追加(ストリーミング彫刻): ウィンドウ処理で同じリージョンの
  // carveRegionを複数回(ウィンドウの数だけ)呼ぶようになったため、
  // buildWidthTracks/buildDepthByRow(front/back/side画像の行スキャン、
  // ウィンドウに関わらず結果は同じ)を毎回re-scanすると無駄に遅い。
  // opts.precomputedRowsが渡されていれば、carveUnifiedRegionsが全ウィンドウ
  // 処理の前に1回だけ計算した結果を使い回す。
  var smoothByRow = opts.precomputedRows ? opts.precomputedRows.smoothByRow : buildWidthTracks();

  // ---- 2) 行ごとの奥行き(side画像) ----
  // ★2026-07-12(ユーザー指摘「房が分かれているところの顔が切り抜けてない」
  // 対応): 当初はside画像上の連結成分ラベリング(track判定と同じ仕組み)で
  // runをグループ化しようとしたが、前髪の房は多くの場合「顔と同じ1つの
  // 連結成分の中の凹み(半島状)」であり、房と房の間で完全に切り離された
  // 別の連結成分にはならない(体+アクセサリー全体が1つの巨大な連結成分に
  // なりやすいのと同じ理由)。そのため連結成分ベースでは房と顔がグループ
  // 分けされず、修正が効かなかった(実測で確認済み)。
  // ★2026-07-17(設定タブ整理): depth_gap_close_pxによるrun統合(隙間が
  // 狭ければ同じ帯とみなす)は廃止し、常に行内のrunをそれぞれ別々の奥行き
  // 帯として扱う。顎先/首のような実在の小さい凹みが再び分断される可能性が
  // あることは把握した上で、ユーザーの判断により削除した。
  function buildDepthByRow(){
  var depthRows=[]; // [iy, [[hdFront,hdBack,zc], ...]]
  for(var iy2=0; iy2<ny; iy2++){
    var rowPx2 = spy[iy2];
    var saRow=rowOf1d(sa, saW, rowPx2);
    var saPx = saCont ? Common.findRunsSubpixel(saRow, rowOf1d(saCont,saW,rowPx2), whiteThr) : Common.findRuns(saRow);
    if(!saPx.length) continue;
    saPx = saPx.slice().sort(function(p,q){return p[0]-q[0];});
    // 各runをモデル単位に変換し、mzLimで切り詰める。
    var runsMz=[];
    for(var ri=0;ri<saPx.length;ri++){
      var conv=intersectIntervals([[(saPx[ri][0]-SIDE_REF-sideOffsetX)/SCALE, (saPx[ri][1]-SIDE_REF-sideOffsetX)/SCALE]], mzLim);
      if(conv.length) runsMz.push(conv[0]);
    }
    if(!runsMz.length) continue;
    // ★2026-07-18バグ修正: 以前は近接するrunを1グループにまとめてから
    // グループ内でノイズ幅(vox未満)のrunを無視していたが、2026-07-17の
    // depth_gap_close_px削除時にグループを「run 1本=1グループ」へ簡略化した
    // ため、この「ノイズ幅runを無視する」判定(zrunsMz.length>1が常に偽になる)
    // が意図せず死んでいた。アンチエイリアス由来の1px程度の孤立誤分類run
    // (色分けマップ上で複数パーツの境界が近接する箇所で発生する)が、
    // そのまま独立した奥行き帯として彫刻に使われ、3D形状にスパイクとして
    // 現れる不具合があった。同じ行に実体のあるrun(vox以上の幅)が他にあれば
    // ノイズ幅のrunは無視する(全runがノイズ幅の場合は、顎先等の実在の小さい
    // 凹凸を消さないよう何も無視しない)。★2026-07-17の変更(隙間サイズに
    // 依存しないよう、各runを別々の奥行き帯として扱う。エンベロープはしない)
    // はそのまま維持する。
    var significantRuns=runsMz.filter(function(r){ return (r[1]-r[0])>=vox; });
    var useRuns = significantRuns.length ? significantRuns : runsMz;
    var bands=[];
    for(var g=0; g<useRuns.length; g++){
      var mz0=useRuns[g][0], mz1=useRuns[g][1];
      if(mz0<0.0 && 0.0<mz1){
        bands.push([Math.max(mz1,EPS), Math.max(-mz0,EPS), 0.0]);
      }else{
        var zc=(mz0+mz1)/2.0;
        var hw2=Math.max((mz1-mz0)/2.0, EPS);
        bands.push([hw2,hw2,zc]);
      }
    }
    if(bands.length) depthRows.push([iy2, bands]);
  }
    // ★2026-07-04(改): 以前は奥行き(hdFront/hdBack/zc)にも行方向trackWin幅の
    // 中央値フィルタをかけていたが、顎先のような数行分しかない前方突出まで
    // 均されて消えてしまうため、奥行きは生の行ごとの値をそのまま使う
    // (幅セグメント側のトラッキング+中央値平滑化は従来通り)。
    var hdByRow=new Map();
    for(var j=0;j<depthRows.length;j++){
      hdByRow.set(depthRows[j][0], depthRows[j][1]);
    }
    return hdByRow;
  }
  var hdByRow = opts.precomputedRows ? opts.precomputedRows.hdByRow : buildDepthByRow();

  // smoothByRow(幅、行ごとのx方向segs)/hdByRow(奥行き、行ごとのz方向bands)は
  // このパーツ自身のシルエットだけから求まる行ごとの外形で、以降の腕/手
  // プロファイルやSDFフィールド書き込みには依存しない。opts.extentsOnlyが
  // 立っている場合はここで打ち切り、この2つ(と行→y変換のny/my)だけを返す
  // (密グリッドを確保しない軽量な事前パス。推定頂点数の計算や、
  // carveUnifiedRegionsのsmoothByRow/hdByRowキャッシュに使う)。
  if(opts.extentsOnly){
    return {smoothByRow:smoothByRow, hdByRow:hdByRow, ny:ny, my:my};
  }

  // ---- 2.5) 腕/手の列プロファイル(y軸で太さを測る) ----
  // ★2026-07-04(改3): 腕の太さの測り方を「行スキャンのx幅」から「列スキャンの
  // y幅」に変更。このツールの想定ポーズでは腕はほぼ水平〜斜めに伸びる
  // (skeleton.jsも腕を列単位でトレースする)ため、行スキャンで得られるxラン幅は
  // 腕の斜め切り(太さ/sinθ)で、水平に近いほど実際の太さより大きくなり半径と
  // して使えない(改2の方式が直らなかった根本原因)。
  // front画像の各列(x)を骨線のy位置から上下に走査して縦半幅ryを測り、それを
  // 奥行き(z)に適用する。傾いた円柱を縦に切ると縦幅は太くなる(ry=R/cosθ)ので、
  // 奥行き半径には傾き補正 rz=ry*|dx|/len(=ry*cosθ) を使う。断面は
  //   ey=(|y-cy|/ry)^p, ez=(|z|/rz)^p, val=1-(ey+ez)
  // で、傾いた円柱の縦断面と数学的に一致する。
  // 戻り値: mxグリッド各列の {cy(中心y), ry(縦半幅), rz(奥行き半径)}。cyはNaN=対象外。
  function buildBoneProfiles(lines, maxHw, slantCorrect){
    var cyA=new Float64Array(nx).fill(NaN);
    var ryA=new Float64Array(nx), rzA=new Float64Array(nx);
    var maxScanPx=Math.max(4, Math.round(maxHw*3*SCALE));
    for(var li=0; li<lines.length; li++){
      var a=lines[li][0], b=lines[li][1];
      var ldx=b[0]-a[0], ldy=b[1]-a[1];
      var llen=Math.hypot(ldx,ldy);
      if(llen<1e-9 || Math.abs(ldx)<vox*2) continue; // ほぼ垂直な線分は列サンプル不可(垂れた腕は従来通り)
      var slant = slantCorrect ? Math.abs(ldx)/llen : 1.0;
      var xlo=Math.min(a[0],b[0]), xhi=Math.max(a[0],b[0]);
      for(var ix=0; ix<nx; ix++){
        var xv=mx[ix];
        if(xv<xlo || xv>xhi) continue;
        var t=(xv-a[0])/ldx; if(t<0)t=0; if(t>1)t=1;
        var lineY=a[1]+t*ldy;
        var px=Math.round(xv*SCALE+CX);
        if(px<0||px>=faW) continue;
        var py0=Math.round(YBOT-lineY*SCALE);
        if(py0<0||py0>=faH) continue;
        // 骨線が輪郭から外れている場合に備え、前景ピクセルが見つかるまで列全体を探す
        // (±8px上限は実イラストの袖の膨らみ/曲がりで頻繁に超え、腕/手の大半が
        // 側面ベースの奥行きにフォールバックする原因だったため撤廃)
        var pyc=-1;
        for(var dp=0; pyc<0 && (py0-dp>=0 || py0+dp<faH); dp++){
          if(py0-dp>=0 && fa[(py0-dp)*faW+px]) pyc=py0-dp;
          else if(py0+dp<faH && fa[(py0+dp)*faW+px]) pyc=py0+dp;
        }
        if(pyc<0) continue; // この列に腕のシルエットが無い
        // 上下に走査。指の間や袖の切れ目/装飾線など、実イラストのギャップは
        // 数px〜十数pxに及ぶことがあるため、小さすぎるギャップ許容は指/肩の
        // 縦幅を実際より小さく測ってしまい、手扱い/腕扱いされない行を作る
        // 原因になっていた(★2026-07-04 gap>2→gap>20に緩和)。
        // maxScanPxまでに背景に届かなければ胴体等の内部を通っているとみなして
        // 腕/手扱いしない(この安全弁は維持)。
        function scanEnd(step){
          var last=pyc, gap=0, p=pyc+step, steps=0;
          while(steps<maxScanPx){
            if(p<0||p>=faH) break;
            if(fa[p*faW+px]){ last=p; gap=0; }
            else{ gap++; if(gap>20) break; }
            p+=step; steps++;
          }
          return {last:last, capped:steps>=maxScanPx};
        }
        var up=scanEnd(-1), dn=scanEnd(1);
        if(up.capped || dn.capped) continue;
        var ry=((dn.last-up.last)/2)/SCALE;
        if(ry<=0) continue;
        var rz=Math.max(ry*slant, vox);
        if(rz>maxHw) continue; // 太すぎる=腕/手ではない(上限ガード)
        var cyM=(YBOT-(up.last+dn.last)/2)/SCALE;
        // 複数線分が同じ列を覆う場合(肘付近)は細い方を採用
        if(isNaN(cyA[ix]) || ry<ryA[ix]){ cyA[ix]=cyM; ryA[ix]=Math.max(ry,EPS); rzA[ix]=rz; }
      }
    }
    return {cy:cyA, ry:ryA, rz:rzA};
  }
  var armProf = armLines ? buildBoneProfiles(armLines, armMaxHw, true) : null;
  var handProf = handLines ? buildBoneProfiles(handLines, handMaxHw, false) : null;

  // ---- 3) 疑似SDFフィールドを彫る(ローカルbbox最適化) ----
  var strideY=nx*nz, strideX=nz;
  // ★2026-07-16追加(ストリーミング彫刻、STREAMING_CARVING_PLAN.md参照):
  // opts.rowRangeが渡された場合、field/ownerFieldは全ny行分ではなく
  // [rowRangeStart, rowRangeEnd](グローバル行番号、両端含む)の範囲だけの
  // 小さい配列(呼び出し元=carveUnifiedRegionsのウィンドウ処理が確保)。
  // 行の添字計算は全てrowRangeStartを引いたローカル行番号で行う。
  // 省略時はrowRangeStart=0・rowRangeEnd=ny-1で、従来と完全に同じ動作になる。
  var rowRangeStart = opts.rowRange ? opts.rowRange[0] : 0;
  var rowRangeEnd = opts.rowRange ? opts.rowRange[1] : ny-1;
  // ★2026-07-10(体+アクセサリー統合彫刻対応): opts.accumulateが渡された
  // 場合は新規fieldを割り付けず、呼び出し元(carveUnifiedRegions)が全パーツ
  // 共有で持つfield/ownerFieldへ直接max-combineで書き込む。ownerFieldには
  // 「そのセルを現在勝っている(field値が最大の)パーツのID」を書き込む。
  var accumulate = opts.accumulate;
  var sharedField = accumulate ? accumulate.field : null;
  var sharedOwnerField = accumulate ? accumulate.ownerField : null;
  var ownerId = accumulate ? accumulate.ownerId : 0;
  function carveSdfField(){
  var field = sharedField || new Float32Array((rowRangeEnd-rowRangeStart+1)*nx*nz).fill(-1.0);
  var ownerField = sharedOwnerField;
  // このbboxの外側は必ずval<=-1相当なので無視できる(psqが小さいほどbboxを
  // 広めに取る必要があるため、使用しうる指数のうち最小値で安全側に倒す)
  var psqMin = Math.min(psqHead,psqTorso,psqLegs,psqArms,psqHands);
  var boundFactor = Math.pow(2, 1/psqMin);

  for(var iy3=rowRangeStart; iy3<=rowRangeEnd; iy3++){
    var hdBands=hdByRow.get(iy3);
    if(!hdBands) continue;
    var segsRow=smoothByRow.get(iy3);
    if(!segsRow) continue;
    var rowOff=(iy3-rowRangeStart)*strideY;
    var myv=my[iy3];
    var rowPsq=regionPsq(myv); // 腕/手プロファイル対象外の列(頭/胴体/脚)で使う指数
    // ★2026-07-12: 1行に複数の奥行き区間(帯)がある場合(例: 前髪の房が手前、
    // 顔がその奥に覗く)、同じ行の全x区間(segsRow)にそれぞれの帯を独立に
    // 適用する(帯ごとに別々の奥行きスラブとして彫り、max-combineで正しい
    // 側の表面が残る)。通常は1行1帯なのでこのループはほぼ1回で終わる。
    for(var bi=0; bi<hdBands.length; bi++){
    var hdFront=hdBands[bi][0], hdBack=hdBands[bi][1], zc=hdBands[bi][2];
    for(var si=0;si<segsRow.length;si++){
      var cx2=segsRow[si][0], hw3=segsRow[si][1];
      var segLo=cx2-hw3, segHi=cx2+hw3;
      var xLo=cx2-hw3*boundFactor, xHi=cx2+hw3*boundFactor;
      var ix0=Math.max(0, Math.floor((xLo-mxMin)/(mxMax-mxMin)*(nx-1)));
      var ix1=Math.min(nx-1, Math.ceil((xHi-mxMin)/(mxMax-mxMin)*(nx-1)));
      if(ix0>ix1) continue;
      for(var ix=ix0; ix<=ix1; ix++){
        var xv=mx[ix];
        if(xv<segLo || xv>segHi) continue; // 腕/手もfrontシルエットの外には出さない
        // この列が手/腕プロファイルに載っていて、かつこの行がその縦幅の中に
        // 入っていれば腕/手断面、外れていれば従来の胴体断面。縦幅のすぐ外
        // (boundFactor倍まで)の行は「何も彫らない」デッドゾーンにする:
        // 胴体扱いにすると腕の上下エッジの行だけ胴体奥行きの薄いヒレが付くため。
        // 手(手首から先)を腕より先に判定する(手首付近で両者が重なるため)。
        var zr=-1, exVal=-1, depthPsq=rowPsq;
        // ★2026-07-15(ユーザー指摘「手や腕は正面だけ使ってほしい」対応):
        // segLo/segHi(このセルが候補になるかどうかの外枠)はfront∪back画像の
        // 和集合で決まるため、手のように指の間の隙間がfrontとbackで食い違う絵柄
        // (backは正面と違うポーズ/簡略化した絵柄で描かれがち)だと、backにしか
        // 無い絵柄がfrontの指の間の隙間を埋めてしまい、指が癒着して見えていた。
        // 手/腕の「確信を持って手/腕と判定できた」列に限り、frontのその画素
        // そのものに前景があるかを追加でチェックし、backだけにある絵柄は
        // 無視する(手/腕以外の胴体等は従来通りfront∪backのまま)。
        var frontPx = Math.round(xv*SCALE+CX);
        var frontHasPixel = frontPx>=0 && frontPx<faW && !!fa[fy[iy3]*faW+frontPx];
        if(handProf && !isNaN(handProf.cy[ix])){
          var uh=Math.abs(myv-handProf.cy[ix]);
          if(uh<=handProf.ry[ix]){
            if(!frontHasPixel) continue;
            // ★2026-07-04(改2): 手の奥行きはside計測もシルエット縦幅も使わず、
            // 設定値handDepthHwをそのまま採用する(ユーザー指定)。
            zr=Math.max(handDepthHw, EPS);
            exVal=0.0; // 押し出し: 断面はz方向のみで決め、x/yはシルエットと縦幅で切る
            depthPsq=psqHands;
          }else if(uh<=handProf.ry[ix]*boundFactor){
            continue; // デッドゾーン
          }
        }
        // 腕の奥行きは縦幅由来の円形断面(zr、z=0対称)、胴体の奥行きはside画像
        // 由来のhdFront/hdBack(zc基準の非対称)で、全く別の測り方をしている。
        // 腕の縦幅の外側は以前「デッドゾーン」として何も彫らなかった(境目で
        // 胴体奥行きの薄いヒレが付くのを避けるため)が、その結果、腕の輪郭が
        // 終わった直後の行でいきなり胴体の(側面計測由来の)奥行きに切り替わり、
        // 肩の位置で奥行きが急に増えて見えていた。デッドゾーンの代わりに、
        // 腕自身のzrを起点として胴体のzc/hdFront/hdBackへなだらかに線形補間する
        // ことで、肩での奥行きジャンプをなくす。
        var zcEff=null, hdFrontEff=0, hdBackEff=0;
        if(exVal<0 && armProf && !isNaN(armProf.cy[ix])){
          var ua=Math.abs(myv-armProf.cy[ix]);
          var armRy=armProf.ry[ix];
          if(ua<armRy){
            if(!frontHasPixel) continue;
            zr=armProf.rz[ix];
            exVal=Math.pow(ua/armRy, psqArms); // 傾いた円柱の縦断面プロファイル
            depthPsq=psqArms;
          }else{
            var blendW=Math.max(armRy*(boundFactor-1), EPS);
            if(ua<armRy+blendW){
              var tBlend=(ua-armRy)/blendW; // 0=腕の際 -> 1=胴体
              var armR=armProf.rz[ix];
              zcEff=zc*tBlend;
              hdFrontEff=armR+(hdFront-armR)*tBlend;
              hdBackEff=armR+(hdBack-armR)*tBlend;
              exVal=Math.pow(Math.abs(xv-cx2)/hw3, rowPsq); // 胴体側のxy形状をそのまま使う
            }
          }
        }
        if(exVal<0) exVal=Math.pow(Math.abs(xv-cx2)/hw3, rowPsq);
        if(exVal>=2) continue;
        // z範囲は列ごとに決める(腕/手はz原点対称、胴体はzc基準の非対称、
        // 肩の遷移帯はzcEff/hdFrontEff/hdBackEffで補間した中間値を使う)
        var izLoC, izHiC;
        if(zcEff!==null){ izLoC=zcEff-hdBackEff*boundFactor; izHiC=zcEff+hdFrontEff*boundFactor; }
        else if(zr>=0){ izLoC=-zr*boundFactor; izHiC=zr*boundFactor; }
        else{ izLoC=zc-hdBack*boundFactor; izHiC=zc+hdFront*boundFactor; }
        var iz0=Math.max(0, Math.floor((izLoC-mzMin)/(mzMax-mzMin)*(nz-1)));
        var iz1=Math.min(nz-1, Math.ceil((izHiC-mzMin)/(mzMax-mzMin)*(nz-1)));
        if(iz0>iz1) continue;
        var base=rowOff+ix*strideX;
        for(var iz=iz0; iz<=iz1; iz++){
          var mzv=mz[iz];
          var ez;
          if(zcEff!==null){
            var hdvB=(mzv>=zcEff)?hdFrontEff:hdBackEff;
            ez=Math.pow(Math.abs(mzv-zcEff)/hdvB, rowPsq);
          }else if(zr>=0){
            ez=Math.pow(Math.abs(mzv)/zr, depthPsq); // 腕=円形/手=押し出し(z原点対称)
          }else{
            var hdv = (mzv>=zc) ? hdFront : hdBack;
            ez=Math.pow(Math.abs(mzv-zc)/hdv, rowPsq);
          }
          var val=1.0-(exVal+ez);
          var idx=base+iz;
          var prevVal=field[idx];
          if(val>prevVal){ field[idx]=val; if(ownerField) ownerField[idx]=ownerId; }
        }
      }
    }
    }
  }
  return field;
  }
  var field = carveSdfField();

  // ★2026-07-10: 共有fieldへ蓄積するだけの呼び出し(体+アクセサリー統合彫刻の
  // 1パーツ分)は、marching cubes/断片除去/平滑化を行わずここで終える
  // (呼び出し元が全パーツ蓄積後に1回だけ行う)。
  if(accumulate) return {accumulated:true};

  var anyPositive=false, cntPos=0;
  for(var i5=0;i5<field.length;i5++){ if(field[i5]>0){ cntPos++; if(cntPos>=8){anyPositive=true;break;} } }
  if(!anyPositive) return null;

  var mc = P3D.marchingCubes(field, ny, nx, nz, 0.0);
  if(!mc.verts.length) return null;
  var nvtx=mc.verts.length/3;
  var V=new Float32Array(nvtx*3);
  for(var vi=0; vi<nvtx; vi++){
    var iyF=mc.verts[vi*3], ixF=mc.verts[vi*3+1], izF=mc.verts[vi*3+2];
    V[vi*3]   = ixF/(nx-1)*(mxMax-mxMin)+mxMin;
    V[vi*3+1] = iyF/(ny-1)*(myMax-myMin)+myMin;
    V[vi*3+2] = izF/(nz-1)*(mzMax-mzMin)+mzMin;
  }
  var F=mc.faces;
  // ★2026-07-10: opts.minFragFracで呼び出し側(体の彫刻)から閾値を下げられる
  // ようにした(js/visual_hull.js参照)。未指定時はdropSmallFragmentsの既定値
  // (0.05)のまま。
  var dropped=dropSmallFragments(V,F,opts.minFragFrac);
  V=dropped.V; F=dropped.F;

  if(smoothIters>0) V=laplacianSmooth(V,F,smoothIters);

  return {V:V, F:F}; // 法線計算・decimationは呼び出し側(visual_hull.js/accessories.js)で行う
}
P3D.carveRegion = carveRegion;

// ★2026-07-14追加(part_gap_close機能、ユーザー要望「モデル生成時に、設定した
// 距離でパーツ間の隙間を塞ぐ機能」): bone_bridgeはボーン共有+行単位の粗い
// 外縁近似(1次元区間)で「隣接している」かどうかを判定していたため、実際には
// 近くない箇所を誤って隣接と判定する不具合が繰り返し見つかった(union範囲の
// 暴走、体⇔マフラーの誤爆等)。この機能はそれとは別に、ボクセルグリッド上の
// 本物の3次元距離だけで判定するシンプルな方式にした: 「まだどのパーツも
// 領域を持たない空ボクセルのうち、異なる2パーツ以上の表面から指定距離以内に
// 同時に届いている(=パーツとパーツに挟まれた細い隙間の中にある)」ボクセル
// だけを埋める。ボーン共有やパーツの種類は一切見ない、純粋に距離だけの判定
// なので、bone_bridgeで問題になった「粗い近似による誤判定」が原理的に起きない
// (実測した3次元距離そのものを使うため)。
// ★2026-07-15(ユーザー指摘「隙間を板で埋めたみたいで不自然、境界だけ繋げたい」):
// 当初は検出したボクセルへ一律の定数値を書き込んでいたが、これだと隙間の内側
// (定数値)と外側(何もない背景値)の境目でfieldの値が不連続に落ちる箇所ができ、
// marching cubesがその段差をそのまま「四角い突起」として描画してしまっていた
// (スカート裾・腕等で頂点が飛び出す不具合の原因)。ここを「各空ボクセルの
// 一番近いパーツまでの距離+2番目に近い別パーツまでの距離の合計」に応じて
// なめらかに減衰する値に変更する。合計距離が小さい(=2つの表面が向き合って
// 最短で接近している真上)ほど高い値、離れるほど滑らかに0へ戻るため、
// 段差が生まれず、かつ塗る範囲も「実際に向き合っている境界」付近だけに
// 自然に絞られる(単純に両方からR以内というAND判定だと、表面の縁の外側の
// 何もない空間まで同じ幅で塗ってしまっていた)。
var PART_GAP_CLOSE_PEAK = 0.3; // 埋める領域の中心(最短経路の真上)でのピーク値
function closeInterPartGaps(field, ownerField, grid, vox, maxDist){
  if(!(maxDist>0)) return;
  var nx=grid.nx, ny=grid.ny, nz=grid.nz;
  var R=Math.max(1, Math.round(maxDist/(vox||0.003)));
  var n=nx*ny*nz;
  var strideY=nx*nz, strideX=nz;

  var ownerSet=new Set();
  for(var i=0;i<n;i++){ if(ownerField[i]>=0) ownerSet.add(ownerField[i]); }
  var owners=Array.from(ownerSet);
  if(owners.length<2) return; // 隙間を語れるのは2パーツ以上ある場合のみ

  // 26近傍オフセット(3x3x3から中心を除いた26通り)。斜め方向の隙間
  // (=45度視点で見える隙間そのもの)も見逃さないよう対角も含める。
  var offs=[];
  for(var oy=-1;oy<=1;oy++)for(var ox=-1;ox<=1;ox++)for(var oz=-1;oz<=1;oz++){
    if(ox===0&&oy===0&&oz===0) continue;
    offs.push([oy,ox,oz]);
  }

  function neighborsOf(idx, cb){
    var iy=(idx/strideY)|0, rem=idx-iy*strideY, ix=(rem/strideX)|0, iz=rem-ix*strideX;
    for(var k=0;k<offs.length;k++){
      var niy=iy+offs[k][0], nix=ix+offs[k][1], niz=iz+offs[k][2];
      if(niy<0||niy>=ny||nix<0||nix>=nx||niz<0||niz>=nz) continue;
      cb(niy*strideY+nix*strideX+niz);
    }
  }

  // ownerIdごとに独立したBFS(R歩以内)を行い、各空ボクセルについて
  // 「一番近いパーツまでの距離・そのownerId」(bestDist/bestOwner)と
  // 「2番目に近い別パーツまでの距離」(secondDist)を求める。
  // (以前はここをbitmaskで「届いたかどうか」だけ記録していたが、埋める値を
  // 距離ベースで減衰させるには実際の距離が要るため、距離そのものを持つ形にした)
  var bestDist=new Int32Array(n).fill(-1);
  var bestOwner=new Int32Array(n).fill(-1);
  var secondDist=new Int32Array(n).fill(-1);
  owners.forEach(function(ownerId){
    var visited=new Uint8Array(n);
    var queue=new Int32Array(n);
    var qHead=0, qTail=0;
    for(var i2=0;i2<n;i2++){
      if(ownerField[i2]===ownerId){ visited[i2]=1; queue[qTail++]=i2; }
    }
    var distO=new Int32Array(n).fill(-1);
    for(var s=0;s<qTail;s++) distO[queue[s]]=0;
    var qh=0;
    while(qh<qTail){
      var idx=queue[qh++];
      var d=distO[idx];
      if(d>=R) continue;
      neighborsOf(idx, function(nidx){
        if(visited[nidx]) return;
        visited[nidx]=1;
        var dd=d+1;
        distO[nidx]=dd;
        queue[qTail++]=nidx;
        if(ownerField[nidx]!==-1) return; // 既に実体があるボクセルは埋める対象外
        if(bestOwner[nidx]===-1 || dd<bestDist[nidx]){
          secondDist[nidx]=bestDist[nidx]; bestDist[nidx]=dd; bestOwner[nidx]=ownerId;
        }else if(secondDist[nidx]===-1 || dd<secondDist[nidx]){
          secondDist[nidx]=dd;
        }
      });
    }
  });

  // 異なる2パーツ以上に挟まれた(secondDistが求まった)空ボクセルだけを、
  // 合計距離(bestDist+secondDist)が小さいほど高い、なめらかなsmoothstep減衰で埋める。
  for(i=0;i<n;i++){
    if(ownerField[i]!==-1) continue; // 既にどこかのパーツが領域を持つボクセルは変更しない
    if(bestOwner[i]<0 || secondDist[i]<0) continue;
    var gapSum=bestDist[i]+secondDist[i];
    var t=1-gapSum/(2*R);
    if(t<=0) continue;
    if(t>1) t=1;
    var val=PART_GAP_CLOSE_PEAK*(t*t*(3-2*t)); // smoothstep(0→1)
    if(val<=0) continue;
    field[i]=val;
    ownerField[i]=bestOwner[i];
  }
}
P3D.closeInterPartGaps = closeInterPartGaps;

/**
 * ★2026-07-10(体+アクセサリー統合彫刻、ユーザー指摘「パーツ間の隙間」対応):
 * 体+全アクセサリーを1つの共有ボクセルグリッドへ蓄積彫刻し、1回だけ
 * marching cubesを実行して継ぎ目の無い1枚のメッシュを作る。従来は体と
 * 各アクセサリーを別々のグリッド・別々のmarching cubes呼び出しで独立に
 * 彫っており、境界は「たまたま同じ輪郭線から彫られていれば大体合う」程度
 * の保証しかなかった(体色以外の画素は最初から体シルエットに含めない設計
 * のため)。1つのfieldへのmax-combineにすることで、彫刻段階そのものでは
 * パーツ間の接合不整合が原理的に起きなくなる。
 *
 * regions: [{ownerId:number, opts:{...carveRegionのopts。grid/accumulateは
 *   ここで自動設定するので渡さなくてよい}}, ...]
 *   ownerId=0は体、1以上は呼び出し側が決めるアクセサリーindex(+1)の想定
 *   (呼び出し側で対応表を持つこと)。
 * sharedGrid: buildGrid()の戻り値(体+全アクセサリーの外接範囲で作ったもの)
 * minFragFrac: dropSmallFragmentsの閾値(未指定時0.05)
 * partGapCloseDist: 省略可(model単位、0または未指定で無効)。part_gap_close機能
 *   (js/carving.jsのcloseInterPartGaps参照)で、異なる2パーツ以上の表面から
 *   同時にこの距離以内にある空ボクセルを埋める閾値。
 * 戻り値: {V,F,owner} (owner: Int32Array、頂点ごとのownerId) または
 *   null(彫れなかった場合)
 */
// ★2026-07-16追加(ストリーミング彫刻、STREAMING_CARVING_PLAN.md参照): 1
// ウィンドウあたりのfield+ownerField確保サイズの上限目安。body_vox/
// body_vox_xzを両方1px相当にすると、共有field/ownerFieldの一括確保
// (nx*ny*nz*8byte)が数GBに達しArrayBuffer確保に失敗する
// (Array buffer allocation failed)。Y方向を、この予算に収まる行数の
// ウィンドウに分割して彫刻+marching cubesを繰り返し、頂点/面だけを
// グローバルなメッシュへ蓄積することでこれを回避する(サーフェスメッシュ
// 自体は密グリッドよりずっと小さいため、間引き以降の処理は変更不要)。
var STREAMING_FIELD_BUDGET_BYTES = 300*1024*1024;
function carveUnifiedRegions(regions, sharedGrid, minFragFrac, partGapCloseDist){
  var nx=sharedGrid.nx, ny=sharedGrid.ny, nz=sharedGrid.nz;

  // ★2026-07-16追加(ストリーミング彫刻): 各リージョンのsmoothByRow/hdByRow
  // (front/back/side画像の行スキャン結果)は、ウィンドウ処理で同じリージョンの
  // carveRegionを複数回(ウィンドウの数だけ)呼んでも値は変わらない(入力画像は
  // ウィンドウに依存しない)。全ウィンドウ処理の前に1回だけ計算してキャッシュし、
  // 各ウィンドウのcarveSdfField呼び出しで使い回す(js/carving.jsの
  // opts.precomputedRows参照)。これが無いとウィンドウの数だけ画像の行スキャンが
  // 重複し、無駄に遅くなる。
  var precomputedRowsByOwner = new Map();
  regions.forEach(function(r){
    precomputedRowsByOwner.set(r.ownerId, carveRegion(Object.assign({}, r.opts, {grid:sharedGrid, extentsOnly:true})));
  });
  var voxForGapClose = regions.length ? (regions[0].opts.vox||0.003) : 0.003;

  // ウィンドウの行数をメモリ予算から決める。既定の粗い設定ではグリッド
  // 全体が予算に収まり、windowRows>=nyになる(=ウィンドウ1個、従来と
  // 完全に同じ1回のmarching cubesに自動的に収束する安全弁)。
  var windowRows = Math.max(8, Math.floor(STREAMING_FIELD_BUDGET_BYTES/(nx*nz*8)));
  if(windowRows > ny) windowRows = ny;

  var mcCache = null;
  var globalVerts=[], globalFaces=[], globalOwner=[];

  for(var winStart=0; winStart<ny-1; winStart += (windowRows-1)){
    var winEnd = Math.min(winStart+windowRows-1, ny-1); // このウィンドウのfield行範囲(グローバル行番号、両端含む)
    var winRows = winEnd-winStart+1;
    var field = new Float32Array(winRows*nx*nz).fill(-1.0);
    var ownerField = new Int32Array(winRows*nx*nz).fill(-1);

    regions.forEach(function(r){
      var opts = Object.assign({}, r.opts, {
        grid: sharedGrid,
        rowRange: [winStart, winEnd],
        precomputedRows: precomputedRowsByOwner.get(r.ownerId),
        accumulate: {field:field, ownerField:ownerField, ownerId:r.ownerId},
      });
      carveRegion(opts);
    });

    // ★2026-07-14追加(part_gap_close機能): ボーン共有や行単位の近似を介さず、
    // 純粋なボクセルグリッド上の3次元距離だけで異なるパーツ間の隙間を塞ぐ
    // (closeInterPartGaps参照)。★このウィンドウのfield/ownerField自体を
    // グリッドの全てとみなして自己完結で動く(BFSの探索半径がウィンドウを
    // またぐケースは範囲外として扱われる。STREAMING_CARVING_PLAN.mdの既知の
    // 制限事項参照)。
    if(partGapCloseDist>0){
      closeInterPartGaps(field, ownerField, Object.assign({}, sharedGrid, {ny:winRows}), voxForGapClose, partGapCloseDist);
    }

    var mc = P3D.marchingCubes(field, winRows, nx, nz, 0.0, ownerField, {
      rowOffset: winStart, cache: mcCache, vertBase: globalVerts.length/3,
    });
    mcCache = mc.cache;
    for(var vi=0; vi<mc.verts.length; vi++) globalVerts.push(mc.verts[vi]);
    for(var fi=0; fi<mc.faces.length; fi++) globalFaces.push(mc.faces[fi]);
    if(mc.vertOwner) for(var oi=0; oi<mc.vertOwner.length; oi++) globalOwner.push(mc.vertOwner[oi]);

    if(winEnd>=ny-1) break;
  }

  if(!globalVerts.length) return null;
  var nvtx=globalVerts.length/3;
  var mxMin=sharedGrid.mxMin,mxMax=sharedGrid.mxMax,myMin=sharedGrid.myMin,myMax=sharedGrid.myMax,mzMin=sharedGrid.mzMin,mzMax=sharedGrid.mzMax;
  var V=new Float32Array(nvtx*3);
  for(var vidx=0; vidx<nvtx; vidx++){
    var iyF=globalVerts[vidx*3], ixF=globalVerts[vidx*3+1], izF=globalVerts[vidx*3+2];
    V[vidx*3]   = ixF/(nx-1)*(mxMax-mxMin)+mxMin;
    V[vidx*3+1] = iyF/(ny-1)*(myMax-myMin)+myMin;
    V[vidx*3+2] = izF/(nz-1)*(mzMax-mzMin)+mzMin;
  }
  var F=Uint32Array.from(globalFaces);
  var owner=Int32Array.from(globalOwner);
  var dropped=dropSmallFragments(V,F,minFragFrac,{owner:owner});
  return {V:dropped.V, F:dropped.F, owner:dropped.extra.owner};
}
P3D.carveUnifiedRegions = carveUnifiedRegions;

/**
 * ★2026-07-10: carveUnifiedRegions()の出力(1枚の継ぎ目なしメッシュ+頂点
 * ごとのownerId)を、ownerIdごとの独立したサブメッシュ(V,F)に分割する。
 * 3頂点のownerが割れている面(パーツの境界を跨ぐ面)は、多数決(2/3以上を
 * 占めるowner。3頂点とも別なら頂点0のownerにタイブレーク)で「どちらか
 * 片方のパーツに完全に」割り当てる(面を欠落させない=分割後も両パーツの
 * 表面を合わせると隙間なく元の1枚のメッシュを復元できる)。境界の頂点は
 * 両方のサブメッシュに同じ座標のまま重複して現れる形になるため、平滑化
 * 回数0・間引きで境界頂点が消えない限り、2つのサブメッシュの境界は
 * ぴったり閉じたまま保たれる。
 * ownerIds: 分割したいownerIdの配列(この順で戻り値配列に対応する)
 * extraVertArrays: 省略可、{name: TypedArray(N)}(頂点ごとに1個の値、Vと
 *   同じ頂点並びの補助配列)。渡すと、各パーツの生き残った頂点に合わせて
 *   remapした結果をextra.<name>として一緒に返す(dropSmallFragmentsの
 *   extraVertArraysと同じ規約。★2026-07-11追加: 平滑化後の法線Nをパーツ
 *   ごとに分割するのに使う)。
 * 戻り値: [{V,F,extra}, ...] (ownerIdsと同じ長さ、該当頂点が無ければV,Fとも空)
 */
function splitMeshByOwner(V, F, owner, ownerIds, extraVertArrays){
  var nf=F.length/3;
  var faceOwner=new Int32Array(nf);
  for(var f=0;f<nf;f++){
    var a=F[f*3],b=F[f*3+1],c=F[f*3+2];
    var oa=owner[a],ob=owner[b],oc=owner[c];
    var o;
    if(oa===ob||oa===oc) o=oa;
    else if(ob===oc) o=ob;
    else o=oa; // 3頂点とも別ownerの稀なケースはタイブレークでaを採用
    faceOwner[f]=o;
  }
  return ownerIds.map(function(targetId){
    var usedVert=new Set();
    for(var f2=0;f2<nf;f2++){
      if(faceOwner[f2]!==targetId) continue;
      usedVert.add(F[f2*3]); usedVert.add(F[f2*3+1]); usedVert.add(F[f2*3+2]);
    }
    if(!usedVert.size) return {V:new Float32Array(0), F:new Uint32Array(0), extra:extraVertArrays?{}:undefined};
    var remap=new Map(); var cnt=0;
    var Vout=new Float32Array(usedVert.size*3);
    usedVert.forEach(function(vi){
      remap.set(vi,cnt);
      Vout[cnt*3]=V[vi*3];Vout[cnt*3+1]=V[vi*3+1];Vout[cnt*3+2]=V[vi*3+2];
      cnt++;
    });
    var Fout=[];
    for(var f3=0;f3<nf;f3++){
      if(faceOwner[f3]!==targetId) continue;
      Fout.push(remap.get(F[f3*3]), remap.get(F[f3*3+1]), remap.get(F[f3*3+2]));
    }
    var extraOut;
    if(extraVertArrays){
      extraOut={};
      Object.keys(extraVertArrays).forEach(function(name){
        var src=extraVertArrays[name], perVert=src.length/(V.length/3);
        var dst=new src.constructor(cnt*perVert);
        usedVert.forEach(function(vi){
          var ni=remap.get(vi);
          for(var k=0;k<perVert;k++) dst[ni*perVert+k]=src[vi*perVert+k];
        });
        extraOut[name]=dst;
      });
    }
    return {V:Vout, F:Uint32Array.from(Fout), extra:extraOut};
  });
}
P3D.splitMeshByOwner = splitMeshByOwner;

})(window);
