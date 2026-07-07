# ジェネレータ体感改善プラン（2Dプレビュー・輪郭線除去・ビューア連携）

## 背景・目的

キャラクター生成ツール（`landmark_tool.html` = 通称「ジェネレータ」）は、パラメータを
調整→「生成」ボタン→フルパイプライン実行（数秒〜10秒程度）→結果を見る、という
試行錯誤ループになっている。生成時間自体は致命的ではないが、以下の改善余地がある。

1. **2D画像処理系パラメータ（背景しきい値・オフセット補正等）は、3D生成を待たずに
   その場でプレビューできるはず** なのに、今は生成してみないと効果が分からない。
2. **メッシュ後処理系パラメータ（平滑化・間引き・テクスチャ継ぎ目）は彫刻
   （marching cubes）のやり直しが不要** なのに、パラメータを変えるたびにフル
   パイプラインが再実行され、無駄が大きい。
3. **線画イラスト特有の問題として、3D化した際にテクスチャの継ぎ目が黒くなる** —
   輪郭線の存在位置と、テクスチャ継ぎ目の判定位置（表面法線が前向き⇔横向きに
   切り替わる境界）がほぼ一致するため。
4. **ボーン位置の確認が専用タブでしかできない** — アクセサリーの取り付けボーンを
   手動でチェックボックス選択する際も、ランドマークを置く際も、実際にはどの
   ボーンがどこにあるか・どの領域を担当するかを見ながら作業したいが、今は
   「ボーン配置プレビュー」タブに切り替えないと見えない。

これらは性質の異なる問題なので、独立して着手できるフェーズに分けて計画する。

## 技術調査で分かったこと

- 生成パイプライン（`js/pipeline.js`）: `prep`(背景除去) → `bleed`(縁の色にじみ) →
  `profile/core` → `skeleton` → `visual_hull`(全身彫刻) → `accessories`(個別彫刻) →
  `atlas_bake`(テクスチャ焼き) → `model_glb`(GLB書き出し)。
- **支配的コストは`visual_hull`のmarching cubes**（`js/marching_cubes.js`の3重ループ）。
  既定の`body_vox=0.003`で体だけでも約2170万セルを走査する（`js/carving.js:383-386`）。
- 全28個の生成パラメータ（`js/common.js`の`DEFAULT_GEN_PARAMS`＋`seamAngles`等）のうち、
  **彫刻をやり直さずに反映できるのは12個**（後述の表を参照）。
- `character_3d.html`（ビューア）は現状**純粋なGLBビューア**で、生成パイプラインへの
  アクセスは一切ない。`js/idb.js`の`saveGeneratedModel`/`loadGeneratedModel`は
  完成済みGLBバイナリのみを受け渡す契約になっている。
- 線画特有の黒い継ぎ目問題: `js/atlas.js`の継ぎ目判定（`:264-268`）は表面法線の
  front⇔side遷移点で決まり、これは正面イラストの外周輪郭線が引かれる位置と
  ほぼ一致する。輪郭線が**シルエット外周のみ**（内部の黒髪・黒服等の塗りは対象外）
  という前提が確認できたため、前景マスクをNpx収縮し、その帯の暗ピクセルを
  内側の色で塗りのばして除去する、比較的シンプルな手法で対応できる。
- ボーン表示・範囲マップ: `computeBonePivots()`（`landmark_tool.html:841`）は
  ランドマークからボーン各関節のfront画像ピクセル座標を`toPx()`で計算済み
  （現状は「ボーン配置プレビュー」専用タブのオーバーレイ表示にのみ使用）。
  この座標系をそのまま使い、キャンバス上の各点について最も近いボーン線分
  (親ピボット→子ピボット)への2D距離を求めれば、ボーンごとの担当領域を
  Voronoi風に色分けできる。粗いグリッド(例:40×60)で計算すれば負荷は軽い。
  side/back画像への拡張は`js/atlas.js`の`regionPoint`と同じ投影式が必要で
  frontよりやや手間が増えるため、まずfront限定のMVPとする。

## 移動可能パラメータの分類（フェーズ2の対象）

| Tier | パラメータ | 反映に必要な前提 |
|---|---|---|
| Tier1（完全即時） | `body_smooth_iters`, `acc_smooth_iters`, `rigid_soft_width`, `kb_per_face` | 追加キャッシュ不要。頂点座標・スキン・テクスチャ圧縮のみで完結 |
| Tier2（生メッシュキャッシュ要） | `body_decimate`, `body_target_verts`, `acc_decimate`, `acc_target_verts` | 彫刻直後（smooth/decimate前）の生メッシュV/Fをキャッシュしておけば再彫刻不要 |
| Tier3（生メッシュ+bleed画像キャッシュ要） | `seamAngles`, `seamNoSide`, `seamSmoothIters`, `colorGradWidth` | 上記に加え、prep/bleed済みのfront/back/side画像をキャッシュしておけば`atlas_bake`のみ再実行で反映可能 |

それ以外（`body_vox`, `psq_*`, `track_gap/win`, `arm_*`, `hand_*`, `subpixel`,
`white_thr`, `alpha_dilate`, `band_h/overlap`, `back_offset_x/y`,
`side_offset_x/y`）は彫刻（marching cubes）のやり直しが必須で、ビューア側への
移動対象外。ただしこのうち2D画像処理段階だけで完結するものはフェーズ0で
ジェネレータ側にプレビューを追加する。

## フェーズ構成

| # | フェーズ | 内容 | 対象ファイル | 依存 | 状態 |
|---|---|---|---|---|---|
| 0 | ランドマークツールの2Dプレビュー＋輪郭線除去＋ボーン表示/範囲トグル | `white_thr`/`alpha_dilate`/`back_offset_x,y`/`side_offset_x,y`/`band_h`/`band_overlap`/`track_gap`/`track_win`のパラメータタブ選択中オーバーレイ表示。パラメータグループ展開時に対象view（front/back/side）へ自動切替。シルエット外周の黒い輪郭線除去（前景マスクをNpx収縮→帯の暗ピクセルを内側色で塗りのばし、`bleedEdges`のBFSを方向反転して流用）を線幅・暗さしきい値パラメータ化し同じプレビュー機構で確認可能にする。加えて「マーク」「パーツ＋」タブに「ボーン表示」（既存`drawBoneOverlay()`を他タブでも呼べるように）と「ボーン範囲」（`computeBonePivots()`の座標系でボーン線分への2D距離を粗いグリッドで計算し、最近傍ボーンごとに色分けしたVoronoi風オーバーレイ）の2トグルを追加し、ランドマーク/アクセサリー配置中にどのボーンの担当領域か一目で分かるようにする | `landmark_tool.html`, `js/common.js` | なし（独立、先行着手可） | 完了 |
| 1 | 中間データ契約の設計・実装 | `js/idb.js`の契約を「完成GLB」から「中間パッケージ」（元JSON全体＋生の彫刻メッシュV/F(body/accessory別)＋prep/bleed済みfront/back/side canvas＋skeleton/pivots）に変更。`js/pipeline.js`を重い彫刻（marching cubes）まで実行して中間データを返せるよう分割。`landmark_tool.html`の「生成」ボタンをこの保存形式に変更 | `js/idb.js`, `js/pipeline.js`, `landmark_tool.html` | なし（基盤、フェーズ2の前提） | 完了 |
| 2 | ビューアのライブパラメータUI | `character_3d.html`に`js/atlas.js`, `js/model_export.js`, `js/skeleton.js`, `js/carving.js`を読み込み追加。Tier1〜3の12パラメータのUIパネルを実装（`landmark_tool.html`のパラメータパネルUIを流用/移植）。依存順序（smooth→decimate→atlas bake）を守って連動再計算 | `character_3d.html` | フェーズ1 | 完了 |
| 3 | ビューアからの最終出力 | 「GLB書き出し」ボタン（現在のプレビュー状態を`model_export.js`でGLB化）。「JSON書き出し/コピー」ボタン（中間パッケージのJSONオブジェクトの該当フィールドをライブ調整値で上書きして`landmarks_ai.json`として出力、`landmark_tool.html`の`exportJson`/`copyJson`と同等のUI） | `character_3d.html` | フェーズ2 | 未着手 |

## ビューアUIの制約（フェーズ2・3共通）

`character_3d.html`は現状、キャンバス`#c`が`position:fixed;inset:0`で画面全体を占め、
既存のコントロールは下部固定バー`.bar`（`character_3d.html:43`）のみの薄いレイアウト。
フェーズ2・3で追加するパラメータパネル/タブ/書き出しボタンは、この`.bar`を拡張する
形で実装するが、**画面高さの50%（50vh）を超えないこと**を制約とする。

- `max-height:50vh` + `overflow-y:auto`でスクロール可能にする。
- タブ／折りたたみ（`<details>`等）で一度に表示する項目数を絞り、縦に伸びすぎない
  構成にする（`landmark_tool.html`のパラメータパネルの`<details class="accgroup">`
  と同様の折りたたみ方式を踏襲する）。
- 3Dビュー（`#c`）が常に画面上半分以上は隠れず視認できる状態を保つ。

## 運用ルール

1. フェーズ0は他フェーズと完全に独立しているため、いつ着手してもよい。
2. フェーズ1→2→3は順番必須（2はデータ契約に、3はビューアのUI状態に依存する）。
3. 着手するときはこのファイルの状態列を「進行中」に、完了したら「完了」に更新する
   （簡単な実施メモ・コミットハッシュを添える）。
4. 実施中に追加の課題が見つかったら、末尾に追記してよい（既存の番号は変更しない）。

## フェーズ0 実施メモ

`landmark_tool.html`の「設定値」タブに以下を実装した。

- `PREVIEW_GROUPS`（front/back/side自動切替対象のパラメータグループ定義）、
  `buildPreviewCanvas()`（背景除去+bleedEdges+(有効時)輪郭線除去を適用した
  プレビュー用canvasをキャッシュ付きで構築）、`previewModeActive()`/
  `previewTargetView()`、`draw()`内の分岐でプレビュー描画を追加。
  パラメータグループの`<details>`のtoggleイベントで`previewActiveGroup`を
  更新し、対象グループに`view`指定があれば`curView`を自動切替する。
- シルエット輪郭線除去は`js/common.js`に`erodeMaskPx()`（前景マスクの4連結
  収縮N回）と`removeSilhouetteOutline()`（収縮後マスクの外側かつ前景内側の
  帯だけに限定し、暗いピクセルを多元BFSで最寄りの健全前景色に置換）を追加。
  帯だけを対象にすることで内部の黒髪・黒服等は変更されない前提を担保している。
  UIは`#outlinePanel`の`renderOutlinePanel()`で専用の`<details>`を描画し、
  有効/無効・帯幅(band_px)・暗さしきい値(dark_thr)を操作できる（プレビュー
  専用機能のためgenParams/landmarks_ai.jsonには含めない）。
- 「マーク」「パーツ＋」タブに共通の`boneOverlayOn`/`boneRegionOn`状態を追加し、
  `wireBoneToggle()`で両タブのチェックボックス(`boneOverlayToggleLM/AC`,
  `boneRegionToggleLM/AC`)を同期させた。ボーン表示は既存`drawBoneOverlay()`を
  そのまま呼び出し、ボーン範囲は`drawBoneRegionOverlay()`を新規実装（front限定
  MVP、40×60の粗いグリッドで`computeBonePivots()`の骨線分への2D距離を計算し
  最近傍ボーンの色で`fillRect`するVoronoi風オーバーレイ、ボーンごとに固定色相を
  `BONE_REGION_COLORS`で割当）。

Playwrightでの確認（chromium、`python3 -m http.server`でローカル配信、
サンプルモードで`images/front.png`等を読込）: 「設定値」タブで「背景/しきい値」
グループを開くと正面プレビューに切替わり、`white_thr`を200/255にスライドすると
背景除去範囲が実際に変化することを画面キャプチャで確認。「背面/側面ズレ補正」
グループを開くと自動的に背面ビューへ切替わることを確認。「シルエット輪郭線の
除去」パネルを有効化し帯幅30/暗さしきい値255まで動かしても例外なし。「マーク」
タブでボーン表示・ボーン範囲を両方ONにするとボーン線分+関節点+40×60の色分け
グリッドが重畳表示され、「パーツ＋」タブに切替えても両トグルのON状態が保持され
アクセサリー領域点と共存表示されることを確認。全操作を通じてブラウザコンソール
エラーは0件。

設計判断: ボーン範囲オーバーレイはプランの指示通りfront限定・グリッド粗さ
40×60固定とした。輪郭線除去の既定値(band_px=6, dark_thr=90)は既存コード内の
コメントに基づき採用し、変更していない。

## フェーズ1 実施メモ

契約変更の核心は「彫刻(marching cubes)の平滑化(smooth_iters)を、carveRegion
自身の内部処理から呼び出し側の後段処理として分離した」こと。平滑化は
`P3D.laplacianSmooth(V,F,iters)`という「与えられたV/F/itersのみに依存する
純粋関数」なので、`carveRegion`にsmoothIters:0を渡して彫刻直後の生メッシュ
(rawV/rawF)を取り、後から同じ`laplacianSmooth`を呼ぶのは、従来
`smoothIters>0`をcarveRegionに直接渡す場合と数式的に同一の結果になる
(間引き decimateMesh は元々carveRegionの外(呼び出し側)で行われていたため
分離は不要だった)。

- `js/visual_hull.js`: `stageVisualHull()`がcarveRegionへ`smoothIters:0`を渡し、
  戻り値に`rawV`/`rawF`(彫刻直後・平滑化/間引き前)を追加。平滑化+間引きの
  適用ロジックを`P3D.finishBodyMesh(rawV,rawF,gp)`として切り出し、
  `stageVisualHull`内からも呼ぶ(挙動は変更なし、内部実装のみ分離)。
- `js/accessories.js`: `stageAccessories()`もアクセサリーごとに同様の分離を行い、
  ループ内で`rawParts`配列(`{name,mode,bones,rawV,rawF}`)を蓄積して戻り値に
  追加。平滑化+間引きは`P3D.finishAccessoryMesh(rawV,rawF,gp)`に切り出した。
- `js/pipeline.js`: 新規`P3D.runToIntermediate(state,onProgress)`を追加。
  prep→bleed→profile/core→skeleton→visual_hull→accessoriesまでを実行し、
  atlas_bake/model_glbは実行せずに`{raw_body:{V,F}, raw_accessories:[...],
  bled_canvases:{front,back,side}, pivots, calib}`を返す(中間データ)。
  新規`P3D.finishFromIntermediate(pkg, opts, onProgress)`を追加。中間データ+
  gen_params/seam系パラメータから、平滑化→間引き→スキニング→atlas_bake→
  model_glbを実行してGLBを返す(彫刻はやり直さない)。既存`runPipeline()`は
  そのまま残置(後方互換/デバッグ用。現在の生成ボタンからは呼ばれない)。
- `js/idb.js`: `saveGeneratedModel`/`loadGeneratedModel`の契約を「完成GLBの
  ArrayBuffer」から「中間パッケージ」に変更(破壊的変更)。パッケージは
  `{landmarks_json, raw_body, raw_accessories, bled_canvases, pivots, calib,
  gen_params, seam_angles, seam_no_side, seam_smooth_iters, color_grad_width}`
  の形。canvas要素はstructured cloneできないため保存時に`canvas.toBlob()`で
  Blobに変換し、読み込み時に`Image`経由でHTMLCanvasElementへ復元する
  (`canvasToBlobEntry`/`blobEntryToCanvas`)。それ以外のTypedArray/プレーン
  オブジェクトはIndexedDBのstructured cloneでそのまま保存できるため変換不要。
- `landmark_tool.html`の「生成」ボタン: `P3D.runPipeline`ではなく
  `P3D.runToIntermediate`を呼び、`buildJson()`(既存のlandmarks_ai.json生成
  ロジック)の結果と組み合わせてパッケージを構築し`P3D.saveGeneratedModel`に
  渡すよう変更。ビューアへの遷移(`location.href="character_3d.html?..."`)は
  変更なし。
- `character_3d.html`: `js/common.js`/`js/carving.js`/`js/skeleton.js`/
  `js/atlas.js`/`js/model_export.js`/`js/visual_hull.js`/`js/accessories.js`/
  `js/pipeline.js`と、間引きに必要な`js/vendor/BufferGeometryUtils.js`/
  `js/vendor/SimplifyModifier.js`を読み込み追加(フェーズ2のライブパラメータ
  編集UIもこれらの上に構築する想定)。起動時オートロード処理を、
  `loadGeneratedModel()`の戻り値が中間パッケージであることを前提に、
  `P3D.finishFromIntermediate(pkg,{gp:pkg.gen_params,...})`でGLBを構築してから
  `loadGLB()`する形に変更。`currentPackage`にパッケージを保持(フェーズ2で
  ライブパラメータ変更時に再利用する)。

Playwrightでの確認(chromium、`python3 -m http.server`でローカル配信):
サンプルモードで画像/ランドマークを自動読込→「生成」タブで「生成」ボタンを
押下→`runToIntermediate`の各ステージログ(prep/bleed/profile/skeleton/
visual_hull/accessories)がコンソールに出ることを確認→`character_3d.html?
source=generated`へ自動遷移→ビューア側で「構築中: ...」の進捗表示が
mesh_finish→atlas_bake→model_glbと進み、最終的に髪・カメラ小物・スカート付き
のフルテクスチャモデルが正しい姿勢(Tポーズ)で表示されることをスクリーン
ショットで確認。「モデル」タブの「モデルを保存」ボタンでGLBをダウンロードし、
先頭4バイトが`glTF`マジックであること、ファイルサイズが約820KBの妥当な
GLBであることを確認。実行中に発生した警告(`SimplifyModifier`が高頂点数の
メッシュで失敗し頂点クラスタリングにフォールバックする旨)は本フェーズの
変更とは無関係な既存の挙動(間引き手法のフォールバック)であり、最終的な
モデル生成・表示は成功している。

設計判断/注意点: 初回実装時、`runToIntermediate`が返すフィールド名
(`rawBody`/`rawAccessories`/`bledCanvases`、キャメルケース)と、
`js/idb.js`に保存されるパッケージのフィールド名(`raw_body`/`raw_accessories`/
`bled_canvases`、スネークケース)が食い違っており、`finishFromIntermediate`
がスネークケース側を参照するように修正して解決した(Playwright検証で
`Cannot read properties of undefined (reading 'V')`として実際に検出できた)。
今後この2つの関数間でデータをやり取りする際はスネークケース(保存契約の
フィールド名)に統一する。

## フェーズ2 実施メモ

`character_3d.html`の下部バー`.bar`に新タブ「生成調整」(`#genTabBtn`、中間
パッケージがある時だけ表示)を追加した。

- `.bar`に`max-height:50vh;overflow-y:auto`を追加(UI制約を満たす)。
  `landmark_tool.html`の`accgroup`パターンを移植したCSS(`.accgroup`/
  `.pitem`等)を追加。
- `GEN_PARAM_TIERS`(Tier1〜3のパラメータ定義)と`renderGenParamsPanel()`で
  `<details class="accgroup">`のグループUIを描画。`landmark_tool.html`の
  `PARAM_META`/`renderParamsPanel`と同じ「スライダー+数値入力+単位」の
  行パターンを採用。
- パラメータ変更(`oninput`/`onchange`)は`scheduleGenRecompute()`で250ms
  デバウンスした上で`doGenRecompute()`を呼び、`P3D.finishFromIntermediate()`
  を`currentPackage`(フェーズ1でキャッシュ済みの生メッシュ+bled画像+骨格)に
  対して呼び直してGLBを再構築し、`loadGLB(glb,undefined,false,true)`で
  差し替える。処理中に追加の変更が来た場合は`genRecomputeQueued`フラグで
  1回だけキューイングし、多重実行を避ける。
- `loadGLB()`に`keepView`引数を追加。フェーズ2のライブ更新時は`true`を渡し、
  初回読み込み時の`frameModel()`(カメラの自動フィット)をスキップすることで、
  パラメータ調整のたびに視点が初期化されないようにした。

依存順序について: `finishFromIntermediate()`自体がsmooth→decimate→
skin→atlas_bake→model_glbの順で毎回フルに計算し直す設計なので、
「Tier1のパラメータだけ変えた時はatlas_bakeを省略する」といった段階的な
差分最適化は本フェーズでは実装していない(常に全段を再計算する)。
生メッシュ/bled画像のキャッシュ自体(フェーズ1の中核)により彫刻
[marching cubes]の再実行は避けられているため実用上のレスポンスは確保できて
いるが、更に細かい差分キャッシュ(例: Tier1のみ変更時はatlas再焼き込みを
スキップする等)は今後の課題として末尾に追記する。

スコープ縮小の判断: プランのTier3には`seamAngles`/`seamNoSide`(ボーン別の
継ぎ目角度・側面画像使用有無の上書き辞書)も含まれるが、これらは
`landmark_tool.html`の「境目角度」タブと同じボーン別リストUIが必要で
本フェーズの分量を大きく超えるため、今回は`seamSmoothIters`(継ぎ目の平滑化
回数)と`colorGradWidth`(色のディザグラデーション幅)の2つのみをTier3として
ライブ編集可能にし、`seamAngles`/`seamNoSide`は生成時点の値をそのまま
`finishFromIntermediate`に渡す(据え置き)。ビューア側でこれらを編集したい
場合は現状ジェネレータに戻って再生成する必要がある。この制約は末尾にも
追記する。

Playwrightでの確認(chromium): サンプル画像から「生成」→ビューア到達後、
「操作パネル」を開き「生成調整」タブを選択→Tier1グループを開き
`body_smooth_iters`を20に、`kb_per_face`を50に変更→コンソールエラー0件で
モデルが再構築されること、ステータス表示が「更新中: ステージ名」→空に
遷移することを確認。Tier2グループで`body_decimate`/`acc_decimate`
チェックボックスと`body_target_verts`(500)/`acc_target_verts`を変更しても
同様に正常動作。Tier3グループで`__seamSmoothIters`を25に変更しても正常動作。
`document.getElementById('bar').getBoundingClientRect().height`を測定し、
3グループ全て開いた状態でも346px(ウィンドウ高さ900pxの50vh=450px以内)で
あることを確認、かつ`#c`(3Dビュー)のtopが常に0であること(3Dビューが画面上部
から隠れないこと)を確認。チェックボックス項目でラベルが二重表示される
軽微な表示バグを発見し、`renderGenParamsPanel()`のcheckbox分岐でラベルを
`.plabel`と`.prow`の両方に出していた箇所を修正した。

## 追加課題(運用ルール4に基づく追記)

5. フェーズ2で`seamAngles`/`seamNoSide`(ボーン別の継ぎ目角度/側面画像不使用
   フラグの上書き辞書)はビューアのライブ編集対象から外し、生成時点の値を
   据え置きにした。これらを編集したい場合は現状ジェネレータ
   (`landmark_tool.html`)の「境目角度」タブに戻って再生成する必要がある。
   将来的にビューア側でも編集したい場合は、ボーン別リストUIの追加実装が
   必要(工数が本フェーズの他項目より大きいため意図的に見送った)。
6. `P3D.finishFromIntermediate()`は現状、どのパラメータが変わったかに
   関わらず常にsmooth→decimate→skin→atlas_bake→model_glbの全段を再計算する。
   Tier1のパラメータ(平滑化回数等)だけを変えた場合でも間引き
   (decimateMesh)やatlas焼き込みをやり直しており、彫刻(marching cubes)の
   再実行は避けられているものの、更に細かい「変更のあった段以降だけ
   再計算する」差分キャッシュは未実装。パラメータ数・メッシュ規模次第では
   1回の調整で数百ms〜数秒かかることがある(Playwright確認時、間引き目標
   頂点数の変更でSimplifyModifierが失敗し頂点クラスタリングにフォール
   バックするケースがあり、その場合は特に時間がかかる)。
