// 神社マップ(第11弾: 再々構築版)。マップ分離アーキテクチャ(SHRINE_REDESIGN_PLAN.md参照)に従い、
// controller.html(汎用ホスト)から呼ばれるGhostMaps.shrine.build(env)としてまとめている。
// env = { scene, colliders, loadStaticGLB, normalizeToHeight, pushCredit }
// THREE/GLTFLoaderはこのファイルより先に<script>で読み込まれているグローバルをそのまま使う。
//
// 第11弾でのレイアウト方針転換(SHRINE_REDESIGN_PLAN.md 第11弾参照):
// 「長い一本道(182m)」をやめ、駐車場→短い参道(密度重視)→広場化した境内→本殿→
// 短い奥の院、という約114mの構成に圧縮。境内は一本道ではなく幅34mの広場(プラザ)にし、
// 鳥居は一の鳥居・二の鳥居の大型2基のみ(千本鳥居風の連続小鳥居・各Tier入口ゲート鳥居は廃止)。
// 石段は参道中央を1箇所で跨ぐ単一オブジェクトに統一(旧: 左右に分裂して不自然だった問題を是正)。
// なお、社務所・絵馬掛け・神馬・磐座・竹林・駐車場の車/自販機など新規カテゴリは
// まだ素材調達(Step3)が済んでいないため、このコミットではゾーニング/動線のみ用意し、
// 実オブジェクトは調達後の別コミットで追加する(TODOコメントで明記)。
(function(global){
"use strict";
const GhostMaps=global.GhostMaps=global.GhostMaps||{};

GhostMaps.shrine={
id:'shrine', title:'神社',
build(env){
  const {scene,colliders,loadStaticGLB,normalizeToHeight,pushCredit}=env;
  const group=new THREE.Group();
  scene.add(group);

  // ================= レイアウト定数(第11弾: 全長約114m、広場中心) =================
  // 駐車場(Tier0,Y=0)→参道(Tier0,Y=0,短く密に)→石段(単一)→境内広場(Tier1,Y=1.8,幅34m)
  // →石段→本殿区画(Tier2,Y=3.2)→石段(あえて下る)→奥の院(Tier1.5,Y=1.3,短縮)→しめ縄境界。
  const PATH_MIN_Z=-14, PATH_MAX_Z=100;
  const Z_PARKING_END=-2;      // 駐車場→参道の境目
  const Z_SANDOU_END=20;       // 参道→石段1の境目
  const Z_SLOPE1_S=20, Z_SLOPE1_E=24;
  const Z_KEIDAI_END=64;       // 境内広場→石段2の境目
  const Z_SLOPE2_S=64, Z_SLOPE2_E=68;
  const Z_HONDEN_END=82;       // 本殿区画→石段3の境目
  const Z_SLOPE3_S=82, Z_SLOPE3_E=86;
  const Z_BOUNDARY=98;

  const Y_TIER1=1.8, Y_TIER2=3.2, Y_TIER15=1.3;
  const HALFW_PARKING=11, HALFW_SANDOU=7, HALFW_KEIDAI=17, HALFW_HONDEN=7.5, HALFW_OKU=6.5;
  const POND_CX=11, POND_CZ=48, POND_RX=5, POND_RZ=6, POND_DEPTH=0.8;
  const POND_EAST_RIGHT=HALFW_KEIDAI+5, POND_Z0=42, POND_Z1=54;

  // 自己レビューでの是正: 段差区間はsmoothstep(S字カーブ)ではなく線形補間にする。
  // 石段の装飾モデルは物理的にまっすぐな直線状の階段形状であり、S字カーブの地面と
  // 組み合わせると区間の上下端でモデルと地面の傾斜が食い違って浮き/めり込みが生じ、
  // 「階段が変」に見える原因になっていた。線形にすることで実際の階段と同じ一定勾配になる。
  function lerpClamped(a,b,z){ const t=Math.max(0,Math.min(1,(z-a)/(b-a))); return t; }
  function tierY(z){
    if(z<Z_SLOPE1_S)return 0;
    if(z<Z_SLOPE1_E)return Y_TIER1*lerpClamped(Z_SLOPE1_S,Z_SLOPE1_E,z);
    if(z<Z_SLOPE2_S)return Y_TIER1;
    if(z<Z_SLOPE2_E)return Y_TIER1+(Y_TIER2-Y_TIER1)*lerpClamped(Z_SLOPE2_S,Z_SLOPE2_E,z);
    if(z<Z_SLOPE3_S)return Y_TIER2;
    if(z<Z_SLOPE3_E)return Y_TIER2+(Y_TIER15-Y_TIER2)*lerpClamped(Z_SLOPE3_S,Z_SLOPE3_E,z);
    return Y_TIER15;
  }
  function groundHeightAt(x,z){
    let y=tierY(z);
    if(z>POND_Z0&&z<POND_Z1){
      const dx=(x-POND_CX)/POND_RX, dz=(z-POND_CZ)/POND_RZ, d=Math.sqrt(dx*dx+dz*dz);
      if(d<1)y-=(1-d*d)*POND_DEPTH;
    }
    return y;
  }
  // 各スロープ帯(z範囲)・池の楕円内かどうかの判定(scatterPropsで散布除外に使う。
  // 第11弾でのバグ修正: 浮遊オブジェクトはスロープ帯・池の窪みへ通常の散布ロジックが
  // 侵入していたことが主因だったため、対象帯を明示的に除外する)。
  function inSlopeBand(z){
    return (z>=Z_SLOPE1_S&&z<=Z_SLOPE1_E)||(z>=Z_SLOPE2_S&&z<=Z_SLOPE2_E)||(z>=Z_SLOPE3_S&&z<=Z_SLOPE3_E);
  }
  function inPondEllipse(x,z){
    if(z<=POND_Z0||z>=POND_Z1)return false;
    const dx=(x-POND_CX)/(POND_RX+1.5), dz=(z-POND_CZ)/(POND_RZ+1.5);
    return (dx*dx+dz*dz)<1;
  }
  function corridorBoundsAt(z){
    if(z<Z_PARKING_END)return {left:-HALFW_PARKING,right:HALFW_PARKING};
    if(z<Z_SLOPE1_E)return {left:-HALFW_SANDOU,right:HALFW_SANDOU};
    if(z<Z_SLOPE2_E){
      const right=(z>POND_Z0&&z<POND_Z1)?POND_EAST_RIGHT:HALFW_KEIDAI;
      return {left:-HALFW_KEIDAI,right};
    }
    if(z<Z_SLOPE3_E)return {left:-HALFW_HONDEN,right:HALFW_HONDEN};
    return {left:-HALFW_OKU,right:HALFW_OKU};
  }

  // ================= 汎用ヘルパー =================
  // XZ中心が原点からズレたフリーモデル(例: bush_freeは複数バリエーションが並んで
  // x=150付近に配置されたまま書き出されている)を、指定位置に置いた時に自然な場所へ
  // 収まるよう水平方向だけ再センタリングする(normalizeToHeightのYオフセット処理とは独立)。
  function centerXZ(obj){
    obj.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(obj);
    obj.position.x-=(box.min.x+box.max.x)/2;
    obj.position.z-=(box.min.z+box.max.z)/2;
    return obj;
  }
  // normalizeToHeight済みのobjを、地形の高さに追従させて(x,z)へ設置する。
  // normalizeToHeightはY=0の平地を前提に「最下点がY=0に来る」ようposition.yを既に
  // 調整済みなので、その値に地形の高さを加算するだけでよい(上書きしない)。
  // さらに、bboxの最下点を実測して地面へスナップし2cm沈めることで浮遊を防ぐ(第11弾)。
  function placeOnGround(obj,x,z){
    obj.position.x=x; obj.position.z=z;
    obj.position.y+=groundHeightAt(x,z);
    obj.updateMatrixWorld(true);
    const box=new THREE.Box3().setFromObject(obj);
    const groundY=groundHeightAt(x,z);
    const gap=box.min.y-groundY;
    if(Math.abs(gap)>0.01) obj.position.y-=(gap+0.02);
    return obj;
  }

  // ================= 地面(ゾーンごとに素材違い、頂点変位で高低差を表現) =================
  function makeCanvasTexture(painter,repeat){
    const c=document.createElement('canvas'); c.width=c.height=256;
    painter(c.getContext('2d'));
    const tex=new THREE.CanvasTexture(c);
    tex.wrapS=tex.wrapT=THREE.RepeatWrapping; tex.repeat.set(repeat,repeat);
    return tex;
  }
  function speckle(ctx,base,count,lightBias,size){
    ctx.fillStyle=base; ctx.fillRect(0,0,256,256);
    for(let i=0;i<count;i++){
      const x=Math.random()*256,y=Math.random()*256,r=size*0.5+Math.random()*size;
      const v=Math.random()<lightBias?18+Math.random()*22:-(12+Math.random()*16);
      ctx.fillStyle='rgba('+(v>0?255:0)+','+(v>0?255:0)+','+(v>0?255:0)+','+(Math.abs(v)/255)+')';
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
    }
  }
  const gravelTex=makeCanvasTexture(ctx=>speckle(ctx,'#5c574c',2400,0.55,1.1),30);
  const stonePathTex=makeCanvasTexture(ctx=>{
    ctx.fillStyle='#3a3d40'; ctx.fillRect(0,0,256,256);
    ctx.strokeStyle='rgba(15,16,18,0.9)'; ctx.lineWidth=3;
    const cell=42;
    for(let y=0;y<256+cell;y+=cell){
      for(let x=0;x<256+cell;x+=cell){
        const jx=(Math.random()-0.5)*6, jy=(Math.random()-0.5)*6;
        ctx.strokeRect(x+jx,y+jy,cell-4,cell-4);
      }
    }
  },14);
  const dirtMossTex=makeCanvasTexture(ctx=>speckle(ctx,'#332c22',2000,0.35,1.3),26);
  // 駐車場ゾーン用のアスファルト風テクスチャ(白線つき)。「舗装された現実世界から
  // 神域へ入っていく」導入部を表現する(第11弾、user案)。
  const asphaltTex=makeCanvasTexture(ctx=>{
    speckle(ctx,'#26282b',1800,0.45,1.0);
    ctx.strokeStyle='rgba(235,235,225,0.55)'; ctx.lineWidth=4;
    ctx.setLineDash([18,10]);
    ctx.beginPath(); ctx.moveTo(64,0); ctx.lineTo(64,256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(192,0); ctx.lineTo(192,256); ctx.stroke();
    ctx.setLineDash([]);
  },10);

  function buildGroundMesh(halfWidth,zFrom,zTo,tex,yOffset){
    const width=halfWidth*2, depth=zTo-zFrom, zCenter=(zFrom+zTo)/2;
    const wSeg=Math.max(2,Math.round(width/3)), dSeg=Math.max(2,Math.round(depth/3));
    const geo=new THREE.PlaneGeometry(width,depth,wSeg,dSeg);
    geo.rotateX(-Math.PI/2);
    geo.translate(0,0,zCenter);
    const pos=geo.attributes.position;
    for(let i=0;i<pos.count;i++){
      const x=pos.getX(i), z=pos.getZ(i);
      pos.setY(i,groundHeightAt(x,z)+(yOffset||0));
    }
    pos.needsUpdate=true;
    geo.computeVertexNormals();
    const mat=new THREE.MeshStandardMaterial({map:tex,roughness:0.92,metalness:0});
    const mesh=new THREE.Mesh(geo,mat);
    mesh.receiveShadow=false;
    group.add(mesh);
    return mesh;
  }
  // 駐車場=アスファルト、参道〜本殿区画=玉砂利ベース(参道中央+本殿正面は石畳)、
  // 奥の院=土/苔混じりの未舗装路、という実在の神社の作法+現代パートのゾーニング。
  buildGroundMesh(HALFW_PARKING,PATH_MIN_Z,Z_PARKING_END,asphaltTex,0);
  buildGroundMesh(HALFW_KEIDAI+2,Z_PARKING_END,Z_SLOPE3_S,gravelTex,0);
  buildGroundMesh(HALFW_OKU+2,Z_SLOPE3_S,PATH_MAX_Z,dirtMossTex,0);
  // 正中(せいちゅう)の石畳帯: 参道入口から本殿の手前まで、実在の神社の作法通り
  // 一本の帯として途切れず連続させる(自己レビューで指摘: 旧実装は参道と本殿正面の
  // 2箇所に分断されており、境内広場を横切る区間に石畳が無かった)。本殿正面のみ幅を広げる。
  buildGroundMesh(1.6,Z_PARKING_END,Z_HONDEN_END,stonePathTex,0.01);
  buildGroundMesh(3.2,72,80,stonePathTex,0.011); // 本殿正面だけ幅広の石畳を上乗せ

  // 水面(池、簡易な半透明の平面)
  {
    const wGeo=new THREE.CircleGeometry(1,24).scale(POND_RX,POND_RZ,1);
    wGeo.rotateX(-Math.PI/2);
    const y=groundHeightAt(POND_CX,POND_CZ)-POND_DEPTH*0.55;
    wGeo.translate(POND_CX,y,POND_CZ);
    const wMat=new THREE.MeshStandardMaterial({color:0x1c2f38,roughness:0.25,metalness:0.1,
      transparent:true,opacity:0.85});
    group.add(new THREE.Mesh(wGeo,wMat));
  }

  // ================= 移動可能範囲の境界線(光る線、地面のみ対象) =================
  function addBoundaryLine(x1,z1,x2,z2){
    const len=Math.hypot(x2-x1,z2-z1);
    if(len<1e-6)return;
    const geo=new THREE.PlaneGeometry(len,0.012);
    geo.rotateX(-Math.PI/2);
    const mat=new THREE.MeshBasicMaterial({color:0x39ff9e,transparent:true,opacity:0.85,
      toneMapped:false,depthWrite:false,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geo,mat);
    const midY=groundHeightAt((x1+x2)/2,(z1+z2)/2)+0.03;
    mesh.position.set((x1+x2)/2,midY,(z1+z2)/2);
    mesh.rotation.y=Math.atan2(-(z2-z1),(x2-x1));
    group.add(mesh);
  }
  function buildBoundaryLines(){
    const STEP=0.5;
    let prev=corridorBoundsAt(PATH_MIN_Z);
    let leftStart=PATH_MIN_Z, rightStart=PATH_MIN_Z;
    for(let z=PATH_MIN_Z+STEP;z<=PATH_MAX_Z+1e-6;z+=STEP){
      const zc=Math.min(z,PATH_MAX_Z);
      const b=corridorBoundsAt(zc);
      if(b.left!==prev.left){ addBoundaryLine(prev.left,leftStart,prev.left,zc); addBoundaryLine(prev.left,zc,b.left,zc); leftStart=zc; }
      if(b.right!==prev.right){ addBoundaryLine(prev.right,rightStart,prev.right,zc); addBoundaryLine(prev.right,zc,b.right,zc); rightStart=zc; }
      prev=b;
    }
    addBoundaryLine(prev.left,leftStart,prev.left,PATH_MAX_Z);
    addBoundaryLine(prev.right,rightStart,prev.right,PATH_MAX_Z);
    const bS=corridorBoundsAt(PATH_MIN_Z), bE=corridorBoundsAt(PATH_MAX_Z);
    addBoundaryLine(bS.left,PATH_MIN_Z,bS.right,PATH_MIN_Z);
    addBoundaryLine(bE.left,PATH_MAX_Z,bE.right,PATH_MAX_Z);
  }
  // 敷地の境界(移動可能範囲の縁)に沿って生け垣(茂み)を並べ、光る線だけの無機質な
  // 境界を緩和する。corridorBoundsAtの左右境界のすぐ外側に一定間隔で配置する(user要望)。
  function buildHedge(){
    const STEP=4, OUTSET=0.5;
    loadStaticGLB('models/bush_free.glb').then(template=>{
      centerXZ(template);
      for(let z=PATH_MIN_Z+2;z<=PATH_MAX_Z-2;z+=STEP){
        const b=corridorBoundsAt(z);
        if(inSlopeBand(z))continue; // 石段区間は柵・視界の妨げになるため間引く
        [b.left-OUTSET,b.right+OUTSET].forEach(x=>{
          const t=template.clone(true);
          normalizeToHeight(t,0.85+Math.random()*0.5);
          t.rotation.y=Math.random()*Math.PI*2;
          placeOnGround(t,x,z+(Math.random()-0.5)*1.2);
          group.add(t);
        });
      }
      pushCredit(CREDIT_BUSH);
    }).catch(()=>{});
  }

  // ================= 設置物 =================
  function placeStatic(url,x,z,targetHeight,opts){
    opts=opts||{};
    loadStaticGLB(url).then(obj=>{
      if(opts.rotY)obj.rotation.y=opts.rotY;
      normalizeToHeight(obj,targetHeight);
      if(opts.centerXZ)centerXZ(obj);
      placeOnGround(obj,x,z);
      if(opts.scale)obj.scale.multiplyScalar(opts.scale);
      group.add(obj);
      if(opts.collider)colliders.push({type:'circle',x,z,r:opts.colliderR||0.4});
      if(opts.credit)pushCredit(opts.credit);
      if(opts.onLoaded)opts.onLoaded(obj);
    }).catch(()=>console.warn('[shrine] failed to load',url));
  }

  const CREDIT_TORII_HERO={name:'Japanese Torii',author:'Jacques Fourie',license:'CC-BY',url:'https://poly.pizza/m/cXyQGUwmlA5'};
  const CREDIT_LANTERN={name:'Toro',author:'Matt Newell',license:'CC-BY',url:'https://poly.pizza/m/0SguM8o_PMc'};
  const CREDIT_LANTERN_ALT={name:'Japanese Stone Lamp',author:'Flopsi',license:'CC-BY 3.0',url:'https://poly.pizza/m/5gZfOZIW92k'};
  const CREDIT_FOX={name:'Kurama(キツネの神使像)',author:'Imran Bepari (theCH33F)',license:'CC-BY',url:'https://poly.pizza/m/5KQZFKrA-EM'};
  const CREDIT_PEDESTAL={name:'Pebble Square',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/2YtLzwgsWp'};
  const CREDIT_SHRINE1={name:'Shrine',author:'Kay Lousberg',license:'CC0',url:'https://poly.pizza/m/Qq8M5LSXQ2'};
  const CREDIT_SHRINE2={name:'Shrine(石柱)',author:'Kay Lousberg',license:'CC0',url:'https://poly.pizza/m/tFxdxO5clk'};
  const CREDIT_PINE={name:'Pine Tree',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/gX8WmgkeEm'};
  const CREDIT_ROCK={name:'Rock',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/4MUaQTcDdc'};
  const CREDIT_BUSH={name:'Flower Bushes',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/1X06RgvSr6'};
  const CREDIT_BRIDGE={name:'Small Bridge',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/j4KsIuJYnq'};
  const CREDIT_FENCE={name:'Fence',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/r0n40F7FKx'};
  const CREDIT_SIGNPOST={name:'Signpost',author:'Kenney',license:'CC0',url:'https://poly.pizza/m/3U2lj1gpeH'};
  const CREDIT_STAIRS={name:'Stairs',author:'Kenney',license:'CC0',url:'https://poly.pizza/m/lZFtRSTeKR'};
  const CREDIT_DOOR={name:'Japanese Door',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/t4otyljz8K'};
  const CREDIT_HONDEN={name:'Shrine(本殿)',author:'つっちー',license:'商用利用・改変可(再配布不可)',url:'https://booth.pm/ja/items/2659982'};
  const CREDIT_CHOUZUYA={name:'手水舎',author:'つっちー',license:'商用利用・改変可(再配布不可)',url:'https://shoshinshaworks.booth.pm/items/2660016'};

  // --- 一の鳥居(参道入口)。第11弾: 大型鳥居は一の鳥居/二の鳥居の2基のみに削減。
  //     現行のtorii_hero_free(Jacques Fourie、提灯付き)は暫定続投だが、Step4で
  //     プロシージャル自作の明神鳥居に置き換え予定(提灯も撤去)。 ---
  const Z_ICHI_TORII=0;
  colliders.push({type:'circle',x:-2.9,z:Z_ICHI_TORII,r:0.3},{type:'circle',x:2.9,z:Z_ICHI_TORII,r:0.3});
  placeStatic('models/torii_hero_free.glb',0,Z_ICHI_TORII,5.6,{credit:CREDIT_TORII_HERO});

  // --- 二の鳥居(石段2の上、本殿区画の入口) ---
  const Z_NI_TORII=Z_SLOPE2_E+1;
  colliders.push({type:'circle',x:-3.0,z:Z_NI_TORII,r:0.3},{type:'circle',x:3.0,z:Z_NI_TORII,r:0.3});
  placeStatic('models/torii_hero_free.glb',0,Z_NI_TORII,5.0,{});

  // --- 石段(単一・参道中央を跨ぐ1オブジェクトに統一。第11弾でのバグ修正: 旧実装は
  //     左右に1個ずつ分裂配置していて不自然だったため、幅方向に引き伸ばした1枚へ統合) ---
  function placeStairDecor(zFrom,zTo,halfW){
    loadStaticGLB('models/stairs_free.glb').then(obj=>{
      // 石段3(本殿→奥の院)は「あえて下る」設計でtierY(zTo)<tierY(zFrom)となり差分が負になる。
      // normalizeToHeightは targetHeight/現在高さ をそのままscaleに掛けるため、負の値を渡すと
      // モデルが原点を軸に上下反転し、潰れた木目色の板のように見える不具合の原因だった(自己レビュー)。
      // 高さは常に正の絶対値を渡し、上り/下りの向きは既存のrotation.y設定にのみ依存させる。
      normalizeToHeight(obj,Math.abs(tierY(zTo)-tierY(zFrom))||1.2);
      obj.rotation.y=Math.PI/2;
      const len=zTo-zFrom;
      // rotation.y=90°では local X 軸がワールドZ(登り方向)、local Z 軸がワールドX(幅方向)に
      // 対応する(x'=z, z'=-x)。登り方向はscale.xで区間長に合わせ、幅方向は実測bboxを
      // 基準にscale.zで参道全幅へ引き伸ばす(絶対値をそのまま割る旧実装は極端な巨大化バグの原因だった)。
      obj.scale.x*=len/1.34;
      obj.updateMatrixWorld(true);
      const box0=new THREE.Box3().setFromObject(obj);
      const curWidth=Math.max(0.01,box0.max.x-box0.min.x);
      const desiredWidth=halfW*1.8;
      obj.scale.z*=desiredWidth/curWidth;
      // 自己レビューでの是正: 中間点(mid z)の地面高さでbboxの最下点をスナップすると、
      // モデルの実際の最下点(登り口=zFrom側)とはズレた基準になり、区間の上端 or 下端で
      // 地面から浮く/めり込むズレが出ていた。最下点は登り口側にあると想定し、zFromの
      // 地面高さを基準にスナップする(線形勾配化と合わせて上端もほぼ一致するはず)。
      obj.position.x=0; obj.position.z=(zFrom+zTo)/2;
      obj.updateMatrixWorld(true);
      const box1=new THREE.Box3().setFromObject(obj);
      obj.position.y+=groundHeightAt(0,zFrom)-box1.min.y;
      group.add(obj);
    }).catch(()=>{});
  }
  placeStairDecor(Z_SLOPE1_S,Z_SLOPE1_E,HALFW_SANDOU);
  placeStairDecor(Z_SLOPE2_S,Z_SLOPE2_E,HALFW_KEIDAI*0.5);
  placeStairDecor(Z_SLOPE3_S,Z_SLOPE3_E,HALFW_HONDEN);
  pushCredit(CREDIT_STAIRS);

  // --- 狛犬一対(石段1の上、境内広場の入口) ---
  const Z_KOMAINU=Z_SLOPE1_E+2;
  [-1,1].forEach(side=>{
    const x=side*3.4;
    colliders.push({type:'circle',x,z:Z_KOMAINU,r:0.5});
    placeStatic('models/pedestal_free.glb',x,Z_KOMAINU,0.3,{});
    placeStatic('models/fox_statue_free.glb',x,Z_KOMAINU,0.8,{rotY:side>0?-Math.PI/2:Math.PI/2,
      onLoaded:o=>{o.position.y+=0.3;},credit:CREDIT_FOX});
  });
  pushCredit(CREDIT_PEDESTAL);

  // --- 手水舎(境内広場入口すぐ) ---
  let basinBulb=null, basinSwingT=0;
  {
    const x=4.5, z=30;
    colliders.push({type:'circle',x,z,r:0.55});
    const bulb=new THREE.Mesh(new THREE.SphereGeometry(0.06,8,8),new THREE.MeshBasicMaterial({color:0xffe9b0,toneMapped:false}));
    placeOnGround(bulb,x,z); bulb.position.y+=1.7;
    group.add(bulb);
    bulb.add(new THREE.PointLight(0xffdca0,0.7,5,2));
    basinBulb=bulb;
    loadStaticGLB('models/chouzuya_free.glb').then(obj=>{
      normalizeToHeight(obj,2.8);
      placeOnGround(obj,x,z);
      const _hsl={h:0,s:0,l:0};
      obj.traverse(o=>{ if(o.isMesh&&o.material&&o.material.color){
        o.material.color.getHSL(_hsl);
        o.material.color.setHSL(_hsl.h,Math.min(1,_hsl.s*1.1),Math.max(_hsl.l,0.42));
      }});
      group.add(obj);
      pushCredit(CREDIT_CHOUZUYA);
    }).catch(()=>{});
  }

  // --- 石灯籠(参道は3〜4m間隔で密に、境内広場は周囲を囲むように配置) ---
  function placeLantern(x,z,mode,alt){ // mode: 'lit'|'cold'|'dark'
    colliders.push({type:'circle',x,z,r:0.3});
    loadStaticGLB(alt?'models/lantern_alt_free.glb':'models/lantern_free.glb').then(obj=>{
      normalizeToHeight(obj,1.15);
      placeOnGround(obj,x,z);
      group.add(obj);
      if(mode!=='dark'){
        const color=mode==='cold'?0x8fd8ff:0xffb066;
        const glowMesh=new THREE.Mesh(new THREE.SphereGeometry(0.07,8,8),new THREE.MeshBasicMaterial({color,toneMapped:false}));
        glowMesh.position.set(x,groundHeightAt(x,z)+0.75,z);
        group.add(glowMesh);
        if(mode==='cold'){ const glow=new THREE.PointLight(color,0.5,4.2,2); glow.position.copy(glowMesh.position); group.add(glow); }
      }
    }).catch(()=>{});
  }
  pushCredit(CREDIT_LANTERN); pushCredit(CREDIT_LANTERN_ALT);
  // 参道: z=2〜18を3m間隔で(密度アップ、旧2.4m*12本→短い参道に合わせて7組=14基)
  const SANDOU_LANTERN_MODES=['lit','dark','cold','lit','dark','lit','dark'];
  for(let i=0;i<7;i++){
    const z=4.5+i*2.8; // 一の鳥居(z=0)と重なって見えないよう十分な間隔を確保
    placeLantern(-4.6,z,SANDOU_LANTERN_MODES[i],i%3===0);
    placeLantern(4.6,z,SANDOU_LANTERN_MODES[(i+3)%SANDOU_LANTERN_MODES.length],i%2===0);
  }
  // 境内広場: 周囲を囲む配置(広場感を出す)
  const KEIDAI_RING=[[-14,30],[14,30],[-14,60],[14,60],[-15,45],[15,45],[0,32]];
  KEIDAI_RING.forEach((p,i)=>placeLantern(p[0],p[1],i%2===0?'lit':'cold',i%2===1));

  // --- 御神木(境内広場、幹の胸の高さに注連縄+紙垂) ---
  {
    const x=-13, z=40;
    colliders.push({type:'circle',x,z,r:0.9});
    loadStaticGLB('models/pine_tree_free.glb').then(obj=>{
      normalizeToHeight(obj,11);
      placeOnGround(obj,x,z);
      group.add(obj);
      const ropeMat=new THREE.MeshStandardMaterial({color:0xcfc29a,roughness:0.95});
      const ring=new THREE.Mesh(new THREE.TorusGeometry(0.55,0.05,8,20),ropeMat);
      ring.rotation.x=Math.PI/2;
      ring.position.set(x,groundHeightAt(x,z)+1.4,z);
      group.add(ring);
      const shideMat=new THREE.MeshBasicMaterial({color:0xf2efe6,side:THREE.DoubleSide});
      for(let a=0;a<3;a++){
        const ang=a*Math.PI*2/3;
        const shide=new THREE.Mesh(new THREE.PlaneGeometry(0.14,0.32),shideMat);
        shide.position.set(x+Math.cos(ang)*0.55,groundHeightAt(x,z)+1.2,z+Math.sin(ang)*0.55);
        shide.rotation.y=-ang;
        group.add(shide);
      }
    }).catch(()=>{});
  }

  // --- 摂社/末社セット(祠+ミニ鳥居+ミニ灯籠2基、境内広場の2箇所にまとめて配置) ---
  function placeSubShrineSet(x,z,shrineUrl,shrineH){
    placeStatic(shrineUrl,x,z,shrineH,{collider:true,colliderR:0.5});
    colliders.push({type:'circle',x,z:z-1.6,r:0.25});
    placeStatic('models/torii_row_free.glb',x,z-1.6,2.6,{});
    [[-0.7,0],[0.7,0]].forEach(([ox,oz])=>{
      placeLantern(x+ox,z-0.8+oz,'dark',true);
    });
  }
  placeSubShrineSet(13,36,'models/shrine_small1_free.glb',1.9);
  placeSubShrineSet(13,56,'models/shrine_small2_free.glb',2.4);
  pushCredit(CREDIT_SHRINE1); pushCredit(CREDIT_SHRINE2);

  // --- 池+太鼓橋(境内広場西側の見どころ) ---
  {
    loadStaticGLB('models/bridge_free.glb').then(obj=>{
      normalizeToHeight(obj,1.6);
      placeOnGround(obj,POND_CX,POND_CZ);
      group.add(obj);
      pushCredit(CREDIT_BRIDGE);
    }).catch(()=>{});
    colliders.push({type:'box',minX:POND_CX-5.2,maxX:POND_CX-2.6,minZ:POND_CZ-1.2,maxZ:POND_CZ+1.2});
    colliders.push({type:'box',minX:POND_CX+2.6,maxX:POND_CX+5.2,minZ:POND_CZ-1.2,maxZ:POND_CZ+1.2});
    loadStaticGLB('models/signpost_free.glb').then(obj=>{
      normalizeToHeight(obj,1.1);
      obj.rotation.y=Math.PI/2;
      placeOnGround(obj,3.6,POND_Z0-1);
      group.add(obj);
      pushCredit(CREDIT_SIGNPOST);
    }).catch(()=>{});
  }

  // TODO(Step3素材調達後に実装): 社務所/授与所、絵馬掛け所、おみくじ結び所、神馬の銅像、
  // 蔵/井戸、篝火、提灯スタンド、駐車場の放置車・自動販売機・社号標・掲示板。
  // いずれも本レイアウトの各ゾーン内に配置スペースは確保済み(境内広場の外周・駐車場ゾーン等)。

  // --- 本殿参道: 玉垣(低い柵)で囲われた区画、キツネの神使像+台座を対で配置 ---
  const Z_FOX=76;
  {
    const zFrom=Z_NI_TORII+3, zTo=Z_HONDEN_END-2;
    [-1,1].forEach(side=>{
      const fx=side*HALFW_HONDEN*0.72;
      for(let z=zFrom;z<=zTo;z+=3.2){
        loadStaticGLB('models/fence_free.glb').then(obj=>{
          normalizeToHeight(obj,1.05);
          obj.rotation.y=Math.PI/2;
          placeOnGround(obj,fx,z);
          group.add(obj);
        }).catch(()=>{});
      }
    });
    pushCredit(CREDIT_FENCE);
  }
  [-1,1].forEach(side=>{
    const x=side*2.5;
    colliders.push({type:'circle',x,z:Z_FOX,r:0.5});
    placeStatic('models/pedestal_free.glb',x,Z_FOX,0.35,{});
    loadStaticGLB('models/fox_statue_free.glb').then(obj=>{
      normalizeToHeight(obj,0.85);
      obj.rotation.y=side>0?-Math.PI/2:Math.PI/2; // 参道側(中央)を向くよう対で配置
      const pedestalH=0.35;
      obj.position.x=x; obj.position.z=Z_FOX;
      obj.position.y+=groundHeightAt(x,Z_FOX)+pedestalH;
      group.add(obj);
      pushCredit(CREDIT_FOX); pushCredit(CREDIT_PEDESTAL);
    }).catch(()=>{});
  });

  // --- 本殿(最高地点。前後反転バグを是正: モデルの正面はローカル+Zを向いているため
  //     参道側(-Z方向)を向かせるにはY軸180度回転が必要) ---
  const Z_HONDEN=80;
  let sensorLight=null, sensorLightOn=false, hallFrontZ=0;
  {
    const halfW=4.0, halfD=4.0;
    colliders.push({type:'box',minX:-halfW-0.4,maxX:halfW+0.4,minZ:Z_HONDEN-halfD-0.4,maxZ:Z_HONDEN+halfD+0.4});
    loadStaticGLB('models/honden_free.glb').then(obj=>{
      obj.rotation.y=Math.PI;
      normalizeToHeight(obj,6.2);
      placeOnGround(obj,0,Z_HONDEN);
      const _hsl={h:0,s:0,l:0};
      obj.traverse(o=>{ if(o.isMesh&&o.material&&o.material.color){
        o.material.color.getHSL(_hsl);
        o.material.color.setHSL(_hsl.h,Math.min(1,_hsl.s*1.1),Math.max(_hsl.l,0.42));
      }});
      group.add(obj);
      pushCredit(CREDIT_HONDEN);
    }).catch(()=>console.warn('[shrine] failed to load honden_free.glb'));

    hallFrontZ=Z_HONDEN-halfD;
    // 自己レビューで撤去: shoji_door_freeを本殿の正面に壁なしで単独設置していたため、
    // 「謎の格子が本殿手前に浮いている」ように見えるバグだった。honden_free.glb自体に
    // 引き戸は含まれているため、この単独オブジェクトは不要と判断し削除する。

    sensorLight=new THREE.SpotLight(0xfff0d0,0,11,THREE.MathUtils.degToRad(48),0.4,1.2);
    sensorLight.position.set(0,groundHeightAt(0,hallFrontZ)+3.3,hallFrontZ-0.3);
    sensorLight.target.position.set(0,groundHeightAt(0,hallFrontZ),hallFrontZ-4.5);
    scene.add(sensorLight); scene.add(sensorLight.target);
  }

  // --- しめ縄+木杭の禁足地境界(奥の院、既存の実装をそのまま踏襲、座標のみ更新) ---
  function buildForbiddenBoundary(z,halfW){
    const g=new THREE.Group();
    const stakeMat=new THREE.MeshStandardMaterial({color:0x2e2015,roughness:0.9});
    const ropeMat=new THREE.MeshStandardMaterial({color:0xcfc29a,roughness:0.95});
    const shideMat=new THREE.MeshBasicMaterial({color:0xf2efe6,side:THREE.DoubleSide});
    const stakeCount=6, stakeH=1.1, xs=[];
    for(let i=0;i<stakeCount;i++){
      const x=-halfW+(halfW*2)*(i/(stakeCount-1));
      xs.push(x);
      const stake=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.07,stakeH,8),stakeMat);
      stake.position.set(x,stakeH/2,0); g.add(stake);
    }
    for(let i=0;i<xs.length-1;i++){
      const x0=xs[i],x1=xs[i+1],midX=(x0+x1)/2,len=Math.abs(x1-x0),sag=0.05,ropeY=stakeH*0.82-sag;
      const rope=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.03,len,6),ropeMat);
      rope.rotation.z=Math.PI/2; rope.position.set(midX,ropeY,0); g.add(rope);
      const shide=new THREE.Mesh(new THREE.PlaneGeometry(0.12,0.3),shideMat);
      shide.position.set(midX,ropeY-0.18,0); g.add(shide);
    }
    g.position.set(0,groundHeightAt(0,z),z);
    group.add(g);
    colliders.push({type:'box',minX:-halfW,maxX:halfW,minZ:z-0.15,maxZ:z+0.3});
  }
  buildForbiddenBoundary(Z_BOUNDARY,HALFW_OKU-0.3);

  // --- 駐車場口の常夜灯(入口の雰囲気づくり、ちらつきはupdate()で処理) ---
  let entranceLight=null, entranceFlickerT=0;
  entranceLight=new THREE.PointLight(0xfff0c0,1.0,9,2);
  entranceLight.position.set(0,3.6,-8);
  scene.add(entranceLight);

  // --- 杉の木・岩・茂み(参道〜奥の院まで散布。スロープ帯・池の楕円内は除外して
  //     浮遊オブジェクトのバグを防ぐ) ---
  function scatterProps(url,count,minDist,maxDist,zMin,zMax,targetHeight,opts){
    opts=opts||{};
    loadStaticGLB(url).then(template=>{
      normalizeToHeight(template,targetHeight);
      if(opts.centerXZ)centerXZ(template);
      let placed=0, attempts=0;
      while(placed<count&&attempts<count*6){
        attempts++;
        const side=Math.random()<0.5?-1:1;
        const x=side*(minDist+Math.random()*(maxDist-minDist));
        const z=zMin+Math.random()*(zMax-zMin);
        if(inSlopeBand(z))continue;
        if(inPondEllipse(x,z))continue;
        const t=template.clone(true);
        const s=(opts.scaleMin||0.8)+Math.random()*((opts.scaleMax||1.3)-(opts.scaleMin||0.8));
        t.position.copy(template.position);
        placeOnGround(t,x,z);
        t.rotation.y=Math.random()*Math.PI*2;
        t.scale.multiplyScalar(s);
        group.add(t);
        if(opts.collider)colliders.push({type:'circle',x,z,r:(opts.colliderR||0.4)*s});
        placed++;
      }
      if(opts.credit)pushCredit(opts.credit);
    }).catch(()=>{});
  }
  scatterProps('models/pine_tree_free.glb',34,7.5,16,-1,Z_BOUNDARY-4,7,{collider:true,colliderR:0.35,scaleMin:0.8,scaleMax:1.5,credit:CREDIT_PINE});
  scatterProps('models/rock_free.glb',22,5.5,16,-1,Z_BOUNDARY-4,0.9,{collider:true,colliderR:0.45,scaleMin:0.7,scaleMax:1.6,credit:CREDIT_ROCK});
  scatterProps('models/bush_free.glb',16,6,16,0,Z_BOUNDARY-4,1.1,{collider:false,scaleMin:0.6,scaleMax:1.0,centerXZ:true,credit:CREDIT_BUSH});

  buildBoundaryLines();
  buildHedge();

  // ================= 毎フレーム更新 =================
  function update(dt,charPos){
    entranceFlickerT+=dt;
    let v=0.85+Math.sin(entranceFlickerT*9)*0.08+Math.sin(entranceFlickerT*23)*0.05;
    if(Math.random()<0.015)v*=0.25;
    entranceLight.intensity=Math.max(0,v);

    basinSwingT+=dt;
    if(basinBulb){
      basinBulb.position.x=4.5+Math.sin(basinSwingT*1.3)*0.035;
      basinBulb.position.z=30+Math.cos(basinSwingT*0.9)*0.025;
    }

    const d=Math.hypot(charPos.x,charPos.z-hallFrontZ);
    sensorLightOn=d<6;
    sensorLight.intensity+=((sensorLightOn?1.7:0)-sensorLight.intensity)*Math.min(1,10*dt);
  }

  return {
    group,
    spawnPoint:{x:0,z:(PATH_MIN_Z+Z_PARKING_END)/2,yaw:0}, // 駐車場ゾーンの中央
    zMin:PATH_MIN_Z, zMax:PATH_MAX_Z,
    corridorBoundsAt,
    groundHeightAt,
    update,
  };
}
};
})(window);
