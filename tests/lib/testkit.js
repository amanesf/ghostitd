// -*- coding: utf-8 -*-
// テスト用の共通ヘルパー(静的サーバ起動/ブラウザ起動/エラー収集)。
// 自動テストが無かったこのプロジェクトに、リポジトリルートを直接配信する
// 最小限の静的サーバとPlaywrightのラッパーだけを追加する(フレームワーク非依存、
// プロジェクト本体と同じ「素朴なJS」の流儀に合わせている)。
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".css": "text/css; charset=utf-8",
};

// リポジトリルート配下の静的ファイルをそのまま返すだけの最小サーバ。
// (http-server等の外部devDependencyを増やさず、Node標準のhttpモジュールのみで完結させる)
function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split("?")[0]);
      if (reqPath === "/") reqPath = "/index.html";
      const filePath = path.join(REPO_ROOT, reqPath);
      if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found: " + reqPath); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.on("error", reject);
    server.listen(port || 0, "127.0.0.1", () => {
      const actualPort = server.address().port;
      resolve({
        url: "http://127.0.0.1:" + actualPort,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

// テスト用ページを開き、実行時エラーを収集する。favicon.ico等の無害な404は
// 全ページ共通の既知ノイズなので既定で無視する(呼び出し側で拾いたい場合は
// ignoreKnownNoise:falseを渡す)。
async function openPage(browser, url, opts) {
  opts = opts || {};
  const page = await browser.newPage({ viewport: opts.viewport || { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (opts.ignoreKnownNoise !== false && /Failed to load resource.*404/.test(text)) return;
    errors.push("console: " + text);
  });
  await page.goto(url, { waitUntil: "load" });
  return { page, errors };
}

module.exports = { startServer, openPage, REPO_ROOT };
