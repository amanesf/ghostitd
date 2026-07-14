// -*- coding: utf-8 -*-
// character_3d.html(ビューア)のUI回帰テスト。
// dispose漏れ修正(clearModel/rebuildOutlines)やLong Method分割
// (loadGLB/applyMeshMaterials/setupMotionDropdown)の再構築パスを重点的に
// 踏む。
// ★2026-07-15(モデル調整機能のジェネレータ移植): 生成モデルの継ぎ目角度
// パネル(旧・生成調整タブのライブ編集)はlandmark_tool.html側に移った
// ため、そちらのテスト(tests/generator-ui.test.js)に移動した。
"use strict";
const assert = require("assert");
const { chromium } = require("playwright");
const { startServer, openPage } = require("./lib/testkit");

async function testSampleDropdown(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/character_3d.html");
  const options = await page.$$eval("#sampleSelect option", (els) => els.map((e) => e.textContent));
  assert.ok(options.length >= 1, "sample select should have at least 1 option");
  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function testSampleLoadAndMaterialToggles(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/character_3d.html");
  await page.click("#modeSampleBtn b");
  // ★2026-07-10: 固定sleep(2000ms)だと、CPUが混み合った際にモデル読み込みが
  // 2秒を超えて完了しないケースがありflakyだった。実際の完了条件をポーリング
  // する方式に変更。ただしtryAutoLoad()はモデル本体のloadGLB完了(dropに
  // hideが付く)→その後に別途fetchするmotion_*.glb群のloadGLB(animSelへの
  // 追加)という2段階の非同期処理なので、両方を別々に待つ必要がある
  // (dropのhideだけを待つとmotionOptionsがまだ0〜1件のまま次のassertに
  // 進んでしまい、別の意味でflakyになる)。
  await page.waitForFunction(
    () => document.getElementById("drop").classList.contains("hide"),
    { timeout: 20000 }
  );
  const dropHidden = await page.$eval("#drop", (el) => el.classList.contains("hide"));
  assert.ok(dropHidden, "sample model load should hide the drop/file-picker screen");

  await page.waitForFunction(
    () => document.querySelectorAll("#animSel option").length > 1,
    { timeout: 20000 }
  );
  const motionOptions = await page.$$eval("#animSel option", (els) => els.map((e) => e.textContent));
  assert.ok(motionOptions.length > 1, "motion dropdown should be populated (setupMotionDropdown)");

  await page.click("#barToggle");
  await page.waitForTimeout(150);
  await page.click('.vtabbtn[data-vtab="motion"]');
  await page.waitForTimeout(150);
  await page.selectOption("#animSel", "1");
  await page.waitForTimeout(300);

  // セル影/輪郭線トグル(applyMeshMaterials, rebuildOutlines: dispose+再構築パス)
  await page.click('.vtabbtn[data-vtab="shader"]');
  await page.waitForTimeout(150);
  await page.click("#cel");
  await page.waitForTimeout(200);
  await page.click("#outline");
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const el = document.getElementById("outlineStrength");
    el.value = 80; el.dispatchEvent(new Event("input"));
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const el = document.getElementById("outlineStrength");
    el.value = 20; el.dispatchEvent(new Event("input"));
  });
  await page.waitForTimeout(300);

  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function testGeneratedModelExportTab(server, browser) {
  // ★2026-07-15(モデル調整機能のジェネレータ移植): 生成モデルは既に完成GLBの
  // 状態でビューアに渡ってくる(landmark_tool.html側でfinishFromIntermediate()
  // まで完了済み)。ビューアの「書き出し」タブはGLB/JSON再書き出し専用になった。
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForTimeout(1500);
  await page.click('.tabbtn[data-tab="gen"]');
  await page.waitForTimeout(200);
  await page.click("#generateBtn");
  await page.waitForURL("**/character_3d.html*", { timeout: 60000 });

  for (let i = 0; i < 24; i++) {
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
  assert.strictEqual(download.suggestedFilename(), "model.glb", "export button should re-serve the already-finished GLB");

  await page.click("#exportJsonBtn");
  await page.waitForTimeout(200);
  const status = await page.$eval("#genPanelStatus", (el) => el.textContent);
  assert.ok(status.includes("landmarks_ai.json"), "JSON export should report success: " + status);

  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    await testSampleDropdown(server, browser);
    await testSampleLoadAndMaterialToggles(server, browser);
    await testGeneratedModelExportTab(server, browser);
  } finally {
    await browser.close();
    await server.close();
  }
}

module.exports = { name: "viewer-ui (character_3d.html)", run };
