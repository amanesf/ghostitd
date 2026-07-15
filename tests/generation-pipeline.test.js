// -*- coding: utf-8 -*-
// 生成パイプライン(js/pipeline.js, carving.js, skeleton.js, atlas.js,
// accessories.js, visual_hull.js, marching_cubes.js)の回帰検知テスト。
//
// ★これは「golden master」テストです。同梱サンプル(landmarks_ai_2_embedded.json、
// front/side/back画像込み)から生成したGLBのSHA-256ハッシュを固定値と比較し、
// 1バイトでも変わったら失敗させる。彫刻・スキニングのアルゴリズムは
// 数式が複雑で自動テストの無いプロジェクトのため、「意図しない変更が
// 無いこと」を機械的に検知するのが目的。
//
// ★2026-07-09: 多角形(手動パーツ)アクセサリー機能廃止に伴い、サンプル1
// (images/+landmarks_ai.json、多角形形式)を削除し、唯一のサンプルである
// サンプル2(マスク形式、アクセサリー7点内蔵)を使うよう作り直した。同日中に
// front/side/back画像もJSONへ埋め込む形式に統一し、images2/*.png+
// landmarks_ai_2.jsonの2ファイル構成をlandmarks_ai_2_embedded.json単体に
// まとめた。「body-only」の生成経路も引き続き検証するため、サンプル2の
// JSONをそのまま使う代わりに、テスト内でaccessoriesを空にした一時JSONを
// 組み立てて「JSON読み込み」機能経由で読み込ませている(手動でアクセサリーを
// 追加するUI(旧「パーツ＋」タブ)は廃止済みのため)。
// ★2026-07-09(同日中に再更新): 全身のシルエットも色分けマップ+色許容誤差
// 方式に統一したため、サンプルをcolormaps(front/side/leftSide/back)込みの
// 新形式に作り直した(旧形式=colormapsを持たないJSONのサポートは廃止)。
// アクセサリーの色もcolormaps上の実際の配色に合わせて再設定した。
//
// 生成結果を意図的に変える変更(例: 彫刻アルゴリズムの改善、パラメータ
// 既定値の変更)をした場合は、このテストが失敗するのが正しい挙動です。
// その場合はテスト実行時に表示される新しいハッシュ値でEXPECTED_*を
// 更新してください(下の値を書き換えるだけ)。
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { chromium } = require("playwright");
const { startServer, openPage, REPO_ROOT } = require("./lib/testkit");

// ★2026-07-10: ジェネレータに側面画像のテクスチャ利用設定UIを復活させ、
// 既定値を「側面画像を使わない」に変更した(従来はUIが無い間、暗黙的に
// 「全パーツ側面を使う」がデフォルト挙動だった)。この既定値変更で継ぎ目
// テクスチャの焼き込み結果が変わるため、ハッシュを更新した。
// ★2026-07-11(顔の立体感対応、鼻の突起案からの再検討): 当初は鼻先landmarkに
// 加算式の突起(applyNoseBump)を実装したが、鼻は顔の中心線上にありside画像の
// 行スキャンから既に実測の奥行きが出ているため、独自パラメータの突起を足すと
// 実測の側面イラストと食い違ってしまうと判明し撤回した(ユーザー指摘)。
// 代わりに、front/back/sideどのシルエット輪郭にも現れない内部形状である
// 目窩(eye_L/eye_R landmark中心の凹み、js/carving.jsのapplyEyeSocketRecess)
// を彫るようにした。body-only/with-accessoryとも彫刻結果(=GLB)が変わり、
// ハッシュを更新した。
// ★2026-07-11(パーツ分割タイミングの是正): 体+全アクセサリーを彫刻直後に
// 分割し、間引き・平滑化をパーツごとに独立して行っていたことが、境界を
// 共有する頂点が両側で別々に動いて隙間になる根本原因と判明した(ユーザー
// 指摘)。間引き・平滑化を統合されたままの1枚のメッシュに対して1回だけ
// 行い、スキニング直前にだけパーツへ分割するよう変更した(js/pipeline.js
// のdecimateStage/meshFinishStage、js/carving.jsのdecimateMesh/
// splitMeshByOwner参照)。これに伴い、パーツ別だった間引き目標頂点数
// (body_target_verts/acc_target_verts)を1本(target_verts)に統合した
// ため、サンプルの埋め込みgen_params(古いbody_target_verts:3000)が
// 効かなくなり、新しい既定値(target_verts:10000)が使われるようになった
// (=間引きが弱まり高精細になった)。body-only/with-accessoryとも彫刻
// 結果(=GLB)が変わり、ハッシュを更新した。
// ★2026-07-11(切り抜き精度向上): 色分けマップの体色/アクセサリー色をそれぞれ
// 独立に固定色許容誤差(tolerance)で判定していた方式(P3D.colorRegionRawMask/
// loadAlphaFromColormap/extractMaskFromColormap、body_color_tolerance/
// colorTolerance)を、体+全アクセサリー色+背景を候補とした最近傍色分類
// (P3D.classifySilhouetteRaw)に置き換えた(js/common.js/js/pipeline.js参照)。
// あわせて、その分類境界のアンチエイリアス帯をサブピクセル補間する仕組み
// (P3D.boundaryContForCandidate、gen_params.subpixel_edges)を追加し、体の
// 行スキャン(front/back/side)に適用した。どちらも彫刻の入力(輪郭の位置)が
// 変わるため、body-only/with-accessoryとも彫刻結果(=GLB)が変わり、ハッシュを
// 更新した。
// ★2026-07-11(にじみの起点修正): bleedEdges(縁の色にじみ)が輪郭ぎりぎりの
// 画素(元イラストの黒い縁取りストロークになりがち)を起点に外側へにじませて
// いたため、縁取りが太って見える問題があった。gen_params.bleed_inset_px分
// だけ内側の「安全な内部色」を起点にするよう変更した(js/common.jsの
// bleedEdges参照)。テクスチャの焼き込み結果が変わるため、ハッシュを更新した。
// ★2026-07-11(ユーザー指摘対応、追加3点): (1) bleedEdges侵食(bleedInsetPx)が
// 髪の房の毛先等alpha幅の細い部位を完全に消してしまい、その部位のにじみ起点が
// 無関係な別部位の色に飛んで「パーツごとに扱いが違って見える」不具合があった。
// alpha連結成分ごとに、侵食後シードが0個の成分だけ侵食前のalphaへフォール
// バックする修正(js/common.jsのrestoreErodedThinComponents)を追加。
// (2) 顔・前髪の丸みを「かなり四角形寄り」にしたいとの指摘を受け、
// psq_head(5→6、上限値)・psq_acc(2.2→5、全アクセサリー共通)を引き上げた。
// あわせてサンプルJSON(landmarks_ai_2_embedded.json)に古いpsq_head:2/
// psq_acc:2.2が埋め込み保存されており新しい既定値が反映されない状態だった
// ため、サンプル側も新しい既定値に合わせて更新した。
// (3) 耳の位置に穴が空いているように見えるとの指摘を受けGLBの頂点/面データを
// 直接解析したが、実際の位相的な穴(1個の三角形にしか使われない境界辺)は
// ゼロ件(UVシーム分割による見かけ上の「境界」を頂点座標でマージして除外した
// 上での結果)で、耳専用のcarving機能自体が存在しないことも確認した(コード上の
// バグではなく、ジオメトリ自体は閉じている)。
// 上記3点の彫刻結果・テクスチャ焼き込み結果が変わるため、body-only/
// with-accessoryともハッシュを更新した。
// ★2026-07-12(ユーザー指摘「房が分かれているところの顔が切り抜けてない」
// 対応、側面切り抜き精度): js/carving.jsのbuildDepthByRow()は、1行内にside
// 画像上のrunが複数あっても常に前端〜後端をまるごと包む1本の奥行き区間に
// 合成していた(2026-07-04、顎先が首との間の隙間で分断されて消える不具合の
// 対策として導入)。これが、前髪の房のように奥行き方向で本来別々の物体
// (房が手前、顔がその奥に覗く)まで1枚の奥行きスラブへ均してしまい、房と
// 顔が癒着して見える原因になっていた。行内のrunどうしのpx間隔だけで判定
// (新設のdepth_gap_close_px、既定6px)し、間隔がこの値以下のrunだけ従来通り
// 1本にまとめ、間隔が大きいrunは別々の奥行き区間として保持するよう変更した
// (connected-component分析は「同じ1つの連結成分内の凹み」まで区別できず
// 効かなかったため不採用、詳細はjs/carving.jsのコメント参照)。体単体でも
// 該当行があり彫刻結果が変わるため、body-only/with-accessoryともハッシュを
// 更新した。
// ★2026-07-12(ユーザー指摘「内側のピクセルを拡張するのがうまく動いていない」
// 対応): bleedEdges(js/common.js)は、bleedInsetPxで指定した分だけ内側に
// 侵食した「安全な内部色」をにじみの起点(シード)にしていたが、実際に見えて
// いる前景画素(輪郭ぎりぎりの縁取りストローク画素を含む)は侵食の有無に
// 関わらず常に実ピクセルの絵柄そのままを使う仕様だった。このため
// bleedInsetPxをいくら大きくしても縁取りストローク自体は書き換わらず、
// 「内側のピクセル拡張が効いているように見えない」原因になっていた
// (ユーザー指摘「輪郭から拡張するんじゃなくて内側から拡張」)。侵食後も
// シードとして生き残った画素だけを実ピクセルとして保護し、それ以外
// (輪郭ぎりぎりの縁取りストローク画素+実背景画素)は全て最寄りの安全な
// 内部色で上書きするよう変更した(bleedInsetPx=0なら従来通り変化なし)。
// bleedFgAlpha(体+全アクセサリーの和集合)全体に対する一様な処理であり、
// パーツごとに個別処理しているわけではない(js/pipeline.js参照)。
// body-only/with-accessoryとも彫刻結果は不変だがテクスチャ焼き込み結果が
// 変わるため、ハッシュを更新した。
// ★2026-07-12(SIMPLIFY_DECIMATE_PLAN.md): js/vendor/SimplifyModifier.jsが
// 大規模メッシュで"Cannot read properties of undefined (reading 'hasVertex')"
// を投げて不安定になる不具合の根本原因(mergeVertices後に残る縮退三角形を
// 半エッジ構造の構築前に除外していなかったこと)を修正し、頂点数によらず
// 常にSimplifyModifierを使うようにした(gridClusterDecimateは例外発生時のみの
// フォールバックに変更)。あわせて間引きの設定を「目標頂点数(target_verts)」
// から「間引きの強さ(decimate_strength、0〜1、内部でSimplifyModifierの
// 許容誤差maxCostに変換)」に変更した(js/carving.js参照)。既定値0.85は
// 体単体でほぼ旧target_verts=10000相当の頂点数になるよう調整したが、
// 誤差ベースの曲率考慮アルゴリズムに変わったこと自体で彫刻結果(頂点分布)が
// 変わるため、body-only/with-accessoryともファイルサイズ・ハッシュが変わった
// (with-accessory側はアクセサリーが体に道連れで過度に削られなくなった分、
// より大きく変化している。SIMPLIFY_DECIMATE_PLAN.mdの発端そのものの改善)。
// ★2026-07-14(ユーザー指摘「横方向は490頂点も要らない、丸みは数式で合成
// してるだけだから細かく作る必要ない。縦方向は画像の実測値だから重要」):
// ボクセル解像度を縦(Y、body_vox)と横/奥行き(X・Z、body_vox_xz新設)に
// 分離した(js/carving.jsのbuildGrid参照)。縦は各行がfront/side/back画像の
// 実測行そのものだが、横/奥行きの断面はcarveSdfField内でなめらかな数式
// (superellipse)で合成しているだけの近似形状のため、縦と同じ細かさにする
// 意味が無い。既定でbody_vox_xzをbody_voxの4倍(粗く)にしたところ、実測で
// 生頂点数が163,982→27,794(約17%)、生成時間が約60秒→13秒に減った一方、
// 45度・側面視点での目視確認では丸みのカクつき等の劣化は確認されなかった。
// body-only/with-accessoryとも彫刻結果(頂点分布)が変わるため、ハッシュを
// 更新した。
// ★2026-07-15(ユーザー指摘「手や腕は正面だけ使ってほしい」対応): 手/腕と
// 確信を持って判定できた列について、front∪backの和集合ではなくfront単独の
// 前景画素を追加でチェックするよう変更した(js/carving.jsのcarveRegion参照。
// 指の間の隙間がfront/backで食い違う絵柄だと、backにしかない絵柄で指の間の
// 隙間が塗り潰され指が癒着していた)。body-only/with-accessoryとも腕の
// 彫刻結果が変わるため、ハッシュを更新した。
// ★2026-07-17(パフォーマンス改善): js/vendor/SimplifyModifier.jsの
// vertices/faces(メッシュ全体を通した大域配列)からの削除がindexOf+spliceで
// O(現在の配列長)かかり、collapse()のたびに呼ばれるため合計でO(頂点数の
// 二乗)級になっていた(1px/1px設定・約120万頂点の実測で間引き段階だけで
// 約40分かかっていた主因)。swap-and-pop方式(削除対象を末尾要素とswapして
// popする)によりO(1)に置き換えた(ベンチマーク実測: 12.5万頂点で33秒→
// 4.9秒、98万頂点で(旧方式はタイムアウトするほど遅いため未計測)→35秒、
// ほぼ線形スケールに改善)。生き残る頂点・面の「集合」は変わらないが、
// 配列内の並び順が変わったことで、間引き終盤の僅差タイブレークで極めて
// 近接した(位置差1e-5オーダー)頂点がどちらか一方だけ選ばれる箇所が
// ごく少数(実測23,713頂点中7〜8点、0.03%)生じるため、ハッシュを更新した
// (見た目上の劣化は無いことを確認済み)。
// ★2026-07-17(設定タブ整理): 目窩(face_sculpt/eye_socket_*)機能とdepth_gap_
// close_px(側面のrun統合)を機能ごと削除した。前者は輪郭に現れない架空の
// 凹みだったため、後者は実サンプルで検証したところ効果を確認できなかった
// ため(ユーザー指摘)。body-only/with-accessoryとも彫刻結果が変わるため
// ハッシュを更新した。
// ★2026-07-18(スカート裾スパイク調査): js/carving.jsのbuildDepthByRowで、
// depth_gap_close_px削除時にグループ構造が変わったことで死んでいた「ノイズ幅
// runを無視する」フィルタを復元した。1ボクセル未満の幅は解像度的に表現不可能な
// ゴミとして無視するだけで、色分けマップの分類結果自体は一切書き換えない
// (「画像を信じる」方針に沿った修正、ユーザー合意済み)。
// ★同日: js/common.jsに追加していたdespeckleLabels(色分類結果を周囲の
// 多数派で書き換える処理)は、画像の分類結果を推測で上書きするものだった
// ため、ユーザー判断により撤回した(this file's history参照)。
const EXPECTED_BODY_ONLY = {
  byteLength: 688780,
  sha256: "731ef8e0ab8cb5f95283e9fc256a21265159c90dcccc58063a04569f607a10cd",
};
// ★2026-07-10バグ修正: bleedEdges(縁の色にじみ)が体(alphaFull)だけを前景と
// みなし、スカート/マフラー/髪等のアクセサリー領域(体とは別の色分けマップ色)
// を「背景」として周囲の色で上書きしていたため、アクセサリーの実際の絵柄が
// 消えて縞状に破綻していた(js/pipeline.js参照)。bleedの前景判定を「体∪全
// アクセサリー」の和集合に修正したことでwith-accessory側のテクスチャ焼き込み
// 結果が変わるため、ハッシュを更新した(body-onlyはアクセサリーが無いため
// 影響を受けず不変)。
// ★2026-07-10(彫刻方式の刷新): 体+全アクセサリーを別々のグリッドで独立に
// 彫っていた方式を、1つの共有グリッドへ蓄積してから1回だけmarching cubes
// する統合彫刻方式に置き換えた(パーツ間の隙間の解消が目的、js/pipeline.js
// のrunCarvingStages参照)。あわせて前髪等のtrack判定を行→行の距離ベース
// 貪欲マッチングから連結成分ラベリングに置き換えた(房の交差による誤結合の
// 解消が目的、js/carving.js参照)。with-accessory側はアクセサリー(前髪等)
// を含むため彫刻結果が変わり、ハッシュを更新した(body-onlyはアクセサリーが
// 無く、統合しても体単体と同じ結果になるため不変)。
// ★2026-07-10(境界ギャップ埋め): 統合彫刻を入れてもなお隙間が残るとの
// ユーザー指摘を受け再調査した結果、色分けマップの体色/アクセサリー色の
// 境界に数px〜十数px幅の陰影があり、どちらの色許容誤差判定にも入らない
// 実データの穴(彫刻の入力自体に隙間)になっていたことが判明した
// (js/common.jsのP3D.fillColorGaps参照)。2つの確定領域に挟まれた未確定
// 画素だけを最近傍色で埋める修正によりwith-accessory側の彫刻結果が変わり、
// ハッシュを更新した(body-onlyはアクセサリーが無く対象外のため不変)。
// ★2026-07-11: 上記(切り抜き精度向上/にじみの起点修正)と同じ変更により
// with-accessory側も彫刻結果・テクスチャ焼き込み結果が変わり、ハッシュを
// 更新した。
// ★2026-07-11(ユーザー指摘対応、追加3点): 上のEXPECTED_BODY_ONLYコメント
// (bleedEdges細部位フォールバック/psq_head・psq_acc引き上げ/サンプルJSON
// 側のpsq更新/耳の穴の有無を実データで確認)と同じ変更により、with-accessory
// 側も彫刻結果・テクスチャ焼き込み結果が変わり、ハッシュを更新した。
// ★2026-07-11バグ修正(退行、重要): 最近傍色分類への置き換え(2026-07-11の
// 「切り抜き精度向上」コミット)時、bleedFgAlpha(にじみの前景判定を「体∪全
// アクセサリー」の和集合にする2026-07-10の修正)が必要とするa.mask[v].alpha
// (マスクPNGから読み込んだ実データ)を早期にロードしていたearlyMaskLoads
// ブロックを、旧・境界ギャップ埋め(fillColorGaps)専用の処理と誤認して丸ごと
// 削除してしまっていた。この結果bleedFgAlphaのforEachループが常にm.alpha
// 未ロードで素通りし、体以外(スカート/マフラー等)が全く前景とみなされず、
// 2026-07-10に一度直したはずの「アクセサリーが周囲の体色のにじみで塗り
// 潰される」不具合が退行していた(ユーザー指摘「スカートが上着や太もも
// のにじみで消えてしまう」により発覚。git bisectで2026-07-11の切り抜き
// 精度向上コミットが原因と特定)。bleedFgAlpha計算の直前に必要な分だけ
// 早期ロードを復元した(js/pipeline.js参照)。with-accessory側のテクスチャ
// 焼き込み結果が大きく変わるため、ハッシュを更新した(body-onlyはアクセサ
// リーが無く対象外のため不変)。
// ★2026-07-12(ユーザー指摘「まとめて設定は意味がない」「サンプル初期値」対応):
// 全アクセサリー共通の「まとめて設定」(psq_acc)を廃止し、各アクセサリーが
// 必ず個別のpsq値を持つようにした。サンプル(landmarks_ai_2_embedded.json)の
// 初期値は前髪/後ろ髪=5、それ以外(左右ツインテール/髪飾り/マフラー/スカート)
// =2に設定した(以前は全アクセサリーが共通のpsq_acc=5を使っていた)。彫刻結果
// が変わるため、with-accessoryのハッシュを更新した(body-onlyはアクセサリー
// を含まないため不変)。
// ★2026-07-12(ユーザー指摘「ツインテールの造形が粗い/穴が空く」対応):
// js/carving.jsのgridClusterDecimate(SIMPLIFY_SAFE_LIMIT超過時のフォールバック、
// 実サンプルはこちらの経路を通る)は、体全体のbbox表面積から一律のセルサイズを
// 決めていたため、体よりずっと細いアクセサリー(房状の髪飾り等)の断面が
// 数セルに丸ごと吸収され、粗い/穴の空いた形状になっていた(ユーザーが生データ
// [間引き前]は綺麗であることを確認し、間引き段階が原因と特定)。パーツの境目の
// 頂点(隣接面が別ownerを含む頂点)は絶対にクラスタリングせず凍結し、それ以外は
// 各ownerが自分自身のbbox表面積÷(targetVertsを頂点数比で配分した目標頂点数)
// で求めた専用のセルサイズで間引くよう変更した(境目を凍結しないと、体側と
// アクセサリー側でグリッドの縮尺が食い違い、房が扇状に歪む重大な副作用が
// 実機で確認された)。ファイルサイズは相応に増える(816608→1406364バイト)。
// ★2026-07-12(SIMPLIFY_DECIMATE_PLAN.md、上のEXPECTED_BODY_ONLYコメント参照):
// 上記のgridClusterDecimate側の複雑化(境目凍結・パーツ別セルサイズ)は、
// SimplifyModifier自体の根本原因(縮退三角形)を修正して常時SimplifyModifierを
// 使うようにしたことで発動頻度が下がり複雑さに見合わなくなったため撤去し、
// 単一セルサイズの元の方式に戻した(gridClusterDecimateは例外発生時のみの
// フォールバックに専念)。実サンプル(163,982頂点)でSimplifyModifierが完走・
// 結果メッシュも健全であることを実機確認済み。間引きの設定を「目標頂点数」
// から「間引きの強さ(0〜1の誤差ベース)」に変更したことで、体より細い
// アクセサリーが体に道連れで過度に削られなくなり(本計画の発端だった
// 「ツインテールの造形が粗い」不具合そのものの解決)、ファイルサイズは
// 大きく増えた(1406364→2816216バイト)。
// ★2026-07-12(ユーザー指摘「45度からみたらパーツ間隙間が開く」対応、
// owner_blend機能追加): 体+全アクセサリーの統合彫刻は各パーツのフィールドを
// そのパーツ自身のfront/side/back画像だけから独立に作るため、3方向どの
// 投影でも輪郭が一致して見えても斜め方向には「どちらのパーツの表面も
// 届いていない」隙間ができることがあった。パーツ境界で競合するボクセルに
// 限り、単純max-combineの代わりにpolynomial smooth-max(SDFベースCSGの
// smooth union)でなだらかに橋渡しする機能を追加し、既定ONにした
// (js/carving.jsのcarveSdfField/carveUnifiedRegions、gen_paramsの
// owner_blend/owner_blend_strength参照)。
// ★2026-07-13(ユーザー指摘「ツインテールの付け根で隙間が空く」対応、
// bone_bridge機能追加): owner_blendの小さいブレンド半径は、front/side/back
// 画像上でツインテールが後ろ髪の一部を覆い隠すことでシルエットそのものが
// 欠落するケース(実測: 競合ボクセルの値差が2を超え、owner_blend単体では
// 橋渡しできなかった)には効かなかった。bones(付け根の骨、例えばツインテール
// ・後ろ髪はともに"head")を共有するパーツ同士に限り、幅(front/back)と
// 奥行き(side)の両方で同時に隙間なく隣接している行だけを「本当に3D的に
// 接している」と確信し、その行だけ実際にボクセルへ材質を書き込んで橋渡し
// する機能を追加した(js/carving.jsのcomputeRowExtents/
// computeBoneBridgeRows/applyBoneBridgeFill、gen_paramsのbone_bridge参照)。
// ★2026-07-14(ユーザー指摘「効果がなさすぎる」「四角形になって意味不明」
// 対応): owner_blendは実測(163,982頂点のサンプル)で該当ボクセルがわずか
// 34頂点分しかなく体感できる効果がほぼ無いこと、bone_bridgeの初回実装は
// 橋渡し範囲を2パーツの外縁の和集合(union)で計算していたため前髪⇔顔・
// 後ろ髪⇔顔のような広く連続した境界で行ごとに頭部の断面丸ごとに近い範囲を
// 塗りつぶす巨大な箱になっていたことが分かったため、owner_blendは既定OFFに、
// bone_bridgeは範囲計算を「隙間/重なりの近傍だけ」に絞る修正
// (fillIntervalForAxis)を施した上で既定OFFのまま(体が無条件に全アクセサリー
// の橋渡し候補になる点など、まだ誤爆の余地があるため実験的機能として継続
// 調査中)とした。両機能とも既定OFFのため、この時点での既定生成結果は
// owner_blend導入前の間引き強度変更時点(1406364→2816216バイト)から不変
// だった。
// ★2026-07-14(上のEXPECTED_BODY_ONLYコメント「縦横のボクセル解像度分離」
// 参照): body_vox_xz新設によりwith-accessory側も彫刻結果が変わったため、
// ハッシュを更新した(2816216→1222828バイト)。
// ★2026-07-15: 上のEXPECTED_BODY_ONLYコメント(手/腕をfront単独判定に変更)
// と同じ変更により、with-accessory側も彫刻結果が変わり、ハッシュを更新した。
// ★2026-07-17: 上のEXPECTED_BODY_ONLYコメント(SimplifyModifierのswap-and-pop化)
// と同じ変更により、with-accessory側も間引き終盤の僅差タイブレークが変わり
// ハッシュを更新した。
// ★2026-07-17(設定タブ整理): 上のEXPECTED_BODY_ONLYコメント(目窩/
// depth_gap_close_px削除)に加え、track_gap_close_px(房の分断を埋める)も
// 機能ごと削除した。with-accessory側はこれらの影響を全て受けるため
// ハッシュを更新した(バイト数が増えているのは、房の分断や側面の分断が
// 埋められなくなり、以前より分割された形状になったため)。
// ★2026-07-18(スカート裾スパイク調査): 上のEXPECTED_BODY_ONLYコメント参照
// (buildDepthByRowのノイズフィルタ復元。despeckleLabelsは撤回済みのため
// with-accessory側のみ影響を受ける、body-onlyは不変)。
const EXPECTED_WITH_ACCESSORY = {
  byteLength: 1199956,
  sha256: "d55954d2bc89e1ac6aa11a140090ba85eb70a883d56aa8c32dbb773865cc7080",
};

async function generateAndExportGlb(server, browser, bodyOnly) {
  const { page, errors } = await openPage(browser, server.url + "/landmark_tool.html");
  await page.click("#modeSampleBtn b");
  await page.waitForTimeout(1500);

  if (bodyOnly) {
    // サンプル2のJSONからaccessoriesだけを空にした一時JSONを作り、
    // 「JSON読み込み」機能経由で読み込ませる(画像は先に読み込み済みのものを使う。
    // このJSONにも画像dataUrlは含まれるが、既にpointsがある=編集画面に入って
    // からの読み込みなのでapplyLoadedJson()の差し替え経路のみが働き、画像
    // dataUrl自体は参照されない)。
    const srcJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "landmarks_ai_2_embedded.json"), "utf8"));
    srcJson.accessories = [];
    const tmpPath = path.join(os.tmpdir(), "landmarks_ai_2_body_only_" + Date.now() + ".json");
    fs.writeFileSync(tmpPath, JSON.stringify(srcJson));
    await page.click('.tabbtn[data-tab="gen"]');
    await page.waitForTimeout(200);
    await page.setInputFiles("#jsonFile", tmpPath);
    await page.waitForTimeout(500);
    fs.unlinkSync(tmpPath);
  }

  await page.click('.tabbtn[data-tab="gen"]');
  await page.waitForTimeout(200);
  await page.click("#generateBtn");
  await page.waitForURL("**/character_3d.html*", { timeout: 60000 });

  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(5000);
    const txt = await page.$eval("#err", (el) => el.textContent).catch(() => "(err)");
    if (txt === "") break;
  }

  await page.click("#barToggle");
  await page.waitForTimeout(150);
  await page.click("#genTabBtn");
  await page.waitForTimeout(300);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportGlbBtn"),
  ]);
  const streamPath = await download.path();
  const buf = require("fs").readFileSync(streamPath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  assert.deepStrictEqual(errors, [], "generation produced console/page errors: " + JSON.stringify(errors));
  await page.close();
  return { byteLength: buf.length, sha256 };
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    const bodyOnly = await generateAndExportGlb(server, browser, true);
    assert.strictEqual(bodyOnly.byteLength, EXPECTED_BODY_ONLY.byteLength,
      "body-only GLB byteLength changed: " + bodyOnly.byteLength + " (expected " + EXPECTED_BODY_ONLY.byteLength + ")");
    assert.strictEqual(bodyOnly.sha256, EXPECTED_BODY_ONLY.sha256,
      "body-only GLB sha256 changed: " + bodyOnly.sha256 + " (expected " + EXPECTED_BODY_ONLY.sha256 + ") -- if this change was intentional, update EXPECTED_BODY_ONLY in this file");

    const withAccessory = await generateAndExportGlb(server, browser, false);
    assert.strictEqual(withAccessory.byteLength, EXPECTED_WITH_ACCESSORY.byteLength,
      "with-accessory GLB byteLength changed: " + withAccessory.byteLength + " (expected " + EXPECTED_WITH_ACCESSORY.byteLength + ")");
    assert.strictEqual(withAccessory.sha256, EXPECTED_WITH_ACCESSORY.sha256,
      "with-accessory GLB sha256 changed: " + withAccessory.sha256 + " (expected " + EXPECTED_WITH_ACCESSORY.sha256 + ") -- if this change was intentional, update EXPECTED_WITH_ACCESSORY in this file");
  } finally {
    await browser.close();
    await server.close();
  }
}

module.exports = { name: "generation-pipeline (golden hash)", run };
