// -*- coding: utf-8 -*-
// pipeline_lib/profile.py の stage_profile()/stage_core() のJS移植。
// (診断専用のprofile.json 'layers'配列はメッシュ生成に使われていないため省略。
// メッシュ生成に実際に必要なmeta値(YTOP/YBOT/CX/SYTOP/SYBOT/SIDE_REF)だけ計算する)
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

function boolBounds(mask, w, h){
  // mask: Uint8Array(w*h) 1=前景。行優先で最初/最後に1があるyを探す(np.where(mask).min/max相当)
  var top=-1, bot=-1;
  for(var y=0;y<h;y++){
    var row=mask.subarray(y*w,y*w+w);
    var has=false;
    for(var x=0;x<w;x++){ if(row[x]){has=true;break;} }
    if(has){ if(top<0) top=y; bot=y; }
  }
  return [top,bot];
}

// front側のみのYTOP/YBOT/CX計算(side画像が未読込の段階でも呼べるよう分離)。
// landmark_tool.htmlの分析(analysis)をパイプライン本番の計算と同じ基準
// (同じ2値化・除外マスク)に揃えるためstageProfileと共有する。
function frontProfileOnly(frontAlpha, fw, fh){
  var fb=boolBounds(frontAlpha, fw, fh);
  var YTOP=fb[0], YBOT=fb[1];
  var tc=[];
  var fLin=P3D.linspace(0.32,0.50,15);
  for(var i=0;i<fLin.length;i++){
    var f=fLin[i];
    var y=Math.round(YTOP+f*(YBOT-YTOP));
    var row=frontAlpha.subarray(y*fw,y*fw+fw);
    var r=P3D.findRuns(row,1);
    if(r.length){
      var big=r[0];
      for(var k=1;k<r.length;k++){ if(r[k][1]-r[k][0] > big[1]-big[0]) big=r[k]; }
      tc.push((big[0]+big[1])/2);
    }
  }
  var CX = Math.round(P3D.median(tc));
  return {YTOP:YTOP, YBOT:YBOT, CX:CX};
}
P3D.frontProfileOnly = frontProfileOnly;
P3D.boolBounds = boolBounds;

// ★2026-07-05: 背面画像には(前面と違って)除外マスクが用意されていないことが多く、
// boolBounds()の生の最上端行は、後れ毛やアホ毛のような細い1本の突起にそのまま
// 引っ張られてしまう(前面はユーザーが除外マスクでこの突起を手動で除いている
// ことが多いため、生のboolBoundsで比べると前面/背面で「同じもの」を指していない
// = 基準位置がズレる)。細い突起は無視し、頭の実際の幅に近い太さになった行を
// 頭頂として採用することで、前面のYTOPと同じ基準(細い後れ毛の先端ではなく
// 頭の輪郭そのもの)に揃える。
// alpha: Uint8Array(w*h), minWidthPx: この幅未満のrunは無視する
// 戻り値: 条件を満たす最初の行のy(見つからなければ-1)
function topRowByWidth(alpha, w, h, minWidthPx){
  for(var y=0;y<h;y++){
    var runs = P3D.findRuns(alpha.subarray(y*w,y*w+w), 1);
    var maxW = 0;
    for(var i=0;i<runs.length;i++){ var rw=runs[i][1]-runs[i][0]; if(rw>maxW) maxW=rw; }
    if(maxW>=minWidthPx) return y;
  }
  return -1;
}
P3D.topRowByWidth = topRowByWidth;

// 背面用のプロファイル。CXはfrontProfileOnlyと同じ方法(胸あたりの最大幅の中心)
// で求めるが、YTOPは上記の「前面のYTOP行における幅」を太さの基準にして測り直す
// (前面と同じ基準位置に揃える)。YBOTは生のboolBoundsのままでよい(実測で前面
// との差は1px程度とご検証済みで、後れ毛のような細い突起の影響を受けにくい)。
function backProfileMatched(backAlpha, bw, bh, frontAlpha, fw, frontYTOP, frontYBOT){
  var fbb = boolBounds(backAlpha, bw, bh);
  var rawTop = fbb[0], YBOT = fbb[1];
  // ★2026-07-05(訂正): frontYTOPちょうどの行は、除外マスクの境界のすぐ内側
  // (=マスクがちょうど途切れ始めた行)であることが多く、その行自体がまだ
  // 細い/薄いままなことがある(実測: 幅がわずか十数pxしかなく、しきい値が
  // 小さすぎて背面側もほぼ生の最上端(後れ毛の先端)のままになってしまった)。
  // frontYTOPから少し(身長の5%程度)下がった、頭の輪郭が安定している行の幅を
  // 基準にする。
  var refY = Math.min(Math.round(frontYTOP + 0.05*(frontYBOT-frontYTOP)), frontYBOT-1);
  var frontWidthAtRef = 0;
  var frontRuns = P3D.findRuns(frontAlpha.subarray(refY*fw, refY*fw+fw), 1);
  for(var i=0;i<frontRuns.length;i++){
    var rw=frontRuns[i][1]-frontRuns[i][0]; if(rw>frontWidthAtRef) frontWidthAtRef=rw;
  }
  // 前面の基準行の太さの6割を「頭とみなす」しきい値にする(前面/背面で頭の
  // 傾き・輪郭が完全には一致しないため、多少の余裕を持たせる)。
  var minWidthPx = Math.max(20, frontWidthAtRef*0.6);
  var matchedTop = topRowByWidth(backAlpha, bw, bh, minWidthPx);
  var YTOP = (matchedTop>=0) ? matchedTop : rawTop;
  var tc=[];
  var fLin=P3D.linspace(0.32,0.50,15);
  for(var i2=0;i2<fLin.length;i2++){
    var f=fLin[i2];
    var y=Math.round(YTOP+f*(YBOT-YTOP));
    var row=backAlpha.subarray(y*bw,y*bw+bw);
    var r=P3D.findRuns(row,1);
    if(r.length){
      var big=r[0];
      for(var k=1;k<r.length;k++){ if(r[k][1]-r[k][0] > big[1]-big[0]) big=r[k]; }
      tc.push((big[0]+big[1])/2);
    }
  }
  var CX = Math.round(P3D.median(tc));
  return {YTOP:YTOP, YBOT:YBOT, CX:CX, rawTop:rawTop, minWidthPx:minWidthPx};
}
P3D.backProfileMatched = backProfileMatched;

/**
 * frontAlpha: Uint8Array(fw*fh) front_cut相当(1=前景)
 * sideAlpha: Uint8Array(sw*sh) side_cut相当(1=前景)
 * 戻り値: {YTOP,YBOT,CX,SYTOP,SYBOT,W:fw,H:fh}
 */
function stageProfile(frontAlpha, fw, fh, sideAlpha, sw, sh){
  var fp=frontProfileOnly(frontAlpha, fw, fh);
  var sb=boolBounds(sideAlpha, sw, sh);
  var SYTOP=sb[0], SYBOT=sb[1];
  return {YTOP:fp.YTOP, YBOT:fp.YBOT, CX:fp.CX, SYTOP:SYTOP, SYBOT:SYBOT, W:fw, H:fh};
}
P3D.stageProfile = stageProfile;

// エッジパディングの箱型移動平均(11タップ、profile.py stage_core内のsm()移植)
function boxSmoothEdgePad(arr, k){
  k = k||11;
  var n=arr.length;
  var padded=new Float64Array(n+2*(k>>1));
  var half=k>>1;
  for(var i=0;i<half;i++) padded[i]=arr[0];
  for(var i2=0;i2<n;i2++) padded[half+i2]=arr[i2];
  for(var i3=0;i3<half;i3++) padded[half+n+i3]=arr[n-1];
  var out=new Float64Array(n);
  for(var i4=0;i4<n;i4++){
    var s=0; for(var j=0;j<k;j++) s+=padded[i4+j];
    out[i4]=s/k;
  }
  return out;
}

/**
 * sideAlpha: Uint8Array(sw*sh) side_cut相当(1=前景)
 * YTOP,YBOT: stageProfile()の戻り値(front基準のv境界だが、Python版もside画像の
 * 行indexとしてそのまま使っている=front/sideの縦キャリブレーションが概ね一致
 * している前提。元のPythonの挙動をそのまま踏襲する)
 * 戻り値: {SIDE_REF}
 */
function stageCore(sideAlpha, sw, sh, YTOP, YBOT){
  function runsGap4(y){ return P3D.findRuns(sideAlpha.subarray(y*sw,y*sw+sw), 4); }
  var wc=[];
  for(var y=YTOP;y<YBOT;y++){
    var r=runsGap4(y).filter(function(ab){return ab[1]-ab[0]>=8;});
    if(r.length){
      var big=r[0];
      for(var k=1;k<r.length;k++){ if(r[k][1]-r[k][0]>big[1]-big[0]) big=r[k]; }
      wc.push((big[0]+big[1])/2);
    }
  }
  var BODYC = wc.length ? P3D.median(wc) : sw/2;
  var sl=new Float64Array(sh).fill(NaN), sr=new Float64Array(sh).fill(NaN);
  for(var y2=0;y2<sh;y2++){
    var r2=runsGap4(y2).filter(function(ab){return ab[1]-ab[0]>=8;});
    if(!r2.length) continue;
    var best=r2[0], bd=Math.abs((best[0]+best[1])/2-BODYC);
    for(var k2=1;k2<r2.length;k2++){
      var d=Math.abs((r2[k2][0]+r2[k2][1])/2-BODYC);
      if(d<bd){bd=d;best=r2[k2];}
    }
    sl[y2]=best[0]; sr[y2]=best[1];
  }
  // NaN区間をnp.interp相当で補間(有効なyの前後端はクランプ = 端の値を延長)
  function interpNan(arr){
    var ys=[], vals=[];
    for(var i=0;i<arr.length;i++){ if(!isNaN(arr[i])){ ys.push(i); vals.push(arr[i]); } }
    if(!ys.length) return arr.slice();
    var out=new Float64Array(arr.length);
    for(var i2=0;i2<arr.length;i2++) out[i2]=P3D.interp1d(i2, ys, vals);
    return out;
  }
  sl=interpNan(sl); sr=interpNan(sr);
  sl=boxSmoothEdgePad(sl,11); sr=boxSmoothEdgePad(sr,11);
  var center=new Float64Array(sh);
  for(var y3=0;y3<sh;y3++) center[y3]=(sl[y3]+sr[y3])/2;
  var seg=[];
  for(var y4=YTOP;y4<YBOT;y4++) seg.push(center[y4]);
  var SIDE_REF = P3D.median(seg);
  return {SIDE_REF: SIDE_REF};
}
P3D.stageCore = stageCore;

})(window);
