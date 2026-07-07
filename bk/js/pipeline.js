// -*- coding: utf-8 -*-
// 3DtoolJSの全ステージを束ねるオーケストレーター(pipeline.pyのrun()相当)。
// landmark_tool.htmlの生成ボタンから呼ばれる。ブラウザのメインスレッドで
// 重い処理をまとめて行うため、ステージ間でawait tick(0)を挟んでUIの
// (経過秒数表示の)再描画を可能にする。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

function tick(){ return new Promise(function(r){ setTimeout(r, 0); }); }

function cloneCanvasEl(src){
  var c=document.createElement('canvas'); c.width=src.width; c.height=src.height;
  c.getContext('2d').drawImage(src,0,0);
  return c;
}

function excludeMaskToBool(ecObj, w, h){
  // ecObj: {canvas, ctx} (landmark_tool.htmlのexcludeMask[view]) または null
  if(!ecObj) return null;
  var ctx = ecObj.canvas.getContext('2d');
  var id = ctx.getImageData(0,0,w,h);
  var out = new Uint8Array(w*h);
  for(var i=0;i<w*h;i++){ out[i] = (id.data[i*4+3] > 128) ? 1 : 0; }
  return out;
}
P3D.excludeMaskToBool = excludeMaskToBool;

// landmarks.py の AIツール由来ブロック(clavicle_*_m/wrist_*_mx/elbow_*_mx/
// knee_v/ankle_v/toe_v/elbow_frac/chest_v)のJS移植。
// points: landmark_tool.htmlの points オブジェクト({key:[px,py]})
// analysis: landmark_tool.htmlの analysis オブジェクト({ytop,ybot,cx,...})
// derivedBase: deriveFromPoints(points,analysis)の戻り値
function buildDerivedLandmarks(points, analysis, derivedBase){
  var d = Object.assign({}, derivedBase);
  var fcx=analysis.cx, fyt=analysis.ytop, fyb=analysis.ybot;
  var fsc = fyb-fyt;
  function MX(px){ return (px-fcx)/fsc; }
  function MY(py){ return (fyb-py)/fsc; }
  function V(py){ return (py-fyt)/fsc; }
  ['L','R'].forEach(function(s){
    var cl=points['clavicle_'+s];
    if(cl) d['clavicle_'+s+'_m']=[MX(cl[0]), MY(cl[1]), 0.0];
    var wr=points['wrist_'+s];
    if(wr) d['wrist_'+s+'_mx']=MX(wr[0]);
    var el=points['elbow_'+s];
    if(el) d['elbow_'+s+'_mx']=MX(el[0]);
  });
  function meanV(keys){
    var vals = keys.map(function(k){return points[k];}).filter(Boolean).map(function(p){return V(p[1]);});
    return vals.length ? vals.reduce(function(a,b){return a+b;},0)/vals.length : undefined;
  }
  var kv=meanV(['knee_L','knee_R']); if(kv!==undefined) d.knee_v=kv;
  var av=meanV(['ankle_L','ankle_R']); if(av!==undefined) d.ankle_v=av;
  var tv=meanV(['toe_L','toe_R']); if(tv!==undefined) d.toe_v=tv;
  // ★2026-07-04: 骨格ピボットをシルエットの自動トレースではなくユーザーが
  // 置いたランドマーク点そのものから決められるよう、モデル座標([mx,my])に
  // 変換して渡す。スカートで両脚が1本のrunに融合したり、髪が腕に重なったり
  // すると自動トレースは大きく壊れる(実測: スカートありでthigh_Lが体の中心、
  // thigh_R欠落、膝Lが0.13ズレ)ため、点があれば常に点を優先する(skeleton.js)。
  ['L','R'].forEach(function(s){
    var sh=points['shoulder_'+s], el=points['elbow_'+s], wr=points['wrist_'+s];
    if(sh&&el&&wr){
      d['arm_m_'+s]={sh:[MX(sh[0]),MY(sh[1])], el:[MX(el[0]),MY(el[1])], wr:[MX(wr[0]),MY(wr[1])]};
    }
    var kn=points['knee_'+s], an=points['ankle_'+s], to=points['toe_'+s];
    if(kn&&an&&to && points['hip']){
      var hp=points['hip'];
      d['leg_m_'+s]={hip:[MX(hp[0]),MY(hp[1])], knee:[MX(kn[0]),MY(kn[1])],
                     ankle:[MX(an[0]),MY(an[1])], toe:[MX(to[0]),MY(to[1])]};
    }
  });
  var elbowFracs=[];
  ['L','R'].forEach(function(s){
    var sh=points['shoulder_'+s], el=points['elbow_'+s], wr=points['wrist_'+s];
    if(sh&&el&&wr){
      var armLen=Math.abs(sh[0]-wr[0]);
      var shToEl=Math.abs(sh[0]-el[0]);
      if(armLen>0) elbowFracs.push(shToEl/armLen);
    }
  });
  if(elbowFracs.length) d.elbow_frac = elbowFracs.reduce(function(a,b){return a+b;},0)/elbowFracs.length;
  if(d.shoulder_v!==undefined && d.waist_v!==undefined && d.chest_v===undefined){
    d.chest_v = d.shoulder_v + 0.45*(d.waist_v-d.shoulder_v);
  }
  return d;
}
P3D.buildDerivedLandmarks = buildDerivedLandmarks;

/**
 * state: {
 *   imgs: {front:{el,w,h}, side:{...}, back:{...}}  (landmark_tool.htmlのimgs)
 *   points, analysis: landmark_tool.htmlの同名変数
 *   deriveFromPoints: function(points,analysis)->derivedBase (呼び出し元の関数をそのまま渡す)
 *   accessories: landmark_tool.htmlのaccessories配列
 *   excludeMask: landmark_tool.htmlのexcludeMask({front,side,back})
 *   seamAngles: landmark_tool.htmlのseamAngles
 *   seamNoSide: landmark_tool.htmlのseamNoSide(パーツ別「側面画像を使わない」フラグ)
 *   seamSmoothIters: landmark_tool.htmlのseamSmoothIters(境界線平滑化の強さ)
 *   colorGradWidth: landmark_tool.htmlのcolorGradWidth(色のディザグラデーション幅)
 *   genParams: landmark_tool.htmlのgenParams
 * }
 * onProgress(stageLabel): 各ステージ開始時に呼ばれる(UIの経過秒数表示用)
 * 戻り値: Promise<ArrayBuffer> (GLBファイル全体)
 */
/**
 * フェーズ1: 中間データ契約。runPipeline()の前半(prep〜accessories、重い
 * marching cubesまで)だけを実行し、GLBを作らずに以下を返す:
 *   - rawBody: {V,F} (visual_hullの彫刻直後・平滑化/間引き前メッシュ)
 *   - rawAccessories: [{name,mode,bones,V,F}, ...] (アクセサリー別、平滑化/間引き前)
 *   - bledCanvases: {front,back,side} (prep+bleed済みcanvas。atlas_bakeの入力用)
 *   - pivots: スキン計算/atlas継ぎ目判定に必要な骨格ピボット(モデル座標)
 *   - calib: {SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF} (atlas_bake/finishFromIntermediateで再利用)
 * ビューア(character_3d.html)側はこの中間データ+gen_paramsの一部を使って
 * finishFromIntermediate()を呼べば、再彫刻なしにモデルを再構築できる。
 * 戻り値: Promise<object>
 */
async function runToIntermediate(state, onProgress){
  function report(label){ console.log("=== stage:", label, "==="); if(onProgress) onProgress(label); }
  var gp = state.genParams;

  report("prep(背景除去)");
  var views=['front','side','back'];
  var rgbaFull={}, alphaFull={}, sizes={};
  views.forEach(function(v){
    var img = state.imgs[v].el;
    var w = state.imgs[v].w, h = state.imgs[v].h;
    var id = P3D.imageToImageData(img, w, h);
    rgbaFull[v] = id.data;
    sizes[v] = {w:w,h:h};
  });
  var excludeBool = {};
  views.forEach(function(v){ excludeBool[v] = excludeMaskToBool(state.excludeMask[v], sizes[v].w, sizes[v].h); });
  views.forEach(function(v){
    var img = state.imgs[v].el;
    var res = P3D.loadRgbaRemoveWhite(img, gp.white_thr, excludeBool[v]);
    alphaFull[v] = res.alpha;
  });
  await tick();

  report("bleed(縁の色にじみ)");
  var bledRgba={};
  views.forEach(function(v){
    bledRgba[v] = P3D.bleedEdges(rgbaFull[v], sizes[v].w, sizes[v].h, alphaFull[v], gp.alpha_dilate);
  });
  function toCanvas(rgba,w,h){
    var c=document.createElement('canvas'); c.width=w; c.height=h;
    var ctx=c.getContext('2d');
    var id=new ImageData(new Uint8ClampedArray(rgba.buffer.slice(0)), w, h);
    ctx.putImageData(id,0,0);
    return c;
  }
  var bledCanvas={};
  views.forEach(function(v){
    var rgba=bledRgba[v];
    var opaque=new Uint8ClampedArray(rgba.length);
    opaque.set(rgba);
    for(var a=3; a<opaque.length; a+=4) opaque[a]=255;
    bledCanvas[v]=toCanvas(opaque, sizes[v].w, sizes[v].h);
  });
  await tick();

  report("profile/core(キャリブレーション)");
  var prof = P3D.stageProfile(alphaFull.front, sizes.front.w, sizes.front.h, alphaFull.side, sizes.side.w, sizes.side.h);
  var core = P3D.stageCore(alphaFull.side, sizes.side.w, sizes.side.h, prof.YTOP, prof.YBOT);
  var SCALE = prof.YBOT-prof.YTOP;
  await tick();

  report("skeleton(骨格ピボット計算)");
  var derivedBase = state.deriveFromPoints(state.points, state.analysis);
  var LM = buildDerivedLandmarks(state.points, state.analysis, derivedBase);
  var pivRes = P3D.computePivots(alphaFull.front, sizes.front.w, sizes.front.h, prof.YTOP, prof.YBOT, prof.CX, LM);
  var pivots = Object.assign({}, pivRes.pivots, pivRes.extraPivots);
  await tick();

  var frontAlpha = alphaFull.front.slice();
  var backAlpha = alphaFull.back.slice();
  var sideAlpha = alphaFull.side.slice();
  if(excludeBool.front) for(var i=0;i<frontAlpha.length;i++){ if(excludeBool.front[i]) frontAlpha[i]=0; }
  if(excludeBool.back) for(var i2=0;i2<backAlpha.length;i2++){ if(excludeBool.back[i2]) backAlpha[i2]=0; }
  if(excludeBool.side) for(var i3=0;i3<sideAlpha.length;i3++){ if(excludeBool.side[i3]) sideAlpha[i3]=0; }

  function contArray(rgba){
    var n=rgba.length/4;
    var out=new Float32Array(n);
    for(var i=0;i<n;i++){ out[i]=Math.min(rgba[i*4],rgba[i*4+1],rgba[i*4+2]); }
    return out;
  }
  var frontCont = gp.subpixel ? contArray(rgbaFull.front) : null;
  var backCont = gp.subpixel ? contArray(rgbaFull.back) : null;
  var sideCont = gp.subpixel ? contArray(rgbaFull.side) : null;

  report("visual_hull(全身のvisual hull carving)");
  var body = P3D.stageVisualHull({
    frontAlpha:frontAlpha, backAlpha:backAlpha, sideAlpha:sideAlpha,
    faW:sizes.front.w, faH:sizes.front.h, saW:sizes.side.w, saH:sizes.side.h,
    frontCont:frontCont, backCont:backCont, sideCont:sideCont,
    SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
    pivots:pivots, gp:gp,
  });
  await tick();

  report("accessories(アクセサリーのcarving)");
  var acc = null;
  if(state.accessories && state.accessories.length){
    acc = P3D.stageAccessories({
      accs: state.accessories,
      frontRgba: rgbaFull.front, backRgba: rgbaFull.back, sideRgba: rgbaFull.side,
      W: sizes.front.w, H: sizes.front.h,
      SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
      frontCont:frontCont, backCont:backCont, sideCont:sideCont,
      pivots:pivots, gp:gp,
    });
  }
  await tick();

  return {
    rawBody: {V: body.rawV, F: body.rawF},
    rawAccessories: (acc && acc.rawParts) ? acc.rawParts.map(function(p){
      return {name:p.name, mode:p.mode, bones:p.bones, V:p.rawV, F:p.rawF};
    }) : [],
    bledCanvases: bledCanvas,
    pivots: pivots,
    calib: {SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF},
  };
}
P3D.runToIntermediate = runToIntermediate;

/**
 * フェーズ1/2: 中間データ(runToIntermediateの戻り値と同じ形。IndexedDBから
 * 読み込んだ場合はbledCanvasesがHTMLCanvasElementに復元済みであること)から
 * GLBを再構築する。彫刻(marching cubes)はやり直さず、rawBody/rawAccessories
 * に間引き(decimate)・平滑化(smooth_iters)・スキニング・atlas焼き込み・
 * GLB書き出しだけを適用する(フェーズ2のライブパラメータ編集の中核関数)。
 * opts: {gp, seamAngles, seamNoSide, seamSmoothIters, colorGradWidth}
 * 戻り値: Promise<ArrayBuffer>
 *
 * ★フェーズ2追加課題6の対応(段階的キャッシュ): どのパラメータ層(Tier1〜3)が
 * 実際に変わったかに応じて、変化のなかった段の再計算を省略する。
 * 段の依存関係と実際の処理順(このinter._stageCacheのみで完結する話であり、
 * P3D.finishBodyMesh/finishAccessoryMesh(runPipeline側で使う共有関数、
 * 平滑化→間引きの順)には手を入れていない。ここでは
 * キャッシュを効かせるため意図的に「間引き→平滑化」の順に組み替えている
 * (間引きはTier2のみに依存させ、Tier1(平滑化回数等)だけを変えた時に
 * 間引き結果を再利用できるようにするための設計変更。数式的な最終結果は
 * 従来の「平滑化→間引き」と厳密には同一にならない可能性があるが、
 * どちらも彫刻直後の生メッシュに対する後処理であり見た目上の破綻はない):
 *   1. decimate段: body_decimate/body_target_verts/acc_decimate/acc_target_verts
 *      (Tier2)にのみ依存。rawV/rawFに対して間引きのみ適用。
 *   2. mesh_finish段(平滑化+スキニング): 1の出力 + body_smooth_iters/
 *      acc_smooth_iters/rigid_soft_width(Tier1)に依存。
 *   3. atlas_bake段: 2の出力 + seamAngles/seamNoSide/seamSmoothIters/
 *      colorGradWidth(Tier3)に依存。
 *   4. model_glb段(テクスチャ圧縮+GLB書き出し): 3の出力 + kb_per_face(Tier1)。
 *      圧縮のみなので常に軽量、キャッシュ不要で毎回実行する。
 * 各段の入力シグネチャ(JSON文字列)をinter._stageCacheに保存し、前回と一致
 * すればその段はスキップして前回の結果を再利用する。あるTierが変わって
 * 上流の段が再計算されれば、その下流の段も強制的に再計算する。
 */
function decimateStage(inter, gp){
  var bodyV=inter.raw_body.V, bodyF=inter.raw_body.F;
  if(gp.body_decimate){
    var d=P3D.decimateMesh(bodyV,bodyF,gp.body_target_verts);
    bodyV=d.V; bodyF=d.F;
  }
  var accParts=[];
  (inter.raw_accessories||[]).forEach(function(p){
    var V=p.V, F=p.F;
    if(gp.acc_decimate){
      var d=P3D.decimateMesh(V,F,gp.acc_target_verts);
      V=d.V; F=d.F;
    }
    accParts.push({name:p.name, mode:p.mode, bones:p.bones, V:V, F:F});
  });
  return {bodyV:bodyV, bodyF:bodyF, accParts:accParts};
}

function meshFinishStage(decimated, gp, pivots){
  var V=decimated.bodyV, F=decimated.bodyF;
  if(gp.body_smooth_iters>0) V=P3D.laplacianSmooth(V,F,gp.body_smooth_iters);
  var fw=P3D.computeNormalsFixWinding(V,F);
  var bodyV=V, bodyF=fw.F, bodyN=fw.N;
  var bodySkin=P3D.nearestBoneSegmentSkin(bodyV, pivots, P3D.BONES, 4, gp.rigid_soft_width);

  var acc=null;
  if(decimated.accParts && decimated.accParts.length){
    var allV=[],allN=[],allF=[],allJ=[],allW=[],allAccName=[]; var voff=0;
    decimated.accParts.forEach(function(p){
      var V2=p.V, F2=p.F;
      if(gp.acc_smooth_iters>0) V2=P3D.laplacianSmooth(V2,F2,gp.acc_smooth_iters);
      var fw2=P3D.computeNormalsFixWinding(V2,F2);
      V2=V2; var F2b=fw2.F, Nv=fw2.N;
      var skin;
      if(p.mode==='rigid'){
        skin = P3D.rigidSkin(V2, (p.bones&&p.bones[0])||'head');
      }else{
        skin = P3D.nearestBoneSegmentSkin(V2, pivots, (p.bones&&p.bones.length)?p.bones:P3D.BONES, 4, gp.rigid_soft_width);
      }
      allV.push(V2); allN.push(Nv);
      for(var i=0;i<F2b.length;i++) allF.push(F2b[i]+voff);
      allJ.push(skin.J); allW.push(skin.W);
      var nv=V2.length/3;
      for(var i2=0;i2<nv;i2++) allAccName.push(p.name);
      voff+=nv;
    });
    var accV=P3D.concatTypedArrays(Float32Array,allV), accN=P3D.concatTypedArrays(Float32Array,allN);
    var accF=Uint32Array.from(allF);
    var accJ=P3D.concatTypedArrays(Uint16Array,allJ);
    var accW=P3D.concatTypedArrays(Float32Array,allW);
    var accNF=Uint8Array.from(allAccName.map(function(){return 0;}));
    acc = {V:accV, N:accN, F:accF, J:accJ, W:accW, NF:accNF, accName:allAccName};
  }
  return {bodyV:bodyV, bodyF:bodyF, bodyN:bodyN, bodySkin:bodySkin, acc:acc};
}

async function finishFromIntermediate(inter, opts, onProgress){
  function report(label){ console.log("=== stage:", label, "==="); if(onProgress) onProgress(label); }
  var gp = opts.gp;
  var cache = inter._stageCache || (inter._stageCache = {});
  function sig(o){ return JSON.stringify(o); }

  var decSig = sig({bd:gp.body_decimate, btv:gp.body_target_verts, ad:gp.acc_decimate, atv:gp.acc_target_verts});
  var decimated;
  if(cache.decSig===decSig && cache.decimated){
    decimated = cache.decimated;
  }else{
    report("decimate(間引き)");
    decimated = decimateStage(inter, gp);
    cache.decSig = decSig; cache.decimated = decimated;
    cache.meshSig = null; cache.bakeSig = null; // 下流を強制再計算
  }
  await tick();

  var meshSig = decSig+"|"+sig({bs:gp.body_smooth_iters, as:gp.acc_smooth_iters, rsw:gp.rigid_soft_width});
  var meshFinished;
  if(cache.meshSig===meshSig && cache.meshFinished){
    meshFinished = cache.meshFinished;
  }else{
    report("mesh_finish(平滑化/スキニング)");
    meshFinished = meshFinishStage(decimated, gp, inter.pivots);
    cache.meshSig = meshSig; cache.meshFinished = meshFinished;
    cache.bakeSig = null; // 下流を強制再計算
  }
  await tick();

  var origBled = inter.bled_canvases;
  var bakeSig = meshSig+"|"+sig({sa:opts.seamAngles, sns:opts.seamNoSide, ssi:opts.seamSmoothIters, cgw:opts.colorGradWidth});
  var bake, atlasCanvas;
  if(cache.bakeSig===bakeSig && cache.bake){
    bake = cache.bake; atlasCanvas = cache.atlasCanvas;
  }else{
    report("atlas_bake(テクスチャベイク)");
    // ★colorGradWidth>0のときstageAtlasBakeは渡したcanvasのピクセルを直接
    // 書き換える(atlas_bake段のコメント参照)。inter.bled_canvasesは
    // このfinishFromIntermediate()がライブパラメータ変更のたびに何度も
    // 呼ばれる間ずっと使い回される「元データ」なので、直接渡すと呼ぶたびに
    // 前回のブレンド結果の上にさらにブレンドが重なり、スライダーを動かす
    // たびにどんどん画像がぼやけていくバグになっていた。毎回複製してから
    // stageAtlasBakeに渡すことで、常に元のprep/bleed画像から計算し直す。
    var bledCanvas = {
      front: cloneCanvasEl(origBled.front),
      back: cloneCanvasEl(origBled.back),
      side: cloneCanvasEl(origBled.side),
    };
    var bodyV=meshFinished.bodyV, bodyF=meshFinished.bodyF, bodyN=meshFinished.bodyN, bodySkin=meshFinished.bodySkin, acc=meshFinished.acc;
    bake = P3D.stageAtlasBake({
      W: bledCanvas.front.width, H: bledCanvas.front.height, SCALE:inter.calib.SCALE, CX:inter.calib.CX, YBOT:inter.calib.YBOT,
      SYTOP:inter.calib.SYTOP, SYBOT:inter.calib.SYBOT, SIDE_REF:inter.calib.SIDE_REF,
      backOffsetX: gp.back_offset_x, backOffsetY: gp.back_offset_y,
      sideOffsetX: gp.side_offset_x, sideOffsetY: gp.side_offset_y,
      bodyV:bodyV, bodyN:bodyN, bodyF:bodyF, bodyJ:bodySkin.J, bodyW:bodySkin.W,
      accV: acc?acc.V:null, accN: acc?acc.N:null, accF: acc?acc.F:null,
      accJ: acc?acc.J:null, accW: acc?acc.W:null, accNF: acc?acc.NF:null,
      accName: acc?acc.accName:null,
      seamAngles: opts.seamAngles,
      seamNoSide: opts.seamNoSide,
      seamSmoothIters: opts.seamSmoothIters,
      colorGradWidth: opts.colorGradWidth,
      frontCanvas: bledCanvas.front, backCanvas: bledCanvas.back, sideCanvas: bledCanvas.side,
    });
    atlasCanvas = P3D.buildAtlasCanvas(bledCanvas.front, bledCanvas.back, bledCanvas.side);
    cache.bakeSig = bakeSig; cache.bake = bake; cache.atlasCanvas = atlasCanvas;
  }
  await tick();

  report("model_glb(GLB書き出し)");
  var tex = await P3D.compressAtlas(atlasCanvas, gp.kb_per_face);
  var glb = P3D.buildGLB({
    V: bake.restV, N: bake.norm, UV: bake.UV, J: bake.J, W: bake.W, F: bake.F,
    pivots: inter.pivots, atlasTexBuffer: tex.buffer, atlasMime: tex.mime,
  });
  console.log("DONE(finishFromIntermediate) -> glb bytes:", glb.byteLength);
  return glb;
}
P3D.finishFromIntermediate = finishFromIntermediate;

async function runPipeline(state, onProgress){
  function report(label){ console.log("=== stage:", label, "==="); if(onProgress) onProgress(label); }
  var gp = state.genParams;

  // ---------- prep: 背景除去 ----------
  report("prep(背景除去)");
  var views=['front','side','back'];
  var rgbaFull={}, alphaFull={}, sizes={};
  views.forEach(function(v){
    var img = state.imgs[v].el;
    var w = state.imgs[v].w, h = state.imgs[v].h;
    var id = P3D.imageToImageData(img, w, h);
    rgbaFull[v] = id.data;
    sizes[v] = {w:w,h:h};
  });
  var excludeBool = {};
  views.forEach(function(v){ excludeBool[v] = excludeMaskToBool(state.excludeMask[v], sizes[v].w, sizes[v].h); });
  views.forEach(function(v){
    var img = state.imgs[v].el;
    var res = P3D.loadRgbaRemoveWhite(img, gp.white_thr, excludeBool[v]);
    alphaFull[v] = res.alpha;
  });
  await tick();

  // ---------- bleed: 縁の色にじみ(アトラステクスチャ用) ----------
  report("bleed(縁の色にじみ)");
  var bledRgba={};
  views.forEach(function(v){
    bledRgba[v] = P3D.bleedEdges(rgbaFull[v], sizes[v].w, sizes[v].h, alphaFull[v], gp.alpha_dilate);
  });
  function toCanvas(rgba,w,h){
    var c=document.createElement('canvas'); c.width=w; c.height=h;
    var ctx=c.getContext('2d');
    var id=new ImageData(new Uint8ClampedArray(rgba.buffer.slice(0)), w, h);
    ctx.putImageData(id,0,0);
    return c;
  }
  // ★bleedEdgesはRGBを実画像内容の最近傍色でキャンバス全域まで拡張済みだが、
  // アルファはalpha_dilate分の膨張マスク外で0のまま返す。このアルファ0領域を
  // 透明としてアトラスに合成しJPEG化(アルファ非対応)すると、browserが黒で
  // 塗りつぶしてしまい、bleed margin をわずかに超えて張り出す細いアクセサリー
  // (髪・裾等)で黒い裂け目に見える。アトラス用キャンバスは既に画像ベースで
  // 拡張済みのRGBをそのまま使うべきなので、アルファは全域255に強制する。
  var bledCanvas={};
  views.forEach(function(v){
    var rgba=bledRgba[v];
    var opaque=new Uint8ClampedArray(rgba.length);
    opaque.set(rgba);
    for(var a=3; a<opaque.length; a+=4) opaque[a]=255;
    bledCanvas[v]=toCanvas(opaque, sizes[v].w, sizes[v].h);
  });
  await tick();

  // ---------- profile/core ----------
  report("profile/core(キャリブレーション)");
  var prof = P3D.stageProfile(alphaFull.front, sizes.front.w, sizes.front.h, alphaFull.side, sizes.side.w, sizes.side.h);
  var core = P3D.stageCore(alphaFull.side, sizes.side.w, sizes.side.h, prof.YTOP, prof.YBOT);
  var SCALE = prof.YBOT-prof.YTOP;
  console.log("  profile: CX",prof.CX,"YTOP",prof.YTOP,"YBOT",prof.YBOT,"SIDE_REF",core.SIDE_REF);
  await tick();

  // ---------- landmarks/skeleton ----------
  report("skeleton(骨格ピボット計算)");
  var derivedBase = state.deriveFromPoints(state.points, state.analysis);
  var LM = buildDerivedLandmarks(state.points, state.analysis, derivedBase);
  var pivRes = P3D.computePivots(alphaFull.front, sizes.front.w, sizes.front.h, prof.YTOP, prof.YBOT, prof.CX, LM);
  var pivots = Object.assign({}, pivRes.pivots, pivRes.extraPivots);
  console.log("  skeleton: pivots for", Object.keys(pivRes.pivots).length, "bones +", Object.keys(pivRes.extraPivots).length, "extra");
  await tick();

  // ---------- exclude mask AND-out(visual_hull用、front/back/side個別) ----------
  var frontAlpha = alphaFull.front.slice();
  var backAlpha = alphaFull.back.slice();
  var sideAlpha = alphaFull.side.slice();
  if(excludeBool.front) for(var i=0;i<frontAlpha.length;i++){ if(excludeBool.front[i]) frontAlpha[i]=0; }
  if(excludeBool.back) for(var i2=0;i2<backAlpha.length;i2++){ if(excludeBool.back[i2]) backAlpha[i2]=0; }
  if(excludeBool.side) for(var i3=0;i3<sideAlpha.length;i3++){ if(excludeBool.side[i3]) sideAlpha[i3]=0; }

  function contArray(rgba){
    var n=rgba.length/4;
    var out=new Float32Array(n);
    for(var i=0;i<n;i++){ out[i]=Math.min(rgba[i*4],rgba[i*4+1],rgba[i*4+2]); }
    return out;
  }
  var frontCont = gp.subpixel ? contArray(rgbaFull.front) : null;
  var backCont = gp.subpixel ? contArray(rgbaFull.back) : null;
  var sideCont = gp.subpixel ? contArray(rgbaFull.side) : null;

  // ---------- visual_hull(全身) ----------
  report("visual_hull(全身のvisual hull carving)");
  var body = P3D.stageVisualHull({
    frontAlpha:frontAlpha, backAlpha:backAlpha, sideAlpha:sideAlpha,
    faW:sizes.front.w, faH:sizes.front.h, saW:sizes.side.w, saH:sizes.side.h,
    frontCont:frontCont, backCont:backCont, sideCont:sideCont,
    SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
    pivots:pivots, gp:gp,
  });
  await tick();

  // ---------- accessories ----------
  report("accessories(アクセサリーのcarving)");
  var acc = null;
  if(state.accessories && state.accessories.length){
    acc = P3D.stageAccessories({
      accs: state.accessories,
      frontRgba: rgbaFull.front, backRgba: rgbaFull.back, sideRgba: rgbaFull.side,
      W: sizes.front.w, H: sizes.front.h,
      SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
      frontCont:frontCont, backCont:backCont, sideCont:sideCont,
      pivots:pivots, gp:gp,
    });
  }else{
    console.log("  accessories: 定義なし、スキップ");
  }
  await tick();

  // ---------- atlas_bake ----------
  // ★colorGradWidth>0のときstageAtlasBakeがbledCanvas.front/back/sideのピクセルを
  // 直接書き換えて継ぎ目をブレンドするため、その結果を拾えるようbuildAtlasCanvas
  // より先にstageAtlasBakeを呼ぶ(以前はbuildAtlasCanvasが先だった)。
  report("atlas_bake(テクスチャベイク)");
  var bake = P3D.stageAtlasBake({
    W:sizes.front.w, H:sizes.front.h, SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT,
    SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
    backOffsetX: gp.back_offset_x, backOffsetY: gp.back_offset_y,
    sideOffsetX: gp.side_offset_x, sideOffsetY: gp.side_offset_y,
    bodyV:body.V, bodyN:body.N, bodyF:body.F, bodyJ:body.J, bodyW:body.W,
    accV: acc?acc.V:null, accN: acc?acc.N:null, accF: acc?acc.F:null,
    accJ: acc?acc.J:null, accW: acc?acc.W:null, accNF: acc?acc.NF:null,
    accName: acc?acc.accName:null,
    seamAngles: state.seamAngles,
    seamNoSide: state.seamNoSide,
    seamSmoothIters: state.seamSmoothIters,
    colorGradWidth: state.colorGradWidth,
    frontCanvas: bledCanvas.front, backCanvas: bledCanvas.back, sideCanvas: bledCanvas.side,
  });
  var atlasCanvas = P3D.buildAtlasCanvas(bledCanvas.front, bledCanvas.back, bledCanvas.side);
  await tick();

  // ---------- model_glb ----------
  report("model_glb(GLB書き出し)");
  var tex = await P3D.compressAtlas(atlasCanvas, gp.kb_per_face);
  var glb = P3D.buildGLB({
    V: bake.restV, N: bake.norm, UV: bake.UV, J: bake.J, W: bake.W, F: bake.F,
    pivots: pivots, atlasTexBuffer: tex.buffer, atlasMime: tex.mime,
  });
  console.log("DONE -> glb bytes:", glb.byteLength);
  return glb;
}
P3D.runPipeline = runPipeline;

})(window);
