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
  インスタンスを起動している。
- ★2026-07-20(ユーザー報告「WebGLコンテキストロストのエラー表示が消える」
  調査): 上記とは別に、このサブテストが不安定にFAILする原因を`#err`への
  書き込みにスタックトレースを仕込んで特定した。原因は「モデル読込
  (GLTFLoader.parse()、非同期)が完了する前にコンテキストロストを起こすと、
  遅れて完了したロードのコールバック(resetCharacterUiState())が
  無条件に`#err`を空にし、直前に出したロスト中の警告表示を消してしまう」
  というレース条件だった(固定sleep(1500ms)では低速な環境でロード完了を
  待ちきれないことがあった)。対応は2点: ①テスト側はモデル読込の実際の
  完了条件(selfieBoxのvisible付与)をポーリングしてから試験を始める
  (testMovementPipAndConfigと同じ方式)。②controller.html側の
  resetCharacterUiState()もwebglContextLost中は`#err`を触らないよう防御を
  追加した(実際のユーザー操作でも、モデル読込中にコンテキストロストが
  起きる稀なケースで同じ表示消失が起こり得たため)。
- ★2026-07-10: `run-all.js`はmain()完了後に明示的に`process.exit()`している。
  一部の環境で、全テストの結果を出力し終えているにもかかわらずnodeプロセス
  自体が終了せず`npm test`が何分も(酷いと10分以上)ブロックし続ける現象が
  あった。Playwrightが起動したheadless Chromiumの子プロセスが、
  `browser.close()`がresolveした後もOSレベルでは残り続け、それに紐づく
  stdioハンドルがNodeのイベントループを空にできずにいたとみられる。
  結果は出揃っているのに終わらないだけなので、明示的なprocess.exit()で
  残存ハンドルを待たずに終了するようにした。
