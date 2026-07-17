# BK_手動パーツ分け版_2026-07-08/ (バックアップ)

このフォルダには、アクセサリー抽出の「多角形(手動マスク)」機能が
まだ残っていた最後の状態(コミット`378c0bd`, 2026-07-08時点)を
そのまま保存したものです。

この後のコミット`b0bc08f`「多角形(手動マスク)アクセサリー機能を廃止し、
色分けマップ由来の自動マスク方式に一本化」で、`landmark_tool.html`の
「手動マスク」タブの「パーツ＋」サブタブ(acForm/acList/acAddBtn、
多角形の点編集キャンバス等)と、`js/accessories.js`・`js/carving.js`の
`frontPolygon`/`backPolygon`/`sidePolygon`/`xyPolygon`関連コードが
削除され、色分けマップ方式のみに一本化された。

含まれるファイル:
- controller.html
- character_3d.html
- landmark_tool.html
- js/ 以下の生成パイプライン一式(vendor/を除く)

自動テストが無いプロジェクトのため、多角形方式の実装を参照したい場合の
比較・切り戻し用リファレンスとして残しています。本番の挙動には一切
影響しません(index.html等からこのフォルダは参照されません)。
