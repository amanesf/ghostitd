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
| 1 | 中間データ契約の設計・実装 | `js/idb.js`の契約を「完成GLB」から「中間パッケージ」（元JSON全体＋生の彫刻メッシュV/F(body/accessory別)＋prep/bleed済みfront/back/side canvas＋skeleton/pivots）に変更。`js/pipeline.js`を重い彫刻（marching cubes）まで実行して中間データを返せるよう分割。`landmark_tool.html`の「生成」ボタンをこの保存形式に変更 | `js/idb.js`, `js/pipeline.js`, `landmark_tool.html` | なし（基盤、フェーズ2の前提） | 未着手 |
| 2 | ビューアのライブパラメータUI | `character_3d.html`に`js/atlas.js`, `js/model_export.js`, `js/skeleton.js`, `js/carving.js`を読み込み追加。Tier1〜3の12パラメータのUIパネルを実装（`landmark_tool.html`のパラメータパネルUIを流用/移植）。依存順序（smooth→decimate→atlas bake）を守って連動再計算 | `character_3d.html` | フェーズ1 | 未着手 |
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
