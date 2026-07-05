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
// アクセサリーは常にこのMapの値だけを使う(未設定なら既定tan45°=1)。
// スキニング先ボーン(head/hipsなど)の角度は絶対に継承しない
// (★2026-07-05: 以前はMapに無ければボーン側の角度にフォールバックしていたが、
// 「側面画像を使う」のON/OFFをアクセサリー個別に設定していない限りボーン側の
// 設定を無条件に引き継いでしまい、髪やスカートがボーン側の設定(側面無効)に
// 引きずられて側面画像が使われない不具合の原因になっていた)。
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
 *   colorGradWidth: 色グラデーション(境界ぼかし)の幅(既定0=無効)。0より大きいと
 *     境目付近の帯の中で、実際にfront/side(および正面/背面)の写真ピクセルを
 *     角度ベースの重みで数値的に混ぜ合わせ、front/back/sideキャンバスへ直接
 *     焼き込む(ディザ/ノイズではない本物の色ブレンド)。
 *   frontCanvas,backCanvas,sideCanvas: bleed済みの生キャンバス(colorGradWidth>0の
 *     ときだけ使用。ピクセルを直接書き換える)
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

// ---- 継ぎ目の実カラーブレンド(colorGradWidth>0のときだけ使う) ----

// バイリニアで(x,y)の色をサンプルする(x,yは小数可、範囲外はクランプ)。
function samplePixelBilinear(imgData, x, y){
  var w=imgData.width, h=imgData.height, data=imgData.data;
  x = Math.max(0, Math.min(w-1.001, x));
  y = Math.max(0, Math.min(h-1.001, y));
  var x0=Math.floor(x), y0=Math.floor(y);
  var x1=Math.min(w-1,x0+1), y1=Math.min(h-1,y0+1);
  var fx=x-x0, fy=y-y0;
  var out=[0,0,0];
  for(var c=0;c<3;c++){
    var i00=(y0*w+x0)*4+c, i10=(y0*w+x1)*4+c, i01=(y1*w+x0)*4+c, i11=(y1*w+x1)*4+c;
    var top=data[i00]+(data[i10]-data[i00])*fx;
    var bot=data[i01]+(data[i11]-data[i01])*fx;
    out[c]=top+(bot-top)*fy;
  }
  return out;
}

// 三角形(primaryData空間のp0,p1,p2)をラスタライズし、各ピクセルで重心座標により
// (a)頂点ごとのブレンド重みw0,w1,w2を補間、(b)otherData空間でのサンプル位置
// (o0,o1,o2を補間)を求め、primaryDataの色にotherDataの色を重み分だけ混ぜて
// primaryDataへ書き戻す(ノイズは使わない、実数値の加重平均)。
function blendTriangleColors(primaryData, p0,p1,p2, w0,w1,w2, otherData, o0,o1,o2){
  var minX=Math.max(0,Math.floor(Math.min(p0[0],p1[0],p2[0])));
  var maxX=Math.min(primaryData.width-1,Math.ceil(Math.max(p0[0],p1[0],p2[0])));
  var minY=Math.max(0,Math.floor(Math.min(p0[1],p1[1],p2[1])));
  var maxY=Math.min(primaryData.height-1,Math.ceil(Math.max(p0[1],p1[1],p2[1])));
  if(maxX<minX || maxY<minY) return;
  var denom=(p1[1]-p2[1])*(p0[0]-p2[0])+(p2[0]-p1[0])*(p0[1]-p2[1]);
  if(Math.abs(denom)<1e-9) return;
  var data=primaryData.data, pw=primaryData.width;
  for(var y=minY;y<=maxY;y++){
    for(var x=minX;x<=maxX;x++){
      var l0=((p1[1]-p2[1])*(x+0.5-p2[0])+(p2[0]-p1[0])*(y+0.5-p2[1]))/denom;
      var l1=((p2[1]-p0[1])*(x+0.5-p2[0])+(p0[0]-p2[0])*(y+0.5-p2[1]))/denom;
      var l2=1-l0-l1;
      if(l0<-0.02||l1<-0.02||l2<-0.02) continue; // 三角形の外
      var weight=l0*w0+l1*w1+l2*w2;
      if(weight<=0.002) continue; // 混ぜる必要がないほど小さい
      var ox=l0*o0[0]+l1*o1[0]+l2*o2[0];
      var oy=l0*o0[1]+l1*o1[1]+l2*o2[1];
      var oc=samplePixelBilinear(otherData, ox, oy);
      var idx=(y*pw+x)*4;
      data[idx]  =data[idx]  *(1-weight)+oc[0]*weight;
      data[idx+1]=data[idx+1]*(1-weight)+oc[1]*weight;
      data[idx+2]=data[idx+2]*(1-weight)+oc[2]*weight;
    }
  }
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
  // 色グラデーション(境界ぼかし)の幅(既定0=無効)。0より大きいと、境目付近の
  // 帯の中でfront/side(および正面/背面)の実ピクセル色を角度ベースの重みで
  // 数値的に混ぜてfront/back/sideキャンバスへ焼き込む(下のblendOnブロック)。
  var colorGradWidth = (opts.colorGradWidth!==undefined && opts.colorGradWidth!==null)
    ? Math.max(0, Number(opts.colorGradWidth)) : 0;

  var pxAll=new Float64Array(nV), pyAll=new Float64Array(nV);
  var spxAll=new Float64Array(nV), spyAll=new Float64Array(nV);
  for(var v=0; v<nV; v++){
    var x=allV[v*3], y=allV[v*3+1], z=allV[v*3+2];
    // ★2026-07-05: side用のspxAll/spyAllは元々[0,W-1]/[0,H-1]にクランプして
    // いたが、front/back用のpxAll/pyAllにはクランプが無かった。平滑化/
    // マーチングキューブス/間引きで輪郭ぎりぎりの頂点(頭頂のアホ毛、
    // アクセサリーの先端等)が元写真のシルエット範囲をわずかに超えると、
    // GLBのテクスチャサンプラーはwrapS/wrapT=REPEAT(model_export.js)のため
    // UVが0または1を超えた分だけアトラスの別領域(側面や反対側の正面/背面)に
    // 回り込み、全く無関係な色を貼ってしまっていた(境目付近の虹色の縞の原因)。
    // side同様に画像範囲へクランプし、縁を超えた頂点は縁のピクセルを
    // 引き伸ばして使うようにする。
    pxAll[v]=Math.min(Math.max(x*SCALE+CX,0),W-1);
    pyAll[v]=Math.min(Math.max(YBOT-y*SCALE,0),H-1);
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
    // ★2026-07-05: アクセサリー頂点(accOwnerが付いている)はスキニング先ボーンの
    // 境目設定を継承しない。アクセサリー個別のMapに値が無ければ既定値
    // (tan45°=1、側面を使う)を使う(ボーン側がどんな設定でも無関係)。
    var ratioV = accOwner[sv]
      ? (accSeamRatios.has(accOwner[sv]) ? accSeamRatios.get(accOwner[sv]) : 1.0)
      : seamRatios[J[sv*4]];
    sideS[sv]=Math.abs(allN[sv*3]) - ratioV*Math.abs(allN[sv*3+2]);
    frontS[sv]=allN[sv*3+2];
    noSide[sv] = accOwner[sv]
      ? (accSeamNoSide.has(accOwner[sv]) ? 1 : 0)
      : seamNoSideArr[J[sv*4]];
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

  // 継ぎ目の実カラーブレンド用に、front/back/sideキャンバスのImageDataを一度だけ
  // 取得しておく(colorGradWidth>0のときのみ)。back画像は生キャンバスの時点では
  // mesh xに対して鏡像(buildAtlasCanvasが合成時に反転させる前提)なので、
  // サンプリング側でも同じ反転を再現する。
  var blendOn = !!(colorGradWidth>0 && opts.frontCanvas && opts.backCanvas && opts.sideCanvas);
  var frontImgData=null, backImgData=null, sideImgData=null;
  if(blendOn){
    frontImgData = opts.frontCanvas.getContext('2d').getImageData(0,0,opts.frontCanvas.width,opts.frontCanvas.height);
    backImgData = opts.backCanvas.getContext('2d').getImageData(0,0,opts.backCanvas.width,opts.backCanvas.height);
    sideImgData = opts.sideCanvas.getContext('2d').getImageData(0,0,opts.sideCanvas.width,opts.sideCanvas.height);
  }
  function regionData(region){
    return region==='front' ? frontImgData : (region==='back' ? backImgData : sideImgData);
  }
  function regionPoint(region, vi){
    if(region==='front') return [pxAll[vi], pyAll[vi]];
    if(region==='back') return [(W-1)-pxAll[vi], pyAll[vi]];
    return [spxAll[vi], spyAll[vi]];
  }
  // 頂点viの、primary側からother側へのブレンド重み(継ぎ目ちょうどで0.5、
  // colorGradWidth分離れると0になる)。fieldはsideS/frontSどちらかの平滑化済み配列。
  function seamWeight(field, vi){
    return 0.5*Math.max(0, Math.min(1, 1-Math.abs(field[vi])/colorGradWidth));
  }

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
    // 面がどの写真を使うかは常にハード判定(ディザはしない)。継ぎ目のなめらかさは
    // 下のblendOnブロックで実際の色を混ぜることで出す。
    var useSide = !faceNoSide && sideAvg>0;
    var front = !faceNoFront && frontAvg>=0;
    if(blendOn){
      var primaryRegionNonSide = front ? 'front' : 'back';
      // 側面 <-> 正面/背面 の継ぎ目
      if(!faceNoSide && Math.abs(sideAvg)<colorGradWidth){
        var sidePrimary = useSide ? 'side' : primaryRegionNonSide;
        var sideOther = useSide ? primaryRegionNonSide : 'side';
        var pd=regionData(sidePrimary), od=regionData(sideOther);
        if(pd && od){
          var sp0=regionPoint(sidePrimary,ff[0]), sp1=regionPoint(sidePrimary,ff[1]), sp2=regionPoint(sidePrimary,ff[2]);
          var so0=regionPoint(sideOther,ff[0]), so1=regionPoint(sideOther,ff[1]), so2=regionPoint(sideOther,ff[2]);
          blendTriangleColors(pd, sp0,sp1,sp2,
            seamWeight(sideS,ff[0]), seamWeight(sideS,ff[1]), seamWeight(sideS,ff[2]),
            od, so0,so1,so2);
        }
      }
      // 正面 <-> 背面 の継ぎ目(側面を使う面は対象外)
      if(!useSide && !faceNoFront && Math.abs(frontAvg)<colorGradWidth){
        var fbPrimary = front ? 'front' : 'back';
        var fbOther = front ? 'back' : 'front';
        var pd2=regionData(fbPrimary), od2=regionData(fbOther);
        if(pd2 && od2){
          var fp0=regionPoint(fbPrimary,ff[0]), fp1=regionPoint(fbPrimary,ff[1]), fp2=regionPoint(fbPrimary,ff[2]);
          var fo0=regionPoint(fbOther,ff[0]), fo1=regionPoint(fbOther,ff[1]), fo2=regionPoint(fbOther,ff[2]);
          blendTriangleColors(pd2, fp0,fp1,fp2,
            seamWeight(frontS,ff[0]), seamWeight(frontS,ff[1]), seamWeight(frontS,ff[2]),
            od2, fo0,fo1,fo2);
        }
      }
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
  // blendTriangleColorsで書き換えたImageDataを、元のキャンバスへ書き戻す
  // (buildAtlasCanvasがこの後この生キャンバスからアトラスを合成する)。
  if(blendOn){
    opts.frontCanvas.getContext('2d').putImageData(frontImgData,0,0);
    opts.backCanvas.getContext('2d').putImageData(backImgData,0,0);
    opts.sideCanvas.getContext('2d').putImageData(sideImgData,0,0);
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
