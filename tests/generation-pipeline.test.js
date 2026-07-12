// -*- coding: utf-8 -*-
// 生成パイプライン(js/pipeline.js, carving.js, skeleton.js, atlas.js,
// accessories.js, visual_hull.js, marching_cubes.js)の回帰検知テスト。
//
// ★これは「golden master」テストです。同梱サンプル(landmarks_ai_2_embedded.json、
// front/side/back画像込み)から生成したGLBのSHA-256ハッシュを固定値と比較し、
// 1バイトでも変わったら失敗させる。彫刻・スキニングのアルゴリズムは
// 数式が複雑で自動テストの無いプロジェクトのため、「意図しない変更が
// 無いこと」を機械的に検知するのが目的。
//
// ★2026-07-09: 多角形(手動パーツ)アクセサリー機能廃止に伴い、サンプル1
// (images/+landmarks_ai.json、多角形形式)を削除し、唯一のサンプルである
// サンプル2(マスク形式、アクセサリー7点内蔵)を使うよう作り直した。同日中に
// front/side/back画像もJSONへ埋め込む形式に統一し、images2/*.png+
// landmarks_ai_2.jsonの2ファイル構成をlandmarks_ai_2_embedded.json単体に
// まとめた。「body-only」の生成経路も引き続き検証するため、サンプル2の
// JSONをそのまま使う代わりに、テスト内でaccessoriesを空にした一時JSONを
// 組み立てて「JSON読み込み」機能経由で読み込ませている(手動でアクセサリーを
// 追加するUI(旧「パーツ＋」タブ)は廃止済みのため)。
// ★2026-07-09(同日中に再更新): 全身のシルエットも色分けマップ+色許容誤差
// 方式に統一したため、サンプルをcolormaps(front/side/leftSide/back)込みの
// 新形式に作り直した(旧形式=colormapsを持たないJSONのサポートは廃止)。
// アクセサリーの色もcolormaps上の実際の配色に合わせて再設定した。
//
// 生成結果を意図的に変える変更(例: 彫刻アルゴリズムの改善、パラメータ
// 既定値の変更)をした場合は、このテストが失敗するのが正しい挙動です。
// その場合はテスト実行時に表示される新しいハッシュ値でEXPECTED_*を
// 更新してください(下の値を書き換えるだけ)。
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");
const { startServer, openPage, REPO_ROOT } = require("./lib/testkit");

// ★2026-07-10: ジェネレータに側面画像のテクスチャ利用設定UIを復活させ、
// 既定値を「側面画像を使わない」に変更した(従来はUIが無い間、暗黙的に
// 「全パーツ側面を使う」がデフォルト挙動だった)。この既定値変更で継ぎ目
// テクスチャの焼き込み結果が変わるため、ハッシュを更新した。
// ★2026-07-11(顔の立体感対応、鼻の突起案からの再検討): 当初は鼻先landmarkに
// 加算式の突起(applyNoseBump)を実装したが、鼻は顔の中心線上にありside画像の
// 行スキャンから既に実測の奥行きが出ているため、独自パラメータの突起を足すと
// 実測の側面イラストと食い違ってしまうと判明し撤回した(ユーザー指摘)。
// 代わりに、front/back/sideどのシルエット輪郭にも現れない内部形状である
// 目窩(eye_L/eye_R landmark中心の凹み、js/carving.jsのapplyEyeSocketRecess)
// を彫るようにした。body-only/with-accessoryとも彫刻結果(=GLB)が変わり、
// ハッシュを更新した。
// ★2026-07-11(パーツ分割タイミングの是正): 体+全アクセサリーを彫刻直後に
// 分割し、間引き・平滑化をパーツごとに独立して行っていたことが、境界を
// 共有する頂点が両側で別々に動いて隙間になる根本原因と判明した(ユーザー
// 指摘)。間引き・平滑化を統合されたままの1枚のメッシュに対して1回だけ
// 行い、スキニング直前にだけパーツへ分割するよう変更した(js/pipeline.js
// のdecimateStage/meshFinishStage、js/carving.jsのdecimateMesh/
// splitMeshByOwner参照)。これに伴い、パーツ別だった間引き目標頂点数
// (body_target_verts/acc_target_verts)を1本(target_verts)に統合した
// ため、サンプルの埋め込みgen_params(古いbody_target_verts:3000)が
// 効かなくなり、新しい既定値(target_verts:10000)が使われるようになった
// (=間引きが弱まり高精細になった)。body-only/with-accessoryとも彫刻
// 結果(=GLB)が変わり、ハッシュを更新した。
// ★2026-07-11(切り抜き精度向上): 色分けマップの体色/アクセサリー色をそれぞれ
// 独立に固定色許容誤差(tolerance)で判定していた方式(P3D.colorRegionRawMask/
// loadAlphaFromColormap/extractMaskFromColormap、body_color_tolerance/
// colorTolerance)を、体+全アクセサリー色+背景を候補とした最近傍色分類
// (P3D.classifySilhouetteRaw)に置き換えた(js/common.js/js/pipeline.js参照)。
// あわせて、その分類境界のアンチエイリアス帯をサブピクセル補間する仕組み
// (P3D.boundaryContForCandidate、gen_params.subpixel_edges)を追加し、体の
// 行スキャン(front/back/side)に適用した。どちらも彫刻の入力(輪郭の位置)が
// 変わるため、body-only/with-accessoryとも彫刻結果(=GLB)が変わり、ハッシュを
// 更新した。
// ★2026-07-11(にじみの起点修正): bleedEdges(縁の色にじみ)が輪郭ぎりぎりの
// 画素(元イラストの黒い縁取りストロークになりがち)を起点に外側へにじませて
// いたため、縁取りが太って見える問題があった。gen_params.bleed_inset_px分
// だけ内側の「安全な内部色」を起点にするよう変更した(js/common.jsの
// bleedEdges参照)。テクスチャの焼き込み結果が変わるため、ハッシュを更新した。
// ★2026-07-11(ユーザー指摘対応、追加3点): (1) bleedEdges侵食(bleedInsetPx)が
// 髪の房の毛先等alpha幅の細い部位を完全に消してしまい、その部位のにじみ起点が
// 無関係な別部位の色に飛んで「パーツごとに扱いが違って見える」不具合があった。
// alpha連結成分ごとに、侵食後シードが0個の成分だけ侵食前のalphaへフォール
// バックする修正(js/common.jsのrestoreErodedThinComponents)を追加。
// (2) 顔・前髪の丸みを「かなり四角形寄り」にしたいとの指摘を受け、
// psq_head(5→6、上限値)・psq_acc(2.2→5、全アクセサリー共通)を引き上げた。
// あわせてサンプルJSON(landmarks_ai_2_embedded.json)に古いpsq_head:2/
// psq_acc:2.2が埋め込み保存されており新しい既定値が反映されない状態だった
// ため、サンプル側も新しい既定値に合わせて更新した。
// (3) 耳の位置に穴が空いているように見えるとの指摘を受けGLBの頂点/面データを
// 直接解析したが、実際の位相的な穴(1個の三角形にしか使われない境界辺)は
// ゼロ件(UVシーム分割による見かけ上の「境界」を頂点座標でマージして除外した
// 上での結果)で、耳専用のcarving機能自体が存在しないことも確認した(コード上の
// バグではなく、ジオメトリ自体は閉じている)。
// 上記3点の彫刻結果・テクスチャ焼き込み結果が変わるため、body-only/
// with-accessoryともハッシュを更新した。
// ★2026-07-12(ユーザー指摘「房が分かれているところの顔が切り抜けてない」
// 対応、側面切り抜き精度): js/carving.jsのbuildDepthByRow()は、1行内にside
// 画像上のrunが複数あっても常に前端〜後端をまるごと包む1本の奥行き区間に
// 合成していた(2026-07-04、顎先が首との間の隙間で分断されて消える不具合の
// 対策として導入)。これが、前髪の房のように奥行き方向で本来別々の物体
// (房が手前、顔がその奥に覗く)まで1枚の奥行きスラブへ均してしまい、房と
// 顔が癒着して見える原因になっていた。行内のrunどうしのpx間隔だけで判定
// (新設のdepth_gap_close_px、既定6px)し、間隔がこの値以下のrunだけ従来通り
// 1本にまとめ、間隔が大きいrunは別々の奥行き区間として保持するよう変更した
// (connected-component分析は「同じ1つの連結成分内の凹み」まで区別できず
// 効かなかったため不採用、詳細はjs/carving.jsのコメント参照)。体単体でも
// 該当行があり彫刻結果が変わるため、body-only/with-accessoryともハッシュを
// 更新した。
const EXPECTED_BODY_ONLY = {
  byteLength: 653052,
  sha256: "b5219a2f5c1e4a53b08124ccbd76b181ba6a2eacaa7a4f1794a804994438abf1",
};
// ★2026-07-10バグ修正: bleedEdges(縁の色にじみ)が体(alphaFull)だけを前景と
// みなし、スカート/マフラー/髪等のアクセサリー領域(体とは別の色分けマップ色)
// を「背景」として周囲の色で上書きしていたため、アクセサリーの実際の絵柄が
// 消えて縞状に破綻していた(js/pipeline.js参照)。bleedの前景判定を「体∪全
// アクセサリー」の和集合に修正したことでwith-accessory側のテクスチャ焼き込み
// 結果が変わるため、ハッシュを更新した(body-onlyはアクセサリーが無いため
// 影響を受けず不変)。
// ★2026-07-10(彫刻方式の刷新): 体+全アクセサリーを別々のグリッドで独立に
// 彫っていた方式を、1つの共有グリッドへ蓄積してから1回だけmarching cubes
// する統合彫刻方式に置き換えた(パーツ間の隙間の解消が目的、js/pipeline.js
// のrunCarvingStages参照)。あわせて前髪等のtrack判定を行→行の距離ベース
// 貪欲マッチングから連結成分ラベリングに置き換えた(房の交差による誤結合の
// 解消が目的、js/carving.js参照)。with-accessory側はアクセサリー(前髪等)
// を含むため彫刻結果が変わり、ハッシュを更新した(body-onlyはアクセサリーが
// 無く、統合しても体単体と同じ結果になるため不変)。
// ★2026-07-10(境界ギャップ埋め): 統合彫刻を入れてもなお隙間が残るとの
// ユーザー指摘を受け再調査した結果、色分けマップの体色/アクセサリー色の
// 境界に数px〜十数px幅の陰影があり、どちらの色許容誤差判定にも入らない
// 実データの穴(彫刻の入力自体に隙間)になっていたことが判明した
// (js/common.jsのP3D.fillColorGaps参照)。2つの確定領域に挟まれた未確定
// 画素だけを最近傍色で埋める修正によりwith-accessory側の彫刻結果が変わり、
// ハッシュを更新した(body-onlyはアクセサリーが無く対象外のため不変)。
// ★2026-07-11: 上記(切り抜き精度向上/にじみの起点修正)と同じ変更により
// with-accessory側も彫刻結果・テクスチャ焼き込み結果が変わり、ハッシュを
// 更新した。
// ★2026-07-11(ユーザー指摘対応、追加3点): 上のEXPECTED_BODY_ONLYコメント
// (bleedEdges細部位フォールバック/psq_head・psq_acc引き上げ/サンプルJSON
// 側のpsq更新/耳の穴の有無を実データで確認)と同じ変更により、with-accessory
// 側も彫刻結果・テクスチャ焼き込み結果が変わり、ハッシュを更新した。
// ★2026-07-11バグ修正(退行、重要): 最近傍色分類への置き換え(2026-07-11の
// 「切り抜き精度向上」コミット)時、bleedFgAlpha(にじみの前景判定を「体∪全
// アクセサリー」の和集合にする2026-07-10の修正)が必要とするa.mask[v].alpha
// (マスクPNGから読み込んだ実データ)を早期にロードしていたearlyMaskLoads
// ブロックを、旧・境界ギャップ埋め(fillColorGaps)専用の処理と誤認して丸ごと
// 削除してしまっていた。この結果bleedFgAlphaのforEachループが常にm.alpha
// 未ロードで素通りし、体以外(スカート/マフラー等)が全く前景とみなされず、
// 2026-07-10に一度直したはずの「アクセサリーが周囲の体色のにじみで塗り
// 潰される」不具合が退行していた(ユーザー指摘「スカートが上着や太もも
// のにじみで消えてしまう」により発覚。git bisectで2026-07-11の切り抜き
// 精度向上コミットが原因と特定)。bleedFgAlpha計算の直前に必要な分だけ
// 早期ロードを復元した(js/pipeline.js参照)。with-accessory側のテクスチャ
// 焼き込み結果が大きく変わるため、ハッシュを更新した(body-onlyはアクセサ
// リーが無く対象外のため不変)。
const EXPECTED_WITH_ACCESSORY = {
  byteLength: 866496,
  sha256: "19f40910adc9fbbff05b883f5014ceed2faa7873f71c908ebcf0c172b5c20a63",
};

async function generateAndExportGlb(server, browser, bodyOnly) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForTimeout(1500);

  if (bodyOnly) {
    // サンプル2のJSONからaccessoriesだけを空にした一時JSONを作り、
    // 「JSON読み込み」機能経由で読み込ませる(画像は先に読み込み済みのものを使う。
    // このJSONにも画像dataUrlは含まれるが、既にpointsがある=編集画面に入って
    // からの読み込みなのでapplyLoadedJson()の差し替え経路のみが働き、画像
    // dataUrl自体は参照されない)。
    const srcJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "landmarks_ai_2_embedded.json"), "utf8"));
    srcJson.accessories = [];
    const tmpPath = path.join(os.tmpdir(), "landmarks_ai_2_body_only_" + Date.now() + ".json");
    fs.writeFileSync(tmpPath, JSON.stringify(srcJson));
    await page.click('.tabbtn[data-tab="gen"]');
    await page.waitForTimeout(200);
    await page.setInputFiles("#jsonFile", tmpPath);
    await page.waitForTimeout(500);
    fs.unlinkSync(tmpPath);
  }

  await page.click('.tabbtn[data-tab="gen"]');
  await page.waitForTimeout(200);
  await page.click("#generateBtn");
  await page.waitForURL("**/character_3d.html*", { timeout: 60000 });

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(5000);
    const txt = await page.$eval("#err", (el) => el.textContent).catch(() => "(err)");
    if (txt === "") break;
  }

  await page.click("#barToggle");
  await page.waitForTimeout(150);
  await page.click("#genTabBtn");
  await page.waitForTimeout(300);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportGlbBtn"),
  ]);
  const streamPath = await download.path();
  const buf = require("fs").readFileSync(streamPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  assert.deepStrictEqual(errors, [], "generation produced console/page errors: " + JSON.stringify(errors));
  await page.close();
  return { byteLength: buf.length, sha256 };
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const bodyOnly = await generateAndExportGlb(server, browser, true);
    assert.strictEqual(bodyOnly.byteLength, EXPECTED_BODY_ONLY.byteLength,
      "body-only GLB byteLength changed: " + bodyOnly.byteLength + " (expected " + EXPECTED_BODY_ONLY.byteLength + ")");
    assert.strictEqual(bodyOnly.sha256, EXPECTED_BODY_ONLY.sha256,
      "body-only GLB sha256 changed: " + bodyOnly.sha256 + " (expected " + EXPECTED_BODY_ONLY.sha256 + ") -- if this change was intentional, update EXPECTED_BODY_ONLY in this file");

    const withAccessory = await generateAndExportGlb(server, browser, false);
    assert.strictEqual(withAccessory.byteLength, EXPECTED_WITH_ACCESSORY.byteLength,
      "with-accessory GLB byteLength changed: " + withAccessory.byteLength + " (expected " + EXPECTED_WITH_ACCESSORY.byteLength + ")");
    assert.strictEqual(withAccessory.sha256, EXPECTED_WITH_ACCESSORY.sha256,
      "with-accessory GLB sha256 changed: " + withAccessory.sha256 + " (expected " + EXPECTED_WITH_ACCESSORY.sha256 + ") -- if this change was intentional, update EXPECTED_WITH_ACCESSORY in this file");
  } finally {
    await browser.close();
    await server.close();
  }
}

module.exports = { name: "generation-pipeline (golden hash)", run };
