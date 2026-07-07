// -*- coding: utf-8 -*-
// tests/配下の*.test.jsを順番に実行し、PASS/FAILをまとめて報告する。
// 1ファイルずつ独立したbrowser/serverを起動するため並列実行はしていない
// (このプロジェクトの規模ではテスト全体で数分程度で終わるため十分)。
"use strict";
const fs = require("fs");
const path = require("path");

const testDir = __dirname;
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

async function main() {
  console.log(`Running ${files.length} test file(s)...\n`);
  const results = [];
  for (const file of files) {
    const mod = require(path.join(testDir, file));
    const label = mod.name || file;
    process.stdout.write(`- ${label} ... `);
    const t0 = Date.now();
    try {
      await mod.run();
      const ms = Date.now() - t0;
      console.log(`PASS (${ms}ms)`);
      results.push({ file, label, ok: true, ms });
    } catch (e) {
      const ms = Date.now() - t0;
      console.log(`FAIL (${ms}ms)`);
      console.error("  " + (e && e.stack ? e.stack.split("\n").join("\n  ") : e));
      results.push({ file, label, ok: false, ms, error: e });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log("Failed: " + failed.map((f) => f.label).join(", "));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("test runner crashed:", e);
  process.exitCode = 1;
});
