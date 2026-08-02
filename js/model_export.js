// -*- coding: utf-8 -*-
// pipeline_lib/model_export.py の stage_model_glb() のJS移植。
// pygltflibの代わりにglTF2.0のJSON+BINチャンクを直接組み立ててGLBバイナリを作る。
(function(global){
"use strict";
var P3D = global.P3D = global.P3D || {};

var GLTF_FLOAT=5126, GLTF_USHORT=5123, GLTF_UINT=5125;
var GLTF_ARRAY_BUFFER=34962, GLTF_ELEMENT_ARRAY_BUFFER=34963;
var GLTF_LINEAR=9729, GLTF_REPEAT=33071;

function align4(n){ return (n+3) & ~3; }

/**
 * atlasCanvas: HTMLCanvasElement(front+back+side並びのアトラス、RGB)
 * kbPerFace: 1面あたりの目標容量上限(KB)、faces=3固定(front/back/side)
 * 戻り値: Promise<{buffer:ArrayBuffer, mime:string}>
 * canvas.toBlob(quality)の2分探索でJPEG品質を決める(Python版の
 * _compress_atlasと同じ考え方)。
 */
function compressAtlas(atlasCanvas, kbPerFace){
  var faces=3;
  var targetBytes = kbPerFace*faces*1024;
  function tryQuality(q){
    return new Promise(function(resolve){
      atlasCanvas.toBlob(function(blob){ resolve(blob); }, 'image/jpeg', q/100);
    });
  }
  return (async function(){
    var lo=30, hi=95, best=null, bestQ=lo;
    while(lo<=hi){
      var mid=(lo+hi)>>1;
      var blob=await tryQuality(mid);
      if(blob.size<=targetBytes){ best=blob; bestQ=mid; lo=mid+1; }
      else{ hi=mid-1; }
    }
    if(!best){ best=await tryQuality(lo); bestQ=lo; }
    var buf=await best.arrayBuffer();
    console.log("  model_export: atlas texture compressed to", Math.floor(buf.byteLength/1024),
      "KB (quality="+bestQ+", 目標"+kbPerFace+"KB/face)");
    return {buffer:buf, mime:'image/jpeg'};
  })();
}
P3D.compressAtlas = compressAtlas;

/**
 * opts: {
 *   V: Float32Array(N*3) restV(頂点位置。中心化はcharacter_3d.html側で行う前提だが、
 *      Python版と同様[0,0.5,0]だけ引いて大まかに合わせる)
 *   N: Float32Array(N*3) 法線
 *   UV: Float32Array(N*2)
 *   J: Uint16Array(N*4) スキニングjoint index
 *   W: Float32Array(N*4) スキニングweight
 *   F: Uint32Array(M*3) 三角形index
 *   pivots: {boneName:[x,y,z]} (BONES全ボーン分)
 *   atlasTexBuffer: ArrayBuffer (JPEG済みバイト列, compressAtlasの結果)
 *   atlasMime: string
 * }
 * 戻り値: ArrayBuffer (GLBファイル全体)
 */
function buildGLB(opts){
  var BONES=P3D.BONES, BHIER=P3D.BHIER;
  var restV=Float32Array.from(opts.V);
  // ★[0,0.5,0]だけ引く大まかな初期位置合わせ(Python版と同じ、正式な中央化は
  // ビューア側でバインドポーズ実測バウンディングボックスから行う)
  for(var i=0;i<restV.length/3;i++){ restV[i*3+1]-=0.5; }
  var norm=opts.N, uv=opts.UV, J=opts.J, Wt=opts.W, Fall=opts.F;

  var pivots=opts.pivots;
  var PIVc={};
  BONES.forEach(function(b){
    var p=pivots[b];
    PIVc[b]=[p[0], p[1]-0.5, p[2]];
  });

  var bufferParts=[]; var blobLen=0;
  function addView(dataBuf, target){
    while(blobLen%4!==0){ bufferParts.push(new Uint8Array([0])); blobLen+=1; }
    var off=blobLen;
    var u8 = new Uint8Array(dataBuf);
    bufferParts.push(u8); blobLen+=u8.byteLength;
    return {byteOffset:off, byteLength:u8.byteLength, target:target};
  }
  var views=[], accessors=[];
  function pushView(v){ views.push(v); return views.length-1; }
  function pushAcc(a){ accessors.push(a); return accessors.length-1; }

  function minmax3(arr){
    var n=arr.length/3;
    var mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity];
    for(var i=0;i<n;i++){
      for(var k=0;k<3;k++){
        var v=arr[i*3+k];
        if(v<mn[k])mn[k]=v; if(v>mx[k])mx[k]=v;
      }
    }
    return {min:mn,max:mx};
  }

  var vPos=pushView(addView(restV.buffer, GLTF_ARRAY_BUFFER));
  var mm=minmax3(restV);
  var aPos=pushAcc({bufferView:vPos, componentType:GLTF_FLOAT, count:restV.length/3, type:"VEC3", min:mm.min, max:mm.max});
  var vNor=pushView(addView(norm.buffer, GLTF_ARRAY_BUFFER));
  var aNor=pushAcc({bufferView:vNor, componentType:GLTF_FLOAT, count:norm.length/3, type:"VEC3"});
  var vUv=pushView(addView(uv.buffer, GLTF_ARRAY_BUFFER));
  var aUv=pushAcc({bufferView:vUv, componentType:GLTF_FLOAT, count:uv.length/2, type:"VEC2"});
  var vJ=pushView(addView(J.buffer, GLTF_ARRAY_BUFFER));
  var aJ=pushAcc({bufferView:vJ, componentType:GLTF_USHORT, count:J.length/4, type:"VEC4"});
  var vW=pushView(addView(Wt.buffer, GLTF_ARRAY_BUFFER));
  var aW=pushAcc({bufferView:vW, componentType:GLTF_FLOAT, count:Wt.length/4, type:"VEC4"});
  var vIdx=pushView(addView(Fall.buffer, GLTF_ELEMENT_ARRAY_BUFFER));
  var aIdx=pushAcc({bufferView:vIdx, componentType:GLTF_UINT, count:Fall.length, type:"SCALAR"});

  // inverse bind matrices: translate(-pivot)、column-major 4x4をBONES順に連結
  var ibmArr=new Float32Array(BONES.length*16);
  BONES.forEach(function(b,bi){
    var p=PIVc[b];
    // column-major: [1,0,0,0, 0,1,0,0, 0,0,1,0, -px,-py,-pz,1]
    var m=[1,0,0,0, 0,1,0,0, 0,0,1,0, -p[0],-p[1],-p[2],1];
    for(var k=0;k<16;k++) ibmArr[bi*16+k]=m[k];
  });
  var vIbm=pushView(addView(ibmArr.buffer));
  var aIbm=pushAcc({bufferView:vIbm, componentType:GLTF_FLOAT, count:BONES.length, type:"MAT4"});

  // ---- nodes ----
  var nodes=[], name2node={};
  BONES.forEach(function(b){
    var par=BHIER[b];
    var off = par ? [PIVc[b][0]-PIVc[par][0], PIVc[b][1]-PIVc[par][1], PIVc[b][2]-PIVc[par][2]] : PIVc[b].slice();
    nodes.push({name:b, translation:off});
    name2node[b]=nodes.length-1;
  });
  BONES.forEach(function(b){
    var par=BHIER[b];
    if(par!==null){
      var nd=nodes[name2node[par]];
      if(!nd.children) nd.children=[];
      nd.children.push(name2node[b]);
    }
  });
  var meshNode={name:"character", skin:0, mesh:0};
  nodes.push(meshNode);
  var meshNodeIdx=nodes.length-1;

  // ---- texture/material ----
  var vPng=pushView(addView(opts.atlasTexBuffer));
  var images=[{bufferView:vPng, mimeType:opts.atlasMime}];
  var samplers=[{magFilter:GLTF_LINEAR, minFilter:GLTF_LINEAR, wrapS:GLTF_REPEAT, wrapT:GLTF_REPEAT}];
  var textures=[{source:0, sampler:0}];
  var materials=[{
    pbrMetallicRoughness:{baseColorTexture:{index:0}, metallicFactor:0.0, roughnessFactor:1.0},
    name:"char_mat", doubleSided:true
  }];

  var prim={attributes:{POSITION:aPos, NORMAL:aNor, TEXCOORD_0:aUv, JOINTS_0:aJ, WEIGHTS_0:aW}, indices:aIdx, material:0};
  var meshes=[{primitives:[prim], name:"char_mesh"}];
  var skins=[{inverseBindMatrices:aIbm, joints:BONES.map(function(b){return name2node[b];}), skeleton:name2node['hips']}];

  var gltf={
    asset:{version:"2.0", generator:"3DtoolJS"},
    scene:0,
    scenes:[{nodes:[name2node['hips'], meshNodeIdx]}],
    nodes:nodes,
    meshes:meshes,
    skins:skins,
    materials:materials,
    textures:textures,
    images:images,
    samplers:samplers,
    animations:[],
    bufferViews:views.map(function(v){ return {buffer:0, byteOffset:v.byteOffset, byteLength:v.byteLength, target:v.target}; }),
    accessors:accessors,
    buffers:[{byteLength: blobLen}],
  };
  // bufferViewsのtargetがundefinedのものは省く(glTF検証で余計なフィールドを避ける)
  gltf.bufferViews.forEach(function(bv){ if(bv.target===undefined) delete bv.target; });

  var jsonStr=JSON.stringify(gltf);
  var jsonBytes=new TextEncoder().encode(jsonStr);
  var jsonPadded=align4(jsonBytes.length);
  var jsonPad=jsonPadded-jsonBytes.length;

  var binBytes=new Uint8Array(blobLen);
  var off2=0;
  bufferParts.forEach(function(p){ binBytes.set(p, off2); off2+=p.byteLength; });
  var binPadded=align4(binBytes.length);
  var binPad=binPadded-binBytes.length;

  var totalLen = 12 + 8+jsonPadded + 8+binPadded;
  var out=new ArrayBuffer(totalLen);
  var dv=new DataView(out);
  var u8out=new Uint8Array(out);
  var p=0;
  dv.setUint32(p, 0x46546C67, true); p+=4; // magic "glTF"
  dv.setUint32(p, 2, true); p+=4;          // version
  dv.setUint32(p, totalLen, true); p+=4;   // total length
  // JSON chunk
  dv.setUint32(p, jsonPadded, true); p+=4;
  dv.setUint32(p, 0x4E4F534A, true); p+=4; // "JSON"
  u8out.set(jsonBytes, p); p+=jsonBytes.length;
  for(var i2=0;i2<jsonPad;i2++){ u8out[p++]=0x20; } // spaceで埋める(仕様推奨)
  // BIN chunk
  dv.setUint32(p, binPadded, true); p+=4;
  dv.setUint32(p, 0x004E4942, true); p+=4; // "BIN\0"
  u8out.set(binBytes, p); p+=binBytes.length;
  for(var i3=0;i3<binPad;i3++){ u8out[p++]=0x00; }

  return out;
}
P3D.buildGLB = buildGLB;

/**
 * VEO_VIDEO_TO_3D_PLAN.md M2スコープ用の簡易GLB書き出し。
 * 通常のbuildGLBはUV+単一テクスチャ+スキニング(骨格)を前提にしているが、
 * M2(投票制彫刻)の時点ではUVチャート展開(M3)もスキニング(M4)もまだ無い、
 * 「形状だけ確認したい」段階のプレビュー用。頂点カラー(COLOR_0)だけを
 * 持つ、骨無しの単一メッシュとして書き出す(glTF仕様上、COLOR_0は
 * 対応ビューアでbaseColorに自動で乗算されるため、テクスチャなしでも
 * 色が見える)。
 * opts: {V:Float32Array(N*3), N:Float32Array(N*3), F:Uint32Array(M*3),
 *        C:Float32Array(N*3, 0..1のRGB)}
 * 戻り値: ArrayBuffer (GLBファイル全体)
 */
function buildStaticVertexColorGLB(opts){
  var V=Float32Array.from(opts.V), Nrm=opts.N, F=opts.F, C=opts.C;

  var bufferParts=[]; var blobLen=0;
  function addView(dataBuf, target){
    while(blobLen%4!==0){ bufferParts.push(new Uint8Array([0])); blobLen+=1; }
    var off=blobLen;
    var u8 = new Uint8Array(dataBuf);
    bufferParts.push(u8); blobLen+=u8.byteLength;
    return {byteOffset:off, byteLength:u8.byteLength, target:target};
  }
  var views=[], accessors=[];
  function pushView(v){ views.push(v); return views.length-1; }
  function pushAcc(a){ accessors.push(a); return accessors.length-1; }
  function minmax3(arr){
    var n=arr.length/3;
    var mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity];
    for(var i=0;i<n;i++){
      for(var k=0;k<3;k++){
        var v=arr[i*3+k];
        if(v<mn[k])mn[k]=v; if(v>mx[k])mx[k]=v;
      }
    }
    return {min:mn,max:mx};
  }

  var vPos=pushView(addView(V.buffer, GLTF_ARRAY_BUFFER));
  var mm=minmax3(V);
  var aPos=pushAcc({bufferView:vPos, componentType:GLTF_FLOAT, count:V.length/3, type:"VEC3", min:mm.min, max:mm.max});
  var vNor=pushView(addView(Nrm.buffer, GLTF_ARRAY_BUFFER));
  var aNor=pushAcc({bufferView:vNor, componentType:GLTF_FLOAT, count:Nrm.length/3, type:"VEC3"});
  var vCol=pushView(addView(C.buffer, GLTF_ARRAY_BUFFER));
  var aCol=pushAcc({bufferView:vCol, componentType:GLTF_FLOAT, count:C.length/3, type:"VEC3"});
  var vIdx=pushView(addView(F.buffer, GLTF_ELEMENT_ARRAY_BUFFER));
  var aIdx=pushAcc({bufferView:vIdx, componentType:GLTF_UINT, count:F.length, type:"SCALAR"});

  var prim={attributes:{POSITION:aPos, NORMAL:aNor, COLOR_0:aCol}, indices:aIdx, material:0};
  var meshes=[{primitives:[prim], name:"multiview_hull_preview"}];
  var materials=[{
    pbrMetallicRoughness:{baseColorFactor:[1,1,1,1], metallicFactor:0.0, roughnessFactor:0.9},
    name:"vertex_color_mat", doubleSided:true
  }];
  var nodes=[{name:"multiview_hull", mesh:0}];

  var gltf={
    asset:{version:"2.0", generator:"3DtoolJS ghost_studio M2"},
    scene:0,
    scenes:[{nodes:[0]}],
    nodes:nodes,
    meshes:meshes,
    materials:materials,
    animations:[],
    bufferViews:views.map(function(v){ return {buffer:0, byteOffset:v.byteOffset, byteLength:v.byteLength, target:v.target}; }),
    accessors:accessors,
    buffers:[{byteLength: blobLen}],
  };
  gltf.bufferViews.forEach(function(bv){ if(bv.target===undefined) delete bv.target; });

  var jsonStr=JSON.stringify(gltf);
  var jsonBytes=new TextEncoder().encode(jsonStr);
  var jsonPadded=align4(jsonBytes.length);
  var jsonPad=jsonPadded-jsonBytes.length;

  var binBytes=new Uint8Array(blobLen);
  var off2=0;
  bufferParts.forEach(function(p){ binBytes.set(p, off2); off2+=p.byteLength; });
  var binPadded=align4(binBytes.length);
  var binPad=binPadded-binBytes.length;

  var totalLen = 12 + 8+jsonPadded + 8+binPadded;
  var out=new ArrayBuffer(totalLen);
  var dv=new DataView(out);
  var u8out=new Uint8Array(out);
  var p=0;
  dv.setUint32(p, 0x46546C67, true); p+=4;
  dv.setUint32(p, 2, true); p+=4;
  dv.setUint32(p, totalLen, true); p+=4;
  dv.setUint32(p, jsonPadded, true); p+=4;
  dv.setUint32(p, 0x4E4F534A, true); p+=4;
  u8out.set(jsonBytes, p); p+=jsonBytes.length;
  for(var i2=0;i2<jsonPad;i2++){ u8out[p++]=0x20; }
  dv.setUint32(p, binPadded, true); p+=4;
  dv.setUint32(p, 0x004E4942, true); p+=4;
  u8out.set(binBytes, p); p+=binBytes.length;
  for(var i3=0;i3<binPad;i3++){ u8out[p++]=0x00; }

  return out;
}
P3D.buildStaticVertexColorGLB = buildStaticVertexColorGLB;

})(window);
