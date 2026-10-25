// AgentDock 使用演示 —— three.js 场景
// ---------------------------------------------------------------------
// 设计要点：
//   * 所有画面都是 renderAt(t) 的纯函数（便于逐帧捕获，帧间无状态残留）
//   * LED 颜色/闪烁严格照抄 firmware/main/fx.c 的状态机
//   * 几何全部来自 CAD：外壳 STL + 参数化键帽/旋钮（prep_meshes.py）
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

import * as S from './script.js';
import * as overlay from './overlay.js';

const W = 1920, H = 1080;
const DPR = Number(new URLSearchParams(location.search).get('dpr') || 2);
const MM = 0.01;                       // 1 mm = 0.01 世界单位

/* ---------------- 数学小工具 ---------------- */
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (u) => { u = clamp(u); return u * u * (3 - 2 * u); };
const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3);
const easeOutBack = (u) => {
  u = clamp(u); const c = 1.6;
  return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2);
};
const DEG = Math.PI / 180;

/* ---------------- 器件坐标（mm，来自 pcb_report.json + 外壳装配） ---------------- */
const BOARD_DX = 2.0873, BOARD_DZ = 5.0;      // PCB 局部 → 世界
const KEYS = [
  { id: 1, x: 20.9550 + BOARD_DX, y: 11.43 + BOARD_DX, tint: 0xc44c33 },
  { id: 2, x: 41.6630 + BOARD_DX, y: 11.43 + BOARD_DX, tint: 0xb2ada2 },
  { id: 3, x: 62.3720 + BOARD_DX, y: 11.43 + BOARD_DX, tint: 0xb2ada2 },
];
const KNOB = { x: 80.8990 + BOARD_DX, y: 31.7460 + BOARD_DX };
const LED = { x: 35.3100 + BOARD_DX, y: 33.7800 + BOARD_DX };
const DEVICE_C = { x: 96.175 / 2, y: 47.175 / 2 };

const KEYCAP_Z = 17.50;      // 键帽底面（轴顶 17.54）
const KEYCAP_TRAVEL = 2.6;   // 演示行程（choc 全行程 3.0）
const KNOB_Z = 19.30;        // 旋钮裙边坐在顶盖 Ø13.6×0.8 沉台底
const KNOB_STEP = 15 * DEG;  // 每 detent 的转角（视觉用）

/* ==================== 渲染器 / 场景 ==================== */
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(DPR);
renderer.setSize(W, H);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070b);
scene.fog = new THREE.FogExp2(0x080c13, 0.30);

const camera = new THREE.PerspectiveCamera(28, W / H, 0.01, 40);

/* 环境光照（RoomEnvironment 提供柔和的塑料/金属反射） */
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envRT = pmrem.fromScene(new RoomEnvironment(), 0.02);
scene.environment = envRT.texture;
scene.environmentIntensity = 0.46;

/* 关键光：左前上方，负责轮廓与阴影 */
const key = new THREE.DirectionalLight(0xfff3e6, 2.05);
key.position.set(-0.75, -1.05, 2.3);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -0.9; key.shadow.camera.right = 0.9;
key.shadow.camera.top = 0.9; key.shadow.camera.bottom = -0.9;
key.shadow.camera.near = 0.05; key.shadow.camera.far = 6;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.006;
key.shadow.radius = 3.2;
scene.add(key, key.target);

/* 补光：右侧偏冷，压出蓝色塑料的层次 */
const fill = new THREE.DirectionalLight(0x9dbcff, 1.15);
fill.position.set(1.15, -1.75, 0.55);
scene.add(fill);

/* 逆光：勾出顶盖边缘 */
const rim = new THREE.DirectionalLight(0xffc79a, 1.55);
rim.position.set(0.85, 1.35, 0.85);
scene.add(rim);

const hemi = new THREE.HemisphereLight(0x27374a, 0x05070b, 0.40);
scene.add(hemi);

/* 地面：微微反光的暗色台面 + 一圈光池 */
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x0b1017, roughness: 0.42, metalness: 0.5, envMapIntensity: 0.5,
});
const floor = new THREE.Mesh(new THREE.CircleGeometry(9, 96), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.z = -0.0015;
floor.receiveShadow = true;
scene.add(floor);

function radialTexture(stops, size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const pool = new THREE.Mesh(
  new THREE.PlaneGeometry(3.6, 3.6),
  new THREE.MeshBasicMaterial({
    map: radialTexture([[0, 'rgba(132,178,255,0.22)'], [0.30, 'rgba(70,104,190,0.10)'], [1, 'rgba(0,0,0,0)']]),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9,
  }),
);
pool.position.z = 0.0008;
scene.add(pool);

/* 环形贴图（按键涟漪 / 声波） */
const ringTex = radialTexture([
  [0.00, 'rgba(255,255,255,0)'], [0.62, 'rgba(255,255,255,0)'],
  [0.80, 'rgba(255,255,255,0.95)'], [0.90, 'rgba(255,255,255,0.35)'], [1.00, 'rgba(255,255,255,0)'],
], 256);

/* ==================== 器件装配 ==================== */
const device = new THREE.Group();            // mm 坐标，整体缩放到世界
device.scale.setScalar(MM);
device.position.set(-DEVICE_C.x * MM, -DEVICE_C.y * MM, 0);
scene.add(device);

const keycaps = new Map();
let knobMesh = null;
let ledPipeMat = null, ledLight = null, ledHalo = null;
const pressRings = [];
const soundWaves = [];

function mat(opts) { return new THREE.MeshStandardMaterial(opts); }

const M = {
  base: mat({ color: 0xe0631f, roughness: 0.62, metalness: 0.0, envMapIntensity: 0.75 }),
  lid: mat({ color: 0x2b5591, roughness: 0.58, metalness: 0.0, envMapIntensity: 0.8 }),
  pcb: mat({ color: 0x1d6b3c, roughness: 0.72, metalness: 0.0, envMapIntensity: 0.5 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.24, metalness: 1.0, envMapIntensity: 1.35 }),
};

const loader = new STLLoader();
async function loadSTL(url, material, name) {
  const geo = await loader.loadAsync(url);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 把 PCB 几何里"编码器轴"那段三角形拆出来（板色 → 金属） */
function splitEncoderShaft(geo) {
  const pos = geo.attributes.position;
  const nTri = pos.count / 3;
  const keep = [], shaft = [];
  const cx = KNOB.x, cy = KNOB.y, r2 = 4.2 * 4.2;
  for (let i = 0; i < nTri; i++) {
    const o = i * 9;
    const x = (pos.array[o] + pos.array[o + 3] + pos.array[o + 6]) / 3;
    const y = (pos.array[o + 1] + pos.array[o + 4] + pos.array[o + 7]) / 3;
    const z = (pos.array[o + 2] + pos.array[o + 5] + pos.array[o + 8]) / 3;
    const isShaft = z > 15.7 && (x - cx) * (x - cx) + (y - cy) * (y - cy) < r2;
    (isShaft ? shaft : keep).push(i);
  }
  const pick = (list) => {
    const arr = new Float32Array(list.length * 9);
    let k = 0;
    for (const i of list) {
      const o = i * 9;
      for (let j = 0; j < 9; j++) arr[k++] = pos.array[o + j];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  };
  const rest = pick(keep);
  geo.setAttribute('position', rest.attributes.position);
  geo.setAttribute('normal', rest.attributes.normal);
  const shaftGeo = pick(shaft);
  // EC11 轴实测低于旋钮顶面，视觉上会把 Ø6 孔变成黑洞；把轴的端点抬到顶面下 0.6 mm
  shaftGeo.computeBoundingBox();
  const dz = (KNOB_Z + 6.5 - 0.6) - shaftGeo.boundingBox.max.z;
  if (Number.isFinite(dz) && Math.abs(dz) < 14) {
    shaftGeo.translate(0, 0, dz);
    shaftGeo.computeBoundingBox();
  }
  return [shaftGeo];
}

async function buildDevice() {
  const [base, lid, pcb, capGeo, knobGeo] = await Promise.all([
    loadSTL('/assets/base.stl', M.base, 'base'),
    loadSTL('/assets/lid.stl', M.lid, 'lid'),
    loadSTL('/assets/pcb.stl', M.pcb, 'pcb'),
    loader.loadAsync('/assets/keycap.stl'),
    loader.loadAsync('/assets/knob.stl'),
  ]);
  device.add(base, lid);

  // PCB 的 STEP 里含 EC11 金属轴，但它跟着板子被涂绿了；
  // 把这根轴（旋钮底孔里能看到的那段）拆出来换成金属材质。
  const shafts = splitEncoderShaft(pcb.geometry);
  device.add(pcb);
  for (const g of shafts) {
    const m = new THREE.Mesh(g, M.metal);
    m.castShadow = true; m.receiveShadow = true;
    device.add(m);
  }
  capGeo.computeVertexNormals();
  knobGeo.computeVertexNormals();

  // 键帽（外壳模型里没有配件，按 1u choc 参数化补上）
  for (const k of KEYS) {
    const cap = new THREE.Mesh(capGeo, mat({
      color: k.tint, roughness: 0.58, metalness: 0.0, envMapIntensity: 0.62,
      emissive: new THREE.Color(k.tint), emissiveIntensity: 0,
    }));
    cap.position.set(k.x, k.y, KEYCAP_Z);
    cap.castShadow = true; cap.receiveShadow = true;
    cap.name = `keycap${k.id}`;
    device.add(cap);
    keycaps.set(k.id, cap);

    // 按下去时从键窗边缘扩散的光环
    const ring = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: ringTex, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, color: 0x9fe4ff, opacity: 0,
      }),
    );
    ring.position.set(k.x, k.y, 20.20);
    ring.scale.set(17, 17, 1);
    device.add(ring);
    pressRings[k.id] = ring;
  }

  // 旋钮
  knobMesh = new THREE.Mesh(knobGeo, M.metal);
  knobMesh.position.set(KNOB.x, KNOB.y, KNOB_Z);
  knobMesh.castShadow = true; knobMesh.receiveShadow = true;
  knobMesh.name = 'knob';
  device.add(knobMesh);

  // 导光柱：填满顶盖 Ø3.4 出光孔，顶端略高于顶面（20.1）
  ledPipeMat = new THREE.MeshStandardMaterial({
    color: 0x243444, emissive: new THREE.Color(0x000000), emissiveIntensity: 1,
    roughness: 0.46, metalness: 0.0, envMapIntensity: 0.4,
  });
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(1.68, 1.70, 1.55, 44), ledPipeMat);
  pipe.position.set(LED.x, LED.y, 19.32);
  device.add(pipe);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.7, 44, 20, 0, Math.PI * 2, 0, Math.PI / 2),
                              ledPipeMat);
  dome.position.set(LED.x, LED.y, 20.06);
  dome.scale.z = 0.22;
  device.add(dome);


  // LED 照亮周边顶盖
  ledLight = new THREE.PointLight(0x4488ff, 0.0, 0.10, 2.0);
  ledLight.position.set((LED.x - DEVICE_C.x) * MM, (LED.y - DEVICE_C.y) * MM, 0.262);
  scene.add(ledLight);

  // LED 光晕（相机朝向的 sprite）
  ledHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(255,255,255,0.9)'], [0.25, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']], 256),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.0,
  }));
  ledHalo.position.copy(ledLight.position).setZ(0.208);
  ledHalo.scale.setScalar(0.075);
  scene.add(ledHalo);

  // 蜂鸣器声波：+X 端面外侧三圈
  for (let i = 0; i < 3; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, opacity: 0, color: 0xffd9b0,
    }));
    sp.center.set(1.0, 0.5);       // 让圆环从器件边缘向外扩，而不是向两侧膨胀
    sp.position.set(0.985, (12.0 - DEVICE_C.y) * MM, 0.115);
    sp.scale.setScalar(0.05);
    scene.add(sp);
    soundWaves.push(sp);
  }
}

/* ==================== LED 状态机（照抄 fx.c） ==================== */
const LED_TICK = 0.1;
const BREATH = [4, 8, 14, 20, 24, 26, 24, 20, 14, 8];   // 10 步阶梯，2 s 周期
const LED_GAIN = 3.4;                                    // 让 40/255 的暗灯在镜头里读得出来

function stateAt(t) {
  let st = 'offline', since = -1e9;
  for (const s of S.STATES) if (t >= s.t) { st = s.st; since = s.t; }
  return { st, since };
}

/** 返回 [r,g,b]（0–255 的 WS2812 值） */
function ledRGB(t, st, since) {
  const dt = t - since;
  switch (st) {
    case 'idle': return [0, 0, 40];
    case 'busy': {
      const phase = Math.floor(dt / LED_TICK) % 10;
      const k = BREATH[((phase % 10) + 10) % 10] / 32;
      return [0, Math.round(40 * k), 0];
    }
    case 'done': {   // 4 次翻转 = 双闪，之后回 idle
      const phase = Math.floor(dt / LED_TICK);
      if (phase >= 4) return [0, 0, 40];
      return phase % 2 === 0 ? [40, 40, 40] : [0, 0, 40];
    }
    case 'error': {  // 6 次翻转 = 三连闪
      const phase = Math.floor(dt / LED_TICK);
      if (phase >= 6) return [0, 0, 40];
      return phase % 2 === 0 ? [40, 0, 0] : [0, 0, 40];
    }
    default: {       // offline: 1 s 周期心跳，前 200 ms 微亮
      const phase = Math.floor(dt / LED_TICK) % 10;
      return [0, 0, phase < 2 ? 6 : 0];
    }
  }
}

/* ==================== 按键 / 旋钮动作 ==================== */
function pressAmount(t, id) {
  let d = 0;
  for (const p of S.PRESSES) {
    if (p.id !== id) continue;
    const down = easeOut((t - p.down) / 0.055);
    const up = easeOut((t - p.up) / 0.10);
    const amt = clamp(down - up);
    if (t >= p.down) d = Math.max(d, amt);
  }
  return d;                      // 0 → 1
}

function knobAngle(t) {
  let a = 0;
  for (const e of S.ENCODER) a += e.v * KNOB_STEP * easeOut((t - e.t) / 0.13);
  return a;
}

/* ==================== 相机编排 ==================== */
// az/el 单位度，d 单位世界单位，lat = 相机横向偏移（让器件偏左，给端子留位置）
// 所有机位统一退远：器件在画面里占比更小，留白更好看
const CAM_ZOOM = 1.19;

const SHOTS = [
  // 序：推近，器件偏左给右侧端子留位（d × CAM_ZOOM 生效，下面的 d 都是"退远前"的值）
  { t: 0.0,  az: -106, el: 25, d: 2.08, lat: 0.10, tx: 0.02, ty: 0, tz: 0.065 },
  { t: 1.6,  az: -103, el: 27, d: 2.12, lat: 0.13, tx: 0.02, ty: 0, tz: 0.062 },
  { t: 5.0,  az: -100, el: 29, d: 1.98, lat: 0.15, tx: 0, ty: 0, tz: 0.062 },
  { t: 6.8,  az: -97,  el: 33, d: 1.82, lat: 0.15, tx: 0, ty: 0, tz: 0.060 },
  // 控件巡览：俯视讲四个输入
  { t: 8.2,  az: -100, el: 55, d: 1.68, lat: 0.14, tx: 0, ty: 0, tz: 0.066 },
  { t: 10.1, az: -98,  el: 36, d: 1.76, lat: 0.15, tx: 0, ty: 0, tz: 0.060 },
  // 运行中：KEY2 特写（三个键 + 灯都在画面里）
  { t: 13.6, az: -90,  el: 34, d: 1.50, lat: 0.15, tx: -0.02, ty: -0.01, tz: 0.062 },
  { t: 14.5, az: -86,  el: 36, d: 1.46, lat: 0.15, tx: -0.03, ty: -0.015, tz: 0.064 },
  { t: 17.0, az: -85,  el: 36, d: 1.46, lat: 0.15, tx: -0.03, ty: -0.015, tz: 0.064 },
  // 旋钮特写
  { t: 18.0, az: -56,  el: 42, d: 1.26, lat: 0.10, tx: 0.285, ty: 0.050, tz: 0.190 },
  { t: 19.95, az: -62, el: 44, d: 1.30, lat: 0.09, tx: 0.278, ty: 0.045, tz: 0.185 },
  // 完成：快速拉回看整机双闪（0.5 s 的“甩镜”，情绪转折）
  { t: 20.45, az: -78, el: 36, d: 1.74, lat: 0.15, tx: 0.02, ty: 0, tz: 0.066 },
  { t: 21.6,  az: -73, el: 34, d: 1.66, lat: 0.15, tx: 0.03, ty: 0, tz: 0.066 },
  { t: 23.4, az: -80,  el: 34, d: 1.54, lat: 0.15, tx: 0.06, ty: -0.015, tz: 0.064 },
  { t: 23.9, az: -82,  el: 34, d: 1.52, lat: 0.15, tx: 0.065, ty: -0.015, tz: 0.064 },
  // KEY1：长按静音 → 短按中断
  { t: 26.8, az: -92,  el: 34, d: 1.56, lat: 0.19, tx: -0.14, ty: -0.015, tz: 0.064 },
  { t: 30.2, az: -93,  el: 34, d: 1.56, lat: 0.19, tx: -0.14, ty: -0.015, tz: 0.064 },
  // 中断后拉开
  { t: 31.3, az: -88,  el: 32, d: 1.78, lat: 0.14, tx: -0.01, ty: 0, tz: 0.062 },
  { t: 33.5, az: -99,  el: 28, d: 2.06, lat: 0.13, tx: 0, ty: 0, tz: 0.055 },
  { t: 37.4, az: -91,  el: 26, d: 2.10, lat: 0.13, tx: 0, ty: 0, tz: 0.055 },
];

function cameraAt(t) {
  let i = 0;
  while (i < SHOTS.length - 2 && t >= SHOTS[i + 1].t) i++;
  const a = SHOTS[i], b = SHOTS[i + 1];
  const u = smooth((t - a.t) / Math.max(1e-6, b.t - a.t));
  const az = lerp(a.az, b.az, u) + 0.9 * Math.sin(t * 0.31);
  const el = lerp(a.el, b.el, u) + 0.5 * Math.sin(t * 0.47 + 1.1);
  const d = (lerp(a.d, b.d, u) + 0.012 * Math.sin(t * 0.9 + 0.4)) * CAM_ZOOM;
  const lat = lerp(a.lat, b.lat, u);
  const tx = lerp(a.tx, b.tx, u) + 0.004 * Math.sin(t * 0.63 + 2.0);
  const ty = lerp(a.ty, b.ty, u);
  const tz = lerp(a.tz, b.tz, u);

  const target = new THREE.Vector3(tx, ty, tz);
  const p = new THREE.Vector3(
    Math.cos(el * DEG) * Math.cos(az * DEG),
    Math.cos(el * DEG) * Math.sin(az * DEG),
    Math.sin(el * DEG),
  ).multiplyScalar(d).add(target);

  camera.position.copy(p);
  camera.lookAt(target);
  camera.translateX(lat);      // 让器件在画面里偏左
  camera.updateMatrixWorld();
  return { target };
}

/* 世界坐标（mm，器件局部）→ 屏幕像素 */
const _v = new THREE.Vector3();
function project(xmm, ymm, zmm) {
  _v.set(xmm, ymm, zmm);
  device.localToWorld(_v);
  _v.project(camera);
  return { x: (_v.x * 0.5 + 0.5) * W, y: (-_v.y * 0.5 + 0.5) * H };
}

/* ==================== 后期 ==================== */
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(W * DPR, H * DPR, { type: THREE.HalfFloatType, samples: 4 }),
);
composer.setPixelRatio(DPR);
composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.40, 0.34, 0.90);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const gradePass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, uFade: { value: 1 }, uTime: { value: 0 },
    uVignette: { value: 1.0 }, uGrain: { value: 0.011 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uFade, uTime, uVignette, uGrain;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = smoothstep(1.02, 0.30, length(d * vec2(1.06, 1.0)));
      c.rgb *= mix(1.0, v, uVignette);
      float g = hash(vUv * vec2(1920.0, 1080.0) + uTime) - 0.5;
      c.rgb += g * uGrain;
      c.rgb *= uFade;
      gl_FragColor = c;
    }`,
});
composer.addPass(gradePass);

/* ==================== 每帧更新 ==================== */
const ledColor = new THREE.Color();

function updateLED(t) {
  const { st, since } = stateAt(t);
  const [r, g, b] = ledRGB(t, st, since);
  ledColor.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  const lum = Math.max(r, g, b) / 255;
  // 关键：把亮度归一化到"能过 bloom 阈值"，但保持色相（否则蓝/绿会被白洗掉）
  const peak = Math.max(ledColor.r, ledColor.g, ledColor.b, 1e-4);
  const gain = 1.35 + 1.45 * lum;
  const norm = ledColor.clone().multiplyScalar(gain / peak);
  ledPipeMat.emissive.copy(norm);
  ledPipeMat.emissiveIntensity = 1.0;
  ledLight.color.copy(ledColor).multiplyScalar(1 / peak);
  ledLight.intensity = 0.03 + 0.95 * lum;
  ledHalo.material.color.copy(ledColor).multiplyScalar(1 / peak);
  ledHalo.material.opacity = clamp(lum * 1.6 + 0.07);
  ledHalo.scale.setScalar(0.050 + 0.085 * lum);
  return { st, since, rgb: [r, g, b] };
}

/* 蜂鸣器音符表（绝对时间），同时驱动声波涟漪 */
let noteTable = [];
function buildNotes() {
  noteTable = S.SOUNDS.map((s) => ({ ...s, notes: S.parseRtttl(S.MELODIES[s.name], s.t) }));
}

function updateSoundWaves(t) {
  let active = null;
  for (const s of noteTable) {
    const last = s.notes[s.notes.length - 1];
    if (last && t >= s.t && t <= last.t + last.dur + 0.05) active = s;
  }
  const muted = S.MUTE.some((m) => m.on && t >= m.t) ? 1 : 0;
  for (let i = 0; i < soundWaves.length; i++) {
    const sp = soundWaves[i];
    if (!active || muted) { sp.material.opacity = 0; continue; }
    const note = active.notes.find((n) => t >= n.t && t < n.t + n.dur);
    if (!note || note.f === 0) { sp.material.opacity = 0; continue; }
    const p = (t - note.t) / note.dur;
    const ph = clamp(p - i * 0.22);
    sp.material.opacity = ph > 0.001 ? (1 - ph) * 0.55 : 0;
    const r = 0.02 + 0.075 * easeOut(ph);
    sp.scale.set(r, r, 1);
  }
}

function updateParts(t) {
  for (const k of KEYS) {
    const cap = keycaps.get(k.id);
    const amt = pressAmount(t, k.id);
    cap.position.z = KEYCAP_Z - amt * KEYCAP_TRAVEL;
    cap.material.emissiveIntensity = amt * 0.06;

    // 按下瞬间的扩散光环
    const p = S.PRESSES.filter((q) => q.id === k.id && t >= q.down)
      .map((q) => (t - q.down) / 0.45).filter((u) => u < 1).pop();
    const ring = pressRings[k.id];
    if (p !== undefined) {
      ring.material.opacity = (1 - p) * (1 - p) * 0.45;
      const s = 17 + 22 * easeOut(p);
      ring.scale.set(s, s, 1);
    } else {
      ring.material.opacity = 0;
    }
  }
  if (knobMesh) knobMesh.rotation.z = knobAngle(t);
}

function updateAtmosphere(t) {
  // 地面光池随器件移动（器件固定，光池轻微呼吸即可）
  pool.material.opacity = 0.55 + 0.08 * Math.sin(t * 0.6);
  // 片头/片尾黑场
  const fadeIn = smooth(t / 0.9);
  const fadeOut = 1 - smooth((t - 35.9) / 1.1);
  gradePass.uniforms.uFade.value = Math.min(fadeIn, fadeOut);
  gradePass.uniforms.uTime.value = t;
}

export function renderAt(t) {
  cameraAt(t);
  const led = updateLED(t);
  updateParts(t);
  updateSoundWaves(t);
  updateAtmosphere(t);

  // 传给 DOM 叠加层：屏幕坐标 + 状态
  const center = project(DEVICE_C.x, DEVICE_C.y, 22);
  const anchors = {
    key1: project(KEYS[0].x, KEYS[0].y, 22.6),
    key2: project(KEYS[1].x, KEYS[1].y, 22.6),
    key3: project(KEYS[2].x, KEYS[2].y, 22.6),
    knob: project(KNOB.x, KNOB.y, 26.9),
    led: project(LED.x, LED.y, 20.2),
    center,
  };
  overlay.update(t, { anchors, state: led.st, deviceCenter: center });

  composer.render();
}

/* ==================== 音频事件（供 audio.py 合成） ==================== */
export function audioEvents() {
  const ev = [];
  for (const s of noteTable) {
    ev.push({
      type: 'melody', name: s.name, t: s.t,
      notes: s.notes.map((n) => ({ t: +n.t.toFixed(4), dur: +n.dur.toFixed(4), f: Math.round(n.f) })),
    });
  }
  for (const p of S.PRESSES) ev.push({ type: 'click', t: p.down, id: p.id });
  for (const e of S.ENCODER) ev.push({ type: 'tick', t: e.t, v: e.v });
  return { duration: S.DURATION, sampleRate: 48000, mutedFrom: S.MUTE[0]?.t ?? null, events: ev };
}

/* ==================== 启动 ==================== */
async function boot() {
  await buildDevice();
  buildNotes();
  await overlay.init();
  key.target.position.set(0, 0, 0.1);
  renderAt(0);
  window.__renderAt = renderAt;
  window.__audioEvents = audioEvents;
  window.__duration = S.DURATION;
  window.__ready = true;
  window.__dbg = { scene, device, camera, renderer, ledLight, ledHalo, ledPipeMat };
}

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend',
    `<pre style="position:absolute;left:20px;top:20px;color:#f88;z-index:9">${e?.stack || e}</pre>`);
});
