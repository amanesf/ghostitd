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
  // ★2026-07-11追加(顔の立体感対応): eye_L/eye_Rランドマーク(px)をmodel座標
  // へ変換し、js/carving.jsのapplyEyeSocketRecessが目窩の凹みを彫る中心点
  // として使う。
  ['L','R'].forEach(function(s){
    var ep=points['eye_'+s];
    if(ep) d['face_eye_'+s]=[MX(ep[0]), MY(ep[1]), 0.0];
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
 * ★奥行き(Z軸)計算に使う側面画像について: 全身の奥行き(stageVisualHull)は
 * 常にside(右向き側面)だけを使う。leftSide(左向き側面)は使わない
 * (下記のleftSide変数はmask.leftSideを持つ非対称アクセサリーの彫刻専用で、
 * side用のSIDE_REF起点の変換式(px-SIDE_REF)/SCALEをそのまま再利用できる
 * よう、読み込み時に水平反転してから独自にキャリブレーションする)。
 * side/leftSideのどちらを使うか、どちらを反転するかを変更する場合は、
 * このコメントとrunCarvingStages内のleftSide計算部分の両方を必ず更新する
 * こと(2026-07-09、ユーザー指摘によりこの前提を明文化)。
 *
 * state: {
 *   imgs: {front:{el,w,h}, side:{...}, back:{...}}  (landmark_tool.htmlのimgs)
 *   colormaps: {front:{canvas,ctx,w,h}, side:{...}, leftSide:{...}, back:{...}}
 *     (landmark_tool.htmlのcolormaps。体・アクセサリーとも色分けマップ由来の
 *     最近傍色分類方式でシルエットを抽出するため必須)
 *   points, analysis: landmark_tool.htmlの同名変数
 *   deriveFromPoints: function(points,analysis)->derivedBase (呼び出し元の関数をそのまま渡す)
 *   accessories: landmark_tool.htmlのaccessories配列
 *   seamAngles: landmark_tool.htmlのseamAngles
 *   seamNoSide: landmark_tool.htmlのseamNoSide(パーツ別「側面画像を使わない」フラグ)
 *   seamSmoothIters: landmark_tool.htmlのseamSmoothIters(境界線平滑化の強さ)
 *   colorGradWidth: landmark_tool.htmlのcolorGradWidth(色のディザグラデーション幅、
 *     無次元スケール、js/atlas.js参照)
 *   colorGradStrength: landmark_tool.htmlのcolorGradStrength(境目ちょうどでの
 *     最大ブレンド比率、0〜1)
 *   genParams: landmark_tool.htmlのgenParams
 * }
 * onProgress(stageLabel): 各ステージ開始時に呼ばれる(UIの経過秒数表示用)
 *
 * prep(背景除去)〜accessories(アクセサリーcarving)までを実行する(重い
 * marching cubesまでを含む)。GLBは作らず、以下を返す:
 *   - sizes,prof,core,SCALE,pivots: キャリブレーション/骨格ピボット
 *   - bledCanvas: {front,back,side} (prep+bleed済みcanvas。atlas_bakeの入力用)
 *   - body: P3D.stageVisualHull()の戻り値(V,N,F,J,W,rawV,rawF)
 *   - acc: P3D.stageAccessories()の戻り値、またはnull(アクセサリー未定義時)
 * 戻り値: Promise<object>
 */
async function runCarvingStages(state, report){
  var gp = state.genParams;

  report("prep(体シルエット抽出)");
  var views=['front','side','back'];
  var rgbaFull={}, alphaFull={}, sizes={};
  views.forEach(function(v){
    var img = state.imgs[v].el;
    var w = state.imgs[v].w, h = state.imgs[v].h;
    var id = P3D.imageToImageData(img, w, h);
    rgbaFull[v] = id.data;
    sizes[v] = {w:w,h:h};
  });
  // ★2026-07-09/10: 全身のシルエットも色分けマップから抽出するようにした
  // (以前は素の写真に白背景しきい値(white_thr)を掛けていた)。
  // ★2026-07-11(切り抜き精度向上、ユーザー指摘「色分けマップも本来輪郭は
  // キレイなはず」対応): 体・各アクセサリーをそれぞれ独立に「その色との距離が
  // tolerance以内か」で判定する旧方式(P3D.loadAlphaFromColormap+
  // gp.body_color_tolerance)は、境界の陰影(グラデーション)幅がtoleranceを
  // 超えると「どちらの判定にも入らない未確定画素」を生み、以前は
  // P3D.fillColorGapsで事後に橋渡し修復していた。ここを体+全アクセサリー色を
  // 候補とした最近傍色分類(P3D.classifySilhouetteRaw、js/common.js参照)に
  // 置き換えることで、各画素が必ずいずれか1つの候補に確定的に割り当たり、
  // 未確定画素の帯そのものが原理的に発生しなくなる(tolerance/
  // fillColorGaps不要)。アクセサリー側のマスク(a.mask[v].alpha)は
  // landmark_tool.htmlの自動マスクタブで既に同じ分類方式により体と矛盾しない
  // 境界で抽出済み(バイナリのmaskDataUrlとしてJSONに埋め込み済み)のため、
  // ここでは体のシルエットだけをこの分類から取り出せばよく、以前のような
  // 生成時点でのアクセサリー側bbox再計算(隙間の橋渡し)は不要になった。
  // マフラーが首を・スカートが腰を覆う行では体シルエットが分断され、visual
  // hullが頭部/脚を胴体から独立した閉曲面として彫ることがあるが、これは
  // 許容する(js/visual_hull.jsのminFragFrac、js/carving.jsの
  // dropSmallFragments/computeNormalsFixWinding参照)。
  var accsWithColor = (state.accessories||[]).filter(function(a){ return a.color; });
  var accessoryColors = accsWithColor.map(function(a){ return a.color; });
  // ★2026-07-11追加(切り抜き精度向上、point2): 最近傍色分類の境界は必ず
  // どこかの画素で起きるが、その画素そのものはアンチエイリアスで前後2色が
  // 混ざった中間色なので、行スキャン(front/back/side幅・奥行き測定)が
  // その画素をそのまま整数pxの境界として使うと1px単位の量子化誤差が乗る。
  // gp.subpixel_edgesが有効なら、境界のサブピクセル位置(P3D.classifySilhouetteCont、
  // js/common.js参照)も体・全アクセサリーのシルエットと同時に算出し、
  // carveRegionの行スキャンに渡す(体はjs/visual_hull.jsのbuildBodyCarveOpts、
  // アクセサリーはjs/accessories.jsのbuildAccessoryCarveOptsList経由。
  // アクセサリー側はmask[v].alphaと同じ場所にmask[v].contとして載せる)。
  var contFull={};
  views.forEach(function(v){
    var cm = state.colormaps && state.colormaps[v];
    if(!cm) throw new Error("色分けマップ("+v+")が見つかりません。front/side/backの3面とも色分けマップが必要です(ゴーストスキャナーで生成/アップロードしてから引き継いでください)。");
    var raw = P3D.classifySilhouetteRaw(cm.ctx, cm.w, cm.h, "#000000", accessoryColors);
    var alpha = P3D.significantComponentsMask(raw.bodyRaw, cm.w, cm.h);
    alphaFull[v] = P3D.fillHoles(alpha, cm.w, cm.h);
    if(gp.subpixel_edges){
      var contRes = P3D.classifySilhouetteCont(cm.ctx, cm.w, cm.h, "#000000", accessoryColors);
      contFull[v] = contRes.bodyCont;
      accsWithColor.forEach(function(a, idx){
        if(a.mask && a.mask[v]) a.mask[v].cont = contRes.accCont[idx];
      });
    }
  });
  await tick();

  // ★2026-07-10バグ修正: bleedEdges(縁の色にじみ)は「体(alphaFull、色分け
  // マップの黒だけ)」を前景とみなし、それ以外(スカート/マフラー/髪等の
  // アクセサリー領域は体とは別の色で塗られているため体シルエットから見れば
  // 「背景」)を周囲の最近傍色で問答無用に上書きしてしまっていた。
  // その結果、アクセサリー自体の3D形状の切り抜きはアクセサリー専用マスクで
  // 正しく行われるのに、テクスチャの元になるこの共有キャンバス上では
  // アクセサリーの実際の絵柄が上着の裾や太もも等・隣接する体領域の色で
  // 塗り潰されて消え、アトラスに焼き込んだ際に縞状の破綻に見えていた
  // (ユーザー指摘により発覚)。bleedの前景判定だけは「体∪全アクセサリー」の
  // 和集合にし、アクセサリー領域の実ピクセルも保護対象に含める(3D彫刻用の
  // alphaFull自体は体オンリーのまま変更しない=体がアクセサリー形状に
  // 膨らむ不具合を再発させない)。
  // ★2026-07-11バグ修正(退行): 最近傍色分類への置き換え時、この和集合計算に
  // 必要なa.mask[v].alpha(マスクPNGから読み込んだ実際のUint8Array)を早期に
  // ロードしていたearlyMaskLoadsブロック(旧・境界ギャップ埋め専用と誤認して
  // 削除)が、実はこのbleedFgAlpha計算の前提でもあったため、削除後は
  // 常にm.alphaが未ロード(undefined)のままここを素通りし、上のバグが
  // 再発していた(スカート等が体色のにじみで塗り潰される)。ここで改めて
  // 必要な分だけ早期ロードする。
  if(state.accessories && state.accessories.length){
    var bleedMaskLoads=[];
    state.accessories.forEach(function(a){
      if(!a.mask) return;
      ["front","back","side"].forEach(function(v){
        var m=a.mask[v];
        if(!m || !m.maskDataUrl || m.alpha) return;
        var sz = (v==='side') ? sizes.side : sizes.front;
        bleedMaskLoads.push(P3D.loadMaskAlphaAsync(m.maskDataUrl, sz.w, sz.h).then(function(alpha){ m.alpha=alpha; }));
      });
    });
    if(bleedMaskLoads.length) await Promise.all(bleedMaskLoads);
  }
  var bleedFgAlpha={};
  views.forEach(function(v){ bleedFgAlpha[v]=Uint8Array.from(alphaFull[v]); });
  if(state.accessories && state.accessories.length){
    state.accessories.forEach(function(a){
      if(!a.mask) return;
      ["front","back","side"].forEach(function(v){
        var m=a.mask[v];
        if(!m || !m.alpha) return;
        var fg=bleedFgAlpha[v];
        for(var i=0;i<fg.length;i++){ if(m.alpha[i]) fg[i]=1; }
      });
    });
  }
  await tick();

  report("bleed(縁の色にじみ)");
  var bledRgba={};
  views.forEach(function(v){
    bledRgba[v] = P3D.bleedEdges(rgbaFull[v], sizes[v].w, sizes[v].h, bleedFgAlpha[v], gp.alpha_dilate, gp.bleed_inset_px);
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

  report("profile/core(キャリブレーション)");
  var prof = P3D.stageProfile(alphaFull.front, sizes.front.w, sizes.front.h, alphaFull.side, sizes.side.w, sizes.side.h);
  var core = P3D.stageCore(alphaFull.side, sizes.side.w, sizes.side.h, prof.SYTOP, prof.SYBOT);
  var SCALE = prof.YBOT-prof.YTOP;
  console.log("  profile: CX",prof.CX,"YTOP",prof.YTOP,"YBOT",prof.YBOT,"SIDE_REF",core.SIDE_REF,"SYTOP",prof.SYTOP,"SYBOT",prof.SYBOT);

  // ★奥行き(Z)計算に使う側面画像はside(右)固定、leftSide(左)は使わない★
  // 2026-07-09(左右非対称キャラ対応): leftSide(左向き側面。色分けマップ)が
  // ある場合、sideと同じキャリブレーション手順を、水平反転したアルファに
  // 対して行う(P3D.flipAlphaHorizontal参照。反転することでside用の各種
  // 変換式(SIDE_REF起点)をそのまま再利用できるようにするため)。体本体
  // (stageVisualHull)はside(右)のみを使い、leftSideは片方だけにある
  // 非対称アクセサリー(例: 左だけのツインテール)の彫刻にのみ使う。
  var leftSide = null;
  if(state.imgs.leftSide && state.colormaps.leftSide){
    var lImg = state.imgs.leftSide.el, lW = state.imgs.leftSide.w, lH = state.imgs.leftSide.h;
    var lCm = state.colormaps.leftSide;
    var lRaw = P3D.classifySilhouetteRaw(lCm.ctx, lCm.w, lCm.h, "#000000", accessoryColors);
    var lAlpha = P3D.fillHoles(P3D.significantComponentsMask(lRaw.bodyRaw, lCm.w, lCm.h), lCm.w, lCm.h);
    var lAlphaFlipped = P3D.flipAlphaHorizontal(lAlpha, lW, lH);
    var lBounds = P3D.boolBounds(lAlphaFlipped, lW, lH);
    var lCore = P3D.stageCore(lAlphaFlipped, lW, lH, lBounds[0], lBounds[1]);
    leftSide = { w:lW, h:lH, SYTOP:lBounds[0], SYBOT:lBounds[1], SIDE_REF:lCore.SIDE_REF };
    console.log("  profile(leftSide): SYTOP",lBounds[0],"SYBOT",lBounds[1],"SIDE_REF",lCore.SIDE_REF);
    // ★2026-07-11: leftSideを使う非対称アクセサリーにもサブピクセル境界指標を
    // 用意する(反転座標系のためalphaと同じくP3D.flipArrayHorizontalで反転する)。
    if(gp.subpixel_edges){
      var lContRes = P3D.classifySilhouetteCont(lCm.ctx, lCm.w, lCm.h, "#000000", accessoryColors);
      accsWithColor.forEach(function(a, idx){
        if(a.mask && a.mask.leftSide) a.mask.leftSide.cont = P3D.flipArrayHorizontal(lContRes.accCont[idx], lW, lH);
      });
    }
  }
  await tick();

  report("skeleton(骨格ピボット計算)");
  var derivedBase = state.deriveFromPoints(state.points, state.analysis);
  var LM = buildDerivedLandmarks(state.points, state.analysis, derivedBase);
  var pivRes = P3D.computePivots(alphaFull.front, sizes.front.w, sizes.front.h, prof.YTOP, prof.YBOT, prof.CX, LM);
  var pivots = Object.assign({}, pivRes.pivots, pivRes.extraPivots);
  console.log("  skeleton: pivots for", Object.keys(pivRes.pivots).length, "bones +", Object.keys(pivRes.extraPivots).length, "extra");
  await tick();

  var frontAlpha = alphaFull.front;
  var backAlpha = alphaFull.back;
  var sideAlpha = alphaFull.side;

  // ★2026-07-09: 色分けマップ由来のalphaFullは既に色距離判定によるくっきりした
  // 2値マスクであり、白背景しきい値による写真の明度(frontCont等)を使った
  // サブピクセル境界補正は意味を持たない(js/accessories.jsで色分けマップ由来の
  // マスク形式アクセサリーに同じ補正を適用すると境界が不規則に暴れ、破綻した
  // メッシュになる不具合が見つかり、faCont等を常にnullにした時と同じ理由)。
  // 体本体も同様にfrontCont/backCont/sideContは常にnullにする。
  //
  // ★2026-07-10(ユーザー指摘「パーツ間の隙間」「前髪がぐちゃぐちゃ」対応):
  // 体とアクセサリーを別々のグリッドで独立に彫刻し、独立にmarching cubesする
  // 従来方式は、体色以外の画素を最初から体シルエットに含めない設計と相まって、
  // 「境界がたまたま同じ輪郭線から彫られていれば大体合う」程度の保証しか
  // 無かった(隙間の主因)。ここから体+全アクセサリーのcarveRegion optsを
  // (実際に彫らずに)組み立てて外接範囲を求め、1つの共有グリッドへ
  // P3D.carveUnifiedRegions()でmax-combine蓄積し、1回だけmarching cubesする。
  // 生成される全頂点はどのパーツが実際に表面を作ったか(owner)を彫刻に
  // 使った座標系そのものから厳密に持つ(js/marching_cubes.js参照。色サンプリング
  // 等の曖昧な事後推定は一切使わない)ため、体とアクセサリーの境界は
  // 構造的に閉じたまま(隙間が原理的に発生しない)彫り上がる。
  report("visual_hull+accessories(統合carving)");
  var bodyBuilt = P3D.buildBodyCarveOpts({
    frontAlpha:frontAlpha, backAlpha:backAlpha, sideAlpha:sideAlpha,
    faW:sizes.front.w, faH:sizes.front.h, saW:sizes.side.w, saH:sizes.side.h,
    frontCont:contFull.front||null, backCont:contFull.back||null, sideCont:contFull.side||null,
    SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
    pivots:pivots, gp:gp, faceEyeL:LM.face_eye_L, faceEyeR:LM.face_eye_R,
  });

  var accBuilt = [];
  if(state.accessories && state.accessories.length){
    // ★2026-07-08バグ修正: 色分けマップ由来(mask形式)のアクセサリーは、以前は
    // bboxだけ取り出してその中を「白背景でないか」で塗り直しており、bbox内に
    // ある体側のピクセル(肌・髪・他の服等)まで拾って本体位置まで彫ってしまう
    // 不具合があった。ここでmask[view].maskDataUrl(パレット色によるピクセル
    // 単位の正確なマスク)をfront/back/side画像と同じ座標系のUint8Arrayに
    // 変換して各accessoryオブジェクトのmask[view].alphaに載せ、accessories.js
    // 側でlocalAlphaの代わりにこれを直接使えるようにする(パーツごとに自分の
    // front/side/backマスクだけで彫る)。
    var maskLoads=[];
    state.accessories.forEach(function(a){
      if(!a.mask) return;
      ["front","back"].forEach(function(v){
        var m=a.mask[v];
        if(m && m.maskDataUrl && !m.alpha){
          maskLoads.push(P3D.loadMaskAlphaAsync(m.maskDataUrl, sizes.front.w, sizes.front.h).then(function(alpha){ m.alpha=alpha; }));
        }
      });
      var ms=a.mask.side;
      if(ms && ms.maskDataUrl && !ms.alpha){
        maskLoads.push(P3D.loadMaskAlphaAsync(ms.maskDataUrl, sizes.side.w, sizes.side.h).then(function(alpha){ ms.alpha=alpha; }));
      }
      // ★2026-07-09(左右非対称キャラ対応): mask.leftSideも、leftSide本体の
      // キャリブレーション(上記leftSide変数)と同じ水平反転を適用してから
      // alpha/bboxを格納する(反転後の座標系はside用の変換式とそのまま
      // 揃うため、accessories.js側はside/leftSideを区別なく同じ式で扱える)。
      // ★2026-07-11: 体・アクセサリー双方が最近傍色分類(P3D.classifySilhouetteRaw)
      // で抽出されるようになったため、front/back/side/leftSideいずれの境界も
      // 構造的に隙間が発生しなくなった(旧・境界ギャップ埋め(fillColorGaps)は
      // 不要になり削除済み)。
      var mls=a.mask.leftSide;
      if(leftSide && mls && mls.maskDataUrl && !mls.alpha){
        maskLoads.push(P3D.loadMaskAlphaAsync(mls.maskDataUrl, leftSide.w, leftSide.h).then(function(alpha){
          mls.alpha=P3D.flipAlphaHorizontal(alpha, leftSide.w, leftSide.h);
          if(mls.bbox) mls.bbox=P3D.flipBboxHorizontal(mls.bbox, leftSide.w);
        }));
      }
    });
    if(maskLoads.length) await Promise.all(maskLoads);
    accBuilt = P3D.buildAccessoryCarveOptsList({
      accs: state.accessories,
      frontRgba: rgbaFull.front, backRgba: rgbaFull.back, sideRgba: rgbaFull.side,
      // ★2026-07-08バグ修正(GHOST_SCANNER_PLAN.md「運用面の修正6点・③」):
      // carveRegion/carving.jsはfront/backが同サイズ前提・sideは別サイズという
      // 設計(buildBodyCarveOptsのfaW/faH+saW/saHと同じ)。以前はW,H(front基準)
      // 1組をside側にも使い回しており、front/side画像のピクセル寸法が
      // 食い違うスキャナー経由の素材でside側のアクセサリー切り出し位置・
      // スケールがズレていた。faW/faH(front+back用)とsaW/saH(side用)を
      // 分けて渡す。
      faW:sizes.front.w, faH:sizes.front.h, saW:sizes.side.w, saH:sizes.side.h,
      SCALE:SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF,
      // ★2026-07-09(左右非対称キャラ対応): mask.leftSideを持つアクセサリーの
      // 彫刻に使う、leftSide側のキャリブレーション一式(無ければnull=非対応)。
      laW: leftSide?leftSide.w:0, laH: leftSide?leftSide.h:0,
      LEFT_SYTOP: leftSide?leftSide.SYTOP:0, LEFT_SYBOT: leftSide?leftSide.SYBOT:0,
      LEFT_SIDE_REF: leftSide?leftSide.SIDE_REF:0,
      pivots:pivots, gp:gp,
    });
  }else{
    console.log("  accessories: 定義なし、スキップ");
  }

  var allMxBounds=[bodyBuilt.mxBounds].concat(accBuilt.map(function(a){return a.mxBounds;}));
  var allMyBounds=[bodyBuilt.myBounds].concat(accBuilt.map(function(a){return a.myBounds;}));
  var allMzBounds=[bodyBuilt.mzBounds].concat(accBuilt.map(function(a){return a.mzBounds;}));
  var unionBounds=[
    [Math.min.apply(null, allMxBounds.map(function(b){return b[0];})), Math.max.apply(null, allMxBounds.map(function(b){return b[1];}))],
    [Math.min.apply(null, allMyBounds.map(function(b){return b[0];})), Math.max.apply(null, allMyBounds.map(function(b){return b[1];}))],
    [Math.min.apply(null, allMzBounds.map(function(b){return b[0];})), Math.max.apply(null, allMzBounds.map(function(b){return b[1];}))],
  ];
  var sharedGrid = P3D.buildGrid(unionBounds[0], unionBounds[1], unionBounds[2], gp.body_vox);
  var regions = [{ownerId:0, opts:bodyBuilt.carveOpts}].concat(
    accBuilt.map(function(a,i){ return {ownerId:i+1, opts:a.carveOpts}; }));
  // ★2026-07-12追加(パーツ境界のなじませ、owner_blend機能): 3方向投影
  // だけでは埋まらない斜め視点でのパーツ間の隙間をなじませる強さ
  // (js/carving.jsのcarveUnifiedRegions/carveSdfField参照)。
  var ownerBlendStrength = gp.owner_blend ? (gp.owner_blend_strength||0) : 0;
  var unified = P3D.carveUnifiedRegions(regions, sharedGrid, 0.001, ownerBlendStrength);
  if(!unified) throw new Error("visual_hull+accessories: carving produced an empty mesh");
  console.log("  carveUnifiedRegions: total verts", unified.V.length/3, "faces", unified.F.length/3);

  // ★2026-07-11(ユーザー指摘「パーツ分割のタイミングが早すぎる」対応):
  // 以前はここで即座にsplitMeshByOwnerしていたが、その後の間引き・平滑化を
  // パーツごとに独立して行うと、彫刻直後はぴったり合っていた境界の頂点が
  // 両側で別々に動いて隙間・段差になっていた。統合されたままの1枚のメッシュ
  // (owner付き)を返し、分割は間引き・平滑化が全て終わった後(pipeline.jsの
  // decimateStage/meshFinishStage参照)にだけ行う。
  var partsMeta = [{ownerId:0, name:"body", mode:null, bones:null}].concat(
    accBuilt.map(function(a,i){ return {ownerId:i+1, name:a.name, mode:a.mode, bones:a.bones}; }));
  await tick();

  return {sizes:sizes, prof:prof, core:core, SCALE:SCALE, pivots:pivots, bledCanvas:bledCanvas,
    unified:{V:unified.V, F:unified.F, owner:unified.owner}, partsMeta:partsMeta};
}

/**
 * フェーズ1: 中間データ契約。runCarvingStages()(prep〜accessories、重い
 * marching cubesまで)だけを実行し、GLBを作らずに以下を返す:
 *   - rawUnified: {V,F,owner} (体+全アクセサリーを1つの共有gridで彫刻した
 *     直後・間引き/平滑化前の継ぎ目のない1枚のメッシュ。owner=頂点ごとの
 *     所属パーツID)
 *   - partsMeta: [{ownerId,name,mode,bones}, ...] (ownerId=0が体、1以降が
 *     各アクセサリー。スキニング時にownerIdでパーツへ分割するのに使う)
 *   - bledCanvases: {front,back,side} (prep+bleed済みcanvas。atlas_bakeの入力用)
 *   - pivots: スキン計算/atlas継ぎ目判定に必要な骨格ピボット(モデル座標)
 *   - calib: {SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF} (atlas_bake/finishFromIntermediateで再利用)
 * ビューア(character_3d.html)側はこの中間データ+gen_paramsの一部を使って
 * finishFromIntermediate()を呼べば、再彫刻なしにモデルを再構築できる。
 * ★2026-07-11: 以前はrawBody/rawAccessoriesという分割済みの形で返していたが、
 * パーツ分割は間引き・平滑化が終わった後(finishFromIntermediate内)にのみ
 * 行うよう変更したため、ここでは統合済みのrawUnifiedをそのまま返す。
 * 戻り値: Promise<object>
 */
async function runToIntermediate(state, onProgress){
  function report(label){ console.log("=== stage:", label, "==="); if(onProgress) onProgress(label); }
  var staged = await runCarvingStages(state, report);
  var prof=staged.prof, core=staged.core;

  return {
    rawUnified: staged.unified,
    partsMeta: staged.partsMeta,
    bledCanvases: staged.bledCanvas,
    pivots: staged.pivots,
    calib: {SCALE:staged.SCALE, CX:prof.CX, YBOT:prof.YBOT, SYTOP:prof.SYTOP, SYBOT:prof.SYBOT, SIDE_REF:core.SIDE_REF},
  };
}
P3D.runToIntermediate = runToIntermediate;

/**
 * フェーズ1/2: 中間データ(runToIntermediateの戻り値と同じ形。IndexedDBから
 * 読み込んだ場合はbledCanvasesがHTMLCanvasElementに復元済みであること)から
 * GLBを再構築する。彫刻(marching cubes)はやり直さず、rawUnified(体+全
 * アクセサリー統合済み・継ぎ目なしの1枚のメッシュ)に間引き(decimate)・
 * 平滑化(smooth_iters)・スキニング・atlas焼き込み・GLB書き出しだけを適用する
 * (フェーズ2のライブパラメータ編集の中核関数)。
 * opts: {gp, seamAngles, seamNoSide, seamSmoothIters, colorGradWidth, colorGradStrength}
 * 戻り値: Promise<ArrayBuffer>
 *
 * ★2026-07-11(ユーザー指摘「パーツ分割のタイミングが早すぎる」対応):
 * 以前はbody/各アクセサリーを彫刻直後にsplitMeshByOwnerで分割し、間引き・
 * 平滑化をパーツごとに独立して行っていた。境界を共有する頂点が両側で別々に
 * 動くため、彫刻直後はぴったり合っていた継ぎ目が最終的にズレて隙間になって
 * いた。間引き・平滑化は統合されたままの1枚のメッシュに対して1回だけ行い、
 * その後(スキニングの直前)にだけsplitMeshByOwnerでパーツへ分割するように
 * 変更した。これに伴い、パーツごとに分かれていた間引き目標頂点数・平滑化
 * 回数(body_target_verts/acc_target_verts、body_smooth_iters/
 * acc_smooth_iters)は、共有トポロジーを1回で処理する以上分けようがない
 * ため、1本の値(target_verts、smooth_iters)に統合した(ユーザー承認済み。
 * 「髪だけ多めに平滑化」等パーツ別の強弱は失われるトレードオフ)。
 *
 * ★フェーズ2追加課題6の対応(段階的キャッシュ): どのパラメータ層(Tier1〜3)が
 * 実際に変わったかに応じて、変化のなかった段の再計算を省略する。
 *   1. decimate段: decimate/decimate_strength(Tier2)にのみ依存。統合メッシュに
 *      間引きのみ適用(owner配列も追従)。
 *   2. mesh_finish段(平滑化+パーツ分割+スキニング): 1の出力 + smooth_iters/
 *      rigid_soft_width(Tier1)に依存。
 *   3. atlas_bake段: 2の出力 + seamAngles/seamNoSide/seamSmoothIters/
 *      colorGradWidth/colorGradStrength(Tier3)に依存。
 *   4. model_glb段(テクスチャ圧縮+GLB書き出し): 3の出力 + kb_per_face(Tier1)。
 *      圧縮のみなので常に軽量、キャッシュ不要で毎回実行する。
 * 各段の入力シグネチャ(JSON文字列)をinter._stageCacheに保存し、前回と一致
 * すればその段はスキップして前回の結果を再利用する。あるTierが変わって
 * 上流の段が再計算されれば、その下流の段も強制的に再計算する。
 */
function decimateStage(inter, gp){
  var V=inter.raw_unified.V, F=inter.raw_unified.F, owner=inter.raw_unified.owner;
  if(gp.decimate){
    var d=P3D.decimateMesh(V,F,gp.decimate_strength,owner);
    V=d.V; F=d.F; owner=d.owner;
  }
  return {V:V, F:F, owner:owner};
}

function meshFinishStage(decimated, gp, pivots, partsMeta){
  var V=decimated.V, F=decimated.F, owner=decimated.owner;
  if(gp.smooth_iters>0) V=P3D.laplacianSmoothPreserveExtent(V,F,gp.smooth_iters);
  var fw=P3D.computeNormalsFixWinding(V,F);
  F=fw.F;

  // ★2026-07-11: 形状(間引き・平滑化・法線)が確定した後、ここで初めて
  // パーツ(体/各アクセサリー)へ分割する。法線Nもowner配列と同じ頂点並びで
  // 一緒に分割する(splitMeshByOwnerのextraVertArrays)。
  var ownerIds=partsMeta.map(function(p){ return p.ownerId; });
  var split=P3D.splitMeshByOwner(V, F, owner, ownerIds, {N:fw.N});

  var bodyPart=split[0];
  var bodyV=bodyPart.V, bodyF=bodyPart.F, bodyN=bodyPart.extra.N;
  var bodySkin=P3D.nearestBoneSegmentSkin(bodyV, pivots, P3D.BONES, 4, gp.rigid_soft_width);

  var acc=null;
  if(partsMeta.length>1){
    var allV=[],allN=[],allF=[],allJ=[],allW=[],allAccName=[]; var voff=0;
    for(var i=1;i<partsMeta.length;i++){
      var p=partsMeta[i], part=split[i];
      if(!part.V.length) continue;
      var V2=part.V, F2=part.F, N2=part.extra.N;
      var skin;
      if(p.mode==='rigid'){
        skin = P3D.rigidSkin(V2, (p.bones&&p.bones[0])||'head');
      }else{
        skin = P3D.nearestBoneSegmentSkin(V2, pivots, (p.bones&&p.bones.length)?p.bones:P3D.BONES, 4, gp.rigid_soft_width);
      }
      allV.push(V2); allN.push(N2);
      for(var j=0;j<F2.length;j++) allF.push(F2[j]+voff);
      allJ.push(skin.J); allW.push(skin.W);
      var nv=V2.length/3;
      for(var k=0;k<nv;k++) allAccName.push(p.name);
      voff+=nv;
    }
    if(allV.length){
      var accV=P3D.concatTypedArrays(Float32Array,allV), accN=P3D.concatTypedArrays(Float32Array,allN);
      var accF=Uint32Array.from(allF);
      var accJ=P3D.concatTypedArrays(Uint16Array,allJ);
      var accW=P3D.concatTypedArrays(Float32Array,allW);
      var accNF=Uint8Array.from(allAccName.map(function(){return 0;}));
      acc = {V:accV, N:accN, F:accF, J:accJ, W:accW, NF:accNF, accName:allAccName};
    }
  }
  return {bodyV:bodyV, bodyF:bodyF, bodyN:bodyN, bodySkin:bodySkin, acc:acc};
}

async function finishFromIntermediate(inter, opts, onProgress){
  function report(label){ console.log("=== stage:", label, "==="); if(onProgress) onProgress(label); }
  var gp = opts.gp;
  var cache = inter._stageCache || (inter._stageCache = {});
  function sig(o){ return JSON.stringify(o); }

  var decSig = sig({d:gp.decimate, ds:gp.decimate_strength});
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

  var meshSig = decSig+"|"+sig({si:gp.smooth_iters, rsw:gp.rigid_soft_width});
  var meshFinished;
  if(cache.meshSig===meshSig && cache.meshFinished){
    meshFinished = cache.meshFinished;
  }else{
    report("mesh_finish(平滑化/スキニング)");
    meshFinished = meshFinishStage(decimated, gp, inter.pivots, inter.parts_meta);
    cache.meshSig = meshSig; cache.meshFinished = meshFinished;
    cache.bakeSig = null; // 下流を強制再計算
  }
  await tick();

  var origBled = inter.bled_canvases;
  var bakeSig = meshSig+"|"+sig({sa:opts.seamAngles, sns:opts.seamNoSide, ssi:opts.seamSmoothIters, cgw:opts.colorGradWidth, cgs:opts.colorGradStrength});
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
      colorGradStrength: opts.colorGradStrength,
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

})(window);
