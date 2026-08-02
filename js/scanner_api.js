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
// 画像生成(front/side/back)・テキスト/JSON推定(ランドマーク・パラメータ・
// アクセサリー)ともに、既定値はコード更新時点(2026-07-08)の最新安定モデル。
// Geminiのモデルは頻繁に更新されるため、既定値をハードコードしたままにせず
// localStorageで上書きできるようにしてある(下のgetImageModel/getTextModel、
// および画面上の「モデル取得」UIから選択・保存する)。
var DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";
var DEFAULT_TEXT_MODEL = "gemini-3.5-flash";
var IMAGE_MODEL_STORAGE_KEY = "ghost_scanner_image_model";
var TEXT_MODEL_STORAGE_KEY = "ghost_scanner_text_model";

function getImageModel(){
  try{ return localStorage.getItem(IMAGE_MODEL_STORAGE_KEY) || DEFAULT_IMAGE_MODEL; }catch(e){ return DEFAULT_IMAGE_MODEL; }
}
function setImageModel(model){
  try{ localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, model||""); }catch(e){}
}
function getTextModel(){
  try{ return localStorage.getItem(TEXT_MODEL_STORAGE_KEY) || DEFAULT_TEXT_MODEL; }catch(e){ return DEFAULT_TEXT_MODEL; }
}
function setTextModel(model){
  try{ localStorage.setItem(TEXT_MODEL_STORAGE_KEY, model||""); }catch(e){}
}
P3D.SCANNER_DEFAULT_IMAGE_MODEL = DEFAULT_IMAGE_MODEL;
P3D.SCANNER_DEFAULT_TEXT_MODEL = DEFAULT_TEXT_MODEL;
P3D.getScannerImageModel = getImageModel;
P3D.setScannerImageModel = setImageModel;
P3D.getScannerTextModel = getTextModel;
P3D.setScannerTextModel = setTextModel;

// Gemini側のモデル一覧を取得する(models.list)。APIキーが使えるモデル名を
// 画面のプルダウンに反映するために使う。「画像出力対応」を示す明確なフラグは
// レスポンスに無いため、呼び出し元(UI層)でモデル名に"image"を含むかどうか等の
// パターンで画像用/テキスト用を振り分ける。
async function listModels(apiKey){
  apiKey = apiKey || getApiKey();
  if(!apiKey) throw new Error("APIキーが設定されていません。先に画面上部でAPIキーを入力してください。");
  var url = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=" + encodeURIComponent(apiKey);
  var res;
  try{
    res = await fetch(url);
  }catch(e){
    throw new Error("Gemini APIへの通信に失敗しました(ネットワーク/プロキシの問題の可能性があります): " + ((e&&e.message)||e));
  }
  var text = await res.text();
  var json;
  try{ json = JSON.parse(text); }
  catch(e){ throw new Error("Gemini APIのモデル一覧レスポンスがJSONとして解析できませんでした: " + text.slice(0,500)); }
  if(!res.ok){
    var msg = (json && json.error && json.error.message) || text;
    throw new Error("Gemini APIのモデル一覧取得がエラーを返しました(HTTP " + res.status + "): " + msg);
  }
  var models = (json && json.models) || [];
  // "models/gemini-3.1-flash-image" のような形で返るのでプレフィックスを剥がす
  return models.map(function(m){
    return {
      name: (m.name||"").replace(/^models\//, ""),
      displayName: m.displayName || m.name || "",
      supportedGenerationMethods: m.supportedGenerationMethods || []
    };
  }).filter(function(m){ return m.name; });
}
P3D.scannerListModels = listModels;

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
    if(res.status === 429 && /limit:\s*0\b/.test(msg)){
      // "limit: 0" は一時的なレート制限ではなく、そのAPIキーのプロジェクトで
      // このモデルの無料枠が0(=課金設定が必要)であることを示す。しばらく
      // 待っても解消しないため、原因を区別できるメッセージにする。
      msg = "このAPIキーのプロジェクトでは、このモデルの無料利用枠が0に設定されています" +
        "(一時的なレート制限ではありません)。Google AI Studio/Cloudの課金設定を有効にするか、" +
        "別のAPIキーに切り替えてください。元のメッセージ: " + msg;
    }
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
  var json = await callGemini(getImageModel(), [], parts, { apiKey: apiKey, responseModalities: ["IMAGE"] });
  return extractImageDataUrl(json);
}
P3D.scannerGenerateImage = generateImage;

// ★2026-07-09(左右非対称キャラ対応): front→side→leftSide→backを同一
// セッション(会話継続)で生成するための版。callTextTurn(テキスト/JSON推定)と
// 同じ「呼び出し元がhistoryを保持し、都度渡す」方針をそのまま画像生成にも
// 適用する。新規セッションを都度張り直すと、キャラクターの左右非対称な
// 特徴(例: 左だけ・右だけに付いた房のツインテール)の割り当てがビューごとに
// ブレる(生成のたびに左右が入れ替わる等)ことが実地で確認されたため。
// 応答の画像そのものをmodelターンとしてhistoryに積むことで、次のターンで
// Geminiが「直前に自分が生成した画像」を参照できるようにする(refImageDataUrl
// も併せて明示的に添付し続けるのは、会話内画像参照だけに頼るより安定させるため)。
async function generateImageInSession(promptText, refImageDataUrl, history, apiKey){
  var parts = [ { text: promptText }, dataUrlToInlinePart(refImageDataUrl) ];
  var json = await callGemini(getImageModel(), history||[], parts, { apiKey: apiKey, responseModalities: ["IMAGE"] });
  var dataUrl = extractImageDataUrl(json);
  var newHistory = (history||[]).concat([
    { role: "user", parts: parts },
    { role: "model", parts: [ dataUrlToInlinePart(dataUrl) ] }
  ]);
  return { dataUrl: dataUrl, history: newHistory, raw: json };
}
P3D.scannerGenerateImageInSession = generateImageInSession;

// テキスト/JSON推定(ランドマーク・パラメータ・アクセサリー)の1ターン。
// 会話継続に対応するため、呼び出し元がhistoryを保持し、都度渡す(このツール自体は
// 会話状態を持たない=状態管理はUI層に一元化するというGHOST_SCANNER_PLAN.mdの方針)。
// imageDataUrls: 添付する画像(複数可、プロンプトFはfront/side/back3枚同時)
async function callTextTurn(promptText, imageDataUrls, history, apiKey){
  var parts = [ { text: promptText } ];
  (imageDataUrls||[]).forEach(function(u){ parts.push(dataUrlToInlinePart(u)); });
  var json = await callGemini(getTextModel(), history||[], parts, { apiKey: apiKey });
  var text = extractText(json);
  var newHistory = (history||[]).concat([
    { role: "user", parts: parts },
    { role: "model", parts: [ { text: text } ] }
  ]);
  return { text: text, history: newHistory, raw: json };
}
P3D.scannerCallTextTurn = callTextTurn;

// ---- 色分けマップ生成プロンプト(GHOST_SCANNER_PLAN.md「色分けマップ」方式) ----
// accessory一覧(名前・パレット色・判定理由)から動的にテーブルを組み立てる。
// front/side/leftSide/backそれぞれ1回のAPI呼び出しを行う。
// ★2026-07-09: 以前は判断基準・塗り分けルール自体がviewに依存しないという
// 理由でview非依存の共通テキスト1つを使い回していたが、(1)ユーザーから
// 「面ごとに別々に確認・コピーしたい」との要望があったこと、(2)view非依存の
// 文面のままだと「添付画像はfront/side/backのいずれか」という曖昧な書き方に
// なり、実際にどの面を処理しているのかがGeminiにも読み手にも伝わりにくかった
// こと、の2点から、view引数を受け取って冒頭の説明文をその面向けに書き換える
// ようにした(判断基準・塗り分けルール自体の内容は変えていない)。
// accessories: [{name,color,reason}, ...](タブ6-1で確定済みの一覧、colorは"#rrggbb"、
// reasonはPROMPT_Fで「なぜaccessoryと判断したか+体のどこを指すか」を具体的に
// 書かせたもの。この会話(色分けマップ生成)はPROMPT_F検出時の会話履歴を
// 引き継がない新規セッションなので、reasonと下記「参考」節でPROMPT_F相当の
// 判断基準を都度渡し直すことで、検出時と同じ考え方で境界を塗らせる)。
// view: "front"|"side"|"leftSide"|"back"(省略可、既定は旧来通りの曖昧な表現)
var COLORMAP_VIEW_LABEL = {front:"正面(front)", side:"側面・右(side)", leftSide:"側面・左(leftSide)", back:"背面(back)"};
function buildColormapPrompt(accessories, view){
  var rows = (accessories||[]).map(function(a){
    var reason = a.reason ? "(判定理由: " + a.reason + ")" : "";
    return "- " + a.name + reason + " → " + (a.color || "#000000");
  }).join("\n");
  var viewDesc = view && COLORMAP_VIEW_LABEL[view]
    ? "添付画像は、あるキャラクターのTポーズ立ち絵の**"+COLORMAP_VIEW_LABEL[view]+"**です。"
    : "添付画像は、あるキャラクターのTポーズ立ち絵です(front/side/backのいずれか。";
  var viewDescTail = view && COLORMAP_VIEW_LABEL[view]
    ? "この画像を、以下の指示に\n"
    : "どの面でも判断基準・塗り分けルールは共通です)。この画像を、以下の指示に\n";
  return "これは、事前に別の作業でこの画像と同一キャラクターのfront/side/leftSide/back\n"+
"立ち絵から検出したアクセサリー一覧を、この画像上で色分けマップとして\n"+
"塗り分ける作業です(この会話には検出時の判断過程は引き継がれていないため、\n"+
"以下の参考情報・各アクセサリーの判定理由を手がかりに判断してください)。\n\n"+
"## 参考: アクセサリー検出時に使った判断基準\n"+
"- body(通常人体)とaccessoryの区別: その部分を取り除いたときに、下の体の\n"+
"  シルエットが単純な円柱/紡錘形に近い形で残るかどうかで判断しています\n"+
"  (残らない=体の輪郭からはみ出るものがaccessory)。体に密着して輪郭に沿う\n"+
"  服(通常のシャツ・ズボン・靴等)はbody(黒塗り)として扱ってください\n"+
"- 髪は基本的に房(ふさ)ごとに独立したaccessoryとして分割しています。頭部に\n"+
"  密着する前髪・後ろ髪は、頭頂(前から見た頭部シルエットの最も高い点)を\n"+
"  基準に前後に機械的に分割しており、頭頂そのものは前髪側に含まれます。\n"+
"  ツインテール・お団子・三つ編み・アホ毛等、頭部から独立して垂れ下がる房は\n"+
"  この前後分割とは別に、房ごとに個別のaccessoryとして扱っています\n\n"+
viewDesc+viewDescTail+
"従って**色分けマップ**(ベタ塗りの領域分割図)に編集してください。線画・\n"+
"グラデーション・影は一切残さず、指定した色の平坦な塗りつぶしだけで\n"+
"構成してください。\n\n"+
"## 塗り分けルール\n"+
"1. **背景**: 白(#FFFFFF)\n"+
"2. **体そのもの**(肌、および体に密着してその輪郭に沿う衣服。下記の\n"+
"   アクセサリー一覧に含まれない全ての部分): 黒(#000000)\n"+
"3. **各アクセサリー**: 以下の一覧の名前・判定理由ごとに、対応する色でベタ塗り\n"+
(rows || "   (アクセサリーの指定はありません)") + "\n\n"+
"## 注意点\n"+
"- 各領域の境界は明瞭に(アンチエイリアスによる中間色のにじみを最小限に)\n"+
"- あるアクセサリーが体や他のアクセサリーの前後に重なって一部隠れている\n"+
"  場合も、実際に見えている部分だけをそのアクセサリーの色で塗ってください\n"+
"  (隠れて見えない部分は無理に推測して塗らない)\n"+
"- この画像に写っていないアクセサリーは無視してください(一覧はfront/side/\n"+
"  leftSide/back共通ですが、面によっては一部のアクセサリーが写っていない\n"+
"  ことがあります)\n"+
"- キャラクターの輪郭・ポーズ・構図(位置・大きさ)は元画像から変更しない\n"+
"  でください(色分けマップとして領域抽出に使うため、位置がずれると\n"+
"  マスクが元画像とずれてしまいます)\n\n"+
"出力は画像のみとしてください。";
}
P3D.scannerBuildColormapPrompt = buildColormapPrompt;

})(window);
