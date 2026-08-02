// -*- coding: utf-8 -*-
// VEO_VIDEO_TO_3D_PLAN.md §5(Stage3: ターンテーブル・キャリブレーション)の
// JS実装。
// ★M1スコープでの簡略化: 計画書本文が言う「粗彫刻→再投影IoU最大化の
// analysis-by-synthesis」(彫刻結果に対する反復最適化)は、Stage4の彫刻結果
// そのものに依存する反復ループで実装コストが高いため、本セッションのM1
// 受け入れ基準(「角度曲線・残差表示、キーフレーム同定が目視で正しい」)には
// 含めず見送る。代わりに、シルエットのbbox幅が最小になる位置(Tポーズが
// 真横向きになる=90度/270度)をキーフレームとして検出し、そこを通る
// 区分線形補正で等速仮定を補正する軽量版にする(将来、彫刻結果を使った
// 反復精密化を追加する場合はここを拡張する)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

function median(arr){
  var s = arr.slice().sort(function(a,b){return a-b;});
  var n = s.length;
  if(n===0) return 0;
  return n%2 ? s[(n-1)/2] : (s[n/2-1]+s[n/2])/2;
}

// 配列内の局所最小(近傍radius内で最小)のindexを返す。
function localMinima(arr, radius){
  var out = [];
  for(var i=0;i<arr.length;i++){
    var isMin = true;
    for(var j=Math.max(0,i-radius); j<=Math.min(arr.length-1,i+radius); j++){
      if(j!==i && arr[j] < arr[i]){ isMin=false; break; }
    }
    if(isMin) out.push(i);
  }
  return out;
}

/**
 * frames: [{t, mask, w, h}] (時間順、js/edt.jsのsilhouetteFromImageDataの結果を想定)
 * opts: {}
 * 戻り値: {
 *   perFrame: [{i, t, theta, thetaInitial, scale, cx, cy, w(confidence), bbox,
 *              bboxWidthNorm, isOutlier}],
 *   refHeight, keyIdx:{i0,i90,i180,i270,iEnd}
 * }
 * 前提: framesは「フレーム0=正面(0度)、時間順に一定方向へ連続回転し
 * ちょうど1周する」動画から抽出したもの(VEO_VIDEO_TO_3D_PLAN.md §3.2の
 * プロンプトVで生成した動画、またはそれと同じ規約の素材)。
 */
function calibrateTurntable(frames, opts){
  opts = opts || {};
  var n = frames.length;
  var bboxes = frames.map(function(f){ return P3D.maskBBox(f.mask, f.w, f.h); });
  var heights = bboxes.map(function(b){ return b ? (b[3]-b[1]+1) : 0; });
  var widths  = bboxes.map(function(b){ return b ? (b[2]-b[0]+1) : 0; });
  var cxs     = bboxes.map(function(b){ return b ? (b[0]+b[2])/2 : 0; });
  var ybots   = bboxes.map(function(b){ return b ? b[3] : 0; });

  var refHeight = median(heights.filter(function(h){return h>0;}));
  var refYbot = median(ybots.filter(function(v,i){return heights[i]>0;}));
  // ★カメラ固定・回転軸が画面水平中心に固定(プロンプトVの条件)という前提の
  // もとでは、真の回転軸の投影位置(cx)は全フレームで本来一定のはず。
  // bbox中心をフレームごとに毎回使うと、斜め角度(Tポーズの腕が前後にずれて
  // 写り、シルエットが回転軸に対して左右非対称になる角度)でbbox中心が
  // 真の軸からずれ、多数フレームを重ねる投票で細い部位(腕等)がにじんで
  // 平べったくなる原因になっていた(実地検証で判明)。正面/背面付近
  // (シルエットが左右対称に近い)を含む全フレームの中央値を共通の基準
  // 軸として使う。
  var refCx = median(cxs.filter(function(v,i){return heights[i]>0;}));

  // 初期角度: 等速仮定(index 0=0度、index n-1=ほぼ360度手前で1周)。
  // n枚でちょうど1周を表すデータ(§3.2で末尾は先頭に戻る設計)なので、
  // 360*i/nとする(i=nなら360=0度に一致する手前で止まる)。
  var thetaInitial = [];
  for(var i=0;i<n;i++) thetaInitial.push(360*i/n);

  // bbox幅(refHeightで正規化)からキーフレーム(90度/270度=真横向き=幅最小)を検出。
  var widthNorm = widths.map(function(w,i){ return heights[i]>0 ? w/refHeight : 999; });
  var minimaIdx = localMinima(widthNorm, Math.max(2, Math.floor(n/16)));
  // 前半(0〜n/2)から最小の1つ、後半(n/2〜n)から最小の1つを90度/270度候補とする
  var firstHalf = minimaIdx.filter(function(idx){ return idx < n/2 && idx > n*0.05; });
  var secondHalf = minimaIdx.filter(function(idx){ return idx >= n/2 && idx < n*0.95; });
  function pickMin(idxs){
    if(!idxs.length) return null;
    var best=idxs[0];
    idxs.forEach(function(idx){ if(widthNorm[idx]<widthNorm[best]) best=idx; });
    return best;
  }
  var i90 = pickMin(firstHalf);
  var i270 = pickMin(secondHalf);

  // アンカー点(index, 目標角度)を組み立てて区分線形補正する。
  var anchors = [[0,0]];
  if(i90!==null) anchors.push([i90, 90]);
  anchors.push([Math.round(n/2), 180]);
  if(i270!==null) anchors.push([i270, 270]);
  anchors.push([n, 360]);
  // indexで昇順に整列(90/270検出が理論位置から大きくズレていても単調性を保つ)
  anchors.sort(function(a,b){ return a[0]-b[0]; });
  // 単調性の保証: 角度が逆行するアンカーは間引く
  var cleanAnchors = [anchors[0]];
  anchors.forEach(function(a){
    var last = cleanAnchors[cleanAnchors.length-1];
    if(a[0] > last[0] && a[1] > last[1]) cleanAnchors.push(a);
  });
  if(cleanAnchors[cleanAnchors.length-1][0] < n) cleanAnchors.push([n,360]);

  function interpTheta(i){
    for(var k=0;k<cleanAnchors.length-1;k++){
      var a=cleanAnchors[k], b=cleanAnchors[k+1];
      if(i>=a[0] && i<=b[0]){
        var frac = (b[0]===a[0]) ? 0 : (i-a[0])/(b[0]-a[0]);
        return a[1] + frac*(b[1]-a[1]);
      }
    }
    return 360*i/n;
  }

  var perFrame = [];
  for(var idx=0; idx<n; idx++){
    var h = heights[idx];
    var scale = (h>0) ? refHeight/h : 1;
    var thetaRefined = interpTheta(idx);
    var heightRatio = h>0 ? h/refHeight : 0;
    var isOutlier = (h===0) || heightRatio<0.85 || heightRatio>1.15;
    var conf = isOutlier ? 0.2 : 1.0;
    perFrame.push({
      i: idx, t: frames[idx].t,
      theta: thetaRefined, thetaInitial: thetaInitial[idx],
      scale: scale, cx: cxs[idx], ybot: ybots[idx],
      w: conf, bbox: bboxes[idx], bboxWidthNorm: widthNorm[idx],
      isOutlier: isOutlier,
    });
  }

  return {
    perFrame: perFrame, refHeight: refHeight, refYbot: refYbot, refCx: refCx,
    keyIdx: {i0:0, i90:i90, i180:Math.round(n/2), i270:i270, iEnd:n-1},
  };
}
P3D.calibrateTurntable = calibrateTurntable;

// ---------------------------------------------------------------------
// 較正精密化(analysis-by-synthesis、簡易版)
// VEO_VIDEO_TO_3D_PLAN.md §5本文の「粗彫刻→再投影IoU最大化」を、
// フル反復ではなく縮小版として実装する。粗彫刻(js/multiview_hull.jsの
// carveMultiviewField)で得たメッシュを各フレームの候補カメラへ再投影し、
// 実測シルエットとのIoUが最大になるよう、フレームごとにθ・2Dシフト
// (cx/ybot)・スケールの4パラメータを座標降下で微調整する。
// ★2026-07-18(方針転換の一部): calibrateTurntable本体・buildUseFramesの
// 「フレーム個別のbbox実測値ではなく共通基準値(refCx/refYbot/refHeight)を
// 使う」という設計(実地検証で腕のにじみ潰れの原因と判明)とは矛盾しない。
// ここで導入する per-frame シフトは生のbbox実測値ではなく、3D的に整合した
// 粗彫刻結果への再投影IoU最大化で得た小さな補正量(既定で最大±4%refHeight
// 相当・±6°・±6%スケールに制限)であり、Veoの被写体が完全な剛体回転を
// 守れていない(わずかなフレーム間ドリフトがある)ことへの対処という
// 位置づけ。過学習(ノイズへの過剰適合)を避けるため探索範囲を意図的に狭くする。
// ---------------------------------------------------------------------

// 2値マスク(sdf>=0を前景とみなす)をsize x sizeへ最近傍ダウンサンプルする。
function _calibDownsampleSdfMask(sdf, w, h, size){
  var out = new Uint8Array(size*size);
  for(var y=0;y<size;y++){
    var sy = Math.min(h-1, Math.floor((y+0.5)*h/size));
    var rowBase = sy*w;
    for(var x=0;x<size;x++){
      var sx = Math.min(w-1, Math.floor((x+0.5)*w/size));
      out[y*size+x] = (sdf[rowBase+sx] >= 0) ? 1 : 0;
    }
  }
  return out;
}

function _calibMaskIoU(a, b){
  var inter=0, uni=0;
  for(var i=0;i<a.length;i++){
    var av=a[i], bv=b[i];
    if(av||bv) uni++;
    if(av&&bv) inter++;
  }
  return uni>0 ? inter/uni : 1;
}

// メッシュ(V,F、モデル空間)を、projectFn(vx,vy,vz)->[u,v](rasterSize空間の
// px)で投影しラスタライズした2値マスク(rasterSize x rasterSize)を返す。
// ★三角形ごとに個別のfill()呼び出しをすると低速なので、1本のPathに全三角形を
// 積んで1回のfill("nonzero")で塗る。ただしメッシュの表/裏(巻き順)は視点により
// 入り乱れるため、そのままnonzero塗りすると裏表が重なった領域で巻き数が
// 相殺されて穴になりうる。各三角形を投影後の2D符号付き面積を見て頂点順を
// 揃える(全三角形を同じ向きに統一する)ことで、重なりは常に加算方向になり
// 単純な被覆判定(=シルエットの和集合)として機能する。
var _calibScratchCanvas = null;
function _calibRasterizeMeshMask(mesh, projectFn, rasterSize){
  if(!_calibScratchCanvas) _calibScratchCanvas = document.createElement("canvas");
  var canvas = _calibScratchCanvas;
  if(canvas.width!==rasterSize || canvas.height!==rasterSize){
    canvas.width = rasterSize; canvas.height = rasterSize;
  }
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,rasterSize,rasterSize);
  ctx.fillStyle = "#000";
  var V=mesh.V, F=mesh.F;
  ctx.beginPath();
  for(var f=0; f<F.length; f+=3){
    var i0=F[f]*3, i1=F[f+1]*3, i2=F[f+2]*3;
    var p0=projectFn(V[i0],V[i0+1],V[i0+2]);
    var p1=projectFn(V[i1],V[i1+1],V[i1+2]);
    var p2=projectFn(V[i2],V[i2+1],V[i2+2]);
    var p1x=p1[0], p1y=p1[1], p2x=p2[0], p2y=p2[1];
    var cross = (p1x-p0[0])*(p2y-p0[1]) - (p1y-p0[1])*(p2x-p0[0]);
    if(cross<0){ var tx=p1x,ty=p1y; p1x=p2x; p1y=p2y; p2x=tx; p2y=ty; }
    ctx.moveTo(p0[0],p0[1]); ctx.lineTo(p1x,p1y); ctx.lineTo(p2x,p2y); ctx.closePath();
  }
  ctx.fill("nonzero");
  var data = ctx.getImageData(0,0,rasterSize,rasterSize).data;
  var mask = new Uint8Array(rasterSize*rasterSize);
  for(var i=0;i<rasterSize*rasterSize;i++) mask[i] = (data[i*4+3] > 127) ? 1 : 0;
  return mask;
}

/**
 * calib: calibrateTurntableの戻り値(またはperFrame/refHeight/refCx/refYbot
 *   を持つ同形のオブジェクト)
 * mesh: {V,F} (粗彫刻結果からのメッシュ。carveMultiviewFieldのfield+gridに
 *   P3D.marchingCubesを直接かけたものでよい。高精細である必要はない)
 * sdfFrames: [{sdf,w,h}] (calib.perFrameと同じindex順。js/edt.jsの
 *   signedDistanceField。実測シルエットはsdf>=0から復元する)
 * scalePxPerModel, myMin: js/multiview_hull.jsのbuildUseFramesと同じ意味の
 *   投影パラメータ(scalePxPerModel=refHeight/modelHeightSpan、
 *   myMin=bounds.myBounds[0])
 * opts: {iters(既定2), rasterSize(既定96), thetaStepDeg(既定3),
 *   maxThetaDeg(既定6), shiftStepPx(既定refHeight*0.01),
 *   maxShiftPx(既定refHeight*0.04), scaleStepFrac(既定0.02),
 *   maxScaleFrac(既定0.06), minWeight(既定0.3), onProgress(frac)}
 * 戻り値: 新しいcalib(perFrameの各要素にtheta/cxOverride/ybotOverride/
 *   scaleMult/refineIoUを追加したコピー。refHeight等の共通値は元のまま)
 */
function refineCalibrationAnalysisBySynthesis(calib, mesh, sdfFrames, scalePxPerModel, myMin, opts){
  opts = opts || {};
  var iters = (opts.iters===undefined) ? 2 : opts.iters;
  var rasterSize = opts.rasterSize || 96;
  var thetaStepDeg = (opts.thetaStepDeg===undefined) ? 3 : opts.thetaStepDeg;
  var maxThetaDeg = (opts.maxThetaDeg===undefined) ? 6 : opts.maxThetaDeg;
  var shiftStepPx = (opts.shiftStepPx===undefined) ? calib.refHeight*0.01 : opts.shiftStepPx;
  var maxShiftPx = (opts.maxShiftPx===undefined) ? calib.refHeight*0.04 : opts.maxShiftPx;
  var scaleStepFrac = (opts.scaleStepFrac===undefined) ? 0.02 : opts.scaleStepFrac;
  var maxScaleFrac = (opts.maxScaleFrac===undefined) ? 0.06 : opts.maxScaleFrac;
  var minWeight = (opts.minWeight===undefined) ? 0.3 : opts.minWeight;
  var onProgress = opts.onProgress || function(){};

  var baseCx = calib.refCx, baseYbot = calib.refYbot;
  var perFrame = calib.perFrame.map(function(pf){ return Object.assign({}, pf); });

  function project(vx,vy,vz, thetaDeg, cxV, ybotV, sMult, sx, sy){
    var rad = thetaDeg*Math.PI/180;
    var cosT=Math.cos(rad), sinT=Math.sin(rad);
    var worldX = vx*cosT + vz*sinT;
    var sc = scalePxPerModel*sMult;
    var u = cxV + sc*worldX;
    var v = ybotV - sc*(vy-myMin);
    return [u*sx, v*sy];
  }

  perFrame.forEach(function(pf, idx){
    if(pf.w < minWeight){ onProgress(idx/perFrame.length); return; }
    var sf = sdfFrames[idx];
    if(!sf) return;
    var sx = rasterSize/sf.w, sy = rasterSize/sf.h;
    var actualDown = _calibDownsampleSdfMask(sf.sdf, sf.w, sf.h, rasterSize);

    var thetaDeg0 = pf.theta, dCx=0, dYbot=0, scaleMult=1;
    function evalIoU(tD, cxV, ybotV, sMult){
      var pred = _calibRasterizeMeshMask(mesh, function(vx,vy,vz){
        return project(vx,vy,vz, tD, cxV, ybotV, sMult, sx, sy);
      }, rasterSize);
      return _calibMaskIoU(pred, actualDown);
    }

    var curIoU = evalIoU(thetaDeg0, baseCx, baseYbot, 1);
    for(var it=0; it<iters; it++){
      var stepMul = Math.pow(0.5, it); // 反復ごとにステップを縮める(粗→精密)
      [-thetaStepDeg*stepMul, thetaStepDeg*stepMul].forEach(function(delta){
        var cand = thetaDeg0+delta;
        if(Math.abs(cand-pf.theta) > maxThetaDeg) return;
        var iou = evalIoU(cand, baseCx+dCx, baseYbot+dYbot, scaleMult);
        if(iou>curIoU){ curIoU=iou; thetaDeg0=cand; }
      });
      [-shiftStepPx*stepMul, shiftStepPx*stepMul].forEach(function(delta){
        var cand = dCx+delta;
        if(Math.abs(cand) > maxShiftPx) return;
        var iou = evalIoU(thetaDeg0, baseCx+cand, baseYbot+dYbot, scaleMult);
        if(iou>curIoU){ curIoU=iou; dCx=cand; }
      });
      [-shiftStepPx*stepMul, shiftStepPx*stepMul].forEach(function(delta){
        var cand = dYbot+delta;
        if(Math.abs(cand) > maxShiftPx) return;
        var iou = evalIoU(thetaDeg0, baseCx+dCx, baseYbot+cand, scaleMult);
        if(iou>curIoU){ curIoU=iou; dYbot=cand; }
      });
      [-scaleStepFrac*stepMul, scaleStepFrac*stepMul].forEach(function(delta){
        var cand = scaleMult+delta;
        if(Math.abs(cand-1) > maxScaleFrac) return;
        var iou = evalIoU(thetaDeg0, baseCx+dCx, baseYbot+dYbot, cand);
        if(iou>curIoU){ curIoU=iou; scaleMult=cand; }
      });
    }

    pf.thetaBeforeRefine = pf.theta;
    pf.theta = thetaDeg0;
    pf.cxOverride = baseCx+dCx;
    pf.ybotOverride = baseYbot+dYbot;
    pf.scaleMult = scaleMult;
    pf.refineIoU = curIoU;
    if(idx % 4 === 0) onProgress(idx/perFrame.length);
  });
  onProgress(1);

  return Object.assign({}, calib, {perFrame: perFrame});
}
P3D.refineCalibrationAnalysisBySynthesis = refineCalibrationAnalysisBySynthesis;

// ---------------------------------------------------------------------
// 0/90/180/270度での再投影フィデリティ診断
// VEO_VIDEO_TO_3D_PLAN.md §16「統計量の見直し」で、bottom-k平均(固定比率)が
// ツインテール間・帽子の裏側等の狭い可視窓の隙間を多数派フレームで薄めて
// 消してしまう問題が実地で見つかった。この種の不具合は3Dプレビューを目視で
// 回転させないと気づきにくい一方、「0/90/180/270度で実測フレームと一致するか」
// という定量指標なら彫刻のたびに機械的にチェックできる。最終彫刻結果を
// 基準4方向の実測カメラへ再投影し、実測シルエットとのIoUを返す(§9.4の
// 「元イラストの参加」と同種の考え方で、正面/側面/背面という最も情報量の
// 多いビューでの忠実度を直接測る)。
// ---------------------------------------------------------------------

/**
 * calib: perFrame配列とrefCx/refYbotを持つcalib(refineCalibrationAnalysisBySynthesis
 *   適用後ならpf.cxOverride等を優先して使う)
 * mesh: {V,F} (最終彫刻結果のメッシュ。粗メッシュでも精細メッシュでも可)
 * sdfFrames: [{sdf,w,h}] (calib.perFrameと同じindex順)
 * scalePxPerModel, myMin: js/multiview_hull.jsのbuildUseFramesと同じ意味の
 *   投影パラメータ
 * indices: 評価したいフレームindexの配列(通常はcalib.keyIdxのi0/i90/i180/i270)
 * opts: {rasterSize(既定128)}
 * 戻り値: [{idx, theta, iou}] (indices中、該当データが無い/wが0のものはスキップ)
 */
function evaluateReprojectionIoU(calib, mesh, sdfFrames, scalePxPerModel, myMin, indices, opts){
  opts = opts || {};
  var rasterSize = opts.rasterSize || 128;
  var out = [];
  indices.forEach(function(idx){
    if(idx===null || idx===undefined) return;
    var pf = calib.perFrame[idx];
    var sf = sdfFrames[idx];
    if(!pf || !sf) return;
    var sx = rasterSize/sf.w, sy = rasterSize/sf.h;
    var actualDown = _calibDownsampleSdfMask(sf.sdf, sf.w, sf.h, rasterSize);
    var cxV = (pf.cxOverride!==undefined) ? pf.cxOverride : calib.refCx;
    var ybotV = (pf.ybotOverride!==undefined) ? pf.ybotOverride : calib.refYbot;
    var sMult = pf.scaleMult || 1;
    var rad = pf.theta*Math.PI/180;
    var cosT=Math.cos(rad), sinT=Math.sin(rad);
    var pred = _calibRasterizeMeshMask(mesh, function(vx,vy,vz){
      var worldX = vx*cosT + vz*sinT;
      var sc = scalePxPerModel*sMult;
      var u = cxV + sc*worldX;
      var v = ybotV - sc*(vy-myMin);
      return [u*sx, v*sy];
    }, rasterSize);
    out.push({idx: idx, theta: pf.theta, iou: _calibMaskIoU(pred, actualDown)});
  });
  return out;
}
P3D.evaluateReprojectionIoU = evaluateReprojectionIoU;

/**
 * evaluateReprojectionIoUのピクセルデータ版。「0/90/180/270度でピクセル単位
 * まで一致しているか」を実際に確認するための診断(2026-07-19、ユーザー
 * 指摘を受けて新設)。128px等の粗いダウンサンプルではなく元動画フレームに
 * 近い解像度で評価し、シルエットIoUに加えて**境界のズレ量(px単位)**を
 * 返す。IoUはシルエット全体の面積比なので、輪郭が全周にわたって数px
 * ズレていても高い値が出てしまう(「だいたい合っている」を「ピクセル単位で
 * 一致している」と誤読させかねない)。境界距離の方が「実測の輪郭から予測の
 * 輪郭まで何pxズレているか」を直接答える。
 * opts: {rasterSize(既定: min(sf.w,sf.h)、正方形ラスタのため小さい方に合わせる)}
 * 戻り値: {w,h,iou,boundaryMeanPx,boundaryP95Px,boundaryMaxPx,
 *          overlayRGBA(Uint8ClampedArray, w*h*4。白=両方一致、
 *          緑=実測のみ(予測が削りすぎ)、赤=予測のみ(予測が余っている)、
 *          黒=どちらも背景)} / 該当フレームが無ければnull
 */
function renderReprojectionOverlayAt(calib, mesh, sdfFrames, scalePxPerModel, myMin, idx, opts){
  opts = opts || {};
  var pf = calib.perFrame[idx];
  var sf = sdfFrames[idx];
  if(!pf || !sf) return null;
  var rasterSize = opts.rasterSize || Math.min(sf.w, sf.h);
  var sx = rasterSize/sf.w, sy = rasterSize/sf.h;
  var actual = _calibDownsampleSdfMask(sf.sdf, sf.w, sf.h, rasterSize);
  var cxV = (pf.cxOverride!==undefined) ? pf.cxOverride : calib.refCx;
  var ybotV = (pf.ybotOverride!==undefined) ? pf.ybotOverride : calib.refYbot;
  var sMult = pf.scaleMult || 1;
  var rad = pf.theta*Math.PI/180;
  var cosT=Math.cos(rad), sinT=Math.sin(rad);
  var pred = _calibRasterizeMeshMask(mesh, function(vx,vy,vz){
    var worldX = vx*cosT + vz*sinT;
    var sc = scalePxPerModel*sMult;
    var u = cxV + sc*worldX;
    var v = ybotV - sc*(vy-myMin);
    return [u*sx, v*sy];
  }, rasterSize);

  var n = rasterSize*rasterSize;
  var rgba = new Uint8ClampedArray(n*4);
  for(var i=0;i<n;i++){
    var a = actual[i], p = pred[i];
    var r=0,g=0,b=0;
    if(a && p){ r=g=b=255; }
    else if(a && !p){ g=255; } // 実測のみ前景=予測が削りすぎ
    else if(!a && p){ r=255; } // 予測のみ前景=予測が余っている
    rgba[i*4]=r; rgba[i*4+1]=g; rgba[i*4+2]=b; rgba[i*4+3]=255;
  }
  // 境界距離: 実測シルエットの輪郭画素それぞれについて、予測シルエットの
  // SDF(符号付き距離場)を引いて「予測の輪郭までの距離」を直接読む
  // (最近傍探索を書かずに済む。js/edt.jsのsignedDistanceFieldを流用)。
  var predSdf = P3D.signedDistanceField(pred, rasterSize, rasterSize);
  var boundaryDists = [];
  for(var y=1;y<rasterSize-1;y++){
    var rowOff = y*rasterSize;
    for(var x=1;x<rasterSize-1;x++){
      var i2 = rowOff+x;
      if(!actual[i2]) continue;
      var isBoundary = !actual[i2-1]||!actual[i2+1]||!actual[i2-rasterSize]||!actual[i2+rasterSize];
      if(!isBoundary) continue;
      boundaryDists.push(Math.abs(predSdf[i2]));
    }
  }
  boundaryDists.sort(function(a,b){ return a-b; });
  var meanD = boundaryDists.length ? boundaryDists.reduce(function(s,v){return s+v;},0)/boundaryDists.length : 0;
  var p95D = boundaryDists.length ? boundaryDists[Math.floor(boundaryDists.length*0.95)] : 0;
  var maxD = boundaryDists.length ? boundaryDists[boundaryDists.length-1] : 0;

  return {
    w: rasterSize, h: rasterSize, iou: _calibMaskIoU(pred, actual),
    boundaryMeanPx: meanD, boundaryP95Px: p95D, boundaryMaxPx: maxD,
    overlayRGBA: rgba,
  };
}
P3D.renderReprojectionOverlayAt = renderReprojectionOverlayAt;

})(window);
