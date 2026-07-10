# tests/

Playwrightを使ったヘッドレスブラウザテスト。フレームワーク非依存(Node標準の
`assert`のみ)、プロジェクト本体と同じ「素朴なJS」の流儀に合わせている。

## セットアップ
```
npm install
```

## 実行
```
npm test
```
CPUに余裕があるマシンでは `TEST_CONCURRENCY=2 npm test` のようにテストファイルの
同時実行数を上げられる(既定は1=直列。詳細はrun-all.js冒頭のコメント参照。
CPUが少ない/GPU無しの環境では同時起動数を上げるとchromium.launch()自体が
詰まる場合があるため、既定は安全側の直列にしている)。

## 構成
- `generation-pipeline.test.js` — golden masterテスト。同梱サンプルから生成した
  GLBのSHA-256ハッシュを固定値と比較する。彫刻/スキニングアルゴリズムを
  意図的に変更した場合はこのテストが失敗するのが正しい挙動なので、
  ファイル内のEXPECTED_*を新しいハッシュ値で更新すること。
- `generator-ui.test.js` — landmark_tool.htmlのUI回帰(モード選択、正面のみ
  読込時に編集画面へ遷移しないこと、タブ切替、ボーンオーバーレイ、
  アクセサリーフォーム、パラメータパネル)。
- `viewer-ui.test.js` — character_3d.htmlのUI回帰(サンプル読込、セル影/輪郭線
  トグルのdispose+再構築パス、モーション選択、生成モデルの継ぎ目角度パネル)。
- `controller-ui.test.js` — controller.htmlのUI回帰(サンプル読込、移動+当たり
  判定、PIPカメラ、ノイズトグル、WebGLコンテキストロスト復帰)。

## 既知の注意点
- `controller-ui.test.js`のWebGLコンテキストロストテストは、他のサブテストと
  同じbrowserインスタンスを使い回すと(GPUプロセス側の状態のためか)
  `webglcontextlost`イベントが発火してもcontroller.html側のハンドラが
  `#err`のtextContentを更新しない現象があったため、専用の新しいbrowser
  インスタンスを起動している(原因未特定、要調査。一部の環境ではこの専用
  browserを使っても症状が再現し、このサブテストだけFAILすることがある)。
- ★2026-07-10: `run-all.js`はmain()完了後に明示的に`process.exit()`している。
  一部の環境で、全テストの結果を出力し終えているにもかかわらずnodeプロセス
  自体が終了せず`npm test`が何分も(酷いと10分以上)ブロックし続ける現象が
  あった。Playwrightが起動したheadless Chromiumの子プロセスが、
  `browser.close()`がresolveした後もOSレベルでは残り続け、それに紐づく
  stdioハンドルがNodeのイベントループを空にできずにいたとみられる。
  結果は出揃っているのに終わらないだけなので、明示的なprocess.exit()で
  残存ハンドルを待たずに終了するようにした。
