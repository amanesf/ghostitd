# -*- coding: utf-8 -*-
"""各ボーンのpivot座標を計算する(stage_skeleton)。

BONES/BHIER(23ボーンの階層定義)はここが単一のソース。以前はstage_visual_hull/
stage_accessories/stage_skin_glbの3箇所に同じリストが複製されていた。
"""
import numpy as np
import json
from PIL import Image

from .common import find_runs, MX as _MX, MY as _MY, py_of as _py_of

BONES = ['hips','torso','chest','neck','head',
         'clavicle_L','upperarm_L','forearm_L','wrist_L','hand_L',
         'clavicle_R','upperarm_R','forearm_R','wrist_R','hand_R',
         'thigh_L','shin_L','foot_L','toe_L',
         'thigh_R','shin_R','foot_R','toe_R']

BHIER = {'hips':None,'torso':'hips','chest':'torso','neck':'chest','head':'neck',
 'clavicle_L':'chest','upperarm_L':'clavicle_L','forearm_L':'upperarm_L','wrist_L':'forearm_L','hand_L':'wrist_L',
 'clavicle_R':'chest','upperarm_R':'clavicle_R','forearm_R':'upperarm_R','wrist_R':'forearm_R','hand_R':'wrist_R',
 'thigh_L':'hips','shin_L':'thigh_L','foot_L':'shin_L','toe_L':'foot_L',
 'thigh_R':'hips','shin_R':'thigh_R','foot_R':'shin_R','toe_R':'foot_R'}

BIDX = {b: i for i, b in enumerate(BONES)}


def load_pivots():
    """skeleton.jsonからpivot辞書(ボーン名→np.array[3])を読み込む
    (stage_visual_hull/stage_accessories/stage_skin_glbで共通の読み込み処理)。"""
    SK = json.load(open('skeleton.json'))
    piv = {k: np.array(v, float) for k, v in SK['pivots'].items()}
    for k, v in SK['meta'].get('extra_pivots', {}).items():
        piv[k] = np.array(v, float)
    return piv


def stage_skeleton():
    """各ボーンのpivot座標だけを計算する軽量ステージ。

    以前はvisual hull導入前の筒メッシュ生成(旧stage_gen_spine/gen_limbs/slim/
    bake_sideu、計約840行)がこれを兼ねていたが、そのメッシュ出力(V/N/F/VS/NS)は
    stage_visual_hull/stage_skin_glbのどちらからも参照されておらず(参照されるのは
    各パーツのpivotとmeta.extra_pivotsのみ)、大半が死んだコードになっていた。
    ここではpivot計算に必要な部分だけを残す。頭/首/胸/腰/腰は landmarks からの
    直接式で求まるが、腕/脚のpivotは実際のシルエット幅測定(移動平均平滑化込み)が
    必要なため、その部分は元の測定ロジックをそのまま流用している。
    """
    fa = np.asarray(Image.open('front_cut.png'))[:,:,3] > 8
    H,W = fa.shape
    P = json.load(open('profile.json')); M = P['meta']
    YTOP,YBOT,CX = M['YTOP'],M['YBOT'],M['CX']
    SCALE = (YBOT-YTOP)

    def py_of(v): return _py_of(v, YTOP, YBOT)
    def MX(px): return _MX(px, CX, SCALE)
    def MY(py): return _MY(py, YBOT, SCALE)
    def row_runs(mask,y):
        return find_runs(mask[y], gap=1)
    def smooth1(vals,win=5):
        n=len(vals)
        if n<max(6,win+1): return list(vals)
        k=win//2
        return [sum(vals[max(0,i-k):min(n,i+k+1)])/(min(n,i+k+1)-max(0,i-k)) for i in range(n)]

    LM = json.load(open('landmarks.json'))
    HEAD_BOTTOM_V=LM['head_bottom_v']; SHOULDER_V=LM['shoulder_v']; MERGE_END_V=LM['merge_end_v']
    SHOULDER_HW=LM['shoulder_hw_px']; WAIST_V=LM['waist_v']; HIP_V=LM['hip_v']
    CHEST_V=LM.get('chest_v', SHOULDER_V+0.45*(WAIST_V-SHOULDER_V))
    KNEE_V=LM['knee_v']; ANKLE_V=LM['ankle_v']; ELBOW_FRAC=LM.get('elbow_frac',0.47)
    WRIST_MX={'L':LM.get('wrist_L_mx'),'R':LM.get('wrist_R_mx')}
    ELBOW_MX={'L':LM.get('elbow_L_mx'),'R':LM.get('elbow_R_mx')}
    TOE_V=LM.get('toe_v', ANKLE_V+0.85*(1.0-ANKLE_V))

    pivots={}; extra_pivots={}

    # ---- spine: landmarksからの直接式(実測メッシュ生成には依存しない) ----
    pivots['head']=(0.0, MY(py_of(HEAD_BOTTOM_V)), 0.0)
    pivots['neck']=(0.0, MY(py_of(SHOULDER_V)), 0.0)
    pivots['chest']=(0.0, MY(py_of(CHEST_V)), 0.0)
    pivots['torso']=(0.0, MY(py_of(WAIST_V)), 0.0)
    hips_pivot_v = WAIST_V+0.3*(HIP_V-WAIST_V)
    pivots['hips']=(0.0, MY(py_of(hips_pivot_v)), 0.0)

    for s in ('L','R'):
        c=LM.get('clavicle_%s_m'%s)
        if c is None:
            sgn=-1.0 if s=='L' else 1.0
            c=[sgn*SHOULDER_HW*0.45/SCALE, 1.0-SHOULDER_V, 0.0]
        extra_pivots['clavicle_%s'%s]=[float(c[0]),float(c[1]),float(c[2])]

    # ---- arms: 肩帯を前面シルエットの列(column)ごとに走査して中心線を実測 ----
    def col_thickness(x,y0,y1):
        col=fa[y0:y1,x]; idx=np.where(col)[0]
        if len(idx)<2: return None
        top=y0+idx.min(); bot=y0+idx.max(); return top,bot
    _arm_margin=int(0.3*SHOULDER_HW)
    ay0=py_of(SHOULDER_V)-_arm_margin; ay1=py_of(MERGE_END_V)+_arm_margin
    sh_half=int(round(SHOULDER_HW))
    for side in ['L','R']:
        xs=list(range(CX+sh_half,W-2)) if side=='R' else list(range(CX-sh_half,2,-1))
        cols=[]
        for x in xs:
            tb=col_thickness(x,ay0,ay1)
            if tb:
                t,b=tb; cols.append((x,(t+b)/2,(b-t)/2))
        if len(cols)<6:
            print("arm cols few",side,len(cols)); continue
        cols=np.array(cols)
        xq=np.linspace(cols[0,0],cols[-1,0],22)
        cyq=np.interp(xq,cols[:,0],cols[:,1]) if side=='R' else np.interp(xq,cols[::-1,0],cols[::-1,1])
        cyq=[int(round(y)) for y in cyq]           # 元コードは丸め後のpyでリング化してから平滑化する
        cyq=smooth1([MY(py) for py in cyq])        # ★ 元_smooth_rings(axis='x')相当: 中心線(y)の移動平均平滑化(model単位で)
        mxs=MX(xq)
        ne=len(xq)
        emx=ELBOW_MX[side]
        ke=int(round(ne*ELBOW_FRAC)) if emx is None else int(np.argmin(np.abs(mxs-emx)))
        ke=max(1,min(ke,ne-4))
        wmx=WRIST_MX[side]
        kw=int(round(ne*0.78)) if wmx is None else int(np.argmin(np.abs(mxs-wmx)))
        kw=max(ke+2,min(kw,ne-3))
        shoulder=(float(mxs[0]), float(cyq[0]), 0.0)
        elbow=(float(mxs[ke]), float(cyq[ke]), 0.0)
        wrist=(float(mxs[kw]), float(cyq[kw]), 0.0)
        pivots[f'upperarm_{side}']=shoulder
        pivots[f'forearm_{side}']=elbow
        pivots[f'wrist_{side}']=wrist
        # ★ TEX-1対策(旧): hand_L/Rはジオメトリを持たない(視認不可のため生成しない)。
        #   ボーン生成のKeyErrorを防ぐためpivotのみextra_pivotsに登録。
        extra_pivots[f'hand_{side}']=[float(wrist[0]),float(wrist[1]),float(wrist[2])]

    # ---- legs: 前面シルエットの行(row)ごとに左右の脚ランを実測 ----
    def leg_runs(v):
        r=row_runs(fa,py_of(v))
        r=[x for x in r if x[1]-x[0]>6]
        L=[x for x in r if (x[0]+x[1])/2<CX]
        R=[x for x in r if (x[0]+x[1])/2>=CX]
        def pick(lst): return max(lst,key=lambda ab:ab[1]-ab[0]) if lst else None
        return pick(L),pick(R)
    for side,sel in [('L',0),('R',1)]:
        def leg_center_at(v):
            runs=leg_runs(v); rn=runs[sel]
            if rn is None: return None
            a,b=rn; return (MX((a+b)/2), MY(py_of(v)), v)
        def seg_centers(v0,v1,n):
            out=[]
            for i in range(n):
                v=v0+(v1-v0)*i/(n-1); c=leg_center_at(v)
                if c is not None: out.append(c)
            return out
        thigh=seg_centers(HIP_V,KNEE_V+0.010,12)
        shin=seg_centers(KNEE_V-0.010,ANKLE_V+0.010,10)
        ankle_c=leg_center_at(ANKLE_V)
        if shin and ankle_c is not None: shin[-1]=ankle_c
        def smooth_cx(pts):   # ★ 元_smooth_rings(axis='y')相当: 中心線(x)の移動平均平滑化
            if len(pts)<6: return pts
            xs=smooth1([p[0] for p in pts])
            return [(xs[i],pts[i][1],pts[i][2]) for i in range(len(pts))]
        thigh=smooth_cx(thigh); shin=smooth_cx(shin)
        FOOT_BOT=0.998
        foot_full=seg_centers(ANKLE_V-0.010,FOOT_BOT,9)
        if foot_full and ankle_c is not None: foot_full[0]=ankle_c
        foot_bot_c=leg_center_at(FOOT_BOT)
        if foot_full and foot_bot_c is not None: foot_full[-1]=foot_bot_c
        if foot_full:
            # ★ 元コードのバグを維持(挙動を変えないための意図的な再現): 本来はfoot_vs
            #   もTOE_Vと同じv系(0=頭,1=足)で比較すべきだが、元コードはMY系(0=足,1=頭)の
            #   値とv系のTOE_Vを直接比較しており、実質ksp=nf-2(足首寄り)に固定される。
            #   挙動を変えないためここでもfoot_vs=MY値のまま比較する。
            foot_vs=np.array([p[1] for p in foot_full])
            ksp=int(np.argmin(np.abs(foot_vs-TOE_V)))
            ksp=max(1,min(ksp,len(foot_full)-2))
        else:
            ksp=0
        if thigh: pivots[f'thigh_{side}']=(float(thigh[0][0]),float(thigh[0][1]),0.0)
        if shin: pivots[f'shin_{side}']=(float(shin[0][0]),float(shin[0][1]),0.0)
        if foot_full:
            pivots[f'foot_{side}']=(float(foot_full[0][0]),float(foot_full[0][1]),0.0)
            pivots[f'toe_{side}']=(float(foot_full[ksp][0]),float(foot_full[ksp][1]),0.0)

    json.dump({'meta':{'extra_pivots':extra_pivots},
               'pivots':{k:[float(v[0]),float(v[1]),float(v[2])] for k,v in pivots.items()}},
              open('skeleton.json','w'))
    print("  skeleton: pivots for",len(pivots),"bones +",len(extra_pivots),"extra")
