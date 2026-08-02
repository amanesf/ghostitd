// -*- coding: utf-8 -*-
// VEO_VIDEO_TO_3D_PLAN.md §4(Stage1: フレーム抽出)のJS実装。
// ★M1スコープでの簡略化: WebCodecs VideoDecoderは生の符号化フレームを
// 受け取る前提で、mp4コンテナからのデマルチプレクスには別途ライブラリが
// 要る(このリポジトリはビルドなし・外部CDN依存なしが方針のため導入しない)。
// そのため本ファイルは計画書が「フォールバック」と位置付けている
// <video>要素のseek方式のみを実装する(WebCodecs第一候補の実装は見送り、
// 将来必要になれば別途追加する)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

// 1フレーム(canvas)のブレ量を推定する簡易指標。
// 本物のラプラシアン分散(2階微分の分散)は縦横2方向の畳み込みが要るが、
// フレーム枚数分(数十〜百枚程度)×フル解像度で行うと重いため、ここでは
// グレースケールに間引いた上で1次元差分(水平方向)の分散を代理指標として使う。
// 値が小さいほどブレている(エッジが乏しい)とみなす。
function estimateSharpness(imageData){
  var d=imageData.data, w=imageData.width, h=imageData.height;
  var stepX=Math.max(1, Math.floor(w/256)), stepY=Math.max(1, Math.floor(h/256));
  var sum=0, sumSq=0, n=0;
  for(var y=0; y<h; y+=stepY){
    var rowOff=y*w*4;
    var prevGray=null;
    for(var x=0; x<w; x+=stepX){
      var idx=rowOff+x*4;
      var gray=0.299*d[idx]+0.587*d[idx+1]+0.114*d[idx+2];
      if(prevGray!==null){
        var diff=gray-prevGray;
        sum+=diff; sumSq+=diff*diff; n++;
      }
      prevGray=gray;
    }
  }
  if(n<2) return 0;
  var mean=sum/n;
  return sumSq/n - mean*mean; // 分散
}
P3D.estimateFrameSharpness = estimateSharpness;

// 2枚のimageDataの近さ(重複フレーム判定用)。間引いたピクセルの平均絶対差。
function frameDiff(a, b){
  var da=a.data, db=b.data, w=a.width, h=a.height;
  var stepX=Math.max(1, Math.floor(w/128)), stepY=Math.max(1, Math.floor(h/128));
  var sum=0, n=0;
  for(var y=0; y<h; y+=stepY){
    var rowOff=y*w*4;
    for(var x=0; x<w; x+=stepX){
      var idx=rowOff+x*4;
      sum += Math.abs(da[idx]-db[idx]) + Math.abs(da[idx+1]-db[idx+1]) + Math.abs(da[idx+2]-db[idx+2]);
      n++;
    }
  }
  return n ? sum/n : 0;
}
P3D.frameDiff = frameDiff;

/**
 * videoFile: File|Blob (mp4)
 * opts: {targetCount(既定64), dupThreshold(既定1.5), onProgress(frac)}
 * 戻り値: Promise<{frames:[{t, imageData}], width, height, duration, fps}>
 * §4の方針: N=48〜96(既定64)を時間軸で等間隔サンプリングし、ブレ・重複を除外する。
 * 生fps・生フレーム数には依存しない(<video>のseekは時間指定のため)。
 */
async function extractVideoFrames(videoFile, opts){
  opts = opts || {};
  var targetCount = opts.targetCount || 64;
  var dupThreshold = (opts.dupThreshold===undefined) ? 1.5 : opts.dupThreshold;
  var onProgress = opts.onProgress || function(){};

  var url = URL.createObjectURL(videoFile);
  var video = document.createElement("video");
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  await new Promise(function(resolve, reject){
    video.onloadedmetadata = function(){ resolve(); };
    video.onerror = function(){ reject(new Error("動画の読み込みに失敗しました")); };
  });
  var w = video.videoWidth, h = video.videoHeight, duration = video.duration;
  if(!w || !h || !duration){
    URL.revokeObjectURL(url);
    throw new Error("動画のサイズ・長さが取得できませんでした");
  }

  var canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  var ctx = canvas.getContext("2d", {willReadFrequently:true});

  function seekTo(t){
    return new Promise(function(resolve, reject){
      function onSeeked(){ video.removeEventListener("seeked", onSeeked); resolve(); }
      video.addEventListener("seeked", onSeeked);
      video.onerror = function(){ reject(new Error("シークに失敗しました(t="+t+")")); };
      video.currentTime = Math.min(t, Math.max(0, duration-0.001));
    });
  }

  // 候補時刻: [0, duration)をtargetCount等分(末尾フレームも欲しいので
  // duration*(k+0.5)/targetCountの中点サンプリングにする)。
  var candidates = [];
  for(var k=0; k<targetCount; k++){
    candidates.push(duration * (k+0.5)/targetCount);
  }

  var raw = [];
  for(var i=0;i<candidates.length;i++){
    await seekTo(candidates[i]);
    ctx.drawImage(video, 0, 0, w, h);
    var imageData = ctx.getImageData(0, 0, w, h);
    var sharpness = estimateSharpness(imageData);
    raw.push({t:candidates[i], imageData:imageData, sharpness:sharpness});
    onProgress((i+1)/candidates.length);
  }
  URL.revokeObjectURL(url);

  // ブレフィルタ: 中央値の一定割合未満のシャープネスは除外候補とする
  // (全滅を避けるため、除外後にtargetCountの半分を下回りそうなら緩める)。
  var sharpVals = raw.map(function(r){ return r.sharpness; }).sort(function(a,b){return a-b;});
  var median = sharpVals[Math.floor(sharpVals.length/2)] || 0;
  var blurMinRatio = 0.15;
  var filtered = raw.filter(function(r){ return r.sharpness >= median*blurMinRatio; });
  if(filtered.length < Math.max(8, targetCount*0.5)) filtered = raw; // 緩めても足りないなら諦めて全部使う

  // 重複フレーム除外: 直前に採用したフレームとの差が閾値未満ならスキップ
  var deduped = [];
  var prevImg = null;
  filtered.forEach(function(r){
    if(prevImg && frameDiff(r.imageData, prevImg) < dupThreshold) return;
    deduped.push(r);
    prevImg = r.imageData;
  });
  if(deduped.length < 8) deduped = filtered; // 削りすぎたら諦めて使う

  var fps = raw.length>1 ? (raw.length/duration) : 30;
  return {
    frames: deduped.map(function(r){ return {t:r.t, imageData:r.imageData, sharpness:r.sharpness}; }),
    width: w, height: h, duration: duration, fps: fps,
    rawCount: raw.length, filteredCount: filtered.length,
  };
}
P3D.extractVideoFrames = extractVideoFrames;

})(window);
