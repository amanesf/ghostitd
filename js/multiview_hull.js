// -*- coding: utf-8 -*-
// VEO_VIDEO_TO_3D_PLAN.md §6(Stage4: 多視点ソフトビジュアルハル彫刻)のM2実装。
// ★M1+M2スコープでの簡略化: 計画書は「coarse-to-fine(1/4解像度→表面narrow
// bandのみ本解像度)+Worker並列」を挙げているが、これは主に性能最適化であり
// 正しさの必須要件ではないため、本セッションでは単一解像度・メインスレッド
// (chunk分割してrequestAnimationFrameで小休止を挟み、UIをブロックしない)の
// 実装に留める。§7のphoto-consistency精密化(凹形状)も実験パス扱いのため
// 見送る。将来必要になれば別途追加する。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

// 既存js/visual_hull.jsのbuildBodyCarveOptsが使っている体の外接範囲と同じ
// 既定値(モデル単位、頭頂〜足裏がおおよそy:[-0.02,1.05]に収まる規約)を流用する。
var DEFAULT_BOUNDS = {
  mxBounds: [-0.62, 0.62],
  myBounds: [-0.02, 1.05],
  mzBounds: [-0.35, 0.35], // 3面方式の既定(z:[-0.22,0.22])よりは奥行きに
                            // 余裕を持たせるが、体の奥行き(胸〜背中)は
                            // 肩幅よりかなり小さいのが通常なので、
                            // mxBoundsと同じ広さにはしない
};
P3D.MULTIVIEW_DEFAULT_BOUNDS = DEFAULT_BOUNDS;

function deg2rad(d){ return d*Math.PI/180; }

// ★2026-07-18(方針転換1): 単一の重み付き分位点(weightedQuantile)は、境界を
// どこに引いてもノイズに対して脆弱な「1フレームが拒否権を持つ」構造になる
// (quantilePos=0の厳密ANDが特に顕著だが、0.9等の緩い値でも1点選択である限り
// 同じ脆弱性が残る)ため、いったんbottomKWeightedMean(固定比率の下位平均)へ
// 置き換えた。
//
// ★2026-07-18(方針転換2、ユーザー実地確認で発覚): ところがbottomKWeightedMean
// (下記に経緯として残す)は別の問題を生んだ。ツインテール間・帽子のつばの
// 裏側のような「ごく一部の角度域(数フレーム)からしか外側と判定できない
// 狭い可視窓」を持つ凹み・隙間で、固定比率(既定10%=64枚中約6〜7枚分)の
// 重みを機械的に埋めようとするため、実際に外側と言っている2〜4枚だけでは
// 予算が余り、残りはオクルージョンでたまたま内側寄りに見えている無関係な
// フレームで埋められてしまい、平均が内側(正)に寄って隙間が彫れなくなって
// いた(狭い可視窓の情報が多数派の無関係な票で薄められて消える)。90度側面
// 等で見ると一目瞭然だった。固定個数/固定比率という設計自体が原因なので、
// 「本当に近い証拠だけを集める」可変サイズのクラスタへ置き換える。
//
// (旧実装、参考のため残す):
// function weightedQuantile(pairs, quantilePos){ ソートして累積重みが
//   targetに達した1点をそのまま返す(1点しか見ない)。 }
// function bottomKWeightedMean(pairs, bottomKFrac){ ソートして下位
//   bottomKFrac分(重み基準)を平均する(常に固定量を消費する)。 }

// 最小値から始める単一連結(single-linkage)クラスタの重み付き平均。
// pairsを値の小さい順に並べ、隣接値との差がepsilon以内である限りクラスタに
// 取り込み、差がepsilonを超えた時点で打ち切ってそこまでの重み付き平均を返す。
// 固定個数/固定比率を強制しないため、クラスタは点ごとに自然なサイズになる:
//   - 広い接線角度域を持つ表面(髪の毛の生え際等)では、較正ノイズで散らばった
//     複数フレームがepsilon内で連鎖してクラスタに入り、ノイズが平均で
//     打ち消される。
//   - ツインテール間・帽子の裏のような狭い可視窓の隙間では、実際に外側と
//     言っている少数フレーム(2〜4枚等)だけがクラスタになり、無関係な
//     多数派フレームで薄められることなくそのまま反映される。
// epsilon: モデル空間の距離(呼び出し側でpx→モデル単位に変換済みの値を渡す。
//   較正の残留ノイズ(数px相当)を吸収できる程度の小さい値を想定)。
// クラスタの増殖に上限を設ける比率(voteAtPointのMAX_CLUSTER_WEIGHT_FRACと
// 同じ値・同じ理由。このモジュールの下の方で定義されるが、varはモジュール
// スコープ全体でhoistされるため、この関数からも参照できる)。
// pairs: [[value, weight], ...] (未ソート可)
function clusterMeanFromMin(pairs, epsilon){
  if(pairs.length===0) return -1e6;
  var sorted = pairs.slice().sort(function(a,b){ return a[0]-b[0]; });
  var total = 0;
  for(var i=0;i<sorted.length;i++) total += sorted[i][1];
  var capW = MAX_CLUSTER_WEIGHT_FRAC*total;
  var accW = sorted[0][1], accWV = sorted[0][0]*sorted[0][1];
  var prevVal = sorted[0][0];
  for(var j=1; j<sorted.length && accW<capW; j++){
    var v = sorted[j][0];
    if(v - prevVal > epsilon) break;
    accWV += v*sorted[j][1];
    accW += sorted[j][1];
    prevVal = v;
  }
  return accW>0 ? accWV/accW : sorted[0][0];
}
P3D.clusterMeanFromMin = clusterMeanFromMin;

// ★2026-07-18(ユーザー指摘で撤回): 当初、0/90/180/270度フレームだけ重みを
// 15倍にして多数決を支配させていたが、これは「一部のフレームを他より強く」
// という発想であり、ユーザーの意図(「全フレームが同格の直接証拠であり、
// 統計的多数決で薄められること自体がおかしい」「回転に合わせて全フレームの
// 輪郭をそのまま使いたい」)とは異なっていた。全フレームを同格に扱うなら
// 特定角度だけ重み付けする理由が無いため1に戻す(=無効化。定数とロジックは
// 将来また要ることがあれば再利用できるよう残す)。
var CARDINAL_WEIGHT_MULT = 1;

// calib.perFrame + sdfFramesから、投影に必要な値だけをまとめた配列を作る
// (carveMultiviewField/carveMultiviewFieldCoarseToFineの共通処理)。
function buildUseFrames(calib, sdfFrames, minWeight){
  var modelHeightSpan = DEFAULT_BOUNDS.myBounds[1]-DEFAULT_BOUNDS.myBounds[0];
  // ★scaleはフレームごとのbbox高さを毎回使わず、calibrateTurntableが
  // 全フレームから頑健に求めたrefHeight(中央値)を共通の基準として使う。
  // カメラ固定前提では真のpx/model比は全フレームで一定のはずで、フレーム
  // 個別のbbox高さ(セグメンテーションノイズ・アンチエイリアス境界で数px
  // 単位でブレる)を毎回使うと、フレームごとにわずかに異なる拡大率で投影
  // してしまい、多数フレームの重ね合わせで細い部位(腕等)がにじんで
  // 平べったくなる原因になっていた(実地検証で判明)。cx/ybotも同様の理由で
  // 共通基準値(refCx/refYbot)をデフォルトとする。
  // ★ただし、js/turntable_calib.jsのrefineCalibrationAnalysisBySynthesis
  // (§5較正精密化)がpf.cxOverride/ybotOverride/scaleMultを設定した場合は
  // それを優先する。これは上記で問題になった「生のbbox値をそのまま使う」
  // 手法とは別物で、粗彫刻結果への再投影IoU最大化で得た小さな補正量
  // (最大シフト・スケールに上限あり)であり、単なるセグメンテーションノイズ
  // ではなくVeoが完全な剛体回転を守れていない実際のドリフトを補正する値
  // という位置づけ。未精密化のcalibではこれらのフィールドが無いため、
  // 従来どおり共通基準値のみで動く(後方互換)。
  var scalePxPerModelBase = calib.refHeight/modelHeightSpan;
  var cardinalIdx = new Set();
  var ki = calib.keyIdx || {};
  [ki.i0, ki.i90, ki.i180, ki.i270, ki.iEnd].forEach(function(idx){
    if(idx===null || idx===undefined) return;
    cardinalIdx.add(idx);
    if(idx>0) cardinalIdx.add(idx-1);
    cardinalIdx.add(idx+1);
  });
  var useFrames = [];
  calib.perFrame.forEach(function(pf, idx){
    if(pf.w < minWeight) return;
    var sf = sdfFrames[idx];
    if(!sf) return;
    if(!pf.bbox) return;
    var isCardinal = cardinalIdx.has(idx);
    var weight = pf.w * (isCardinal ? CARDINAL_WEIGHT_MULT : 1);
    useFrames.push({
      sdf: sf.sdf, w: sf.w, h: sf.h,
      thetaRad: deg2rad(pf.theta),
      scalePxPerModel: scalePxPerModelBase * (pf.scaleMult || 1),
      cx: (pf.cxOverride!==undefined) ? pf.cxOverride : calib.refCx,
      ybot: (pf.ybotOverride!==undefined) ? pf.ybotOverride : calib.refYbot,
      weight: weight, isCardinal: isCardinal,
    });
  });
  return useFrames;
}

// 0/90/180/270度(isCardinal)は必ず残しつつ、残りのフレームを均等間引きして
// 合計maxCount枚以内に収める(精細パスの高コストな投票の対象フレーム数を
// 抑えるため。理由はcarveMultiviewFieldCoarseToFineのコメント参照)。
function subsampleFramesKeepingCardinals(useFrames, maxCount){
  var cardinals = useFrames.filter(function(f){ return f.isCardinal; });
  var others = useFrames.filter(function(f){ return !f.isCardinal; });
  var otherBudget = Math.max(0, maxCount - cardinals.length);
  if(others.length <= otherBudget) return useFrames;
  var picked = [];
  var stride = others.length / otherBudget;
  for(var i=0; i<otherBudget; i++){
    picked.push(others[Math.floor(i*stride)]);
  }
  return cardinals.concat(picked);
}

// ★voteAtPointは精細パスのnarrow band内で数百万回呼ばれるホットパスのため、
// 呼び出しごとの配列/クロージャ割り当て(GC圧力の主因だった)を避け、
// 使い回しのスクラッチバッファ+モジュールスコープの比較関数を使う。
var _vapValues = null, _vapWeights = null, _vapIdx = null;
function _vapCompare(a, b){ return _vapValues[a]-_vapValues[b]; }

// 単一連結クラスタが吸収してよい重みの上限(全重みに対する比率)。
// ★実地検証で判明した問題: narrow band(表面近傍)の点は多くのフレームで
// dが緩やかに連続変化するため、上限無しの連結だと48枚中40枚以上を1つの
// クラスタに飲み込むことが常態化し、(a)固定10%予算だった旧bottom-k平均より
// 大幅に遅くなる(該当ボクセルが数百万〜数千万に達するnarrow band全体で
// ソート後の走査がほぼ全件に達する)、(b)「狭い可視窓だけを信頼する」という
// 本来の設計意図から外れ、実質的に旧来の広い平均に近づいてしまう、という
// 2つの副作用があった。クラスタ増殖に上限を設け、両方を抑える。
var MAX_CLUSTER_WEIGHT_FRAC = 0.25;

// 1点(モデル空間wx,wy,wz)について、全使用フレームへ投影しSDFを最小値からの
// 単一連結クラスタ平均(clusterMeanFromMin)で合成した値を返す(§6の
// 投票制彫刻のコア)。clusterEpsはモデル単位に変換済みの値(呼び出し側で
// px→モデル単位の変換を1回だけ行い、ホットパスでは変換しない)。
function voteAtPoint(wx, wy, wz, useFrames, clusterEps, myMin){
  var n = useFrames.length;
  if(!_vapValues || _vapValues.length < n){
    _vapValues = new Float64Array(n);
    _vapWeights = new Float64Array(n);
    _vapIdx = new Uint32Array(n);
  }
  var count = 0;
  var totalW = 0;
  for(var f=0; f<n; f++){
    var fr = useFrames[f];
    var cosT=Math.cos(fr.thetaRad), sinT=Math.sin(fr.thetaRad);
    var worldX = wx*cosT + wz*sinT;
    // worldZは奥行き(自己遮蔽の判定には使わない=ビジュアルハルの既知の
    // 限界。§7のphoto-consistencyが本来担当する領域)
    var u = fr.cx + fr.scalePxPerModel*worldX;
    var v = fr.ybot - fr.scalePxPerModel*(wy-myMin);
    if(u<0 || v<0 || u>fr.w-1 || v>fr.h-1) continue; // 画角外は棄権(この点について何も言えない)
    var dPx = P3D.sampleSdfBilinear(fr.sdf, fr.w, fr.h, u, v);
    _vapValues[count] = dPx / fr.scalePxPerModel;
    _vapWeights[count] = fr.weight;
    _vapIdx[count] = count;
    totalW += fr.weight;
    count++;
  }
  if(count===0) return -1;
  var idxView = _vapIdx.subarray(0, count);
  idxView.sort(_vapCompare);
  // 単一連結クラスタリング: 最小値から始め、ソート順に隣接値との差が
  // clusterEps以内である限り取り込む。固定個数/固定比率を強制しないため、
  // クラスタは点ごとに(狭い可視窓の隙間なら少数、広い接線域なら多数と)
  // 自然なサイズになる(§多視点彫刻の統計量見直し、clusterMeanFromMin参照)。
  // ただしMAX_CLUSTER_WEIGHT_FRACで増殖に上限を設ける(上記コメント参照)。
  var capW = MAX_CLUSTER_WEIGHT_FRAC*totalW;
  var accW = _vapWeights[idxView[0]];
  var accWV = _vapValues[idxView[0]] * accW;
  var prevVal = _vapValues[idxView[0]];
  for(var j=1; j<count && accW<capW; j++){
    var v = _vapValues[idxView[j]];
    if(v - prevVal > clusterEps) break;
    accWV += v*_vapWeights[idxView[j]];
    accW += _vapWeights[idxView[j]];
    prevVal = v;
  }
  return accW>0 ? accWV/accW : _vapValues[idxView[0]];
}

/**
 * calib: js/turntable_calib.jsのcalibrateTurntableの戻り値
 * sdfFrames: [{sdf, w, h}] (calib.perFrameと同じindex順、js/edt.jsのsignedDistanceField)
 * opts: {
 *   vox(既定0.02): ボクセルサイズ(モデル単位、XYZ等方)
 *   clusterEpsPx(既定10.0): 単一連結クラスタの許容差(元動画のpx単位)。内部で
 *     モデル単位へ変換してvoteAtPointへ渡す。★実地検証(2026-07-19)で
 *     3.0(較正ノイズだけを想定した小さい値)を試したところ、表面全体が
 *     スパイク状にノイズる結果になった。原因は較正ノイズだけでなく、
 *     隣接フレーム間(64枚/360°で約5.6°刻み)の**真の**形状変化量(曲面なら
 *     角度が変わるだけで実際にd値が数px動く)も同程度の大きさがあり、
 *     3px程度の許容差では表面のほぼ全点でクラスタが1〜2枚しか繋がらず、
 *     実質「較正ノイズも真の変化も区別できない=単一フレームに近い脆弱な
 *     結果」に逆戻りしていたため(較正精密化の有無に関わらず再現したので
 *     精密化由来のノイズではないことを確認済み)。10.0に上げたところ表面が
 *     滑らかになり、0/90/180/270度の再投影IoUもわずかに改善した
 *     (0.86前後→0.89前後)。大きくするとより広いクラスタが形成され滑らか・
 *     ノイズに強くなるが、狭い可視窓の隙間が多数派フレームに薄められて
 *     消えやすくなる方向へ戻っていく(clusterMeanFromMinのコメント参照、
 *     MAX_CLUSTER_WEIGHT_FRACが歯止めにはなる)。小さくすると狭い隙間は
 *     彫れやすいが表面がノイズやすい、というトレードオフのダイヤル。
 *   bounds: {mxBounds,myBounds,mzBounds} (既定DEFAULT_BOUNDS)
 *   minWeight(既定0.3): この信頼度未満のフレームはサンプリングから除外
 *   onProgress(frac): 進捗コールバック
 * }
 * 戻り値: Promise<{field, grid}> (fieldはP3D.marchingCubesにそのまま渡せる
 *   Float32Array、レイアウトiy*(nx*nz)+ix*nz+iz)
 */
async function carveMultiviewField(calib, sdfFrames, opts){
  opts = opts || {};
  var vox = opts.vox || 0.02;
  var clusterEpsPx = (opts.clusterEpsPx===undefined) ? 10.0 : opts.clusterEpsPx;
  var minWeight = (opts.minWeight===undefined) ? 0.3 : opts.minWeight;
  var bounds = opts.bounds || DEFAULT_BOUNDS;
  var onProgress = opts.onProgress || function(){};

  var grid = P3D.buildGrid(bounds.mxBounds, bounds.myBounds, bounds.mzBounds, vox, vox);
  var nx=grid.nx, ny=grid.ny, nz=grid.nz;
  var mx=grid.mx, my=grid.my, mz=grid.mz;
  var myMin = bounds.myBounds[0];

  var useFrames = buildUseFrames(calib, sdfFrames, minWeight);
  if(useFrames.length===0) throw new Error("multiview_hull: 有効なフレームがありません(全て信頼度不足)");
  // clusterEpsPxはvoteAtPointの中で1点ずつ変換すると割り算がホットパスに
  // 乗ってしまうため、フレーム間でほぼ共通のscalePxPerModel(calib.refHeight
  // 由来)を使って1回だけモデル単位に変換する。
  var modelHeightSpanForEps = DEFAULT_BOUNDS.myBounds[1]-DEFAULT_BOUNDS.myBounds[0];
  var clusterEps = clusterEpsPx / (calib.refHeight/modelHeightSpanForEps);

  var field = new Float32Array(nx*ny*nz);
  var strideY = nx*nz, strideX = nz;

  for(var iy=0; iy<ny; iy++){
    var wy = my[iy];
    for(var ix=0; ix<nx; ix++){
      var wx = mx[ix];
      for(var iz=0; iz<nz; iz++){
        field[iy*strideY + ix*strideX + iz] = voteAtPoint(wx, wy, mz[iz], useFrames, clusterEps, myMin);
      }
    }
    if(iy % 4 === 0){
      onProgress(iy/ny);
      await new Promise(function(resolve){ requestAnimationFrame(resolve); });
    }
  }
  onProgress(1);
  return {field: field, grid: grid};
}
P3D.carveMultiviewField = carveMultiviewField;

// field+gridの任意座標(モデル空間)をトリリニア補間でサンプルする。
// ★高頻度に(精細グリッドの全ボクセル分)呼ばれるため、ネストした関数
// (クロージャ)を避けてインライン化し、V8の最適化を妨げないようにしている。
function sampleFieldTrilinear(field, grid, wx, wy, wz){
  var fx = (wx-grid.mxMin)/(grid.mxMax-grid.mxMin)*(grid.nx-1);
  var fy = (wy-grid.myMin)/(grid.myMax-grid.myMin)*(grid.ny-1);
  var fz = (wz-grid.mzMin)/(grid.mzMax-grid.mzMin)*(grid.nz-1);
  if(fx<0||fy<0||fz<0||fx>grid.nx-1||fy>grid.ny-1||fz>grid.nz-1) return -1e6;
  var ix0=fx|0, iy0=fy|0, iz0=fz|0;
  var ix1=Math.min(ix0+1,grid.nx-1), iy1=Math.min(iy0+1,grid.ny-1), iz1=Math.min(iz0+1,grid.nz-1);
  var tx=fx-ix0, ty=fy-iy0, tz=fz-iz0;
  var strideY=grid.nx*grid.nz, strideX=grid.nz;
  var baseY0=iy0*strideY, baseY1=iy1*strideY;
  var baseX0=ix0*strideX, baseX1=ix1*strideX;
  var c000=field[baseY0+baseX0+iz0], c001=field[baseY0+baseX0+iz1];
  var c010=field[baseY0+baseX1+iz0], c011=field[baseY0+baseX1+iz1];
  var c100=field[baseY1+baseX0+iz0], c101=field[baseY1+baseX0+iz1];
  var c110=field[baseY1+baseX1+iz0], c111=field[baseY1+baseX1+iz1];
  var c00=c000*(1-tz)+c001*tz, c01=c010*(1-tz)+c011*tz;
  var c10=c100*(1-tz)+c101*tz, c11=c110*(1-tz)+c111*tz;
  var c0=c00*(1-tx)+c01*tx, c1=c10*(1-tx)+c11*tx;
  return c0*(1-ty)+c1*ty;
}
P3D.sampleFieldTrilinear = sampleFieldTrilinear;

// coarse fieldのうち「表面近傍(narrow band)」とみなせる領域のモデル空間
// bboxを求める(bandMargin以内の値を持つボクセル、無ければ正値=内部の
// ボクセルにフォールバック)。fine gridをこの範囲+paddingだけに絞り込む
// ことで、無駄な空間(既定の外接範囲は上下左右に余裕を持たせてあるため
// 空白域が広い)を精細ボクセルで走査せずに済む。
function tightBoundsFromCoarseField(coarse, bandMargin, paddingVox){
  var grid = coarse.grid, field = coarse.field;
  var nx=grid.nx, ny=grid.ny, nz=grid.nz;
  var strideY=nx*nz, strideX=nz;
  var ixMin=nx, ixMax=-1, iyMin=ny, iyMax=-1, izMin=nz, izMax=-1;
  var ixMin2=nx, ixMax2=-1, iyMin2=ny, iyMax2=-1, izMin2=nz, izMax2=-1;
  for(var iy=0; iy<ny; iy++){
    for(var ix=0; ix<nx; ix++){
      for(var iz=0; iz<nz; iz++){
        var v = field[iy*strideY+ix*strideX+iz];
        if(Math.abs(v) <= bandMargin){
          if(ix<ixMin)ixMin=ix; if(ix>ixMax)ixMax=ix;
          if(iy<iyMin)iyMin=iy; if(iy>iyMax)iyMax=iy;
          if(iz<izMin)izMin=iz; if(iz>izMax)izMax=iz;
        }
        if(v > 0){
          if(ix<ixMin2)ixMin2=ix; if(ix>ixMax2)ixMax2=ix;
          if(iy<iyMin2)iyMin2=iy; if(iy>iyMax2)iyMax2=iy;
          if(iz<izMin2)izMin2=iz; if(iz>izMax2)izMax2=iz;
        }
      }
    }
  }
  // narrow band(境界)が見つからなければ、正値(内部)領域で代用する
  if(ixMax<0){ ixMin=ixMin2; ixMax=ixMax2; iyMin=iyMin2; iyMax=iyMax2; izMin=izMin2; izMax=izMax2; }
  if(ixMax<0) return null; // 完全に空(何も彫れなかった)
  var pad = paddingVox===undefined ? 3 : paddingVox;
  function toWorld(iMin,iMax,axisMin,axisMax,n){
    var lo = axisMin + Math.max(0,iMin-pad)*(axisMax-axisMin)/(n-1);
    var hi = axisMin + Math.min(n-1,iMax+pad)*(axisMax-axisMin)/(n-1);
    return [lo,hi];
  }
  var xB = toWorld(ixMin,ixMax,grid.mxMin,grid.mxMax,nx);
  var yB = toWorld(iyMin,iyMax,grid.myMin,grid.myMax,ny);
  var zB = toWorld(izMin,izMax,grid.mzMin,grid.mzMax,nz);
  return {mxBounds:xB, myBounds:yB, mzBounds:zB};
}
P3D.tightBoundsFromCoarseField = tightBoundsFromCoarseField;

/**
 * §6が挙げる「coarse-to-fine(粗解像度→表面narrow bandのみ本解像度)」の実装。
 * まずcoarseVoxで全体を1回彫刻し、その等値面近傍(bandMargin以内)だけを
 * fineVoxの解像度で再計算する。深い内部/外部はcoarse値をそのまま採用する
 * (投票計算=フレーム数分のループを省略できるため、fineVoxを画像の実ピクセル
 * 相当まで細かくしても、体の表面積相当のボクセル数だけで済み現実的な時間で
 * 終わる)。
 * opts: {coarseVox(既定0.02), fineVox(既定0.006), clusterEpsPx(既定10.0), minWeight,
 *        bandMargin(既定coarseVox*1.5), bounds,
 *        maxFineFrames(既定Infinity=全フレーム使用。★2026-07-19方針変更:
 *          目標が「全フレームの実測シルエットと再投影ピクセル一致」である以上、
 *          精細パスから外したフレームはそのぶん系統的に不一致になる。旧既定48は
 *          64枚抽出時に接線サンプリング誤差≈0.7px(指先=最大半径R≈345px、
 *          R·Δθ²/8)を残していた。全64枚なら≈0.4px。時間コストはフレーム数に
 *          線形(+33%程度)で、性能が問題になる環境では明示的に指定して絞る),
 *        refineCalib(既定true): §5較正精密化(analysis-by-synthesis)を粗彫刻
 *          結果に対して実行し、精密化後のcalibでfineパスを彫刻する,
 *        calibRefineOpts: js/turntable_calib.jsのrefineCalibrationAnalysisBySynthesis
 *          へそのまま渡すopts,
 *        onProgress(frac)}
 * 戻り値: Promise<{field, grid, coarseField, coarseGrid, refinedCalib}>
 *   (refinedCalibはrefineCalib:falseの場合は入力calibそのまま)
 */
async function carveMultiviewFieldCoarseToFine(calib, sdfFrames, opts){
  opts = opts || {};
  var coarseVox = opts.coarseVox || 0.02;
  var fineVox = opts.fineVox || 0.006;
  var clusterEpsPx = (opts.clusterEpsPx===undefined) ? 10.0 : opts.clusterEpsPx;
  var minWeight = (opts.minWeight===undefined) ? 0.3 : opts.minWeight;
  var bounds = opts.bounds || DEFAULT_BOUNDS;
  var bandMargin = (opts.bandMargin===undefined) ? coarseVox*4 : opts.bandMargin;
  var maxFineFrames = opts.maxFineFrames || Infinity;
  var refineCalibFlag = (opts.refineCalib===undefined) ? true : opts.refineCalib;
  var calibRefineOpts = opts.calibRefineOpts || {};
  var onProgress = opts.onProgress || function(){};

  var coarse = await carveMultiviewField(calib, sdfFrames, {
    vox: coarseVox, clusterEpsPx: clusterEpsPx, minWeight: minWeight, bounds: bounds,
    onProgress: function(f){ onProgress(f*0.30); },
  });

  // ★§5較正精密化(analysis-by-synthesis): 粗彫刻結果(3D的に整合したhull)を
  // 各フレームの候補カメラへ再投影し、実測シルエットとのIoUが最大になるよう
  // θ・2Dシフト・スケールをフレームごとに座標降下で微調整する。以降の
  // (tightBoundsFromCoarseField以外の)全処理は精密化後のcalibを使う。
  var refinedCalib = calib;
  if(refineCalibFlag){
    var modelHeightSpan = bounds.myBounds[1]-bounds.myBounds[0];
    var scalePxPerModel = calib.refHeight/modelHeightSpan;
    var coarseMeshForRefine = meshFromField(coarse.field, coarse.grid);
    refinedCalib = P3D.refineCalibrationAnalysisBySynthesis(
      calib, coarseMeshForRefine, sdfFrames, scalePxPerModel, bounds.myBounds[0],
      Object.assign({}, calibRefineOpts, {
        onProgress: function(f){ onProgress(0.30 + f*0.10); },
      })
    );
  }else{
    onProgress(0.40);
  }
  calib = refinedCalib;

  // ★既定の外接範囲(DEFAULT_BOUNDS)は上下左右に余裕を持たせてあるため、
  // 精細グリッドをそのまま既定範囲全体で作ると空白域まで精細ボクセルで
  // 走査することになり非現実的に遅くなる(実測: 1px相当だと2億ボクセル超)。
  // coarse結果から実際の形状(境界近傍+内部)のbboxを求め、少し余白を
  // 持たせた範囲だけを精細グリッドの対象にする。
  var tight = tightBoundsFromCoarseField(coarse, bandMargin, 3) || bounds;
  var grid = P3D.buildGrid(tight.mxBounds, tight.myBounds, tight.mzBounds, fineVox, fineVox);
  var nx=grid.nx, ny=grid.ny, nz=grid.nz;
  var mx=grid.mx, my=grid.my, mz=grid.mz;
  // ★投影の基準点(myMin)は精細グリッドの切り詰め後範囲ではなく、
  // 元の外接範囲(bounds、calibrateTurntableのrefYbot=足裏pxに対応する
  // 基準)を使い続ける必要がある(voteAtPointのv計算はwy-myMinを
  // 「足裏からの高さ」として使うため)。
  var myMin = bounds.myBounds[0];
  var modelHeightSpanForEps = DEFAULT_BOUNDS.myBounds[1]-DEFAULT_BOUNDS.myBounds[0];
  var clusterEps = clusterEpsPx / (calib.refHeight/modelHeightSpanForEps);
  var useFramesAll = buildUseFrames(calib, sdfFrames, minWeight);
  if(useFramesAll.length===0) throw new Error("multiview_hull: 有効なフレームがありません(全て信頼度不足)");
  // ★narrow band内(表面近傍)の1ボクセルごとの投票コストはO(フレーム数)、
  // かつ重み付き分位点の計算にソートを伴うためO(フレーム数 log フレーム数)。
  // 精細解像度(実ピクセル相当)まで細かくすると対象ボクセル数が数百万〜
  // 数千万に達するため、フレーム数がそのまま総計算量に直結し、全148枚
  // 相当を毎回使うと非現実的に遅くなる(実測)。0/90/180/270度(絶対視すべき
  // 基準ビュー、CARDINAL_WEIGHT_MULT参照)は必ず残しつつ、残りは間引いて
  // 上限枚数に収める(粗解像度パスは全フレームを使うため、この間引きは
  // 精細パスの高コストな投票だけに影響する)。
  var useFrames = subsampleFramesKeepingCardinals(useFramesAll, maxFineFrames);
  console.log("  multiview_hull(coarse-to-fine): tight bounds", JSON.stringify(tight),
    "grid", nx+"x"+ny+"x"+nz, "("+(nx*ny*nz).toLocaleString()+" voxels)",
    "fine-pass frames", useFrames.length, "/", useFramesAll.length);

  var field = new Float32Array(nx*ny*nz);
  var strideY = nx*nz, strideX = nz;
  var bandCount = 0, totalCount = nx*ny*nz;

  for(var iy=0; iy<ny; iy++){
    var wy = my[iy];
    for(var ix=0; ix<nx; ix++){
      var wx = mx[ix];
      for(var iz=0; iz<nz; iz++){
        var wz = mz[iz];
        var coarseVal = sampleFieldTrilinear(coarse.field, coarse.grid, wx, wy, wz);
        var val;
        if(Math.abs(coarseVal) > bandMargin){
          val = coarseVal; // 深い内部/外部はcoarse値を信用し、高コストな投影投票は省略する
        }else{
          val = voteAtPoint(wx, wy, wz, useFrames, clusterEps, myMin);
          bandCount++;
        }
        field[iy*strideY + ix*strideX + iz] = val;
      }
    }
    if(iy % 4 === 0){
      onProgress(0.40 + 0.60*(iy/ny));
      await new Promise(function(resolve){ requestAnimationFrame(resolve); });
    }
  }
  onProgress(1);
  console.log("  multiview_hull(coarse-to-fine): narrow band voxels", bandCount, "/", totalCount,
    "("+(100*bandCount/totalCount).toFixed(1)+"%)");
  return {field: field, grid: grid, coarseField: coarse.field, coarseGrid: coarse.grid, refinedCalib: refinedCalib};
}
P3D.carveMultiviewFieldCoarseToFine = carveMultiviewFieldCoarseToFine;

/**
 * field+gridからメッシュを作る(marching cubes → 断片除去 → 法線/巻き補正)。
 * 既存js/carving.jsのP3D.marchingCubes/dropSmallFragments/computeNormalsFixWinding
 * を素直に流用する(§6「marching cubes・断片除去・法線/巻き補正は既存流用」)。
 * opts: {smoothIters(既定0)}
 * ★2026-07-19(ユーザー方針): ラプラシアン平滑化は既定で行わない。目標は
 * 「全フレームの実測シルエットとの再投影ピクセル一致」であり、平滑化は
 * 表面を縮める方向に働いて境界誤差を直接悪化させる(細い部位=ツインテール
 * ほど縮む)。fineVoxが実ピクセル1個相当まで細かい現行設定では、marching
 * cubesの入力fieldが連続値SDFなのでボクセル格子由来のガタつきも元々小さい。
 * 3面方式のfinishBodyMeshの「平滑化してから法線計算」という流儀は、粗い
 * ボクセルで彫っていた頃の名残であり、ここでは踏襲しない。
 * 戻り値: {V,N,F} (Float32Array/Float32Array/Uint32Array)
 */
function meshFromField(field, grid, opts){
  opts = opts || {};
  var smoothIters = (opts.smoothIters===undefined) ? 0 : opts.smoothIters;
  var mc = P3D.marchingCubes(field, grid.ny, grid.nx, grid.nz, 0.0);
  // marchingCubesの頂点はindex空間座標([iy,ix,iz]相当)なので、モデル空間へ変換する
  var nv = mc.verts.length/3;
  var V = new Float32Array(nv*3);
  for(var i=0;i<nv;i++){
    var iy=mc.verts[i*3], ix=mc.verts[i*3+1], iz=mc.verts[i*3+2];
    V[i*3+0] = grid.mxMin + ix*(grid.mxMax-grid.mxMin)/(grid.nx-1);
    V[i*3+1] = grid.myMin + iy*(grid.myMax-grid.myMin)/(grid.ny-1);
    V[i*3+2] = grid.mzMin + iz*(grid.mzMax-grid.mzMin)/(grid.nz-1);
  }
  var F = mc.faces;
  var dropped = P3D.dropSmallFragments(V, F, 0.02);
  V = dropped.V; F = dropped.F;
  if(smoothIters > 0){
    V = P3D.laplacianSmoothPreserveExtent(V, F, smoothIters);
  }
  var fw = P3D.computeNormalsFixWinding(V, F);
  return {V: V, N: fw.N, F: fw.F};
}
P3D.meshFromMultiviewField = meshFromField;

// ---------------------------------------------------------------------
// Stage C: アンカー(js/feature_tracks.jsの3Dアンカー点群)とhull SDFの融合。
// VEO_VIDEO_TO_3D_PLAN.md §16「新パイプライン構成」のStage Cにあたる。
// hullは輪郭(シルエット)だけから彫っているため2つの既知の限界がある:
//   (a) 過彫刻: 単一連結クラスタ平均の副作用で細い部位(ツインテール等)が
//       実際より細く彫れることがある(clusterMeanFromMinのコメント参照)
//   (b) 凹みが彫れない: シルエット交差(visual hull)は原理的に凹みを
//       検出できない(どの角度から見てもシルエットは変わらないため)
// アンカーは「実際にその3D位置に表面がある」という直接証拠なので、これを
// 使ってfieldを局所的に補正する。
// ---------------------------------------------------------------------

// カメラ方向の符号規約(VEO_VIDEO_TO_3D_PLAN.md §3.2のプロンプトVより導出、
// 2026-07-19): 「反時計回り(キャラクターの右肩が先にカメラへ近づく向き)に
// 0度(正面)→90度(右側面)→...」という規約から、u_i=cx+s(x・cosθ_i+z・sinθ_i)
// と同じ回転(-θ_iによるxz平面回転)の直交成分 depth_i(x,z)=-x・sinθ_i+z・cosθ_i
// を考えると、depth_iが大きいほどカメラに近い(2通りの独立な確認: ①正面
// (θ=0)で通常x<0側にある右肩は、depth_0=z_shoulder≈0から始まりθ増加に
// つれてdepth≈|x_shoulder|・sinθと単調増加=カメラに近づく、というプロンプトの
// 記述と整合。②θ=90°=「右側面」ではdepth_90(x,z)=-xなので、右肩(x<0)は
// depth_90=|x_shoulder|>0で最大=最も近い点になり、「右側面がカメラに正対する」
// という規約と整合)。したがって「アンカーからカメラへ向かう方向」は
// +depthDir_i=(-sinθ_i, cosθ_i)(xz平面内の単位ベクトル)。
function cameraDepthDir(thetaRad){
  return [-Math.sin(thetaRad), Math.cos(thetaRad)];
}
P3D._cameraDepthDirForTest = cameraDepthDir; // Node合成テスト(符号検証)専用のフック

// 1点(モデル空間)について、全使用フレームへ投影しSDFを取った「厳密な
// 単一フレームの最小値」(クラスタ平均を取らない、素のvisual hull)を返す。
// これは「どの1フレームの証拠とも矛盾しない」という意味で本来の輪郭ベース
// hullの上限(その値を超えて内側だと主張すると、必ずどれかのフレームの
// シルエットと矛盾する)。過彫刻(アンカーが外側)を押し戻す際、この値を
// 超えて押し戻さないようにする「上限」として使う(voteAtPointは軽量化の
// ためスクラッチバッファを使うが、ここはアンカー点数個(全トラック分、
// 数百点程度)でしか呼ばないため素直な実装でよい)。
function hardHullAtPoint(wx, wy, wz, useFrames, myMin){
  var minVal = Infinity, count = 0;
  for(var f=0; f<useFrames.length; f++){
    var fr = useFrames[f];
    var cosT=Math.cos(fr.thetaRad), sinT=Math.sin(fr.thetaRad);
    var worldX = wx*cosT + wz*sinT;
    var u = fr.cx + fr.scalePxPerModel*worldX;
    var v = fr.ybot - fr.scalePxPerModel*(wy-myMin);
    if(u<0 || v<0 || u>fr.w-1 || v>fr.h-1) continue;
    var dPx = P3D.sampleSdfBilinear(fr.sdf, fr.w, fr.h, u, v);
    var dModel = dPx/fr.scalePxPerModel;
    if(dModel<minVal) minVal=dModel;
    count++;
  }
  return count>0 ? minVal : -1e6;
}

// アンカー周辺(半径radiusModel、モデル空間)のfieldを、中心に近いほど
// targetValへ強く引き上げる(max更新、線形フォールオフ)。過彫刻の押し戻し用
// (fieldを下げる方向には絶対に使わない=既存の彫刻結果を悪化させない)。
function applyRadialMax(field, grid, cx, cy, cz, radiusModel, targetVal){
  var nx=grid.nx, ny=grid.ny, nz=grid.nz;
  var strideY=nx*nz, strideX=nz;
  var dxVox=(grid.mxMax-grid.mxMin)/(nx-1), dyVox=(grid.myMax-grid.myMin)/(ny-1), dzVox=(grid.mzMax-grid.mzMin)/(nz-1);
  var ixC=(cx-grid.mxMin)/dxVox, iyC=(cy-grid.myMin)/dyVox, izC=(cz-grid.mzMin)/dzVox;
  var rxVox=Math.ceil(radiusModel/dxVox), ryVox=Math.ceil(radiusModel/dyVox), rzVox=Math.ceil(radiusModel/dzVox);
  var ix0=Math.max(0,Math.floor(ixC-rxVox)), ix1=Math.min(nx-1,Math.ceil(ixC+rxVox));
  var iy0=Math.max(0,Math.floor(iyC-ryVox)), iy1=Math.min(ny-1,Math.ceil(iyC+ryVox));
  var iz0=Math.max(0,Math.floor(izC-rzVox)), iz1=Math.min(nz-1,Math.ceil(izC+rzVox));
  for(var iy=iy0; iy<=iy1; iy++){
    var wy = grid.myMin+iy*dyVox, dy=wy-cy;
    for(var ix=ix0; ix<=ix1; ix++){
      var wx = grid.mxMin+ix*dxVox, dx=wx-cx;
      for(var iz=iz0; iz<=iz1; iz++){
        var wz = grid.mzMin+iz*dzVox, dz=wz-cz;
        var dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
        if(dist>radiusModel) continue;
        var falloff = 1 - dist/radiusModel;
        var idx = iy*strideY+ix*strideX+iz;
        var candidate = targetVal*falloff + field[idx]*(1-falloff);
        if(candidate>field[idx]) field[idx]=candidate;
      }
    }
  }
}

// アンカー位置からdepthDir方向(カメラ側)へ長さlengthModelのカプセル状
// (半径radiusModel)領域を彫る(min更新、線形フォールオフ)。アンカー側
// (t=0)はほぼ境界(0付近)、カメラ側の端(t=length)ほど確実に外側という
// 線形勾配をtargetとする。凹み(手前の過剰な体積)の除去用(fieldを上げる
// 方向には絶対に使わない)。
function carveAlongRaySegment(field, grid, ax, ay, az, dirX, dirZ, lengthModel, radiusModel){
  if(lengthModel<=0) return;
  var nx=grid.nx, ny=grid.ny, nz=grid.nz;
  var strideY=nx*nz, strideX=nz;
  var dxVox=(grid.mxMax-grid.mxMin)/(nx-1), dyVox=(grid.myMax-grid.myMin)/(ny-1), dzVox=(grid.mzMax-grid.mzMin)/(nz-1);
  var exz = [ax+dirX*lengthModel, az+dirZ*lengthModel];
  var loX=Math.min(ax,exz[0])-radiusModel, hiX=Math.max(ax,exz[0])+radiusModel;
  var loZ=Math.min(az,exz[1])-radiusModel, hiZ=Math.max(az,exz[1])+radiusModel;
  var loY=ay-radiusModel, hiY=ay+radiusModel;
  var ix0=Math.max(0,Math.floor((loX-grid.mxMin)/dxVox)), ix1=Math.min(nx-1,Math.ceil((hiX-grid.mxMin)/dxVox));
  var iz0=Math.max(0,Math.floor((loZ-grid.mzMin)/dzVox)), iz1=Math.min(nz-1,Math.ceil((hiZ-grid.mzMin)/dzVox));
  var iy0=Math.max(0,Math.floor((loY-grid.myMin)/dyVox)), iy1=Math.min(ny-1,Math.ceil((hiY-grid.myMin)/dyVox));
  var carveMag = Math.max(dxVox,dyVox,dzVox)*3; // カメラ側の端で確実に外側とみなす基準の大きさ(ボクセル数個分)
  for(var iy=iy0; iy<=iy1; iy++){
    var wy=grid.myMin+iy*dyVox, dy=wy-ay;
    for(var ix=ix0; ix<=ix1; ix++){
      var wx=grid.mxMin+ix*dxVox, dx=wx-ax;
      for(var iz=iz0; iz<=iz1; iz++){
        var wz=grid.mzMin+iz*dzVox, dz=wz-az;
        var t = dx*dirX+dz*dirZ; // dirはxz平面内の単位ベクトル
        var tClamped = Math.max(0, Math.min(lengthModel, t));
        var px = ax+dirX*tClamped, pz = az+dirZ*tClamped;
        var perpX=wx-px, perpZ=wz-pz;
        var perpDist = Math.sqrt(perpX*perpX+perpZ*perpZ+dy*dy);
        if(perpDist>radiusModel) continue;
        var falloffR = 1 - perpDist/radiusModel;
        var alongFrac = tClamped/lengthModel; // 0=アンカー側、1=カメラ側
        var targetVal = -alongFrac*carveMag;
        var idx=iy*strideY+ix*strideX+iz;
        var candidate = targetVal*falloffR + field[idx]*(1-falloffR);
        if(candidate<field[idx]) field[idx]=candidate;
      }
    }
  }
}
P3D._carveAlongRaySegmentForTest = carveAlongRaySegment; // Node合成テスト専用のフック

/**
 * carveResult: carveMultiviewFieldCoarseToFineの戻り値
 *   ({field,grid,coarseField,coarseGrid,refinedCalib})
 * sdfFrames: calibと同じindex順のsignedDistanceField配列
 * featureTracks: js/feature_tracks.jsのcomputeFeatureTracksの戻り値
 *   (.tracks配列。各要素が{x,y,z,obs,residualPx,nObs})
 * opts: {minWeight(既定0.3, buildUseFramesに渡す信頼度下限),
 *        outsideMarginPx(既定1.0, これを超えて外側なら過彫刻とみなす),
 *        insideMarginPx(既定3.0, これを超えて内側なら凹みとみなす),
 *        blendRadiusPx(既定6.0, 過彫刻補正の適用半径),
 *        carveRadiusPx(既定4.0, 空間彫りのトンネル半径),
 *        maxCarveDepthPx(既定60.0, 空間彫りの最大長さ), onProgress(frac)}
 * 戻り値: {field(新規Float32Array、gridはcarveResult.gridを共有), grid,
 *          stats:{overCarved,concave,unfixable,untouched,totalAnchors}}
 */
function fuseAnchorsIntoHull(carveResult, sdfFrames, featureTracks, opts){
  opts = opts || {};
  var minWeight = (opts.minWeight===undefined) ? 0.3 : opts.minWeight;
  var calib = carveResult.refinedCalib;
  var grid = carveResult.grid;
  var useFrames = buildUseFrames(calib, sdfFrames, minWeight);
  var modelHeightSpan = DEFAULT_BOUNDS.myBounds[1]-DEFAULT_BOUNDS.myBounds[0];
  var scalePxPerModelBase = calib.refHeight/modelHeightSpan;
  var myMin = DEFAULT_BOUNDS.myBounds[0];

  var outsideMarginModel = ((opts.outsideMarginPx===undefined)?1.0:opts.outsideMarginPx)/scalePxPerModelBase;
  var insideMarginModel = ((opts.insideMarginPx===undefined)?3.0:opts.insideMarginPx)/scalePxPerModelBase;
  var blendRadiusModel = ((opts.blendRadiusPx===undefined)?6.0:opts.blendRadiusPx)/scalePxPerModelBase;
  var carveRadiusModel = ((opts.carveRadiusPx===undefined)?4.0:opts.carveRadiusPx)/scalePxPerModelBase;
  var maxCarveDepthModel = ((opts.maxCarveDepthPx===undefined)?60.0:opts.maxCarveDepthPx)/scalePxPerModelBase;
  var onProgress = opts.onProgress || function(){};

  var field = carveResult.field.slice(); // 元のfieldは保持し、複製に対して補正する
  var anchors = (featureTracks && featureTracks.tracks) || [];
  var stats = {overCarved:0, concave:0, unfixable:0, untouched:0, totalAnchors:anchors.length};

  anchors.forEach(function(a, idx){
    var fieldVal = sampleFieldTrilinear(field, grid, a.x, a.y, a.z);
    if(fieldVal < -outsideMarginModel){
      // 過彫刻: hard hull(全フレーム厳密min、シルエット整合の上限)を超えない
      // 範囲でfieldを押し戻す。
      var hardVal = hardHullAtPoint(a.x, a.y, a.z, useFrames, myMin);
      if(hardVal <= 0){ stats.unfixable++; return; } // どのフレームも外側と言っている=補正不可
      var target = Math.min(hardVal, insideMarginModel*0.3); // 表面近くに留め、内側へ入れすぎない
      applyRadialMax(field, grid, a.x, a.y, a.z, blendRadiusModel, target);
      stats.overCarved++;
    } else if(fieldVal > insideMarginModel){
      // 凹み: 観測した各フレームの視線に沿って手前(カメラ側)を彫る
      // (対応点既知のspace carving)。彫る長さはこのアンカーの現在の
      // 「内側の深さ」(fieldVal)を目安にする(=元の表面付近まで届く)。
      var carveLen = Math.min(fieldVal, maxCarveDepthModel);
      a.obs.forEach(function(o){
        var pf = calib.perFrame[o.frameIdx];
        if(!pf) return;
        var dir = cameraDepthDir(pf.theta*Math.PI/180);
        carveAlongRaySegment(field, grid, a.x, a.y, a.z, dir[0], dir[1], carveLen, carveRadiusModel);
      });
      stats.concave++;
    } else {
      stats.untouched++;
    }
    if(idx % 40 === 0) onProgress(idx/anchors.length);
  });
  onProgress(1);
  return {field: field, grid: grid, stats: stats};
}
P3D.fuseAnchorsIntoHull = fuseAnchorsIntoHull;

})(window);
