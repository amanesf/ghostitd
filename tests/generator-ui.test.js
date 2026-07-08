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

async function testFrontOnlyDoesNotTransition(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeNewBtn b");
  await page.waitForTimeout(300);

  // ファイル入力にはローカルパスが必要なので絶対パスで指定する
  const path = require("path");
  const imagesDir = path.join(require("./lib/testkit").REPO_ROOT, "images");
  await page.setInputFiles('input[data-slot="front"]', path.join(imagesDir, "front.png"));
  await page.waitForTimeout(500);
  let editorHidden = await page.$eval("#editor", (el) => el.classList.contains("hidden"));
  assert.ok(editorHidden, "editor must stay hidden after loading FRONT only (side/back still missing)");

  await page.setInputFiles('input[data-slot="side"]', path.join(imagesDir, "side.png"));
  await page.waitForTimeout(500);
  editorHidden = await page.$eval("#editor", (el) => el.classList.contains("hidden"));
  assert.ok(editorHidden, "editor must stay hidden after loading FRONT+SIDE (back still missing)");

  await page.setInputFiles('input[data-slot="back"]', path.join(imagesDir, "back.png"));
  await page.waitForTimeout(800);
  editorHidden = await page.$eval("#editor", (el) => el.classList.contains("hidden"));
  assert.ok(!editorHidden, "editor must show once all 3 (front/side/back) are loaded");

  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function testEditorTabsAndOverlays(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForTimeout(1500);
  const editorVisible = await page.$eval("#editor", (el) => !el.classList.contains("hidden"));
  assert.ok(editorVisible, "sample mode should reach the editor screen");

  // 5タブ再編(GHOST_SCANNER_PLAN.md「色分けマップ」方式): 旧「領域」(ex)/
  // 「パーツ＋」(ac)はトップレベルタブから消え、「手動マスク」(manualmask)配下の
  // サブタブになった(data-subtab="ex"/"ac")。編集にはロック解除チェックボックスも要る。
  for (const tab of ["automask", "manualmask", "params", "gen", "lm"]) {
    await page.click(`.tabbtn[data-tab="${tab}"]`);
    await page.waitForTimeout(150);
  }
  await page.click('.tabbtn[data-tab="manualmask"]');
  await page.check("#manualMaskUnlock");
  for (const subtab of ["ex", "ac"]) {
    await page.click(`[data-subtab="${subtab}"]`);
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

  // アクセサリーフォーム(buildAcFormHtml/wireAcFormEvents)
  await page.click('.tabbtn[data-tab="manualmask"]');
  await page.click('[data-subtab="ac"]');
  await page.waitForTimeout(150);
  await page.click("#acAddBtn");
  await page.waitForTimeout(200);
  await page.fill("#acName", "テスト");
  await page.click('#acForm [data-acmode="soft"]');
  await page.click("#acCancel");

  // パラメータパネル(buildParamsPanelHtml/wireParamsPanelEvents)
  await page.click('.tabbtn[data-tab="params"]');
  await page.waitForTimeout(150);
  const firstGroup = await page.$("details.accgroup");
  if (firstGroup) { await firstGroup.click(); await page.waitForTimeout(200); }

  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    await testSampleModeDropdown(server, browser);
    await testFrontOnlyDoesNotTransition(server, browser);
    await testEditorTabsAndOverlays(server, browser);
  } finally {
    await browser.close();
    await server.close();
  }
}

module.exports = { name: "generator-ui (landmark_tool.html)", run };
