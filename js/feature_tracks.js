// -*- coding: utf-8 -*-
// VEO_VIDEO_TO_3D_PLAN.md §16「方針転換: 色・特徴の追跡で立体を取る
// 『回転ステレオ』方式」のStage B実装(特徴検出→隣接フレームNCC追跡→
// (x,z)線形フィット→3Dアンカー点群+全トラック残差の交互最小化による
// フレーム別θ/ドリフト/スケール精密化)。
//
// 固定カメラ+Y軸回転+弱透視の前提では、表面点(x,y,z)のフレームiでの投影は
//   u_i = cx_i + s_i・(x・cosθ_i + z・sinθ_i)   … (x,z)について線形
//   v_i = ybot_i − s_i・(y − yMin)              … フレームによらずほぼ一定
// となる(計画書§16参照)。1つの特徴点を複数フレーム追跡してu_iを集めれば
// (x,z)は2元の線形最小二乗で閉形式に求まり、v_iのフレーム間ドリフトが
// そのままフレーム別較正誤差(ybot/scale/θ)の実測値になる。この対応関係を
// 使い、js/turntable_calib.jsのrefineCalibrationAnalysisBySynthesis(彫刻結果
// への再投影IoU座標降下)を置き換える、より高速・高精度な同時較正を提供する。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

// ---------------------------------------------------------------------
// グレースケール変換・パッチ抽出・NCC
// ★特徴は輝度勾配のコーナー検出で取る(色境界そのものではなく輝度勾配を
// 見ている)。このリポジトリが対象にする素材(アニメ塗り+黒い輪郭線)では
// 色境界のほとんどに輪郭線由来の輝度コントラストが伴うため、輝度コーナーで
// 実用上ほぼ拾える。色相のみが変わり輝度がほぼ同じ境界(まれ)は取りこぼす
// が、そうした境界はそもそも幾何誤差が目立ちにくい平坦域である。
// ---------------------------------------------------------------------

function grayscaleFromImageData(imageData){
  var d = imageData.data, w = imageData.width, h = imageData.height;
  var gray = new Float32Array(w*h);
  for(var i=0, p=0; i<w*h; i++, p+=4){
    gray[i] = 0.299*d[p] + 0.587*d[p+1] + 0.114*d[p+2];
  }
  return gray;
}
P3D.grayscaleFromImageData = grayscaleFromImageData;

function sampleBilinearGray(gray, w, h, x, y){
  if(x<0) x=0; if(y<0) y=0;
  if(x>w-1) x=w-1; if(y>h-1) y=h-1;
  var x0=Math.floor(x), y0=Math.floor(y);
  var x1=Math.min(x0+1, w-1), y1=Math.min(y0+1, h-1);
  var fx=x-x0, fy=y-y0;
  var v00=gray[y0*w+x0], v10=gray[y0*w+x1], v01=gray[y1*w+x0], v11=gray[y1*w+x1];
  var top = v00*(1-fx) + v10*fx;
  var bot = v01*(1-fx) + v11*fx;
  return top*(1-fy) + bot*fy;
}

// (2r+1)x(2r+1)パッチを(cx,cy)中心(小数可、バイリニア補間)で抽出する。
// outを渡せばスクラッチバッファとして使い回せる(探索窓の中で毎回新規
// 割り当てするとGC圧力が高いため)。
function extractPatch(gray, w, h, cx, cy, r, out){
  var size = (2*r+1)*(2*r+1);
  if(!out) out = new Float32Array(size);
  var k=0;
  for(var dy=-r; dy<=r; dy++){
    for(var dx=-r; dx<=r; dx++){
      out[k++] = sampleBilinearGray(gray, w, h, cx+dx, cy+dy);
    }
  }
  return out;
}
P3D.extractGrayPatch = extractPatch;

// 正規化相互相関(NCC)。範囲は[-1,1]、分散が無い(平坦)パッチ同士は-1を返す
// (「一致なし」として扱われ、平坦な背景領域が誤って高スコアを得るのを防ぐ)。
function nccScore(a, b){
  var n = a.length;
  var sa=0, sb=0;
  for(var i=0;i<n;i++){ sa+=a[i]; sb+=b[i]; }
  var ma=sa/n, mb=sb/n;
  var num=0, da=0, db=0;
  for(var j=0;j<n;j++){
    var va=a[j]-ma, vb=b[j]-mb;
    num += va*vb; da += va*va; db += vb*vb;
  }
  var denom = Math.sqrt(da*db);
  return denom>1e-6 ? num/denom : -1;
}
P3D.nccScore = nccScore;

// ---------------------------------------------------------------------
// 特徴検出: Shi-Tomasi(最小固有値)コーナー検出+格子ベースの簡易NMS
// ---------------------------------------------------------------------

// 縦横integral image(累積和)。boxSumで矩形和をO(1)で引くための前処理。
function integralImage(src, w, h){
  var W = w+1;
  var integ = new Float64Array(W*(h+1));
  for(var y=0; y<h; y++){
    var rowSum = 0;
    var rowOff = y*w, outRowOff = (y+1)*W, prevRowOff = y*W;
    for(var x=0; x<w; x++){
      rowSum += src[rowOff+x];
      integ[outRowOff+x+1] = integ[prevRowOff+x+1] + rowSum;
    }
  }
  return integ;
}
function boxSum(integ, w, h, x0, y0, x1, y1){
  x0 = Math.max(0,x0); y0 = Math.max(0,y0);
  x1 = Math.min(w-1,x1); y1 = Math.min(h-1,y1);
  if(x1<x0 || y1<y0) return 0;
  var W = w+1;
  return integ[(y1+1)*W+(x1+1)] - integ[y0*W+(x1+1)] - integ[(y1+1)*W+x0] + integ[y0*W+x0];
}

/**
 * gray: Float32Array(w*h)
 * mask: Uint8Array(w*h)|null (1=前景。指定時は前景のみ候補にする)
 * opts: {windowRadius(既定3), maxFeatures(既定150), nmsRadius(既定14),
 *        marginPx(既定windowRadius+4)}
 * 戻り値: [{x,y,score}] (score降順)
 */
function detectFeatureCorners(gray, w, h, mask, opts){
  opts = opts || {};
  var wr = opts.windowRadius || 3;
  var maxFeatures = opts.maxFeatures || 150;
  var nmsRadius = opts.nmsRadius || 14;
  var marginPx = opts.marginPx || (wr+4);

  var n = w*h;
  var Ix = new Float32Array(n), Iy = new Float32Array(n);
  for(var y=1; y<h-1; y++){
    var rowOff=y*w;
    for(var x=1; x<w-1; x++){
      var i = rowOff+x;
      Ix[i] = (gray[i+1]-gray[i-1])*0.5;
      Iy[i] = (gray[i+w]-gray[i-w])*0.5;
    }
  }
  var Ixx = new Float32Array(n), Iyy = new Float32Array(n), Ixy = new Float32Array(n);
  for(var j=0;j<n;j++){
    var ix=Ix[j], iy=Iy[j];
    Ixx[j]=ix*ix; Iyy[j]=iy*iy; Ixy[j]=ix*iy;
  }
  var Sxx = integralImage(Ixx, w, h);
  var Syy = integralImage(Iyy, w, h);
  var Sxy = integralImage(Ixy, w, h);

  var candidates = [];
  for(var yy=marginPx; yy<h-marginPx; yy++){
    for(var xx=marginPx; xx<w-marginPx; xx++){
      var idx = yy*w+xx;
      if(mask && !mask[idx]) continue;
      var sxx = boxSum(Sxx,w,h,xx-wr,yy-wr,xx+wr,yy+wr);
      var syy = boxSum(Syy,w,h,xx-wr,yy-wr,xx+wr,yy+wr);
      var sxy = boxSum(Sxy,w,h,xx-wr,yy-wr,xx+wr,yy+wr);
      var tr = sxx+syy, det = sxx*syy-sxy*sxy;
      var disc = tr*tr/4 - det;
      if(disc<0) disc=0;
      var minEig = tr/2 - Math.sqrt(disc);
      if(minEig>0) candidates.push({x:xx, y:yy, score:minEig});
    }
  }
  candidates.sort(function(a,b){ return b.score-a.score; });

  // 格子ベースの非最大抑制: 採用済み特徴の近傍セル(3x3)には新規追加しない。
  var cell = nmsRadius;
  var occupied = new Set();
  var chosen = [];
  for(var k=0; k<candidates.length && chosen.length<maxFeatures; k++){
    var c = candidates[k];
    var cellX = (c.x/cell)|0, cellY = (c.y/cell)|0;
    var dup = false;
    for(var dx=-1; dx<=1 && !dup; dx++){
      for(var dy=-1; dy<=1 && !dup; dy++){
        if(occupied.has((cellX+dx)+","+(cellY+dy))) dup=true;
      }
    }
    if(dup) continue;
    occupied.add(cellX+","+cellY);
    chosen.push(c);
  }
  return chosen;
}
P3D.detectFeatureCorners = detectFeatureCorners;

// ---------------------------------------------------------------------
// 追跡: 隣接フレーム間NCCマッチング(行拘束+線形予測付き探索窓)
// ---------------------------------------------------------------------

// NCCスコア曲面の3点放物線フィットでサブピクセル精密化する(x/y独立)。
function subpixelRefine(template, gray, w, h, best, r, scratch){
  function scoreAt(x, y){
    if(x<r || y<r || x>w-1-r || y>h-1-r) return null;
    extractPatch(gray, w, h, x, y, r, scratch);
    return nccScore(template, scratch);
  }
  var c = scoreAt(best.x, best.y);
  var l = scoreAt(best.x-1, best.y), rr = scoreAt(best.x+1, best.y);
  var u = scoreAt(best.x, best.y-1), dn = scoreAt(best.x, best.y+1);
  var dx=0, dy=0;
  if(l!==null && rr!==null && c!==null){
    var denomX = (l - 2*c + rr);
    if(Math.abs(denomX)>1e-6) dx = 0.5*(l-rr)/denomX;
  }
  if(u!==null && dn!==null && c!==null){
    var denomY = (u - 2*c + dn);
    if(Math.abs(denomY)>1e-6) dy = 0.5*(u-dn)/denomY;
  }
  dx = Math.max(-0.5, Math.min(0.5, dx));
  dy = Math.max(-0.5, Math.min(0.5, dy));
  return {x: best.x+dx, y: best.y+dy};
}

/**
 * frames: [{imageData}] (js/video_frames.jsのextractVideoFramesの.frames。
 *   時間順、calibInitial.perFrameと同じindex)
 * masks: [Uint8Array(w*h)|null] (frames同数。js/edt.jsのsilhouetteFromImageData
 *   の.mask。前景に追跡を限定するために使う)
 * calibInitial: js/turntable_calib.jsのcalibrateTurntableの戻り値(粗較正。
 *   θ_i・cx・ybot・scaleの初期値として予測に使う)
 * opts: {patchRadius(既定4), maxDispPx(既定34, 予測が無い最初のステップの
 *   探索半径。指先等の最速部位のフレーム間最大移動量), rowBandPx(既定6,
 *   行拘束の許容縦ずれ), refineSearchPx(既定6, 予測が効く2ステップ目以降の
 *   探索半径), nccAcceptThreshold(既定0.5), maxFeaturesPerRedetect(既定150),
 *   maxActiveTracks(既定450), redetectEvery(既定8), nmsRadius(既定14),
 *   onProgress(frac)}
 * 戻り値: [{id, obs:[{frameIdx,u,v,ncc}]}] (終了・生存問わず全トラック。
 *   長さ2未満のトラックは含めない)
 */
async function trackFeaturesNCC(frames, masks, calibInitial, opts){
  opts = opts || {};
  var patchR = opts.patchRadius || 4;
  var maxDispPx = opts.maxDispPx || 34;
  var rowBandPx = opts.rowBandPx || 6;
  var refineSearchPx = opts.refineSearchPx || 6;
  var nccAcceptThreshold = (opts.nccAcceptThreshold===undefined) ? 0.5 : opts.nccAcceptThreshold;
  var maxFeaturesPerRedetect = opts.maxFeaturesPerRedetect || 150;
  var maxActiveTracks = opts.maxActiveTracks || 450;
  var redetectEvery = opts.redetectEvery || 8;
  var nmsRadius = opts.nmsRadius || 14;
  var onProgress = opts.onProgress || function(){};

  var n = frames.length;
  var grays = new Array(n), dims = new Array(n);
  for(var gi=0; gi<n; gi++){
    grays[gi] = grayscaleFromImageData(frames[gi].imageData);
    dims[gi] = {w: frames[gi].imageData.width, h: frames[gi].imageData.height};
  }

  var modelHeightSpan = P3D.MULTIVIEW_DEFAULT_BOUNDS.myBounds[1]-P3D.MULTIVIEW_DEFAULT_BOUNDS.myBounds[0];
  var scalePxPerModelBase = calibInitial.refHeight/modelHeightSpan;
  function frameAngleRad(i){ return calibInitial.perFrame[i].theta*Math.PI/180; }
  function frameCx(i){ var pf=calibInitial.perFrame[i]; return pf.cxOverride!==undefined ? pf.cxOverride : calibInitial.refCx; }
  function frameScale(i){ var pf=calibInitial.perFrame[i]; return scalePxPerModelBase*(pf.scaleMult||1); }

  // トラックが持つ観測群だけから(x,z)を暫定推定する(次フレームのu予測用。
  // 最終的な3Dアンカー確定はfitTrackAnchorで残差ゲート付きにやり直す)。
  function partialFitXZ(obs){
    if(obs.length<2) return null;
    var Sxx=0,Sxz=0,Szz=0,Sxu=0,Szu=0;
    for(var k=0;k<obs.length;k++){
      var o=obs[k];
      var c=Math.cos(frameAngleRad(o.frameIdx)), s=Math.sin(frameAngleRad(o.frameIdx));
      var rhs=(o.u-frameCx(o.frameIdx))/frameScale(o.frameIdx);
      Sxx+=c*c; Sxz+=c*s; Szz+=s*s; Sxu+=c*rhs; Szu+=s*rhs;
    }
    var det=Sxx*Szz-Sxz*Sxz;
    if(Math.abs(det)<1e-9) return null;
    return {
      x: (Sxu*Szz-Szu*Sxz)/det,
      z: (Sxx*Szu-Sxz*Sxu)/det,
    };
  }

  var activeTracks = [];
  var finishedTracks = [];
  var trackIdSeq = 0;
  var scratchSize = (2*patchR+1)*(2*patchR+1);

  for(var i=0; i<n; i++){
    var gray = grays[i], dim = dims[i], mask = masks[i];
    if((i===0 || i%redetectEvery===0) && activeTracks.length<maxActiveTracks){
      var occCell = nmsRadius;
      var occ = new Set();
      activeTracks.forEach(function(t){
        var last = t.obs[t.obs.length-1];
        occ.add(((last.u/occCell)|0)+","+((last.v/occCell)|0));
      });
      var budget = maxActiveTracks - activeTracks.length;
      var feats = detectFeatureCorners(gray, dim.w, dim.h, mask, {
        maxFeatures: Math.min(maxFeaturesPerRedetect, budget),
        nmsRadius: nmsRadius,
      });
      for(var fi2=0; fi2<feats.length; fi2++){
        var ft = feats[fi2];
        var cellKey = ((ft.x/occCell)|0)+","+((ft.y/occCell)|0);
        if(occ.has(cellKey)) continue; // 既存トラックの近傍は避ける(重複防止)
        activeTracks.push({
          id: trackIdSeq++,
          obs: [{frameIdx:i, u:ft.x, v:ft.y, ncc:1}],
          template: extractPatch(gray, dim.w, dim.h, ft.x, ft.y, patchR),
        });
      }
    }
    if(i===n-1) break;

    var nextGray = grays[i+1], nextDim = dims[i+1], nextMask = masks[i+1];
    var scratch = new Float32Array(scratchSize);
    var stillActive = [];
    for(var ti=0; ti<activeTracks.length; ti++){
      var track = activeTracks[ti];
      var last = track.obs[track.obs.length-1];
      var fit = partialFitXZ(track.obs);
      var predU, searchR;
      if(fit){
        var c1=Math.cos(frameAngleRad(i+1)), s1=Math.sin(frameAngleRad(i+1));
        predU = frameCx(i+1) + frameScale(i+1)*(fit.x*c1+fit.z*s1);
        searchR = refineSearchPx;
      }else{
        predU = last.u; // 動きモデルがまだ無い最初のステップは前フレーム位置を仮の中心にする
        searchR = maxDispPx;
      }
      var predV = last.v; // 行拘束: 回転による動きはほぼ水平

      var y0 = Math.max(patchR, Math.round(predV-rowBandPx));
      var y1 = Math.min(nextDim.h-1-patchR, Math.round(predV+rowBandPx));
      var x0 = Math.max(patchR, Math.round(predU-searchR));
      var x1 = Math.min(nextDim.w-1-patchR, Math.round(predU+searchR));

      var best=null, bestScore=-2;
      for(var yy=y0; yy<=y1; yy++){
        var rowBase = yy*nextDim.w;
        for(var xx=x0; xx<=x1; xx++){
          if(nextMask && !nextMask[rowBase+xx]) continue;
          extractPatch(nextGray, nextDim.w, nextDim.h, xx, yy, patchR, scratch);
          var score = nccScore(track.template, scratch);
          if(score>bestScore){ bestScore=score; best={x:xx,y:yy}; }
        }
      }
      if(!best || bestScore<nccAcceptThreshold){
        // 追跡終了(遮蔽・一致喪失)。2観測未満は3D化できないので捨てる。
        if(track.obs.length>=2) finishedTracks.push(track);
        continue;
      }
      var refined = subpixelRefine(track.template, nextGray, nextDim.w, nextDim.h, best, patchR, scratch);
      track.obs.push({frameIdx:i+1, u:refined.x, v:refined.y, ncc:bestScore});
      track.template = extractPatch(nextGray, nextDim.w, nextDim.h, refined.x, refined.y, patchR);
      stillActive.push(track);
    }
    activeTracks = stillActive;
    if(i % 4 === 0){
      onProgress(i/n);
      await new Promise(function(resolve){ requestAnimationFrame(resolve); });
    }
  }
  finishedTracks = finishedTracks.concat(activeTracks.filter(function(t){ return t.obs.length>=2; }));
  onProgress(1);
  return finishedTracks;
}
P3D.trackFeaturesNCC = trackFeaturesNCC;

// ---------------------------------------------------------------------
// 3D化: (x,z)線形最小二乗+残差ゲート(誤追跡の棄却)
// ---------------------------------------------------------------------

/**
 * track: {obs:[{frameIdx,u,v,ncc}]} (trackFeaturesNCCの1要素)
 * calib: perFrame[].theta/cxOverride/ybotOverride/scaleMultとrefCx/refYbotを
 *   持つcalib(calibrateTurntableの戻り値、または較正精密化後のもの)
 * scalePxPerModelBase, myMin: js/multiview_hull.jsのbuildUseFramesと同じ意味
 * opts: {minObsPerTrack(既定6), maxResidualPx(既定2.5),
 *        sigmaClipIters(既定2), sigmaClipMult(既定2.5)}
 * 戻り値: {x,z,y,obs(ゲート後),residualPx,nObs} / 棄却時はnull
 */
function fitTrackAnchor(track, calib, scalePxPerModelBase, myMin, opts){
  opts = opts || {};
  var minObs = opts.minObsPerTrack===undefined ? 6 : opts.minObsPerTrack;
  var maxResidualPx = opts.maxResidualPx===undefined ? 2.5 : opts.maxResidualPx;
  var sigmaClipIters = opts.sigmaClipIters===undefined ? 2 : opts.sigmaClipIters;
  var sigmaClipMult = opts.sigmaClipMult===undefined ? 2.5 : opts.sigmaClipMult;

  function frameAngleRad(i){ return calib.perFrame[i].theta*Math.PI/180; }
  function frameCx(i){ var pf=calib.perFrame[i]; return pf.cxOverride!==undefined ? pf.cxOverride : calib.refCx; }
  function frameYbot(i){ var pf=calib.perFrame[i]; return pf.ybotOverride!==undefined ? pf.ybotOverride : calib.refYbot; }
  function frameScale(i){ var pf=calib.perFrame[i]; return scalePxPerModelBase*(pf.scaleMult||1); }

  function solveXZ(obsList){
    var Sxx=0,Sxz=0,Szz=0,Sxu=0,Szu=0;
    for(var k=0;k<obsList.length;k++){
      var o=obsList[k];
      var c=Math.cos(frameAngleRad(o.frameIdx)), s=Math.sin(frameAngleRad(o.frameIdx));
      var rhs=(o.u-frameCx(o.frameIdx))/frameScale(o.frameIdx);
      Sxx+=c*c; Sxz+=c*s; Szz+=s*s; Sxu+=c*rhs; Szu+=s*rhs;
    }
    var det=Sxx*Szz-Sxz*Sxz;
    if(Math.abs(det)<1e-9) return null;
    return { x:(Sxu*Szz-Szu*Sxz)/det, z:(Sxx*Szu-Sxz*Sxu)/det };
  }

  var obs = track.obs.slice();
  var solved = null;
  for(var iter=0; iter<=sigmaClipIters; iter++){
    if(obs.length<minObs) return null;
    solved = solveXZ(obs);
    if(!solved) return null;
    var residuals = obs.map(function(o){
      var c=Math.cos(frameAngleRad(o.frameIdx)), s=Math.sin(frameAngleRad(o.frameIdx));
      var uPred = frameCx(o.frameIdx) + frameScale(o.frameIdx)*(solved.x*c+solved.z*s);
      return Math.abs(o.u-uPred);
    });
    if(iter===sigmaClipIters){ solved.residuals=residuals; break; }
    var sorted = residuals.slice().sort(function(a,b){return a-b;});
    var med = sorted[Math.floor(sorted.length/2)] || 0;
    var thresh = Math.max(1.0, med*sigmaClipMult);
    var kept = [];
    for(var ki=0; ki<obs.length; ki++){ if(residuals[ki]<=thresh) kept.push(obs[ki]); }
    if(kept.length===obs.length){ solved.residuals=residuals; break; } // 収束(変化なし)
    if(kept.length<minObs){ solved.residuals=residuals; break; } // 削りすぎるので打ち切ってそのまま評価
    obs = kept;
  }

  var rmsResidual = Math.sqrt(solved.residuals.reduce(function(s,r){return s+r*r;},0)/solved.residuals.length);
  if(rmsResidual > maxResidualPx) return null; // 誤追跡として棄却

  var ys = obs.map(function(o){ return myMin + (frameYbot(o.frameIdx)-o.v)/frameScale(o.frameIdx); });
  var yMed = P3D.median(ys);

  return { x: solved.x, z: solved.z, y: yMed, obs: obs, residualPx: rmsResidual, nObs: obs.length };
}
P3D.fitTrackAnchor = fitTrackAnchor;

/**
 * frames, masks, calib: trackFeaturesNCCと同じ
 * opts: trackFeaturesNCCのoptsとfitTrackAnchorのoptsをマージして渡せる。
 *   加えて{bounds(既定P3D.MULTIVIEW_DEFAULT_BOUNDS)}
 * 戻り値: {tracks:[{x,z,y,obs,residualPx,nObs}], rawTrackCount,
 *          scalePxPerModelBase, myMin}
 */
async function computeFeatureTracks(frames, masks, calib, opts){
  opts = opts || {};
  var bounds = opts.bounds || P3D.MULTIVIEW_DEFAULT_BOUNDS;
  var modelHeightSpan = bounds.myBounds[1]-bounds.myBounds[0];
  var scalePxPerModelBase = calib.refHeight/modelHeightSpan;
  var myMin = bounds.myBounds[0];

  var rawTracks = await trackFeaturesNCC(frames, masks, calib, opts);
  var anchors = [];
  rawTracks.forEach(function(tr){
    var fit = fitTrackAnchor(tr, calib, scalePxPerModelBase, myMin, opts);
    if(fit) anchors.push(fit);
  });
  return {
    tracks: anchors, rawTrackCount: rawTracks.length,
    scalePxPerModelBase: scalePxPerModelBase, myMin: myMin,
  };
}
P3D.computeFeatureTracks = computeFeatureTracks;

// ---------------------------------------------------------------------
// 同時較正: 全トラック残差の交互最小化(アンカー再フィット⇔フレーム別
// θ/cx/ybot/scale更新)。js/turntable_calib.jsのrefineCalibrationAnalysisBySynthesis
// (彫刻結果への再投影IoU座標降下、粗彫刻メッシュが必須)を置き換える。
// こちらは彫刻結果に依存せず(トラックの2D観測だけで完結)、サブピクセル
// 精度の線形最小二乗なので座標降下よりも高速・高精度。
// ---------------------------------------------------------------------

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

// 4x4正規方程式をガウス消去(部分ピボット選択)で解く。特異ならnull。
function solveLinear4(ATA, ATb){
  var n=4;
  var A = [ATA[0].slice(), ATA[1].slice(), ATA[2].slice(), ATA[3].slice()];
  var b = ATb.slice();
  for(var col=0; col<n; col++){
    var piv=col;
    for(var r=col+1; r<n; r++){ if(Math.abs(A[r][col])>Math.abs(A[piv][col])) piv=r; }
    if(Math.abs(A[piv][col])<1e-10) return null;
    if(piv!==col){
      var tmpRow=A[piv]; A[piv]=A[col]; A[col]=tmpRow;
      var tmpB=b[piv]; b[piv]=b[col]; b[col]=tmpB;
    }
    for(var r2=col+1; r2<n; r2++){
      var f = A[r2][col]/A[col][col];
      for(var c2=col; c2<n; c2++) A[r2][c2] -= f*A[col][c2];
      b[r2] -= f*b[col];
    }
  }
  var x = new Array(n);
  for(var i=n-1; i>=0; i--){
    var s = b[i];
    for(var j=i+1; j<n; j++) s -= A[i][j]*x[j];
    x[i] = s/A[i][i];
  }
  return x;
}

function addNormalEq4(ATA, ATb, row, resid, weight){
  for(var r=0;r<4;r++){
    ATb[r] += weight*row[r]*resid;
    for(var c=0;c<4;c++) ATA[r][c] += weight*row[r]*row[c];
  }
}

/**
 * calib: 粗較正(calibrateTurntableの戻り値)
 * tracks: computeFeatureTracksが返した.tracks(x,z,y,obs,nObs付き)
 * scalePxPerModelBase, myMin: computeFeatureTracksの戻り値の同名フィールド
 * opts: {iters(既定5), maxThetaDeg(既定10, 1反復あたりの角度更新の上限),
 *        maxShiftPx(既定refHeight*0.08), maxScaleFrac(既定0.12),
 *        minObsPerFrame(既定4, これ未満のフレームは当反復で更新しない),
 *        onProgress(frac)}
 * 戻り値: 新しいcalib(perFrameのtheta/cxOverride/ybotOverride/scaleMultを
 *   トラック較正で更新したコピー。refHeight等の共通値は元のまま。
 *   trackRefineMeanResidualPx/trackRefineAnchorsに診断情報を追加)
 */
function refineCalibrationByTracks(calib, tracks, scalePxPerModelBase, myMin, opts){
  opts = opts || {};
  var iters = opts.iters===undefined ? 5 : opts.iters;
  var maxThetaRad = (opts.maxThetaDeg===undefined ? 10 : opts.maxThetaDeg) * Math.PI/180;
  var maxShiftPx = opts.maxShiftPx===undefined ? calib.refHeight*0.08 : opts.maxShiftPx;
  var maxScaleFrac = opts.maxScaleFrac===undefined ? 0.12 : opts.maxScaleFrac;
  var minObsPerFrame = opts.minObsPerFrame===undefined ? 4 : opts.minObsPerFrame;
  var onProgress = opts.onProgress || function(){};

  var n = calib.perFrame.length;
  var perFrame = calib.perFrame.map(function(pf){ return Object.assign({}, pf); });
  var anchors = tracks.map(function(t){
    return { x:t.x, z:t.z, y:t.y, obs:t.obs, weight: Math.sqrt(t.nObs) };
  });

  function frameParams(pf){
    return {
      thetaRad: pf.theta*Math.PI/180,
      cx: pf.cxOverride!==undefined ? pf.cxOverride : calib.refCx,
      ybot: pf.ybotOverride!==undefined ? pf.ybotOverride : calib.refYbot,
      scaleMult: pf.scaleMult || 1,
    };
  }

  function refitAnchor(a){
    var Sxx=0,Sxz=0,Szz=0,Sxu=0,Szu=0;
    var ys=[];
    a.obs.forEach(function(o){
      var p = frameParams(perFrame[o.frameIdx]);
      var c=Math.cos(p.thetaRad), s=Math.sin(p.thetaRad);
      var sc = scalePxPerModelBase*p.scaleMult;
      var rhs = (o.u-p.cx)/sc;
      Sxx+=c*c; Sxz+=c*s; Szz+=s*s; Sxu+=c*rhs; Szu+=s*rhs;
      ys.push(myMin + (p.ybot-o.v)/sc);
    });
    var det = Sxx*Szz-Sxz*Sxz;
    if(Math.abs(det)<1e-9) return;
    a.x = (Sxu*Szz-Szu*Sxz)/det;
    a.z = (Sxx*Szu-Sxz*Sxu)/det;
    a.y = P3D.median(ys);
  }

  for(var it=0; it<iters; it++){
    anchors.forEach(refitAnchor);

    var byFrame = new Array(n);
    for(var fi=0; fi<n; fi++) byFrame[fi] = [];
    anchors.forEach(function(a){
      a.obs.forEach(function(o){
        byFrame[o.frameIdx].push({u:o.u, v:o.v, x:a.x, y:a.y, z:a.z, weight:a.weight});
      });
    });

    for(var i=0; i<n; i++){
      var obsList = byFrame[i];
      if(obsList.length < minObsPerFrame) continue; // 証拠不足のフレームは元の値を維持
      var pf = perFrame[i];
      var p = frameParams(pf);
      var cosT=Math.cos(p.thetaRad), sinT=Math.sin(p.thetaRad);
      var s0 = scalePxPerModelBase*p.scaleMult;
      // θ・scaleMultをcosθ0・sinθ0周りで線形化した4パラメータ
      // (dθ,dcx,dybot,dScaleMult)の正規方程式(§16の交互最小化の「フレーム別
      // 更新」ステップ。u方程式はdθ・dcx・dScaleMultに、v方程式はdybot・
      // dScaleMultに効く)。
      var ATA=[[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
      var ATb=[0,0,0,0];
      obsList.forEach(function(o){
        var worldX = o.x*cosT + o.z*sinT;
        var uPred = p.cx + s0*worldX;
        var vPred = p.ybot - s0*(o.y-myMin);
        var ru = o.u - uPred, rv = o.v - vPred;
        var au = s0*(-o.x*sinT + o.z*cosT);
        var rowU = [au, 1, 0, scalePxPerModelBase*worldX];
        var rowV = [0, 0, 1, -scalePxPerModelBase*(o.y-myMin)];
        addNormalEq4(ATA, ATb, rowU, ru, o.weight);
        addNormalEq4(ATA, ATb, rowV, rv, o.weight);
      });
      for(var d=0; d<4; d++) ATA[d][d] += 1e-6; // 特異性回避の微小減衰
      var delta = solveLinear4(ATA, ATb);
      if(!delta) continue;
      var dTheta = clamp(delta[0], -maxThetaRad, maxThetaRad);
      var dCx = clamp(delta[1], -maxShiftPx, maxShiftPx);
      var dYbot = clamp(delta[2], -maxShiftPx, maxShiftPx);
      var dScale = clamp(delta[3], -maxScaleFrac, maxScaleFrac);
      pf.theta = (p.thetaRad+dTheta)*180/Math.PI;
      pf.cxOverride = p.cx+dCx;
      pf.ybotOverride = p.ybot+dYbot;
      pf.scaleMult = p.scaleMult+dScale;
    }
    onProgress((it+1)/iters);
  }

  var finalResiduals = [];
  anchors.forEach(function(a){
    a.obs.forEach(function(o){
      var p = frameParams(perFrame[o.frameIdx]);
      var c=Math.cos(p.thetaRad), s=Math.sin(p.thetaRad);
      var sc = scalePxPerModelBase*p.scaleMult;
      var uPred = p.cx + sc*(a.x*c+a.z*s);
      finalResiduals.push(Math.abs(o.u-uPred));
    });
  });
  var meanResidualPx = finalResiduals.length ?
    finalResiduals.reduce(function(s,v){return s+v;},0)/finalResiduals.length : 0;

  return Object.assign({}, calib, {
    perFrame: perFrame,
    trackRefineMeanResidualPx: meanResidualPx,
    trackRefineAnchors: anchors,
  });
}
P3D.refineCalibrationByTracks = refineCalibrationByTracks;

})(window);
