# BK_手動パーツ分け版_2026-07-07/ (バックアップ)

このフォルダには、`carveRegion()`/`nearestBoneSegmentSkin()`の内部分割、
`runPipeline`/`runToIntermediate`の重複統合、3ファイル(controller.html/
character_3d.html/landmark_tool.html)のIIFEモジュール分割という、より
リスクの高いリファクタリングに着手する直前(2026-07-07)の、動作確認済みの
状態をそのまま保存したものです。

含まれるファイル:
- controller.html
- character_3d.html
- landmark_tool.html
- js/ 以下の生成パイプライン一式(vendor/を除く)

自動テストが無いプロジェクトのため、以降の構造変更で問題が起きた場合の
比較・切り戻し用リファレンスとして残しています。本番の挙動には一切
影響しません(index.html等からこのフォルダは参照されません)。
