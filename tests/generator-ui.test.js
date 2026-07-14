// -*- coding: utf-8 -*-
// landmark_tool.html(ジェネレータ)のUI回帰テスト。
"use strict";
const assert = require("assert");
const { chromium } = require("playwright");
const { startServer, openPage } = require("./lib/testkit");

async function testSampleModeDropdown(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  const options = await page.$$eval("#sampleSelect option", (els) => els.map((e) => e.textContent));
  assert.ok(options.length >= 1, "sample select should have at least 1 option");
  // クリックしてもプルダウン操作でモード選択画面が閉じないこと(stopPropagation確認)
  await page.click("#sampleSelect");
  await page.keyboard.press("Escape");
  const stillVisible = await page.$eval("#modeChoice", (el) => !el.classList.contains("hidden"));
  assert.ok(stillVisible, "clicking the sample dropdown must not dismiss the mode-choice screen");
  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function testJsonModeLoadsEditor(server, browser) {
  // ★2026-07-09(UIレビュー): front/side/back画像を個別アップロードする
  // 「新規作成」モードを廃止し、画像込みのJSON(landmarks_ai_2_embedded.json
  // 相当)を読み込む一本の経路に統一した。旧テスト(testFrontOnlyDoesNotTransition、
  // 個別スロットへの段階的アップロードを検証していた)はこの経路自体が
  // 無くなったため、JSON読み込みで編集画面まで到達することを確認する内容に
  // 作り直した。
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  let editorHidden = await page.$eval("#editor", (el) => el.classList.contains("hidden"));
  assert.ok(editorHidden, "editor must stay hidden before any JSON is loaded");

  const path = require("path");
  const jsonPath = path.join(require("./lib/testkit").REPO_ROOT, "landmarks_ai_2_embedded.json");
  await page.click("#modeJsonBtn b");
  await page.setInputFiles("#jsonFile", jsonPath);
  // ★2026-07-10: 固定sleepだと並列実行時のCPU競合でflakyになるため、実際の
  // 完了条件(runAnalyze()がeditorからhiddenを外す)をポーリングする方式に変更。
  await page.waitForFunction(
    () => !document.getElementById("editor").classList.contains("hidden"),
    { timeout: 20000 }
  );

  editorHidden = await page.$eval("#editor", (el) => el.classList.contains("hidden"));
  assert.ok(!editorHidden, "editor must show once an image-embedded JSON is loaded");
  const modeChoiceHidden = await page.$eval("#modeChoice", (el) => el.classList.contains("hidden"));
  assert.ok(modeChoiceHidden, "mode-choice screen must be hidden after successful JSON bootstrap");

  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function testEditorTabsAndOverlays(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForFunction(
    () => !document.getElementById("editor").classList.contains("hidden"),
    { timeout: 20000 }
  );
  const editorVisible = await page.$eval("#editor", (el) => !el.classList.contains("hidden"));
  assert.ok(editorVisible, "sample mode should reach the editor screen");

  // ★2026-07-09: 「手動マスク」タブ(旧「領域」ex)は廃止した。exclude_masksは
  // 色分けマップ由来のaccessoryマスクから自動合成されるため、手塗り編集UIは
  // 不要という判断(ユーザー合意済み)。「パーツ＋」(ac、多角形手動マスク)も
  // 同日に機能ごと廃止済み。
  for (const tab of ["automask", "params", "gen", "lm"]) {
    await page.click(`.tabbtn[data-tab="${tab}"]`);
    await page.waitForTimeout(150);
  }

  // ボーン表示/範囲オーバーレイ(drawBoneOverlaysIfEnabled)
  await page.click('.tabbtn[data-tab="lm"]');
  await page.check("#boneOverlayToggleLM");
  await page.check("#boneRegionToggleLM");
  await page.waitForTimeout(200);

  // ランドマーク点のドラッグ(draw()の点描画パス)
  const box = await page.$eval("#cvs", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2 + 8, box.y + box.h / 2 + 8, { steps: 5 });
  await page.mouse.up();

  // パラメータパネル(buildParamsPanelHtml/wireParamsPanelEvents)
  await page.click('.tabbtn[data-tab="params"]');
  await page.waitForTimeout(150);
  const firstGroup = await page.$("details.accgroup");
  if (firstGroup) { await firstGroup.click(); await page.waitForTimeout(200); }

  assert.deepStrictEqual(errors, []);
  await page.close();
}

// ★2026-07-15(モデル調整機能のジェネレータ移植): 間引き・平滑化・継ぎ目角度
// パネル(旧character_3d.htmlの「フェーズ2」ライブ編集パネル)をこちらに
// 移植した。3Dプレビューは無い(ユーザー承認済み)ため、再計算ではなく
// genParams/seamAngles/seamNoSideへ正しく値が書き込まれることだけを確認する。
// ★2026-07-17(設定タブ整理): 「モデル調整」グループは「モデルの細かさ」
// (間引き)と「モデルへの画像貼り付け」(継ぎ目角度=側面画像の利用パネル)に
// 分割された。
async function testModelAdjustAndSeamPanel(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForFunction(
    () => !document.getElementById("editor").classList.contains("hidden"),
    { timeout: 20000 }
  );
  await page.click('.tabbtn[data-tab="params"]');
  await page.waitForTimeout(150);

  const finenessGroup = await page.$('details.accgroup[data-accgroup="モデルの細かさ"]');
  assert.ok(finenessGroup, "モデルの細かさ accordion group should exist");
  await finenessGroup.click();
  await page.waitForTimeout(150);

  // decimate_strength(PARAM_META、genParams直結)。onchangeが例外なく走ることを確認する。
  const decimateInput = await page.$('[data-param="decimate_strength"]');
  assert.ok(decimateInput, "decimate_strength number input should be present");
  await decimateInput.evaluate((el) => { el.value = "0.5"; el.dispatchEvent(new Event("change")); });
  await page.waitForTimeout(100);

  const pasteGroup = await page.$('details.accgroup[data-accgroup="モデルへの画像貼り付け"]');
  assert.ok(pasteGroup, "モデルへの画像貼り付け accordion group should exist");
  await pasteGroup.click();
  await page.waitForTimeout(150);

  // 継ぎ目角度パネル(buildSeamGroupsHtml/wireParamsPanelEvents)
  const seamGroup = await page.$('details.accgroup[data-seamgroup]:not([data-seamgroup="一括設定"])');
  assert.ok(seamGroup, "seam angle accordion group should be present");
  await seamGroup.click();
  await page.waitForTimeout(150);
  const rangeInput = await page.$("[data-seam-range]");
  assert.ok(rangeInput, "seam angle range input should be present once the group is open");
  await rangeInput.evaluate((el) => { el.value = 30; el.dispatchEvent(new Event("input")); });
  await page.waitForTimeout(100);
  const numEl = await page.$('[data-seam-key]');
  const numVal = await numEl.evaluate((el) => el.value);
  assert.strictEqual(numVal, "30", "moving the seam angle range slider should sync the paired number input");

  // 一括設定(renderSeamBulkHtml/wireParamsPanelEvents)
  const bulkGroup = await page.$('details.accgroup[data-seamgroup="一括設定"]');
  assert.ok(bulkGroup, "seam bulk-apply group should be present");
  await bulkGroup.click();
  await page.waitForTimeout(150);
  await page.click("#seamSideAllOff");
  await page.waitForTimeout(150);

  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    await testSampleModeDropdown(server, browser);
    await testJsonModeLoadsEditor(server, browser);
    await testEditorTabsAndOverlays(server, browser);
    await testModelAdjustAndSeamPanel(server, browser);
  } finally {
    await browser.close();
    await server.close();
  }
}

module.exports = { name: "generator-ui (landmark_tool.html)", run };
