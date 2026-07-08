// -*- coding: utf-8 -*-
// 生成パイプライン(js/pipeline.js, carving.js, skeleton.js, atlas.js,
// accessories.js, visual_hull.js, marching_cubes.js)の回帰検知テスト。
//
// ★これは「golden master」テストです。同梱サンプル(images/*.png +
// landmarks_ai.json)から生成したGLBのSHA-256ハッシュを固定値と比較し、
// 1バイトでも変わったら失敗させる。彫刻・スキニングのアルゴリズムは
// 数式が複雑で自動テストの無いプロジェクトのため、「意図しない変更が
// 無いこと」を機械的に検知するのが目的。
//
// 生成結果を意図的に変える変更(例: 彫刻アルゴリズムの改善、パラメータ
// 既定値の変更)をした場合は、このテストが失敗するのが正しい挙動です。
// その場合はテスト実行時に表示される新しいハッシュ値でEXPECTED_*を
// 更新してください(下の値を書き換えるだけ)。
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { startServer, openPage } = require("./lib/testkit");

const EXPECTED_BODY_ONLY = {
  byteLength: 1134576,
  sha256: "159c83cf3c65f3fb65c8c3c445521221dda8f83b4ebeaa951abf25f9bbf67ce8",
};
const EXPECTED_WITH_ACCESSORY = {
  byteLength: 1254952,
  sha256: "f0b71c556b299cff391f4ac6d5acf150becb59c4ebf964c1bd9ceebf0b03962d",
};

async function generateAndExportGlb(server, browser, addAccessory) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForTimeout(1500);

  if (addAccessory) {
    // 5タブ再編(GHOST_SCANNER_PLAN.md「色分けマップ」方式): 旧「パーツ＋」(ac)は
    // 「手動マスク」(manualmask)配下のサブタブになり、編集にはロック解除が要る。
    await page.click('.tabbtn[data-tab="manualmask"]');
    await page.check("#manualMaskUnlock");
    await page.click('[data-subtab="ac"]');
    await page.waitForTimeout(200);
    await page.click("#acAddBtn");
    await page.waitForTimeout(200);
    await page.fill("#acName", "TestAccessory");
    await page.waitForTimeout(100);
    await page.click(".bonesGroups input[type=checkbox]");
    await page.waitForTimeout(200);
    await page.click("#acPlaceAll");
    await page.waitForTimeout(200);
    await page.click("#acConfirm");
    await page.waitForTimeout(200);
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
    const bodyOnly = await generateAndExportGlb(server, browser, false);
    assert.strictEqual(bodyOnly.byteLength, EXPECTED_BODY_ONLY.byteLength,
      "body-only GLB byteLength changed: " + bodyOnly.byteLength + " (expected " + EXPECTED_BODY_ONLY.byteLength + ")");
    assert.strictEqual(bodyOnly.sha256, EXPECTED_BODY_ONLY.sha256,
      "body-only GLB sha256 changed: " + bodyOnly.sha256 + " (expected " + EXPECTED_BODY_ONLY.sha256 + ") -- if this change was intentional, update EXPECTED_BODY_ONLY in this file");

    const withAccessory = await generateAndExportGlb(server, browser, true);
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
