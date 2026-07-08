// -*- coding: utf-8 -*-
// 生成パイプライン(js/pipeline.js, carving.js, skeleton.js, atlas.js,
// accessories.js, visual_hull.js, marching_cubes.js)の回帰検知テスト。
//
// ★これは「golden master」テストです。同梱サンプル(images2/*.png +
// landmarks_ai_2.json)から生成したGLBのSHA-256ハッシュを固定値と比較し、
// 1バイトでも変わったら失敗させる。彫刻・スキニングのアルゴリズムは
// 数式が複雑で自動テストの無いプロジェクトのため、「意図しない変更が
// 無いこと」を機械的に検知するのが目的。
//
// ★2026-07-09: 多角形(手動パーツ)アクセサリー機能廃止に伴い、サンプル1
// (images/+landmarks_ai.json、多角形形式)を削除し、唯一のサンプルである
// サンプル2(images2/+landmarks_ai_2.json、マスク形式、アクセサリー7点内蔵)
// を使うよう作り直した。「body-only」の生成経路も引き続き検証するため、
// サンプル2のJSONをそのまま使う代わりに、テスト内でaccessoriesを空にした
// 一時JSONを組み立てて「JSON読み込み」機能経由で読み込ませている(手動で
// アクセサリーを追加するUI(旧「パーツ＋」タブ)は廃止済みのため)。
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

const EXPECTED_BODY_ONLY = {
  byteLength: 536912,
  sha256: "0515842c162df7de1ecbff2cc8967942b52a67c029730c15b170c0e3e40dabe5",
};
const EXPECTED_WITH_ACCESSORY = {
  byteLength: 902132,
  sha256: "dfff05209554406948b5772d38875b1dd9aaafc7b325dba009acee239e56b12a",
};

async function generateAndExportGlb(server, browser, bodyOnly) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForTimeout(1500);

  if (bodyOnly) {
    // サンプル2のJSONからaccessoriesだけを空にした一時JSONを作り、
    // 「JSON読み込み」機能経由で読み込ませる(画像は先に読み込み済みのものを使う)。
    const srcJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "landmarks_ai_2.json"), "utf8"));
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
