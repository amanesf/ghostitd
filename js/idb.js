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
async function saveGeneratedModel(arrayBuffer){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(arrayBuffer, KEY);
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
})(window);
