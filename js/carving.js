// -*- coding: utf-8 -*-
// pipeline_lib/carving.py の carve_region() のJS移植(3DtoolJS)。
// Python版はnumpyのブロードキャストで(nx,nz)全域に対して行/セグメントごとに
// 疑似SDFを書き込むが、JSは素朴なループになるため、影響が及ぶ範囲(セグメントの
// 半幅/半奥行きのbound_factor倍以内)だけを更新するローカルbbox最適化を入れて
// 実用的な速度にする(結果は数式的に同一、計算を省くだけ)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};
var C = P3D.common = P3D; // common.jsの関数はP3D直下にある
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

// polyXY: [[x,y],...] (モデル座標の閉多角形), y: 水平線
// 戻り値: [[x0,x1],...] (偶奇則によるx区間)
function polygonRowIntervals(polyXY, y){
  var n=polyXY.length, xs=[];
  for(var i=0;i<n;i++){
    var x1=polyXY[i][0], y1=polyXY[i][1];
    var j=(i+1)%n, x2=polyXY[j][0], y2=polyXY[j][1];
    if(y1===y2) continue;
    if(Math.min(y1,y2)<=y && y<Math.max(y1,y2)){
      var t=(y-y1)/(y2-y1);
      xs.push(x1+t*(x2-x1));
    }
  }
  xs.sort(function(a,b){return a-b;});
  var out=[];
  for(var k=0;k+1<xs.length - (xs.length%2);k+=2) out.push([xs[k],xs[k+1]]);
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

// V:Float32Array(N*3), F:Uint32Array(M*3) -> 最大連結成分に対しminFrac未満の
// 断片を除去(union-find)
function dropSmallFragments(V, F, minFrac){
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
  if(allKept) return {V:V,F:F};
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
  return {V:V2, F:Uint32Array.from(faceOut)};
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

// 面法線から頂点法線を再計算し、符号付き体積で外向きか判定して巻きを補正する。
function computeNormalsFixWinding(V, F){
  function calc(F){
    var n=V.length/3, nf=F.length/3;
    var Nv=new Float32Array(n*3);
    for(var f=0;f<nf;f++){
      var ia=F[f*3],ib=F[f*3+1],ic=F[f*3+2];
      var ax=V[ia*3],ay=V[ia*3+1],az=V[ia*3+2];
      var bx=V[ib*3],by=V[ib*3+1],bz=V[ib*3+2];
      var cx=V[ic*3],cy=V[ic*3+1],cz=V[ic*3+2];
      var ux=bx-ax, uy=by-ay, uz=bz-az;
      var wx=cx-ax, wy=cy-ay, wz=cz-az;
      var nx=uy*wz-uz*wy, ny=uz*wx-ux*wz, nz=ux*wy-uy*wx;
      Nv[ia*3]+=nx;Nv[ia*3+1]+=ny;Nv[ia*3+2]+=nz;
      Nv[ib*3]+=nx;Nv[ib*3+1]+=ny;Nv[ib*3+2]+=nz;
      Nv[ic*3]+=nx;Nv[ic*3+1]+=ny;Nv[ic*3+2]+=nz;
    }
    for(var v=0;v<n;v++){
      var x=Nv[v*3],y=Nv[v*3+1],z=Nv[v*3+2];
      var len=Math.sqrt(x*x+y*y+z*z)+1e-9;
      Nv[v*3]=x/len;Nv[v*3+1]=y/len;Nv[v*3+2]=z/len;
    }
    return Nv;
  }
  function signedVolume(F){
    var nf=F.length/3, vol=0;
    for(var f=0;f<nf;f++){
      var ia=F[f*3],ib=F[f*3+1],ic=F[f*3+2];
      var ax=V[ia*3],ay=V[ia*3+1],az=V[ia*3+2];
      var bx=V[ib*3],by=V[ib*3+1],bz=V[ib*3+2];
      var cx=V[ic*3],cy=V[ic*3+1],cz=V[ic*3+2];
      var cxv=by*cz-bz*cy, cyv=bz*cx-bx*cz, czv=bx*cy-by*cx;
      vol += ax*cxv+ay*cyv+az*czv;
    }
    return vol/6.0;
  }
  var Nv=calc(F);
  var vol=signedVolume(F);
  if(vol<0){
    var nf=F.length/3;
    var F2=new Uint32Array(F.length);
    for(var f=0;f<nf;f++){ F2[f*3]=F[f*3]; F2[f*3+1]=F[f*3+2]; F2[f*3+2]=F[f*3+1]; }
    F=F2;
    Nv=calc(F);
  }
  return {N:Nv, F:F};
}
P3D.computeNormalsFixWinding = computeNormalsFixWinding;

// (旧findArmCrossings: 行ごとの骨線分X交点方式は削除。腕の太さの測定は
// carveRegion内のbuildBoneProfiles(列ごとのy方向走査)に置き換えた。)

// linspace(min,max,n)相当(n>=2前提、Python np.linspaceと同じ: 端点を含みn-1等分)
function linspace(a,b,n){
  var out=new Float64Array(n);
  if(n===1){ out[0]=a; return out; }
  var step=(b-a)/(n-1);
  for(var i=0;i<n;i++) out[i]=a+step*i;
  return out;
}
P3D.linspace = linspace;

/**
 * carve_region()のJS移植。
 * opts: {
 *   fa,ba,sa: Uint8Array(w*h) 2値シルエット(front/back/side、1=前景)
 *   faW,faH: front/backの画像サイズ(back/frontは同サイズ前提, side別サイズ)
 *   saW,saH: side画像のサイズ
 *   faCont,baCont,saCont: 連続値配列(Float32Array、サブピクセル補正用、無ければnull)
 *   SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF: キャリブレーション値
 *   mxBounds,myBounds,mzBounds: [min,max]
 *   vox, psqHull, trackGap, trackWin, smoothIters
 *   frontPolygon, backPolygon, sidePolygon: [[x,y],...] | null (アクセサリー用)
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
  // ★2026-07-05: 背面画像は前面画像とは別に撮影/作画されているため、シルエットの
  // 水平中心が前面のCXと正確に一致するとは限らない(実測でも数%ズレることがある)。
  // 一致する前提で(faW-CX)を使うと、背面全体が一定量ズレて見える。呼び出し側が
  // 背面シルエット自身から求めたCXBackを渡してきた場合はそれを使い、無ければ
  // 従来通り前面基準のミラー(faW-CX)にフォールバックする。
  var CXBack = (opts.CXBack!==undefined && opts.CXBack!==null) ? opts.CXBack : (faW-CX);
  var mxB=opts.mxBounds, myB=opts.myBounds, mzB=opts.mzBounds;
  var vox=opts.vox, psqHull=opts.psqHull, trackGap=opts.trackGap, trackWin=opts.trackWin;
  var smoothIters=opts.smoothIters||0;
  var frontPolygon=opts.frontPolygon||null, backPolygon=opts.backPolygon||null, sidePolygon=opts.sidePolygon||null;
  var armLines=opts.armLines||null, armMaxHw=opts.armMaxHw||0.07;
  var handLines=opts.handLines||null, handDepthHw=opts.handDepthHw||0.02, handMaxHw=opts.handMaxHw||0.06;
  var whiteThr=opts.whiteThr!==undefined?opts.whiteThr:250;

  var mxMin=mxB[0],mxMax=mxB[1], myMin=myB[0],myMax=myB[1], mzMin=mzB[0],mzMax=mzB[1];
  var nx=Math.max(Math.round((mxMax-mxMin)/vox),4);
  var ny=Math.max(Math.round((myMax-myMin)/vox),4);
  var nz=Math.max(Math.round((mzMax-mzMin)/vox),4);
  var mx=linspace(mxMin,mxMax,nx), my=linspace(myMin,myMax,ny), mz=linspace(mzMin,mzMax,nz);

  function rowOf1d(arr, w, y){ return arr.subarray(y*w, y*w+w); }

  var fy=new Int32Array(ny), spy=new Int32Array(ny);
  for(var iy0=0;iy0<ny;iy0++){
    fy[iy0]=Math.min(Math.max(Math.round(YBOT-my[iy0]*SCALE),0),faH-1);
    var v_=1.0-my[iy0];
    spy[iy0]=Math.min(Math.max(Math.round(SYTOP+v_*(SYBOT-SYTOP)),0),saH-1);
  }
  var mxLim=[[mx[0],mx[nx-1]]];
  var mzLim=[[mz[0],mz[nz-1]]];
  var xyPolygon = frontPolygon || backPolygon;

  // ---- 1) 行ごとの幅セグメント(front/back)、行トラッキング+中央値フィルタ ----
  var tracks=[]; // {rows:[],cx:[],hw:[],lastIy,lastCx}
  for(var iy=0; iy<ny; iy++){
    var faRow=rowOf1d(fa, faW, fy[iy]), baRow=rowOf1d(ba, faW, fy[iy]);
    var frPx = faCont ? C.findRunsSubpixel(faRow, rowOf1d(faCont,faW,fy[iy]), whiteThr) : C.findRuns(faRow);
    var brPx = baCont ? C.findRunsSubpixel(baRow, rowOf1d(baCont,faW,fy[iy]), whiteThr) : C.findRuns(baRow);
    var fr=frPx.map(function(pq){ return [(pq[0]-CX)/SCALE, (pq[1]-CX)/SCALE]; });
    var br=brPx.map(function(pq){ return [(CXBack-pq[1])/SCALE, (CXBack-pq[0])/SCALE]; });
    var runsVal = intersectIntervals(intersectIntervals(fr,br), mxLim);
    // ★2026-07-04: アクセサリー(ポリゴン指定あり)では、front/backの絵柄の
    // 描かれ方が行単位で食い違う(片方だけ描線が途切れる等)と交差が空になり
    // その行のメッシュが丸ごと欠落していた。ポリゴンで範囲が明示されている
    // 場合は、交差が空なら描かれている方の面のrunだけで続行する。
    if(xyPolygon && !runsVal.length){
      runsVal = intersectIntervals(fr.length ? fr : br, mxLim);
    }
    if(xyPolygon) runsVal = intersectIntervals(runsVal, polygonRowIntervals(xyPolygon, my[iy]));
    var segs=[];
    for(var i=0;i<runsVal.length;i++){
      var r0=runsVal[i][0], r1=runsVal[i][1];
      if(r1-r0>=vox) segs.push([(r0+r1)/2.0, Math.max((r1-r0)/2.0, EPS)]);
    }
    for(var s=0;s<segs.length;s++){
      var cx=segs[s][0], hw=segs[s][1];
      var best=-1, bestd=Infinity;
      for(var ti=0;ti<tracks.length;ti++){
        var tr=tracks[ti];
        if(iy-tr.lastIy>trackGap) continue;
        var d=Math.abs(cx-tr.lastCx);
        var lastHw=tr.hw[tr.hw.length-1];
        var thresh=Math.min(Math.max(hw,lastHw)*1.2, 0.025);
        var ratio=hw/lastHw;
        if(d<thresh && ratio>=0.4 && ratio<=2.5 && d<bestd){ best=ti; bestd=d; }
      }
      if(best===-1){
        tracks.push({rows:[iy],cx:[cx],hw:[hw],lastIy:iy,lastCx:cx});
      }else{
        var tr2=tracks[best];
        tr2.rows.push(iy); tr2.cx.push(cx); tr2.hw.push(hw);
        tr2.lastIy=iy; tr2.lastCx=cx;
      }
    }
  }
  var smoothByRow=new Map(); // iy -> [[cx,hw],...]
  for(var t=0;t<tracks.length;t++){
    var tr3=tracks[t];
    var scx=medianFilter(tr3.cx, trackWin), shw=medianFilter(tr3.hw, trackWin);
    for(var i2=0;i2<tr3.rows.length;i2++){
      var iyk=tr3.rows[i2];
      if(!smoothByRow.has(iyk)) smoothByRow.set(iyk, []);
      smoothByRow.get(iyk).push([scx[i2], shw[i2]]);
    }
  }

  // ---- 2) 行ごとの奥行き(side画像) ----
  var depthRows=[]; // [iy, hdFront, hdBack, zc]
  for(var iy2=0; iy2<ny; iy2++){
    var saRow=rowOf1d(sa, saW, spy[iy2]);
    var saPx = saCont ? C.findRunsSubpixel(saRow, rowOf1d(saCont,saW,spy[iy2]), whiteThr) : C.findRuns(saRow);
    var zrunsMz = saPx.map(function(pq){ return [(pq[0]-SIDE_REF)/SCALE, (pq[1]-SIDE_REF)/SCALE]; });
    zrunsMz = intersectIntervals(zrunsMz, mzLim);
    if(sidePolygon){
      // ★2026-07-04: アクセサリーの側面ポリゴンが指定されている行では、side画像
      // の描線が薄い/途切れている等でrunが取れなくても行を捨てず、描いた側面
      // ポリゴンの区間そのものを奥行きとして使う(側面領域を「必ず」奥行きに
      // 反映する)。従来はrunが取れない行が丸ごと欠落し、アクセサリーが歯抜け
      // の薄い円盤状になることがあった。
      var polyIv = intersectIntervals(polygonRowIntervals(sidePolygon, my[iy2]), mzLim);
      if(!polyIv.length) continue; // ポリゴンの縦範囲外
      var clipped = intersectIntervals(zrunsMz, polyIv);
      zrunsMz = clipped.length ? clipped : polyIv;
    }
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
  var field=new Float32Array(ny*nx*nz).fill(-1.0);
  var boundFactor = Math.pow(2, 1/psqHull); // このbboxの外側は必ずval<=-1相当なので無視できる

  for(var iy3=0; iy3<ny; iy3++){
    var hd=hdByRow.get(iy3);
    if(!hd) continue;
    var hdFront=hd[0], hdBack=hd[1], zc=hd[2];
    var segsRow=smoothByRow.get(iy3);
    if(!segsRow) continue;
    var rowOff=iy3*strideY;
    var myv=my[iy3];
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
        var zr=-1, exVal=-1;
        if(handProf && !isNaN(handProf.cy[ix])){
          var uh=Math.abs(myv-handProf.cy[ix]);
          if(uh<=handProf.ry[ix]){
            // ★2026-07-04(改2): 手の奥行きはside計測もシルエット縦幅も使わず、
            // 設定値handDepthHwをそのまま採用する(ユーザー指定)。
            zr=Math.max(handDepthHw, EPS);
            exVal=0.0; // 押し出し: 断面はz方向のみで決め、x/yはシルエットと縦幅で切る
          }else if(uh<=handProf.ry[ix]*boundFactor){
            continue; // デッドゾーン
          }
        }
        if(exVal<0 && armProf && !isNaN(armProf.cy[ix])){
          var ua=Math.abs(myv-armProf.cy[ix]);
          if(ua<armProf.ry[ix]){
            zr=armProf.rz[ix];
            exVal=Math.pow(ua/armProf.ry[ix], psqHull); // 傾いた円柱の縦断面プロファイル
          }else if(ua<armProf.ry[ix]*boundFactor){
            continue; // デッドゾーン
          }
        }
        if(exVal<0) exVal=Math.pow(Math.abs(xv-cx2)/hw3, psqHull);
        if(exVal>=2) continue;
        // z範囲は列ごとに決める(腕/手はz原点対称、胴体はzc基準の非対称)
        var izLoC, izHiC;
        if(zr>=0){ izLoC=-zr*boundFactor; izHiC=zr*boundFactor; }
        else{ izLoC=zc-hdBack*boundFactor; izHiC=zc+hdFront*boundFactor; }
        var iz0=Math.max(0, Math.floor((izLoC-mzMin)/(mzMax-mzMin)*(nz-1)));
        var iz1=Math.min(nz-1, Math.ceil((izHiC-mzMin)/(mzMax-mzMin)*(nz-1)));
        if(iz0>iz1) continue;
        var base=rowOff+ix*strideX;
        for(var iz=iz0; iz<=iz1; iz++){
          var mzv=mz[iz];
          var ez;
          if(zr>=0){
            ez=Math.pow(Math.abs(mzv)/zr, psqHull); // 腕=円形/手=押し出し(z原点対称)
          }else{
            var hdv = (mzv>=zc) ? hdFront : hdBack;
            ez=Math.pow(Math.abs(mzv-zc)/hdv, psqHull);
          }
          var val=1.0-(exVal+ez);
          var idx=base+iz;
          if(val>field[idx]) field[idx]=val;
        }
      }
    }
  }

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
  var dropped=dropSmallFragments(V,F);
  V=dropped.V; F=dropped.F;

  if(smoothIters>0) V=laplacianSmooth(V,F,smoothIters);

  return {V:V, F:F}; // 法線計算・decimationは呼び出し側(visual_hull.js/accessories.js)で行う
}
P3D.carveRegion = carveRegion;

})(window);
