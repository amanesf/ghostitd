# -*- coding: utf-8 -*-
"""各ステージで少しずつ違う形に再実装されていたヘルパーをここに集約する。

挙動は変えていない: 呼び出し側ごとに微妙に違っていたパラメータ(行ラン検出の
gap許容量など)は、暗黙に統一するのではなく find_runs(mask1d, gap=...) の
引数として明示的に渡す形にした。
"""
import base64
import json
import os
from io import BytesIO

import numpy as np
from PIL import Image
from scipy import ndimage


def load_mask(png_path, thr=8):
    """*_cut.png のアルファチャンネルから2値シルエットマスクを作る。"""
    return np.asarray(Image.open(png_path))[:, :, 3] > thr


def load_continuous(png_path):
    """front/back/side.png(2値化前の元画像)からmin(R,G,B)の連続値配列を作る。
    white_background_maskの2値化と同じ値(mn)で、find_runs_subpixelの
    サブピクセル境界補正に使う。"""
    return np.asarray(Image.open(png_path).convert('RGB'), dtype=np.float32).min(axis=2)


def load_exclude_mask(view, W, H):
    """landmarks_ai.jsonのexclude_masks[view](landmark_tool.htmlで塗った
    「シルエット測定から除外する範囲」、data:image/png;base64,...形式)を読み、
    front.png等と同じ解像度のbool配列(True=除外)を返す。前髪が首に
    かぶって幅が実際より太く測定される、といった隣接パーツの混入をユーザーが
    直接塗って除外できるようにするためのもの(2026-07-03〜、パーツごとの
    幅/奥行き上書きパネルに代わる仕組み)。
    定義が無い/サイズが一致しなければNone(=何も除外しない)。"""
    if not os.path.exists('landmarks_ai.json'):
        return None
    LMD = json.load(open('landmarks_ai.json'))
    data_url = (LMD.get('exclude_masks') or {}).get(view)
    if not data_url:
        return None
    try:
        _, b64 = data_url.split(',', 1)
        im = Image.open(BytesIO(base64.b64decode(b64))).convert('RGBA')
    except Exception as e:
        print("  exclude_mask", view, "読み込み失敗、無視します:", e)
        return None
    if im.size != (W, H):
        print("  exclude_mask", view, "サイズ不一致、無視します", im.size, (W, H))
        return None
    alpha = np.asarray(im)[:, :, 3]
    return alpha > 128


# ★モデル生成パラメータのランドマークツール公開(2026-07-04〜、ユーザー指示:
# 「vox解像度とか頂点数とか色々試したいから設定できるようにして」)。
# 従来はcarving.py/visual_hull.py/accessories.py/prep.py/model_export.py各所に
# 直書きされていたハードコード値を、landmark_tool.htmlの「パラメータ」タブで
# 調整できるよう、ここに既定値の単一のソースとして集約する。
# 既定値はこれまで直書きされていた値と完全に一致させてある(landmarks_ai.jsonに
# gen_paramsが無い/キーが欠けている場合は、変更前と全く同じ挙動になる)。
DEFAULT_GEN_PARAMS = {
    # ---- ボクセル/メッシュ生成 ----
    'body_vox': 0.002,          # 全身のボクセル解像度(model単位)
    'acc_vox': 0.006,           # アクセサリーのボクセル解像度(model単位)
    'body_decimate': True,      # 全身を目標頂点数まで間引くか
    'body_target_verts': 50000,  # 全身の間引き後目標頂点数
    'acc_decimate': False,      # アクセサリーを目標頂点数まで間引くか
    'acc_target_verts': 20000,  # アクセサリーの間引き後目標頂点数
    'psq_hull': 2.2,            # 断面スーパー楕円の指数(2に近いほど円形)
    'track_gap': 6,             # 行トラッキング: 継続許容ギャップ(行数)
    'track_win': 9,             # 行トラッキング: 中央値フィルタ窓幅(行数)
    'body_smooth_iters': 25,    # 全身のHC-Laplacian平滑化反復回数
    'acc_smooth_iters': 25,     # アクセサリーのHC-Laplacian平滑化反復回数
    'arm_circle': True,         # 腕を骨線分基準の円形断面にするか
    'arm_tol': 0.06,            # 腕ボーン線分からこの距離以内を腕として扱う
    'arm_max_hw': 0.07,         # これより太いセグメントは腕とみなさない
    'subpixel': True,           # 幅/奥行き測定のサブピクセル境界補正
    # ---- 背景/しきい値 ----
    'white_thr': 250,           # 白背景と判定する明るさのしきい値(0-255)
    'alpha_dilate': 9,          # 縁の色にじみ処理の膨張量(px)
    # ---- アクセサリーのローカル背景除去 ----
    'band_h': 220,              # 帯の高さ(px)
    'band_overlap': 40,         # 帯どうしの重なり(px)
    # ---- テクスチャ ----
    'kb_per_face': 200,         # アトラス1面あたりの目標容量上限(KB)
}


def load_gen_params():
    """landmarks_ai.jsonのgen_params(ランドマークツールの「パラメータ」タブで
    設定)を読み、欠けている項目はDEFAULT_GEN_PARAMSで埋めて返す。
    landmarks_ai.json自体が無い/gen_paramsが無い場合は既定値のみを返す
    (=これまでと完全に同じ挙動)。"""
    params = dict(DEFAULT_GEN_PARAMS)
    if os.path.exists('landmarks_ai.json'):
        try:
            LMD = json.load(open('landmarks_ai.json'))
        except Exception:
            LMD = {}
        gp = LMD.get('gen_params') or {}
        for k in DEFAULT_GEN_PARAMS:
            if k in gp and gp[k] is not None:
                params[k] = gp[k]
    return params


def white_background_mask(rgb, white_thr=250, also_passable=None):
    """外周(画像/クロップの縁)に連結した「白背景」領域をflood fillで求めて
    boolマスク(True=背景)で返す。rgbは(H,W,3)のfloat/uint8。

    ★ゆるいグラデーション救済は廃止(2026-07-04、ユーザー指示): 以前は
    「純白(>white_thr) または (明るく(>soft_thr) かつ 勾配が緩い(<grad_thr))」
    を通行可能としており、背景のビネット(ごく薄いグラデーション)を拾う
    目的だったが、白いソックス等の衣装の淡い陰影も同じ条件(明るい・勾配が
    緩い)を満たしてしまい、輪郭が本来の絵より細く削れる原因になっていた。
    判定はwhite_thrによる純白判定のみに戻す(境界のシャープさで十分
    輪郭を追えることを実画像で確認済み)。

    ★オブジェクト内部の白い隙間(2026-07-03〜): 髪の房と体の間のような、
    キャラクター自身の輪郭に完全に囲まれて画像/クロップの外周に繋がらない
    白い隙間(本来は背景が見えている部分)は、上記の連結flood fillだけでは
    絶対に「背景」と判定できない(外周から辿り着けないため)。この隙間の
    真の境界は「白かどうか」だけでは(輪郭線のAAと区別がつかず)自動検出
    できないため、landmark_tool.htmlの「除外」タブでユーザーが直接塗った
    領域(load_exclude_mask)をalso_passableとして渡せるようにし、flood fill
    が塗った領域を「白と同様に通行可能」として突き抜けられるようにする。
    塗った領域自体が輪郭線をまたいで外周と繋がる「橋」になることで、
    その先にある本当の隙間までflood fillが到達し、隙間全体を正しく背景と
    判定できる(単に塗った領域だけを後から除外する旧来の使い方より強力:
    塗る範囲は隙間の一部を橋渡しするだけで済み、隙間の輪郭を正確になぞる
    必要がない)。"""
    a = np.asarray(rgb, dtype=np.float32)
    mn = a.min(axis=2)
    passable = mn > white_thr
    if also_passable is not None:
        passable = passable | also_passable
    struct = np.ones((3, 3), dtype=bool)
    lbl, _ = ndimage.label(passable, structure=struct)
    border = set(lbl[0, :]) | set(lbl[-1, :]) | set(lbl[:, 0]) | set(lbl[:, -1])
    border.discard(0)
    return np.isin(lbl, list(border)) if border else np.zeros(mn.shape, dtype=bool)


def find_runs(mask1d, gap=1):
    """1次元boolean配列から、gapピクセル以内の隙間を許容してつながる
    連続run(開始,終了)のリストを返す。"""
    idx = np.where(mask1d)[0]
    if len(idx) == 0:
        return []
    out = []
    s = idx[0]
    p = idx[0]
    for x in idx[1:]:
        if x <= p + gap:
            p = x
        else:
            out.append((int(s), int(p)))
            s = x
            p = x
    out.append((int(s), int(p)))
    return out


def _subpixel_edge(cont1d, i_in, i_out, thr):
    """内側(値<=thr側)i_inと外側(値>thr側)i_outの間で、連続値cont1dが
    ちょうどthrを跨ぐ位置を線形補間したサブピクセル座標を返す。"""
    v_in = float(cont1d[i_in]); v_out = float(cont1d[i_out])
    if v_out == v_in:
        return float(i_in)
    t = max(0.0, min(1.0, (thr - v_in) / (v_out - v_in)))
    return i_in + t * (i_out - i_in)


def find_runs_subpixel(mask1d, cont1d, thr, gap=1):
    """find_runs()と同じrun検出(2値マスク、連結性・除外マスクのブリッジ等は
    従来通りこちらに従う)をしたうえで、各runの両端だけ連続値(2値化前の
    アンチエイリアス込みの生の輝度値、cont1d)からサブピクセル位置に補正する
    (2026-07-04〜、ユーザー指摘: 2値マスクで幅/奥行きを行ごとに測ると、
    元絵は滑らかな線でも整数ピクセル単位の階段になり、それがそのまま
    3Dモデルの縦方向のガタつきとして出ていた)。
    2値マスクの内側最終画素(run終端)と、その1つ外側の画素の間で連続値が
    thrを跨ぐ点を線形補間するだけなので、run自体の検出結果(どの区間が
    runになるか)はfind_runsと完全に同じで、境界位置だけが整数から浮動小数点
    になる。"""
    runs = find_runs(mask1d, gap=gap)
    n = len(mask1d)
    out = []
    for s, e in runs:
        rs = _subpixel_edge(cont1d, s, s - 1, thr) if s - 1 >= 0 else float(s)
        re = _subpixel_edge(cont1d, e, e + 1, thr) if e + 1 < n else float(e)
        out.append((rs, re))
    return out


def py_of(v, ytop, ybot):
    """ランドマークのv座標(0=頭頂,1=足元)を画像のpy(行)に変換する。"""
    return int(round(ytop + v * (ybot - ytop)))


def spy_of(v, sytop, sybot):
    """v座標をside画像のpy(行)に変換する。"""
    return int(round(sytop + v * (sybot - sytop)))


def MX(px, cx, scale):
    """画像px座標 → モデルx座標(中心cx、+X=画像右方向)。"""
    return (px - cx) / scale


def MY(py, ybot, scale):
    """画像py座標 → モデルy座標(0=足元,1=頭頂側、scale=YBOT-YTOP)。"""
    return (ybot - py) / scale


# ---------------- glTF定数(pygltflibの生の整数値に名前を付ける) ----------------
GLTF_FLOAT = 5126
GLTF_USHORT = 5123
GLTF_UINT = 5125
GLTF_ARRAY_BUFFER = 34962
GLTF_ELEMENT_ARRAY_BUFFER = 34963
GLTF_LINEAR = 9729          # magFilter/minFilter
GLTF_REPEAT = 33071         # wrapS/wrapT
