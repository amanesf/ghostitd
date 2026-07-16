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

// 矩形範囲をそのまま塗りつぶしたアルファ(実画像のピクセルは一切参照しない)。
// mask形式アクセサリーでside面のマスクが無い場合、粗い深さ推定の矩形を
// そのまま使うためのもの(GHOST_SCANNER_PLAN.md 原因①対応)。
function rectAlpha(fullW, fullH, x0,y0,x1,y1){
  var x0i=Math.max(0,Math.floor(x0)), x1i=Math.min(fullW,Math.ceil(x1));
  var y0i=Math.max(0,Math.floor(y0)), y1i=Math.min(fullH,Math.ceil(y1));
  var out=new Uint8Array(fullW*fullH);
  for(var y=y0i;y<y1i;y++){
    for(var x=x0i;x<x1i;x++){ out[y*fullW+x]=1; }
  }
  return out;
}

// front画像ピクセル座標からモデル座標への変換(pixelBboxToModelBboxの
// toModelFn引数として使う。多角形(regions)形式廃止後もmask.*.bboxの変換に使う)。
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

// マスク(色分けマップ由来、regions.mask.{front,back,side}={bbox:[x0,y0,x1,y1](画像
// ピクセル座標)})の外接矩形を、多角形のbboxOf()と同じ「モデル座標の[x0,x1,y0,y1]」
// 形式に変換する。マスクのピクセルbboxの四隅を各view座標変換関数に通してから
// モデル空間でのmin/maxを取る(多角形と同じ経路でスケール/オフセットを反映するため)。
function pixelBboxToModelBbox(pxBbox, toModelFn){
  var x0=pxBbox[0], y0=pxBbox[1], x1=pxBbox[2], y1=pxBbox[3];
  var corners=[[x0,y0],[x1,y0],[x0,y1],[x1,y1]];
  var modelPts = toModelFn(corners);
  return bboxOf(modelPts, 0.05);
}
P3D.pixelBboxToModelBbox = pixelBboxToModelBbox;

/**
 * opts: {
 *   accs: [{name,mode,bones,mask:{front:{...},back:{...},side:{...},leftSide:{...}}}, ...]
 *     (mask[view] = {maskDataUrl,bbox,alpha}。leftSideは左右非対称キャラ用の
 *     任意フィールドで、mask.sideの代わりに優先して使われる)
 *   frontRgba,backRgba,sideRgba: Uint8ClampedArray(*4) 元画像(front.png等)そのまま
 *   faW,faH: front/backの画像サイズ(carving.jsの前提通りback/frontは同サイズ)
 *   saW,saH: side画像のサイズ(front/backとは別サイズでよい)
 *   SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF: キャリブレーション
 *   laW,laH,LEFT_SYTOP,LEFT_SYBOT,LEFT_SIDE_REF: leftSide画像のキャリブレーション
 *     (pipeline.js側で水平反転済み。laW===0またはlaW未指定ならleftSide非対応、
 *     mask.leftSideを持つアクセサリーがあってもmask.sideにフォールバックする)
 *   pivots: skeleton pivots(soft skinning用)
 *   gp: gen_params
 * }
 * 戻り値: {V,N,F,J,W,NF} または null(アクセサリー無し/生成失敗時)
 */
/**
 * ★2026-07-10(体+アクセサリー統合彫刻対応): 各アクセサリーのcarveRegion opts
 * (mxBounds等の外接範囲込み)を組み立てるだけの関数。以前はstageAccessories
 * 内で組み立ててそのままcarveRegionを呼んでいたが、体+全アクセサリーを
 * 1つの共有グリッドで統合彫刻する新方式(js/pipeline.jsのrunCarvingStages
 * 参照)のため、「optsを組み立てる」と「実際に彫る」を分離した。
 * opts: stageAccessoriesと同じ引数。
 * 戻り値: [{name,mode,bones,mxBounds,myBounds,mzBounds,carveOpts}, ...]
 *   (front/back範囲が無く彫れないアクセサリーはスキップされ配列に含まれない)
 */
function buildAccessoryCarveOptsList(opts){
  var gp = opts.gp;
  var faW=opts.faW, faH=opts.faH, saW=opts.saW, saH=opts.saH;
  var SCALE=opts.SCALE, CX=opts.CX, YBOT=opts.YBOT;
  var SYTOP=opts.SYTOP, SYBOT=opts.SYBOT, SIDE_REF=opts.SIDE_REF;
  var backOffsetX=gp.back_offset_x||0, backOffsetY=gp.back_offset_y||0;
  var sideOffsetX=gp.side_offset_x||0, sideOffsetY=gp.side_offset_y||0;
  var laW=opts.laW||0, laH=opts.laH||0;
  var LEFT_SYTOP=opts.LEFT_SYTOP, LEFT_SYBOT=opts.LEFT_SYBOT, LEFT_SIDE_REF=opts.LEFT_SIDE_REF;
  var leftSideOffsetX=gp.leftside_offset_x||0, leftSideOffsetY=gp.leftside_offset_y||0;
  var accs = opts.accs || [];
  var out=[];

  accs.forEach(function(acc){
    var name = acc.name || 'accessory';
    var mode = acc.mode || 'rigid';
    var bones = acc.bones || [];
    // ★2026-07-12: 全アクセサリー共通の「まとめて設定」(gp.psq_acc)は廃止した
    // (各アクセサリーは必ず個別のpsq値を持つ)。ここでの2は、それでも欠けて
    // いた場合(壊れた/旧形式JSON等)に備えた安全側フォールバックに過ぎない。
    var accPsq = (acc.psq!==undefined && acc.psq!==null) ? acc.psq : 2;
    // ★2026-07-19追加: 尖り除去(js/carving.jsのspikeSmoothSelective)の
    // アクセサリー個別の強さ(0=対象外〜1)。既定0(無効)。
    var accSpikeSmooth = (acc.spikeSmooth!==undefined && acc.spikeSmooth!==null) ? acc.spikeSmooth : 0;
    var mask = acc.mask || {};
    var mxMin,mxMax,myMin,myMax,mzMin,mzMax;
    var usedBackOnly=false;
    if(mask.front && mask.front.bbox){
      var bbm=P3D.pixelBboxToModelBbox(mask.front.bbox, function(pts){ return frontPointsToModel(pts, CX, SCALE, YBOT); });
      mxMin=bbm[0];mxMax=bbm[1];myMin=bbm[2];myMax=bbm[3];
    }else if(mask.back && mask.back.bbox){
      var bbm2=P3D.pixelBboxToModelBbox(mask.back.bbox, function(pts){ return backPointsToModel(pts, CX, SCALE, YBOT, faW, backOffsetX, backOffsetY); });
      mxMin=bbm2[0];mxMax=bbm2[1];myMin=bbm2[2];myMax=bbm2[3];
      usedBackOnly=true;
    }else{
      console.log("  accessories: skip", name, "(front/back範囲なし)");
      return;
    }
    var useLeftSide = !!(laW && mask.leftSide && mask.leftSide.bbox);
    var sideMask = useLeftSide ? mask.leftSide : mask.side;
    var curSAW = useLeftSide ? laW : saW;
    var curSAH = useLeftSide ? laH : saH;
    var curSYTOP = useLeftSide ? LEFT_SYTOP : SYTOP;
    var curSYBOT = useLeftSide ? LEFT_SYBOT : SYBOT;
    var curSIDE_REF = useLeftSide ? LEFT_SIDE_REF : SIDE_REF;
    var curSideOffsetX = useLeftSide ? leftSideOffsetX : sideOffsetX;
    var curSideOffsetY = useLeftSide ? leftSideOffsetY : sideOffsetY;
    if(sideMask && sideMask.bbox){
      var bbm3=P3D.pixelBboxToModelBbox(sideMask.bbox, function(pts){ return sidePointsToModel(pts, curSIDE_REF, SCALE, curSYTOP, curSYBOT); });
      mzMin=bbm3[0];mzMax=bbm3[1];
    }else{
      var hw=(mxMax-mxMin)/2; mzMin=-hw*0.6; mzMax=hw*0.6;
    }

    var faAcc = (mask.front && mask.front.alpha) ? mask.front.alpha : new Uint8Array(faW*faH);
    var baAcc = (mask.back && mask.back.alpha) ? mask.back.alpha : new Uint8Array(faW*faH);
    // ★2026-07-11: gp.subpixel_edges有効時、js/pipeline.jsがmask[view].contに
    // 最近傍色分類のサブピクセル境界指標(P3D.boundaryContForCandidate)を
    // 載せている(体側と同じ仕組み、js/visual_hull.jsのbuildBodyCarveOpts参照)。
    var faContAcc = (mask.front && mask.front.cont) ? mask.front.cont : null;
    var baContAcc = (mask.back && mask.back.cont) ? mask.back.cont : null;
    var saAcc, saContAcc=null;
    if(sideMask && sideMask.alpha){
      saAcc = sideMask.alpha;
      saContAcc = sideMask.cont || null;
    }else{
      var sx0=curSIDE_REF+mzMin*SCALE+curSideOffsetX, sx1=curSIDE_REF+mzMax*SCALE+curSideOffsetX;
      var sy0=curSYTOP+(1.0-myMax)*(curSYBOT-curSYTOP)+curSideOffsetY, sy1=curSYTOP+(1.0-myMin)*(curSYBOT-curSYTOP)+curSideOffsetY;
      saAcc = rectAlpha(curSAW, curSAH, sx0, sy0, sx1, sy1);
    }

    var carveOpts = {
      fa:faAcc, ba:baAcc, sa:saAcc, faW:faW, faH:faH, saW:curSAW, saH:curSAH,
      faCont: faContAcc, baCont: baContAcc, saCont: saContAcc,
      whiteThr: 0,
      SCALE:SCALE, CX:CX, YBOT:YBOT, SYTOP:curSYTOP, SYBOT:curSYBOT, SIDE_REF:curSIDE_REF,
      backOffsetX:backOffsetX, backOffsetY:backOffsetY, sideOffsetX:curSideOffsetX, sideOffsetY:curSideOffsetY,
      mxBounds:[mxMin,mxMax], myBounds:[myMin,myMax], mzBounds:[mzMin,mzMax],
      // ★2026-07-10(体+アクセサリー統合彫刻対応): 共有グリッド(body_vox_xz/
      // body_voxで作る)へ統合するため、voxもグリッドのX/Z軸解像度(body_vox_xz)
      // に揃える(閾値判定(最小セグメント幅等)はX/Z方向の量のため。
      // acc_voxは独立彫刻時代の名残で、統合彫刻では使わない)。
      // ★2026-07-14: 縦横解像度分離に伴いbody_vox_xzを使うよう更新。
      vox: gp.body_vox_xz,
      psqHead: accPsq, psqTorso: accPsq, psqLegs: accPsq,
      psqArms: accPsq, psqHands: accPsq,
      smoothIters: 0,
    };
    out.push({name:name, mode:mode, bones:bones.slice(), usedBackOnly:usedBackOnly,
      mxBounds:[mxMin,mxMax], myBounds:[myMin,myMax], mzBounds:[mzMin,mzMax], carveOpts:carveOpts,
      spikeSmooth:accSpikeSmooth});
  });
  return out;
}
P3D.buildAccessoryCarveOptsList = buildAccessoryCarveOptsList;

// ★2026-07-10: 体+アクセサリーの統合彫刻(js/pipeline.jsのrunCarvingStages)
// からはもう呼ばれない(buildAccessoryCarveOptsListだけを使う)。単体で
// アクセサリーだけを素朴に彫りたい場合のために後方互換として残す。
function stageAccessories(opts){
  var gp = opts.gp;
  // ★2026-07-08バグ修正(GHOST_SCANNER_PLAN.md「運用面の修正6点・③」): 以前は
  // front基準の単一W,Hをfront/back/side全ての領域抽出・carveRegion呼び出しに
  // 使い回しており、front/side画像のピクセル寸法が食い違うと側面のアクセサリー
  // 抽出位置・スケールがズレていた。stageVisualHullと同じくfaW/faH(front+back)
  // とsaW/saH(side)を区別する。
  var faW=opts.faW, faH=opts.faH, saW=opts.saW, saH=opts.saH;
  var SCALE=opts.SCALE, CX=opts.CX, YBOT=opts.YBOT;
  var SYTOP=opts.SYTOP, SYBOT=opts.SYBOT, SIDE_REF=opts.SIDE_REF;
  var backOffsetX=gp.back_offset_x||0, backOffsetY=gp.back_offset_y||0;
  var sideOffsetX=gp.side_offset_x||0, sideOffsetY=gp.side_offset_y||0;
  // ★2026-07-09(左右非対称キャラ対応): leftSide(左向き側面。pipeline.js側で
  // sideと同じ座標変換式を再利用できるよう既に水平反転済み)のキャリブレーション。
  // laW/laH===0はleftSide画像が渡されていない(非対応/従来通り)ことを示す。
  var laW=opts.laW||0, laH=opts.laH||0;
  var LEFT_SYTOP=opts.LEFT_SYTOP, LEFT_SYBOT=opts.LEFT_SYBOT, LEFT_SIDE_REF=opts.LEFT_SIDE_REF;
  var leftSideOffsetX=gp.leftside_offset_x||0, leftSideOffsetY=gp.leftside_offset_y||0;
  var accs = opts.accs || [];
  if(!accs.length) return null;

  var allV=[],allN=[],allF=[],allJ=[],allW=[],allNF=[],allAccName=[]; var voff=0;
  var rawParts=[]; // フェーズ1: 彫刻直後(平滑化/間引き前)のアクセサリー別メッシュ

  accs.forEach(function(acc){
    var name = acc.name || 'accessory';
    var mode = acc.mode || 'rigid';
    var bones = acc.bones || [];
    // ★2026-07-12: 全アクセサリー共通の「まとめて設定」(gp.psq_acc)は廃止した
    // (各アクセサリーは必ず個別のpsq値を持つ)。ここでの2は、それでも欠けて
    // いた場合(壊れた/旧形式JSON等)に備えた安全側フォールバックに過ぎない。
    var accPsq = (acc.psq!==undefined && acc.psq!==null) ? acc.psq : 2;
    // accessoryはマスク(mask[view].bbox、色分けマップ由来・自動抽出のみ)形式
    // だけを持つ(多角形(regions)形式は2026-07-09に廃止)。実際の3D彫刻は
    // bbox範囲内のアルファ検出(carveRegion)で行われる。
    var mask = acc.mask || {};
    var mxMin,mxMax,myMin,myMax,mzMin,mzMax;
    var usedBackOnly=false;
    if(mask.front && mask.front.bbox){
      var bbm=P3D.pixelBboxToModelBbox(mask.front.bbox, function(pts){ return frontPointsToModel(pts, CX, SCALE, YBOT); });
      mxMin=bbm[0];mxMax=bbm[1];myMin=bbm[2];myMax=bbm[3];
    }else if(mask.back && mask.back.bbox){
      var bbm2=P3D.pixelBboxToModelBbox(mask.back.bbox, function(pts){ return backPointsToModel(pts, CX, SCALE, YBOT, faW, backOffsetX, backOffsetY); });
      mxMin=bbm2[0];mxMax=bbm2[1];myMin=bbm2[2];myMax=bbm2[3];
      usedBackOnly=true;
    }else{
      console.log("  accessories: skip", name, "(front/back範囲なし)");
      return;
    }
    // ★2026-07-09(左右非対称キャラ対応): mask.leftSideがあればそちらを優先する
    // (左右で違う房のツインテールのように、片側だけに存在するアクセサリーは
    // 通常mask.sideを持たずmask.leftSideだけを持つ)。両方持つ場合(通常は
    // 起こらないが)もleftSideを優先する。
    var useLeftSide = !!(laW && mask.leftSide && mask.leftSide.bbox);
    var sideMask = useLeftSide ? mask.leftSide : mask.side;
    var curSAW = useLeftSide ? laW : saW;
    var curSAH = useLeftSide ? laH : saH;
    var curSYTOP = useLeftSide ? LEFT_SYTOP : SYTOP;
    var curSYBOT = useLeftSide ? LEFT_SYBOT : SYBOT;
    var curSIDE_REF = useLeftSide ? LEFT_SIDE_REF : SIDE_REF;
    var curSideOffsetX = useLeftSide ? leftSideOffsetX : sideOffsetX;
    var curSideOffsetY = useLeftSide ? leftSideOffsetY : sideOffsetY;
    if(sideMask && sideMask.bbox){
      var bbm3=P3D.pixelBboxToModelBbox(sideMask.bbox, function(pts){ return sidePointsToModel(pts, curSIDE_REF, SCALE, curSYTOP, curSYBOT); });
      mzMin=bbm3[0];mzMax=bbm3[1];
    }else{
      var hw=(mxMax-mxMin)/2; mzMin=-hw*0.6; mzMax=hw*0.6;
    }

    // ★2026-07-08バグ修正: パレット色によるピクセル単位の正確なマスク
    // (mask[view].alpha、pipeline.jsで事前にmaskDataUrlをラスタライズ済み)を
    // そのまま使う。従来はbbox内を「白背景でないか」で塗り直すlocalAlphaに
    // 頼っていたため、bbox内にある体側のピクセル(肌・髪・他の服等)まで拾って
    // 本体位置まで彫ってしまっていた。
    //
    // ★2026-07-09バグ修正(GHOST_SCANNER_PLAN.md 原因①): 片面(front/back/side)
    // にしかマスクが存在しないことが普通にある(例: 前髪は背面写真に映らない
    // のでmask.backが無い)。この場合に元画像を粗い閾値(localAlpha)で走査
    // すると、前髪と無関係な後ろ髪・地肌等まで「背面側のアルファ」として
    // 拾ってしまい、front/back合成(和集合)後に本物の前髪と無関係な塊が
    // 両方彫られて斜め視点で二重に見える不具合があった。localAlphaへは
    // フォールバックせず、front/backは情報なし(全ゼロ、和集合に寄与しない)、
    // sideは実画像を見ずに粗い深さ推定の矩形をそのまま塗りつぶす。
    var faAcc = (mask.front && mask.front.alpha) ? mask.front.alpha : new Uint8Array(faW*faH);
    var baAcc = (mask.back && mask.back.alpha) ? mask.back.alpha : new Uint8Array(faW*faH);
    var saAcc;
    if(sideMask && sideMask.alpha){
      saAcc = sideMask.alpha;
    }else{
      var sx0=curSIDE_REF+mzMin*SCALE+curSideOffsetX, sx1=curSIDE_REF+mzMax*SCALE+curSideOffsetX;
      var sy0=curSYTOP+(1.0-myMax)*(curSYBOT-curSYTOP)+curSideOffsetY, sy1=curSYTOP+(1.0-myMin)*(curSYBOT-curSYTOP)+curSideOffsetY;
      saAcc = rectAlpha(curSAW, curSAH, sx0, sy0, sx1, sy1);
    }

    var result = P3D.carveRegion({
      fa:faAcc, ba:baAcc, sa:saAcc, faW:faW, faH:faH, saW:curSAW, saH:curSAH,
      // ★2026-07-09バグ修正: opts.frontCont/backCont/sideContは元写真(front.png等)
      // そのものの明度(min(R,G,B))で、体本体の白背景しきい値(white_thr)による
      // 境界サブピクセル補正専用のデータ。マスク形式のアクセサリーはパレット色
      // 由来の正確な2値マスク(fa/ba/sa)を既に持っているため、この補正を適用すると
      // マスクで見つけた境界が元写真の明度が white_thr を横切る位置へズラされて
      // しまう。ツインテールのように白背景でない体・服の上に重なる行では、
      // その明度が白から大きく外れるため境界が不規則に暴れ、ねじれたリボン状の
      // 破綻したメッシュになっていた(ユーザー指摘により発覚)。マスク形式の
      // アクセサリーではこの補正自体が無意味なので常にnullにする。
      faCont: null, baCont: null, saCont: null,
      SCALE:SCALE, CX:CX, YBOT:YBOT, SYTOP:curSYTOP, SYBOT:curSYBOT, SIDE_REF:curSIDE_REF,
      backOffsetX:backOffsetX, backOffsetY:backOffsetY, sideOffsetX:curSideOffsetX, sideOffsetY:curSideOffsetY,
      mxBounds:[mxMin,mxMax], myBounds:[myMin,myMax], mzBounds:[mzMin,mzMax],
      vox: gp.acc_vox,
      // アクセサリーは頭/胴体/脚のような部位分けが無いため、部位別指数は
      // 全て同じ値を渡す(neckY/hipsYを渡さないのでcarveRegion側は常に
      // psqTorso=accPsqを使う)。アクセサリーごとに理想的な丸みが異なる
      // (硬いアクセサリー/柔らかい布等)ため、各アクセサリーが必ず個別の
      // acc.psqを持つ(★2026-07-12: 全アクセサリー共通の「まとめて設定」は
      // 廃止した、上のaccPsq代入部分参照)。
      psqHead: accPsq, psqTorso: accPsq, psqLegs: accPsq,
      psqArms: accPsq, psqHands: accPsq,
      // ★フェーズ1: bodyと同様、平滑化前の生メッシュをキャッシュするため
      // carveRegion自体には常にsmoothIters:0を渡し、平滑化はfinishAccessoryMesh
      // 側で別途適用する。
      smoothIters: 0,
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
    for(var i2=0;i2<nv;i2++){ allNF.push(usedBackOnly); allAccName.push(name); }
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

// ★フェーズ1: rawV/rawF(彫刻直後・平滑化/間引き前)にgen_paramsのsmooth_iters/
// decimate/decimate_strengthを適用する(visual_hull.jsのfinishBodyMeshの
// アクセサリー版)。ビューア側でrawParts配列の各要素にこれを呼び直すことで、再彫刻なしに
// 平滑化/間引きパラメータを反映できる(フェーズ2で使用)。
// ★2026-07-10以降、体+アクセサリー統合彫刻(js/pipeline.jsのrunCarvingStages)
// からは呼ばれなくなった後方互換用(stageAccessories内でのみ使用)。
// ★2026-07-11: gen_paramsのacc_smooth_iters/acc_decimate/acc_target_vertsが
// smooth_iters/decimate/target_vertsに統合されたのに合わせて参照名を更新。
// ★2026-07-12: target_vertsがdecimate_strengthに置き換わったのに合わせて
// 参照名を更新(js/carving.jsのdecimateMesh参照)。
function finishAccessoryMesh(rawV, rawF, gp){
  var V=rawV, F=rawF;
  if(gp.smooth_iters>0) V=P3D.laplacianSmoothPreserveExtent(V,F,gp.smooth_iters);
  if(gp.decimate){
    var dec=P3D.decimateMesh(V,F,gp.decimate_strength);
    V=dec.V; F=dec.F;
  }
  return {V:V, F:F};
}
P3D.finishAccessoryMesh = finishAccessoryMesh;

})(window);
