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
const EXPECTED_BODY_ONLY = {
  byteLength: 470800,
  sha256: "fca0d04fb57f7b02f16ac368f858f0ff68d0cfcf413aec5490f95f9cf9816bff",
};
// ★2026-07-10バグ修正: bleedEdges(縁の色にじみ)が体(alphaFull)だけを前景と
// みなし、スカート/マフラー/髪等のアクセサリー領域(体とは別の色分けマップ色)
// を「背景」として周囲の色で上書きしていたため、アクセサリーの実際の絵柄が
// 消えて縞状に破綻していた(js/pipeline.js参照)。bleedの前景判定を「体∪全
// アクセサリー」の和集合に修正したことでwith-accessory側のテクスチャ焼き込み
// 結果が変わるため、ハッシュを更新した(body-onlyはアクセサリーが無いため
// 影響を受けず不変)。
const EXPECTED_WITH_ACCESSORY = {
  byteLength: 865844,
  sha256: "bf2b9ef04cbd372934512f85d17ee986f4a048491a7e9a2b496f6138ec250c9a",
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
