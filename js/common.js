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
  // ★2026-07-09(左右非対称キャラ対応): leftSide(左向き側面)画像用のズレ補正。
  // 意味・既定値ともside_offset_x/yと同じ(js/accessories.jsのcurSideOffsetX/Y参照)。
  leftside_offset_x: 0, leftside_offset_y: 0,
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

// ---- 一定面積以上の連結成分を全て残す(4連結、OR合成) ----
// largestComponent()は最大成分1つだけを残すため、同一色に塗られた領域が
// 画面内で複数の孤立した塊に分かれるケース(左右別々の房が同色指定、体の
// 別パーツに隠れて視覚的に分断されている等)で小さい方の塊が失われる
// (GHOST_SCANNER_PLAN.md「色分けマップ方式・運用面の修正6点・②」)。
// minAreaPx未満の成分はアンチエイリアス境界のノイズとみなして除外し、
// それ以外の成分は全てOR合成して残す。
function significantComponentsMask(mask, w, h, minAreaPx){
  minAreaPx = (minAreaPx===undefined || minAreaPx===null) ? 16 : minAreaPx;
  var n=w*h;
  var label=new Int32Array(n).fill(-1);
  var labelSize={};
  var stack=[];
  for(var start=0; start<n; start++){
    if(!mask[start] || label[start]!==-1) continue;
    var lab=start, size=0;
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
    labelSize[lab]=size;
  }
  var out=new Uint8Array(n);
  for(var i=0;i<n;i++){
    var lab=label[i];
    if(lab>=0 && labelSize[lab]>=minAreaPx) out[i]=1;
  }
  return out;
}
P3D.significantComponentsMask = significantComponentsMask;

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

// ★2026-07-09(左右非対称キャラ対応): leftSide(左向き側面)画像は、side
// (右向き側面)と全く同じ座標変換式(SIDE_REF起点の(px-SIDE_REF)/SCALE)を
// 再利用できるよう、読み込み時点で水平反転して「characterが右を向いている」
// という既存の規約に合わせる。これによりcarveRegion/sidePointsToModel等、
// 既存の彫刻コードを一切変更せずにleftSide由来のアクセサリーを彫れる。
function flipAlphaHorizontal(alpha, w, h){
  var out=new Uint8Array(w*h);
  for(var y=0;y<h;y++){
    var row=y*w;
    for(var x=0;x<w;x++){ out[row+(w-1-x)] = alpha[row+x]; }
  }
  return out;
}
P3D.flipAlphaHorizontal = flipAlphaHorizontal;
// pxBbox: [x0,y0,x1,y1](画像ピクセル座標)。flipAlphaHorizontalと対になる、
// 同じ水平反転をbboxに適用する版。
function flipBboxHorizontal(bbox, w){
  return [w-bbox[2], bbox[1], w-bbox[0], bbox[3]];
}
P3D.flipBboxHorizontal = flipBboxHorizontal;

// ---- 色分けマップからのマスク抽出(GHOST_SCANNER_PLAN.md「色分けマップ」方式) ----
// アクセサリー領域抽出を「1件ずつ座標を当てさせる」方式から、front/side/back
// 各1枚の色分けマップ画像(体=黒、背景=白、各accessory=パレット色でベタ塗り)
// をGeminiの画像編集で生成し、こちら側のcanvas処理で色ごとに走査して
// マスクを機械的に算出する方式に変更した際に追加。多角形化(輪郭追跡)は
// 行わず、ラスタマスクのまま保持する(多角形手動編集とは別データ形式として
// 並存させる、GHOST_SCANNER_PLAN.md「データモデル」節)。
// hex: "#rrggbb" -> [r,g,b]
function hexToRgb(hex){
  var m = /^#?([0-9a-fA-F]{6})$/.exec(hex||"");
  if(!m) return [0,0,0];
  var n = parseInt(m[1],16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}
P3D.hexToRgb = hexToRgb;

// ctx: CanvasRenderingContext2D(色分けマップ画像が描画済み), w,h: サイズ,
// targetColorHex: 抽出したい色("#rrggbb"), toleranceOpt: 色距離許容誤差
// (デフォルト40。アンチエイリアス境界のにじみを吸収するため、RGB各成分の
// 差の二乗和のルート=ユークリッド距離で判定する)。
// 戻り値: {maskDataUrl, bbox:[x0,y0,x1,y1](ピクセル座標、y0<y1)} | null
// (該当色の画素が1つも無ければnull)。一定面積以上の連結成分を全てOR合成して
// 採用する(GHOST_SCANNER_PLAN.md「運用面の修正6点・②」。以前は最大成分1つ
// だけを採用しており、同一色の領域が複数の孤立した塊に分かれるケースで
// 小さい方が失われていた)。
function extractMaskFromColormap(ctx, w, h, targetColorHex, toleranceOpt, minAreaPxOpt){
  var tol = (toleranceOpt===undefined || toleranceOpt===null) ? 40 : toleranceOpt;
  var target = hexToRgb(targetColorHex);
  var id = ctx.getImageData(0,0,w,h);
  var data = id.data;
  var raw = new Uint8Array(w*h);
  var tol2 = tol*tol;
  for(var i=0,p=0; i<data.length; i+=4,p++){
    var dr=data[i]-target[0], dg=data[i+1]-target[1], db=data[i+2]-target[2];
    if(dr*dr+dg*dg+db*db <= tol2) raw[p]=1;
  }
  var comp = significantComponentsMask(raw, w, h, minAreaPxOpt);
  var x0=w, x1=-1, y0=h, y1=-1, any=false;
  for(var y=0;y<h;y++){
    for(var x=0;x<w;x++){
      if(comp[y*w+x]){
        any=true;
        if(x<x0)x0=x; if(x>x1)x1=x;
        if(y<y0)y0=y; if(y>y1)y1=y;
      }
    }
  }
  if(!any) return null;
  var maskCanvas = document.createElement("canvas");
  maskCanvas.width=w; maskCanvas.height=h;
  var mctx = maskCanvas.getContext("2d");
  var mid = mctx.createImageData(w,h);
  for(var q=0;q<comp.length;q++){
    var v = comp[q] ? 255 : 0;
    mid.data[q*4]=255; mid.data[q*4+1]=255; mid.data[q*4+2]=255; mid.data[q*4+3]=v;
  }
  mctx.putImageData(mid,0,0);
  return { maskDataUrl: maskCanvas.toDataURL("image/png"), bbox:[x0,y0,x1+1,y1+1] };
}
P3D.extractMaskFromColormap = extractMaskFromColormap;

// マスクdataURL(白RGB+アルファ=前景)からUint8Array(w*h, 1=前景)を復元する
// (3D彫刻側/範囲計算側で真偽画素配列として扱いたい箇所向けのヘルパー)。
function maskDataUrlToAlpha(ctx, w, h, maskDataUrl){
  // 呼び出し元はPromiseベースで画像読み込み後にこれを呼ぶ想定(同期版)。
  // ここでは既にdrawImage済みのctxからアルファチャンネルだけ読む単純な実装にする。
  var id = ctx.getImageData(0,0,w,h);
  var out = new Uint8Array(w*h);
  for(var i=0,p=0;i<id.data.length;i+=4,p++){ out[p] = id.data[i+3] > 127 ? 1 : 0; }
  return out;
}
P3D.maskAlphaFromCtx = maskDataUrlToAlpha;

// maskDataUrl(P3D.extractMaskFromColormapの戻り値.maskDataUrl)を実際に画像として
// 読み込み、w×hのUint8Array(1=前景)に変換する非同期版。アクセサリー彫刻
// (accessories.js)が、色分けマップ由来の正確なマスクをfront/back/side画像と
// 同じ座標系のアルファ配列として直接使うために使う(パーツごとに自分の
// front/side/backマスクだけで彫るため。従来はbboxの中を「白背景でないか」で
// 塗り直していたため、bbox内にある体側のピクセルまで拾ってしまっていた)。
function loadMaskAlphaAsync(maskDataUrl, w, h){
  return new Promise(function(resolve, reject){
    var img = new Image();
    img.onload = function(){
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(maskDataUrlToAlpha(ctx, w, h));
    };
    img.onerror = function(){ reject(new Error("マスク画像の読込に失敗しました")); };
    img.src = maskDataUrl;
  });
}
P3D.loadMaskAlphaAsync = loadMaskAlphaAsync;

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

// ---- ランドマーク点描画(landmark_tool.htmlベタ書きからの切り出し、フェーズ0) ----
// ゴーストスキャナー(ghost_scanner.html)側の簡易プレビューでも同じ見た目の
// 点/ラベルを描きたいため、canvasコンテキストと座標だけを受け取る汎用関数として
// ここに集約する(landmark_tool.html側はこの関数を呼ぶだけにする)。
// x: CanvasRenderingContext2D, px/py: 描画先の点(px座標), on: 選択中か, color: 通常色
function drawCross(x,px,py,on,color){
  const r=on?9:6.5;
  x.lineWidth=on?3.4:2.4;x.strokeStyle="rgba(0,0,0,.65)";
  x.beginPath();x.moveTo(px-r,py);x.lineTo(px+r,py);x.moveTo(px,py-r);x.lineTo(px,py+r);x.stroke();
  x.lineWidth=on?1.8:1.2;x.strokeStyle=on?"#ffe14d":color;
  x.beginPath();x.moveTo(px-r,py);x.lineTo(px+r,py);x.moveTo(px,py-r);x.lineTo(px,py+r);x.stroke();
}
P3D.drawCross = drawCross;
function drawLabel(x,text,px,py,color){
  x.font="bold 11px sans-serif";x.textAlign="center";
  x.lineWidth=3;x.strokeStyle="rgba(0,0,0,.75)";x.strokeText(text,px,py);
  x.fillStyle=color;x.fillText(text,px,py);
}
P3D.drawLabel = drawLabel;
// アクセサリー等の可変N点多角形の輪郭線描画。呼び出し側で既にビュー座標
// (拡大/パン込みのpx座標)に変換した点配列を渡す想定(このツール自体は
// ビュー変換の詳細を知らない、純粋な描画プリミティブ)。
// x: CanvasRenderingContext2D, ptsPx: [[px,py],...] (2点未満は何もしない), color: 線色
function drawPolygonOutline(x,ptsPx,color){
  if(!ptsPx||ptsPx.length<2)return;
  x.save();x.lineWidth=2;x.strokeStyle=color;x.beginPath();
  x.moveTo(ptsPx[0][0],ptsPx[0][1]);
  for(let i=1;i<ptsPx.length;i++){ x.lineTo(ptsPx[i][0],ptsPx[i][1]); }
  x.closePath();x.stroke();x.restore();
}
P3D.drawPolygonOutline = drawPolygonOutline;

// ---- ランドマーク定義/色(landmark_tool.htmlベタ書きからの切り出し、フェーズ0) ----
// 解剖学的ランドマーク定義とグループ色(骨格関節点18+目/口角4=計22点)。ゴーストスキャナーのプレビューでも
// landmark_tool.htmlと全く同じ点定義・配色を使いたいためここに集約する。
var LM=[
 {k:"head_top",jp:"頭頂",g:"head",desc:"頭のてっぺん(髪を含めた輪郭の一番上)"},
 {k:"chin",jp:"あご",g:"head",desc:"あごの先端(顔の輪郭で一番下の点。髪で隠れていても実際の輪郭位置)"},
 // ★2026-07-08追加: 現時点では彫刻パイプライン(carveRegion等)はこの2点を
 // 未使用(将来、表情/顔パーツ位置合わせ等で使う可能性があるための先行追加)。
 // 未使用のため彫刻結果には影響しないが、マーク済みの位置として保存・表示は
 // される(landmark_tool.htmlのplaceAll()が自動配置の粗い初期値を置く)。
 {k:"eye_L",jp:"目L",g:"face",desc:"左目(画面に向かって左側)の中心"},
 {k:"eye_R",jp:"目R",g:"face",desc:"右目(画面に向かって右側)の中心"},
 {k:"mouth_L",jp:"口角L",g:"face",desc:"口の左端(画面に向かって左側の口角)"},
 {k:"mouth_R",jp:"口角R",g:"face",desc:"口の右端(画面に向かって右側の口角)"},
 {k:"clavicle_L",jp:"鎖骨L",g:"torso",desc:"鎖骨(首の付け根と肩の間、体の中心寄り。肩関節そのものではない)"},
 {k:"clavicle_R",jp:"鎖骨R",g:"torso",desc:"鎖骨(首の付け根と肩の間、体の中心寄り。肩関節そのものではない)"},
 {k:"shoulder_L",jp:"肩L",g:"arm",desc:"肩関節(腕が胴体に接続する回転軸の位置。腕の付け根の一番外側ではなく、腕がそこを軸に回る点)"},
 {k:"shoulder_R",jp:"肩R",g:"arm",desc:"肩関節(腕が胴体に接続する回転軸の位置。腕の付け根の一番外側ではなく、腕がそこを軸に回る点)"},
 {k:"elbow_L",jp:"肘L",g:"arm",desc:"肘関節(腕が曲がる位置)"},
 {k:"elbow_R",jp:"肘R",g:"arm",desc:"肘関節(腕が曲がる位置)"},
 {k:"wrist_L",jp:"手首L",g:"arm",desc:"手首関節(手のひらの付け根。指先ではない)"},
 {k:"wrist_R",jp:"手首R",g:"arm",desc:"手首関節(手のひらの付け根。指先ではない)"},
 {k:"waist_L",jp:"腰L",g:"torso",desc:"胴が一番くびれている高さの、体の左右の輪郭端(ウエストの一番細い所)"},
 {k:"waist_R",jp:"腰R",g:"torso",desc:"胴が一番くびれている高さの、体の左右の輪郭端(ウエストの一番細い所)"},
 {k:"hip",jp:"股",g:"leg",desc:"股(両脚の間、脚の付け根の中心点)"},
 {k:"knee_L",jp:"膝L",g:"leg",desc:"膝関節(脚が曲がる位置)"},
 {k:"knee_R",jp:"膝R",g:"leg",desc:"膝関節(脚が曲がる位置)"},
 {k:"ankle_L",jp:"足首L",g:"leg",desc:"足首関節(すねと足の境目)"},
 {k:"ankle_R",jp:"足首R",g:"leg",desc:"足首関節(すねと足の境目)"},
 {k:"toe_L",jp:"つま先L",g:"leg",desc:"つま先(靴/足の輪郭で一番前の点)"},
 {k:"toe_R",jp:"つま先R",g:"leg",desc:"つま先(靴/足の輪郭で一番前の点)"},
];
P3D.LM = LM;
var GCOL={head:"#52e0c4",face:"#c9a0ff",arm:"#ffb454",torso:"#7aa2ff",leg:"#ff6ad5"};
P3D.GCOL = GCOL;
var LM_GROUP_ORDER=["head","face","torso","arm","leg"];
P3D.LM_GROUP_ORDER = LM_GROUP_ORDER;
var LM_GROUP_JP={head:"頭部",face:"顔",torso:"胴体",arm:"腕",leg:"脚"};
P3D.LM_GROUP_JP = LM_GROUP_JP;

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
