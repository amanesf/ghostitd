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
`controller-ui.test.js`のWebGLコンテキストロストテストは、他のサブテストと
同じbrowserインスタンスを使い回すと(GPUプロセス側の状態のためか)
`webglcontextlost`イベントが発火してもcontroller.html側のハンドラが
`#err`のtextContentを更新しない現象があったため、専用の新しいbrowser
インスタンスを起動している(原因未特定、要調査)。
