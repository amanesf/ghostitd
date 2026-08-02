// -*- coding: utf-8 -*-
// controller.html(一人称コントローラー)のUI回帰テスト。
// dispose漏れ修正(clearCharacter/removeFlashlight)、frame()/loadCharacter()
// のLong Method分割、WebGLコンテキストロスト対応を重点的に踏む。
"use strict";
const assert = require("assert");
const { chromium } = require("playwright");
const { startServer, openPage } = require("./lib/testkit");

async function testSampleDropdown(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/controller.html");
  const options = await page.$$eval("#sampleSelect option", (els) => els.map((e) => e.textContent));
  assert.ok(options.length >= 1, "sample select should have at least 1 option");
  assert.deepStrictEqual(errors, []);
  await page.close();
}

// ★2026-07-10: 元は「移動+PIP+懐中電灯」と「ノイズ/設定パネル」を別々の
// サブテストにしており、それぞれ独立にページを開いてキャラクターモデル一式
// (model.glb+モーションclip複数本)を読み込み直していた。どちらもモデルの
// 状態には依存しない独立した操作なので、モデル読み込みを1回に統合して
// 所要時間を短縮する(GPU無しのヘッドレス環境ではモデル読み込み自体が
// 相対的に重く、これがcontroller-ui.test.js全体の所要時間の大半を占めていた)。
async function testMovementPipAndConfig(server, browser) {
  const { page, errors } = await openPage(browser, server.url + "/controller.html");
  await page.click("#modeSampleBtn b");
  // ★2026-07-10: 固定sleep(2000ms)は、テストを並列実行してCPUが競合すると
  // モデル読み込みが2秒を超えて完了せずflakyになったため、実際の完了条件
  // (resetCharacterUiState()がselfieBoxにvisibleを付与する)をポーリングする
  // 方式に変更した(並列化してもしなくても、固定sleepより正しく速い)。
  await page.waitForFunction(
    () => document.getElementById("selfieBox").classList.contains("visible"),
    { timeout: 20000 }
  );

  const pipVisible = await page.$eval("#selfieBox", (el) => el.classList.contains("visible"));
  assert.ok(pipVisible, "PIP cameras should be visible once a character model is loaded");

  // updateCharacterMovement()+resolveCollision()を4方向で踏む
  for (const key of ["KeyW", "KeyA", "KeyS", "KeyD"]) {
    await page.keyboard.down(key);
    await page.waitForTimeout(400);
    await page.keyboard.up(key);
    await page.waitForTimeout(100);
  }

  // 懐中電灯トグル(removeFlashlight/attachFlashlightのdisposeパス経由ではないが、updateFlashlight経路を踏む)
  await page.click("#flashToggle");
  await page.waitForTimeout(200);
  await page.click("#flashToggle");
  await page.waitForTimeout(200);

  await page.click("#configBtn");
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const el = document.getElementById("cfgNoise");
    el.value = 0; el.dispatchEvent(new Event("input")); // updateNoise()の早期return分岐
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const el = document.getElementById("cfgNoise");
    el.value = 50; el.dispatchEvent(new Event("input"));
  });
  await page.waitForTimeout(300);
  await page.click("#configClose");

  assert.deepStrictEqual(errors, []);
  await page.close();
}

async function testWebglContextLossRecovery(server) {
  // ★注意: 他のサブテストと同じbrowserインスタンス(既にWebGLコンテキストを
  // いくつも生成/破棄済み)を使い回すと、GPUプロセス側の状態のせいか
  // webglcontextlostが発火してもcontroller.html側のリスナーがerr.textContentを
  // 更新しない現象を確認したため、このテストだけは専用の新しいbrowser
  // インスタンスを使い、他のWebGL処理からの干渉を避ける。
  const browser = await chromium.launch();
  const { page, errors } = await openPage(browser, server.url + "/controller.html");
  await page.click("#modeSampleBtn b");
  // ★2026-07-20(ユーザー報告「WebGLコンテキストロストのエラー表示が消える」
  // 調査): 固定sleep(1500ms)だとGLTFLoader.parse()の非同期完了(モデルの
  // デコード、環境によっては1500msを超える)が終わっていないことがあり、
  // その完了コールバック(resetCharacterUiState())がこの後のコンテキスト
  // ロスト試験と競合して#errのエラー表示を上書き消去してしまうflakyの
  // 原因になっていた(実測でスタックトレースを取って特定済み、
  // controller.htmlのresetCharacterUiState参照)。実際の完了条件
  // (resetCharacterUiState()がselfieBoxにvisibleを付与する)をポーリング
  // することでこの競合を根本から避ける(testMovementPipAndConfigと同じ方式)。
  await page.waitForFunction(
    () => document.getElementById("selfieBox").classList.contains("visible"),
    { timeout: 20000 }
  );

  const result = await page.evaluate(() => {
    const canvas = document.getElementById("c");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_lose_context");
    if (!ext) return { skipped: true };
    ext.loseContext();
    return new Promise((resolve) => {
      let n = 0;
      const iv = setInterval(() => {
        n++;
        const duringLoss = document.getElementById("err").textContent;
        if (duringLoss || n >= 20) {
          clearInterval(iv);
          ext.restoreContext();
          resolve({ duringLoss });
        }
      }, 100);
    });
  });
  if (!result.skipped) {
    assert.ok(result.duringLoss && result.duringLoss.length > 0,
      "an error/status message should be shown while the WebGL context is lost");
  }
  await page.waitForTimeout(500);
  const errAfterRestore = await page.$eval("#err", (el) => el.textContent);
  assert.strictEqual(errAfterRestore, "", "error message should clear after the WebGL context is restored");

  assert.deepStrictEqual(errors, []);
  await page.close();
  await browser.close();
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    await testSampleDropdown(server, browser);
    await testMovementPipAndConfig(server, browser);
    await testWebglContextLossRecovery(server);
  } finally {
    await browser.close();
    await server.close();
  }
}

module.exports = { name: "controller-ui (controller.html)", run };
