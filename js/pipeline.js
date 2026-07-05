// -*- coding: utf-8 -*-
// 3DtoolJSの全ステージを束ねるオーケストレーター(pipeline.pyのrun()相当)。
// landmark_tool.htmlの生成ボタンから呼ばれる。ブラウザのメインスレッドで
// 重い処理をまとめて行うため、ステージ間でawait tick(0)を挟んでUIの
// (経過秒数表示の)再描画を可能にする。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

function tick(){ return new Promise(function(r){ setTimeout(r, 0); }); }

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
  // ★2026-07-05: 背面画像は前面画像と別に撮影/作画されるため、シルエットの水平
  // 中心(CX)だけでなく縦横の拡大率(SCALE=身長のpx数)も前面と厳密に一致すると
  // は限らない(実測で共に数%規模のズレが起きうる)。CXだけ補正してSCALEは
  // 前面のものを流用すると、体の中心に近い部分(誤差は小さい)ではズレが
  // 目立たないが、腕や裾など中心から離れた部分ほど誤差が拡大して見える
  // (誤差 ≈ 中心からの距離 × SCALEの食い違い)。背面シルエット自身から
  // CX/YTOP/YBOT(=SCALE)を独立に求め、背面の投影/彫り出しにはこちらを使う。
  var backProfOnly = P3D.frontProfileOnly(alphaFull.back, sizes.back.w, sizes.back.h);
  var CX_BACK = backProfOnly.CX;
  var YBOT_BACK = backProfOnly.YBOT;
  var SCALE_BACK = backProfOnly.YBOT - backProfOnly.YTOP;
  console.log("  profile: CX",prof.CX,"YTOP",prof.YTOP,"YBOT",prof.YBOT,"SIDE_REF",core.SIDE_REF,
    "/ CX_BACK",CX_BACK,"YBOT_BACK",YBOT_BACK,"SCALE_BACK",SCALE_BACK,
    "(front SCALE",SCALE,")");
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
    SCALE:SCALE, CX:prof.CX, CXBack:CX_BACK, SCALEBack:SCALE_BACK, YBOT:prof.YBOT, YBOTBack:YBOT_BACK,
    SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
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
      SCALE:SCALE, CX:prof.CX, CXBack:CX_BACK, SCALEBack:SCALE_BACK, YBOT:prof.YBOT, YBOTBack:YBOT_BACK,
      SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
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
    W:sizes.front.w, H:sizes.front.h, SCALE:SCALE, CX:prof.CX, CXBack:CX_BACK, SCALEBack:SCALE_BACK,
    YBOT:prof.YBOT, YBOTBack:YBOT_BACK,
    SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
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
