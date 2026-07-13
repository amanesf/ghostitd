// -*- coding: utf-8 -*-
// 3Dtool(Python版)pipeline_lib/common.pyのJS移植 + 座標ヘルパー。
// ブラウザ完結版(3DtoolJS)の全モジュールが読む共通ユーティリティ。
// window.P3D 名前空間にぶら下げる(素朴な<script>読み込みなのでESモジュール不使用)。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

// ---- モデル生成パラメータの既定値 ----
// Python版(pipeline_lib/common.py)はbody_vox=0.002/body_target_verts=50000だが、
// ブラウザ版はvox解像度に応じたraw頂点数がJSの素朴なmarching cubesループの
// 速度に直結する。そのため3DtoolJS版はbody_voxを粗め(0.005)にし、大抵の
// キャラクターでraw頂点数を抑えることを狙う既定値にしていたが(2026-07-04)、
// その後ファイルサイズ/軽量性を優先する方針に変更し、body_target_verts/
// acc_target_vertsは大きく引き下げて積極的に間引く既定値にしている
// (2026-07-06)。
// ★2026-07-12(SIMPLIFY_DECIMATE_PLAN.md): three.js SimplifyModifierが
// 大規模メッシュ(数万頂点超)で"Cannot read properties of undefined
// (reading 'hasVertex')"を投げて不安定になる不具合の根本原因(mergeVertices
// 後に残る縮退三角形を除外していなかったこと)を修正し、頂点数によらず常に
// SimplifyModifierを使うようにした(js/carving.jsのdecimateMesh参照、
// gridClusterDecimateは例外発生時のみの最終フォールバックになった)。これに
// 伴い、間引きの設定も「目標頂点数を決め打ちする」方式から「間引きの強さ
// (0〜1、内部でSimplifyModifierの許容誤差maxCostに変換する)を指定し、結果の
// 頂点数は表示するだけ」という誤差ベースの方式に変更した。
var DEFAULT_GEN_PARAMS = {
  body_vox: 0.003,
  // ★2026-07-10: 体+全アクセサリーを1つの共有ボクセルグリッドで統合彫刻する
  // 方式に変更したため(js/pipeline.jsのrunCarvingStages/js/carving.jsの
  // carveUnifiedRegions参照)、実際のグリッド解像度はbody_voxのみで決まる。
  // acc_voxは旧・独立彫刻方式の名残で現在は未使用(js/accessories.jsの
  // 後方互換用stageAccessoriesだけが参照する)。生成器UIからも削除済み。
  acc_vox: 0.003,
  // ★2026-07-10: 既定の間引き後頂点数(3000/1000)だと、特に顔まわり・
  // アクセサリーの折り目等で三角面のカクつき(ローポリ感)が目立つとの指摘
  // により、body/accともに10000へ引き上げた(ユーザー指摘)。
  // ★2026-07-11(ユーザー指摘「パーツ分割のタイミングが早すぎる」対応):
  // 体+全アクセサリーを間引き・平滑化が終わるまで1枚の連続したメッシュの
  // まま扱うよう変更した(js/pipeline.jsのdecimateStage/meshFinishStage
  // 参照)。境界を共有する頂点に別々の強さを適用すること自体が矛盾するため、
  // body_decimate/acc_decimateとbody_target_verts/acc_target_vertsを
  // それぞれ1本の値に統合した(ユーザー承認済み。パーツ別の強弱調整は
  // 失われるトレードオフ)。
  // ★2026-07-12: target_verts(目標頂点数)をdecimate_strength(間引きの強さ、
  // 0〜1)に置き換えた(js/carving.jsのstrengthToMaxCost参照)。0.85は、体単体
  // (生彫刻84,076頂点)の実測でstrengthToMaxCostが旧既定値(target_verts=
  // 10000)とほぼ同じ結果頂点数(実測11,394)になる値。体+全アクセサリー
  // 統合メッシュ(163,982頂点)では同じ0.85でも旧既定値より頂点数が多く残る
  // (誤差ベースになったことで、体より細いアクセサリーが道連れで過度に
  // 削られなくなったため。SIMPLIFY_DECIMATE_PLAN.mdの発端そのものの改善)。
  decimate: true, decimate_strength: 0.85,
  // ★2026-07-06: 断面スーパー楕円の指数はこれまで全身共通(psq_hull)の1個
  // だったが、部位ごとに理想的な丸み/角ばりが異なる(頭は卵型に近く丸め、
  // 腕は円筒に近いほど自然、手は厚み一定の板に近いため角を立たせたい等)
  // ため部位別に分割する。左右対称な部位(腕/脚/手)はL/Rで値を分けず1個の
  // パラメータを共有する(見た目上、体の対称性を壊す理由がないため)。
  // 各既定値は現行の2.2(楕円と矩形の中間よりやや矩形寄り)を基準に、
  // 部位の実際の断面形状に合わせて調整したオススメ値。
  // ★2026-07-10: psq_headは2.0→5に変更(ユーザー指摘)。値が大きいほど
  // 断面は卵型より四角形に近づく(このファイル内のPARAM_META該当desc参照)。
  // ★2026-07-11: 顔・前髪の丸みをかなり四角形寄りにしたいとの指摘を受け、
  // psq_headを5→6(上限値)に引き上げた。
  // ★2026-07-12(ユーザー指摘「まとめて設定は意味がない」): 以前は全
  // アクセサリー共通のpsq_acc(全アクセサリーに等しく効く「まとめて設定」)
  // を基本にし、必要な場合だけアクセサリー個別に上書きする方式だったが、
  // 「アクセサリーごとに理想的な丸みが違うのが前提なのだから、まとめて
  // 設定できても意味がない」との指摘を受け、psq_acc(全体共通のまとめ設定)
  // 自体を廃止した。各アクセサリーは必ず個別のpsq値を持つ(js/accessories.js
  // 参照、未設定の場合の安全側フォールバックのみ残す)。
  psq_head: 6, psq_torso: 2.2, psq_legs: 2.2, psq_arms: 2.0, psq_hands: 3.0,
  // ★2026-07-10: track_gap(track追跡の行許容ギャップ)は、js/carving.jsの
  // track判定を連結成分ラベリングに置き換えたことで不要になったため廃止した。
  track_win: 1,
  // ★2026-07-11追加(ユーザー指摘「パーツ内部が隙間だらけ」の実測調査で判明):
  // 手前の房が奥の房を隠す描き方で色分けマップに残る数px〜十数px幅の隙間を、
  // track判定(連結成分ラベリング)の前にモルフォロジーclosingで埋める半径
  // (px)。実サンプルで実測した最悪ケース(約10px)を余裕を持って埋められる値。
  // 0で無効(従来の挙動に戻る)。
  track_gap_close_px: 6,
  // ★2026-07-12追加(ユーザー指摘「房が分かれているところの顔が切り抜けて
  // ない」対応): js/carving.jsのbuildDepthByRow()は元々、1行内にside画像の
  // ランが複数あっても常に前端〜後端をまるごと包む1本の奥行き区間に合成
  // していた(2026-07-04、顎先が首との間の隙間で分断されて消える不具合の
  // 対策として導入)。しかしこの「常に合成」は、前髪の房と顔のように、
  // 本来奥行き方向で別々の物体(房が手前、顔がその奥に覗く)even奥行きの
  // runが複数あるケースまで一緒くたに1枚の奥行きスラブへ均してしまい、
  // 房と顔が癒着して見える原因になっていた。連結成分ラベリング(track_gap_
  // close_pxと同じ仕組み)をside画像のラスタにも適用し、「同じ塊とみなせる
  // 隙間(この値未満)」だけ合成し、「本当に別の塊」は別々の奥行き区間として
  // 保持するようにした。顎先/首のような実在の小さい隙間はこの値で埋めて
  // 従来通り連続面として彫り、房と顔のような大きい隙間は分断されたまま
  // 別々に彫られる。0で無効(隙間があれば常に別々の区間として扱う)。
  depth_gap_close_px: 6,
  // ★2026-07-11: 上記target_vertsと同じ理由(統合メッシュとして1回だけ
  // 平滑化する)でbody_smooth_iters/acc_smooth_itersを1本に統合した。
  smooth_iters: 0,
  // ★2026-07-10: landmark_tool.htmlは以前このオブジェクトを丸ごとコピーした
  // 独自定義を持っており(「値を一致させる」というコメントで手動同期の前提に
  // なっていた)、そちらにだけrigid_soft_widthが存在しこちらには無いという
  // 食い違いが生じていた(ユーザー指摘により発覚)。landmark_tool.htmlは
  // このP3D.DEFAULT_GEN_PARAMSを直接参照する形に統一したため、ここが唯一の
  // 定義元になる。
  rigid_soft_width: 0,
  arm_circle: true, arm_tol: 0.06, arm_max_hw: 0.2,
  hand_extrude: true, hand_depth: 0.01, hand_max_hw: 0.1, hand_len: 0.25,
  alpha_dilate: 9,
  // ★2026-07-11追加(切り抜き精度向上、point3): にじみ(bleedEdges)の起点を
  // 輪郭ぎりぎり(0)ではなく、この分だけ内側へ侵食した「安全な内部色」から
  // 取るようにする(元イラストの黒い縁取りストロークをにじみが外側へ延長して
  // 太らせてしまう不具合の対策)。0で従来通り輪郭ぎりぎりから。
  bleed_inset_px: 2,
  // ★2026-07-09: 全身のシルエットも色分けマップ由来の抽出方式に統一した
  // (js/pipeline.jsのrunCarvingStages参照)。
  // ★2026-07-11: body_color_tolerance(体色=黒との色許容誤差)は最近傍色分類
  // (P3D.classifySilhouetteRaw)への置き換えに伴い廃止した(体・全アクセサリー
  // 色を候補とした分類のみで境界が確定的に決まるため、tolerance自体が不要)。
  // ★2026-07-11追加: 体シルエットの行スキャン(front/back/side幅・奥行き測定)
  // で、最近傍色分類の境界をサブピクセル補間する(P3D.boundaryContForCandidate、
  // js/carving.jsのcarveRegion内faCont/baCont/saCont参照)。旧・輝度しきい値
  // ベースのサブピクセル補正(findRunsSubpixel)は色分けマップに適用すると境界が
  // 暴れる不具合があったため撤回した実績があるが、これは色分類そのものに
  // 対応した別方式のため、様子を見て問題があればfalseで無効化できるように
  // トグルとして残す。
  subpixel_edges: true,
  kb_per_face: 200,
  // ★2026-07-05: 背面/側面写真はそれぞれ別に撮影/作画されるため、前面基準の
  // CX/SCALE/YBOTをそのまま流用(鏡像)する彫り出し/テクスチャ変換に、
  // 素材ごとの微妙なズレが残ることがある。自動推定(シルエット計測)は
  // 後れ毛等のノイズを拾って余計に暴れることが分かったため、シルエット
  // 解析による自動補正はせず、ユーザーが実際の見た目を見ながら手で追い込める
  // 単純な定数pxオフセットとして用意する(既定0=補正なし)。
  back_offset_x: 0, back_offset_y: 0,
  side_offset_x: 0, side_offset_y: 0,
  // ★2026-07-09(左右非対称キャラ対応): leftSide(左向き側面)画像用のズレ補正。
  // 意味・既定値ともside_offset_x/yと同じ(js/accessories.jsのcurSideOffsetX/Y参照)。
  leftside_offset_x: 0, leftside_offset_y: 0,
  // ★2026-07-11追加(顔の立体感対応): 目窩(眼球が収まる凹み)はfront/back/side
  // どのシルエット輪郭にも現れない内部形状のため、彫刻済みの頭部表面から
  // 局所的に凹ませても輪郭(=元イラストの実測データ)とは矛盾しない
  // (js/carving.jsのapplyEyeSocketRecess参照)。鼻は中心線上にあり側面画像の
  // 実測奥行きが既に出ているため、独自の突起を足すと側面イラストと食い違う
  // ことが判明し、対象にしないことにした(ユーザー指摘)。
  // face_sculpt=falseで無効化できる(landmarkが無い場合も自動的にスキップされる)。
  face_sculpt: true,
  eye_socket_depth: 0.008, eye_socket_radius_x: 0.022, eye_socket_radius_y: 0.018,
  // ★2026-07-12追加(ユーザー指摘「45度から見たらパーツ間隙間が開く」対応):
  // 体+全アクセサリーは1つの共有ボクセルグリッドへ統合彫刻されるが、各パーツの
  // フィールドはそのパーツ自身のfront/side/back画像だけから独立に作られるため、
  // 前後側面3方向どの投影でも輪郭が一致して見えても、その間の斜め方向には
  // 「どちらのパーツの表面も届いていない」隙間が実際にできることがある
  // (js/carving.jsのcarveSdfField/carveUnifiedRegions参照)。owner_blendを
  // ONにすると、パーツ境界で「2パーツの値が同じボクセルで競合しており、かつ
  // 両方とも表面近傍(owner_blend_strengthで決まる半径以内)」という条件に
  // 一致するボクセルだけをsmooth-maxでなだらかに橋渡しする。
  // ★2026-07-13(ユーザー指摘「効果がなさすぎる」対応): 実測(163,982頂点の
  // サンプル)でこの条件に該当したのはわずか34頂点で、体感できるほどの効果は
  // 出ないことが確認された。owner_blendが埋められるのは「2パーツの表面が
  // ほんの僅かに(同一ボクセル内で)離れているだけ」という限定的なケースのみで、
  // ツインテール付け根のような「遮蔽でシルエットデータ自体が欠落している」
  // ケース(=そもそも競合するボクセルが存在しない)には無力(bone_bridge
  // 参照)。効果の割に「意図的な境目(生え際と地肌の継ぎ目等)まで丸まる」
  // 副作用のリスクだけが残るため、既定OFFの実験的機能とした。
  owner_blend: false, owner_blend_strength: 0.4,
  // ★2026-07-13追加(ユーザー指摘「ツインテールの付け根で隙間が空く」対応):
  // owner_blendの小さいブレンド半径では、遮蔽(例: ツインテールが後ろ髪の
  // 一部を覆い隠す)によってシルエットそのものが欠落したパーツ同士の隙間は
  // 埋まらない(実測で確認: 競合ボクセルの値差が2を超えるケースがあり、
  // owner_blend単体では橋渡しできなかった)。bones(付け根の骨、例えば
  // ツインテール・後ろ髪はともに"head")を共有するパーツ同士に限り、front/back
  // (幅)とside(奥行き)の両方で同時に隙間なく隣接している行だけを「本当に
  // 3D的に接している」と確信し、その行だけ実際にボクセルへ材質を書き込んで
  // 橋渡しする(js/carving.jsのcomputeRowExtents/computeBoneBridgeRows/
  // applyBoneBridgeFill、js/pipeline.jsのrunCarvingStages参照)。ツインテール
  // 付け根での隙間解消は目視確認済みだが、埋めた箇所が箱型(軸並行の矩形)の
  // パッチになり近くで見るとやや不自然に見える場合があること、実績が浅いことから、
  // 既定はOFFとし使いたい場合は設定タブから有効化する実験的機能とする
  // (ユーザー指示「一旦デフォルトオフで」)。
  bone_bridge: false,
};
P3D.DEFAULT_GEN_PARAMS = DEFAULT_GEN_PARAMS;

// ---- 行ラン検出(common.find_runs/find_runs_subpixelのJS移植) ----
// mask: Uint8Array/Array(0/1 or bool), gap: 許容ギャップ(px)
function findRuns(mask, gap){
  gap = gap || 1;
  var out=[], n=mask.length, s=-1, p=-1;
  for(var x=0;x<n;x++){
    if(mask[x]){
      if(s<0){s=x;p=x;}
      else if(x<=p+gap){p=x;}
      else{ out.push([s,p]); s=x; p=x; }
    }
  }
  if(s>=0) out.push([s,p]);
  return out;
}
P3D.findRuns = findRuns;

function subpixelEdge(cont, iIn, iOut, thr){
  var vIn=cont[iIn], vOut=cont[iOut];
  if(vOut===vIn) return iIn;
  var t=(thr-vIn)/(vOut-vIn);
  if(t<0)t=0; if(t>1)t=1;
  return iIn + t*(iOut-iIn);
}
// mask: 2値run検出用, cont: 2値化前の連続値(min(R,G,B)等), thr: 2値化しきい値
function findRunsSubpixel(mask, cont, thr, gap){
  var runs=findRuns(mask, gap);
  var n=mask.length, out=[];
  for(var i=0;i<runs.length;i++){
    var s=runs[i][0], e=runs[i][1];
    var rs = (s-1>=0) ? subpixelEdge(cont, s, s-1, thr) : s;
    var re = (e+1<n) ? subpixelEdge(cont, e, e+1, thr) : e;
    out.push([rs, re]);
  }
  return out;
}
P3D.findRunsSubpixel = findRunsSubpixel;

// ---- 数値ヘルパー ----
function median(arr){
  if(!arr.length) return 0;
  var a=arr.slice().sort(function(x,y){return x-y;});
  var n=a.length, mid=n>>1;
  return (n%2) ? a[mid] : (a[mid-1]+a[mid])/2;
}
P3D.median = median;

// np.interp相当: xp昇順前提、xpの範囲外はクランプ(np.interpのデフォルトと同じ)
function interp1d(x, xp, fp){
  var n=xp.length;
  if(x<=xp[0]) return fp[0];
  if(x>=xp[n-1]) return fp[n-1];
  // 二分探索
  var lo=0, hi=n-1;
  while(hi-lo>1){
    var mid=(lo+hi)>>1;
    if(xp[mid]<=x) lo=mid; else hi=mid;
  }
  var t=(x-xp[lo])/(xp[hi]-xp[lo]);
  return fp[lo] + t*(fp[hi]-fp[lo]);
}
P3D.interp1d = interp1d;

// エッジパディングの移動平均(profile.py/skeleton.pyの sm()/smooth1() 相当)
function smoothEdgePad(arr, win){
  win = win || 5;
  var n=arr.length;
  if(n < Math.max(6, win+1)) return arr.slice();
  var k = win>>1;
  var out = new Array(n);
  for(var i=0;i<n;i++){
    var a=Math.max(0,i-k), b=Math.min(n,i+k+1);
    var s=0; for(var j=a;j<b;j++) s+=arr[j];
    out[i]=s/(b-a);
  }
  return out;
}
P3D.smoothEdgePad = smoothEdgePad;

// ---- 座標変換(common.py MX/MY/py_of/spy_ofのJS移植) ----
function MX(px, cx, scale){ return (px-cx)/scale; }
function MY(py, ybot, scale){ return (ybot-py)/scale; }
function pyOf(v, ytop, ybot){ return Math.round(ytop + v*(ybot-ytop)); }
function spyOf(v, sytop, sybot){ return Math.round(sytop + v*(sybot-sytop)); }
P3D.MX=MX; P3D.MY=MY; P3D.pyOf=pyOf; P3D.spyOf=spyOf;

// ---- 画像 -> ImageData取得ヘルパー ----
function imageToImageData(img, w, h){
  w = w || img.naturalWidth || img.width;
  h = h || img.naturalHeight || img.height;
  var c=document.createElement("canvas"); c.width=w; c.height=h;
  var ctx=c.getContext("2d"); ctx.drawImage(img,0,0,w,h);
  return ctx.getImageData(0,0,w,h);
}
P3D.imageToImageData = imageToImageData;

// ---- 連結成分の穴埋め(scipy.ndimage.binary_fill_holesのJS簡易版) ----
// mask: Uint8Array(w*h) 1=前景。外周から辿れない0領域(=穴)を1で埋める。
function fillHoles(mask, w, h){
  var n=w*h;
  var outside=new Uint8Array(n); // 1=外周から辿れる背景(=真の外側)
  var visited=new Uint8Array(n);
  var stack=[];
  function push(idx){ if(!visited[idx] && !mask[idx]){ visited[idx]=1; stack.push(idx);} }
  for(var x=0;x<w;x++){ push(x); push((h-1)*w+x); }
  for(var y=0;y<h;y++){ push(y*w); push(y*w+(w-1)); }
  while(stack.length){
    var idx=stack.pop(); outside[idx]=1;
    var x=idx%w, y=(idx/w)|0;
    if(x>0) push(idx-1); if(x<w-1) push(idx+1);
    if(y>0) push(idx-w); if(y<h-1) push(idx+w);
  }
  var out=new Uint8Array(n);
  for(var i=0;i<n;i++) out[i] = mask[i] ? 1 : (outside[i] ? 0 : 1);
  return out;
}
P3D.fillHoles = fillHoles;

// ---- 一定面積以上の連結成分を全て残す(4連結、OR合成) ----
// ★2026-07-09: 以前あった「最大成分1つだけを残す」largestComponent()は、
// キャラクターのシルエットが常に単一の連結領域であるという前提に依存して
// おり、除外範囲(exclude_masks)がスカート等の連結部分を削ると胴体と脚が
// 分断され、小さい方(脚側)が丸ごと消えるバグを引き起こしていた
// (loadRgbaRemoveWhite参照)。同一色に塗られた領域が画面内で複数の孤立した
// 塊に分かれるケース(左右別々の房が同色指定、体の別パーツに隠れて視覚的に
// 分断されている等)でも同様に小さい方の塊が失われる。シルエットは最初から
// 複数の領域に分かれうる前提でロジックを組み、minAreaPx未満の成分だけを
// アンチエイリアス境界のノイズとみなして除外し、それ以外の成分は全て
// OR合成して残す方式(GHOST_SCANNER_PLAN.md「色分けマップ方式・運用面の
// 修正6点・②」で色分けマップ抽出用に導入済みだったもの)に、body本体の
// シルエット検出も統一する。
function significantComponentsMask(mask, w, h, minAreaPx){
  minAreaPx = (minAreaPx===undefined || minAreaPx===null) ? 16 : minAreaPx;
  var n=w*h;
  var label=new Int32Array(n).fill(-1);
  var labelSize={};
  var stack=[];
  for(var start=0; start<n; start++){
    if(!mask[start] || label[start]!==-1) continue;
    var lab=start, size=0;
    stack.push(start); label[start]=lab;
    while(stack.length){
      var idx=stack.pop(); size++;
      var x=idx%w, y=(idx/w)|0;
      var nbrs=[];
      if(x>0)nbrs.push(idx-1); if(x<w-1)nbrs.push(idx+1);
      if(y>0)nbrs.push(idx-w); if(y<h-1)nbrs.push(idx+w);
      for(var k=0;k<nbrs.length;k++){
        var ni=nbrs[k];
        if(mask[ni] && label[ni]===-1){ label[ni]=lab; stack.push(ni); }
      }
    }
    labelSize[lab]=size;
  }
  var out=new Uint8Array(n);
  for(var i=0;i<n;i++){
    var lab=label[i];
    if(lab>=0 && labelSize[lab]>=minAreaPx) out[i]=1;
  }
  return out;
}
P3D.significantComponentsMask = significantComponentsMask;

// ★2026-07-09(左右非対称キャラ対応): leftSide(左向き側面)画像は、side
// (右向き側面)と全く同じ座標変換式(SIDE_REF起点の(px-SIDE_REF)/SCALE)を
// 再利用できるよう、読み込み時点で水平反転して「characterが右を向いている」
// という既存の規約に合わせる。これによりcarveRegion/sidePointsToModel等、
// 既存の彫刻コードを一切変更せずにleftSide由来のアクセサリーを彫れる。
function flipAlphaHorizontal(alpha, w, h){
  var out=new Uint8Array(w*h);
  for(var y=0;y<h;y++){
    var row=y*w;
    for(var x=0;x<w;x++){ out[row+(w-1-x)] = alpha[row+x]; }
  }
  return out;
}
P3D.flipAlphaHorizontal = flipAlphaHorizontal;
// pxBbox: [x0,y0,x1,y1](画像ピクセル座標)。flipAlphaHorizontalと対になる、
// 同じ水平反転をbboxに適用する版。
function flipBboxHorizontal(bbox, w){
  return [w-bbox[2], bbox[1], w-bbox[0], bbox[3]];
}
P3D.flipBboxHorizontal = flipBboxHorizontal;

// ---- 色分けマップからのマスク抽出(GHOST_SCANNER_PLAN.md「色分けマップ」方式) ----
// アクセサリー領域抽出を「1件ずつ座標を当てさせる」方式から、front/side/back
// 各1枚の色分けマップ画像(体=黒、背景=白、各accessory=パレット色でベタ塗り)
// をGeminiの画像編集で生成し、こちら側のcanvas処理で色ごとに走査して
// マスクを機械的に算出する方式に変更した際に追加。多角形化(輪郭追跡)は
// 行わず、ラスタマスクのまま保持する(多角形手動編集とは別データ形式として
// 並存させる、GHOST_SCANNER_PLAN.md「データモデル」節)。
// hex: "#rrggbb" -> [r,g,b]
function hexToRgb(hex){
  var m = /^#?([0-9a-fA-F]{6})$/.exec(hex||"");
  if(!m) return [0,0,0];
  var n = parseInt(m[1],16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}
P3D.hexToRgb = hexToRgb;

// ★2026-07-11: 各色を独立にEuclidean色距離+tolerance判定するcolorRegionRawMask/
// extractMaskFromColormap/loadAlphaFromColormap(旧方式)は、最近傍色分類
// (classifySilhouetteRaw、下記)への置き換えに伴い呼び出し元が無くなったため
// 削除した。単一色の判定結果組み立て部分(bbox算出+マスクcanvas化)は
// packRawMaskToResultとして残し、新方式からも共通利用する。
//
// 戻り値: {maskDataUrl, bbox:[x0,y0,x1,y1](ピクセル座標、y0<y1)} | null
// (該当色の画素が1つも無ければnull)。一定面積以上の連結成分を全てOR合成して
// 採用する(GHOST_SCANNER_PLAN.md「運用面の修正6点・②」。以前は最大成分1つ
// だけを採用しており、同一色の領域が複数の孤立した塊に分かれるケースで
// 小さい方が失われていた)。
function packRawMaskToResult(comp, w, h){
  var x0=w, x1=-1, y0=h, y1=-1, any=false;
  for(var y=0;y<h;y++){
    for(var x=0;x<w;x++){
      if(comp[y*w+x]){
        any=true;
        if(x<x0)x0=x; if(x>x1)x1=x;
        if(y<y0)y0=y; if(y>y1)y1=y;
      }
    }
  }
  if(!any) return null;
  var maskCanvas = document.createElement("canvas");
  maskCanvas.width=w; maskCanvas.height=h;
  var mctx = maskCanvas.getContext("2d");
  var mid = mctx.createImageData(w,h);
  for(var q=0;q<comp.length;q++){
    var v = comp[q] ? 255 : 0;
    mid.data[q*4]=255; mid.data[q*4+1]=255; mid.data[q*4+2]=255; mid.data[q*4+3]=v;
  }
  mctx.putImageData(mid,0,0);
  return { maskDataUrl: maskCanvas.toDataURL("image/png"), bbox:[x0,y0,x1+1,y1+1] };
}
P3D.packRawMaskToResult = packRawMaskToResult;

// ---- 最近傍色分類によるマスク抽出(2026-07-11) ----
// ★2026-07-10までの体(全身)シルエット抽出は、色分けマップの黒(体色)のみと
// 一致する画素だけを対象にする方式(loadAlphaFromColormap、廃止済み)だった。
// マフラー/スカートで覆われた行では体シルエットが途切れ、visual hullが頭部/
// 脚を独立した閉曲面として彫ることがあるが、この分断自体は許容する
// (js/carving.jsのdropSmallFragments/computeNormalsFixWindingを連結成分単位で
// 処理するよう修正済み。js/visual_hull.jsのminFragFrac参照)。
// 体・各アクセサリーをそれぞれ独立に「その色との距離がtolerance以内か」で
// 判定する従来方式(colorRegionRawMask、廃止済み)は、境界の陰影(グラデー
// ション)幅がtoleranceを超えると「どちらの判定にも入らない未確定画素」を生み、
// fillColorGaps(廃止済み)で事後に埋める必要があった。色分けマップは本来、体・各
// アクセサリー・背景をそれぞれ単色フラットで塗り分けている(のはず)なので、
// 各画素を「既知の色候補のうちどれに一番近いか」で分類(最近傍色分類=
// 単純なボロノイ分割)すれば、必ずいずれか1つの候補に確定的に割り当たり、
// 未確定画素の帯そのものが原理的に発生しない(tolerance/fillColorGaps不要)。
// candidates: [[r,g,b], ...] 全候補色。背景を含めないと、体/アクセサリーの
// 実際には無い背景領域まで最寄りの色として割り当てられ、シルエットが輪郭の
// 外側へ膨張してしまうため、呼び出し元は必ず背景色を候補に含めること。
// 戻り値: Int32Array(w*h)、各画素が最も近い候補のindex。
function classifyColorsNearest(ctx, w, h, candidates){
  var id = ctx.getImageData(0,0,w,h);
  var data = id.data;
  var n = w*h;
  var labels = new Int32Array(n);
  var nc = candidates.length;
  for(var i=0,p=0; i<data.length; i+=4,p++){
    var r=data[i], g=data[i+1], b=data[i+2];
    var bestI=0, bestD=Infinity;
    for(var c=0;c<nc;c++){
      var tc=candidates[c];
      var dr=r-tc[0], dg=g-tc[1], db=b-tc[2];
      var dd=dr*dr+dg*dg+db*db;
      if(dd<bestD){ bestD=dd; bestI=c; }
    }
    labels[p]=bestI;
  }
  return labels;
}
P3D.classifyColorsNearest = classifyColorsNearest;

// classifyColorsNearestの戻り値からidx番の候補のみを1とする2値マスクを作る。
function maskFromLabels(labels, idx){
  var n=labels.length, out=new Uint8Array(n);
  for(var i=0;i<n;i++) out[i] = (labels[i]===idx) ? 1 : 0;
  return out;
}
P3D.maskFromLabels = maskFromLabels;

// 体色(既定黒)+全アクセサリー色を1回の最近傍分類で一括抽出する(体と
// アクセサリーが同じ分類結果から導かれるため、境界が構造的に一致し隙間が
// 生じない)。背景("#ffffff")を候補0として自動的に含める。
// accessoryColorHexes: ["#rrggbb", ...] (体以外の全アクセサリーの色。この
// ビューで使われていない色を含めても、単にどの画素からも選ばれないだけで
// 実害は無い)
// 戻り値: {bodyRaw:Uint8Array, accRaw:[Uint8Array,...]}
// (significantComponentsMask適用前の生マスク。呼び出し元がminAreaPxで仕上げる)
function classifySilhouetteRaw(ctx, w, h, bodyColorHex, accessoryColorHexes){
  bodyColorHex = bodyColorHex || "#000000";
  accessoryColorHexes = accessoryColorHexes || [];
  var candidates = [hexToRgb("#ffffff"), hexToRgb(bodyColorHex)].concat(
    accessoryColorHexes.map(hexToRgb));
  var labels = classifyColorsNearest(ctx, w, h, candidates);
  var bodyRaw = maskFromLabels(labels, 1);
  var accRaw = accessoryColorHexes.map(function(_, i){ return maskFromLabels(labels, i+2); });
  return {bodyRaw:bodyRaw, accRaw:accRaw};
}
P3D.classifySilhouetteRaw = classifySilhouetteRaw;

// ---- 最近傍色分類のサブピクセル境界補正(2026-07-11) ----
// 旧subpixelEdge/findRunsSubpixel(js/common.js冒頭)は「1個の連続値(輝度等)が
// 固定しきい値を跨ぐ点」を線形補間するもので、白背景の写真専用だった
// (colormap由来の2値マスクに適用すると境界が暴れることが分かり撤回済み、
// 上部のコメント参照)。ここでは色分けマップの最近傍色分類そのものに
// 素直に対応するサブピクセル指標を作る: 画素pについて
//   cont[p] = (own候補以外で最も近い候補までの距離) - (own候補までの距離)
// と定義すると、cont>0はpがown候補側(内側)、cont<0は他候補側(外側)、
// cont=0がちょうど最近傍色分類の境界(ボロノイ境界)と一致する。境界の
// アンチエイリアス画素は前後2色の単純な線形混合(pixel=(1-t)*own+t*other、
// t=0でown、t=1でother)である前提を置くと、cont(t)=(1-2t)*|other-own|に
// なりt=0.5(混合率半々)でちょうどcont=0を通るため、findRunsSubpixelの
// 「thr=0を跨ぐ点を線形補間する」という既存の仕組みにそのまま載せられる
// (subpixelEdge(cont,iIn,iOut,thr=0)呼び出し側がwhiteThr:0を渡す)。
// candidates: classifyColorsNearestと同じ候補配列。ownIdx: この領域の候補index。
// 戻り値: Float32Array(w*h)。
function boundaryContForCandidate(ctx, w, h, candidates, ownIdx){
  var id = ctx.getImageData(0,0,w,h);
  var data = id.data;
  var n = w*h;
  var out = new Float32Array(n);
  var nc = candidates.length;
  var own = candidates[ownIdx];
  for(var i=0,p=0; i<data.length; i+=4,p++){
    var r=data[i], g=data[i+1], b=data[i+2];
    var dr0=r-own[0], dg0=g-own[1], db0=b-own[2];
    var distOwn = Math.sqrt(dr0*dr0+dg0*dg0+db0*db0);
    var distOther = Infinity;
    for(var c=0;c<nc;c++){
      if(c===ownIdx) continue;
      var tc=candidates[c];
      var dr=r-tc[0], dg=g-tc[1], db=b-tc[2];
      var dd=Math.sqrt(dr*dr+dg*dg+db*db);
      if(dd<distOther) distOther=dd;
    }
    out[p] = distOther - distOwn;
  }
  return out;
}
P3D.boundaryContForCandidate = boundaryContForCandidate;

// classifySilhouetteRawと対になる、体+全アクセサリーのサブピクセル境界指標
// (boundaryContForCandidate)を同じ候補構成で一括算出する。
// 戻り値: {bodyCont:Float32Array, accCont:[Float32Array,...]}
function classifySilhouetteCont(ctx, w, h, bodyColorHex, accessoryColorHexes){
  bodyColorHex = bodyColorHex || "#000000";
  accessoryColorHexes = accessoryColorHexes || [];
  var candidates = [hexToRgb("#ffffff"), hexToRgb(bodyColorHex)].concat(
    accessoryColorHexes.map(hexToRgb));
  var bodyCont = boundaryContForCandidate(ctx, w, h, candidates, 1);
  var accCont = accessoryColorHexes.map(function(_, i){ return boundaryContForCandidate(ctx, w, h, candidates, i+2); });
  return {bodyCont:bodyCont, accCont:accCont};
}
P3D.classifySilhouetteCont = classifySilhouetteCont;

// flipAlphaHorizontalの型非依存版(Float32Array等、任意のTypedArrayに使える)。
function flipArrayHorizontal(arr, w, h){
  var out = new arr.constructor(w*h);
  for(var y=0;y<h;y++){
    var row=y*w;
    for(var x=0;x<w;x++){ out[row+(w-1-x)] = arr[row+x]; }
  }
  return out;
}
P3D.flipArrayHorizontal = flipArrayHorizontal;

// alpha(Uint8Array(w*h)、1=前景)からピクセルbbox([x0,y0,x1,y1]、x1/y1は
// 排他的な右下)を求める。前景画素が無ければnull。
function bboxFromAlpha(alpha, w, h){
  var x0=w,x1=-1,y0=h,y1=-1,any=false;
  for(var y=0;y<h;y++){
    var rowOff=y*w;
    for(var x=0;x<w;x++){
      if(alpha[rowOff+x]){
        any=true;
        if(x<x0)x0=x; if(x>x1)x1=x;
        if(y<y0)y0=y; if(y>y1)y1=y;
      }
    }
  }
  if(!any) return null;
  return [x0,y0,x1+1,y1+1];
}
P3D.bboxFromAlpha = bboxFromAlpha;

// マスクdataURL(白RGB+アルファ=前景)からUint8Array(w*h, 1=前景)を復元する
// (3D彫刻側/範囲計算側で真偽画素配列として扱いたい箇所向けのヘルパー)。
function maskDataUrlToAlpha(ctx, w, h, maskDataUrl){
  // 呼び出し元はPromiseベースで画像読み込み後にこれを呼ぶ想定(同期版)。
  // ここでは既にdrawImage済みのctxからアルファチャンネルだけ読む単純な実装にする。
  var id = ctx.getImageData(0,0,w,h);
  var out = new Uint8Array(w*h);
  for(var i=0,p=0;i<id.data.length;i+=4,p++){ out[p] = id.data[i+3] > 127 ? 1 : 0; }
  return out;
}
P3D.maskAlphaFromCtx = maskDataUrlToAlpha;

// maskDataUrl(P3D.extractMaskFromColormapの戻り値.maskDataUrl)を実際に画像として
// 読み込み、w×hのUint8Array(1=前景)に変換する非同期版。アクセサリー彫刻
// (accessories.js)が、色分けマップ由来の正確なマスクをfront/back/side画像と
// 同じ座標系のアルファ配列として直接使うために使う(パーツごとに自分の
// front/side/backマスクだけで彫るため。従来はbboxの中を「白背景でないか」で
// 塗り直していたため、bbox内にある体側のピクセルまで拾ってしまっていた)。
function loadMaskAlphaAsync(maskDataUrl, w, h){
  return new Promise(function(resolve, reject){
    var img = new Image();
    img.onload = function(){
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      var ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      resolve(maskDataUrlToAlpha(ctx, w, h));
    };
    img.onerror = function(){ reject(new Error("マスク画像の読込に失敗しました")); };
    img.src = maskDataUrl;
  });
}
P3D.loadMaskAlphaAsync = loadMaskAlphaAsync;

// 4連結の1px単純侵食をr回繰り返す(bleedEdgesの境界インセット用)。
function erode4N(mask, w, h, r){
  var m = mask;
  for(var it=0; it<r; it++){
    var next=new Uint8Array(w*h);
    for(var y=0;y<h;y++){
      for(var x=0;x<w;x++){
        var idx=y*w+x;
        if(!m[idx]){ next[idx]=0; continue; }
        var ok=1;
        if(x>0 && !m[idx-1]) ok=0;
        if(ok && x<w-1 && !m[idx+1]) ok=0;
        if(ok && y>0 && !m[idx-w]) ok=0;
        if(ok && y<h-1 && !m[idx+w]) ok=0;
        next[idx]=ok;
      }
    }
    m = next;
  }
  return m;
}

// ★2026-07-11追加(ユーザー指摘「にじみがパーツごとにバラバラに見える」対応):
// bleedInsetPxによる侵食(erode4N)は、髪の房の毛先やアクセサリーの細い帯など
// alphaの幅がinsetPx*2未満の細い部位を完全に消してしまうことがある。その
// 部位のalpha連結成分にシード画素が1つも残らないと、にじみの起点が(近い
// 別部位のたまたま最寄りの画素という)無関係な色に飛んでしまい、細い部位
// だけ色が破綻して見える(パーツごとに扱いが違って見える原因)。alpha側の
// 連結成分(4連結)ごとに、侵食後のシードが0個の成分だけ侵食前のalphaを
// そのまま復元する(その部位だけinsetPx=0相当にフォールバックし、他の
// 部位の色を借りることはない)。
function restoreErodedThinComponents(alpha, eroded, w, h){
  var n=w*h;
  var label=new Int32Array(n).fill(-1);
  var out=new Uint8Array(eroded);
  var stack=[];
  for(var start=0; start<n; start++){
    if(!alpha[start] || label[start]!==-1) continue;
    var lab=start;
    stack.push(start); label[start]=lab;
    var members=[start];
    var hasSeed=!!eroded[start];
    while(stack.length){
      var idx=stack.pop();
      var x=idx%w, y=(idx/w)|0;
      var nbrs=[];
      if(x>0)nbrs.push(idx-1); if(x<w-1)nbrs.push(idx+1);
      if(y>0)nbrs.push(idx-w); if(y<h-1)nbrs.push(idx+w);
      for(var k=0;k<nbrs.length;k++){
        var ni=nbrs[k];
        if(alpha[ni] && label[ni]===-1){
          label[ni]=lab; stack.push(ni); members.push(ni);
          if(eroded[ni]) hasSeed=true;
        }
      }
    }
    if(!hasSeed){
      for(var m2=0;m2<members.length;m2++) out[members[m2]]=1;
    }
  }
  return out;
}

// ---- 縁の色にじみ(prep.stage_bleedのJS移植) ----
// 透明画素を最も近い不透明画素のRGBで埋め(distance_transform_edtのindices相当を
// 多元BFSで代用)、アルファをalphaDilate回だけ膨張させる。
// ★2026-07-11追加(切り抜き精度向上、point3): 元イラストは輪郭を黒い縁取り
// ストロークで描くことが多く、にじみの起点(BFSのシード)を輪郭ぎりぎりの
// 画素(=縁取りストロークそのもの)にすると、外側ににじませた分だけ縁取りが
// 太って見える不具合があった。bleedInsetPxで指定した分だけalphaを内側に
// 侵食(erode4N)した「安全な内部色」だけをシードにする。
// ★2026-07-12修正(ユーザー指摘「輪郭から拡張するんじゃなくて内側から拡張」):
// 当初は「実際に見えている前景画素(縁取りストローク自体を含む)は書き換えない」
// 仕様にしていたが、これだとbleedInsetPxをいくら大きくしても縁取りストローク
// 自体はそのまま残り、にじみが効いて見えなかった(ユーザーが「内側のピクセル
// 拡張がうまく動いていない」と報告した根本原因)。侵食後もシードとして生き
// 残った(=輪郭からbleedInsetPxより内側にある)画素だけを「実ピクセルのまま」
// 保護し、それ以外(輪郭ぎりぎりの縁取りストローク画素+実背景画素)は全て
// BFSで求めた最寄りの安全な内部色で上書きする。これにより縁取りストローク
// そのものが内部の塗り色に置き換わり、文字通り「内側から外側へ拡張」した
// 見た目になる。bleedInsetPx=0ならseedAlpha=alphaなので従来通り(輪郭ぎりぎり
// の画素がそのまま=書き換えなし)。
// 戻り値: 新しいImageData(w,h) と同サイズのUint8ClampedArray rgba。
function bleedEdges(rgba, w, h, alpha, alphaDilate, bleedInsetPx){
  alphaDilate = (alphaDilate===undefined) ? 9 : alphaDilate;
  bleedInsetPx = (bleedInsetPx===undefined || bleedInsetPx===null) ? 0 : bleedInsetPx;
  var n=w*h;
  var seedAlpha = alpha;
  if(bleedInsetPx>0){
    seedAlpha = erode4N(alpha, w, h, bleedInsetPx);
    seedAlpha = restoreErodedThinComponents(alpha, seedAlpha, w, h);
  }
  var nearestIdx=new Int32Array(n).fill(-1);
  var dist=new Int32Array(n).fill(-1);
  var visited=new Uint8Array(n);
  var queue=[]; var qh=0;
  for(var i=0;i<n;i++){ if(seedAlpha[i]){ nearestIdx[i]=i; dist[i]=0; visited[i]=1; queue.push(i); } }
  // ★2026-07-05: 以前はキャンバス全域まで最近傍色を無制限に伝播していたため、
  // Tポーズの袖・脚等にある細かい帯模様(リストバンド等)の色が背景の遠くまで
  // 直線的なボロノイ境界として伸び、輪郭からわずかにはみ出た頂点(髪の房・
  // アクセサリーの縁など、実シルエットよりわずかに広いUVを持つ面)がその
  // ボロノイ模様を拾って縞々に見える不具合の原因になっていた。にじみは
  // 縁からBLEED_MAX_DISTだけに制限し、それより遠くは(白いはずの)元の背景
  // ピクセルへ戻す。
  var BLEED_MAX_DIST = Math.max(alphaDilate*4, 40);
  while(qh<queue.length){
    var idx=queue[qh++];
    if(dist[idx]>=BLEED_MAX_DIST) continue;
    var src=nearestIdx[idx];
    var x=idx%w, y=(idx/w)|0;
    var nbrs=[];
    if(x>0)nbrs.push(idx-1); if(x<w-1)nbrs.push(idx+1);
    if(y>0)nbrs.push(idx-w); if(y<h-1)nbrs.push(idx+w);
    for(var k=0;k<nbrs.length;k++){
      var ni=nbrs[k];
      if(!visited[ni]){ visited[ni]=1; nearestIdx[ni]=src; dist[ni]=dist[idx]+1; queue.push(ni); }
    }
  }
  var outRgba=new Uint8ClampedArray(n*4);
  for(var i2=0;i2<n;i2++){
    var o=i2*4;
    if(seedAlpha[i2]){
      // 侵食後もシードとして生き残った(=輪郭からbleedInsetPxより内側にある)
      // 画素だけは実ピクセルの絵柄自体をそのまま使う。
      outRgba[o]=rgba[o]; outRgba[o+1]=rgba[o+1]; outRgba[o+2]=rgba[o+2]; outRgba[o+3]=255;
      continue;
    }
    // それ以外(輪郭ぎりぎりの縁取りストローク画素+実背景画素)は、最寄りの
    // 安全な内部色で上書きする(bleedInsetPx=0ならseedAlpha=alphaなので、
    // ここへは実背景画素しか来ず従来通り)。
    var farOrUnreached = (nearestIdx[i2]<0) || (dist[i2]>BLEED_MAX_DIST);
    var src2 = farOrUnreached ? i2 : nearestIdx[i2];
    var so=src2*4;
    outRgba[o]=rgba[so]; outRgba[o+1]=rgba[so+1]; outRgba[o+2]=rgba[so+2]; outRgba[o+3]=255;
  }
  // アルファ膨張(iterations回、4連結の単純膨張。ndimage.binary_dilationの既定=4連結相当)
  var dilated = alpha;
  for(var it=0; it<alphaDilate; it++){
    var next=new Uint8Array(n);
    for(var y2=0;y2<h;y2++){
      for(var x2=0;x2<w;x2++){
        var idx2=y2*w+x2;
        if(dilated[idx2]){ next[idx2]=1; continue; }
        var on=false;
        if(x2>0&&dilated[idx2-1])on=true;
        if(!on&&x2<w-1&&dilated[idx2+1])on=true;
        if(!on&&y2>0&&dilated[idx2-w])on=true;
        if(!on&&y2<h-1&&dilated[idx2+w])on=true;
        next[idx2]=on?1:0;
      }
    }
    dilated=next;
  }
  for(var i3=0;i3<n;i3++){ outRgba[i3*4+3] = dilated[i3] ? 255 : 0; }
  return outRgba;
}
P3D.bleedEdges = bleedEdges;


// ---- 複数のTypedArrayを1本に連結する ----
// pipeline.js(stageAccessories内)とaccessories.jsで同一の実装(concatF32)が
// 重複していたため、頂点(V/N)・スキニング(J/W)いずれの連結にも使える形で
// ここに集約する(Ctorを渡せばFloat32Array/Uint16Array等どれでも使える)。
function concatTypedArrays(Ctor, arrs){
  var total = 0;
  arrs.forEach(function(a){ total += a.length; });
  var out = new Ctor(total), off = 0;
  arrs.forEach(function(a){ out.set(a, off); off += a.length; });
  return out;
}
P3D.concatTypedArrays = concatTypedArrays;

// ---- ランドマーク点描画(landmark_tool.htmlベタ書きからの切り出し、フェーズ0) ----
// ゴーストスキャナー(ghost_scanner.html)側の簡易プレビューでも同じ見た目の
// 点/ラベルを描きたいため、canvasコンテキストと座標だけを受け取る汎用関数として
// ここに集約する(landmark_tool.html側はこの関数を呼ぶだけにする)。
// x: CanvasRenderingContext2D, px/py: 描画先の点(px座標), on: 選択中か, color: 通常色
function drawCross(x,px,py,on,color){
  const r=on?9:6.5;
  x.lineWidth=on?3.4:2.4;x.strokeStyle="rgba(0,0,0,.65)";
  x.beginPath();x.moveTo(px-r,py);x.lineTo(px+r,py);x.moveTo(px,py-r);x.lineTo(px,py+r);x.stroke();
  x.lineWidth=on?1.8:1.2;x.strokeStyle=on?"#ffe14d":color;
  x.beginPath();x.moveTo(px-r,py);x.lineTo(px+r,py);x.moveTo(px,py-r);x.lineTo(px,py+r);x.stroke();
}
P3D.drawCross = drawCross;
function drawLabel(x,text,px,py,color){
  x.font="bold 11px sans-serif";x.textAlign="center";
  x.lineWidth=3;x.strokeStyle="rgba(0,0,0,.75)";x.strokeText(text,px,py);
  x.fillStyle=color;x.fillText(text,px,py);
}
P3D.drawLabel = drawLabel;
// アクセサリー等の可変N点多角形の輪郭線描画。呼び出し側で既にビュー座標
// (拡大/パン込みのpx座標)に変換した点配列を渡す想定(このツール自体は
// ビュー変換の詳細を知らない、純粋な描画プリミティブ)。
// x: CanvasRenderingContext2D, ptsPx: [[px,py],...] (2点未満は何もしない), color: 線色
function drawPolygonOutline(x,ptsPx,color){
  if(!ptsPx||ptsPx.length<2)return;
  x.save();x.lineWidth=2;x.strokeStyle=color;x.beginPath();
  x.moveTo(ptsPx[0][0],ptsPx[0][1]);
  for(let i=1;i<ptsPx.length;i++){ x.lineTo(ptsPx[i][0],ptsPx[i][1]); }
  x.closePath();x.stroke();x.restore();
}
P3D.drawPolygonOutline = drawPolygonOutline;

// ---- ランドマーク定義/色(landmark_tool.htmlベタ書きからの切り出し、フェーズ0) ----
// 解剖学的ランドマーク定義とグループ色(骨格関節点18+目/口角4=計22点)。ゴーストスキャナーのプレビューでも
// landmark_tool.htmlと全く同じ点定義・配色を使いたいためここに集約する。
var LM=[
 {k:"head_top",jp:"頭頂",g:"head",desc:"頭のてっぺん(髪を含めた輪郭の一番上)"},
 {k:"chin",jp:"あご",g:"head",desc:"あごの先端(顔の輪郭で一番下の点。髪で隠れていても実際の輪郭位置)"},
 // ★2026-07-08追加: 現時点では彫刻パイプライン(carveRegion等)はこの2点を
 // 未使用(将来、表情/顔パーツ位置合わせ等で使う可能性があるための先行追加)。
 // 未使用のため彫刻結果には影響しないが、マーク済みの位置として保存・表示は
 // される(landmark_tool.htmlのplaceAll()が自動配置の粗い初期値を置く)。
 // ★2026-07-11: 顔の立体感対応でこの2点を実際に使うようにした
 // (js/pipeline.jsのbuildDerivedLandmarksでmodel座標に変換され、
 // js/carving.jsのapplyEyeSocketRecessが彫刻済みの頭部表面へ局所的な
 // 目窩の凹みを彫るのに使う)。
 // ★2026-07-11(検討の結果、鼻には使わないことにした): 当初は同じ仕組みで
 // 鼻先ランドマークを追加し突起を加算していたが、鼻は顔の中心線上にあり、
 // side(側面)画像のその高さの行スキャンから既に実測の奥行きが出ている
 // (ユーザー指摘)。そこへ独自パラメータの突起を追加で盛ると、側面の実測値
 // (=実際の側面イラスト)と食い違う奥行きになってしまう。目窩はどの
 // ビュー(front/back/side)のシルエット輪郭にも現れない内部の凹みなので、
 // 追加しても輪郭とは矛盾しない(このため目窩だけ採用した)。
 {k:"eye_L",jp:"目L",g:"face",desc:"左目(画面に向かって左側)の中心"},
 {k:"eye_R",jp:"目R",g:"face",desc:"右目(画面に向かって右側)の中心"},
 {k:"mouth_L",jp:"口角L",g:"face",desc:"口の左端(画面に向かって左側の口角)"},
 {k:"mouth_R",jp:"口角R",g:"face",desc:"口の右端(画面に向かって右側の口角)"},
 {k:"clavicle_L",jp:"鎖骨L",g:"torso",desc:"鎖骨(首の付け根と肩の間、体の中心寄り。肩関節そのものではない)"},
 {k:"clavicle_R",jp:"鎖骨R",g:"torso",desc:"鎖骨(首の付け根と肩の間、体の中心寄り。肩関節そのものではない)"},
 {k:"shoulder_L",jp:"肩L",g:"arm",desc:"肩関節(腕が胴体に接続する回転軸の位置。腕の付け根の一番外側ではなく、腕がそこを軸に回る点)"},
 {k:"shoulder_R",jp:"肩R",g:"arm",desc:"肩関節(腕が胴体に接続する回転軸の位置。腕の付け根の一番外側ではなく、腕がそこを軸に回る点)"},
 {k:"elbow_L",jp:"肘L",g:"arm",desc:"肘関節(腕が曲がる位置)"},
 {k:"elbow_R",jp:"肘R",g:"arm",desc:"肘関節(腕が曲がる位置)"},
 {k:"wrist_L",jp:"手首L",g:"arm",desc:"手首関節(手のひらの付け根。指先ではない)"},
 {k:"wrist_R",jp:"手首R",g:"arm",desc:"手首関節(手のひらの付け根。指先ではない)"},
 {k:"waist_L",jp:"腰L",g:"torso",desc:"胴が一番くびれている高さの、体の左右の輪郭端(ウエストの一番細い所)"},
 {k:"waist_R",jp:"腰R",g:"torso",desc:"胴が一番くびれている高さの、体の左右の輪郭端(ウエストの一番細い所)"},
 {k:"hip",jp:"股",g:"leg",desc:"股(両脚の間、脚の付け根の中心点)"},
 {k:"knee_L",jp:"膝L",g:"leg",desc:"膝関節(脚が曲がる位置)"},
 {k:"knee_R",jp:"膝R",g:"leg",desc:"膝関節(脚が曲がる位置)"},
 {k:"ankle_L",jp:"足首L",g:"leg",desc:"足首関節(すねと足の境目)"},
 {k:"ankle_R",jp:"足首R",g:"leg",desc:"足首関節(すねと足の境目)"},
 {k:"toe_L",jp:"つま先L",g:"leg",desc:"つま先(靴/足の輪郭で一番前の点)"},
 {k:"toe_R",jp:"つま先R",g:"leg",desc:"つま先(靴/足の輪郭で一番前の点)"},
];
P3D.LM = LM;
var GCOL={head:"#52e0c4",face:"#c9a0ff",arm:"#ffb454",torso:"#7aa2ff",leg:"#ff6ad5"};
P3D.GCOL = GCOL;
var LM_GROUP_ORDER=["head","face","torso","arm","leg"];
P3D.LM_GROUP_ORDER = LM_GROUP_ORDER;
var LM_GROUP_JP={head:"頭部",face:"顔",torso:"胴体",arm:"腕",leg:"脚"};
P3D.LM_GROUP_JP = LM_GROUP_JP;

// ---- スライダー(<input type=range>)をつまみ(thumb)付近でのみ操作可能にする ----
// ネイティブのrange inputは、つまみ以外のトラック部分をタップしただけでも
// 即座にその位置へ値がジャンプする仕様のため、誤操作(意図せずパラメータが
// 変わってしまう)が起きやすい。つまみの現在位置に十分近い場所から操作を
// 開始した場合のみ許可し、それ以外はpointerdownを無視(preventDefault)する。
// landmark_tool.html/character_3d.html両方が本ファイルを読み込むため、ここに
// documentへの委譲リスナーとして実装することで全range inputに一括で効かせる。
// ---- ランドマークの粗い自動配置(白背景シルエットからの推定) ----
// ★2026-07-10: landmark_tool.htmlにあったSTD/buildMask/rowRuns/analyze/
// placeAllを、ghost_scanner.html側でも「AI(Gemini)を使わずランドマークを
// 仮配置したい」場合に再利用できるようこちらへ移した(手動でスキャナーを
// 完結させたい場合の代替経路。あくまで一般的な体型比率からの粗い仮配置
// なので、実際の絵柄に合わせた微調整はジェネレータ(landmark_tool.html)側の
// ドラッグ編集で行う前提)。
// 標準人体プロポーション(このキャラ固有値ではない)。
var STD={head_bottom:0.125,shoulder:0.182,waist:0.375,hip:0.500,knee_frac:0.47,ankle_frac:0.91,elbow_frac:0.47};
P3D.STD=STD;
// L=画像左 / R=画像右（pipeline.py の leg_runs と同規約）
function buildMask(img,W,H,thr){
  thr=thr||238;
  var c=document.createElement("canvas");c.width=W;c.height=H;
  var x=c.getContext("2d");x.drawImage(img,0,0,W,H);
  var d=x.getImageData(0,0,W,H).data, m=new Uint8Array(W*H);
  for(var i=0;i<W*H;i++){var r=d[i*4],g=d[i*4+1],b=d[i*4+2],a=d[i*4+3];
    m[i]=(a>40 && !(r>thr&&g>thr&&b>thr))?1:0;}
  return m;
}
P3D.buildMask=buildMask;
function rowRuns(mask,W,y,minGap,minLen){
  minGap=minGap||4;minLen=minLen||0;
  var out=[],s=-1,p=-1;
  for(var x=0;x<W;x++){
    if(mask[y*W+x]){ if(s<0){s=x;p=x;} else if(x<=p+minGap)p=x; else{ if(p-s>=minLen)out.push([s,p]); s=x;p=x; } }
  }
  if(s>=0&&p-s>=minLen)out.push([s,p]);
  return out;
}
// mask: buildMask()の戻り値, W,H: 画像サイズ。戻り値: シルエット計測結果
// (ytop/ybot/cx/肩・腰・股の推定位置等)、シルエットが検出できなければnull。
function analyzeSilhouette(mask,W,H){
  var ytop=-1,ybot=-1;
  for(var y=0;y<H;y++){for(var x=0;x<W;x++)if(mask[y*W+x]){if(ytop<0)ytop=y;ybot=y;break;}}
  if(ytop<0)return null;
  var BH=ybot-ytop, NOISE=Math.max(6,Math.round(0.01*BH));
  var tc=[];
  for(var f=0.32;f<=0.50;f+=0.012){var yy=Math.round(ytop+f*BH),r=rowRuns(mask,W,yy,4,NOISE);
    if(r.length){var big=r.reduce(function(a,b){return (b[1]-b[0])>(a[1]-a[0])?b:a;});tc.push((big[0]+big[1])/2);}}
  tc.sort(function(a,b){return a-b;});var cx=tc.length?tc[tc.length>>1]:W/2;
  var widthAt=function(v){var yy=Math.min(Math.max(Math.round(ytop+v*BH),0),H-1),r=rowRuns(mask,W,yy,4,NOISE);
    if(!r.length)return{full:0,n:0,r:[],y:yy};return{full:r[r.length-1][1]-r[0][0],n:r.length,r:r,y:yy};};
  var sm=function(a,k){k=k||5;return a.map(function(_,i){var s=0,c=0;for(var j=-(k>>1);j<=(k>>1);j++){var t=i+j;if(t>=0&&t<a.length){s+=a[t];c++;}}return s/c;});};
  var vs=[];for(var v=0.06;v<=0.42;v+=0.0018)vs.push(v);
  var ws=sm(vs.map(function(v){return widthAt(v).full;}));
  var j=0,best=-1;for(var i2=0;i2<ws.length-1;i2++){var d=ws[i2+1]-ws[i2];if(d>best){best=d;j=i2;}}
  var shoulder_v=vs[j];
  var pre=Math.min.apply(null,ws.slice(0,j+1)), post=Math.max.apply(null,ws.slice(j,Math.min(j+20,ws.length)));
  var shoulder_detected=post>1.8*Math.max(pre,1);
  if(!shoulder_detected)shoulder_v=STD.shoulder;
  var preFull=widthAt(Math.max(shoulder_v-0.01,0.02)).full;
  var shoulder_hw=preFull>0?preFull/2:BH*0.10;
  var merge_end_v=Math.min(shoulder_v+0.20,0.46);
  for(var v2=shoulder_v+0.01;v2<=Math.min(shoulder_v+0.30,0.48);v2+=0.0025){var w=widthAt(v2);if(w.full>0&&w.full<1.5*Math.max(preFull,1)&&w.n<=1){merge_end_v=v2;break;}}
  var waist_v=STD.waist,waist_hw=shoulder_hw*0.75,waist_detected=false,mn=1e9;
  for(var v3=merge_end_v+0.01;v3<=0.48;v3+=0.0025){var w2=widthAt(v3);if(w2.n===1&&w2.full>0&&w2.full<mn){mn=w2.full;waist_v=v3;waist_hw=w2.full/2;waist_detected=true;}}
  var hip_v=STD.hip,hip_detected=false;
  for(var v4=waist_v+0.02;v4<=0.62;v4+=0.002){var w3=widthAt(v4);var big2=w3.r.filter(function(rr){return rr[1]-rr[0]>NOISE;});if(big2.length>=2){hip_v=v4;hip_detected=true;break;}}
  return{ytop:ytop,ybot:ybot,BH:BH,cx:cx,NOISE:NOISE,mask:mask,W:W,H:H,shoulder_v:shoulder_v,shoulder_hw:shoulder_hw,shoulder_detected:shoulder_detected,merge_end_v:merge_end_v,waist_v:waist_v,waist_hw:waist_hw,waist_detected:waist_detected,hip_v:hip_v,hip_detected:hip_detected};
}
// A: analyzeSilhouette()の戻り値。戻り値: {点キー: [x,y]}(22点、front画像の
// 実寸ピクセル座標)。あくまで一般的な体型比率からの粗い仮配置。
function placeAllLandmarks(A){
  var ytop=A.ytop,BH=A.BH,cx=A.cx,W=A.W,mask=A.mask,NOISE=A.NOISE, yOf=function(v){return Math.round(ytop+v*BH);}, P={};
  P.head_top=[cx,ytop];
  var hb=A.shoulder_v*(STD.head_bottom/STD.shoulder);P.chin=[cx,yOf(hb)];
  var headH=yOf(hb)-ytop;
  var eyeHw=A.shoulder_hw*0.28, mouthHw=A.shoulder_hw*0.12;
  P.eye_L=[cx-eyeHw, ytop+headH*0.46];P.eye_R=[cx+eyeHw, ytop+headH*0.46];
  P.mouth_L=[cx-mouthHw, ytop+headH*0.82];P.mouth_R=[cx+mouthHw, ytop+headH*0.82];
  var shY=yOf(A.shoulder_v);
  P.shoulder_L=[cx-A.shoulder_hw,shY];P.shoulder_R=[cx+A.shoulder_hw,shY];
  P.clavicle_L=[cx-A.shoulder_hw*0.45,shY+BH*0.012];P.clavicle_R=[cx+A.shoulder_hw*0.45,shY+BH*0.012];
  var armY=yOf((A.shoulder_v+A.merge_end_v)/2),xl=cx,xr=cx;
  for(var y=shY;y<=yOf(A.merge_end_v);y++){var r=rowRuns(mask,W,y,4,NOISE);for(var k=0;k<r.length;k++){var rr=r[k];if(rr[0]<xl)xl=rr[0];if(rr[1]>xr)xr=rr[1];}}
  var shL=cx-A.shoulder_hw,shR=cx+A.shoulder_hw;
  var wrR=shR+0.88*(xr-shR),wrL=shL+0.88*(xl-shL);
  P.wrist_R=[wrR,armY];P.wrist_L=[wrL,armY];
  P.elbow_R=[shR+0.5*(wrR-shR),armY];P.elbow_L=[shL+0.5*(wrL-shL),armY];
  var waY=yOf(A.waist_v);P.waist_L=[cx-A.waist_hw,waY];P.waist_R=[cx+A.waist_hw,waY];
  P.hip=[cx,yOf(A.hip_v)];
  var legAt=function(v){var y=yOf(v),r=rowRuns(mask,W,y,4,NOISE).filter(function(rr){return rr[1]-rr[0]>NOISE;});
    var L=r.filter(function(rr){return (rr[0]+rr[1])/2<cx;}),R=r.filter(function(rr){return (rr[0]+rr[1])/2>=cx;});
    var pick=function(l){return l.length?l.reduce(function(a,b){return (b[1]-b[0])>(a[1]-a[0])?b:a;}):null;};
    var pl=pick(L),pr=pick(R);
    return{L:pl?(pl[0]+pl[1])/2:cx-A.shoulder_hw*0.3,R:pr?(pr[0]+pr[1])/2:cx+A.shoulder_hw*0.3,y:y};};
  var kv=A.hip_v+STD.knee_frac*(1-A.hip_v),av=A.hip_v+STD.ankle_frac*(1-A.hip_v);
  var kk=legAt(kv),an=legAt(av),to=legAt(0.992);
  P.knee_L=[kk.L,kk.y];P.knee_R=[kk.R,kk.y];P.ankle_L=[an.L,an.y];P.ankle_R=[an.R,an.y];P.toe_L=[to.L,to.y];P.toe_R=[to.R,to.y];
  var out={};for(var key in P)out[key]=[Math.round(P[key][0]),Math.round(P[key][1])];
  return out;
}
P3D.analyzeSilhouette=analyzeSilhouette;
P3D.placeAllLandmarks=placeAllLandmarks;

// ★2026-07-10: landmark_tool.html(ジェネレータ)の作業セッション自動保存
// (localStorage)キーをcharacter_3d.html(ビューア)とも共有する。ビューアで
// 「モデル生成」経由の中間パッケージをライブ編集した内容(gen_params/
// seam_angles等)は、従来ジェネレータ側のセッションへ書き戻されず、
// 「戻る」で行き来すると消えてしまっていた(ユーザー指摘)。同じキー名を
// 両ファイルで直接文字列リテラルとして重複定義すると将来的な食い違いの元に
// なるため、ここで一箇所にまとめる。
P3D.NORMAL_SESSION_KEY="3dtoolJS_normal_session_v1";
P3D.SAMPLE_SESSION_KEY="3dtoolJS_sample_session_v1";
P3D.sessionStorageKey=function(mode, sampleId){
  return mode==="sample" ? (P3D.SAMPLE_SESSION_KEY+":"+sampleId) : P3D.NORMAL_SESSION_KEY;
};

// ★2026-07-11追加(ユーザー指摘「ビューアからジェネレータへ戻ると設定値が
// 消える」への対応): landmark_tool.htmlのbuildJson()はfront/side/back/
// leftSideの実画像+色分けマップを丸ごとbase64で埋め込むため、この自動保存
// (localStorage、quotaは通常5〜10MB程度)にそのまま使うと、キャラクター1体分
// でも数MB超になりQuotaExceededErrorで保存自体が毎回失敗していた
// (呼び出し元がcatchで握りつぶすため、画面には「自動保存に失敗しました」
// としか出ず気づきにくい)。サンプルモードの画像・色分けマップは同梱の
// 固定アセットから、通常モードの画像・色分けマップは別途IndexedDB
// (P3D.saveNormalSessionImages、landmark_tool.html参照)から、それぞれ
// 再取得できるため、この自動保存にはランドマーク/設定値等の軽量な差分だけ
// 残せばよい。character_3d.html(ビューア)の書き戻し(ジェネレータと同じ
// キーへ上書き保存)にも同じ理由で使う。
// json: buildJson()相当のオブジェクト。破壊せず新しいオブジェクトを返す。
function stripHeavyFieldsForSessionSave(json){
  var out = Object.assign({}, json);
  var strippedImage = {};
  ["front","side","back","leftSide"].forEach(function(v){
    var src = json.image && json.image[v];
    if(!src){ strippedImage[v]=null; return; }
    var meta = {w:src.w, h:src.h};
    if(src.ytop!==undefined) meta.ytop=src.ytop;
    if(src.ybot!==undefined) meta.ybot=src.ybot;
    if(src.cx!==undefined) meta.cx=src.cx;
    strippedImage[v]=meta;
  });
  out.image = strippedImage;
  delete out.colormaps;
  return out;
}
P3D.stripHeavyFieldsForSessionSave = stripHeavyFieldsForSessionSave;

document.addEventListener('pointerdown', function(e){
  var el = e.target;
  if(!el || el.tagName!=='INPUT' || el.type!=='range') return;
  var rect = el.getBoundingClientRect();
  if(rect.width<=0) return;
  var min=parseFloat(el.min), max=parseFloat(el.max), val=parseFloat(el.value);
  if(!isFinite(min)) min=0;
  if(!isFinite(max)) max=100;
  if(!isFinite(val)) val=min;
  var frac = max>min ? (val-min)/(max-min) : 0;
  frac = Math.max(0, Math.min(1, frac));
  // ブラウザ既定のrange thumb幅(Chromium系の実測値。本プロジェクトはCSSで
  // thumbの見た目を変更していないため既定サイズを前提にできる)。
  var thumbW = 16;
  var usable = Math.max(1, rect.width - thumbW);
  var thumbCenterX = rect.left + thumbW/2 + frac*usable;
  var tolerance = 14; // つまみ中心からこの範囲内なら「つまみに触れた」とみなす
  if(Math.abs(e.clientX - thumbCenterX) > tolerance){
    e.preventDefault();
  }
}, {capture:true, passive:false});

})(window);
