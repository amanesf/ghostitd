// -*- coding: utf-8 -*-
// ランドマークツール(生成ボタン)→ビューアへ生成済みGLBを渡すためのIndexedDB
// ラッパー。ページ遷移をまたいで数MBのバイナリを安全に渡すため
// (sessionStorage/URL経由はサイズ的に不安定なため採用)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};
var DB_NAME="3dtooljs_db", STORE="models", KEY="generated_model", NORMAL_IMAGES_KEY="normal_session_images";

function openDb(){
  return new Promise(function(resolve,reject){
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function(){ req.result.createObjectStore(STORE); };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error); };
  });
}
// ★2026-07-15(ユーザー指摘「1px/1pxにするとビューアが重すぎる、間引き等の
// モデル調整機能はジェネレータに移した方がいい」対応): フェーズ1〜2で採用して
// いた「彫刻直後の生メッシュ+画像一式を渡し、ビューア側でfinishFromIntermediate()
// を呼んでライブに間引き/平滑化/継ぎ目調整する」方式(中間パッケージ)を廃止し、
// 契約を元(2026-07-07以前)の「完成GLBのArrayBuffer」に戻した。間引き等の
// モデル調整パラメータはlandmark_tool.html(ジェネレータ)側に移植済みで、
// 生成ボタンを押した時点でfinishFromIntermediate()まで完了させてから保存する。
// ビューアは完成メッシュを表示するだけになり、生メッシュ・画像一式を保持する
// 必要が無くなった(IndexedDB転送量・ビューア初期化の負荷が大幅に減る)。
// package: {
//   glb: ArrayBuffer,                 // 完成GLB(finishFromIntermediate()の戻り値そのもの)
//   landmarks_json: object,           // buildJson()の戻り値そのもの(「JSON書き出し」用)
//   session_mode, session_sample_id,  // ビューアの「戻る」でジェネレータへ遷移するだけの情報
// }
async function saveGeneratedModel(pkg){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(pkg, KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
async function loadGeneratedModel(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readonly');
    var req = tx.objectStore(STORE).get(KEY);
    req.onsuccess=function(){resolve(req.result||null);};
    req.onerror=function(){reject(req.error);};
  });
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

// ★2026-07-09(UIレビュー): ゴーストスキャナー→ジェネレータの引き継ぎは、
// scanner側がimage.*.dataUrlをJSONに埋め込むようになったため、画像本体を
// 別途Blobとしてこの専用キー(SCANNER_IMAGES_KEY)経由でIndexedDBに保存する
// 仕組みが不要になった(旧saveScannerHandoffImages/loadScannerHandoffImages/
// clearScannerHandoffImages、及びSCANNER_IMAGES_KEY自体を削除した)。
// landmark_tool.html側は「?source=scanner」時にsessionStorageのJSON1つを
// bootstrapFromJson()に渡すだけで画像復元まで完結する。

// ゴーストスキャナー自身の「前回の続きから」用(GHOST_SCANNER_PLAN.md「運用面の
// 修正6点・⑥」)。ジェネレータへの引き継ぎ(2026-07-09以降はJSON埋め込みの
// dataUrl経由、専用のBlob転送キーは廃止済み)とは別に、スキャナー内での
// 作業継続用に画像本体(Blob)を保持する専用キー。
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
