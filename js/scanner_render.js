// -*- coding: utf-8 -*-
// ゴーストスキャナー(ghost_scanner.html)専用: プレビュー描画層。
// GHOST_SCANNER_PLAN.mdのフェーズ0で js/common.js に切り出した汎用描画関数
// (P3D.drawCross/P3D.drawLabel/P3D.drawPolygonOutline/P3D.LM/P3D.GCOL)を呼ぶだけの
// 薄い層にする(landmark_tool.htmlと見た目を完全に統一するため、独自に色や
// 点の形を再実装しない)。状態(どのタブの何を表示するか)はghost_scanner.html側の
// 状態オブジェクトが持ち、この層は「渡された座標を描くだけ」の単一責務にする。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

// ---- 画像リサイズ(フェーズ2: 1024x1024へリサイズしてからGeminiに渡す) ----
// GHOST_SCANNER_PLAN.md「3面図生成」節の通り、Geminiのリサイズは使わず、必ず
// 先にこちら側でリサイズしてから送る(縦横比は維持し、余白を透過で埋める=
// アスペクト比の歪みでキャラクターの体型が変わって渡るのを防ぐ)。
// 戻り値: {canvas, dataUrl}
function resizeImageToSquare(img, size){
  size = size || 1024;
  var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  var scale = Math.min(size/iw, size/ih);
  var dw = Math.round(iw*scale), dh = Math.round(ih*scale);
  var ox = Math.round((size-dw)/2), oy = Math.round((size-dh)/2);
  var c = document.createElement("canvas"); c.width=size; c.height=size;
  var ctx = c.getContext("2d");
  ctx.clearRect(0,0,size,size);
  ctx.drawImage(img, 0,0, iw,ih, ox,oy, dw,dh);
  return { canvas:c, dataUrl:c.toDataURL("image/png") };
}
P3D.scannerResizeImageToSquare = resizeImageToSquare;

// dataURL/Blob/File -> HTMLImageElement(Promise)
function loadImageFromSrc(src){
  return new Promise(function(resolve,reject){
    var img = new Image();
    img.onload = function(){ resolve(img); };
    img.onerror = function(e){ reject(new Error("画像の読み込みに失敗しました")); };
    img.src = src;
  });
}
P3D.scannerLoadImage = loadImageFromSrc;
function fileToDataUrl(file){
  return new Promise(function(resolve,reject){
    var r = new FileReader();
    r.onload = function(){ resolve(r.result); };
    r.onerror = function(){ reject(new Error("ファイルの読み込みに失敗しました")); };
    r.readAsDataURL(file);
  });
}
P3D.scannerFileToDataUrl = fileToDataUrl;

// ---- ランドマークの簡易プレビュー(フェーズ5) ----
// canvas: 描画先のCanvasRenderingContext2D、img: 背景に描くHTMLImageElement、
// w,h: 表示サイズ(canvas自体はこのサイズで用意しておくこと)、
// pointsPx: {key:{x,y}} (画像の原寸ピクセル座標)、scale: 画像原寸->表示サイズの倍率
function drawLandmarkPreview(ctx, img, w, h, pointsPx, scale){
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(img, 0,0, w,h);
  (P3D.LM||[]).forEach(function(d){
    var p = pointsPx[d.k];
    if(!p) return;
    var px = p.x*scale, py = p.y*scale;
    P3D.drawCross(ctx, px, py, false, P3D.GCOL[d.g]);
    P3D.drawLabel(ctx, d.jp, px, py-13, P3D.GCOL[d.g]);
  });
}
P3D.scannerDrawLandmarkPreview = drawLandmarkPreview;

// ---- アクセサリー領域の簡易プレビュー(フェーズ6) ----
// accessories: プロンプトFのJSONから得たaccessories配列、view: "front"|"side"|"back"、
// scale: 画像原寸->表示サイズの倍率
function drawAccessoryRegionsPreview(ctx, img, w, h, accessories, view, scale){
  ctx.clearRect(0,0,w,h);
  ctx.drawImage(img, 0,0, w,h);
  (accessories||[]).forEach(function(a){
    var region = a.regions && a.regions[view];
    var pts = region && region.points;
    if(!pts || pts.length<2) return;
    var ptsPx = pts.map(function(p){ return [p[0]*scale, p[1]*scale]; });
    P3D.drawPolygonOutline(ctx, ptsPx, a.color || "#7aa2ff");
  });
}
P3D.scannerDrawAccessoryRegionsPreview = drawAccessoryRegionsPreview;

// ---- 除外マスクの合成(フェーズ6: exclude_from_body_silhouette===trueのみ) ----
// GHOST_SCANNER_PLAN.mdの通り、プロンプトFのregionsを機械的にcanvas上へ赤で
// 塗りつぶし、landmark_tool.htmlのexclude_masks(PNG dataURL)と同じ形にする。
// accessories: exclude_from_body_silhouetteフィールドを含むaccessories配列、
// view: "front"|"side"|"back"、w,h: そのview画像の原寸サイズ
// 戻り値: PNG dataURL、対象accessoryが1つもなければnull
function buildExcludeMaskDataUrl(accessories, view, w, h){
  var targets = (accessories||[]).filter(function(a){
    var region = a.regions && a.regions[view];
    return a.exclude_from_body_silhouette===true && region && region.points && region.points.length>=2;
  });
  if(!targets.length) return null;
  var c = document.createElement("canvas"); c.width=w; c.height=h;
  var ctx = c.getContext("2d");
  ctx.fillStyle = "#ff0000";
  targets.forEach(function(a){
    var pts = a.regions[view].points;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for(var i=1;i<pts.length;i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  });
  return c.toDataURL("image/png");
}
P3D.scannerBuildExcludeMaskDataUrl = buildExcludeMaskDataUrl;

})(window);
