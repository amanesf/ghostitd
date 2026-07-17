// -*- coding: utf-8 -*-
// ランドマークツール(生成ボタン)→ビューアへ生成済みGLBを渡すためのIndexedDB
// ラッパー。ページ遷移をまたいで数MBのバイナリを安全に渡すため
// (sessionStorage/URL経由はサイズ的に不安定なため採用)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};
var DB_NAME="3dtooljs_db", STORE="models", KEY="generated_model", NORMAL_IMAGES_KEY="normal_session_images";
// ゴーストスキャナー(ghost_scanner.html)→ジェネレータ(landmark_tool.html)の
// 引き継ぎ専用キー。GHOST_SCANNER_PLAN.mdの「ジェネレータへの引き継ぎ」節の通り、
// KEY(generated_model)は「彫刻後の中間パッケージ」専用に契約変更済みで流用できず、
// NORMAL_IMAGES_KEYは「前回の続き」機能が読み書きする専用キーのため、それらと
// 混ざらないよう別キーに分離する(データ形式自体はNORMAL_IMAGES_KEYと同じ
// {front,side,back}のBlob)。
var SCANNER_IMAGES_KEY="scanner_handoff_images";

function openDb(){
  return new Promise(function(resolve,reject){
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function(){ req.result.createObjectStore(STORE); };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error); };
  });
}
// ★フェーズ1(2026-07-07〜): 契約を「完成GLBのArrayBuffer」から「中間パッケージ」
// (元landmarks_ai.json全体+彫刻直後の生メッシュ+prep/bleed済み画像+骨格ピボット)
// に変更した(破壊的変更。character_3d.html側もpackage形式を前提に読む)。
// canvas要素はstructured cloneできないため、保存時にBlob(toBlob)へ変換して
// {width,height,blob}の形でIndexedDBへ入れる。読み込み側(loadGeneratedModel)
// はBlobから元のHTMLCanvasElementを復元してから返す。
// package: {
//   landmarks_json: object,           // buildJson()の戻り値そのもの(元JSON全体)
//   raw_body: {V:Float32Array, F:Uint32Array},
//   raw_accessories: [{name,mode,bones,V:Float32Array,F:Uint32Array}, ...],
//   bled_canvases: {front,back,side}, // 保存時はHTMLCanvasElement、読み込み後もHTMLCanvasElementに復元
//   pivots: object,
//   calib: {SCALE,CX,YBOT,SYTOP,SYBOT,SIDE_REF},
//   gen_params, seam_angles, seam_no_side, seam_smooth_iters, color_grad_width,
// }
function canvasToBlobEntry(canvas){
  return new Promise(function(resolve,reject){
    canvas.toBlob(function(blob){
      if(!blob){ reject(new Error("canvas.toBlobに失敗しました")); return; }
      resolve({width:canvas.width, height:canvas.height, blob:blob});
    }, "image/png");
  });
}
function blobEntryToCanvas(entry){
  return new Promise(function(resolve,reject){
    var img = new Image();
    img.onload=function(){
      var c=document.createElement("canvas"); c.width=entry.width; c.height=entry.height;
      c.getContext("2d").drawImage(img,0,0);
      resolve(c);
    };
    img.onerror=function(e){ reject(e); };
    img.src = URL.createObjectURL(entry.blob);
  });
}
async function saveGeneratedModel(pkg){
  var bled = {};
  for(var v of ["front","side","back"]){
    if(pkg.bled_canvases && pkg.bled_canvases[v]) bled[v] = await canvasToBlobEntry(pkg.bled_canvases[v]);
  }
  var toStore = Object.assign({}, pkg, {bled_canvases: bled});
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(toStore, KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
async function loadGeneratedModel(){
  var db = await openDb();
  var raw = await new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readonly');
    var req = tx.objectStore(STORE).get(KEY);
    req.onsuccess=function(){resolve(req.result||null);};
    req.onerror=function(){reject(req.error);};
  });
  if(!raw) return null;
  var bled = {};
  for(var v of ["front","side","back"]){
    if(raw.bled_canvases && raw.bled_canvases[v]) bled[v] = await blobEntryToCanvas(raw.bled_canvases[v]);
  }
  return Object.assign({}, raw, {bled_canvases: bled});
}
async function clearGeneratedModel(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
P3D.saveGeneratedModel=saveGeneratedModel;
P3D.loadGeneratedModel=loadGeneratedModel;
P3D.clearGeneratedModel=clearGeneratedModel;

// 「前回の続き」(通常モードのみ)用の画像本体保存。サンプルモードは常に
// 同梱画像から新規に読み込む決定的な状態なので、ここには一切書き込まない
// (サンプル/通常が保存を共有して混ざらないようにするため、キーを分けている)。
async function saveNormalSessionImages(blobs){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(blobs, NORMAL_IMAGES_KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
async function loadNormalSessionImages(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readonly');
    var req = tx.objectStore(STORE).get(NORMAL_IMAGES_KEY);
    req.onsuccess=function(){resolve(req.result||null);};
    req.onerror=function(){reject(req.error);};
  });
}
P3D.saveNormalSessionImages=saveNormalSessionImages;
P3D.loadNormalSessionImages=loadNormalSessionImages;

// ゴーストスキャナー→ジェネレータの引き継ぎ用(前述の通りKEY/NORMAL_IMAGES_KEYとは
// 別キー)。保存/読込のたびに使い切りとして扱う(読込側でclearScannerHandoffImages
// を呼んで消費する想定。landmark_tool.html側の「?source=scanner」分岐が呼ぶ)。
async function saveScannerHandoffImages(blobs){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(blobs, SCANNER_IMAGES_KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
async function loadScannerHandoffImages(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readonly');
    var req = tx.objectStore(STORE).get(SCANNER_IMAGES_KEY);
    req.onsuccess=function(){resolve(req.result||null);};
    req.onerror=function(){reject(req.error);};
  });
}
async function clearScannerHandoffImages(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).delete(SCANNER_IMAGES_KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
P3D.saveScannerHandoffImages=saveScannerHandoffImages;
P3D.loadScannerHandoffImages=loadScannerHandoffImages;
P3D.clearScannerHandoffImages=clearScannerHandoffImages;

// ゴーストスキャナー自身の「前回の続きから」用(GHOST_SCANNER_PLAN.md「運用面の
// 修正6点・⑥」)。SCANNER_IMAGES_KEY(ジェネレータへの引き継ぎ、使い切り)とは
// 別に、スキャナー内での作業継続用に画像本体(Blob)を保持する専用キー。
// 有料/時間のかかるAPI呼び出しの結果(元画像・front/side/back生成画像・
// 色分けマップ画像)のみを対象にし、そこから無料で再抽出できるマスクは
// 対象外にする(保存対象を絞ることでBlob管理の複雑さを抑える設計)。
var SCANNER_SESSION_IMAGES_KEY="scanner_session_images";
async function saveScannerSessionImages(blobs){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(blobs, SCANNER_SESSION_IMAGES_KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
async function loadScannerSessionImages(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readonly');
    var req = tx.objectStore(STORE).get(SCANNER_SESSION_IMAGES_KEY);
    req.onsuccess=function(){resolve(req.result||null);};
    req.onerror=function(){reject(req.error);};
  });
}
async function clearScannerSessionImages(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).delete(SCANNER_SESSION_IMAGES_KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
P3D.saveScannerSessionImages=saveScannerSessionImages;
P3D.loadScannerSessionImages=loadScannerSessionImages;
P3D.clearScannerSessionImages=clearScannerSessionImages;
})(window);
