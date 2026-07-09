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
// 戻り値: {canvas, dataUrl, scale, ox, oy, size}(scale/ox/oyは呼び出し元が
// 座標を実寸に逆変換する際に使う。詳細はscannerBuildDetectionCopy参照)。
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
  return { canvas:c, dataUrl:c.toDataURL("image/png"), scale:scale, ox:ox, oy:oy, size:size };
}
P3D.scannerResizeImageToSquare = resizeImageToSquare;

// ---- 検出専用の正方形レターボックスコピー(座標系の自己申告依存を廃止) ----
// Geminiにランドマーク/アクセサリー領域を尋ねる際、「画像サイズを自己申告
// させてそれを信用する」(旧rescalePointsToNaturalSize方式)は自己申告と
// 実際の画像サイズが食い違うことがあり、ズレの主因になっていた。
// 代わりに、こちらで確実に size×size(既定1000×1000)にレターボックス
// リサイズしたコピーを作って送り、「このN×Nピクセル座標で答えよ」と
// 指示する(Geminiが正規化0〜1000座標で検出タスクを学習している慣習にも
// 合わせられる)。返ってきた座標は、このリサイズ情報(scale/ox/oy)を使って
// 決定論的に実寸へ逆変換できる(自己申告を一切信用しない)。
// 戻り値: {dataUrl, resize:{scale, ox, oy, size}}
async function buildDetectionCopy(sourceDataUrl, size){
  var img = await loadImageFromSrc(sourceDataUrl);
  var r = resizeImageToSquare(img, size||1000);
  return { dataUrl:r.dataUrl, resize:{ scale:r.scale, ox:r.ox, oy:r.oy, size:r.size } };
}
P3D.scannerBuildDetectionCopy = buildDetectionCopy;

// 検出コピー上の座標(pt:{x,y})を、リサイズ情報を使って元画像の実寸座標に戻す。
function detectionPointToNatural(pt, resize){
  return { x:(pt.x-resize.ox)/resize.scale, y:(pt.y-resize.oy)/resize.scale };
}
P3D.scannerDetectionPointToNatural = detectionPointToNatural;

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

// ★2026-07-09: 除外マスク(exclude_masks)合成用のbuildExcludeMaskDataUrl()は
// js/common.js のP3D.buildExcludeMaskDataUrlへ移した(マスク抽出処理自体が
// ghost_scanner.htmlからlandmark_tool.htmlへ移り、両ツールで使う共通
// ユーティリティになったため)。

})(window);
