# -*- coding: utf-8 -*-
"""モーションデータ・ロジック(スケルトン/メッシュ/glTF組み立てとは独立した区画)。

★ 回転規約について(読む前に必ず): `Ez(rx,ry,rz)` は `Rx(rx) @ Ry(ry) @ Rz(rz)` の
ボーンローカル回転行列を返す(X軸→Y軸→Z軸の順に回転を合成)。GLOBALには「rxは
前後方向、ryは左右/内外方向、rzは上下方向」のような一般則があるわけではなく、
**各アニメーション関数ごとに、実際にレンダリングして目視確認しながら軸の意味を
決めた**(コード中の「★実測規約」「★真の修正」等のコメントがその痕跡)。
そのため同じ「肘を曲げる」動きでも、moshimoshi/idol/danceではrz、runではrxを
使っている、というように**関数をまたいで軸の意味が一致しない**。これが
「曲がる方向が分からない」の正体で、今回のモジュール分割ではこの不一致自体は
直していない(値を変えずに安全にできる範囲外だったため)。各関数の直前に、
判明している範囲でその関数内での軸の意味をコメントしてある。

idle/waveは各ボーンの振幅・位相を関数内で直接返す小さな式なのでそのまま。
moshimoshi/dance/idol/runは秒数で区切られた振付(タイムライン)そのものが本質的な
データなので、無理に別テーブルへ切り出さず「1アニメ=1関数」の対応を保つ形で分離した。
"""
import numpy as np


def Ez(rx,ry,rz):
    cx,sx=np.cos(rx),np.sin(rx);cy,sy=np.cos(ry),np.sin(ry);cz,sz=np.cos(rz),np.sin(rz)
    Rx=np.array([[1,0,0],[0,cx,-sx],[0,sx,cx]]);Ry=np.array([[cy,0,sy],[0,1,0],[-sy,0,cy]]);Rz=np.array([[cz,-sz,0],[sz,cz,0],[0,0,1]])
    return Rx@Ry@Rz

def quat_from_R(R):
    m=R;tr=m[0,0]+m[1,1]+m[2,2]
    if tr>0:
        s=np.sqrt(tr+1)*2;w=0.25*s;x=(m[2,1]-m[1,2])/s;y=(m[0,2]-m[2,0])/s;z=(m[1,0]-m[0,1])/s
    elif m[0,0]>m[1,1] and m[0,0]>m[2,2]:
        s=np.sqrt(1+m[0,0]-m[1,1]-m[2,2])*2;w=(m[2,1]-m[1,2])/s;x=0.25*s;y=(m[0,1]+m[1,0])/s;z=(m[0,2]+m[2,0])/s
    elif m[1,1]>m[2,2]:
        s=np.sqrt(1+m[1,1]-m[0,0]-m[2,2])*2;w=(m[0,2]-m[2,0])/s;x=(m[0,1]+m[1,0])/s;y=0.25*s;z=(m[1,2]+m[2,1])/s
    else:
        s=np.sqrt(1+m[2,2]-m[0,0]-m[1,1])*2;w=(m[1,0]-m[0,1])/s;x=(m[0,2]+m[2,0])/s;y=(m[1,2]+m[2,1])/s;z=0.25*s
    return np.array([x,y,z,w],np.float32)

# アニメーションの基準姿勢(下げ手)。以前はgltf_export.stage_skin_glbがNO_MOTIONフラグに
# 応じて{}(T-pose)かこの辞書かを実行時に切り替えていたが、モデル出力(model_export.py)は
# 常にモーションを含まなくなったため(2026-07-02〜、model/motion分割出力)、この基準姿勢は
# モーション側だけが使う定数になった。anim_local等のidle/waveがbase_local(n)経由で参照する。
POSE={'upperarm_R':Ez(0.10,0,-1.35),'forearm_R':Ez(0,0.05,-0.16),
      'upperarm_L':Ez(0.10,0,1.35),'forearm_L':Ez(0,-0.05,0.16),'torso':Ez(0.02,0,0)}
ANIMATED_BONES=['hips','torso','neck','head','upperarm_L','forearm_L','upperarm_R','forearm_R',
                'thigh_L','shin_L','thigh_R','shin_R']
ANIMS_ALL=[('idle',6.0,13),('wave',4.0,21),('moshimoshi',15.0,150),('dance',15.0,150),('idol',15.0,150),('run',1.7,40)]

def base_local(n):
    return POSE.get(n,np.eye(3))

def anim_local(n,anim,tm,T):
    # idle/wave/moshimoshiの3種を扱う。moshimoshi以外の秒数分岐系(idol/dance/run)は
    # 個別関数(idol_local/dance_local/run_local)に委譲する。
    # ★軸規約(idle): upperarm rx=前後振り, rz=上下(sin波の小さな揺れ)。腕はbase_local
    #   (下げ手の基準姿勢)に対する相対回転(Rb@Ez(...))で、他は絶対回転。
    # ★軸規約(wave): upperarm uz(rz)が-1.35(下ろし)→0付近(横)に上がる。forearm rzで
    #   手首をひらひらさせる(sin波の重畳)。左腕はbase_local固定(動かさない)。
    ph=2*np.pi*(tm/T);Rb=base_local(n)
    if anim=='idle':
        if n=='torso':return Ez(0.02+0.02*np.sin(2*ph),0,0.03*np.sin(ph))
        if n=='hips':return Ez(0.02*np.sin(2*ph),0,0.03*np.sin(ph))
        if n=='head':return Ez(0.03*np.sin(2*ph)-0.01,0.10*np.sin(ph*0.5),0.04*np.sin(ph+0.6))
        if n=='neck':return Ez(0,0,0.02*np.sin(ph))
        if n=='upperarm_R':return Rb@Ez(0.03*np.sin(ph),0,0.04*np.sin(ph+0.3))
        if n=='upperarm_L':return Rb@Ez(0.03*np.sin(ph),0,-0.04*np.sin(ph+0.3))
        if n=='forearm_R':return Rb@Ez(0,0,0.04*np.sin(ph+1.0))
        if n=='forearm_L':return Rb@Ez(0,0,-0.04*np.sin(ph+1.0))
        return Rb
    elif anim=='wave': # wave (right hand)
        g=np.exp(-((tm-T*0.5)/(T*0.22))**2)
        if n=='upperarm_R':return Ez(0.10+0.25*g,0,-1.35+1.15*g)
        if n=='forearm_R':return Ez(0,0.05,-0.16+g*(0.35+0.5*np.sin(tm*12)))
        if n=='head':return Ez(-0.02,0.12*g,0.04)
        if n=='torso':return Ez(0.02,0.05*g,0.0)
        if n=='upperarm_L':return base_local('upperarm_L')
        if n=='forearm_L':return base_local('forearm_L')
        return base_local(n)
    else: # moshimoshi (15s, kawaii TikTok dance)
        # キーフレーム補間ヘルパ: [(t,val),...] から線形補間でvalを得る
        def kf(keys):
            if tm<=keys[0][0]: return keys[0][1]
            if tm>=keys[-1][0]: return keys[-1][1]
            for i in range(len(keys)-1):
                t0,v0=keys[i]; t1,v1=keys[i+1]
                if t0<=tm<=t1:
                    a=(tm-t0)/max(t1-t0,1e-6); a=a*a*(3-2*a)  # smoothstep
                    return v0+(v1-v0)*a
            return keys[-1][1]
        if anim=='idol':
            return idol_local(n,tm)
        if anim=='dance':
            return dance_local(n,tm,kf)
        if anim=='run':
            return run_local(n,tm)
        # 首かしげ(右左右左): 1.0-3.5s
        head_tilt=0.0
        if 1.0<=tm<3.5:
            head_tilt=0.22*np.sin((tm-1.0)/0.6*np.pi)  # 約4回往復
        # ツンツン中は手と逆に首を傾ける: 6.0-8.4s
        if 6.0<=tm<8.4:
            head_tilt=-0.20*np.sin((tm-6.0)/0.8*np.pi)
        # 全体の軽い縦ノリ(ビート)
        bob=0.02*np.sin(2*np.pi*tm/0.5)
        if n=='hips':  return Ez(0,0,0)
        if n=='torso': return Ez(0.02+bob,0,0.02*np.sin(2*np.pi*tm/1.0))
        if n=='neck':  return Ez(0,0,head_tilt*0.4)
        if n=='head':  return Ez(0.02,head_tilt*0.5,head_tilt)
        # --- 腕 ---
        # 区間別の腕ポーズを決める。upperarmのz: 負=下、0付近=横、正=上げ。
        # x回転で前後(正=前方),  forearmのzで肘曲げ。L/Rで符号が反転する点に注意。
        # 受話器(右手を右耳へ): 1.0-3.5s / 準備0-1.0
        def arm(side):
            sgn = 1.0 if side=='L' else -1.0   # Lはz正で下、Rはz負で下
            # デフォルト(下ろし)
            uz=sgn*1.35; ux=0.10; fz=sgn*0.16; fx=0.0; uy=0.0
            if tm<1.0:
                # 準備: 胸の前で軽く握る(両手を前へ)
                a=kf([(0,0),(1.0,1)])
                ux=0.10+a*0.9; uz=sgn*(1.35-a*0.55); fz=sgn*(0.16+a*1.4)
            elif tm<3.5:
                # 受話器: 右手を右耳へ(上腕を立てて肘を深く曲げ手を頭側面へ)
                if side=='R':
                    ux=0.15; uz=-0.35; fz=-2.3; uy=-0.1
                else:
                    ux=0.9; uz=0.75; fz=1.5
            elif tm<5.0:
                # 電波ひらひら(両手を頭上へ、手首をひらひら=forearm小刻み)
                fl=0.5*np.sin(2*np.pi*(tm-3.5)/0.32)  # 素早い往復
                ux=0.2; uz=sgn*0.12; fz=sgn*0.3+fl
            elif tm<5.5:
                # パッと開く(両手を外側へ大きく)
                ux=0.1; uz=sgn*0.5; fz=sgn*0.1
            elif tm<6.0:
                # 胸の高さへストンと下ろす
                a=kf([(5.5,0),(6.0,1)])
                ux=0.1+a*0.8; uz=sgn*(0.5-a*0.05); fz=sgn*(0.1+a*1.3)
            elif tm<8.4:
                # 宇宙ツンツン(人差し指を斜め上45度へ右左右左交互)
                phase=(tm-6.0)/0.8
                up_R = (int(phase)%2==0)
                active = (side=='R' and up_R) or (side=='L' and not up_R)
                if active:
                    ux=0.5; uz=sgn*0.1; fz=sgn*0.05; uy=sgn*0.15  # 斜め上に突き出す
                else:
                    ux=0.9; uz=sgn*0.6; fz=sgn*1.4  # 胸前で待機
            elif tm<9.5:
                # 両頬に指(上腕を下げ肘を深く曲げ、手を顔の高さへ)
                ux=0.1; uz=sgn*0.7; fz=sgn*2.4; uy=sgn*0.05
            elif tm<13.0:
                # けんぱクロス: グー(胸前クロス)とパー(胸横に開く)を交互
                seq=[(9.5,'cross'),(10.2,'open'),(11.0,'cross'),(11.8,'open'),(12.5,'open')]
                st='cross'
                for t0,s in seq:
                    if tm>=t0: st=s
                if st=='cross':
                    ux=0.8; uz=sgn*0.95; fz=sgn*1.9; uy=sgn*-0.5  # 胸前でクロス
                else:
                    ux=0.4; uz=sgn*0.5; fz=sgn*0.7  # 胸横に開く
            else:
                # アウトロ: にっこり、両手を軽く上げてバイバイ気味
                a=kf([(13.0,0),(14.0,1),(15.0,1)])
                ux=0.3+a*0.2; uz=sgn*(0.85-a*0.3); fz=sgn*0.5
            return Ez(ux,uy,uz),Ez(0,0,fz)
        if n=='upperarm_R': return arm('R')[0]
        if n=='forearm_R':  return arm('R')[1]
        if n=='upperarm_L': return arm('L')[0]
        if n=='forearm_L':  return arm('L')[1]
        return base_local(n)

def idol_local(n,tm):
    # 破綻しにくい対称アイドルダンス(15s=5セクション×3s, ループ前提)。
    # 全セクション腕を体の外側/上で対称に動かし、体前のクロス・顔接触を避ける。
    # ★軸規約(idol、moshimoshiと同じ): upperarm rz(下ろし±1.35→0で横水平→さらに
    #   進めて上げ), ry(前後), forearm rz(R負/L正で内側に肘曲げ)。両腕はsgnで左右対称。
    beat=60/130; sec=tm%15.0
    bob=0.05*np.sin(2*np.pi*tm/beat)        # 縦ノリ
    sway=0.06*np.sin(2*np.pi*tm/(beat*2))    # 横ゆれ
    # 体幹
    if n=='hips':  return Ez(0,0,sway)
    if n=='torso': return Ez(0.03+bob*0.2,0,sway*0.5)
    if n=='neck':  return Ez(0,0,sway*0.6)
    if n=='head':  return Ez(0.02+bob*0.3,sway*1.5,sway*0.8)
    def arm(side):
        # 実測規約: rz=0で真下、横T字=sgn*1.35、万歳=sgn*1.9 (R:+/L:-)
        sgn=1.0 if side=='R' else -1.0
        uz=0.0; uy=0.0; fz=0.0   # デフォルト真下
        if sec<3.0:
            # S1: 横ゆれ。腕は体側で軽く前後(肘曲げ)
            sw=np.sin(2*np.pi*sec/(beat*2))
            uz=sgn*0.25; uy=0.4+0.2*sw; fz=sgn*0.7
        elif sec<6.0:
            # S2: バンザイ開閉(横T字↔万歳、対称)
            a=0.5+0.5*np.sin(2*np.pi*(sec-3.0)/(beat*2))  # 0(横)..1(上)
            uz=sgn*(1.35+a*0.55); uy=0.1; fz=sgn*0.1
        elif sec<9.0:
            # S3: 頭上で手拍子風(万歳付近で小さく開閉)
            c=0.5+0.5*np.sin(2*np.pi*(sec-6.0)/beat)
            uz=sgn*(1.7+0.15*c); uy=0.15; fz=sgn*(0.2+0.4*c)
        elif sec<12.0:
            # S4: 左右ウェーブ(横T字を上下にゆらす)
            w=np.sin(2*np.pi*(sec-9.0)/(beat*2))
            uz=sgn*(1.35+0.4*w); uy=0.1; fz=sgn*0.15
        else:
            # S5: キメ(横T字キメ→万歳キメ)
            if sec<13.5: uz=sgn*1.35; uy=0.1; fz=sgn*0.1
            else:        uz=sgn*1.9;  uy=0.15; fz=sgn*0.1
        return Ez(0,uy,uz),Ez(0,0,fz)
    if n=='upperarm_R': return arm('R')[0]
    if n=='forearm_R':  return arm('R')[1]
    if n=='upperarm_L': return arm('L')[0]
    if n=='forearm_L':  return arm('L')[1]
    def leg(side):
        sgn=1.0 if side=='L' else -1.0
        tz=sgn*0.06; kx=0.12+0.10*abs(np.sin(2*np.pi*tm/beat))  # 肩幅+屈伸
        if 6.0<=sec<9.0:
            # S3 ジャンプ気味に軽く開閉
            tz=sgn*(0.06+0.12*abs(np.sin(2*np.pi*(sec-6.0)/beat)))
        elif 12.0<=sec:
            tz=sgn*0.12  # キメで少し広く
        return Ez(0,0,tz),Ez(kx,0,0)
    if n=='thigh_R': return leg('R')[0]
    if n=='shin_R':  return leg('R')[1]
    if n=='thigh_L': return leg('L')[0]
    if n=='shin_L':  return leg('L')[1]
    return base_local(n)

def run_local(n,tm):
    # 走り(ループ)。★軸規約(run、idol/danceとは異なる): upperarmはsgn*(-1.35)が
    #   「真下(下ろし)」基準(sgn=R:+1/L:-1 → R:-1.35, L:+1.35)。0は水平(T字)。
    #   前後振りはrx(左右共通,負で前)。肘曲げはforearmのfx(rx)——idol/dance/
    #   moshimoshiではrz(uz/fz)が肘曲げだったのに対し、ここはrxが肘曲げにあたる。
    #   脚の前後=thigh tx(負で前/正で後), 膝=shin kx。対角同期。
    cyc=0.85  # ★スピード感UP: 1.2→0.85(速いダッシュ)
    ph=2*np.pi*(tm%cyc)/cyc
    s=np.sin(ph)
    # 体幹: 前傾を強化+上下動
    if n=='hips':  return Ez(0,0.05*s,0)             # 捻りを縮小(0.10→0.05)
    if n=='torso': return Ez(0.22,-0.03*s,0)         # 前傾を抑える(0.32→0.22)、捻りも縮小
    if n=='neck':  return Ez(-0.12,0,0)              # 前傾分を首で戻す(0.18→0.12)
    if n=='head':  return Ez(-0.06,0.05*s,0)
    def arm(side):
        sgn=1.0 if side=='R' else -1.0
        swing = s if side=='R' else -s
        # ★真の修正: 下ろした腕(uz=sgn*-1.35)を前後に振るのは rx(左右共通,負で前)。
        #   ry はほぼ効かない(誤りの原因だった)。rxで前後、uzは下ろし基準で固定。
        uz = sgn*(-1.35+0.1745)  # ★肩をY方向に10度広げる(90度下げ→80度下げ。0.1745rad=10度)
        ux = -0.6*swing  # ★左右対称式に修正。swing側で既に左右交互になる為、符号を左右共通に(即時対応)
        uy = 0.0
        fx = -1.3  # ★両腕共通(rxは左右非対称ではない)
        fy = -sgn*0.15  # ★肘の左右方向(ry)。内向きだったのを少し外向きへ反転(即時対応・小さめの値)
        fz = -sgn*1.1  # ★R=-1.1/L=+1.1(ユーザー指定)
        return Ez(ux,uy,uz),Ez(fx,fy,fz)
    if n=='upperarm_R': return arm('R')[0]
    if n=='forearm_R':  return arm('R')[1]
    if n=='upperarm_L': return arm('L')[0]
    if n=='forearm_L':  return arm('L')[1]
    def leg(side):
        swing = -s if side=='R' else s
        sgn=1.0 if side=='L' else -1.0
        tx = -0.95*swing
        tz = sgn*0.05
        kx = 0.3 + 1.25*max(swing,0) + 0.5*max(-swing,0)
        return Ez(tx,0,tz),Ez(kx,0,0)
    if n=='thigh_R': return leg('R')[0]
    if n=='shin_R':  return leg('R')[1]
    if n=='thigh_L': return leg('L')[0]
    if n=='shin_L':  return leg('L')[1]
    if n in ('foot_R','foot_L'):
        return Ez(0.2,0,0)
    return base_local(n)

def run_translation(tm):
    # 走りの上下動(重心の上下)。1サイクルで2回バウンド(各歩で1回)。
    cyc=0.85
    ph=2*np.pi*(tm%cyc)/cyc
    y=0.045*abs(np.sin(ph))
    return [0.0,float(y),0.0]

def idol_translation(tm):
    # 縦ノリの上下とS3の小ジャンプ
    beat=60/130; sec=tm%15.0; y=0.0
    y=0.02*abs(np.sin(2*np.pi*tm/beat))  # 常時の軽い縦ノリ
    if 6.0<=sec<9.0:
        for k in range(6):
            t0=6.0+k*beat
            if 0<=tm%15.0-t0<beat*0.5:
                y+=0.05*np.sin((tm%15.0-t0)/(beat*0.5)*np.pi)
    return [0.0,float(y),0.0]

def dance_local(n,tm,kf):
    # 全身ダンス(15s,135BPM=拍0.444s)。★軸規約(dance、moshimoshi/idolと同じ系統):
    #  upperarm rz: 下ろし=±1.35(R負/L正)、0で横水平に上がる(上げ下げ)
    #  upperarm ry: 腕を上げた後の前後(正=前/奥)
    #  forearm rz : 肘曲げ(R負/L正で手が内側=前に来る)
    #  thigh tx   : 脚の前後(負=前, 正=後ろ)  thigh tz: 開閉(正=外/右)
    beat=60/135
    bob=0.04*np.sin(2*np.pi*tm/beat)
    head_tilt=0.0; hip_shift=0.0
    if 1.0<=tm<3.5:
        s=np.sin((tm-1.0)/beat*np.pi)
        head_tilt=0.35*s; hip_shift=-0.30*s
    if 6.0<=tm<8.9:
        s=np.sin((tm-6.0)/(beat*1.2)*np.pi)
        head_tilt=-0.30*s
    if n=='hips':  return Ez(0,0,hip_shift*0.5)
    if n=='torso': return Ez(0.03+bob*0.3,0,hip_shift*0.3+0.03*np.sin(2*np.pi*tm/beat))
    if n=='neck':  return Ez(0,0,head_tilt*0.4)
    if n=='head':  return Ez(0.02,head_tilt*0.5,head_tilt)
    def arm(side):
        sgn=1.0 if side=='L' else -1.0
        uz=sgn*1.35; ux=0.0; uy=0.0; fz=sgn*0.16
        if tm<1.0:
            a=kf([(0,0),(1.0,1)])
            uz=sgn*(1.35-a*0.45); uy=a*0.5; fz=sgn*(0.16+a*1.5)
        elif tm<3.5:
            if side=='R': uz=-0.5; uy=0.3; fz=-2.2
            else: uz=0.85; uy=0.4; fz=1.4
        elif tm<4.8:
            fl=0.6*np.sin(2*np.pi*(tm-3.5)/(beat*0.5))
            uz=sgn*0.12; uy=0.2; fz=sgn*0.3+fl
        elif tm<5.5:
            uz=sgn*0.05; uy=0.0; fz=sgn*0.05
        elif tm<6.0:
            a=kf([(5.5,0),(6.0,1)])
            uz=sgn*(0.05+a*1.3); fz=sgn*(0.05+a*0.1)
        elif tm<8.9:
            phase=(tm-6.0)/(beat*1.2)
            step_R=(int(phase)%2==0)
            active=(side=='R' and step_R) or (side=='L' and not step_R)
            if active: uz=sgn*0.35; uy=0.3; fz=sgn*0.1
            else: uz=sgn*1.2; uy=0.1; fz=sgn*0.3
        elif tm<9.5:
            uz=sgn*0.7; uy=0.2; fz=sgn*2.4
        elif tm<13.0:
            seq=[(9.5,'ken'),(10.2,'pa'),(11.0,'ken'),(11.8,'pa'),(12.5,'pa')]
            st='ken'
            for t0,s in seq:
                if tm>=t0: st=s
            if st=='ken': uz=sgn*0.9; uy=0.3; fz=sgn*2.0
            else: uz=sgn*0.05; uy=0.0; fz=sgn*0.05
        else:
            if side=='R': uz=-0.3; uy=0.4; fz=-0.5
            else: uz=1.0; uy=0.1; fz=1.2
        return Ez(ux,uy,uz),Ez(0,0,fz)
    if n=='upperarm_R': return arm('R')[0]
    if n=='forearm_R':  return arm('R')[1]
    if n=='upperarm_L': return arm('L')[0]
    if n=='forearm_L':  return arm('L')[1]
    def leg(side):
        sgn=1.0 if side=='L' else -1.0
        tx=0.0; tz=0.0; kx=0.1+0.08*abs(np.sin(2*np.pi*tm/beat))
        if tm<5.0: tz=sgn*0.05
        elif tm<6.0:
            if side=='R':
                a=kf([(5.0,0),(5.3,1)]); tx=-0.5*a; tz=-0.1*a
        elif tm<8.9:
            phase=(tm-6.0)/(beat*1.2)
            step_R=(int(phase)%2==0)
            wide=(side=='R' and step_R) or (side=='L' and not step_R)
            tz=sgn*(0.4 if wide else 0.05)
        elif tm<9.5: tz=sgn*0.05
        elif tm<13.0:
            seq=[(9.5,'ken'),(10.2,'pa'),(11.0,'ken'),(11.8,'pa'),(12.5,'pa')]
            st='ken'
            for t0,s in seq:
                if tm>=t0: st=s
            tz=sgn*(0.02 if st=='ken' else 0.45)
        else:
            if side=='L': kx=0.5; tz=0.1
            else: tz=-0.05
        return Ez(tx,0,tz),Ez(kx,0,0)
    if n=='thigh_R': return leg('R')[0]
    if n=='shin_R':  return leg('R')[1]
    if n=='thigh_L': return leg('L')[0]
    if n=='shin_L':  return leg('L')[1]
    return base_local(n)

def hips_translation(anim,tm):
    # hipsの平行移動(ステップ/ジャンプ/縦ノリ)。
    if anim=='idol': return idol_translation(tm)
    if anim=='run': return run_translation(tm)
    if anim!='dance': return None
    beat=60/135; x=0.0; y=0.0
    if 5.0<=tm<6.0:  x=0.10  # 右前ステップで右へ
    elif 6.0<=tm<8.9:
        phase=(tm-6.0)/(beat*1.2)
        x=0.18 if (int(phase)%2==0) else -0.18  # 横ステップ左右
    elif 9.5<=tm<13.0:
        # けんぱジャンプの上下
        seq=[(9.5,'ken'),(10.2,'pa'),(11.0,'ken'),(11.8,'pa'),(12.5,'pa')]
        st='ken'
        for t0,s in seq:
            if tm>=t0: st=s
        # ジャンプの瞬間に少し浮く
        for t0 in [9.5,10.2,11.0,11.8]:
            if 0<=tm-t0<0.18: y=0.06*np.sin((tm-t0)/0.18*np.pi)
    elif tm>=13.0:
        y=-0.05  # 重心を落とす
    return [float(x),float(y),0.0]
