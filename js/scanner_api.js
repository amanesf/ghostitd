// -*- coding: utf-8 -*-
// ゴーストスキャナー(ghost_scanner.html)専用: Gemini API呼び出し層。
// GHOST_SCANNER_PLAN.mdの「実装方針」節の通り、プロンプト構築+fetch+レスポンス
// パース、新規セッション/会話継続の切り替えをすべてこの層に閉じ込める(UI層から
// fetchのURL組み立てや認証ヘッダー等の実装詳細が直接見えないようにするため)。
// 素の<script>読み込み(ESモジュール不使用)、P3D名前空間にぶら下げる既存の慣習に従う。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

// ---- APIキー管理(localStorage) ----
// GHOST_SCANNER_PLAN.md「APIキーの取り扱い」節の通り、コードにキーを埋め込まず、
// 初回起動時の入力欄からlocalStorageに保存して以降自動読込する(GitHubからの
// 自動取得はしない=「鍵を取ってくるための鍵」問題を避ける)。
var API_KEY_STORAGE_KEY = "ghost_scanner_gemini_api_key";
function getApiKey(){
  try{ return localStorage.getItem(API_KEY_STORAGE_KEY) || ""; }catch(e){ return ""; }
}
function setApiKey(key){
  try{ localStorage.setItem(API_KEY_STORAGE_KEY, key||""); }catch(e){ /* 保存失敗時は今回のセッション内のみ有効 */ }
}
function clearApiKey(){
  try{ localStorage.removeItem(API_KEY_STORAGE_KEY); }catch(e){}
}
P3D.getGeminiApiKey = getApiKey;
P3D.setGeminiApiKey = setApiKey;
P3D.clearGeminiApiKey = clearApiKey;

// ---- モデル名 ----
// 画像生成(front/side/back)はgemini-2.5-flash-image、テキスト/JSON推定
// (ランドマーク・パラメータ・アクセサリー)はgemini-2.5-proを使う
// (GHOST_SCANNER_PLAN.mdの指示通り)。
var IMAGE_MODEL = "gemini-2.5-flash-image";
var TEXT_MODEL = "gemini-2.5-pro";
P3D.SCANNER_IMAGE_MODEL = IMAGE_MODEL;
P3D.SCANNER_TEXT_MODEL = TEXT_MODEL;

function apiUrl(model, apiKey){
  // NOTE(不確実要素): generateContentのエンドポイント形式は
  // v1beta/models/{model}:generateContent が現行の一般的な形だが、
  // 実際のレスポンススキーマ(inlineData/candidates[].content.parts等)は
  // 手元でAPIキーを使った実地検証ができていないため、公開ドキュメントの
  // 記述に基づく best-effort の実装。エラー時は本文をそのままUIに出す
  // ようにしてあるので、実運用で形が違えばエラーメッセージから調整できる。
  return "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(apiKey);
}

// dataURL("data:image/png;base64,....") -> {mimeType, data(base64本体のみ)}
function dataUrlToInlinePart(dataUrl){
  var m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl||"");
  if(!m) throw new Error("画像データの形式が不正です(data URLではありません)");
  return { inline_data: { mime_type: m[1], data: m[2] } };
}
P3D.dataUrlToInlinePart = dataUrlToInlinePart;

// history: [{role:"user"|"model", parts:[...]}, ...] (会話継続用、新規セッションなら空配列)
// newParts: 今回のユーザーターンのparts配列(テキスト+画像)
// opts: {responseModalities:["IMAGE"]|["TEXT"], apiKey}
async function callGemini(model, history, newParts, opts){
  opts = opts || {};
  var apiKey = opts.apiKey || getApiKey();
  if(!apiKey) throw new Error("APIキーが設定されていません。先に画面上部でAPIキーを入力してください。");
  var contents = history.concat([{ role: "user", parts: newParts }]);
  var body = { contents: contents };
  if(opts.responseModalities){
    body.generationConfig = { responseModalities: opts.responseModalities };
  }
  var res;
  try{
    res = await fetch(apiUrl(model, apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }catch(e){
    throw new Error("Gemini APIへの通信に失敗しました(ネットワーク/プロキシの問題の可能性があります): " + ((e&&e.message)||e));
  }
  var text = await res.text();
  var json;
  try{ json = JSON.parse(text); }
  catch(e){ throw new Error("Gemini APIのレスポンスがJSONとして解析できませんでした: " + text.slice(0,500)); }
  if(!res.ok){
    var msg = (json && json.error && json.error.message) || text;
    throw new Error("Gemini APIがエラーを返しました(HTTP " + res.status + "): " + msg);
  }
  return json;
}
P3D.callGemini = callGemini;

// レスポンスから最初の候補のpartsを取り出す(画像/テキスト共通)
function firstCandidateParts(json){
  var cand = json && json.candidates && json.candidates[0];
  if(!cand) throw new Error("Gemini APIのレスポンスに候補(candidates)が含まれていませんでした。");
  var parts = cand.content && cand.content.parts;
  if(!parts || !parts.length) throw new Error("Gemini APIのレスポンスに内容(parts)が含まれていませんでした。");
  return parts;
}

// レスポンスparts配列から画像のdata URLを1枚取り出す
function extractImageDataUrl(json){
  var parts = firstCandidateParts(json);
  for(var i=0;i<parts.length;i++){
    var p = parts[i];
    // NOTE(不確実要素): inline_data/inlineDataどちらのキー名で返るか未検証のため両対応
    var inline = p.inline_data || p.inlineData;
    if(inline && inline.data){
      var mime = inline.mime_type || inline.mimeType || "image/png";
      return "data:" + mime + ";base64," + inline.data;
    }
  }
  throw new Error("Gemini APIのレスポンスに画像データが含まれていませんでした(テキストのみが返された可能性があります)。");
}
P3D.extractImageDataUrl = extractImageDataUrl;

// レスポンスparts配列からテキストを連結して取り出す
function extractText(json){
  var parts = firstCandidateParts(json);
  var text = "";
  for(var i=0;i<parts.length;i++){
    if(typeof parts[i].text === "string") text += parts[i].text;
  }
  if(!text) throw new Error("Gemini APIのレスポンスにテキストが含まれていませんでした。");
  return text;
}
P3D.extractText = extractText;

// Geminiはたまに```json ... ```のコードフェンスを付けて返すことがある(プロンプトで
// 明示的に禁止しているが、念のため防御的に剥がしてからJSON.parseする)。
function parseJsonResponse(text){
  var t = text.trim();
  var fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if(fence) t = fence[1];
  return JSON.parse(t);
}
P3D.parseJsonResponse = parseJsonResponse;

// ---- 単一責務の呼び出しヘルパー(層分離: UI側はこれらだけを呼ぶ) ----

// 画像生成(front/side/back): 常に新規セッション(historyなし)。
// promptText: プロンプト全文、refImageDataUrl: 参照画像(元イラスト、またはfront確定画像)
async function generateImage(promptText, refImageDataUrl, apiKey){
  var parts = [ { text: promptText }, dataUrlToInlinePart(refImageDataUrl) ];
  var json = await callGemini(IMAGE_MODEL, [], parts, { apiKey: apiKey, responseModalities: ["IMAGE"] });
  return extractImageDataUrl(json);
}
P3D.scannerGenerateImage = generateImage;

// テキスト/JSON推定(ランドマーク・パラメータ・アクセサリー)の1ターン。
// 会話継続に対応するため、呼び出し元がhistoryを保持し、都度渡す(このツール自体は
// 会話状態を持たない=状態管理はUI層に一元化するというGHOST_SCANNER_PLAN.mdの方針)。
// imageDataUrls: 添付する画像(複数可、プロンプトFはfront/side/back3枚同時)
async function callTextTurn(promptText, imageDataUrls, history, apiKey){
  var parts = [ { text: promptText } ];
  (imageDataUrls||[]).forEach(function(u){ parts.push(dataUrlToInlinePart(u)); });
  var json = await callGemini(TEXT_MODEL, history||[], parts, { apiKey: apiKey });
  var text = extractText(json);
  var newHistory = (history||[]).concat([
    { role: "user", parts: parts },
    { role: "model", parts: [ { text: text } ] }
  ]);
  return { text: text, history: newHistory, raw: json };
}
P3D.scannerCallTextTurn = callTextTurn;

})(window);
