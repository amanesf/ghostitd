# ゴーストコントローラー 神社マップ 大幅リクオリティ設計書

## Context

現状のゴーストコントローラー(`controller.html`)の神社は、user評価で「30点」。具体的な指摘:
1. 本殿がプリミティブ形状の代替モデル(`buildMainHallProcedural`)またはフリーモデル「Shrine by Aidan K McLaughlin」で構成されているが、後者は見た目が神社ではなく西洋の神殿/宮殿に近い。
2. 狛犬代替の石像(`buildStatueProcedural`または「Statue by Zsky」)が土台(台座)に乗っておらず、見た目もおかしい。
3. 鳥居の向きがおかしい。
4. オブジェクトの物量が少なく寂しい。
5. 読み込み失敗時のプリミティブ形状フォールバック(procedural fallback)は不要(＝全オブジェクトを実際のフリーモデルで用意し、読み込めなければ何も出さないだけでよい)。
6. マップの面積を現状の約10倍にしたい。

このドキュメントは、上記すべてに応える形で神社全体を再設計するための計画。**フリーモデル探しに特に注力**し、実際にダウンロード・軽量性確認・three.jsでのプレビュー描画による目視確認まで行った結果に基づく(下記「調査済み素材」は推測ではなく実物確認済み)。

## 現状の実装(把握済み、変更対象)

`controller.html` 内、神社構築部分(既存関数、すべて置き換え/削除対象):
- `buildToriiProcedural`/`placeTorii(z)` — 鳥居。フリーモデル`models/torii_free.glb`(Hattie Stroud)+プロシージャルfallback。
- `buildLantern(x,z,mode)` — 石灯籠。完全プロシージャル(円柱+箱+四角錐)。
- `buildBasin(x,z)` — 手水舎。完全プロシージャル。
- `buildMainHallProcedural`/`placeMainHall(z)` — 本殿。フリーモデル`models/shrine_hall_free.glb`(Aidan K McLaughlin)+フォールバック。当たり判定(box collider)・黒い引き戸(`MeshBasicMaterial`平面)・人感センサーライト(`sensorLight`/`hallFrontZ`)を内包。
- `buildStatueProcedural`/`placeStatues(z)` — 石像(狛犬代替)。フリーモデル`models/statue_free.glb`(Zsky)+フォールバック。
- `buildForbiddenBoundary(z,halfW)` — しめ縄+木杭境界。完全プロシージャル。
- `placeTrees()`/`scatterProps(...)` — 杉の木・岩・茂み。フリーモデル使用済み(変更少)。
- `colliders`配列(`{type:'circle',...}`/`{type:'box',...}`) + `resolveCollision(pos)` + `corridorBoundsAt(z)`(z12〜19だけ東側境界を張り出す小広場) — 当たり判定システム、レイアウト拡張はこの仕組みを流用。
- `normalizeToHeight(obj,targetHeight)`/`loadStaticGLB(url)` — 既存のロードヘルパー、そのまま再利用。
- `FREE_MODEL_CREDITS`/`refreshCreditsUI()` — configパネルのクレジット表示、そのまま再利用。
- `updateShrineEffects(dt)` — 入口点滅灯・手水舎の吊り電球の揺れ・人感センサーライトの毎フレーム更新。基本ロジックは流用しつつ吊り電球の対象を新モデルに合わせる。

## 調査済みフリーモデル(poly.pizza、実際にダウンロード・three.jsでプレビュー描画して目視確認済み)

すべてCC0またはCC-BY(要クレジット)。サイズは既存のキャラクターモデル(3MB系)や現状の6素材合計(584KB)と比較して十分軽量。

| 用途 | モデル名 | 作者 | ライセンス | サイズ | URL | 確認結果 |
|---|---|---|---|---|---|---|
| 本殿(センターピース) | Pagoda | Poly by Google | CC-BY | 484KB | poly.pizza/m/d1M5ncMBUDi | 三層の反り屋根・障子窓から灯りが漏れる、はっきり日本建築とわかる美麗な塔。現行の「神殿っぽい」問題を直接解決 |
| 入口の鳥居(1基のみ、目玉) | Japanese Torii | Jacques Fourie | CC-BY | 846KB | poly.pizza/m/cXyQGUwmlA5 | 厳島神社スタイルの反り屋根+副柱+提灯装飾。非常に情報量が多く豪華 |
| 参道に連続配置する鳥居(千本鳥居風) | torii | sugamo | CC-BY | 20KB | poly.pizza/m/8ZgGY1XCfuR | シンプルで明快な朱色鳥居。角度0で正面から見て開口部がまっすぐ見えることを確認済み(回転補正おそらく不要、実装時に実機で再確認) |
| 石灯籠 | Toro | Matt Newell | CC-BY | 76KB | poly.pizza/m/0SguM8o_PMc | 段状の台座+火袋+笠、正しいシルエット。色が朱色寄りなので必要ならHSL調整で石色に寄せる(本殿と同じ手法) |
| 石像(狛犬代替→キツネに変更提案) | Kurama | Imran Bepari (theCH33F) | CC-BY | 64KB | poly.pizza/m/5KQZFKrA-EM | 九尾狐のような凛々しい低ポリキツネ。**下記「狛犬→キツネ案」参照** |
| 石像の台座 | Pebble Square | Quaternius | CC0 | 数十KB | poly.pizza/m/2YtLzwgsWp | 苔むした石の台座形状。狛犬(キツネ)・灯籠等を載せる土台として使える |
| 小さな祠/道端の目印(バリエーション用) | Shrine (2種) | Kay Lousberg | CC0 | 24KB/36KB | poly.pizza/m/Qq8M5LSXQ2, poly.pizza/m/tFxdxO5clk | 石の小祠+ろうそく、石柱型の祠。境内各所に散らして密度を上げる |
| 門松(装飾・任意) | kadomatsu | sugamo | CC-BY | 未計測(小) | poly.pizza/m/dGAmgoz6L4T | 正月飾りだが和風演出として入口や社務所前に置ける |
| 杉の木(既存流用) | Pine Tree | Quaternius | CC0 | 94KB | poly.pizza/m/gX8WmgkeEm | 既存のまま |
| 岩(既存流用) | Rock | Quaternius | CC0 | 9KB | poly.pizza/m/4MUaQTcDdc | 既存のまま |
| 茂み(既存流用、要再検討) | Flower Bushes | Quaternius | CC0 | 342KB | poly.pizza/m/1X06RgvSr6 | 既存のまま(花付きが違和感あれば実装時に無地の茂みへ差し替え検討) |

**狛犬→キツネ案の理由**: 軽量(数百KB以内)かつ商用/改変可・帰属表示のみで使えるkomainu(獅子狛犬)専用モデルは見つからなかった(唯一の具体的候補はSketchfab上のCC-BYモデルだが17.5kポリゴン+4K石/苔テクスチャ違い2種で数十MB級、ダウンロードにログインも必要で「軽量」に反する)。稲荷系の神社では狛犬の代わりに**キツネ像(眷属)**が対で置かれるのは実在する様式であり、`Kurama`はまさにキツネ型の低ポリモデル。「似たようなものでもいい」との方針に沿い、**キツネの神使像**として採用することを提案する(狛犬の代わりにキツネという設定に振ることで、無理に狛犬を名乗るより自然)。

**しめ縄境界・杭は継続調査**: 専用の「shimenawa」フリーモデルは見つからず。実装時に「rope」「vine」「wooden post/stake」等でもう一段調査し、見つからなければ杭(木の柱系フリーモデルの転用)+縄(vine系フリーモデルの転用)の組み合わせで代替する。**コード内でジオメトリを新規に組み立てる(プリミティブ)ことはしない**——既存の見つかった/類似フリーモデルの組み合わせ・使い回しで表現する。

## 実装方針

### 1. フォールバック全廃
`buildToriiProcedural`/`buildMainHallProcedural`/`buildStatueProcedural`をすべて削除。`placeTorii`/`placeMainHall`/`placeStatues`は「フリーモデル読み込み→配置」のみとし、`.catch()`はconsole警告のみ(見た目のフォールバックは作らない)。`buildLantern`/`buildBasin`/`buildForbiddenBoundary`もプリミティブ生成をやめ、対応するフリーモデルの読み込み+配置に置き換える(関数名は`placeLantern`/`placeBasin`等に統一)。

### 2. 鳥居
- 入口(参道の起点付近)に「Japanese Torii」(Jacques Fourie)を1基、目玉として設置。
- そこから奥へ向けて「torii」(sugamo)を6〜9基、間隔を空けて連続配置し千本鳥居風の通り道を演出(`scatterProps`ではなく等間隔配置なので専用の`placeToriiRow(startZ,count,spacing)`のような関数を新設)。
- 回転補正: three.jsプレビューで両モデルとも正面(角度0)からアーチ越しに見通せることを確認済みだが、ゲーム内の実際のカメラ/歩行方向(`charYaw=0`が`+Z`)で最終確認し、必要なら`rotation.y`を調整する。

### 3. 本殿
`placeMainHall(z)`は「Pagoda」(Poly by Google)を読み込み配置。既存の当たり判定box・黒い引き戸(`MeshBasicMaterial`平面)・人感センサーライトの座標は、Pagodaの実測バウンディングボックス(`normalizeToHeight`後)に合わせて再調整する(現状のhalfW/halfDの値をPagodaの実寸に置き換え)。

### 4. 石像(キツネ+台座)
`placeStatues(z)`を「Pebble Square」(台座)+「Kurama」(キツネ)の2モデル combo に変更。台座を`normalizeToHeight`で低め(0.3〜0.4m程度)にスケールし地面に設置、その上面高さぶんキツネのY座標をオフセットして「台座の上に乗っている」状態を作る。左右対称に2体配置、当たり判定は台座の円コライダーを使用。

### 5. 石灯籠
`buildLantern`を`placeLantern(x,z,mode)`に置き換え、「Toro」モデルを使用。`mode`(lit/cold/dark)による光源のON/OFF・色は現状のロジックをそのまま踏襲(モデルの色を必要ならHSL調整)。

### 6. 手水舎
「Bowl」(Poly by Google)を水盤として使用。吊り電球+スイングアニメーションは、Bowlの上に浮かせる形で維持するかシンプルに省略するかは実装時に見た目で判断(屋根付き手水舎の専用フリーモデルは見つからなかったため簡略化する前提)。

### 7. しめ縄境界
実装時にもう一段調査(rope/vine/wooden post)。見つかった素材の組み合わせで、既存の`buildForbiddenBoundary`と同じ「杭を並べて縄を渡す」配置ロジック(既存コードのx座標割り出し部分)を流用し、個々のプリミティブメッシュ生成だけをフリーモデルの読み込み+配置に差し替える。

### 8. オブジェクト密度アップ
- 石灯籠を現状6基→12〜16基程度に増量、間隔を詰めすぎない程度に参道沿いに配置。
- Kay Lousbergの小さな祠2種を境内各所(木立の陰、脇広場等)に4〜6体散らし、密度と探索的な面白みを追加。
- 岩・茂みの`scatterProps`呼び出し個数を、拡張後の面積に比例して増やす(下記マップ拡張とセットで再計算、面積比に比例させすぎるとオブジェクト数が過大になり負荷が上がるため、密度は現状と同程度〜1.5倍程度に留め、単純に面積拡張分は「歩く距離が伸びる」効果を主として狙う)。
- kadomatsu(門松)を入口・本殿前などのアクセントに1〜2組。

### 9. マップ面積の拡張(現状比 約8〜10倍)
現状: 参道z=-3〜43(全長46m)× 参道幅15m(`CORRIDOR_HALF_W=7.5`、東側小広場のみ14m張り出し) ≒ 約740㎡。

新レイアウト(一直線の参道構成は維持、全長・全幅を拡張):
```
z = -5           参道開始(境界外扱いの余白)
z = 0 〜 55       千本鳥居風の連続する小鳥居ゾーン(sugamoの鳥居 x6〜9)
z = 60            目玉の鳥居(Japanese Torii、豪華な一の鳥居)
z = 65 〜 110      境内(石灯籠列・手水舎・岩/茂み/小さな祠・木立)
z = 110 〜 125     本殿への参道(キツネ像+台座を対で配置)
z = 130           本殿(Pagoda)
z = 135 〜 175     奥の院(無灯・木立を疎らに・張り詰めた空気)
z = 178           しめ縄+木杭の禁足地境界(現状通りハード境界)
```
全長 ≈ 183m(現状46mの約4倍)。`CORRIDOR_HALF_W`を7.5→16(全幅32m、現状15mの約2.1倍)に拡張。面積 ≈ 183×32 ≈ 5,856㎡ ≒ 現状の約7.9倍(「10倍くらい」の指示に対し概算で妥当な範囲、必要なら奥の院区間をさらに伸ばして微調整)。

`corridorBoundsAt(z)`の東側張り出し小広場は座標を新レイアウトのz範囲に合わせてスライドし、境内ゾーン(z=65〜110)の中に1箇所、奥の院ゾーン(z=135〜175)にもう1箇所追加して、隠れた一角を2箇所に増やす。

`PATH_MIN_Z`/`PATH_MAX_Z`/`MAP_RADIUS`等の定数、`groundGeo`(現状100x120のPlaneGeometry)のサイズも新しい全長・全幅に合わせて拡大する。

### 10. パフォーマンス配慮
面積・オブジェクト総数が増えるため、前回対応した軽量化(ライト数7灯維持、PIPのレンダーターゲットキャッシュ、キャラクター非ライティング化)は崩さない。新規オブジェクトの光源(灯籠の炎、祠のろうそく等)は現状同様「本当に光らせるのは一部だけ」の方針を維持し、ライト総数が大きく増えないよう調整する。木・岩と同様、大きな新オブジェクト(灯籠・祠・キツネ像等)にも当たり判定を付け、カメラの遮蔽レイキャスト(`shrineGroup`に対する既存のカメラオクルージョン処理)がそのまま機能することを確認する。

## 参照する既存コード
`controller.html`: `loadStaticGLB`/`normalizeToHeight`(モデル読込・正規化)、`colliders`/`resolveCollision`/`corridorBoundsAt`(当たり判定・境界)、`FREE_MODEL_CREDITS`/`refreshCreditsUI`(クレジット表示)、`_camRaycaster`によるカメラオクルージョン処理、`scatterProps`(散布ヘルパー、鳥居列配置にも同様のパターンを流用)。

## フリーモデルを効率的に探す方法(今後のセッション用メモ)

1. **主戦場は poly.pizza**(https://poly.pizza)。ログイン不要、CC0/CC-BYが明記され、`.glb`への直リンクが`https://static.poly.pizza/<uuid>.glb`の形でページのraw HTML内に直接埋め込まれている(`curl`で取得したHTMLから`grep -o 'https://static.poly.pizza/[^"]*\.glb'`で一発抽出可能)。検索は`https://poly.pizza/search/<query>`をcurlで取得し、`grep -oE 'href="/m/[^"]*"'`で候補一覧のID(`/m/<id>`)を列挙→各IDのページをcurlしてタイトル(`og:title`)とライセンス(`CC0`/`CC-BY`の文字列)を確認、というワークフローが機械的に回せる。
2. **ファイルサイズは`curl -sSI`(HEADリクエスト)の`content-length`で、ダウンロード前に確認できる**。
3. **見た目は必ず目視確認する**(タイトルや説明文だけで判断しない)。このセッションでは`/tmp`配下に軽量なthree.jsプレビューHTML(`preview.html`)+ Playwright実行スクリプト(`preview_run.js`)を即席で作り、候補モデルをGridHelper付きシーンにロードしてスクリーンショットを撮る、という手法で多数の候補を効率よく目視スクリーニングした。**モデルの奥行きが極端に薄い/巨大すぎるスケール(数千〜数万単位)の場合があるので、カメラのnear/farをモデルの実測バウンディングボックスに応じて動的に設定する**(固定near/farだと真っ黒/何も映らない画面になることがある)。
4. **プレビュー用HTTPサーバは本番のリポジトリディレクトリを汚さないよう、`/tmp`配下の隔離されたディレクトリで別ポートに立てる**(このセッションでは8934=リポジトリ本体、8935=プレビュー専用の一時モデル置き場、で完全に分離した)。plan modeなど「リポジトリに書き込み禁止」の制約下でも安全に候補評価ができる。
5. **有力な作者を覚えておくと検索が速い**: Quaternius・Kay Lousberg・Poly by Google(Googleの旧Poly資産)は軽量・CC0/CC-BYが多く実績あり。日本語ローマ字名のユーザー(例: sugamo)は和風モチーフの投稿が多い傾向があった。
6. **itch.ioやCGTrader/TurboSquidのアセット"パック"は基本的に有料、かつ数百MB級で「軽量」に反するため、このプロジェクトの用途では基本スキップしてよい**(Sketchfabの無料モデルはライセンスが緩い場合もあるが、ダウンロードにログインが要ることが多く、4Kテクスチャ2種同梱など重いことも多いので個別に要検証)。
7. **検索語は日本語ローマ字/英語両方、かつ対象そのものだけでなく類語・上位/下位概念でも試す**(例: 「komainu」で見つからなければ「guardian dog」「fox statue」、「shrine」で理想のものがなければ「pagoda」「temple」、「shimenawa」がなければ「rope」「stone platform」等)。今回はこの横展開で本殿代替(pagoda)や台座(pebble square)を発見できた。

## 検証方法
1. `python3 -m http.server`でリポジトリ配信、Playwrightで`controller.html`サンプルモードを開く。
2. 各新規オブジェクト設置点へ`window.__ghostController.setCharPos(x,z)`でテレポートしスクリーンショット確認(鳥居列、目玉鳥居、本殿、キツネ像+台座、灯籠、祠、境界)。
3. 鳥居の向き: 参道を実際にWキーで歩いて各鳥居に正面から近づき、アーチをくぐる形で見えるか(横向きになっていないか)をスクリーンショットで確認。
4. 新しい`corridorBoundsAt`の境界・当たり判定(大きな岩・灯籠・祠・キツネ像の台座)が機能し、キャラ/カメラがオブジェクトに埋まらないことを確認(前回と同じ手法:カメラオクルージョンレイキャストの動作確認込み)。
5. 面積拡張後もフレームレート体感が大きく落ちないこと(ライト数・オブジェクト総数の増加が過大でないか)を確認。
6. configパネルのクレジット欄に新規使用モデルがすべて表示されること。
7. 読み込み失敗時(意図的にURLを壊すテスト)にフォールバックなしで単にそのオブジェクトが出ないだけであること(procedural fallbackが本当に無くなったこと)を確認。
