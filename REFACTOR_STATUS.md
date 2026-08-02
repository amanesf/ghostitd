# リファクタリング作業メモ(2026-07-07時点)

## 完了
- landmark_tool.html/character_3d.html/controller.html: デッドコード削除、
  three.jsのdispose漏れ修正、Long Method分割(draw/renderAcForm/
  renderParamsPanel/loadGLB/renderSeamPanel/frame/loadCharacter等)、
  WebGLコンテキストロスト対応、命名衝突の解消(mode→ptrMode等)。
- js/pipeline.js: 呼び出し箇所ゼロだったrunPipeline()を削除し、
  runToIntermediate()と共通のrunCarvingStages()に整理。
- js/carving.js: carveRegion()(350行)を責務ごとの内部関数に分割
  (buildWidthTracks/buildDepthByRow/carveSdfField)。
- js/skeleton.js: nearestBoneSegmentSkin()の頂点ループをskinVertex()に分割。
- 上記の数値検証: サンプル生成→GLBのSHA-256ハッシュが変更前後で
  完全一致することを確認済み(本体のみ/アクセサリー付きの両方)。
- `bk/`フォルダに、深いリファクタリング着手前の状態を保存済み(参照/切り戻し用)。
- `tests/`にPlaywrightテスト一式を追加(`npm install && npm test`)。
  - generation-pipeline.test.js: 上記のGLBハッシュ比較をgolden masterテスト化。
  - generator-ui.test.js / viewer-ui.test.js / controller-ui.test.js:
    3ツールのUI回帰テスト。

## 未完了・要フォローアップ
- **`npm test`の最終確認が未完了**(トークン切れのため中断)。個別修正後の
  最終フルラン(4ファイル全体)の結果が未確認。次回セッションでまず
  `npm install && npm test`を実行し、全てPASSすることを確認すること。
  - controller-ui.test.jsのWebGLコンテキストロストテストは、他のサブテストと
    browserインスタンスを共有すると失敗する原因不明の現象があり、専用の
    browserインスタンスを起動する回避策を入れた(tests/README.md参照)。
    この回避策が効いているか未確認。
- **CLAUDE.md未作成**。ユーザーからは「CLAUDE.md(既知の落とし穴・変数一覧・
  命名規則)」の作成も依頼されていたが、未着手。特に`model`(グローバル変数)
  と`sample.model`(SAMPLES配列のプロパティ)の識別子衝突など、機械的な
  リネームで壊れる既知のリスクを記録しておくこと。
- IIFEのモジュール化(3ファイルとも巨大な単一スコープのまま)は、
  上記の命名衝突リスクを理由に見送り済み(ユーザー合意済み)。
