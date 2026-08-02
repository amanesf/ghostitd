# -*- coding: utf-8 -*-
"""
================================================================================
 skeleton.json → モーション単体.glb(1モーション=1ファイル)を書き出す独立CLI
================================================================================
 使い方:
   python bake_motion.py <作業フォルダ(skeleton.json必須)> [モーション名,...]
   例) python bake_motion.py ./work                → idle/wave/moshimoshi/dance/idol/run 全種
       python bake_motion.py ./work idle,wave       → 指定したものだけ

 出力: <作業フォルダ>/motion_<name>.glb (name = idle/wave/moshimoshi/dance/idol/run)
   各ファイルはボーン階層(名前+bind位置。pipeline_lib/model_export.pyのmodel.glbと
   同じBONES/pivot)と、そのモーション1つぶんのanimationのみを持つ。メッシュ/スキン/
   テクスチャは含まない(3Dビューア側でmodel.glbのスケルトンにボーン名で紐付けて適用
   する想定。three.jsのAnimationMixerはトラックをノード名で解決するため、同じボーン名
   を使っている限り別ファイルのクリップでもそのまま適用できる)。

 ★ pipeline.pyの実行ステージには含まれない(2026-07-02〜、model/motion分割出力)。
   skeleton.jsonさえあれば、visual_hull/atlas_bake等の重いメッシュ生成をやり直さず
   モーションの調整・再生成だけができるように独立させてある。
   モーションのロジック本体(各アニメーション関数)は pipeline_lib/motion.py 参照。

 依存: numpy, pygltflib
================================================================================
"""
import sys
import os
import numpy as np
from pygltflib import (GLTF2, Scene, Node, Accessor, BufferView, Buffer,
                        Animation, AnimationSampler, AnimationChannel, AnimationChannelTarget)

from pipeline_lib import motion
from pipeline_lib.skeleton import BONES, BHIER, load_pivots
from pipeline_lib.common import GLTF_FLOAT as FLOAT


def _bake_one(aname, T, NF, PIVc, out_path):
    blob=bytearray();views=[];accs=[]
    def add_view(data):
        while len(blob)%4!=0: blob.extend(b'\x00')
        off=len(blob);blob.extend(data)
        views.append(dict(byteOffset=off,byteLength=len(data)));return len(views)-1
    def add_acc(view,count,atype,mn=None,mx=None):
        a=dict(bufferView=view,componentType=FLOAT,count=count,type=atype)
        if mn is not None:a['min']=mn
        if mx is not None:a['max']=mx
        accs.append(a);return len(accs)-1

    # ---------- nodes(model.glbと同じボーン階層。rotationはbindの土台なので単位回転) ----------
    nodes=[];name2node={}
    for b in BONES:
        par=BHIER[b];off=PIVc[b]-(PIVc[par] if par else np.zeros(3))
        nodes.append(Node(name=b,translation=off.tolist()));name2node[b]=len(nodes)-1
    for b in BONES:
        par=BHIER[b]
        if par is not None:
            nd=nodes[name2node[par]]
            if nd.children is None:nd.children=[]
            nd.children.append(name2node[b])

    # ---------- animation ----------
    times=np.linspace(0,T,NF).astype(np.float32)
    v_t=add_view(times.tobytes());a_t=add_acc(v_t,NF,"SCALAR",[float(times.min())],[float(times.max())])
    samplers=[];channels=[]
    for bn in motion.ANIMATED_BONES:
        quats=np.array([motion.quat_from_R(motion.anim_local(bn,aname,tm,T)) for tm in times],np.float32)
        v_q=add_view(quats.tobytes());a_q=add_acc(v_q,NF,"VEC4")
        si=len(samplers);samplers.append(AnimationSampler(input=a_t,output=a_q,interpolation="LINEAR"))
        channels.append(AnimationChannel(sampler=si,target=AnimationChannelTarget(node=name2node[bn],path='rotation')))
    # hips translation(ステップ/ジャンプ)。値が返るanim(dance/idol/run)のみ追加。
    htr=[motion.hips_translation(aname,tm) for tm in times]
    if any(h is not None for h in htr):
        base_off=PIVc['hips']
        arr=np.array([(np.array(h)+base_off) if h is not None else base_off for h in htr],np.float32)
        v_tr=add_view(arr.tobytes());a_tr=add_acc(v_tr,NF,"VEC3")
        si=len(samplers);samplers.append(AnimationSampler(input=a_t,output=a_tr,interpolation="LINEAR"))
        channels.append(AnimationChannel(sampler=si,target=AnimationChannelTarget(node=name2node['hips'],path='translation')))

    gltf=GLTF2()
    gltf.nodes=nodes
    gltf.scenes=[Scene(nodes=[name2node['hips']])]
    gltf.scene=0
    gltf.animations=[Animation(name=aname,samplers=samplers,channels=channels)]
    gltf.bufferViews=[BufferView(buffer=0,byteOffset=v['byteOffset'],byteLength=v['byteLength']) for v in views]
    gltf.accessors=[Accessor(**a) for a in accs]
    gltf.buffers=[Buffer(byteLength=len(blob))]
    gltf.set_binary_blob(bytes(blob))
    gltf.save_binary(out_path)
    print("  ",out_path,os.path.getsize(out_path)//1024,"KB |",len(channels),"channels |",NF,"frames")


def run(work_dir=".", anims=None):
    os.chdir(work_dir)
    piv = load_pivots()
    PIVc = {n:(piv[n]-np.array([0,0.5,0])) for n in piv}  # model_export.pyと同じ中心シフト
    lut = {a:(T,NF) for a,T,NF in motion.ANIMS_ALL}
    names = anims if anims else list(lut.keys())
    for aname in names:
        if aname not in lut:
            print(f"  [!] unknown motion '{aname}' (choices: {','.join(lut.keys())}), skip")
            continue
        T,NF = lut[aname]
        _bake_one(aname, T, NF, PIVc, f"motion_{aname}.glb")


if __name__=="__main__":
    args = sys.argv[1:]
    wd = args[0] if len(args)>0 else "."
    anims = args[1].split(",") if len(args)>1 else None
    run(wd, anims)
