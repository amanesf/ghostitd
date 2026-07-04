// -*- coding: utf-8 -*-
// pipeline_lib/atlas.py の stage_atlas_bake() のJS移植。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

var SEAM_DEFAULT_DEG = 45;

// seamAngles: {boneName: deg} (landmark_tool.htmlの「境目角度」タブの値)
// 戻り値: Float64Array(BONES.length) tan(角度)の比率
function loadSeamRatios(seamAngles){
  var BONES=P3D.BONES, BIDX=P3D.BIDX;
  var ratios=new Float64Array(BONES.length).fill(1.0); // tan(45)=1
  if(!seamAngles) return ratios;
  Object.keys(seamAngles).forEach(function(bone){
    var i=BIDX[bone];
    if(i===undefined) return;
    var deg=Math.max(1.0, Math.min(89.0, Number(seamAngles[bone])));
    ratios[i]=Math.tan(deg*Math.PI/180);
  });
  return ratios;
}
P3D.loadSeamRatios = loadSeamRatios;

// アクセサリー個別の境目角度(seamAngles中の"acc:"+名前キー)をMapにする。
// 名前が付いていないアクセサリーはボーン側の角度にフォールバックする
// (loadSeamRatios同様、既定tan45°=1)。
function loadAccessorySeamRatios(seamAngles){
  var map=new Map();
  if(!seamAngles) return map;
  Object.keys(seamAngles).forEach(function(key){
    if(key.indexOf("acc:")!==0) return;
    var deg=Math.max(1.0, Math.min(89.0, Number(seamAngles[key])));
    map.set(key.slice(4), Math.tan(deg*Math.PI/180));
  });
  return map;
}
P3D.loadAccessorySeamRatios = loadAccessorySeamRatios;

// seamNoSide: {boneName:true} (境目タブの「側面画像を使う」チェックを外したパーツ)
// 戻り値: Uint8Array(BONES.length) 1=側面画像を使わない
function loadSeamNoSide(seamNoSide){
  var BONES=P3D.BONES, BIDX=P3D.BIDX;
  var flags=new Uint8Array(BONES.length); // 既定0(=側面を使う)
  if(!seamNoSide) return flags;
  Object.keys(seamNoSide).forEach(function(bone){
    var i=BIDX[bone];
    if(i===undefined || bone.indexOf("acc:")===0) return;
    if(seamNoSide[bone]) flags[i]=1;
  });
  return flags;
}
P3D.loadSeamNoSide = loadSeamNoSide;

// アクセサリー個別の「側面画像を使わない」フラグ(seamNoSide中の"acc:"+名前キー)
function loadAccessorySeamNoSide(seamNoSide){
  var map=new Map();
  if(!seamNoSide) return map;
  Object.keys(seamNoSide).forEach(function(key){
    if(key.indexOf("acc:")!==0) return;
    if(seamNoSide[key]) map.set(key.slice(4), true);
  });
  return map;
}
P3D.loadAccessorySeamNoSide = loadAccessorySeamNoSide;

/**
 * 前面/背面/側面のブリード済みキャンバスからアトラスを合成する。
 * frontCanvas,backCanvas,sideCanvas: HTMLCanvasElement(すべて同サイズW x H前提)
 * 戻り値: HTMLCanvasElement (3W x H)
 */
function buildAtlasCanvas(frontCanvas, backCanvas, sideCanvas){
  var W=frontCanvas.width, H=frontCanvas.height;
  var atlas=document.createElement('canvas');
  atlas.width=3*W; atlas.height=H;
  var ctx=atlas.getContext('2d');
  ctx.drawImage(frontCanvas, 0, 0);
  // back画像は左右反転して中央に貼る
  ctx.save();
  ctx.translate(W + backCanvas.width, 0);
  ctx.scale(-1,1);
  ctx.drawImage(backCanvas, 0, 0);
  ctx.restore();
  ctx.drawImage(sideCanvas, 2*W, 0);
  return atlas;
}
P3D.buildAtlasCanvas = buildAtlasCanvas;

/**
 * opts: {
 *   W,H: front/back/side画像サイズ(正方形前提)
 *   SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF: キャリブレーション値
 *   bodyV,bodyN,bodyF,bodyJ,bodyW: stage_visual_hullの出力(Float32/Uint32Array)
 *   accV,accN,accF,accJ,accW,accNF: stage_accessoriesの出力(無ければnull)
 *   seamAngles: {boneName:deg}
 *   seamNoSide: {boneName:true} (境目タブの「側面画像を使う」チェックを外したパーツ。
 *     "acc:"+名前キーでアクセサリー個別指定も可)
 *   seamSmoothIters: 境界線平滑化の反復回数(既定8、0で平滑化なし=法線そのままの
 *     ギザギザ境界、大きくするほど境界線が滑らかな曲線になる)
 *   colorGradWidth: 色のディザ(擬似)グラデーション幅(既定0=無効)。0より大きいと
 *     境目付近の帯の中でfront/side面をノイズ混在させ、離れて見ると色がなめらかに
 *     混ざって見えるようにする(GLB単一UVでは本物の色ブレンドはできないため)
 * }
 * 戻り値: {restV,norm,UV,J,W,F} (mesh_bake.npz相当)
 */
// Float32Array/Uint16Array等の2本を連結する(Array.prototype.push.apply(...)は
// 引数展開の上限(数万〜十数万要素)を超えるとスタックオーバーフローするため、
// 大きな頂点配列(髪・スカート等、10万頂点超になりうる)ではtyped arrayの
// .set()で連結する)。
function concatTyped(Ctor, a, b){
  if(!b || !b.length) return a;
  var out=new Ctor(a.length+b.length);
  out.set(a,0); out.set(b,a.length);
  return out;
}

function stageAtlasBake(opts){
  var W=opts.W, H=opts.H, SCALE=opts.SCALE, CX=opts.CX, YBOT=opts.YBOT;
  var SYTOP=opts.SYTOP, SYBOT=opts.SYBOT, SIDE_REF=opts.SIDE_REF;
  var ATW=3*W, ATH=H;

  var nBodyV=opts.bodyV.length/3;
  var hasAcc = !!(opts.accV && opts.accV.length);
  var nAccV = hasAcc ? opts.accV.length/3 : 0;

  var allV=concatTyped(Float32Array, opts.bodyV, hasAcc?opts.accV:null);
  var allN=concatTyped(Float32Array, opts.bodyN, hasAcc?opts.accN:null);
  var J=concatTyped(Uint16Array, opts.bodyJ, hasAcc?opts.accJ:null);
  var Wt=concatTyped(Float32Array, opts.bodyW, hasAcc?opts.accW:null);

  var nBodyF=opts.bodyF.length;
  var nAccF = hasAcc ? opts.accF.length : 0;
  var allF=new Uint32Array(nBodyF+nAccF);
  allF.set(opts.bodyF, 0);
  for(var i=0;i<nAccF;i++) allF[nBodyF+i]=opts.accF[i]+nBodyV;

  var noFront=new Uint8Array(nBodyV+nAccV); // 既定0(=false)
  if(hasAcc && opts.accNF){
    for(var i2=0;i2<nAccV;i2++) noFront[nBodyV+i2]=opts.accNF[i2]?1:0;
  }
  // 各頂点の所属アクセサリー名(本体頂点はnull)。境目角度をアクセサリー単位で
  // 個別上書きできるようにするためのタグ(accessories.jsのaccName参照)。
  var accOwner=new Array(nBodyV+nAccV).fill(null);
  if(hasAcc && opts.accName){
    for(var i2b=0;i2b<nAccV;i2b++) accOwner[nBodyV+i2b]=opts.accName[i2b];
  }

  var nV=allV.length/3, nF=allF.length/3;
  var seamRatios = loadSeamRatios(opts.seamAngles);
  var accSeamRatios = loadAccessorySeamRatios(opts.seamAngles);
  var seamNoSideArr = loadSeamNoSide(opts.seamNoSide);
  var accSeamNoSide = loadAccessorySeamNoSide(opts.seamNoSide);
  var seamSmoothIters = (opts.seamSmoothIters!==undefined && opts.seamSmoothIters!==null)
    ? Math.max(0, Math.min(30, Number(opts.seamSmoothIters))) : 8;
  // 色のグラデーション幅(既定0=無効、従来通りの単一UVでのハード切替)。
  // GLBは単一UVのため本物の色ブレンドはできないので、境目付近の帯の中で
  // front/side(および正面/背面)の面をノイズパターンで細かく混在させ、
  // 離れて見ると色がなめらかに混ざって見えるディザ(擬似)グラデーションにする。
  var colorGradWidth = (opts.colorGradWidth!==undefined && opts.colorGradWidth!==null)
    ? Math.max(0, Number(opts.colorGradWidth)) : 0;
  function hashNoise(x,y,z){
    var s=Math.sin(x*127.1+y*311.7+z*74.7)*43758.5453123;
    return s-Math.floor(s);
  }

  var pxAll=new Float64Array(nV), pyAll=new Float64Array(nV);
  var spxAll=new Float64Array(nV), spyAll=new Float64Array(nV);
  for(var v=0; v<nV; v++){
    var x=allV[v*3], y=allV[v*3+1], z=allV[v*3+2];
    pxAll[v]=x*SCALE+CX;
    pyAll[v]=YBOT-y*SCALE;
    spxAll[v]=Math.min(Math.max(SIDE_REF+z*SCALE,0),W-1);
    spyAll[v]=Math.min(Math.max(SYTOP+(1.0-y)*(SYBOT-SYTOP),0),H-1);
  }

  // ★2026-07-04: 投影(front/back/side)の切り替えを面単位の法線で即決すると、
  // 法線のノイズで境界線がギザギザ・飛び地状になり「画像の継ぎ目」が汚く見える。
  // 判定に使うスカラー場(side度=|nx|-ratio*|nz|、front度=nz)を頂点単位で作り、
  // メッシュ隣接で数回平滑化してから面ごとに多数決することで、継ぎ目の線が
  // 滑らかな一本の曲線になるようにする(色の混合はGLB単一UVでは不可能なので、
  // 境界線そのものを滑らかにするアプローチ)。
  var adj=[];
  for(var av=0; av<nV; av++) adj.push([]);
  for(var af=0; af<nF; af++){
    var a0=allF[af*3], a1=allF[af*3+1], a2=allF[af*3+2];
    adj[a0].push(a1,a2); adj[a1].push(a0,a2); adj[a2].push(a0,a1);
  }
  var sideS=new Float64Array(nV), frontS=new Float64Array(nV);
  var noSide=new Uint8Array(nV); // 1=このパーツは側面画像を使わない(境目タブのチェックで指定)
  for(var sv=0; sv<nV; sv++){
    var ratioV = (accOwner[sv] && accSeamRatios.has(accOwner[sv]))
      ? accSeamRatios.get(accOwner[sv]) : seamRatios[J[sv*4]];
    sideS[sv]=Math.abs(allN[sv*3]) - ratioV*Math.abs(allN[sv*3+2]);
    frontS[sv]=allN[sv*3+2];
    noSide[sv] = (accOwner[sv] && accSeamNoSide.has(accOwner[sv]))
      ? 1 : seamNoSideArr[J[sv*4]];
  }
  function smoothField(S, iters){
    var cur=Float64Array.from(S), tmp=new Float64Array(nV);
    for(var it=0; it<iters; it++){
      for(var v2=0; v2<nV; v2++){
        var nb=adj[v2];
        if(!nb.length){ tmp[v2]=cur[v2]; continue; }
        var s=0;
        for(var k2=0;k2<nb.length;k2++) s+=cur[nb[k2]];
        tmp[v2]=0.5*cur[v2]+0.5*(s/nb.length);
      }
      var sw=cur; cur=tmp; tmp=sw;
    }
    return cur;
  }
  sideS=smoothField(sideS, seamSmoothIters);
  frontS=smoothField(frontS, seamSmoothIters);

  var finPos=[], finNorm=[], finUv=[], finFace=[], finOrigVi=[];
  var key2idx=new Map();
  function getIndex(vi,u,vv){
    var key=vi+"_"+u.toFixed(6)+"_"+vv.toFixed(6);
    var idx=key2idx.get(key);
    if(idx===undefined){
      idx=finPos.length/3;
      finPos.push(allV[vi*3],allV[vi*3+1],allV[vi*3+2]);
      finNorm.push(allN[vi*3],allN[vi*3+1],allN[vi*3+2]);
      finUv.push(u,vv);
      finOrigVi.push(vi);
      key2idx.set(key, idx);
    }
    return idx;
  }
  var nSideFaces=0;
  for(var f=0; f<nF; f++){
    var f0=allF[f*3], f1=allF[f*3+1], f2=allF[f*3+2];
    var ax=allV[f0*3],ay=allV[f0*3+1],az=allV[f0*3+2];
    var bx=allV[f1*3],by=allV[f1*3+1],bz=allV[f1*3+2];
    var cx=allV[f2*3],cy=allV[f2*3+1],cz=allV[f2*3+2];
    var ux=bx-ax,uy=by-ay,uz=bz-az, wx=cx-ax,wy=cy-ay,wz=cz-az;
    var gnx=uy*wz-uz*wy, gny=uz*wx-ux*wz, gnz=ux*wy-uy*wx;
    var vnx=allN[f0*3]+allN[f1*3]+allN[f2*3];
    var vny=allN[f0*3+1]+allN[f1*3+1]+allN[f2*3+1];
    var vnz=allN[f0*3+2]+allN[f1*3+2]+allN[f2*3+2];
    var dot=gnx*vnx+gny*vny+gnz*vnz;
    var ff = (dot<0) ? [f0,f2,f1] : [f0,f1,f2];
    // 平滑化済みスカラー場(sideS/frontS)の3頂点和で判定する(境目角度ratioは
    // sideS構築時に頂点単位で織り込み済み。アクセサリー個別角度も同様)。
    var sideAvg=(sideS[ff[0]]+sideS[ff[1]]+sideS[ff[2]])/3;
    var frontAvg=(frontS[ff[0]]+frontS[ff[1]]+frontS[ff[2]])/3;
    var faceNoSide = noSide[ff[0]] || noSide[ff[1]] || noSide[ff[2]];
    var faceNoFront = noFront[ff[0]] || noFront[ff[1]] || noFront[ff[2]];
    var useSide, front;
    if(colorGradWidth<=0){
      useSide = !faceNoSide && sideAvg>0;
      front = !faceNoFront && frontAvg>=0;
    }else{
      // 境目付近の帯(colorGradWidth)の中だけ、面の重心座標由来の安定した
      // 疑似乱数でfront/side(正面/背面)をノイズ混在させる。帯の外は従来通り
      // ハード切替(色そのもののブレンドではなく、離れて見ると混ざって見える
      // ディザ表現)。
      var cxF=(ax+bx+cx)/3, cyF=(ay+by+cy)/3, czF=(az+bz+cz)/3;
      var pSide=0.5+0.5*Math.max(-1,Math.min(1, sideAvg/colorGradWidth));
      useSide = !faceNoSide && (hashNoise(cxF,cyF,czF) < pSide);
      var pFront=0.5+0.5*Math.max(-1,Math.min(1, frontAvg/colorGradWidth));
      front = !faceNoFront && (hashNoise(cxF+1000.0,cyF,czF) < pFront);
    }
    var tri=[];
    for(var k=0;k<3;k++){
      var vi=ff[k];
      var gu,gv;
      if(useSide){
        gu=(2*W+spxAll[vi])/ATW;
        gv=spyAll[vi]/ATH;
      }else{
        gu=(front ? pxAll[vi] : W+pxAll[vi])/ATW;
        gv=pyAll[vi]/ATH;
      }
      tri.push(getIndex(vi,gu,gv));
    }
    finFace.push(tri[0],tri[1],tri[2]);
    if(useSide) nSideFaces++;
  }

  var finJ=new Uint16Array(finOrigVi.length*4), finW=new Float32Array(finOrigVi.length*4);
  for(var i3=0;i3<finOrigVi.length;i3++){
    var ovi=finOrigVi[i3];
    for(var c=0;c<4;c++){ finJ[i3*4+c]=J[ovi*4+c]; finW[i3*4+c]=Wt[ovi*4+c]; }
  }
  console.log("  atlas_bake: UV generated, verts", finPos.length/3, "tris", finFace.length/3, "side面", nSideFaces);

  return {
    restV: Float32Array.from(finPos),
    norm: Float32Array.from(finNorm),
    UV: Float32Array.from(finUv),
    J: finJ,
    W: finW,
    F: Uint32Array.from(finFace),
  };
}
P3D.stageAtlasBake = stageAtlasBake;

})(window);
