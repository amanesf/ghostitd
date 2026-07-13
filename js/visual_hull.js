// -*- coding: utf-8 -*-
// pipeline_lib/visual_hull.py の stage_visual_hull() のJS移植。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

/**
 * ★2026-07-10(体+アクセサリー統合彫刻対応): 体のcarveRegion opts(mxBounds等の
 * 外接範囲込み)を組み立てるだけの関数。以前はstageVisualHull内で組み立てて
 * そのままcarveRegionを呼んでいたが、体+全アクセサリーを1つの共有グリッドで
 * 統合彫刻する新方式(js/pipeline.jsのrunCarvingStages参照)のため、
 * 「optsを組み立てる」と「実際に彫る」を分離した。
 * opts: stageVisualHullと同じ引数。
 * 戻り値: {mxBounds,myBounds,mzBounds,carveOpts}
 *   (carveOptsはP3D.carveRegion/carveUnifiedRegionsにそのまま渡せる形。
 *   grid/accumulateは呼び出し側=carveUnifiedRegionsが付加する)
 */
function buildBodyCarveOpts(opts){
  var gp = opts.gp;
  var mxBounds=[-0.62,0.62], myBounds=[-0.02,1.05], mzBounds=[-0.22,0.22];

  var armLines=[];
  if(gp.arm_circle){
    ['L','R'].forEach(function(side){
      var sh=opts.pivots['upperarm_'+side], el=opts.pivots['forearm_'+side], wr=opts.pivots['wrist_'+side];
      if(sh && el) armLines.push([[sh[0],sh[1]],[el[0],el[1]]]);
      if(el && wr) armLines.push([[el[0],el[1]],[wr[0],wr[1]]]);
    });
  }
  // 手首から先(手)の線分: 前腕方向に手首から延長する。手はこの線分の
  // 近傍列を「frontシルエットを一定奥行き(hand_depth)で押し出した板」として
  // 彫る(carving.js)。
  // ★2026-07-15(ユーザー指摘「手の高さが足りない、固定値ではなく自動でいい」):
  // 以前はhand_len/hand_max_hw(手の長さ・太さとみなす上限)を固定のmodel単位
  // 定数で設定していたが、キャラクターの体格によっては前腕に対して手が
  // 相対的に大きく、この固定値では列走査(buildBoneProfiles)の縦幅上限に
  // 引っかかって手の一部が「手」として扱われず高さ不足になっていた。
  // 前腕(肘→手首)の長さlenに比例させることで、体格が変わっても自動的に
  // 追従するようにする(はみ出した列は実シルエットが見つからず自然に除外
  // されるので、多少大きめに取っても誤爆のリスクは低い)。
  var handLines=[];
  var handMaxHwAuto=0.06;
  if(gp.hand_extrude!==false){
    ['L','R'].forEach(function(side){
      var sh=opts.pivots['upperarm_'+side], el=opts.pivots['forearm_'+side], wr=opts.pivots['wrist_'+side];
      if(!(sh && el && wr)) return;
      var dx=wr[0]-el[0], dy=wr[1]-el[1];
      var len=Math.hypot(dx,dy);
      if(len<1e-6) return;
      var handLen=len*0.9;
      handLines.push([[wr[0],wr[1]],[wr[0]+dx/len*handLen, wr[1]+dy/len*handLen]]);
      handMaxHwAuto=Math.max(handMaxHwAuto, len*0.8);
    });
  }

  var carveOpts = {
    fa: opts.frontAlpha, ba: opts.backAlpha, sa: opts.sideAlpha,
    faW: opts.faW, faH: opts.faH, saW: opts.saW, saH: opts.saH,
    // ★2026-07-11: gp.subpixel_edges有効時、js/pipeline.jsが最近傍色分類の
    // ボロノイ境界に対応するサブピクセル指標(P3D.boundaryContForCandidate)を
    // frontCont/backCont/sideContとして渡す(無効時・face_sculpt等の後方互換
    // 呼び出しではnull、carveRegion側は従来通りCommon.findRunsで整数px境界を
    // 使う)。旧・白背景しきい値ベースのサブピクセル補正(輝度専用)とは別の
    // 仕組みのため、whiteThrは0(cont=0がちょうど分類境界)を明示する。
    faCont: opts.frontCont, baCont: opts.backCont, saCont: opts.sideCont,
    whiteThr: 0,
    SCALE: opts.SCALE, CX: opts.CX, YBOT: opts.YBOT, SYTOP: opts.SYTOP, SYBOT: opts.SYBOT, SIDE_REF: opts.SIDE_REF,
    backOffsetX: gp.back_offset_x, backOffsetY: gp.back_offset_y,
    sideOffsetX: gp.side_offset_x, sideOffsetY: gp.side_offset_y,
    mxBounds: mxBounds, myBounds: myBounds, mzBounds: mzBounds,
    // ★2026-07-14: carveRegion内のvoxはセグメント統合・ノイズ床等のX/Z
    // (横・奥行き)方向の閾値にしか使わないため、body_vox_xz(横方向解像度)
    // を使う(縦方向の行数自体はgrid.ny、buildGrid参照)。
    vox: gp.body_vox_xz,
    psqHead: gp.psq_head, psqTorso: gp.psq_torso, psqLegs: gp.psq_legs,
    psqArms: gp.psq_arms, psqHands: gp.psq_hands,
    neckY: opts.pivots.neck ? opts.pivots.neck[1] : null,
    hipsY: opts.pivots.hips ? opts.pivots.hips[1] : null,
    trackWin: gp.track_win,
    trackGapClosePx: gp.track_gap_close_px,
    depthGapClosePx: gp.depth_gap_close_px,
    smoothIters: 0,
    armLines: armLines, armMaxHw: gp.arm_max_hw,
    handLines: handLines.length ? handLines : null,
    handDepthHw: gp.hand_depth, handMaxHw: handMaxHwAuto,
    // ★2026-07-10: 全身シルエットが色分けマップの黒(体色)のみで判定される
    // ようになったことで、マフラー/スカート等に覆われた行で体が分断され、
    // 頭部や脚が独立した閉じたパーツとして彫られることがある。これは
    // 正当な体のパーツなので、dropSmallFragments(js/carving.js)の既定閾値
    // (最大成分比5%未満を削除)では消さないよう、極小ノイズだけを除去する
    // 値まで下げる。
    minFragFrac: 0.001,
  };
  // ★2026-07-11追加(顔の立体感対応): eye_L/eye_Rランドマークがあり、
  // face_sculptが無効化されていなければ、彫刻済みの頭部表面へ局所的な目窩の
  // 凹みを彫る(js/carving.jsのapplyEyeSocketRecess参照)。目窩はfront/back/
  // sideどのシルエット輪郭にも現れない内部形状のため、凹ませても輪郭(=元
  // イラストの実測データ)とは矛盾しない。landmarkが無い旧プロジェクトは
  // 何も変わらない(faceSculpt:nullでapplyEyeSocketRecess自体がスキップ
  // される)。
  if(gp.face_sculpt!==false && (opts.faceEyeL || opts.faceEyeR)){
    carveOpts.faceSculpt = {
      eyeL: opts.faceEyeL, eyeR: opts.faceEyeR,
      eyeSocketDepth: gp.eye_socket_depth,
      eyeSocketRadiusX: gp.eye_socket_radius_x,
      eyeSocketRadiusY: gp.eye_socket_radius_y,
    };
  }
  return {mxBounds:mxBounds, myBounds:myBounds, mzBounds:mzBounds, carveOpts:carveOpts};
}
P3D.buildBodyCarveOpts = buildBodyCarveOpts;

/**
 * opts: {
 *   frontAlpha,backAlpha,sideAlpha: Uint8Array(front/back/side_cut相当。除外マスク適用済み)
 *   faW,faH,saW,saH: 画像サイズ
 *   frontCont,backCont,sideCont: Float32Array|null (常にnull。色分けマップ由来の
 *     マスクは既にくっきりした2値のためサブピクセル補正は行わない)
 *   SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF: キャリブレーション
 *   pivots: skeleton.computePivots()の戻り値.pivots(+extraPivotsをmergeしたもの)
 *   gp: gen_params(パラメータタブの現在値)
 * }
 * 戻り値: {V,N,F,J,W} (Float32Array/Uint32Array/Uint16Array)
 * ★2026-07-10: 体+アクセサリーの統合彫刻(js/pipeline.jsのrunCarvingStages)
 * からはもう呼ばれない(buildBodyCarveOptsだけを使う)。単体で体だけを
 * 素朴に彫りたい場合のために後方互換として残す。
 */
function stageVisualHull(opts){
  var gp = opts.gp;
  var built = buildBodyCarveOpts(opts);
  var result = P3D.carveRegion(built.carveOpts);
  if(!result) throw new Error("visual_hull: carving produced an empty mesh");
  var rawV=result.V, rawF=result.F;
  console.log("  visual_hull: raw verts(彫刻直後)", rawV.length/3, "faces", rawF.length/3);

  var finished=finishBodyMesh(rawV, rawF, gp);
  var V=finished.V, F=finished.F;
  var fw = P3D.computeNormalsFixWinding(V,F);
  var Nv=fw.N; F=fw.F;
  console.log("  visual_hull: verts", V.length/3, "faces", F.length/3);

  var skin = P3D.nearestBoneSegmentSkin(V, opts.pivots, P3D.BONES, 4, gp.rigid_soft_width);
  console.log("  visual_hull: skinning weights assigned (nearest-bone-segment)");

  return {V:V, N:Nv, F:F, J:skin.J, W:skin.W, rawV:rawV, rawF:rawF};
}
P3D.stageVisualHull = stageVisualHull;

// ★フェーズ1: rawV/rawF(彫刻直後・平滑化/間引き前)にgen_paramsのsmooth_iters/
// decimate/decimate_strengthを適用して最終メッシュ(法線計算前)を作る。
// character_3d.htmlのビューア側でキャッシュ済みrawV/rawFを再彫刻せずにこの関数
// だけ呼び直せば、平滑化/間引きパラメータを即時反映できる(フェーズ2で使用)。
// ★2026-07-10以降、体+アクセサリー統合彫刻(js/pipeline.jsのrunCarvingStages)
// からは呼ばれなくなった後方互換用(stageVisualHull内でのみ使用)。
// ★2026-07-11: gen_paramsのbody_smooth_iters/body_decimate/body_target_vertsが
// smooth_iters/decimate/target_vertsに統合されたのに合わせて参照名を更新。
// ★2026-07-12: target_vertsがdecimate_strengthに置き換わったのに合わせて
// 参照名を更新(js/carving.jsのdecimateMesh参照)。
function finishBodyMesh(rawV, rawF, gp){
  var V=rawV, F=rawF;
  if(gp.smooth_iters>0) V=P3D.laplacianSmoothPreserveExtent(V,F,gp.smooth_iters);
  if(gp.decimate){
    var dec=P3D.decimateMesh(V,F,gp.decimate_strength);
    V=dec.V; F=dec.F;
  }
  return {V:V, F:F};
}
P3D.finishBodyMesh = finishBodyMesh;

})(window);
