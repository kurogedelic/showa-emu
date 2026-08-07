'use strict';
// ---------------------------------------------------------------------------
// 3D モード: 畳の部屋に CRT テレビを置き、エミュレータ画面をブラウン管に映す。
// 2D UI はそのまま残し、中央のステージだけを 3D に差し替える。
// assets/models/*.glb があれば仮モデルと差し替えて読み込む (README 参照)。
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as CANNON from './vendor/cannon-es.js';
import { createCables } from './cables.js';
import { createRoach, createLeak, createCan, createTarai } from './props.js';
import { sfx } from './sfx.js';

const MODEL_DIR = './assets/models/';
// 差し替え可能なモデル: ファイル名 -> 仮モデルのプレースホルダ名
const MODELS = ['room', 'crt', 'famicom', 'cassette'];

const wrap = document.getElementById('screen-wrap');
const srcCanvas = document.getElementById('screen');
const cartSlider = document.getElementById('cart-tilt');

let renderer, scene, camera, controls, screenTex, screenMesh;
let cassetteGroup, running = false, started = false;
let standItem = null, crtItem = null, famItem = null, cartItem = null, convItem = null, canItem = null;
let cables = null, roach = null, leak = null, can = null, tarai = null, taraiItem = null;
const roaches = [];
const ROACH_MAX = 16;

// ボタンを押すたびに 1 匹ずつ増やす
function spawnRoach() {
  if (!scene) return;
  let r = roaches.find((x) => !x.state.alive);
  if (!r) {
    if (roaches.length >= ROACH_MAX) r = roaches[0];
    else {
      r = createRoach(scene, { w: ROOM_W, d: ROOM_D });
      r.state.enabled = false;        // 勝手に湧くのは 1 匹目だけ
      roaches.push(r);
    }
  }
  r.state.alive = false;
  r.summon();
}
let convGame = true;      // RF コンバータのスイッチ: true = ゲーム / false = TV
let juiceFault = 0;       // ジュースをかぶった度合い (0..1)
let shock = 0;            // テレビが受けた衝撃 (画面が歪んで戻る)
let bump = 0;             // 本体が受けた衝撃 (接点が跳ねてバグる)

// 衝撃を拾う。ぶつかった速度が大きいほど大きく揺れる
function watchImpacts(item, onHit) {
  item.body.addEventListener('collide', (e) => {
    const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (v > 0.35) { onHit(Math.min(1, v / 3.5)); sfx.thud(Math.min(1, v / 3.5)); }
  });
}
const placeholders = {};   // name -> Group (glTF で差し替えられる)

// ---------------------------------------------------------------- テクスチャ生成
function tatamiTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#c9c18a';
  g.fillRect(0, 0, 256, 256);
  // い草の織り目 (長辺と平行に走る)
  g.strokeStyle = 'rgba(120, 116, 70, 0.35)';
  g.lineWidth = 1;
  for (let y = 2; y < 256; y += 3) {
    g.beginPath();
    g.moveTo(0, y + Math.sin(y) * 0.5);
    g.lineTo(256, y + Math.cos(y) * 0.5);
    g.stroke();
  }
  // 畳縁 (へり) — 長辺の両側
  g.fillStyle = '#2f3b2a';
  g.fillRect(0, 0, 256, 9);
  g.fillRect(0, 247, 256, 9);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function wallTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ded6c3';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2400; i++) {
    g.fillStyle = `rgba(150,140,120,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}

// ------------------------------------------------- CRT / UHF シェーダー
// 走査線・アパーチャグリル・にじみ(色副搬送波)・ゴースト(多重反射)・砂嵐・
// 同期の乱れ・ビネット。「電波の悪さ」は端子の接触状態(カセットの傾き)に連動する。
const CRT_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CRT_FRAG = `
uniform sampler2D map;    // エミュレータ画面 + OSD の合成
uniform vec2  res;        // 元画像の解像度 (256x240)
uniform float time;
uniform float amount;     // 0 = 素通し, 1 = フルCRT
uniform float signalQ;    // 1 = 良好, 0 = 電波が最悪
uniform float detune;     // 同調ずれ -1..1
uniform float power;      // 0 = テレビの電源が来ていない
uniform float carrier;    // 0 = RF が来ていない (完全な砂嵐)
uniform float shock;      // 衝撃 (叩いた/落とした) 0..1
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// RGB <-> YIQ (NTSC のコンポジット信号を作るため)
vec3 rgb2yiq(vec3 c) {
  return vec3(
    dot(c, vec3(0.299, 0.587, 0.114)),
    dot(c, vec3(0.5959, -0.2746, -0.3213)),
    dot(c, vec3(0.2115, -0.5227, 0.3112)));
}
vec3 yiq2rgb(vec3 c) {
  return vec3(
    c.x + 0.956 * c.y + 0.619 * c.z,
    c.x - 0.272 * c.y - 0.647 * c.z,
    c.x - 1.106 * c.y + 1.703 * c.z);
}

// 画面 (OSD は合成済みのキャンバスから来るので、OSD もブラウン管を通る)
vec3 srcAt(vec2 uv) {
  return texture2D(map, uv).rgb;
}

// NTSC コンポジットのエンコード -> 復調。
// Y/C が完全に分離できないので色がにじみ、エッジにドットクロール(虹)が出る。
const float SUBC = 4.18879;   // 1 画素あたりの色副搬送波の位相 (2/3 周期)

// phaseErr = バースト位相の読み違い (同調ずれ・ノイズ) -> 色が転ぶ
vec3 ntscDecode(vec2 uv, float phaseErr) {
  float px = uv.x * res.x;
  float line = floor(uv.y * res.y);
  float frame = floor(time * 60.0);
  float base = line * 2.0943951 + frame * 3.1415926;
  float i = 0.0, q = 0.0, w = 0.0, compC = 0.0;
  for (int k = -3; k <= 3; k++) {
    float fk = float(k);
    float weight = 1.0 - abs(fk) * 0.18;
    vec3 yiq = rgb2yiq(srcAt(uv + vec2(fk / res.x, 0.0)));
    float ph = (px + fk) * SUBC + base;          // 変調 (エンコード側)
    float dph = ph + phaseErr;                   // 復調 (受信側の基準位相)
    float comp = yiq.x + yiq.y * sin(ph) + yiq.z * cos(ph);
    if (k == 0) compC = comp;
    i += comp * sin(dph) * weight;                // 色だけ帯域を絞る
    q += comp * cos(dph) * weight;
    w += weight;
  }
  i = 2.0 * i / w;
  q = 2.0 * q / w;
  // 輝度は中心のコンポジットから色成分を引き算して取り出す (くし形フィルタ相当)。
  // 平均を取らないので、輝度の解像度が落ちない = ボケない。
  float phc = px * SUBC + base + phaseErr;
  float y = compC - (i * sin(phc) + q * cos(phc)) * 0.7;
  return yiq2rgb(vec3(y, i, q));
}

void main() {
  vec2 c = vUv * 2.0 - 1.0;
  if (power < 0.5) {              // 電源が来ていない = 真っ暗なガラス
    gl_FragColor = vec4(vec3(0.008), 1.0);
    #include <colorspace_fragment>
    return;
  }
  float bad = (1.0 - signalQ) * amount;

  // バレル歪み。ジオメトリ側でも球面にしているので、ここは軽く効かせるだけ
  vec2 uv = c * (1.0 + 0.012 * amount * dot(c, c) * vec2(1.0, 1.1));
  uv = uv * 0.5 + 0.5;

  // 衝撃: 画面が波打って、縦の同期も一瞬ずれる (すぐ戻る)
  if (shock > 0.001) {
    uv.x += sin(uv.y * 46.0 + time * 55.0) * 0.045 * shock;
    uv.y += sin(uv.x * 18.0 + time * 37.0) * 0.012 * shock;
    uv.y = fract(uv.y + shock * 0.25 * sin(time * 9.0));
    uv = (uv - 0.5) * (1.0 + 0.05 * shock * sin(time * 24.0)) + 0.5;
  }

  // 水平同期の乱れ + 上下に流れるノイズバンド
  float band = smoothstep(0.10, 0.0, abs(fract(vUv.y * 0.5 + time * 0.11) - 0.5));
  uv.x += (hash(vec2(floor(uv.y * res.y), floor(time * 24.0))) - 0.5) * 0.035 * bad;
  uv.x += band * 0.02 * bad;
  uv.y += band * 0.004 * bad;

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    #include <colorspace_fragment>
    return;
  }

  vec3 col;
  if (carrier < 0.5) {
    // --- 電波が来ていない: 完全な砂嵐 (映像は一切出さない) ---
    float sn = hash(floor(uv * res * vec2(1.7, 1.0)) + floor(time * 60.0) * 7.3);
    float sn2 = hash(floor(uv * res * 0.6) + floor(time * 60.0) * 3.1);
    col = vec3(0.12 + sn * 0.85) * (0.75 + 0.35 * sn2);
    // たまに横に流れるノイズバンド
    float band = smoothstep(0.06, 0.0, abs(fract(vUv.y * 0.7 + time * 0.6) - 0.5));
    col += band * 0.25 * sn;
    col *= 0.72;
  } else {
    // --- コンポジット復調 ---
    // 同調がずれるとバースト位相がずれて色が転ぶ
    float phaseErr = detune * 2.5 + (hash(vec2(floor(uv.y * res.y), floor(time * 20.0))) - 0.5) * bad * 3.0;
    col = mix(srcAt(uv), ntscDecode(uv, phaseErr), clamp(amount, 0.0, 1.0));

    // 色が抜ける (S/N が悪いとカラーキラーが働く)
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum), bad * 0.55);

    // ゴースト (アンテナの多重反射)
    col += srcAt(uv + vec2(0.016, 0.0)) * 0.18 * bad;
  }

  // 走査線
  float sl = 0.5 + 0.5 * cos(uv.y * res.y * 6.2831853);
  col *= 1.0 - 0.30 * amount * sl;

  // アパーチャグリル (RGB の縦ストライプ)。細かすぎるとモアレでボケるので 1画素 = 1組
  float m = mod(floor(vUv.x * res.x * 1.5), 3.0);
  vec3 mask = vec3(step(m, 0.5), step(abs(m - 1.0), 0.5), step(1.5, m));
  col *= mix(vec3(1.0), 0.85 + 0.45 * mask, amount * 0.7);

  // 蛍光体のにじみ (明るいところが太る)
  col += col * col * 0.35 * amount;

  // 砂嵐 (UHF のスノーノイズ)
  float sn = hash(floor(uv * res * 1.5) + floor(time * 45.0));
  col += (sn - 0.5) * (0.05 * amount + 0.55 * bad);

  // ビネット + わずかな明滅
  float v = smoothstep(1.45, 0.35, length(c));
  col *= mix(1.0, v, amount * 0.85);
  col *= 1.0 + 0.02 * amount * sin(time * 37.0);

  // 走査線で暗くなった分を戻す
  col *= 1.0 + 0.35 * amount;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
  #include <colorspace_fragment>
}`;

// -------------------------------------------------- 画面内 OSD (RF デコーダ風)
// famicom-rf-hackrf-decoder の画面にならって、左上に CH 表示、右上に黄色の
// 同期ステータス / FPS / キャリア周波数 / 遅延を出す。OSD もブラウン管を通る。
// 画面 (256x240) を 2 倍に拡大したキャンバスに OSD を重ね、それをテクスチャにする。
// こうすると OSD も NTSC 復調・走査線・歪みを通るので「受信した映像」に見える。
const FEED_W = 512, FEED_H = 480;
const feedCanvas = document.createElement('canvas');
feedCanvas.width = FEED_W;
feedCanvas.height = FEED_H;
const osdCtx = feedCanvas.getContext('2d');
osdCtx.imageSmoothingEnabled = false;

const VIDEO_CARRIER = 91.25;   // CH1 映像キャリア (MHz)
const AUDIO_CARRIER = 95.75;   // CH1 音声キャリア (MHz)
let osdOn = true;

function drawOsd(q, fps) {
  const g = osdCtx;
  g.drawImage(srcCanvas, 0, 0, FEED_W, FEED_H);
  if (!osdOn) { if (screenTex) screenTex.needsUpdate = true; return; }
  const off = detuneVal() * 0.9;                 // 同調ずれ (MHz)
  const lock = q > 0.55, hlock = q > 0.3;
  g.font = 'bold 16px ui-monospace, Menlo, monospace';
  g.textBaseline = 'top';
  g.lineJoin = 'round';

  // 左上: レトロTV 風のチャンネル表示
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  g.lineWidth = 4;
  g.strokeRect(16, 16, 60, 28);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 2;
  g.strokeRect(16, 16, 60, 28);
  const label = (s, x, y, col) => {
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.lineWidth = 4;
    g.strokeText(s, x, y);
    g.fillStyle = col;
    g.fillText(s, x, y);
  };
  label('CH1', 27, 22, '#ffffff');

  // 右上: 黄色のステータス (V-SYNC / FPS / キャリア / 遅延)
  g.textAlign = 'right';
  const lines = [
    `V-SYNC:${lock ? 'OK' : 'LOST'} H-SYNC:${hlock ? 'OK' : 'UNLOCK'}`,
    // 表示は「受信できている映像」のフレームレート (NTSC 59.94 が上限)
    `${(Math.min(fps, 59.94) * (0.75 + 0.25 * q)).toFixed(1)}FPS`,
    `VHF:${(VIDEO_CARRIER + off).toFixed(2)}MHz AUD:${(AUDIO_CARRIER + off).toFixed(2)}MHz`,
    `DELAY V:${Math.round(20 + (1 - q) * 40)}ms A:${Math.round(60 + (1 - q) * 60)}ms`,
  ];
  lines.forEach((s, i) => label(s, 496, 18 + i * 20, lock ? '#ffe14b' : '#ff8c4b'));
  g.textAlign = 'left';
  if (screenTex) screenTex.needsUpdate = true;
}

let screenMat = null;
function makeScreenMaterial() {
  screenMat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: screenTex },
      res: { value: new THREE.Vector2(256, 240) },
      time: { value: 0 },
      amount: { value: crtAmount() },
      signalQ: { value: 1 },
      detune: { value: 0 },
      power: { value: 1 },
      carrier: { value: 1 },
      shock: { value: 0 },
    },
    vertexShader: CRT_VERT,
    fragmentShader: CRT_FRAG,
  });
  return screenMat;
}

// ---------------------------------------------------------------- HUD
// 部屋の明るさ / UHF感度 / CRTエフェクト量。値は localStorage に残す。
const hud = {
  panel: document.getElementById('room-hud'),
  read: document.getElementById('hud-read'),
  light: document.getElementById('room-light'),
  uhf: document.getElementById('uhf-gain'),
  tune: document.getElementById('rf-tune'),
  crt: document.getElementById('crt-amount'),
  osd: document.getElementById('osd-on'),
};
const LIGHT_BASE = { hemi: 0.75, key: 0.85, glow: 0.9 };
let lights = null;

function hudVal(el, def) {
  const v = parseFloat(el && el.value);
  return isNaN(v) ? def : v;
}
const crtAmount = () => hudVal(hud.crt, 100) / 100;
const uhfGain = () => hudVal(hud.uhf, 100) / 100;
const roomLight = () => hudVal(hud.light, 100) / 100;
const detuneVal = () => hudVal(hud.tune, 0) / 100;          // -1 .. +1
// 同調のずれ具合 (中心で 1、外れるほど 0)
const tuneQuality = () => Math.exp(-Math.pow(detuneVal() * 1.9, 2));

function applyHud() {
  const set = (id, v, s) => { const el = document.getElementById(id); if (el) el.textContent = s || (Math.round(v) + '%'); };
  set('light-val', hudVal(hud.light, 100));
  set('uhf-val', hudVal(hud.uhf, 100));
  set('crt-val', hudVal(hud.crt, 100));
  const off = detuneVal() * 0.9;
  set('tune-val', 0, (off >= 0 ? '+' : '') + off.toFixed(2));
  osdOn = !hud.osd || hud.osd.checked;
  localStorage.setItem('roomHud', JSON.stringify({
    light: hudVal(hud.light, 100), uhf: hudVal(hud.uhf, 100),
    tune: hudVal(hud.tune, 0), crt: hudVal(hud.crt, 100), osd: osdOn,
  }));
  if (screenMat) screenMat.uniforms.amount.value = crtAmount();
  if (lights) {
    const k = roomLight();
    lights.hemi.intensity = LIGHT_BASE.hemi * k;
    lights.key.intensity = LIGHT_BASE.key * k;
    // 部屋を暗くするほどブラウン管の光が際立つ
    lights.glow.intensity = LIGHT_BASE.glow * (1.6 - 0.6 * k);
    scene.background.setHSL(0.09, 0.15, 0.02 + 0.05 * k);
  }
}

// ホバーで出る HUD。HUD の上にカーソルがある間は消さず、離れて少し経ってから閉じる
function autoHideHud(el, delay = 500) {
  if (!el) return () => {};
  let timer = 0;
  const show = (on) => {
    clearTimeout(timer);
    if (on) el.classList.add('on');
    else timer = setTimeout(() => el.classList.remove('on'), delay);
  };
  el.addEventListener('pointerenter', () => show(true));
  el.addEventListener('pointerleave', () => show(false));
  return show;
}
const showRoomHud = autoHideHud(hud.panel);

{
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('roomHud')) || {}; } catch (e) { /* 初回 */ }
  for (const [k, el] of [['light', hud.light], ['uhf', hud.uhf], ['tune', hud.tune], ['crt', hud.crt]]) {
    if (!el) continue;
    if (typeof saved[k] === 'number') el.value = saved[k];
    el.addEventListener('input', applyHud);
    el.addEventListener('dblclick', () => { el.value = el.defaultValue; applyHud(); });
  }
  if (hud.osd) {
    if (typeof saved.osd === 'boolean') hud.osd.checked = saved.osd;
    hud.osd.addEventListener('change', applyHud);
  }
  const tgl = document.getElementById('hud-toggle');
  if (tgl) tgl.addEventListener('click', () => {
    const c = hud.panel.classList.toggle('collapsed');
    tgl.textContent = c ? '+' : '−';
  });
  applyHud();
}

// ---------------------------------------------------------------- ミュート
// ツールバーの 🔊 ボタン (main.js が状態を持っている) を HUD からも叩く。
// 既定はミュート ON (ブラウザの自動再生制限もあるので黙って始める)。
const muteBtn = document.getElementById('hud-mute');
const toolbarMute = document.getElementById('btn-mute');
const isMuted = () => toolbarMute && toolbarMute.textContent.includes('🔇');

function refreshMuteBtn() {
  if (!muteBtn) return;
  const m = isMuted();
  muteBtn.classList.toggle('on', !m);
  muteBtn.firstChild.nodeValue = m ? '🔇 ' : '🔊 ';
}
// 既定は音あり。ミュートを選んだら次回も引き継ぐ。
// main.js のミュート処理は WASM のロード後に登録されるので、起動直後のクリックは
// 握り潰される。状態が変わるまで様子を見ながら押し直す。
function ensureMuted(want, tries) {
  if (isMuted() === want) { refreshMuteBtn(); return; }
  toolbarMute.click();
  refreshMuteBtn();
  if (isMuted() !== want && tries > 0) setTimeout(() => ensureMuted(want, tries - 1), 120);
}

if (muteBtn && toolbarMute) {
  muteBtn.addEventListener('click', () => {
    toolbarMute.click();
    localStorage.setItem('roomMuted', isMuted() ? '1' : '0');
    refreshMuteBtn();
  });
  toolbarMute.addEventListener('click', () => setTimeout(refreshMuteBtn, 0));
  // 起動時: 保存された設定 (既定は音あり) を反映
  ensureMuted(localStorage.getItem('roomMuted') === '1', 200);   // 最大 24 秒粘る
}

// ------------------------------------------- 左下のオーバーレイ (3D モードの操作)
// 電源 / リセット / 掴むモード / 片付け と、小物のパレット。
// 電源とリセットは 2D 側のボタン (main.js が状態を持っている) を叩く。
const tbPower = document.getElementById('rt-power');
const tbReset = document.getElementById('rt-reset');
const btnPower2d = document.getElementById('btn-power');
const btnReset2d = document.getElementById('btn-reset');

function refreshPowerBtn() {
  if (!tbPower) return;
  const on = window.NES_UI ? window.NES_UI.isPowered()
    : (btnPower2d && btnPower2d.classList.contains('power-on'));
  tbPower.classList.toggle('on', !!on);
}
if (tbPower) {
  tbPower.addEventListener('click', () => {
    if (window.NES_UI) window.NES_UI.togglePower();
    else if (btnPower2d) btnPower2d.click();
    refreshPowerBtn();
  });
  setInterval(refreshPowerBtn, 400);   // 2D 側や AC アダプタ経由の変化も拾う
}
if (tbReset) {
  // リセットはレベル信号: 押している間だけ停止、離した瞬間に再起動
  const hold = (h) => {
    if (window.NES_UI) window.NES_UI.setResetHold(h);
    tbReset.classList.toggle('held', h);
    if (btnReset2d) btnReset2d.classList.toggle('held', h);
  };
  tbReset.addEventListener('pointerdown', (e) => {
    hold(true);
    try { tbReset.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベント */ }
  });
  const up = () => hold(false);
  tbReset.addEventListener('pointerup', up);
  tbReset.addEventListener('pointercancel', up);
  tbReset.addEventListener('pointerleave', up);
}

const physBtn = document.getElementById('rt-grab');
const tidyBtn = document.getElementById('rt-tidy');
if (physBtn) {
  physBtn.addEventListener('click', () => {
    setPhysicsEnabled(!phys.enabled);
    physBtn.classList.toggle('on', phys.enabled);
  });
}
if (tidyBtn) {
  tidyBtn.addEventListener('click', () => {
    resetPhysics();
    setInsertion(1);
    cartSlider.value = 0;
    cartSlider.dispatchEvent(new Event('input'));
    // 濡れ・こぼれもリセット、ケーブルも挿し直す
    if (can) can.reset();
    if (leak) leak.dry();
    juiceFault = 0;
    if (cables) for (const c of cables.cables) { c.held = false; c.connected = true; }
    if (tarai) tarai.object.visible = false;
  });
}

// --- 部屋の明かり (テレビのオプションではないのでオーバーレイ側に置く) ---
const lightBtn = document.getElementById('rt-light');
const LIGHT_STEPS = [
  { v: 130, name: 'BRIGHT' },
  { v: 70, name: 'DIM' },
  { v: 18, name: 'NIGHT' },
  { v: 0, name: 'DARK' },
];
if (lightBtn && hud.light) {
  const refreshLight = () => {
    const cur = hudVal(hud.light, 100);
    // 一番近い段を表示名にする
    let best = LIGHT_STEPS[0];
    for (const s of LIGHT_STEPS) if (Math.abs(s.v - cur) < Math.abs(best.v - cur)) best = s;
    document.getElementById('rt-light-val').textContent = best.name;
    lightBtn.classList.toggle('on', cur > 90);
  };
  lightBtn.addEventListener('click', () => {
    const cur = hudVal(hud.light, 100);
    let i = LIGHT_STEPS.findIndex((s) => Math.abs(s.v - cur) < 12);
    i = (i + 1) % LIGHT_STEPS.length;
    hud.light.value = LIGHT_STEPS[i].v;
    applyHud();
    refreshLight();
  });
  refreshLight();
}

// --- 小物のパレット ---
const roachBtn = document.getElementById('rt-roach');
const leakBtn = document.getElementById('rt-leak');
const canBtn = document.getElementById('rt-can');
if (roachBtn) roachBtn.addEventListener('click', spawnRoach);
const taraiBtn = document.getElementById('rt-tarai');
if (taraiBtn) {
  taraiBtn.addEventListener('click', () => {
    if (!tarai || !taraiItem) return;
    // いま見ているあたりの真上から落とす
    const t = controls ? controls.target : new THREE.Vector3();
    tarai.object.visible = true;
    taraiItem.body.mass = taraiItem.mass;
    taraiItem.body.type = CANNON.Body.DYNAMIC;
    taraiItem.body.updateMassProperties();
    taraiItem.body.position.set(
      t.x + (Math.random() - 0.5) * 0.25,
      ROOM_H - 0.25,
      t.z + (Math.random() - 0.5) * 0.25
    );
    taraiItem.body.quaternion.set(0, 0, 0, 1);
    taraiItem.body.velocity.set(0, -0.5, 0);
    taraiItem.body.angularVelocity.set((Math.random() - 0.5) * 1.2, 0, (Math.random() - 0.5) * 1.2);
    taraiItem.body.wakeUp();
  });
}

const sprayBtn = document.getElementById('rt-spray');
if (sprayBtn) {
  sprayBtn.addEventListener('click', () => {
    setSprayMode(!spray.on);
    sprayBtn.classList.toggle('on', spray.on);
  });
}

// --- ファミコンの HUD (電源 / リセット / ROM名) ---
const fcHud = {
  el: document.getElementById('fc-hud'),
  rom: document.getElementById('fc-rom'),
  power: document.getElementById('fc-power'),
  reset: document.getElementById('fc-reset'),
};
if (fcHud.power) {
  fcHud.power.addEventListener('click', () => {
    if (window.NES_UI) window.NES_UI.togglePower();
    sfx.powerSwitch(window.NES_UI ? window.NES_UI.isPowered() : true);
    refreshFcHud();
  });
}
if (fcHud.reset) {
  const hold = (h) => {
    if (window.NES_UI) window.NES_UI.setResetHold(h);
    fcHud.reset.classList.toggle('held', h);
  };
  fcHud.reset.addEventListener('pointerdown', (e) => {
    hold(true);
    try { fcHud.reset.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベント */ }
  });
  fcHud.reset.addEventListener('pointerup', () => hold(false));
  fcHud.reset.addEventListener('pointercancel', () => hold(false));
  fcHud.reset.addEventListener('pointerleave', () => hold(false));
}
const fcHudToggle = autoHideHud(fcHud.el);
function refreshFcHud() {
  if (!fcHud.el) return;
  const on = window.NES_UI ? window.NES_UI.isPowered() : false;
  fcHud.power.classList.toggle('on', on);
  if (window.NES_UI) fcHud.rom.textContent = window.NES_UI.getRomName() || '-';
}

// --- .nes をファミコンにドラッグ&ドロップしてカセット交換 ---
{
  const stage = document.getElementById('screen-wrap');
  const isRom = (e) => Array.from(e.dataTransfer?.items || []).some((i) => i.kind === 'file');
  stage.addEventListener('dragover', (e) => {
    if (!document.body.classList.contains('room-on') || !isRom(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('rom-drag');
    refreshFcHud();
  });
  stage.addEventListener('dragleave', (e) => {
    if (e.target === stage) document.body.classList.remove('rom-drag');
  });
  stage.addEventListener('drop', async (e) => {
    if (!document.body.classList.contains('room-on')) return;
    const file = e.dataTransfer?.files?.[0];
    document.body.classList.remove('rom-drag');
    if (!file) return;
    e.preventDefault();
    if (!window.NES_UI || !window.NES_UI.swapCartridge) return;
    // 抜く -> 差す の演出つきで入れ替える
    sfx.unplug();
    const ok = await window.NES_UI.swapCartridge(file);
    if (!ok) return;
    if (cartItem && cartItem.reattach) cartItem.reattach();
    reskinCassette();
    sfx.plug();
    refreshFcHud();
  });
}
if (leakBtn) {
  leakBtn.addEventListener('click', () => {
    if (!leak) return;
    const on = !leak.state.enabled;
    leak.setEnabled(on);
    leakBtn.classList.toggle('on', on);
  });
}
if (canBtn) {
  canBtn.addEventListener('click', () => {
    if (!canItem || !can) return;
    // 新しい缶を畳の上に置き直す
    can.reset();
    canItem.obj.position.copy(canItem.home.pos);
    canItem.obj.quaternion.copy(canItem.home.quat);
    syncBodyFromObject(canItem);
    // 缶だけは常に物理で倒れるようにしておく
    canItem.body.mass = canItem.mass;
    canItem.body.type = CANNON.Body.DYNAMIC;
    canItem.body.updateMassProperties();
    canItem.body.wakeUp();
    sfx.can();
  });
}

// i18n (main.js の t() は外から呼べないので簡易版)
function tt(key, vars) {
  const l = document.documentElement.lang || 'ja';
  const dict = (window.I18N && (window.I18N[l] || window.I18N.ja)) || {};
  let s = dict[key] || key;
  if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}

// ---------------------------------------------------------------- 仮モデル
// 寸法はすべてメートル。実物の寸法に合わせてある:
//   6畳間 2.73 x 3.64 m / 畳 910 x 1820 mm / 14型 CRT / カセット 110 x 122 x 17 mm
const MAT_W = 0.91, MAT_L = 1.82;          // 江戸間ではなく京間寄りの 1畳
const ROOM_W = MAT_W * 4, ROOM_D = MAT_L * 2;   // 3.64 x 3.64 m (8畳)
const ROOM_H = 2.5;

// 角の丸い箱 (筐体・カセットの本体に使う)
function roundedBox(w, h, d, r, bevel = 0.004) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(0.001, d - bevel * 2),
    bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
    curveSegments: 8,
  });
  g.translate(0, 0, -d / 2 + bevel);
  g.computeVertexNormals();
  return g;
}

function buildRoom() {
  const room = new THREE.Group();

  // 畳 6枚 (よくある 6畳の敷き方)
  const tatMat = new THREE.MeshStandardMaterial({ map: tatamiTexture(), roughness: 0.95 });
  const tatHalf = new THREE.MeshStandardMaterial({ map: tatamiTexture(), roughness: 0.95 });
  const layout = [];        // 8畳: 4列 x 2行
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 4; c++) {
      layout.push([(c - 1.5) * MAT_W, (r - 0.5) * MAT_L, false]);
    }
  }
  for (const [x, z, rot] of layout) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(MAT_W, MAT_L), rot ? tatHalf : tatMat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = rot ? Math.PI / 2 : 0;
    m.position.set(x, 0, z);
    m.receiveShadow = true;
    room.add(m);
  }

  // 壁は板 (厚み 60mm)。ぶつけると倒れるので剛体として登録する
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 1 });
  const WALL_T = 0.06;
  const walls = [];
  const mkWall = (w, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, ROOM_H, WALL_T), wallMat);
    m.position.set(x, ROOM_H / 2, z);
    m.rotation.y = ry;
    m.receiveShadow = m.castShadow = true;
    m.userData.wallSize = new THREE.Vector3(w, ROOM_H, WALL_T);
    room.add(m);
    walls.push(m);
    return m;
  };
  mkWall(ROOM_W, 0, -ROOM_D / 2 - WALL_T / 2, 0);
  mkWall(ROOM_D, -ROOM_W / 2 - WALL_T / 2, 0, Math.PI / 2);
  mkWall(ROOM_D, ROOM_W / 2 + WALL_T / 2, 0, -Math.PI / 2);
  room.userData.walls = walls;

  // 障子 (右の壁)
  const shoji = new THREE.Group();
  const paper = new THREE.Mesh(
    new THREE.PlaneGeometry(1.7, 1.75),
    new THREE.MeshStandardMaterial({ color: 0xf2eee0, roughness: 1, emissive: 0x2a2a24 })
  );
  shoji.add(paper);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x6d5334, roughness: 0.8 });
  for (let i = 0; i <= 6; i++) {   // 縦桟
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.016, 1.75, 0.014), frameMat);
    b.position.set(-0.85 + (1.7 / 6) * i, 0, 0.012);
    shoji.add(b);
  }
  for (let i = 0; i <= 7; i++) {   // 横桟
    const b = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.014, 0.014), frameMat);
    b.position.set(0, -0.875 + (1.75 / 7) * i, 0.012);
    shoji.add(b);
  }
  shoji.position.set(ROOM_W / 2 - 0.02, 1.0, 0.35);
  shoji.rotation.y = -Math.PI / 2;
  room.add(shoji);

  // 天井 (竿縁天井)
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_W, ROOM_D),
    new THREE.MeshStandardMaterial({ color: 0x7d6a4e, roughness: 1 })
  );
  ceil.position.y = ROOM_H;
  ceil.rotation.x = Math.PI / 2;
  room.add(ceil);

  return room;
}

// 家の外。壁が倒れたときに見える青空と地面
function buildOutside() {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#3f7fd8');
  grd.addColorStop(0.55, '#8fc0ea');
  grd.addColorStop(0.78, '#dce9f2');
  grd.addColorStop(1, '#cbd8c8');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(28, 24, 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false })
  );
  sky.position.y = 6;
  scene.add(sky);

  // 外の地面 (部屋の床より少しだけ下)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(56, 56),
    new THREE.MeshStandardMaterial({ color: 0x6f7a52, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);
}

function buildTvStand() {
  // テレビ台 (600 x 420 x 450h)
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4526, roughness: 0.55 });
  // roundedBox(w, h, d) は X=w / Y=h / Z=d。回すと天板が縦板になるので回さない
  const top = new THREE.Mesh(roundedBox(0.62, 0.035, 0.44, 0.008), wood);
  top.position.y = 0.45;
  top.castShadow = top.receiveShadow = true;
  g.add(top);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.02, 0.38), wood);
  shelf.position.y = 0.16;
  shelf.receiveShadow = true;
  g.add(shelf);
  for (const [x, z] of [[-0.28, -0.19], [0.28, -0.19], [-0.28, 0.19], [0.28, 0.19]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.45, 0.035), wood);
    leg.position.set(x, 0.225, z);
    leg.castShadow = true;
    g.add(leg);
  }
  return g;
}

// 14型ブラウン管テレビ (筐体 420 x 380 x 400、画面 約 280 x 210)
// 造形はシンプルに: 箱 + 黒いベゼル + 少しふくらんだ画面だけ
function buildCrt() {
  const g = new THREE.Group();
  const W = 0.42, H = 0.38, D = 0.40;
  const body = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.4 });

  // 筐体 (前面は開口、後ろは絞る)
  const cab = new THREE.Mesh(roundedBox(W, H, D, 0.022), body);
  cab.position.set(0, H / 2, 0);
  cab.castShadow = cab.receiveShadow = true;
  g.add(cab);

  // 前面パネル: 画面まわりの黒いベゼル (角丸で窓を抜く)
  const SX = 0, SY = H * 0.53;
  const SW = 0.352, SH = 0.264;          // 筐体幅の 84% (ベゼルは細め)
  {
    const outer = new THREE.Shape();
    const w = W - 0.012, h = H - 0.012, r = 0.014;
    outer.moveTo(-w / 2 + r, -h / 2);
    outer.lineTo(w / 2 - r, -h / 2); outer.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    outer.lineTo(w / 2, h / 2 - r); outer.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    outer.lineTo(-w / 2 + r, h / 2); outer.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    outer.lineTo(-w / 2, -h / 2 + r); outer.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    const hole = new THREE.Path();
    const hw = SW * 0.5 + 0.003, hh = SH * 0.5 + 0.003, hr = 0.010;
    hole.moveTo(SX - hw + hr, SY - H / 2 - hh);
    hole.lineTo(SX + hw - hr, SY - H / 2 - hh);
    hole.quadraticCurveTo(SX + hw, SY - H / 2 - hh, SX + hw, SY - H / 2 - hh + hr);
    hole.lineTo(SX + hw, SY - H / 2 + hh - hr);
    hole.quadraticCurveTo(SX + hw, SY - H / 2 + hh, SX + hw - hr, SY - H / 2 + hh);
    hole.lineTo(SX - hw + hr, SY - H / 2 + hh);
    hole.quadraticCurveTo(SX - hw, SY - H / 2 + hh, SX - hw, SY - H / 2 + hh - hr);
    hole.lineTo(SX - hw, SY - H / 2 - hh + hr);
    hole.quadraticCurveTo(SX - hw, SY - H / 2 - hh, SX - hw + hr, SY - H / 2 - hh);
    outer.holes.push(hole);
    const face = new THREE.Mesh(
      new THREE.ExtrudeGeometry(outer, { depth: 0.012, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelSegments: 2, curveSegments: 8 }),
      dark
    );
    face.position.set(0, H / 2, D / 2 - 0.004);
    face.castShadow = true;
    g.add(face);
  }

  // ブラウン管 (エミュレータ画面) — 中央がふくらんだ球面
  screenTex = new THREE.CanvasTexture(feedCanvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.magFilter = THREE.NearestFilter;
  screenTex.minFilter = THREE.LinearFilter;
  screenTex.generateMipmaps = false;
  // 画面はフラット。ベゼルの前面とほぼ面一に置いて、枠に沈んで見えないようにする
  screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH, 2, 2), makeScreenMaterial());
  screenMesh.position.set(SX, SY, D / 2 + 0.007);
  g.add(screenMesh);

  // ガラス面の映り込み (うっすら)
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(SW, SH, 1, 1),
    new THREE.MeshPhysicalMaterial({
      color: 0x000000, roughness: 0.08, metalness: 0,
      transparent: true, opacity: 0.07, transmission: 0, clearcoat: 1,
    })
  );
  glass.position.set(SX, SY, D / 2 + 0.0082);
  g.add(glass);

  // 画面の光がまわりを照らす (青すぎると部屋全体が青くなるので控えめに)
  const glow = new THREE.PointLight(0xa8c8f0, 0.9, 1.4, 2);
  glow.position.set(SX, SY, D / 2 + 0.18);
  g.add(glow);

  return g;
}

// ------------------------------------------------------------------ カセット
// 実寸 (外形は実測値ベース、基板は NESdev Wiki の HVC ボード寸法):
//   シェル  109.5 x 70 x 17 mm
//   基板    90 x 46.1 x 1.2 mm、カードエッジ突出 10.7 mm
//   端子    2.54mm ピッチ x 30 パッド x 表裏 2列 (計60)、信号パッド幅 1.6mm
const CART_W = 0.1095, CART_H = 0.070, CART_D = 0.017;
const PCB_W = 0.090, PCB_T = 0.0012, EDGE_H = 0.0107;
const PIN_PITCH = 0.00254, PIN_W = 0.0016;

// ラベル: 2D 側のカセット絵と同じ「斜めの帯」デザインを描く
const cartLabelCanvas = document.createElement('canvas');
cartLabelCanvas.width = 384;
cartLabelCanvas.height = 220;
const cartLabelTex = new THREE.CanvasTexture(cartLabelCanvas);
cartLabelTex.colorSpace = THREE.SRGBColorSpace;
let cartLabelText = '';

function drawCartLabel(title) {
  const g = cartLabelCanvas.getContext('2d');
  const W = 384, H = 220;
  const accent = '#' + new THREE.Color(cartColor).getHexString();
  const accentDark = '#' + new THREE.Color(cartColor).multiplyScalar(0.72).getHexString();
  g.fillStyle = '#e9e1d0';
  g.fillRect(0, 0, W, H);
  // 上部のコードストライプ
  g.fillStyle = 'rgba(0,0,0,0.07)';
  g.fillRect(0, 0, W, 34);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(0, 34); g.lineTo(W, 34); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.strokeRect(9, 7, 66, 21);
  g.fillStyle = '#444';
  g.font = 'bold 15px ui-monospace, Menlo, monospace';
  g.textBaseline = 'middle';
  g.fillText('HVC', 20, 18);
  // タイトル
  g.fillStyle = accentDark;
  g.font = 'bold 19px system-ui, sans-serif';
  g.fillText((title || 'CASSETTE').slice(0, 22), 90, 18);
  // 斜めの帯
  g.fillStyle = accent;
  g.beginPath();
  g.moveTo(0, 84); g.lineTo(190, 84); g.lineTo(250, 144); g.lineTo(384, 48);
  g.lineTo(384, 74); g.lineTo(250, 170); g.lineTo(190, 110); g.lineTo(0, 110);
  g.closePath(); g.fill();
  // 帯にそったピンストライプ
  g.strokeStyle = accent;
  g.globalAlpha = 0.75;
  g.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.moveTo(0, 126 + i * 10); g.lineTo(190, 126 + i * 10);
    g.lineTo(250, 186 + i * 8); g.lineTo(384, 90 + i * 10);
    g.stroke();
  }
  g.globalAlpha = 1;
  cartLabelTex.needsUpdate = true;
}

// カセットの色は実機同様いろいろ。ROM ごとにランダムで決める
const CART_COLORS = [
  0x8f2323, 0x2f4f8f, 0x2f7a4a, 0x8f6f1f, 0x6a3a8f,
  0x1f6f7a, 0xa8541f, 0x8f2f6a, 0x4a4a52, 0x7a1f1f,
];
let cartColor = CART_COLORS[0];
function pickCartColor() {
  cartColor = CART_COLORS[Math.floor(Math.random() * CART_COLORS.length)];
  return cartColor;
}

function buildCassette() {
  // 原点 = カードエッジの下端 (= 傾きの支点)。シェルの底は y = EDGE_H。
  const grp = new THREE.Group();
  const base = new THREE.Color(pickCartColor());
  const maroon = new THREE.MeshStandardMaterial({ color: base, roughness: 0.5 });
  const maroonDark = new THREE.MeshStandardMaterial({
    color: base.clone().multiplyScalar(0.78), roughness: 0.55,
  });
  const shellY = EDGE_H + CART_H / 2;

  // シェル本体
  const shell = new THREE.Mesh(roundedBox(CART_W, CART_H, CART_D, 0.005), maroon);
  shell.position.y = shellY;
  shell.castShadow = shell.receiveShadow = true;
  grp.add(shell);

  // 上端のリップ (指をかけるところ) と 2つの切り欠き
  const lip = new THREE.Mesh(roundedBox(CART_W - 0.010, 0.008, CART_D + 0.0025, 0.002), maroonDark);
  lip.position.set(0, EDGE_H + CART_H - 0.004, 0);
  grp.add(lip);
  for (const x of [-0.024, 0.024]) {
    const notch = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.005, CART_D + 0.005),
      new THREE.MeshStandardMaterial({ color: 0x5a1414, roughness: 0.6 })
    );
    notch.position.set(x, EDGE_H + CART_H - 0.001, 0);
    grp.add(notch);
  }

  // 側面のグリップ溝
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const gr = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.030, CART_D * 0.7), maroonDark);
      gr.position.set(side * (CART_W / 2 - 0.003 - i * 0.004), shellY, 0);
      grp.add(gr);
    }
  }

  // ラベル (前面。実物同様シェルより一回り小さい)
  drawCartLabel(document.getElementById('cart-label')?.textContent || 'CASSETTE');
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(CART_W - 0.016, CART_H - 0.012),
    new THREE.MeshStandardMaterial({ map: cartLabelTex, roughness: 0.85 })
  );
  label.position.set(0, shellY + 0.001, CART_D / 2 + 0.0007);
  grp.add(label);

  // 裏面の型番プレート
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(CART_W - 0.028, 0.018),
    new THREE.MeshStandardMaterial({ color: 0x7a1f1f, roughness: 0.7 })
  );
  back.position.set(0, shellY + 0.012, -CART_D / 2 - 0.0007);
  back.rotation.y = Math.PI;
  grp.add(back);

  // 基板 (90 x 46.1 x 1.2mm) — カードエッジがシェルの下から 10.7mm 出る
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(PCB_W, 0.0461, PCB_T),
    new THREE.MeshStandardMaterial({ color: 0x1d5c30, roughness: 0.7 })
  );
  board.position.set(0, EDGE_H + 0.0461 / 2 - 0.008, 0);
  grp.add(board);

  // 60 パッド (2.54mm ピッチ x 30 x 表裏)
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xd8b24a, roughness: 0.28, metalness: 0.85 });
  const pins = new THREE.InstancedMesh(
    new THREE.BoxGeometry(PIN_W, EDGE_H * 0.82, 0.0004), goldMat, 60
  );
  const m4 = new THREE.Matrix4();
  const span = PIN_PITCH * 29;              // 73.66mm
  for (let i = 0; i < 30; i++) {
    const x = -span / 2 + PIN_PITCH * i;
    const y = EDGE_H * 0.82 / 2 + 0.0008;
    m4.makeTranslation(x, y, PCB_T / 2 + 0.0002);
    pins.setMatrixAt(i, m4);
    m4.makeTranslation(x, y, -PCB_T / 2 - 0.0002);
    pins.setMatrixAt(30 + i, m4);
  }
  pins.instanceMatrix.needsUpdate = true;
  grp.add(pins);

  return grp;
}

// RF コンバータ (VHF/UHF スイッチ)。白い箱 + ゲーム/TV の切替スイッチ
const CONV_W = 0.085, CONV_H = 0.024, CONV_D = 0.055;
let convSwitch = null;

function buildConverter() {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf0ece0, roughness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: 0.6 });

  const box = new THREE.Mesh(roundedBox(CONV_W, CONV_H, CONV_D, 0.004), white);
  box.position.y = CONV_H / 2;
  box.castShadow = box.receiveShadow = true;
  g.add(box);

  // 上面のスライドスイッチ (ゲーム / TV)
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.002, 0.010), dark);
  rail.position.set(0.018, CONV_H + 0.001, 0);
  g.add(rail);
  convSwitch = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.006, 0.008), new THREE.MeshStandardMaterial({ color: 0x8f2323, roughness: 0.5 }));
  convSwitch.position.set(0.010, CONV_H + 0.003, 0);
  convSwitch.userData.isConvSwitch = true;
  g.add(convSwitch);

  // 前面のスリット模様 (それっぽさ)
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.0012, 0.001), dark);
    s.position.set(-0.012, CONV_H * 0.35 + i * 0.005, CONV_D / 2 + 0.0005);
    g.add(s);
  }
  return g;
}

// ファミコン本体 (150 x 220 x 60mm、意匠はざっくり)
function buildFamicom() {
  const g = new THREE.Group();
  const W = 0.150, D = 0.220, H = 0.055;
  const cream = new THREE.MeshStandardMaterial({ color: 0xe6ddca, roughness: 0.6 });
  const maroon = new THREE.MeshStandardMaterial({ color: 0x8f2323, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: 0.6 });

  const base = new THREE.Mesh(roundedBox(W, H, D, 0.006), cream);
  base.position.y = H / 2;
  base.castShadow = base.receiveShadow = true;
  g.add(base);

  // 上面のマルーンのプレート (奥 2/3 くらい)
  const top = new THREE.Mesh(new THREE.BoxGeometry(W - 0.008, 0.003, D * 0.66), maroon);
  top.position.set(0, H + 0.0005, -D * 0.16);
  g.add(top);

  // カセット差込口 (窪ませる)
  const slot = new THREE.Mesh(new THREE.BoxGeometry(CART_W + 0.008, 0.008, CART_D + 0.006), dark);
  slot.position.set(0, H - 0.002, -0.03);
  g.add(slot);

  // 手前のマルーンの帯 (電源/リセットのあたり)
  const front = new THREE.Mesh(new THREE.BoxGeometry(W - 0.008, 0.003, 0.030), maroon);
  front.position.set(0, H + 0.0005, D / 2 - 0.026);
  g.add(front);

  // カセット。原点がカードエッジの下端なので、差込口の底に置けば
  // 実機と同じ「浮いた側から接点が切れる」動きになる
  cassetteGroup = buildCassette();
  cassetteGroup.position.set(0, H - EDGE_H - 0.002, -0.03);
  g.add(cassetteGroup);

  return g;
}

// ---------------------------------------------------------------- glTF 差し替え
// assets/models/<name>.glb (または .gltf) を置くだけで仮モデルと入れ替わる。
// models.json で位置・回転・スケール・画面メッシュ名を上書きできる。
const FIT = {   // 仮モデルの実寸 (自動スケールの基準)
  room: null,
  crt: { axis: 'y', size: 0.38 },
  famicom: { axis: 'x', size: 0.150 },
  cassette: { axis: 'x', size: CART_W },
};

// 実寸に合わせて拡縮する (models.json の scale が優先)
function fitScale(model, name, cfg) {
  const size = new THREE.Vector3();
  new THREE.Box3().setFromObject(model).getSize(size);
  if (size.x === 0 || size.y === 0) return;
  if (typeof cfg.scale === 'number') {
    model.scale.multiplyScalar(cfg.scale);
  } else if (cfg.autoFit !== false && FIT[name]) {
    const { axis, size: want } = FIT[name];
    if (size[axis] > 0) model.scale.multiplyScalar(want / size[axis]);
  }
  model.updateMatrixWorld(true);
}

// 底面を置き場所 (仮モデルの足元) に合わせる。シーン直下のモデルだけが対象。
function groundTo(model, baseY) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (isFinite(box.min.y)) model.position.y += baseY - box.min.y;
}

async function fetchJson(url) {
  try {
    const r = await fetch(url);
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

async function tryLoadModels() {
  // 既定は内製 (コード生成) モデル。外部モデルを使うときだけ models.json を置く
  const manifest = await fetchJson(`${MODEL_DIR}models.json`);
  if (!manifest) return;
  const loader = new GLTFLoader();
  for (const name of MODELS) {
    const cfg = manifest[name] || {};
    if (cfg.enabled === false) continue;
    const files = cfg.file ? [cfg.file] : [`${name}.glb`, `${name}.gltf`];
    let gltf = null, used = null;
    for (const f of files) {
      const url = MODEL_DIR + f;
      try {
        const head = await fetch(url, { method: 'HEAD' });
        if (!head.ok) continue;
        gltf = await loader.loadAsync(url);
        used = f;
        break;
      } catch (e) {
        console.warn(`[room] ${f} の読み込みに失敗:`, e.message);
      }
    }
    if (!gltf) continue;

    const ph = placeholders[name];
    if (!ph || !ph.parent) continue;
    const model = gltf.scene;
    const parent = ph.parent;

    // 仮モデルの配置を引き継ぐ (models.json で上書き可)
    const baseY = ph.position.y;
    model.position.copy(ph.position);
    model.rotation.copy(ph.rotation);
    model.scale.set(1, 1, 1);
    fitScale(model, name, cfg);
    if (Array.isArray(cfg.position)) model.position.fromArray(cfg.position);
    if (Array.isArray(cfg.rotation)) model.rotation.fromArray(cfg.rotation.map((d) => d * Math.PI / 180));
    if (typeof cfg.rotationY === 'number') model.rotation.y = cfg.rotationY * Math.PI / 180;
    // カセットは本体の子なのでワールド基準の接地はしない
    if (cfg.ground !== false && parent === scene && !Array.isArray(cfg.position)) {
      groundTo(model, baseY);
    }
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    // 画面メッシュ: 名前 "screen" (大文字小文字は無視) か models.json の screenMesh
    const wantName = (cfg.screenMesh || 'screen').toLowerCase();
    let s = null;
    model.traverse((o) => {
      if (s || !o.isMesh) return;
      if (o.name.toLowerCase() === wantName ||
          (o.material && (o.material.name || '').toLowerCase() === wantName)) s = o;
    });
    if (s) {
      s.material = makeScreenMaterial();
      screenMesh = s;
      console.info(`[room] ${used}: 画面メッシュ "${s.name}" にエミュレータ画面を割り当てました`);
    } else if (name === 'crt') {
      console.warn('[room] crt モデルに "screen" という名前のメッシュが見つかりません。' +
        'ブレンダー側で画面のメッシュ名を screen にするか、models.json の screenMesh で指定してください。');
    }

    if (name === 'cassette') cassetteGroup = model;
    if (name === 'famicom') {
      // 本体モデルにカセットが含まれていればそれを、無ければ仮カセットを載せ替える
      const inner = model.getObjectByName('cassette');
      if (inner) cassetteGroup = inner;
      else model.add(cassetteGroup);
      placeholders.cassette = cassetteGroup;
    }
    parent.add(model);
    parent.remove(ph);
    placeholders[name] = model;

    const b = new THREE.Box3().setFromObject(model);
    const sz = new THREE.Vector3(); b.getSize(sz);
    console.info(`[room] ${used} を読み込みました  実寸 ${sz.x.toFixed(3)} x ${sz.y.toFixed(3)} x ${sz.z.toFixed(3)} m`);
  }
}

// ---------------------------------------------------------------- 物理エンジン
// 既定は OFF (全部 mass 0 = 置物)。HUD の「ぶん投げ」で ON にすると掴んで投げられる。
const phys = {
  world: null,
  items: [],        // { obj, body, size, center, home:{pos,quat} }
  enabled: false,
  grab: null,
};

function initPhysics() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.45;
  world.defaultContactMaterial.restitution = 0.22;
  phys.world = world;

  // 床 (外の地面も兼ねるので無限平面のまま)
  const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floor);

  // 手前だけは見えない壁で塞いでおく (カメラ側に飛んでこないように)
  const front = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  front.quaternion.setFromEuler(0, Math.PI, 0);
  front.position.set(0, 0, ROOM_D / 2 + 0.4);
  world.addBody(front);
}

// 壁: 普段は静止。強くぶつけるとドリフの舞台みたいに倒れる
function registerWalls(room) {
  for (const m of room.userData.walls || []) {
    const s = m.userData.wallSize;
    m.name = 'wall';
    const it = addPhysicsItem(m, s, new THREE.Vector3(0, 0, 0), 26);
    it.isWall = true;
    it.body.addEventListener('collide', (e) => {
      if (it.body.type === CANNON.Body.DYNAMIC) return;
      const v = Math.abs(e.contact.getImpactVelocityAlongNormal());
      if (v < 2.0) return;
      // 外側へ倒れる
      it.body.mass = it.mass;
      it.body.type = CANNON.Body.DYNAMIC;
      it.body.updateMassProperties();
      it.body.wakeUp();
      const n = new THREE.Vector3(m.position.x, 0, m.position.z).normalize();
      it.body.velocity.set(n.x * 0.6, 0.2, n.z * 0.6);
      it.body.angularVelocity.set(-n.z * 2.2, 0, n.x * 2.2);
      sfx.crash();
    });
  }
}

// obj のローカル寸法 size と、その中心 center を与えて剛体を作る
function addPhysicsItem(obj, size, center, mass) {
  const body = new CANNON.Body({
    mass: 0,     // 既定は静止。ぶん投げ ON で mass を入れる
    shape: new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2)),
    sleepSpeedLimit: 0.05,
    sleepTimeLimit: 0.4,
  });
  const item = {
    obj, body, mass,
    center: center.clone(),
    home: { pos: obj.position.clone(), quat: obj.quaternion.clone() },
  };
  syncBodyFromObject(item);
  phys.world.addBody(body);
  phys.items.push(item);
  return item;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

function syncBodyFromObject(item) {
  item.obj.updateMatrixWorld(true);
  _v.copy(item.center).applyQuaternion(item.obj.quaternion).add(item.obj.position);
  item.body.position.set(_v.x, _v.y, _v.z);
  const q = item.obj.quaternion;
  item.body.quaternion.set(q.x, q.y, q.z, q.w);
  item.body.velocity.setZero();
  item.body.angularVelocity.setZero();
}

function syncObjectFromBody(item) {
  const b = item.body;
  _q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  item.obj.quaternion.copy(_q);
  _v.copy(item.center).applyQuaternion(_q);
  item.obj.position.set(b.position.x - _v.x, b.position.y - _v.y, b.position.z - _v.z);
}

function setPhysicsEnabled(on) {
  phys.enabled = on;
  for (const it of phys.items) {
    // 壁は「ぶつけたら倒れる」専用なので、掴むモードでは動かさない
    if (it.isWall) continue;
    // 挿さったままのカセットは本体の一部として扱う (掴んだ時点で抜ける)
    if (on && it === cartItem && cassetteGroup.parent !== scene) {
      it.body.mass = 0;
      it.body.type = CANNON.Body.STATIC;
      it.body.updateMassProperties();
      continue;
    }
    if (on) {
      it.body.mass = it.mass;
      it.body.type = CANNON.Body.DYNAMIC;
      it.body.updateMassProperties();
      it.body.wakeUp();
      syncBodyFromObject(it);
    } else {
      it.body.mass = 0;
      it.body.type = CANNON.Body.STATIC;
      it.body.updateMassProperties();
      it.body.velocity.setZero();
      it.body.angularVelocity.setZero();
    }
  }
  if (!on) resetPhysics();
}

// 片付ける: 全部を元の位置に戻す
function resetPhysics() {
  for (const it of phys.items) {
    if (it.isWall) {          // 倒れた壁を立て直す
      it.body.mass = 0;
      it.body.type = CANNON.Body.STATIC;
      it.body.updateMassProperties();
    }
    if (it.reattach) it.reattach();
    it.obj.position.copy(it.home.pos);
    it.obj.quaternion.copy(it.home.quat);
    syncBodyFromObject(it);
    it.body.wakeUp();
  }
}

function stepPhysics(dt) {
  if (!phys.world) return;
  // 剛体は数個なので常に回す (缶や抜いたカセットは「ぶん投げ」OFF でも落ちる)
  phys.world.step(1 / 60, dt, 3);
  for (const it of phys.items) {
    if (it.body.type === CANNON.Body.DYNAMIC) syncObjectFromBody(it);
  }
}

// カセットを別のソフトに差し替えたときは、色とラベルを引き直す
function reskinCassette() {
  if (!cassetteGroup) return;
  const base = new THREE.Color(pickCartColor());
  cassetteGroup.traverse((o) => {
    if (!o.isMesh || !o.material || o.material.map) return;
    if (o.material.color && o.material.color.getHex() !== 0xd8b24a) {
      // 金メッキと基板以外をカセット色に
      const hex = o.material.color.getHex();
      if (hex !== 0x1d5c30 && hex !== 0xd8b24a) {
        o.material.color.copy(hex === 0x5a1414 ? base.clone().multiplyScalar(0.62)
          : (o.material.roughness > 0.52 ? base.clone().multiplyScalar(0.78) : base));
      }
    }
  });
  cartLabelText = document.getElementById('cart-label')?.textContent || '';
  drawCartLabel(cartLabelText);
}

// ------------------------------------------------------------ 殺虫スプレー
// カーソル(カメラ)にスプレー缶を持たせて、噴射でゴキブリを倒す
const spray = { on: false, can: null, puffs: [], t: 0 };

function buildSprayCan() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.032, 0.16, 20),
    new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 0.35, metalness: 0.5 })
  );
  g.add(body);
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0325, 0.0325, 0.05, 20),
    new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.6 })
  );
  band.position.y = 0.01;
  g.add(band);
  const shoulder = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.032, 0.03, 20),
    new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 0.35, metalness: 0.5 })
  );
  shoulder.position.y = 0.095;
  g.add(shoulder);
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.019, 0.019, 0.028, 16),
    new THREE.MeshStandardMaterial({ color: 0xd8d8dc, roughness: 0.5 })
  );
  cap.position.y = 0.124;
  g.add(cap);
  return g;
}

// 霧のスプライト用のふんわりしたテクスチャ
function fogTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.35, 'rgba(232,245,235,0.28)');
  grd.addColorStop(1, 'rgba(220,240,228,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function initSpray() {
  spray.can = buildSprayCan();
  spray.can.visible = false;
  scene.add(spray.can);       // ワールドに置いてカーソルへ追従させる

  // 噴射の霧 (常にカメラを向くスプライト)
  const tex = fogTexture();
  for (let i = 0; i < 90; i++) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false,
    }));
    m.visible = false;
    scene.add(m);
    spray.puffs.push({ mesh: m, life: 0, max: 1, vel: new THREE.Vector3(), spin: 0 });
  }
}

// カーソルの先にスプレー缶を構える
const _aimQ = new THREE.Quaternion(), _aimUp = new THREE.Vector3(0, 1, 0);
function aimSpray(origin, dir) {
  if (!spray.can) return;
  spray.can.position.copy(origin).addScaledVector(dir, 0.30);
  // カメラから見て少し下・右に構える
  const right = new THREE.Vector3().crossVectors(dir, _aimUp).normalize();
  const down = new THREE.Vector3().crossVectors(right, dir).normalize();
  spray.can.position.addScaledVector(right, 0.075).addScaledVector(down, -0.075);
  // 缶の +Y (ノズル) を照準方向へ向け、少しだけ寝かせる
  _aimQ.setFromUnitVectors(_aimUp, dir);
  spray.can.quaternion.copy(_aimQ);
  spray.can.rotateX(-0.45);
}

// ノズルの先端 (噴射の出どころ)
function nozzlePoint(out) {
  return out.set(0, 0.14, 0).applyQuaternion(spray.can.quaternion).add(spray.can.position);
}

function setSprayMode(on) {
  spray.on = on;
  if (spray.can) spray.can.visible = on;
  if (renderer) renderer.domElement.style.cursor = on ? 'crosshair' : '';
}

// 照準方向に噴射して、当たったゴキブリを倒す
function doSpray(origin, dir) {
  let n = 0;
  for (const p of spray.puffs) {
    if (p.life > 0 || n >= 26) continue;
    n++;
    // 出た直後は速くて細かく、進むほど広がって薄くなる
    const t = n / 26;
    p.max = 0.9 + Math.random() * 0.7;
    p.life = p.max;
    p.mesh.visible = true;
    p.mesh.scale.setScalar(0.02 + Math.random() * 0.02);
    p.mesh.material.opacity = 0;
    p.mesh.material.rotation = Math.random() * Math.PI;
    p.spin = (Math.random() - 0.5) * 1.2;
    p.mesh.position.copy(origin).addScaledVector(dir, t * 0.05);
    p.vel.copy(dir).multiplyScalar(2.0 + Math.random() * 2.2);
    p.vel.x += (Math.random() - 0.5) * 0.5;
    p.vel.y += (Math.random() - 0.5) * 0.5;
    p.vel.z += (Math.random() - 0.5) * 0.5;
  }
  // 噴射方向の細い円錐に入っているゴキブリを倒す
  const v = new THREE.Vector3();
  for (const r of roaches) {
    if (!r.state.alive || r.state.dying) continue;
    v.copy(r.object.position).sub(origin);
    const along = v.dot(dir);
    if (along < 0 || along > 3.2) continue;
    const perp = v.addScaledVector(dir, -along).length();
    if (perp < 0.10 + along * 0.06) r.kill();
  }
}

function updateSpray(dt) {
  for (const p of spray.puffs) {
    if (p.life <= 0) continue;
    p.life -= dt;
    const age = 1 - p.life / p.max;                 // 0 = 出たて, 1 = 消える寸前
    p.mesh.position.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(1 - dt * 2.2);             // 空気抵抗で減速
    p.vel.y += (0.25 - p.vel.y) * dt * 0.8;         // 漂って少しだけ上がる
    p.mesh.scale.setScalar(0.03 + age * 0.34);      // どんどん広がる
    p.mesh.material.rotation += p.spin * dt;
    // 出た瞬間は薄く、すぐ濃くなってからゆっくり消える
    p.mesh.material.opacity = Math.min(1, age * 6) * (1 - age) * 0.5;
    if (p.mesh.position.y < 0.01) p.mesh.position.y = 0.01;   // 床を這う
    if (p.life <= 0) { p.mesh.visible = false; p.mesh.material.opacity = 0; }
  }
}

// ------------------------------------------- カセットのドラッグ + 傾きゲージ HUD
const TILT_MAX = 6;

// 2D 側 (main.js) と同じ接触モデル。0 = 完全に浮いている, 1 = しっかり接触
function contactQuality(col, tilt) {
  if (tilt === 0) return 1;
  const x = (col / 29) * 2 - 1;                 // -1 (左) .. +1 (右)
  const lift = (tilt / TILT_MAX) * -x;          // 右回りは左側が浮く
  if (lift <= 0.15) return 1;
  if (lift >= 0.6) return 0;
  return 1 - (lift - 0.15) / 0.45;
}

const cartHud = {
  el: document.getElementById('cart-hud'),
  deg: document.getElementById('ch-deg'),
  needle: document.getElementById('ch-needle'),
  contact: document.getElementById('ch-contact'),
  pins: document.getElementById('ch-pins'),
  ins: document.getElementById('ch-ins'),
  insBar: document.getElementById('ch-ins-bar'),
};
const pinTicks = [];
if (cartHud.pins) {
  for (let i = 0; i < 30; i++) {
    const t = document.createElement('i');
    cartHud.pins.appendChild(t);
    pinTicks.push(t);
  }
}

function updateCartHud(tilt) {
  if (!cartHud.el) return;
  cartHud.deg.textContent = (tilt > 0 ? '+' : '') + tilt.toFixed(1) + '°';
  cartHud.needle.style.left = (50 + (tilt / TILT_MAX) * 50) + '%';
  const seat = insertion >= 0.75 ? 1 : (insertion <= 0.25 ? 0 : (insertion - 0.25) / 0.5);
  if (cartHud.ins) {
    cartHud.ins.textContent = tt('hudInsertion', { p: Math.round(insertion * 100) });
    cartHud.insBar.style.width = Math.round(insertion * 100) + '%';
  }
  let sum = 0;
  for (let i = 0; i < 30; i++) {
    const q = contactQuality(i, tilt) * seat;
    const t = pinTicks[i];
    t.className = q >= 1 ? '' : (q <= 0 ? 'off' : 'weak');
    sum += q;
  }
  // 表と裏で同じ列を共有するので 60 ピン換算 (接触が甘いピンは割合で数える)
  cartHud.contact.textContent = tt('hudContacts', { n: Math.round(sum * 2), total: 60 });
}

// 差し込み具合 0 (抜けている) .. 1 (奥まで)
let insertion = 1;
const EXTRACT_TRAVEL = 0.075;   // 完全に抜けるまでの距離 (m)
let cartHome = null;            // 挿さっているときのローカル位置

function setInsertion(v) {
  insertion = Math.max(0, Math.min(1, v));
  if (cassetteGroup && cartHome && cassetteGroup.parent !== scene) {
    cassetteGroup.position.y = cartHome.y + (1 - insertion) * EXTRACT_TRAVEL;
  }
  pushInsertion();
  updateCartHud(parseFloat(cartSlider.value) || 0);
}

// 実際にコアへ渡す差し込み量。衝撃 (bump) の間は接点が浮いたことにする
function pushInsertion() {
  if (window.NES_CART) window.NES_CART.setInsertion(insertion * (1 - bump * 0.6));
}

function bindPointer(canvas) {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane();
  const hitPt = new THREE.Vector3(), target = new THREE.Vector3(), grabOff = new THREE.Vector3();
  let mode = null;          // null | 'cart' | 'throw' | 'plug'
  let hovering = null;      // null | 'cart' | 'crt' | 'plug' | 'thing'
  let grabbedCable = null;
  let startX = 0, startY = 0, startTilt = 0, startIns = 1;

  const setNdc = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const setTilt = (deg) => {
    const v = Math.max(-TILT_MAX, Math.min(TILT_MAX, Math.round(deg * 10) / 10));
    cartSlider.value = v;
    cartSlider.dispatchEvent(new Event('input'));
    updateCartHud(v);
  };

  // 一番手前のものを拾う。プラグやスイッチのような小物は少しだけ優遇する
  const pick = (e) => {
    setNdc(e);
    let best = null;
    const consider = (obj, what, extra, bias = 0) => {
      if (!obj) return;
      const h = ray.intersectObject(obj, true);
      if (!h.length) return;
      const d = h[0].distance - bias;
      if (!best || d < best.d) best = Object.assign({ d, what, point: h[0].point }, extra);
    };
    if (cables) for (const p of cables.plugMeshes) consider(p, 'plug', { cable: p.userData.cable }, 0.28);
    consider(convSwitch, 'switch', {}, 0.22);
    for (const r of roaches) if (r.object.visible) consider(r.object, 'roach', { roach: r }, 0.22);
    consider(cassetteGroup, 'cart', {}, 0.10);
    for (const it of phys.items) {
      if (it.isWall || it.obj === cassetteGroup) continue;   // 壁は掴めない (ぶつけて倒すだけ)
      const what = it === crtItem ? 'crt' : (it === famItem ? 'famicom' : 'thing');
      consider(it.obj, what, { item: it });
    }
    return best;
  };

  const placeHudAt = (el, e) => {
    if (!el) return;
    const r = wrap.getBoundingClientRect();
    const w = el.offsetWidth || 176, h = el.offsetHeight || 110;
    let x = e.clientX - r.left + 16, y = e.clientY - r.top + 16;
    x = Math.max(4, Math.min(r.width - w - 4, x));
    y = Math.max(4, Math.min(r.height - h - 4, y));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  };
  const placeCartHud = (e) => placeHudAt(cartHud.el, e);
  const showFcHud = (on, e) => {
    if (!fcHud.el) return;
    if (on && !fcHud.el.classList.contains('on')) placeHudAt(fcHud.el, e);
    if (on) refreshFcHud();
    fcHudToggle(on);
  };

  const showCartHud = (on, e) => {
    if (!cartHud.el) return;
    cartHud.el.classList.toggle('on', on);
    if (on) {
      updateCartHud(parseFloat(cartSlider.value) || 0);
      if (e) placeCartHud(e);
    }
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (spray.on) {
      // スプレーモード: ノズルの先から照準方向へ噴射
      setNdc(e);
      aimSpray(ray.ray.origin, ray.ray.direction);
      doSpray(nozzlePoint(new THREE.Vector3()), ray.ray.direction.clone());
      sfx.spray();
      return;
    }
    const hit = pick(e);
    if (!hit) return;

    if (hit.what === 'switch') {
      // RF コンバータの ゲーム / TV 切替
      convGame = !convGame;
      convSwitch.position.x = convGame ? 0.010 : 0.026;
      return;
    }
    if (hit.what === 'roach') {
      hit.roach.scare();
      return;
    }
    if (hit.what === 'plug') {
      // --- プラグを抜く / 挿す ---
      mode = 'plug';
      grabbedCable = hit.cable;
      cables.grab(grabbedCable);
      hitPt.copy(hit.point);
      plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(_v).clone().negate(), hitPt);
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (phys.enabled && (hit.item || hit.what === 'cart')) {
      // --- 掴んで投げる ---
      const item = hit.item || cartItem;
      if (!item) return;
      if (item.detachOnEnable) item.detachOnEnable();
      mode = 'throw';
      phys.grab = item;
      item.body.wakeUp();
      hitPt.copy(hit.point);
      plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(_v).clone().negate(), hitPt);
      grabOff.set(item.body.position.x, item.body.position.y, item.body.position.z).sub(hitPt);
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (hit.what === 'cart') {
      // --- 傾ける / 抜き差しする ---
      mode = 'cart';
      startX = e.clientX;
      startY = e.clientY;
      startTilt = parseFloat(cartSlider.value) || 0;
      startIns = insertion;
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      showCartHud(true, e);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (mode === 'plug' && grabbedCable) {
      setNdc(e);
      if (ray.ray.intersectPlane(plane, target)) cables.moveTo(grabbedCable, target);
      return;
    }
    if (mode === 'throw' && phys.grab) {
      setNdc(e);
      if (ray.ray.intersectPlane(plane, target)) {
        target.add(grabOff);
        const b = phys.grab.body;
        // ばねで引っぱる感じ (瞬間移動させないので、そのまま投げられる)
        b.velocity.set(
          (target.x - b.position.x) * 12,
          (target.y - b.position.y) * 12,
          (target.z - b.position.z) * 12
        );
        b.angularVelocity.scale(0.85, b.angularVelocity);
      }
      return;
    }
    if (spray.on) {
      setNdc(e);
      aimSpray(ray.ray.origin, ray.ray.direction);
      return;
    }
    if (mode === 'cart') {
      // 横 = 傾ける / 縦 = 抜き差し (大きく動いた方を採用)
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dy) > Math.abs(dx)) setInsertion(startIns + dy * 0.007);
      else setTilt(startTilt + dx * 0.04);
      placeCartHud(e);
      return;
    }
    // --- ホバー ---
    const hit = pick(e);
    const what = hit ? hit.what : null;
    if (what !== hovering) {
      hovering = what;
      showCartHud(what === 'cart', e);
      showRoomHud(what === 'crt');
      showFcHud(what === 'famicom', e);
      canvas.style.cursor = spray.on ? 'crosshair' : (what ? 'grab' : '');
    } else if (what === 'cart') {
      placeCartHud(e);
    } else if (what === 'famicom') {
      placeHudAt(fcHud.el, e);
    }
  });

  const end = () => {
    if (mode === 'plug' && grabbedCable) {
      const wasIn = cables.release(grabbedCable);
      if (wasIn) sfx.plug();
      grabbedCable = null;
    }
    if (mode === 'throw' && phys.grab) {
      // 離した瞬間の速度でそのまま飛んでいく
      phys.grab.body.velocity.scale(1.15, phys.grab.body.velocity);
      phys.grab = null;
    }
    // 完全に抜いたら手を離した時点で畳に落ちる
    if (mode === 'cart' && insertion <= 0.02 && cartItem) cartItem.detachOnEnable();
    mode = null;
    controls.enabled = true;
    canvas.style.cursor = hovering ? 'grab' : '';
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => {
    hovering = null;
    showCartHud(false);
    showRoomHud(false);
    showFcHud(false);
  });
}

// ---------------------------------------------------------------- 初期化 / ループ
function init() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.id = 'room-canvas';
  wrap.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0c0b);

  initPhysics();          // 壁を剛体として登録するので、部屋より先に世界を作る

  const room = buildRoom();
  scene.add(room);
  placeholders.room = room;
  registerWalls(room);
  buildOutside();

  const TV_Z = -ROOM_D / 2 + 0.30;    // テレビは奥の壁ぎわ
  const stand = buildTvStand();
  stand.position.set(0, 0, TV_Z);
  scene.add(stand);

  const crt = buildCrt();
  // 天板の上面 (y=0.4715) にちょうど乗せる。roundedBox のベベル 4mm 分を足す
  crt.position.set(0, 0.4755, TV_Z);
  scene.add(crt);
  placeholders.crt = crt;

  const fc = buildFamicom();
  fc.position.set(0.30, 0.004, TV_Z + 0.62);   // ベベル分を持ち上げて畳にめり込ませない
  fc.rotation.y = -0.42;
  scene.add(fc);
  placeholders.famicom = fc;
  placeholders.cassette = cassetteGroup;
  cartHome = cassetteGroup.position.clone();

  // --- 剛体を登録 (寸法はローカル、中心はオブジェクト原点からのオフセット) ---
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  standItem = addPhysicsItem(stand, V(0.628, 0.4715, 0.44), V(0, 0.236, 0), 9);
  crtItem = addPhysicsItem(crt, V(0.428, 0.388, 0.40), V(0, 0.190, 0), 11);
  famItem = addPhysicsItem(fc, V(0.150, 0.055, 0.220), V(0, 0.0275, 0), 0.62);
  cartItem = addPhysicsItem(
    cassetteGroup,
    V(CART_W, CART_H + EDGE_H, CART_D),
    V(0, (CART_H + EDGE_H) / 2, 0),
    0.06
  );
  // カセットは本体の子なので、投げる前にワールドへ切り離す
  // 抜けた瞬間にワールドへ切り離して、そのまま落ちる/投げられるようにする
  cartItem.detachOnEnable = () => {
    if (cassetteGroup.parent === scene) return;
    cassetteGroup.updateMatrixWorld(true);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    cassetteGroup.matrixWorld.decompose(p, q, s);
    scene.add(cassetteGroup);
    cassetteGroup.position.copy(p);
    cassetteGroup.quaternion.copy(q);
    setInsertion(0);
    syncBodyFromObject(cartItem);
    cartItem.body.mass = cartItem.mass;
    cartItem.body.type = CANNON.Body.DYNAMIC;
    cartItem.body.updateMassProperties();
    cartItem.body.wakeUp();
  };
  cartItem.reattach = () => {
    cartItem.body.mass = 0;
    cartItem.body.type = CANNON.Body.STATIC;
    cartItem.body.updateMassProperties();
    if (cassetteGroup.parent === fc) return;
    fc.add(cassetteGroup);
    cassetteGroup.position.copy(cartHome);
    cassetteGroup.quaternion.identity();
    setInsertion(1);
  };
  cartItem.home.pos.copy(cartHome);

  // --- 端子とケーブル ---
  cables = createCables(scene);
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const BACK = V3(0, 0, -1), FRONT = V3(0, 0, 1);

  // 壁のコンセント (奥の壁ぎわ)
  const outlet = new THREE.Group();
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, 0.115, 0.008),
    new THREE.MeshStandardMaterial({ color: 0xeae4d6, roughness: 0.7 })
  );
  outlet.add(plate);
  for (const y of [0.026, -0.026]) {
    for (const x of [-0.011, 0.011]) {
      const slot = new THREE.Mesh(
        new THREE.BoxGeometry(0.004, 0.014, 0.004),
        new THREE.MeshStandardMaterial({ color: 0x111111 })
      );
      slot.position.set(x, y, 0.004);
      outlet.add(slot);
    }
  }
  // 壁に固定する (壁の子にするので、壁が倒れれば一緒に倒れる)
  const backWall = (room.userData.walls || [])[0];
  if (backWall) {
    outlet.position.set(-0.85, 0.20 - ROOM_H / 2, 0.06 / 2 + 0.004);
    backWall.add(outlet);
  } else {
    outlet.position.set(-0.85, 0.20, -ROOM_D / 2 + 0.008);
    scene.add(outlet);
  }

  // RF コンバータ (ファミコンとテレビの間の白い箱)
  const conv = buildConverter();
  conv.position.set(0.12, 0.004, TV_Z + 0.34);
  conv.rotation.y = -0.25;
  scene.add(conv);
  placeholders.converter = conv;
  convItem = addPhysicsItem(conv, V3(CONV_W, CONV_H, CONV_D), V3(0, CONV_H / 2, 0), 0.12);

  const sockFcRf = cables.addSocket('fc-rf', fc, V3(0.035, 0.022, -0.112), BACK, 0x9a9a9c);
  const sockFcDc = cables.addSocket('fc-dc', fc, V3(-0.040, 0.022, -0.112), BACK);
  const sockTvAnt = cables.addSocket('tv-ant', crt, V3(-0.12, 0.10, -0.202), BACK, 0x9a9a9c);
  const sockTvAc = cables.addSocket('tv-ac', crt, V3(0.12, 0.055, -0.202), BACK);
  const sockOut1 = cables.addSocket('outlet-1', outlet, V3(0, 0.026, 0.006), FRONT, 0xeae4d6);
  const sockOut2 = cables.addSocket('outlet-2', outlet, V3(0, -0.026, 0.006), FRONT, 0xeae4d6);

  const sockConvIn = cables.addSocket('conv-in', conv, V3(-0.028, 0.012, CONV_D / 2 + 0.002), FRONT, 0x9a9a9c);
  const sockConvOut = cables.addSocket('conv-out', conv, V3(0.028, 0.012, -CONV_D / 2 - 0.002), BACK, 0x9a9a9c);

  // RF は 本体 -> コンバータ -> テレビ の 2 本
  cables.onPull(() => sfx.unplug());
  cables.addCable({ name: 'rf-in', from: sockFcRf, to: sockConvIn, color: 0x2b2b2e, radius: 0.0032, slack: 1.4 });
  cables.addCable({ name: 'rf-out', from: sockConvOut, to: sockTvAnt, color: 0x2b2b2e, radius: 0.0032, slack: 1.35 });
  cables.addCable({ name: 'tv-power', from: sockTvAc, to: sockOut1, color: 0x17171a, radius: 0.0036, slack: 1.3 });
  cables.addCable({ name: 'fc-power', from: sockFcDc, to: sockOut2, color: 0x17171a, radius: 0.0030, slack: 1.3 });

  // 衝撃 -> テレビは画面が歪む / 本体とカセットは接点が跳ねてバグる
  watchImpacts(crtItem, (v) => { shock = Math.min(1, shock + v); });
  watchImpacts(standItem, (v) => { shock = Math.min(1, shock + v * 0.5); });
  watchImpacts(famItem, (v) => { bump = Math.min(1, bump + v); });
  watchImpacts(cartItem, (v) => { bump = Math.min(1, bump + v * 0.8); });

  // --- 小物: ゴキブリ / 雨漏り / ジュース ---
  // 1匹目だけは勝手に出てくる。ボタンを押すたびに増える
  roach = createRoach(scene, { w: ROOM_W, d: ROOM_D });
  roaches.push(roach);
  leak = createLeak(scene, { x: -0.55, z: TV_Z + 0.75, ceilingY: ROOM_H });
  leak.setEnabled(false);
  leak.onSplash((p) => {
    // 本体の真上から落ちたら濡れて接触不良になる
    const fb = new THREE.Box3().setFromObject(fc);
    if (p.x > fb.min.x - 0.05 && p.x < fb.max.x + 0.05 && p.z > fb.min.z - 0.05 && p.z < fb.max.z + 0.05) {
      juiceFault = Math.min(1, juiceFault + 0.25);
    }
  });
  can = createCan(scene, new THREE.Vector3(0.62, 0.004, TV_Z + 0.80));
  canItem = addPhysicsItem(can.object, V3(0.066, can.height, 0.066), V3(0, can.height / 2, 0), 0.38);

  // たらい (天井から降ってくる)
  tarai = createTarai(scene);
  tarai.object.name = 'tarai';
  tarai.object.position.set(0, ROOM_H + 1, 0);
  taraiItem = addPhysicsItem(
    tarai.object,
    V3(tarai.radius * 2, tarai.height, tarai.radius * 2),
    V3(0, tarai.height / 2, 0), 3.2
  );
  watchImpacts(taraiItem, () => sfx.clang());

  const hemi = new THREE.HemisphereLight(0xfff0d8, 0x7a6446, LIGHT_BASE.hemi);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff2d8, LIGHT_BASE.key);
  key.position.set(1.6, 2.2, 1.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -3;
  key.shadow.camera.right = key.shadow.camera.top = 3;
  scene.add(key);
  lights = { hemi, key, glow: crt.getObjectByProperty('isPointLight', true) };
  applyHud();

  // 部屋全体が見えるところから始める (寄るのはホイールで)
  camera = new THREE.PerspectiveCamera(45, 1, 0.02, 40);
  camera.position.set(0.55, 1.25, TV_Z + 2.35);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.60, TV_Z + 0.15);
  controls.enableDamping = true;
  controls.minDistance = 0.25;
  controls.maxDistance = 3.4;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.update();

  initSpray();
  bindPointer(renderer.domElement);
  // 既定で掴めるようにしておく
  setPhysicsEnabled(true);
  if (physBtn) physBtn.classList.add('on');
  // デバッグ用フック (コンソールから触れるように)
  window.__room = {
    THREE, CANNON, renderer, scene, camera, controls, placeholders, drawOsd,
    material: () => screenMat, phys, setInsertion, getInsertion: () => insertion,
    cables, roaches, leak, can, spawnRoach, spray, doSpray, setSprayMode, sfx,
  };
  resize();
  new ResizeObserver(resize).observe(wrap);
  tryLoadModels();
}

function resize() {
  if (!renderer) return;
  const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

let fps = 60, osdFps = 60, lastFrame = 0, osdAt = 0;

// ケーブルの抜き差しを実際の動作に反映する
let lastTvPower = true, lastFcPower = true;
function syncCablePower() {
  if (!cables) return;
  const tv = cables.isConnected('tv-power');
  if (tv !== lastTvPower) {
    lastTvPower = tv;
    if (screenMat) screenMat.uniforms.power.value = tv ? 1 : 0;
    if (lights && lights.glow) lights.glow.visible = tv;
    if (tv) sfx.tvOn(); else sfx.tvOff();
  }
  const fcp = cables.isConnected('fc-power');
  if (fcp !== lastFcPower) {
    lastFcPower = fcp;
    // AC アダプタを抜いたら本体の電源が落ちる (挿し直したら入る)
    const pw = document.getElementById('btn-power');
    const on = pw && pw.classList.contains('power-on');
    if (pw && on !== fcp) { pw.click(); sfx.powerSwitch(fcp); }
  }
}

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 1 / 60;
  if (lastFrame) fps += ((1000 / Math.max(1, now - lastFrame)) - fps) * 0.1;
  lastFrame = now;

  stepPhysics(dt);

  const tilt = parseFloat(cartSlider.value) || 0;
  // 物理で飛んでいる間は姿勢を物理側に任せる
  if (cassetteGroup && cassetteGroup.parent !== scene) {
    cassetteGroup.rotation.z = -tilt * Math.PI / 180;
  }

  if (cables) cables.update(dt);
  syncCablePower();
  for (const r of roaches) r.update(dt);
  updateSpray(dt);
  if (leak) leak.update(dt);
  if (can) {
    can.update(dt);
    // こぼれたジュースが本体に届いたらベタベタで接触不良に
    if (famItem && can.soaks(famItem.obj.position)) juiceFault = Math.min(1, juiceFault + dt * 0.5);
  }
  // 乾く (ゆっくり)
  if (juiceFault > 0) juiceFault = Math.max(0, juiceFault - dt * 0.012);
  // 衝撃はすぐ収まる
  if (shock > 0) shock = Math.max(0, shock - dt * 1.6);
  if (bump > 0) {
    bump = Math.max(0, bump - dt * 2.2);
    pushInsertion();
  }

  // 映りの良さ = UHF感度 x 同調 x 端子の接触 x RFケーブル
  const seat = insertion >= 0.75 ? 1 : (insertion <= 0.25 ? 0 : (insertion - 0.25) / 0.5);
  // RF 経路: 本体 -> コンバータ -> テレビ。スイッチが TV 側なら当然映らない
  const rf = !cables ? 1
    : ((cables.isConnected('rf-in') && cables.isConnected('rf-out') && convGame) ? 1 : 0);
  // ジュース/水をかぶると接点がベタついてチラつく
  const wet = 1 - juiceFault * (0.55 + 0.45 * Math.abs(Math.sin(now / 130)));
  const q = Math.max(0, Math.min(1,
    uhfGain() * tuneQuality() * (1 - Math.abs(tilt) / 6) * seat * rf * wet));
  if (screenMat) {
    screenMat.uniforms.time.value = now / 1000;
    screenMat.uniforms.signalQ.value = q;
    screenMat.uniforms.detune.value = detuneVal();
    // RF が繋がっていない / カセットが抜けている = 電波が来ていないので純粋な砂嵐
    screenMat.uniforms.carrier.value = (rf && seat > 0) ? 1 : 0;
    screenMat.uniforms.shock.value = shock;
  }
  // 画面 + OSD を合成 (毎フレーム)。数値の更新は 4Hz でチラつかせない。
  if (now - osdAt > 250) {
    osdAt = now;
    osdFps = fps;
    // カセットのラベルは 2D 側の表示 (ROM 名) に追従させる
    const t2 = document.getElementById('cart-label');
    if (t2 && t2.textContent !== cartLabelText) {
      cartLabelText = t2.textContent;
      drawCartLabel(cartLabelText);
    }
  }
  drawOsd(q, osdFps);
  // HUD が出ている間は 2D 側の操作にも追従させる
  if (cartHud.el && cartHud.el.classList.contains('on')) updateCartHud(tilt);
  {
    if (hud.read) {
      hud.read.textContent = tt('hudRead', {
        q: Math.round(q * 100), t: tilt.toFixed(1), fps: fps.toFixed(0),
      });
    }
  }
  controls.update();
  renderer.render(scene, camera);
}

function setRoom(on) {
  if (on && !started) {
    started = true;
    try {
      init();
    } catch (e) {
      // WebGL が使えない環境では 2D のままにする
      console.error('[room] 3D init failed:', e);
      document.body.classList.remove('room-on');
      running = false;
      return;
    }
  }
  document.body.classList.toggle('room-on', on);
  running = on;
  if (on) { resize(); loop(); }
}

const btn = document.getElementById('btn-room');
btn.addEventListener('click', () => {
  setRoom(!running);
  localStorage.setItem('roomOn', running ? '1' : '0');
});

// 既定は 3D。?room=0 で 2D 起動、ボタンで切り替えた状態は次回も引き継ぐ。
{
  const q = new URLSearchParams(location.search).get('room');
  const on = q === '0' ? false : (q === '1' ? true : localStorage.getItem('roomOn') !== '0');
  if (on) setRoom(true);
}
