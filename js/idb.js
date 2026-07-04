// -*- coding: utf-8 -*-
// ランドマークツール(生成ボタン)→ビューアへ生成済みGLBを渡すためのIndexedDB
// ラッパー。ページ遷移をまたいで数MBのバイナリを安全に渡すため
// (sessionStorage/URL経由はサイズ的に不安定なため採用)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};
var DB_NAME="3dtooljs_db", STORE="models", KEY="generated_model", IMAGES_KEY="session_images";

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

// ランドマークツール往復時、サンプル/通常どちらのモードで読み込んだ画像でも
// 復元できるように、front/side/backのBlobをまとめて保存する
// (localStorageはサイズが不安なため、画像本体はIndexedDBに置く。
// セッションJSON(landmarks_ai.json相当、小さい)はlocalStorageのまま)。
async function saveSessionImages(blobs){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readwrite');
    tx.objectStore(STORE).put(blobs, IMAGES_KEY);
    tx.oncomplete=function(){resolve();};
    tx.onerror=function(){reject(tx.error);};
  });
}
async function loadSessionImages(){
  var db = await openDb();
  return new Promise(function(resolve,reject){
    var tx = db.transaction(STORE,'readonly');
    var req = tx.objectStore(STORE).get(IMAGES_KEY);
    req.onsuccess=function(){resolve(req.result||null);};
    req.onerror=function(){reject(req.error);};
  });
}
P3D.saveSessionImages=saveSessionImages;
P3D.loadSessionImages=loadSessionImages;
})(window);
