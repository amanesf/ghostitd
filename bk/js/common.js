// -*- coding: utf-8 -*-
// 3Dtool(Python版)pipeline_lib/common.pyのJS移植 + 座標ヘルパー。
// ブラウザ完結版(3DtoolJS)の全モジュールが読む共通ユーティリティ。
// window.P3D 名前空間にぶら下げる(素朴な<script>読み込みなのでESモジュール不使用)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

// ---- モデル生成パラメータの既定値 ----
// Python版(pipeline_lib/common.py)はbody_vox=0.002/body_target_verts=50000だが、
// ブラウザ版はvox解像度に応じたraw頂点数がJSの素朴なmarching cubesループの
// 速度に直結し、かつ間引き(three.js SimplifyModifier)が数万頂点を大きく超える
// メッシュで不安定になる(実機ベンチマークで確認: 27,818頂点は成功、280,386頂点
// では内部エラー)。そのため3DtoolJS版はbody_voxを粗め(0.005)にし、大抵の
// キャラクターでraw頂点数がtarget_verts以下に収まる(=間引き自体が不要になる)
// ことを狙う既定値にしていたが(2026-07-04)、その後ファイルサイズ/軽量性を
// 優先する方針に変更し、body_target_verts/acc_target_vertsは大きく引き下げて
// 積極的に間引く既定値にしている(2026-07-06)。
// 高解像度で試したい場合は「パラメータ」タブから引き上げられる(その場合は
// carving.jsのSIMPLIFY_SAFE_LIMITを超えるとquadric decimationの代わりに
// 頂点クラスタリングにフォールバックする)。
var DEFAULT_GEN_PARAMS = {
  body_vox: 0.003, acc_vox: 0.003,
  body_decimate: true, body_target_verts: 3000,
  acc_decimate: true, acc_target_verts: 1000,
  // ★2026-07-06: 断面スーパー楕円の指数はこれまで全身共通(psq_hull)の1個
  // だったが、部位ごとに理想的な丸み/角ばりが異なる(頭は卵型に近く丸め、
  // 腕は円筒に近いほど自然、手は厚み一定の板に近いため角を立たせたい等)
  // ため部位別に分割する。左右対称な部位(腕/脚/手)はL/Rで値を分けず1個の
  // パラメータを共有する(見た目上、体の対称性を壊す理由がないため)。
  // 各既定値は現行の2.2(楕円と矩形の中間よりやや矩形寄り)を基準に、
  // 部位の実際の断面形状に合わせて調整したオススメ値。
  psq_head: 2.0, psq_torso: 2.2, psq_legs: 2.2, psq_arms: 2.0, psq_hands: 3.0, psq_acc: 2.2,
  track_gap: 6, track_win: 1,
  body_smooth_iters: 0, acc_smooth_iters: 0,
  arm_circle: true, arm_tol: 0.06, arm_max_hw: 0.2,
  hand_extrude: true, hand_depth: 0.01, hand_max_hw: 0.1, hand_len: 0.25,
  subpixel: true,
  white_thr: 240, alpha_dilate: 9,
  band_h: 220, band_overlap: 40,
  kb_per_face: 200,
  // ★2026-07-05: 背面/側面写真はそれぞれ別に撮影/作画されるため、前面基準の
  // CX/SCALE/YBOTをそのまま流用(鏡像)する彫り出し/テクスチャ変換に、
  // 素材ごとの微妙なズレが残ることがある。自動推定(シルエット計測)は
  // 後れ毛等のノイズを拾って余計に暴れることが分かったため、シルエット
  // 解析による自動補正はせず、ユーザーが実際の見た目を見ながら手で追い込める
  // 単純な定数pxオフセットとして用意する(既定0=補正なし)。
  back_offset_x: 0, back_offset_y: 0,
  side_offset_x: 0, side_offset_y: 0,
};
P3D.DEFAULT_GEN_PARAMS = DEFAULT_GEN_PARAMS;

// ---- 行ラン検出(common.find_runs/find_runs_subpixelのJS移植) ----
// mask: Uint8Array/Array(0/1 or bool), gap: 許容ギャップ(px)
function findRuns(mask, gap){
  gap = gap || 1;
  var out=[], n=mask.length, s=-1, p=-1;
  for(var x=0;x<n;x++){
    if(mask[x]){
      if(s<0){s=x;p=x;}
      else if(x<=p+gap){p=x;}
      else{ out.push([s,p]); s=x; p=x; }
    }
  }
  if(s>=0) out.push([s,p]);
  return out;
}
P3D.findRuns = findRuns;

function subpixelEdge(cont, iIn, iOut, thr){
  var vIn=cont[iIn], vOut=cont[iOut];
  if(vOut===vIn) return iIn;
  var t=(thr-vIn)/(vOut-vIn);
  if(t<0)t=0; if(t>1)t=1;
  return iIn + t*(iOut-iIn);
}
// mask: 2値run検出用, cont: 2値化前の連続値(min(R,G,B)等), thr: 2値化しきい値
function findRunsSubpixel(mask, cont, thr, gap){
  var runs=findRuns(mask, gap);
  var n=mask.length, out=[];
  for(var i=0;i<runs.length;i++){
    var s=runs[i][0], e=runs[i][1];
    var rs = (s-1>=0) ? subpixelEdge(cont, s, s-1, thr) : s;
    var re = (e+1<n) ? subpixelEdge(cont, e, e+1, thr) : e;
    out.push([rs, re]);
  }
  return out;
}
P3D.findRunsSubpixel = findRunsSubpixel;

// ---- 数値ヘルパー ----
function median(arr){
  if(!arr.length) return 0;
  var a=arr.slice().sort(function(x,y){return x-y;});
  var n=a.length, mid=n>>1;
  return (n%2) ? a[mid] : (a[mid-1]+a[mid])/2;
}
P3D.median = median;

// np.interp相当: xp昇順前提、xpの範囲外はクランプ(np.interpのデフォルトと同じ)
function interp1d(x, xp, fp){
  var n=xp.length;
  if(x<=xp[0]) return fp[0];
  if(x>=xp[n-1]) return fp[n-1];
  // 二分探索
  var lo=0, hi=n-1;
  while(hi-lo>1){
    var mid=(lo+hi)>>1;
    if(xp[mid]<=x) lo=mid; else hi=mid;
  }
  var t=(x-xp[lo])/(xp[hi]-xp[lo]);
  return fp[lo] + t*(fp[hi]-fp[lo]);
}
P3D.interp1d = interp1d;

// エッジパディングの移動平均(profile.py/skeleton.pyの sm()/smooth1() 相当)
function smoothEdgePad(arr, win){
  win = win || 5;
  var n=arr.length;
  if(n < Math.max(6, win+1)) return arr.slice();
  var k = win>>1;
  var out = new Array(n);
  for(var i=0;i<n;i++){
    var a=Math.max(0,i-k), b=Math.min(n,i+k+1);
    var s=0; for(var j=a;j<b;j++) s+=arr[j];
    out[i]=s/(b-a);
  }
  return out;
}
P3D.smoothEdgePad = smoothEdgePad;

// ---- 座標変換(common.py MX/MY/py_of/spy_ofのJS移植) ----
function MX(px, cx, scale){ return (px-cx)/scale; }
function MY(py, ybot, scale){ return (ybot-py)/scale; }
function pyOf(v, ytop, ybot){ return Math.round(ytop + v*(ybot-ytop)); }
function spyOf(v, sytop, sybot){ return Math.round(sytop + v*(sybot-sytop)); }
P3D.MX=MX; P3D.MY=MY; P3D.pyOf=pyOf; P3D.spyOf=spyOf;

// ---- 画像 -> ImageData取得ヘルパー ----
function imageToImageData(img, w, h){
  w = w || img.naturalWidth || img.width;
  h = h || img.naturalHeight || img.height;
  var c=document.createElement("canvas"); c.width=w; c.height=h;
  var ctx=c.getContext("2d"); ctx.drawImage(img,0,0,w,h);
  return ctx.getImageData(0,0,w,h);
}
P3D.imageToImageData = imageToImageData;

// ---- 背景マスク(common.white_background_maskのJS移植) ----
// rgba: ImageData.data (Uint8ClampedArray, RGBA), w,h: サイズ
// alsoPassable: Uint8Array(w*h)、1=通行可能として扱う(除外マスクのブリッジ用)
// 戻り値: Uint8Array(w*h)、1=背景
function whiteBackgroundMask(rgba, w, h, whiteThr, alsoPassable){
  whiteThr = (whiteThr===undefined) ? 250 : whiteThr;
  var n=w*h;
  var passable=new Uint8Array(n);
  for(var i=0;i<n;i++){
    var o=i*4;
    var r=rgba[o],g=rgba[o+1],b=rgba[o+2];
    var mn=Math.min(r,g,b);
    passable[i] = (mn>whiteThr) ? 1 : 0;
  }
  if(alsoPassable){
    for(var i2=0;i2<n;i2++){ if(alsoPassable[i2]) passable[i2]=1; }
  }
  // 外周(画像の縁)に連結したpassable領域だけをBFSでbackgroundとする
  var bg=new Uint8Array(n);
  var visited=new Uint8Array(n);
  var stack=[];
  function pushIfPassable(idx){
    if(!visited[idx] && passable[idx]){ visited[idx]=1; stack.push(idx); }
  }
  for(var x=0;x<w;x++){ pushIfPassable(x); pushIfPassable((h-1)*w+x); }
  for(var y=0;y<h;y++){ pushIfPassable(y*w); pushIfPassable(y*w+(w-1)); }
  while(stack.length){
    var idx=stack.pop();
    bg[idx]=1;
    var x=idx%w, y=(idx/w)|0;
    if(x>0) pushIfPassable(idx-1);
    if(x<w-1) pushIfPassable(idx+1);
    if(y>0) pushIfPassable(idx-w);
    if(y<h-1) pushIfPassable(idx+w);
    // 8連結(ndimage.labelの既定structureが8連結のため一致させる)
    if(x>0&&y>0) pushIfPassable(idx-w-1);
    if(x<w-1&&y>0) pushIfPassable(idx-w+1);
    if(x>0&&y<h-1) pushIfPassable(idx+w-1);
    if(x<w-1&&y<h-1) pushIfPassable(idx+w+1);
  }
  return bg;
}
P3D.whiteBackgroundMask = whiteBackgroundMask;

// ---- 連結成分の穴埋め(scipy.ndimage.binary_fill_holesのJS簡易版) ----
// mask: Uint8Array(w*h) 1=前景。外周から辿れない0領域(=穴)を1で埋める。
function fillHoles(mask, w, h){
  var n=w*h;
  var outside=new Uint8Array(n); // 1=外周から辿れる背景(=真の外側)
  var visited=new Uint8Array(n);
  var stack=[];
  function push(idx){ if(!visited[idx] && !mask[idx]){ visited[idx]=1; stack.push(idx);} }
  for(var x=0;x<w;x++){ push(x); push((h-1)*w+x); }
  for(var y=0;y<h;y++){ push(y*w); push(y*w+(w-1)); }
  while(stack.length){
    var idx=stack.pop(); outside[idx]=1;
    var x=idx%w, y=(idx/w)|0;
    if(x>0) push(idx-1); if(x<w-1) push(idx+1);
    if(y>0) push(idx-w); if(y<h-1) push(idx+w);
  }
  var out=new Uint8Array(n);
  for(var i=0;i<n;i++) out[i] = mask[i] ? 1 : (outside[i] ? 0 : 1);
  return out;
}
P3D.fillHoles = fillHoles;

// ---- 最大連結成分だけを残す(4連結) ----
function largestComponent(mask, w, h){
  var n=w*h;
  var label=new Int32Array(n).fill(-1);
  var bestLabel=-1, bestSize=0;
  var stack=[];
  for(var start=0; start<n; start++){
    if(!mask[start] || label[start]!==-1) continue;
    var lab = start; // ラベルIDは開始indexで代用
    var size=0;
    stack.push(start); label[start]=lab;
    while(stack.length){
      var idx=stack.pop(); size++;
      var x=idx%w, y=(idx/w)|0;
      var nbrs=[];
      if(x>0)nbrs.push(idx-1); if(x<w-1)nbrs.push(idx+1);
      if(y>0)nbrs.push(idx-w); if(y<h-1)nbrs.push(idx+w);
      for(var k=0;k<nbrs.length;k++){
        var ni=nbrs[k];
        if(mask[ni] && label[ni]===-1){ label[ni]=lab; stack.push(ni); }
      }
    }
    if(size>bestSize){ bestSize=size; bestLabel=lab; }
  }
  var out=new Uint8Array(n);
  if(bestLabel>=0){ for(var i=0;i<n;i++) if(label[i]===bestLabel) out[i]=1; }
  return out;
}
P3D.largestComponent = largestComponent;

// ---- 背景除去(prep.load_rgba_remove_whiteのJS移植) ----
// img: HTMLImageElement, whiteThr: number, excludeMask: Uint8Array(w*h)|null
// 戻り値: {w,h,rgba(Uint8ClampedArray,元画像そのまま), alpha(Uint8Array, 1=前景)}
function loadRgbaRemoveWhite(img, whiteThr, excludeMask){
  var w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
  var id=imageToImageData(img, w, h);
  var background = whiteBackgroundMask(id.data, w, h, whiteThr, excludeMask);
  var bridgedHole = new Uint8Array(w*h);
  var hasExclude=false;
  if(excludeMask){ for(var i=0;i<excludeMask.length;i++){ if(excludeMask[i]){hasExclude=true;break;} } }
  if(hasExclude){
    var backgroundNoBridge = whiteBackgroundMask(id.data, w, h, whiteThr, null);
    for(var i2=0;i2<bridgedHole.length;i2++){
      bridgedHole[i2] = (background[i2] && !backgroundNoBridge[i2]) ? 1 : 0;
    }
  }
  var alpha=new Uint8Array(w*h);
  for(var i3=0;i3<alpha.length;i3++) alpha[i3] = background[i3] ? 0 : 1;
  alpha = largestComponent(alpha, w, h);
  alpha = fillHoles(alpha, w, h);
  for(var i4=0;i4<alpha.length;i4++){ if(bridgedHole[i4]) alpha[i4]=0; }
  return {w:w, h:h, rgba:id.data, alpha:alpha};
}
P3D.loadRgbaRemoveWhite = loadRgbaRemoveWhite;

// ---- 縁の色にじみ(prep.stage_bleedのJS移植) ----
// 透明画素を最も近い不透明画素のRGBで埋め(distance_transform_edtのindices相当を
// 多元BFSで代用)、アルファをalphaDilate回だけ膨張させる。
// 戻り値: 新しいImageData(w,h) と同サイズのUint8ClampedArray rgba。
function bleedEdges(rgba, w, h, alpha, alphaDilate){
  alphaDilate = (alphaDilate===undefined) ? 9 : alphaDilate;
  var n=w*h;
  var nearestIdx=new Int32Array(n).fill(-1);
  var dist=new Int32Array(n).fill(-1);
  var visited=new Uint8Array(n);
  var queue=[]; var qh=0;
  for(var i=0;i<n;i++){ if(alpha[i]){ nearestIdx[i]=i; dist[i]=0; visited[i]=1; queue.push(i); } }
  // ★2026-07-05: 以前はキャンバス全域まで最近傍色を無制限に伝播していたため、
  // Tポーズの袖・脚等にある細かい帯模様(リストバンド等)の色が背景の遠くまで
  // 直線的なボロノイ境界として伸び、輪郭からわずかにはみ出た頂点(髪の房・
  // アクセサリーの縁など、実シルエットよりわずかに広いUVを持つ面)がその
  // ボロノイ模様を拾って縞々に見える不具合の原因になっていた。にじみは
  // 縁からBLEED_MAX_DISTだけに制限し、それより遠くは(白いはずの)元の背景
  // ピクセルへ戻す。
  var BLEED_MAX_DIST = Math.max(alphaDilate*4, 40);
  while(qh<queue.length){
    var idx=queue[qh++];
    if(dist[idx]>=BLEED_MAX_DIST) continue;
    var src=nearestIdx[idx];
    var x=idx%w, y=(idx/w)|0;
    var nbrs=[];
    if(x>0)nbrs.push(idx-1); if(x<w-1)nbrs.push(idx+1);
    if(y>0)nbrs.push(idx-w); if(y<h-1)nbrs.push(idx+w);
    for(var k=0;k<nbrs.length;k++){
      var ni=nbrs[k];
      if(!visited[ni]){ visited[ni]=1; nearestIdx[ni]=src; dist[ni]=dist[idx]+1; queue.push(ni); }
    }
  }
  var outRgba=new Uint8ClampedArray(n*4);
  for(var i2=0;i2<n;i2++){
    var farOrUnreached = (nearestIdx[i2]<0) || (dist[i2]>BLEED_MAX_DIST);
    var src2 = farOrUnreached ? i2 : nearestIdx[i2];
    var so=src2*4, o=i2*4;
    outRgba[o]=rgba[so]; outRgba[o+1]=rgba[so+1]; outRgba[o+2]=rgba[so+2]; outRgba[o+3]=255;
  }
  // アルファ膨張(iterations回、4連結の単純膨張。ndimage.binary_dilationの既定=4連結相当)
  var dilated = alpha;
  for(var it=0; it<alphaDilate; it++){
    var next=new Uint8Array(n);
    for(var y2=0;y2<h;y2++){
      for(var x2=0;x2<w;x2++){
        var idx2=y2*w+x2;
        if(dilated[idx2]){ next[idx2]=1; continue; }
        var on=false;
        if(x2>0&&dilated[idx2-1])on=true;
        if(!on&&x2<w-1&&dilated[idx2+1])on=true;
        if(!on&&y2>0&&dilated[idx2-w])on=true;
        if(!on&&y2<h-1&&dilated[idx2+w])on=true;
        next[idx2]=on?1:0;
      }
    }
    dilated=next;
  }
  for(var i3=0;i3<n;i3++){ outRgba[i3*4+3] = dilated[i3] ? 255 : 0; }
  return outRgba;
}
P3D.bleedEdges = bleedEdges;

// ---- 前景マスクの収縮(erosion, 4連結、N回) ----
// mask: Uint8Array(w*h) 1=前景。境界からiterations px分だけ内側に後退させた
// マスクを返す(輪郭線除去プレビュー: 前景マスクをNpx収縮して「外周の帯」を
// 求めるために使う)。
function erodeMaskPx(mask, w, h, iterations){
  iterations = iterations || 0;
  var cur = mask;
  for(var it=0; it<iterations; it++){
    var next=new Uint8Array(w*h);
    for(var y=0;y<h;y++){
      for(var x=0;x<w;x++){
        var idx=y*w+x;
        if(!cur[idx]){ next[idx]=0; continue; }
        var keep = (x>0?cur[idx-1]:0) && (x<w-1?cur[idx+1]:0) &&
                   (y>0?cur[idx-w]:0) && (y<h-1?cur[idx+w]:0);
        next[idx] = keep ? 1 : 0;
      }
    }
    cur = next;
  }
  return cur;
}
P3D.erodeMaskPx = erodeMaskPx;

// ---- シルエット外周の黒い輪郭線除去(プレビュー用) ----
// 前景マスクをbandPx収縮し、前景かつ収縮後マスクの外側にある「帯」の中で
// 暗い(輝度<darkThr)ピクセルだけを、bleedEdgesのBFSを反転させた方向
// (帯の暗ピクセル→最も近い健全な前景色)で塗りのばして置き換える。
// シード(健全色の供給元)は「前景かつ帯の暗ピクセルではない」画素全体
// (=収縮後の内部領域＋帯の中の明るい画素)なので、輪郭線がシルエットの
// 外周だけにあるという前提の下では内部の黒髪・黒服などは一切変更されない
// (収縮によって内部領域自体がそもそも帯の外＝対象外になるため)。
// rgba: Uint8ClampedArray(w*h*4), alpha: Uint8Array(w*h) 1=前景
// 戻り値: 新しいUint8ClampedArray(w*h*4)(alphaはそのまま維持)
function removeSilhouetteOutline(rgba, w, h, alpha, bandPx, darkThr){
  bandPx = (bandPx===undefined) ? 6 : bandPx;
  darkThr = (darkThr===undefined) ? 90 : darkThr;
  var n = w*h;
  if(bandPx<=0) return new Uint8ClampedArray(rgba);
  var eroded = erodeMaskPx(alpha, w, h, bandPx);
  var darkBand = new Uint8Array(n);
  for(var i=0;i<n;i++){
    if(!alpha[i] || eroded[i]) continue; // 前景外 or 内部領域は対象外
    var o=i*4;
    var lum = 0.299*rgba[o] + 0.587*rgba[o+1] + 0.114*rgba[o+2];
    if(lum < darkThr) darkBand[i]=1;
  }
  // 多元BFS: シード=前景かつdarkBandでない画素。前景内だけを伝播して
  // darkBand画素へ最も近い健全画素のindexを求める(bleedEdgesと同じBFSを
  // 「透明→不透明」ではなく「帯の暗部→帯外の健全前景」方向に使う)。
  var nearestIdx=new Int32Array(n).fill(-1);
  var visited=new Uint8Array(n);
  var queue=[]; var qh=0;
  for(var i2=0;i2<n;i2++){
    if(alpha[i2] && !darkBand[i2]){ nearestIdx[i2]=i2; visited[i2]=1; queue.push(i2); }
  }
  while(qh<queue.length){
    var idx=queue[qh++];
    var src=nearestIdx[idx];
    var x=idx%w, y=(idx/w)|0;
    var nbrs=[];
    if(x>0)nbrs.push(idx-1); if(x<w-1)nbrs.push(idx+1);
    if(y>0)nbrs.push(idx-w); if(y<h-1)nbrs.push(idx+w);
    for(var k=0;k<nbrs.length;k++){
      var ni=nbrs[k];
      if(!visited[ni] && alpha[ni]){ visited[ni]=1; nearestIdx[ni]=src; queue.push(ni); }
    }
  }
  var out = new Uint8ClampedArray(rgba);
  for(var i3=0;i3<n;i3++){
    if(!darkBand[i3]) continue;
    var src2 = nearestIdx[i3];
    if(src2<0) continue;
    var so=src2*4, oo=i3*4;
    out[oo]=rgba[so]; out[oo+1]=rgba[so+1]; out[oo+2]=rgba[so+2];
  }
  return out;
}
P3D.removeSilhouetteOutline = removeSilhouetteOutline;

// ---- 複数のTypedArrayを1本に連結する ----
// pipeline.js(stageAccessories内)とaccessories.jsで同一の実装(concatF32)が
// 重複していたため、頂点(V/N)・スキニング(J/W)いずれの連結にも使える形で
// ここに集約する(Ctorを渡せばFloat32Array/Uint16Array等どれでも使える)。
function concatTypedArrays(Ctor, arrs){
  var total = 0;
  arrs.forEach(function(a){ total += a.length; });
  var out = new Ctor(total), off = 0;
  arrs.forEach(function(a){ out.set(a, off); off += a.length; });
  return out;
}
P3D.concatTypedArrays = concatTypedArrays;

// ---- スライダー(<input type=range>)をつまみ(thumb)付近でのみ操作可能にする ----
// ネイティブのrange inputは、つまみ以外のトラック部分をタップしただけでも
// 即座にその位置へ値がジャンプする仕様のため、誤操作(意図せずパラメータが
// 変わってしまう)が起きやすい。つまみの現在位置に十分近い場所から操作を
// 開始した場合のみ許可し、それ以外はpointerdownを無視(preventDefault)する。
// landmark_tool.html/character_3d.html両方が本ファイルを読み込むため、ここに
// documentへの委譲リスナーとして実装することで全range inputに一括で効かせる。
document.addEventListener('pointerdown', function(e){
  var el = e.target;
  if(!el || el.tagName!=='INPUT' || el.type!=='range') return;
  var rect = el.getBoundingClientRect();
  if(rect.width<=0) return;
  var min=parseFloat(el.min), max=parseFloat(el.max), val=parseFloat(el.value);
  if(!isFinite(min)) min=0;
  if(!isFinite(max)) max=100;
  if(!isFinite(val)) val=min;
  var frac = max>min ? (val-min)/(max-min) : 0;
  frac = Math.max(0, Math.min(1, frac));
  // ブラウザ既定のrange thumb幅(Chromium系の実測値。本プロジェクトはCSSで
  // thumbの見た目を変更していないため既定サイズを前提にできる)。
  var thumbW = 16;
  var usable = Math.max(1, rect.width - thumbW);
  var thumbCenterX = rect.left + thumbW/2 + frac*usable;
  var tolerance = 14; // つまみ中心からこの範囲内なら「つまみに触れた」とみなす
  if(Math.abs(e.clientX - thumbCenterX) > tolerance){
    e.preventDefault();
  }
}, {capture:true, passive:false});

})(window);
