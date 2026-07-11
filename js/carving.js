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

function medianFilter(vals, win){
  var n=vals.length;
  if(n<3) return vals.slice();
  var k=win>>1;
  var out=new Array(n);
  for(var i=0;i<n;i++){
    var a=Math.max(0,i-k), b=Math.min(n,i+k+1);
    var slice=vals.slice(a,b).slice().sort(function(x,y){return x-y;});
    var m=slice.length;
    out[i]= (m%2) ? slice[m>>1] : (slice[(m>>1)-1]+slice[m>>1])/2;
  }
  return out;
}

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
// ★2026-07-04(実機ベンチマークで判明): SimplifyModifier(three.js r128)は
// 頂点数が数万を大きく超える巨大メッシュ(実測: 27,818頂点は成功、280,386頂点は
// 内部で"Cannot read properties of undefined (reading 'hasVertex')"を投げて失敗)
// で不安定になる。失敗時にそのまま間引かずに返すと、ファイルが非常に重くなり
// 目的(軽量化)を果たせないため、SIMPLIFY_SAFE_LIMITを超える場合や
// SimplifyModifier自体が例外を投げた場合は、頂点クラスタリング法
// (gridClusterDecimate、半エッジ構造に依存しないため巨大メッシュでも壊れない)
// にフォールバックする。
var SIMPLIFY_SAFE_LIMIT = 60000;

// 頂点クラスタリングによる間引き(Rossignac&Borrel方式の簡易版)。バウンディング
// ボックスを立方体グリッドに分割し、同じセルに落ちる頂点をその重心1点に
// まとめる。quadric error decimationよりは形状精度が落ちるが、edge collapseの
// ような複雑な半エッジ構造を作らないため、頂点数に関わらず必ず動作する。
function gridClusterDecimate(V, F, targetVerts){
  var n = V.length/3;
  var minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for(var i=0;i<n;i++){
    var x=V[i*3],y=V[i*3+1],z=V[i*3+2];
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z;
  }
  var dx=Math.max(maxX-minX,1e-6), dy=Math.max(maxY-minY,1e-6), dz=Math.max(maxZ-minZ,1e-6);
  // 頂点はメッシュの表面上に分布する(体積ではなく面積に比例)ため、bboxの表面積
  // から目標頂点数に見合うセルサイズを見積もる。
  var surfaceArea = 2*(dx*dy+dy*dz+dz*dx);
  var cellSize = Math.sqrt(surfaceArea / Math.max(targetVerts,1));
  if(!isFinite(cellSize) || cellSize<=0) cellSize = Math.max(dx,dy,dz)/64;

  function cellKey(x,y,z){
    var ix=Math.floor((x-minX)/cellSize), iy=Math.floor((y-minY)/cellSize), iz=Math.floor((z-minZ)/cellSize);
    return ix+","+iy+","+iz;
  }
  var cellMap = new Map();
  for(var v=0;v<n;v++){
    var x2=V[v*3],y2=V[v*3+1],z2=V[v*3+2];
    var key = cellKey(x2,y2,z2);
    var c = cellMap.get(key);
    if(!c){ c={sx:0,sy:0,sz:0,count:0,idx:-1}; cellMap.set(key,c); }
    c.sx+=x2; c.sy+=y2; c.sz+=z2; c.count++;
  }
  var newV = new Float32Array(cellMap.size*3);
  var vi=0;
  cellMap.forEach(function(c){
    newV[vi*3]=c.sx/c.count; newV[vi*3+1]=c.sy/c.count; newV[vi*3+2]=c.sz/c.count;
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
  return {V:newV, F:Uint32Array.from(newFArr)};
}
P3D.gridClusterDecimate = gridClusterDecimate;

// three.js SimplifyModifierを使ったquadric error簡略化。失敗した場合は例外を
//投げる(呼び出し元decimateMesh()がgridClusterDecimateにフォールバックする)。
function simplifyModifierDecimate(V, F, targetVerts){
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(V), 3));
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(F), 1));
  var curVerts = V.length/3;
  var removeCount = Math.max(0, curVerts - targetVerts);
  if(removeCount<=0) return {V:V,F:F};
  var modifier = new THREE.SimplifyModifier();
  var simplified = modifier.modify(geo, removeCount);
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
  return {V:V2, F:newF};
}

// V:Float32Array(N*3), F:Uint32Array(M*3), targetVerts: 目標頂点数
// 戻り値: {V,F} (必ず何らかの方法で間引く。SimplifyModifierが使えない/失敗する
// /メッシュが巨大すぎる場合はgridClusterDecimateにフォールバックする)
function decimateMesh(V, F, targetVerts){
  var targetFaces = Math.max(targetVerts*2, 4);
  var curFaces = F.length/3;
  if(curFaces <= targetFaces) return {V:V, F:F};
  var curVerts = V.length/3;
  var canUseSimplify = (typeof THREE !== "undefined" && THREE.SimplifyModifier && curVerts <= SIMPLIFY_SAFE_LIMIT);
  if(canUseSimplify){
    try{
      return simplifyModifierDecimate(V, F, targetVerts);
    }catch(e){
      console.warn("  decimateMesh: SimplifyModifierに失敗、頂点クラスタリングにフォールバックします:", e);
    }
  }else if(typeof THREE === "undefined" || !THREE.SimplifyModifier){
    console.warn("  decimateMesh: THREE.SimplifyModifier未読み込み、頂点クラスタリングを使用します");
  }else{
    console.log("  decimateMesh: メッシュが大きい(頂点数"+curVerts+" > "+SIMPLIFY_SAFE_LIMIT+")ため、頂点クラスタリングで間引きます");
  }
  return gridClusterDecimate(V, F, targetVerts);
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
// のloadAlphaFromColormap参照)。以前は符号付き体積をメッシュ全体で1回だけ
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
function buildGrid(mxBounds, myBounds, mzBounds, vox){
  var mxMin=mxBounds[0],mxMax=mxBounds[1], myMin=myBounds[0],myMax=myBounds[1], mzMin=mzBounds[0],mzMax=mzBounds[1];
  var nx=Math.max(Math.round((mxMax-mxMin)/vox),4);
  var ny=Math.max(Math.round((myMax-myMin)/vox),4);
  var nz=Math.max(Math.round((mzMax-mzMin)/vox),4);
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
 *   vox, trackWin, smoothIters
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
  // ★2026-07-10: trackGap(track追跡時の行の許容ギャップ)は、track判定を
  // 連結成分ラベリングに置き換えたことで不要になった(位相的に繋がっている
  // かどうかで判定するため、行数ベースの許容ギャップという概念自体が無い)。
  var vox=opts.vox, trackWin=opts.trackWin;
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
  var trackLabels = labelConnectedComponents(
    buildCombinedFrontRaster(fa, ba, faW, faH, backOffsetX, backOffsetY), faW, faH);
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
      var scx=medianFilter(tr3.cx, trackWin), shw=medianFilter(tr3.hw, trackWin);
      for(var i2=0;i2<tr3.rows.length;i2++){
        var iyk=tr3.rows[i2];
        if(!smoothByRow.has(iyk)) smoothByRow.set(iyk, []);
        smoothByRow.get(iyk).push([scx[i2], shw[i2]]);
      }
    });
    return smoothByRow;
  }
  var smoothByRow = buildWidthTracks();

  // ---- 2) 行ごとの奥行き(side画像) ----
  function buildDepthByRow(){
  var depthRows=[]; // [iy, hdFront, hdBack, zc]
  for(var iy2=0; iy2<ny; iy2++){
    var saRow=rowOf1d(sa, saW, spy[iy2]);
    var saPx = saCont ? Common.findRunsSubpixel(saRow, rowOf1d(saCont,saW,spy[iy2]), whiteThr) : Common.findRuns(saRow);
    var zrunsMz = saPx.map(function(pq){ return [(pq[0]-SIDE_REF-sideOffsetX)/SCALE, (pq[1]-SIDE_REF-sideOffsetX)/SCALE]; });
    zrunsMz = intersectIntervals(zrunsMz, mzLim);
    if(!zrunsMz.length) continue;
    // ★2026-07-04(改): 以前は「最大幅のrunを採用」(+vox*3以内の隙間の橋渡し)
    // だったが、顎先と首の間のような実在の凹みで顎側runが分離すると、隙間が
    // 橋渡し閾値を超えた時点で幅の広い首側runに負けて顎の突出が消えていた
    // (閾値依存で直らない)。隙間サイズに依存しないよう、ノイズ幅(vox未満)の
    // runを除いた全runを「前端の最小〜後端の最大」で包む1本の区間として
    // 採用する(エンベロープ)。
    zrunsMz.sort(function(p,q){return p[0]-q[0];});
    var mz0=Infinity, mz1=-Infinity;
    for(var k=0;k<zrunsMz.length;k++){
      if(zrunsMz.length>1 && zrunsMz[k][1]-zrunsMz[k][0]<vox) continue; // ゴミ描線幅は無視
      if(zrunsMz[k][0]<mz0) mz0=zrunsMz[k][0];
      if(zrunsMz[k][1]>mz1) mz1=zrunsMz[k][1];
    }
    if(mz0>mz1){ mz0=zrunsMz[0][0]; mz1=zrunsMz[zrunsMz.length-1][1]; } // 全部ノイズ幅なら全体を包む
    if(mz0<0.0 && 0.0<mz1){
      depthRows.push([iy2, Math.max(mz1,EPS), Math.max(-mz0,EPS), 0.0]);
    }else{
      var zc=(mz0+mz1)/2.0;
      var hw2=Math.max((mz1-mz0)/2.0, EPS);
      depthRows.push([iy2, hw2, hw2, zc]);
    }
  }
    // ★2026-07-04(改): 以前は奥行き(hdFront/hdBack/zc)にも行方向trackWin幅の
    // 中央値フィルタをかけていたが、顎先のような数行分しかない前方突出まで
    // 均されて消えてしまうため、奥行きは生の行ごとの値をそのまま使う
    // (幅セグメント側のトラッキング+中央値平滑化は従来通り)。
    var hdByRow=new Map();
    for(var j=0;j<depthRows.length;j++){
      hdByRow.set(depthRows[j][0], [depthRows[j][1], depthRows[j][2], depthRows[j][3]]);
    }
    return hdByRow;
  }
  var hdByRow = buildDepthByRow();

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

  // ★2026-07-11追加(顔の立体感対応、ユーザー指摘「顔がのっぺりしている」):
  // 頭部も他の部位と同じ「行(y)ごとのスーパー楕円断面」で彫っているため、
  // 立体感はside画像のその行1行ぶんの前後端にしか依存せず出にくい。これは
  // 平滑化の強さとは無関係な、行ベース彫刻という方式そのものの限界。
  // ★2026-07-11(検討の結果、鼻ではなく目窩を対象にした): 当初は鼻先
  // ランドマークに同様の加算式の突起を実装したが、鼻は顔の中心線上にあり
  // side画像のその高さの行スキャンから既に実測の奥行きが出ている(ユーザー
  // 指摘)。そこへ独自パラメータの突起を追加で盛ると、実測の側面イラストと
  // 食い違う奥行きになってしまうため撤回した。目窩(眼球が収まる凹み)は
  // front/back/sideどのシルエット輪郭にも現れない内部形状のため、局所的に
  // 凹ませても輪郭(=元イラストの実測データ)とは矛盾しない。
  // eye_L/eye_Rランドマーク(js/pipeline.jsのbuildDerivedLandmarksでpx→
  // model座標に変換済み)を中心に、彫刻済みのfieldの表層だけを局所的に
  // 凹ませる(min-combineで下げるだけ=既存の奥行きより外側に何かを足す
  // ことは無い→輪郭を壊すリスクが無い)。opts.grid越しに共有fieldへ蓄積
  // するcarveUnifiedRegions経由の呼び出しでも、body(ownerId=0)の
  // carveOptsにだけfaceSculptを渡すことで自然にbodyだけに効く
  // (アクセサリー側はfaceSculpt未設定のため)。
  function applyEyeSocketRecess(field, fs){
    var rx=Math.max(fs.eyeSocketRadiusX,EPS), ry=Math.max(fs.eyeSocketRadiusY,EPS);
    var depth=fs.eyeSocketDepth;
    if(!(depth>0)) return;
    [fs.eyeL, fs.eyeR].forEach(function(eye){
      if(!eye) return;
      var fx=eye[0], fy=eye[1];
      var ix0=Math.max(0, Math.floor((fx-rx-mxMin)/(mxMax-mxMin)*(nx-1)));
      var ix1=Math.min(nx-1, Math.ceil((fx+rx-mxMin)/(mxMax-mxMin)*(nx-1)));
      var iy0=Math.max(0, Math.floor((fy-ry-myMin)/(myMax-myMin)*(ny-1)));
      var iy1=Math.min(ny-1, Math.ceil((fy+ry-myMin)/(myMax-myMin)*(ny-1)));
      for(var iyb=iy0; iyb<=iy1; iyb++){
        var dy=(my[iyb]-fy)/ry;
        var rowOff=iyb*strideY;
        for(var ixb=ix0; ixb<=ix1; ixb++){
          var dx=(mx[ixb]-fx)/rx;
          var w2=dx*dx+dy*dy;
          if(w2>=1) continue; // 楕円footprintの外
          var recessAmt=depth*(1-w2); // 中心で最大depth、footprint縁でゼロになる凹み量
          var base=rowOff+ixb*strideX;
          // この列(ixb,iyb)の現在の最前面(+z側、front方向)の表面位置を探す。
          var surfIz=-1;
          for(var izs=nz-1; izs>=0; izs--){ if(field[base+izs]>0){ surfIz=izs; break; } }
          if(surfIz<0) continue; // この列にまだ何も彫られていない(頭部シルエット外)
          var zSurf=mz[surfIz];
          var izLo=Math.max(0, Math.floor((zSurf-recessAmt-mzMin)/(mzMax-mzMin)*(nz-1)));
          for(var izb=izLo; izb<=surfIz; izb++){
            var t=(zSurf-mz[izb])/recessAmt; // 0(元の表面)→1(凹みの底)
            var val=-t;
            var idx=base+izb;
            if(val<field[idx]) field[idx]=val;
          }
        }
      }
    });
  }

  // ---- 3) 疑似SDFフィールドを彫る(ローカルbbox最適化) ----
  var strideY=nx*nz, strideX=nz;
  // ★2026-07-10(体+アクセサリー統合彫刻対応): opts.accumulateが渡された
  // 場合は新規fieldを割り付けず、呼び出し元(carveUnifiedRegions)が全パーツ
  // 共有で持つfield/ownerFieldへ直接max-combineで書き込む。ownerFieldには
  // 「そのセルを現在勝っている(field値が最大の)パーツのID」を書き込む。
  var accumulate = opts.accumulate;
  var sharedField = accumulate ? accumulate.field : null;
  var sharedOwnerField = accumulate ? accumulate.ownerField : null;
  var ownerId = accumulate ? accumulate.ownerId : 0;
  function carveSdfField(){
  var field = sharedField || new Float32Array(ny*nx*nz).fill(-1.0);
  var ownerField = sharedOwnerField;
  // このbboxの外側は必ずval<=-1相当なので無視できる(psqが小さいほどbboxを
  // 広めに取る必要があるため、使用しうる指数のうち最小値で安全側に倒す)
  var psqMin = Math.min(psqHead,psqTorso,psqLegs,psqArms,psqHands);
  var boundFactor = Math.pow(2, 1/psqMin);

  for(var iy3=0; iy3<ny; iy3++){
    var hd=hdByRow.get(iy3);
    if(!hd) continue;
    var hdFront=hd[0], hdBack=hd[1], zc=hd[2];
    var segsRow=smoothByRow.get(iy3);
    if(!segsRow) continue;
    var rowOff=iy3*strideY;
    var myv=my[iy3];
    var rowPsq=regionPsq(myv); // 腕/手プロファイル対象外の列(頭/胴体/脚)で使う指数
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
        if(handProf && !isNaN(handProf.cy[ix])){
          var uh=Math.abs(myv-handProf.cy[ix]);
          if(uh<=handProf.ry[ix]){
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
          if(val>field[idx]){ field[idx]=val; if(ownerField) ownerField[idx]=ownerId; }
        }
      }
    }
  }
  if(opts.faceSculpt) applyEyeSocketRecess(field, opts.faceSculpt);
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
 * 戻り値: {V,F,owner} (owner: Int32Array、頂点ごとのownerId) または
 *   null(彫れなかった場合)
 */
function carveUnifiedRegions(regions, sharedGrid, minFragFrac){
  var nx=sharedGrid.nx, ny=sharedGrid.ny, nz=sharedGrid.nz;
  var field = new Float32Array(ny*nx*nz).fill(-1.0);
  var ownerField = new Int32Array(ny*nx*nz).fill(-1);
  regions.forEach(function(r){
    var opts = Object.assign({}, r.opts, {
      grid: sharedGrid,
      accumulate: {field:field, ownerField:ownerField, ownerId:r.ownerId},
    });
    carveRegion(opts);
  });

  var anyPositive=false, cntPos=0;
  for(var i=0;i<field.length;i++){ if(field[i]>0){ cntPos++; if(cntPos>=8){anyPositive=true;break;} } }
  if(!anyPositive) return null;

  var mc = P3D.marchingCubes(field, ny, nx, nz, 0.0, ownerField);
  if(!mc.verts.length) return null;
  var nvtx=mc.verts.length/3;
  var mxMin=sharedGrid.mxMin,mxMax=sharedGrid.mxMax,myMin=sharedGrid.myMin,myMax=sharedGrid.myMax,mzMin=sharedGrid.mzMin,mzMax=sharedGrid.mzMax;
  var V=new Float32Array(nvtx*3);
  for(var vi=0; vi<nvtx; vi++){
    var iyF=mc.verts[vi*3], ixF=mc.verts[vi*3+1], izF=mc.verts[vi*3+2];
    V[vi*3]   = ixF/(nx-1)*(mxMax-mxMin)+mxMin;
    V[vi*3+1] = iyF/(ny-1)*(myMax-myMin)+myMin;
    V[vi*3+2] = izF/(nz-1)*(mzMax-mzMin)+mzMin;
  }
  var F=mc.faces;
  var dropped=dropSmallFragments(V,F,minFragFrac,{owner:mc.vertOwner});
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
 * 戻り値: [{V,F}, ...] (ownerIdsと同じ長さ、該当頂点が無ければV,Fとも空)
 */
function splitMeshByOwner(V, F, owner, ownerIds){
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
    if(!usedVert.size) return {V:new Float32Array(0), F:new Uint32Array(0)};
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
    return {V:Vout, F:Uint32Array.from(Fout)};
  });
}
P3D.splitMeshByOwner = splitMeshByOwner;

})(window);
