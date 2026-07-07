// 神社マップ(完全再構築版)。マップ分離アーキテクチャ(SHRINE_REDESIGN_PLAN.md参照)に従い、
// controller.html(汎用ホスト)から呼ばれるGhostMaps.shrine.build(env)としてまとめている。
// env = { scene, colliders, loadStaticGLB, normalizeToHeight, pushCredit }
// THREE/GLTFLoaderはこのファイルより先に<script>で読み込まれているグローバルをそのまま使う。
(function(global){
"use strict";
const GhostMaps=global.GhostMaps=global.GhostMaps||{};

GhostMaps.shrine={
id:'shrine', title:'神社',
build(env){
  const {scene,colliders,loadStaticGLB,normalizeToHeight,pushCredit}=env;
  const group=new THREE.Group();
  scene.add(group);

  // ================= レイアウト定数 =================
  // 参道(Tier0,Y=0)→石段1→境内(Tier1,Y=1.8)→石段2→本殿参道(Tier2,Y=3.3)→石段3(あえて下る)
  // →奥の院手前の窪地・奥の院(Tier1.5,Y=1.3)→しめ縄境界、という一直線の多段構成。
  const PATH_MIN_Z=-6, PATH_MAX_Z=176;
  const Y_TIER1=1.8, Y_TIER2=3.3, Y_TIER15=1.3;
  const Z_SLOPE1_S=54, Z_SLOPE1_E=60;
  const Z_SLOPE2_S=98, Z_SLOPE2_E=104;
  const Z_SLOPE3_S=150, Z_SLOPE3_E=156;
  const Z_BOUNDARY=173;

  const HALFW_TIER0=9, HALFW_TIER1=13, HALFW_TIER2=7, HALFW_TIER15=6.5;
  const POND_CX=12, POND_CZ=89, POND_RX=6, POND_RZ=8, POND_DEPTH=0.9;
  const POND_EAST_RIGHT=19, POND_Z0=79, POND_Z1=97;

  function smoothstep(a,b,z){ const t=Math.max(0,Math.min(1,(z-a)/(b-a))); return t*t*(3-2*t); }
  function tierY(z){
    if(z<Z_SLOPE1_S)return 0;
    if(z<Z_SLOPE1_E)return Y_TIER1*smoothstep(Z_SLOPE1_S,Z_SLOPE1_E,z);
    if(z<Z_SLOPE2_S)return Y_TIER1;
    if(z<Z_SLOPE2_E)return Y_TIER1+(Y_TIER2-Y_TIER1)*smoothstep(Z_SLOPE2_S,Z_SLOPE2_E,z);
    if(z<Z_SLOPE3_S)return Y_TIER2;
    if(z<Z_SLOPE3_E)return Y_TIER2+(Y_TIER15-Y_TIER2)*smoothstep(Z_SLOPE3_S,Z_SLOPE3_E,z);
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
  function corridorBoundsAt(z){
    if(z<Z_SLOPE1_E)return {left:-HALFW_TIER0,right:HALFW_TIER0};
    if(z<Z_SLOPE2_E){
      const right=(z>POND_Z0&&z<POND_Z1)?POND_EAST_RIGHT:HALFW_TIER1;
      return {left:-HALFW_TIER1,right};
    }
    if(z<Z_SLOPE3_E)return {left:-HALFW_TIER2,right:HALFW_TIER2};
    return {left:-HALFW_TIER15,right:HALFW_TIER15};
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
  function placeOnGround(obj,x,z){
    obj.position.x=x; obj.position.z=z;
    obj.position.y+=groundHeightAt(x,z);
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
  // 参道〜境内〜本殿(奥の院手前まで)は玉砂利をベースに、参道中央帯+本殿正面だけ
  // 石畳を上乗せする(実在の神社の「正中は石畳、左右は玉砂利」という作法を再現)。
  buildGroundMesh(23,PATH_MIN_Z,Z_SLOPE3_S,gravelTex,0);
  buildGroundMesh(10,Z_SLOPE3_S,PATH_MAX_Z,dirtMossTex,0); // 石段3〜奥の院: 土/苔混じり
  buildGroundMesh(1.6,PATH_MIN_Z,Z_SLOPE1_S,stonePathTex,0.01); // 参道中央の石畳帯
  buildGroundMesh(3.2,120,128,stonePathTex,0.01); // 本殿正面の石畳

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
  const CREDIT_TORII_ROW={name:'torii',author:'sugamo',license:'CC-BY',url:'https://poly.pizza/m/8ZgGY1XCfuR'};
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
  const CREDIT_FENCE_C={name:'Fence Center',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/I7D7zk30rv'};
  const CREDIT_SIGNPOST={name:'Signpost',author:'Kenney',license:'CC0',url:'https://poly.pizza/m/3U2lj1gpeH'};
  const CREDIT_STAIRS={name:'Stairs',author:'Kenney',license:'CC0',url:'https://poly.pizza/m/lZFtRSTeKR'};
  const CREDIT_DOOR={name:'Japanese Door',author:'Quaternius',license:'CC0',url:'https://poly.pizza/m/t4otyljz8K'};
  const CREDIT_HONDEN={name:'Shrine(本殿)',author:'つっちー',license:'商用利用・改変可(再配布不可)',url:'https://booth.pm/ja/items/2659982'};
  const CREDIT_CHOUZUYA={name:'手水舎',author:'つっちー',license:'商用利用・改変可(再配布不可)',url:'https://shoshinshaworks.booth.pm/items/2660016'};

  // --- 一の鳥居(目玉)+千本鳥居風の連続する小鳥居 ---
  const Z_HERO_TORII=2;
  colliders.push({type:'circle',x:-2.9,z:Z_HERO_TORII,r:0.3},{type:'circle',x:2.9,z:Z_HERO_TORII,r:0.3});
  placeStatic('models/torii_hero_free.glb',0,Z_HERO_TORII,5.6,{credit:CREDIT_TORII_HERO});
  const TORII_ROW_Z=[9,15,21,27,33,39,45];
  TORII_ROW_Z.forEach((z,i)=>{
    colliders.push({type:'circle',x:-2.4,z,r:0.25},{type:'circle',x:2.4,z,r:0.25});
    placeStatic('models/torii_row_free.glb',0,z,4.2,{credit:i===0?CREDIT_TORII_ROW:null});
  });
  // 各Tierの石段上り口にも1基ずつ(「登るたびに鳥居をくぐる」多層感の演出)
  [Z_SLOPE1_E+2, Z_SLOPE2_E+2].forEach(z=>{
    colliders.push({type:'circle',x:-2.2,z,r:0.25},{type:'circle',x:2.2,z,r:0.25});
    placeStatic('models/torii_row_free.glb',0,z,4.0,{});
  });

  // --- 石段(見た目の装飾。実際に乗って歩く面はgroundHeightAtの滑らかなスロープ) ---
  function placeStairDecor(zFrom,zTo,halfW){
    const len=zTo-zFrom;
    [-1,1].forEach(side=>{
      loadStaticGLB('models/stairs_free.glb').then(obj=>{
        normalizeToHeight(obj,(tierY(zTo)-tierY(zFrom))||1.2);
        obj.rotation.y=Math.PI/2;
        obj.scale.z*=len/1.34; // モデルの奥行き(登り方向)を区間長に合わせて引き伸ばす
        placeOnGround(obj,side*(halfW*0.55),(zFrom+zTo)/2);
        group.add(obj);
      }).catch(()=>{});
    });
  }
  placeStairDecor(Z_SLOPE1_S,Z_SLOPE1_E,HALFW_TIER0);
  placeStairDecor(Z_SLOPE2_S,Z_SLOPE2_E,HALFW_TIER1);
  pushCredit(CREDIT_STAIRS);

  // --- 手水舎(石段1を上りきった直後、本殿へ向かう前) ---
  let basinBulb=null, basinSwingT=0;
  {
    const x=4.2, z=66;
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

  // --- 石灯籠(参道〜境内に14基、単調にならぬよう2種を混在) ---
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
  const LANTERN_MODES=['lit','dark','dark','cold','lit','dark','dark','lit','cold','dark','lit','dark'];
  for(let i=0;i<12;i++){
    const z=68+i*2.4, side=i%2===0?-1:1;
    placeLantern(side*3.4,z,LANTERN_MODES[i],i%3===0);
  }

  // --- 御神木(境内広場、幹の胸の高さに注連縄+紙垂) ---
  {
    const x=-11, z=80;
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

  // --- 摂社/末社セット(祠+ミニ鳥居+ミニ灯籠2基、境内の2箇所) ---
  function placeSubShrineSet(x,z,shrineUrl,shrineH){
    placeStatic(shrineUrl,x,z,shrineH,{collider:true,colliderR:0.5});
    colliders.push({type:'circle',x,z:z-1.6,r:0.25});
    placeStatic('models/torii_row_free.glb',x,z-1.6,2.6,{});
    [[-0.7,0],[0.7,0]].forEach(([ox,oz])=>{
      placeLantern(x+ox,z-0.8+oz,'dark',true);
    });
  }
  placeSubShrineSet(-9,74,'models/shrine_small1_free.glb',1.9);
  placeSubShrineSet(-9,92,'models/shrine_small2_free.glb',2.4);
  pushCredit(CREDIT_SHRINE1); pushCredit(CREDIT_SHRINE2);

  // --- 池+太鼓橋(境内東側の寄り道、行き止まりのごほうび) ---
  {
    loadStaticGLB('models/bridge_free.glb').then(obj=>{
      normalizeToHeight(obj,1.6);
      placeOnGround(obj,POND_CX,POND_CZ);
      group.add(obj);
      pushCredit(CREDIT_BRIDGE);
    }).catch(()=>{});
    colliders.push({type:'box',minX:POND_CX-6.5,maxX:POND_CX-3.2,minZ:POND_CZ-1.4,maxZ:POND_CZ+1.4});
    colliders.push({type:'box',minX:POND_CX+3.2,maxX:POND_CX+6.5,minZ:POND_CZ-1.4,maxZ:POND_CZ+1.4});
    loadStaticGLB('models/signpost_free.glb').then(obj=>{
      normalizeToHeight(obj,1.1);
      obj.rotation.y=Math.PI/2;
      placeOnGround(obj,3.6,POND_Z0-1);
      group.add(obj);
      pushCredit(CREDIT_SIGNPOST);
    }).catch(()=>{});
  }

  // --- 本殿参道: 玉垣(低い柵)で囲われた区画、キツネの神使像+台座を対で配置 ---
  const Z_FOX=118;
  {
    const zFrom=107, zTo=132;
    [-1,1].forEach(side=>{
      const fx=side*HALFW_TIER2*0.72;
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
  const Z_HONDEN=140;
  let sensorLight=null, sensorLightOn=false, hallFrontZ=0;
  {
    const halfW=4.0, halfD=4.1;
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
    loadStaticGLB('models/shoji_door_free.glb').then(obj=>{
      normalizeToHeight(obj,2.1);
      centerXZ(obj);
      placeOnGround(obj,0,hallFrontZ+0.03);
      group.add(obj);
      pushCredit(CREDIT_DOOR);
    }).catch(()=>{});

    sensorLight=new THREE.SpotLight(0xfff0d0,0,11,THREE.MathUtils.degToRad(48),0.4,1.2);
    sensorLight.position.set(0,groundHeightAt(0,hallFrontZ)+3.3,hallFrontZ-0.3);
    sensorLight.target.position.set(0,groundHeightAt(0,hallFrontZ),hallFrontZ-4.5);
    scene.add(sensorLight); scene.add(sensorLight.target);
  }

  // --- しめ縄+木杭の禁足地境界(既存の実装をそのまま踏襲、座標のみ更新) ---
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
  buildForbiddenBoundary(Z_BOUNDARY,HALFW_TIER15-0.3);

  // --- 参道口の常夜灯(入口の雰囲気づくり、ちらつきはupdate()で処理) ---
  let entranceLight=null, entranceFlickerT=0;
  entranceLight=new THREE.PointLight(0xfff0c0,1.0,7,2);
  entranceLight.position.set(0,3.6,4);
  scene.add(entranceLight);

  // --- 杉の木・岩・茂み(拡張後の面積に合わせて増量、参道〜奥の院まで散布) ---
  function scatterProps(url,count,minDist,maxDist,zMin,zMax,targetHeight,opts){
    opts=opts||{};
    loadStaticGLB(url).then(template=>{
      normalizeToHeight(template,targetHeight);
      if(opts.centerXZ)centerXZ(template);
      for(let i=0;i<count;i++){
        const side=Math.random()<0.5?-1:1;
        const x=side*(minDist+Math.random()*(maxDist-minDist));
        const z=zMin+Math.random()*(zMax-zMin);
        const t=template.clone(true);
        const s=(opts.scaleMin||0.8)+Math.random()*((opts.scaleMax||1.3)-(opts.scaleMin||0.8));
        t.position.copy(template.position);
        placeOnGround(t,x,z);
        t.rotation.y=Math.random()*Math.PI*2;
        t.scale.multiplyScalar(s);
        group.add(t);
        if(opts.collider)colliders.push({type:'circle',x,z,r:(opts.colliderR||0.4)*s});
      }
      if(opts.credit)pushCredit(opts.credit);
    }).catch(()=>{});
  }
  scatterProps('models/pine_tree_free.glb',40,9.5,20,-2,Z_BOUNDARY-4,7,{collider:true,colliderR:0.35,scaleMin:0.8,scaleMax:1.5,credit:CREDIT_PINE});
  scatterProps('models/rock_free.glb',28,6.5,20,-2,Z_BOUNDARY-4,0.9,{collider:true,colliderR:0.45,scaleMin:0.7,scaleMax:1.6,credit:CREDIT_ROCK});
  scatterProps('models/bush_free.glb',20,7,20,-1,Z_BOUNDARY-4,1.1,{collider:false,scaleMin:0.6,scaleMax:1.0,centerXZ:true,credit:CREDIT_BUSH});

  buildBoundaryLines();

  // ================= 毎フレーム更新 =================
  function update(dt,charPos){
    entranceFlickerT+=dt;
    let v=0.85+Math.sin(entranceFlickerT*9)*0.08+Math.sin(entranceFlickerT*23)*0.05;
    if(Math.random()<0.015)v*=0.25;
    entranceLight.intensity=Math.max(0,v);

    basinSwingT+=dt;
    if(basinBulb){
      basinBulb.position.x=(4.2)+Math.sin(basinSwingT*1.3)*0.035;
      basinBulb.position.z=(66)+Math.cos(basinSwingT*0.9)*0.025;
    }

    const d=Math.hypot(charPos.x,charPos.z-hallFrontZ);
    sensorLightOn=d<6;
    sensorLight.intensity+=((sensorLightOn?1.7:0)-sensorLight.intensity)*Math.min(1,10*dt);
  }

  return {
    group,
    spawnPoint:{x:0,z:-3,yaw:0},
    zMin:PATH_MIN_Z, zMax:PATH_MAX_Z,
    corridorBoundsAt,
    groundHeightAt,
    update,
  };
}
};
})(window);
