// -*- coding: utf-8 -*-
// tests/配下の*.test.jsを実行し、PASS/FAILをまとめて報告する。
// 各ファイルは独立したbrowser/server(server.listen(0)でランダムポート)を
// 自前で起動しており、ファイル間で共有する状態が無いため理屈の上では並列
// 実行しても安全なはず(実際、CPUに余裕のある環境では並列化で数分→1分未満に
// 短縮できることを確認済み)。
// ★2026-07-10: ただし検証に使った一部のサンドボックス環境(4コア・GPU無しの
// SwiftShaderソフトウェアレンダリング)では、ヘッドレスChromiumを2〜4個
// 同時起動しただけでchromium.launch()自体が詰まって全体がハングする事例を
// 複数回確認した(nproc上は4コアあるように見えても、コンテナのcgroup CPU
// クォータやプロセス起動まわりの制限が別途effectiveに効いている可能性が高い)。
// ハングは「遅い」より遥かに悪い(CIが永久に終わらない)ため、既定値は
// 安全側の直列実行(CONCURRENCY=1)に固定している。CPUに余裕があるマシンで
// 試す場合は TEST_CONCURRENCY=2 npm test のように明示的に指定すること。
// ★2026-07-10(実行時間の異常調査): さらに、各テストファイルはbrowser.close()/
// server.close()を確実にawaitしており全体の結果出力も正しいタイミングで完了
// しているにもかかわらず、一部の環境ではnode自体のプロセスがその後10分以上
// 終了しない現象を確認した(Playwrightが起動したheadless Chromiumの子プロセス
// が、close()がresolveした後もOSレベルでは残り続け、それに紐づくstdioの
// ハンドルがNodeのイベントループを空にできずにいるとみられる)。結果は既に
// 出揃っているのに終了しないのは「テストが遅い」より悪い体験(呼び出し元の
// シェル/CIジョブが延々ブロックされる)なので、結果を出力し終えた時点で
// 明示的にprocess.exit()し、残っている子プロセスのハンドルを待たずに
// 確実に終了させる。
"use strict";
const fs = require("fs");
const path = require("path");

const testDir = __dirname;
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();
const CONCURRENCY = Math.max(1, parseInt(process.env.TEST_CONCURRENCY, 10) || 1);

async function runPooled(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runNext() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return results;
}

async function main() {
  console.log(`Running ${files.length} test file(s) (concurrency=${CONCURRENCY})...\n`);
  const results = await runPooled(files, CONCURRENCY, async (file) => {
    const mod = require(path.join(testDir, file));
    const label = mod.name || file;
    const t0 = Date.now();
    try {
      await mod.run();
      return { file, label, ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { file, label, ok: false, ms: Date.now() - t0, error: e };
    }
  });

  results.forEach((r) => {
    process.stdout.write(`- ${r.label} ... `);
    console.log(r.ok ? `PASS (${r.ms}ms)` : `FAIL (${r.ms}ms)`);
    if (!r.ok) console.error("  " + (r.error && r.error.stack ? r.error.stack.split("\n").join("\n  ") : r.error));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) {
    console.log("Failed: " + failed.map((f) => f.label).join(", "));
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("test runner crashed:", e);
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode || 0));
