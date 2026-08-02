// -*- coding: utf-8 -*-
// VEO_VIDEO_TO_3D_PLAN.md §5(Stage2: シルエット・符号付き距離場)のJS実装。
// 2値マスク(Uint8Array、1=前景)から符号付き距離場(Float32Array、
// 内側は正・外側は負、単位はpx)を作る。距離変換自体はFelzenszwalb&
// Huttenlocher方式の2パス(行→列)1次元変換を使う(scipyのdistance_transform_edt
// と同じ厳密ユークリッド距離)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

var INF = 1e20;

// 1次元の距離変換(Felzenszwalb & Huttenlocher 2004)。
// f: 各セルの「そこが前景なら0、そうでなければINF」の入力配列。
// 戻り値: 各セルから最も近い0地点までの距離の2乗。
function dt1d(f, n){
  var d = new Float64Array(n);
  var v = new Int32Array(n);
  var z = new Float64Array(n+1);
  var k = 0;
  v[0]=0; z[0]=-INF; z[1]=INF;
  for(var q=1; q<n; q++){
    var s;
    while(true){
      var vk=v[k];
      s = ((f[q]+q*q) - (f[vk]+vk*vk)) / (2*q - 2*vk);
      if(s <= z[k]){ k--; if(k<0){k=0;break;} continue; }
      break;
    }
    k++;
    v[k]=q; z[k]=s; z[k+1]=INF;
  }
  k=0;
  for(var qq=0; qq<n; qq++){
    while(z[k+1] < qq) k++;
    var vv=v[k];
    d[qq] = (qq-vv)*(qq-vv) + f[vv];
  }
  return d;
}

// mask(Uint8Array, 1=前景)から「各セルから最も近い"mask===targetVal"地点までの
// ユークリッド距離」を計算する(2パス: 各行→各列)。
function distanceTransform(mask, w, h, targetVal){
  var big = INF;
  var g = new Float64Array(w*h);
  // 行方向
  var rowBuf = new Float64Array(w);
  for(var y=0;y<h;y++){
    for(var x=0;x<w;x++) rowBuf[x] = (mask[y*w+x]===targetVal) ? 0 : big;
    var rowD = dt1d(rowBuf, w);
    for(var x2=0;x2<w;x2++) g[y*w+x2] = rowD[x2];
  }
  // 列方向
  var out = new Float32Array(w*h);
  var colBuf = new Float64Array(h);
  for(var x3=0;x3<w;x3++){
    for(var y2=0;y2<h;y2++) colBuf[y2] = g[y2*w+x3];
    var colD = dt1d(colBuf, h);
    for(var y3=0;y3<h;y3++) out[y3*w+x3] = Math.sqrt(colD[y3]);
  }
  return out;
}
P3D.distanceTransform = distanceTransform;

/**
 * mask: Uint8Array(w*h) 1=前景(キャラクター)、0=背景
 * 戻り値: Float32Array(w*h) 符号付き距離場(px単位。内側は正、外側は負、
 *   境界付近は線形勾配としてmarching-cubes的なバイリニア補間に使える)
 */
function signedDistanceField(mask, w, h){
  var distOut = distanceTransform(mask, w, h, 0); // 前景セルからの、最寄りの背景(0)までの距離
  var distIn  = distanceTransform(mask, w, h, 1); // 背景セルからの、最寄りの前景(1)までの距離
  var sdf = new Float32Array(w*h);
  for(var i=0;i<w*h;i++){
    sdf[i] = mask[i] ? distOut[i] : -distIn[i];
  }
  return sdf;
}
P3D.signedDistanceField = signedDistanceField;

// sdf(w*h)を実数座標(px, 小数可)でバイリニアサンプルする。範囲外は大きな負値。
function sampleSdfBilinear(sdf, w, h, x, y){
  if(x<0 || y<0 || x>w-1 || y>h-1) return -1e6;
  var x0=Math.floor(x), y0=Math.floor(y);
  var x1=Math.min(x0+1, w-1), y1=Math.min(y0+1, h-1);
  var fx=x-x0, fy=y-y0;
  var v00=sdf[y0*w+x0], v10=sdf[y0*w+x1], v01=sdf[y1*w+x0], v11=sdf[y1*w+x1];
  var top = v00*(1-fx) + v10*fx;
  var bot = v01*(1-fx) + v11*fx;
  return top*(1-fy) + bot*fy;
}
P3D.sampleSdfBilinear = sampleSdfBilinear;

/**
 * 前景シルエットマスクを画像から抽出する(§2「四隅パッチから背景色推定→
 * 色距離」+ 既存のsignificantComponentsMask/fillHoles(js/common.js)を流用)。
 * imageData: canvas ImageData(RGBA)
 * opts: {colorTolerance(既定40), minAreaPx(既定16)}
 * 戻り値: Uint8Array(w*h) 1=前景
 */
function silhouetteFromImageData(imageData, opts){
  opts = opts || {};
  var tol = (opts.colorTolerance===undefined) ? 40 : opts.colorTolerance;
  var d = imageData.data, w = imageData.width, h = imageData.height;
  // 四隅5x5パッチの平均色を背景色とみなす
  var patches = [[0,0],[w-5,0],[0,h-5],[w-5,h-5]];
  var br=0, bg=0, bb=0, bn=0;
  patches.forEach(function(p){
    for(var yy=p[1]; yy<p[1]+5 && yy<h; yy++){
      for(var xx=p[0]; xx<p[0]+5 && xx<w; xx++){
        var idx=(yy*w+xx)*4;
        br+=d[idx]; bg+=d[idx+1]; bb+=d[idx+2]; bn++;
      }
    }
  });
  br/=bn; bg/=bn; bb/=bn;

  var mask = new Uint8Array(w*h);
  for(var i=0;i<w*h;i++){
    var idx=i*4;
    var dr=d[idx]-br, dg=d[idx+1]-bg, db=d[idx+2]-bb;
    var dist = Math.sqrt(dr*dr+dg*dg+db*db);
    mask[i] = (dist > tol) ? 1 : 0;
  }
  mask = P3D.significantComponentsMask(mask, w, h, opts.minAreaPx||16);
  // ★ターンテーブル動画の全身シルエットは(髪の房が体から分離して映る場合を
  // 除けば)基本的に単一の連結領域であるはず。GHOST_SCANNER_PLAN.mdの色分け
  // マップ抽出(複数accessoryが同色で分離しうる)とは前提が異なるため、ここでは
  // 最大連結成分だけを残す(小さな浮遊ノイズ・動画の再圧縮で白背景に残った
  // 淡いターンテーブル台座の影などがキャラクターと分離した別成分として
  // 検出された場合に、彫刻結果へ浮遊した塊として混入するのを防ぐ)。
  mask = largestComponentMask(mask, w, h);
  mask = P3D.fillHoles(mask, w, h);
  return {mask:mask, bgColor:[br,bg,bb]};
}
P3D.silhouetteFromImageData = silhouetteFromImageData;

// mask(Uint8Array, 1=前景)のうち、最大の連結成分(4連結)だけを残す。
function largestComponentMask(mask, w, h){
  var n = w*h;
  var label = new Int32Array(n).fill(-1);
  var sizes = [];
  var stack = [];
  for(var start=0; start<n; start++){
    if(!mask[start] || label[start]!==-1) continue;
    var lab = sizes.length;
    var size = 0;
    stack.push(start); label[start]=lab;
    while(stack.length){
      var idx = stack.pop(); size++;
      var x=idx%w, y=(idx/w)|0;
      var nbrs=[];
      if(x>0)nbrs.push(idx-1); if(x<w-1)nbrs.push(idx+1);
      if(y>0)nbrs.push(idx-w); if(y<h-1)nbrs.push(idx+w);
      for(var k=0;k<nbrs.length;k++){
        var ni=nbrs[k];
        if(mask[ni] && label[ni]===-1){ label[ni]=lab; stack.push(ni); }
      }
    }
    sizes.push(size);
  }
  if(sizes.length===0) return mask;
  var bestLab=0;
  for(var i=1;i<sizes.length;i++){ if(sizes[i]>sizes[bestLab]) bestLab=i; }
  var out = new Uint8Array(n);
  for(var j=0;j<n;j++){ out[j] = (label[j]===bestLab) ? 1 : 0; }
  return out;
}
P3D.largestComponentMask = largestComponentMask;

// マスクの外接矩形([x0,y0,x1,y1]、無ければnull)
function maskBBox(mask, w, h){
  var x0=w, y0=h, x1=-1, y1=-1;
  for(var y=0;y<h;y++){
    var rowOff=y*w;
    for(var x=0;x<w;x++){
      if(mask[rowOff+x]){
        if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
      }
    }
  }
  if(x1<0) return null;
  return [x0,y0,x1,y1];
}
P3D.maskBBox = maskBBox;

})(window);
