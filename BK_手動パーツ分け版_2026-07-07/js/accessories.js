// -*- coding: utf-8 -*-
// pipeline_lib/accessories.py の stage_accessories() のJS移植。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

function extractRgbaWindow(fullRgba, fullW, fullH, x0,y0,x1,y1){
  x0=Math.max(0,Math.floor(x0)); y0=Math.max(0,Math.floor(y0));
  x1=Math.min(fullW,Math.ceil(x1)); y1=Math.min(fullH,Math.ceil(y1));
  var w=x1-x0, h=y1-y0;
  if(w<2||h<2) return null;
  var out=new Uint8ClampedArray(w*h*4);
  for(var y=0;y<h;y++){
    var srcOff=((y0+y)*fullW+x0)*4;
    var dstOff=(y*w)*4;
    out.set(fullRgba.subarray(srcOff, srcOff+w*4), dstOff);
  }
  return {rgba:out, w:w, h:h, x0:x0, y0:y0};
}

// accessories.py _local_alpha_band相当
function localAlphaBand(fullRgba, fullW, fullH, x0,y0,x1,y1, whiteThr){
  var win = extractRgbaWindow(fullRgba, fullW, fullH, x0,y0,x1,y1);
  var out = new Uint8Array(fullW*fullH);
  if(!win) return out;
  var background = P3D.whiteBackgroundMask(win.rgba, win.w, win.h, whiteThr, null);
  for(var y=0;y<win.h;y++){
    for(var x=0;x<win.w;x++){
      var i=y*win.w+x;
      if(!background[i]) out[(win.y0+y)*fullW+(win.x0+x)]=1;
    }
  }
  return out;
}

// accessories.py _local_alpha相当(帯分割)
function localAlpha(fullRgba, fullW, fullH, x0,y0,x1,y1, whiteThr, bandH, bandOverlap, pad){
  pad = (pad===undefined) ? 25 : pad;
  var x0i=Math.max(0,x0-pad), x1i=Math.min(fullW,x1+pad);
  var y0i=Math.max(0,y0), y1i=Math.min(fullH,y1);
  var out=new Uint8Array(fullW*fullH);
  if(x1i-x0i<2 || y1i-y0i<2) return out;
  var y=y0i, step=Math.max(1, bandH-bandOverlap);
  while(y<y1i){
    var by0=Math.max(0,y-pad), by1=Math.min(fullH, y+bandH+pad);
    var band = localAlphaBand(fullRgba, fullW, fullH, x0i,by0,x1i,by1, whiteThr);
    for(var i=0;i<out.length;i++){ if(band[i]) out[i]=1; }
    y+=step;
  }
  return out;
}
P3D.localAlpha = localAlpha;

function frontPointsToModel(pts, CX, SCALE, YBOT){
  return pts.map(function(p){ return [(p[0]-CX)/SCALE, (YBOT-p[1])/SCALE]; });
}
function backPointsToModel(pts, CX, SCALE, YBOT, W, backOffsetX, backOffsetY){
  backOffsetX=backOffsetX||0; backOffsetY=backOffsetY||0;
  return pts.map(function(p){ return [(W-p[0]-CX+backOffsetX)/SCALE, (YBOT-p[1]+backOffsetY)/SCALE]; });
}
function sidePointsToModel(pts, SIDE_REF, SCALE, SYTOP, SYBOT){
  return pts.map(function(p){ return [(p[0]-SIDE_REF)/SCALE, 1.0-(p[1]-SYTOP)/(SYBOT-SYTOP)]; });
}
function bboxOf(pointsModel, padFrac){
  padFrac = (padFrac===undefined)?0.05:padFrac;
  var xs=pointsModel.map(function(p){return p[0];}), ys=pointsModel.map(function(p){return p[1];});
  var x0=Math.min.apply(null,xs), x1=Math.max.apply(null,xs);
  var y0=Math.min.apply(null,ys), y1=Math.max.apply(null,ys);
  var px=(x1-x0)*padFrac, py=(y1-y0)*padFrac;
  return [x0-px,x1+px,y0-py,y1+py];
}

/**
 * opts: {
 *   accs: [{name,mode,bones,regions:{front:{points},back:{points},side:{points}}}, ...]
 *   frontRgba,backRgba,sideRgba: Uint8ClampedArray(W*H*4) 元画像(front.png等)そのまま
 *   W,H: 画像サイズ, SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF: キャリブレーション
 *   frontCont,backCont,sideCont: Float32Array(W*H) min(RGB)連続値
 *   pivots: skeleton pivots(soft skinning用)
 *   gp: gen_params
 * }
 * 戻り値: {V,N,F,J,W,NF} または null(アクセサリー無し/生成失敗時)
 */
function stageAccessories(opts){
  var gp = opts.gp;
  var W=opts.W, H=opts.H, SCALE=opts.SCALE, CX=opts.CX, YBOT=opts.YBOT;
  var SYTOP=opts.SYTOP, SYBOT=opts.SYBOT, SIDE_REF=opts.SIDE_REF;
  var backOffsetX=gp.back_offset_x||0, backOffsetY=gp.back_offset_y||0;
  var sideOffsetX=gp.side_offset_x||0, sideOffsetY=gp.side_offset_y||0;
  var accs = opts.accs || [];
  if(!accs.length) return null;

  var allV=[],allN=[],allF=[],allJ=[],allW=[],allNF=[],allAccName=[]; var voff=0;
  var rawParts=[]; // フェーズ1: 彫刻直後(平滑化/間引き前)のアクセサリー別メッシュ

  accs.forEach(function(acc){
    var name = acc.name || 'accessory';
    var mode = acc.mode || 'rigid';
    var bones = acc.bones || [];
    var regions = acc.regions || {};
    var fr=regions.front, bk=regions.back, sd=regions.side;
    var frontPolygon=null, backPolygon=null, sidePolygon=null;
    var mxMin,mxMax,myMin,myMax,mzMin,mzMax;
    if(fr && fr.points && fr.points.length){
      frontPolygon = frontPointsToModel(fr.points, CX, SCALE, YBOT);
      var bb=bboxOf(frontPolygon); mxMin=bb[0];mxMax=bb[1];myMin=bb[2];myMax=bb[3];
    }else if(bk && bk.points && bk.points.length){
      backPolygon = backPointsToModel(bk.points, CX, SCALE, YBOT, W, backOffsetX, backOffsetY);
      var bb2=bboxOf(backPolygon); mxMin=bb2[0];mxMax=bb2[1];myMin=bb2[2];myMax=bb2[3];
    }else{
      console.log("  accessories: skip", name, "(front/back範囲なし)");
      return;
    }
    if(sd && sd.points && sd.points.length){
      sidePolygon = sidePointsToModel(sd.points, SIDE_REF, SCALE, SYTOP, SYBOT);
      var bb3=bboxOf(sidePolygon); mzMin=bb3[0];mzMax=bb3[1];
    }else{
      var hw=(mxMax-mxMin)/2; mzMin=-hw*0.6; mzMax=hw*0.6;
    }

    var faAcc = localAlpha(opts.frontRgba, W, H, mxMin*SCALE+CX, YBOT-myMax*SCALE, mxMax*SCALE+CX, YBOT-myMin*SCALE,
                           gp.white_thr, gp.band_h, gp.band_overlap);
    var baAcc = localAlpha(opts.backRgba, W, H, W-(mxMax*SCALE+CX)+backOffsetX, YBOT-myMax*SCALE+backOffsetY, W-(mxMin*SCALE+CX)+backOffsetX, YBOT-myMin*SCALE+backOffsetY,
                           gp.white_thr, gp.band_h, gp.band_overlap);
    var sx0=SIDE_REF+mzMin*SCALE+sideOffsetX, sx1=SIDE_REF+mzMax*SCALE+sideOffsetX;
    var sy0=SYTOP+(1.0-myMax)*(SYBOT-SYTOP)+sideOffsetY, sy1=SYTOP+(1.0-myMin)*(SYBOT-SYTOP)+sideOffsetY;
    var saAcc = localAlpha(opts.sideRgba, W, H, sx0,sy0,sx1,sy1, gp.white_thr, gp.band_h, gp.band_overlap);

    var result = P3D.carveRegion({
      fa:faAcc, ba:baAcc, sa:saAcc, faW:W, faH:H, saW:W, saH:H,
      faCont: gp.subpixel ? opts.frontCont : null,
      baCont: gp.subpixel ? opts.backCont : null,
      saCont: gp.subpixel ? opts.sideCont : null,
      SCALE:SCALE, CX:CX, YBOT:YBOT, SYTOP:SYTOP, SYBOT:SYBOT, SIDE_REF:SIDE_REF,
      backOffsetX:backOffsetX, backOffsetY:backOffsetY, sideOffsetX:sideOffsetX, sideOffsetY:sideOffsetY,
      mxBounds:[mxMin,mxMax], myBounds:[myMin,myMax], mzBounds:[mzMin,mzMax],
      vox: gp.acc_vox,
      // アクセサリーは頭/胴体/脚のような部位分けが無いため、部位別指数は
      // 全て同じ値(psq_acc)を渡す(neckY/hipsYを渡さないのでcarveRegion側は
      // 常にpsqTorso=psq_accを使う)。
      psqHead: gp.psq_acc, psqTorso: gp.psq_acc, psqLegs: gp.psq_acc,
      psqArms: gp.psq_acc, psqHands: gp.psq_acc,
      trackGap: gp.track_gap, trackWin: gp.track_win,
      // ★フェーズ1: bodyと同様、平滑化前の生メッシュをキャッシュするため
      // carveRegion自体には常にsmoothIters:0を渡し、平滑化はfinishAccessoryMesh
      // 側で別途適用する。
      smoothIters: 0,
      frontPolygon: frontPolygon, backPolygon: backPolygon, sidePolygon: sidePolygon,
      whiteThr: gp.white_thr,
    });
    if(!result){ console.warn("  accessories: carve失敗、このアクセサリーはモデルに含まれません:", name); return; }
    var rawV=result.V, rawF=result.F;
    rawParts.push({name:name, mode:mode, bones:bones.slice(), rawV:rawV, rawF:rawF});
    var finished=finishAccessoryMesh(rawV, rawF, gp);
    var V=finished.V, F=finished.F;
    var fw=P3D.computeNormalsFixWinding(V,F);
    var Nv=fw.N; F=fw.F;

    var skin;
    if(mode==='rigid'){
      var bone = bones[0] || 'head';
      skin = P3D.rigidSkin(V, bone);
    }else{
      skin = P3D.nearestBoneSegmentSkin(V, opts.pivots, bones.length?bones:P3D.BONES, 4, gp.rigid_soft_width);
    }
    allV.push(V); allN.push(Nv);
    for(var i=0;i<F.length;i++) allF.push(F[i]+voff);
    allJ.push(skin.J); allW.push(skin.W);
    var nv=V.length/3;
    var nf = (frontPolygon===null);
    for(var i2=0;i2<nv;i2++){ allNF.push(nf); allAccName.push(name); }
    voff += nv;
    console.log("  accessories:", name, "verts", nv, "tris", F.length/3, "mode", mode, "bones", bones);
  });

  if(!allV.length){ console.log("  accessories: 生成できたメッシュなし"); return null; }
  var V=P3D.concatTypedArrays(Float32Array,allV), Nv=P3D.concatTypedArrays(Float32Array,allN);
  var F=Uint32Array.from(allF);
  var J=P3D.concatTypedArrays(Uint16Array,allJ);
  var Wt=P3D.concatTypedArrays(Float32Array,allW);
  var NF=Uint8Array.from(allNF.map(function(b){return b?1:0;}));
  console.log("  accessories: total verts", V.length/3);
  return {V:V, N:Nv, F:F, J:J, W:Wt, NF:NF, accName:allAccName, rawParts:rawParts};
}
P3D.stageAccessories = stageAccessories;

// ★フェーズ1: rawV/rawF(彫刻直後・平滑化/間引き前)にgen_paramsのacc_smooth_iters/
// acc_decimate/acc_target_vertsを適用する(visual_hull.jsのfinishBodyMeshの
// アクセサリー版)。ビューア側でrawParts配列の各要素にこれを呼び直すことで、
// 再彫刻なしに平滑化/間引きパラメータを反映できる(フェーズ2で使用)。
function finishAccessoryMesh(rawV, rawF, gp){
  var V=rawV, F=rawF;
  if(gp.acc_smooth_iters>0) V=P3D.laplacianSmooth(V,F,gp.acc_smooth_iters);
  if(gp.acc_decimate){
    var dec=P3D.decimateMesh(V,F,gp.acc_target_verts);
    V=dec.V; F=dec.F;
  }
  return {V:V, F:F};
}
P3D.finishAccessoryMesh = finishAccessoryMesh;

})(window);
