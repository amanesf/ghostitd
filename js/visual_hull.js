// -*- coding: utf-8 -*-
// pipeline_lib/visual_hull.py の stage_visual_hull() のJS移植。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

/**
 * opts: {
 *   frontAlpha,backAlpha,sideAlpha: Uint8Array(front/back/side_cut相当。除外マスク適用済み)
 *   faW,faH,saW,saH: 画像サイズ
 *   frontCont,backCont,sideCont: Float32Array|null (subpixel補正用連続値)
 *   SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF: キャリブレーション
 *   pivots: skeleton.computePivots()の戻り値.pivots(+extraPivotsをmergeしたもの)
 *   gp: gen_params(パラメータタブの現在値)
 * }
 * 戻り値: {V,N,F,J,W} (Float32Array/Uint32Array/Uint16Array)
 */
function stageVisualHull(opts){
  var gp = opts.gp;
  var BODY_VOX = gp.body_vox;
  var mxBounds=[-0.62,0.62], myBounds=[-0.02,1.05], mzBounds=[-0.22,0.22];

  var armLines=[];
  if(gp.arm_circle){
    ['L','R'].forEach(function(side){
      var sh=opts.pivots['upperarm_'+side], el=opts.pivots['forearm_'+side], wr=opts.pivots['wrist_'+side];
      if(sh && el) armLines.push([[sh[0],sh[1]],[el[0],el[1]]]);
      if(el && wr) armLines.push([[el[0],el[1]],[wr[0],wr[1]]]);
    });
  }
  // 手首から先(手)の線分: 前腕方向に手首から延長する。長さは肩→手首の45%
  // (実測で指先は手首から肩→手首距離の3割程度先にあり、余らせても列走査が
  // シルエット外で自動的に打ち切られるため長め側に倒す)。手はこの線分の
  // 近傍列を「frontシルエットを一定奥行き(hand_depth)で押し出した板」として
  // 彫る(carving.js)。
  var handLines=[];
  if(gp.hand_extrude!==false){
    ['L','R'].forEach(function(side){
      var sh=opts.pivots['upperarm_'+side], el=opts.pivots['forearm_'+side], wr=opts.pivots['wrist_'+side];
      if(!(sh && el && wr)) return;
      var dx=wr[0]-el[0], dy=wr[1]-el[1];
      var len=Math.hypot(dx,dy);
      if(len<1e-6) return;
      var handLen=gp.hand_len;
      handLines.push([[wr[0],wr[1]],[wr[0]+dx/len*handLen, wr[1]+dy/len*handLen]]);
    });
  }

  var result = P3D.carveRegion({
    fa: opts.frontAlpha, ba: opts.backAlpha, sa: opts.sideAlpha,
    faW: opts.faW, faH: opts.faH, saW: opts.saW, saH: opts.saH,
    faCont: gp.subpixel ? opts.frontCont : null,
    baCont: gp.subpixel ? opts.backCont : null,
    saCont: gp.subpixel ? opts.sideCont : null,
    SCALE: opts.SCALE, CX: opts.CX, CXBack: opts.CXBack, YBOT: opts.YBOT, SYTOP: opts.SYTOP, SYBOT: opts.SYBOT, SIDE_REF: opts.SIDE_REF,
    mxBounds: mxBounds, myBounds: myBounds, mzBounds: mzBounds,
    vox: BODY_VOX, psqHull: gp.psq_hull, trackGap: gp.track_gap, trackWin: gp.track_win,
    smoothIters: gp.body_smooth_iters,
    armLines: armLines, armMaxHw: gp.arm_max_hw,
    handLines: handLines.length ? handLines : null,
    handDepthHw: gp.hand_depth, handMaxHw: gp.hand_max_hw,
    whiteThr: gp.white_thr,
  });
  if(!result) throw new Error("visual_hull: carving produced an empty mesh");
  var V=result.V, F=result.F;
  console.log("  visual_hull: verts(before decimation)", V.length/3, "faces", F.length/3);

  if(gp.body_decimate){
    var dec = P3D.decimateMesh(V, F, gp.body_target_verts);
    V=dec.V; F=dec.F;
  }
  var fw = P3D.computeNormalsFixWinding(V,F);
  var Nv=fw.N; F=fw.F;
  console.log("  visual_hull: verts", V.length/3, "faces", F.length/3);

  var skin = P3D.nearestBoneSegmentSkin(V, opts.pivots, P3D.BONES, 4);
  console.log("  visual_hull: skinning weights assigned (nearest-bone-segment)");

  return {V:V, N:Nv, F:F, J:skin.J, W:skin.W};
}
P3D.stageVisualHull = stageVisualHull;

})(window);
