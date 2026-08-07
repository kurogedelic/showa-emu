'use strict';
// ---------------------------------------------------------------------------
// 部屋の効果音。音源は持たず WebAudio で合成する。
//   plug/unplug (プラグの抜き差し)、power on/off (ブラウン管の入切)、
//   thud (物がぶつかる)、spray (シューッ)、pop (缶を置く)
// エミュレータ本体の音とは別系統 (ミュートの影響も受けない)
// ---------------------------------------------------------------------------

let ctx = null;
let master = null;
let enabled = true;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  return ctx;
}

// ユーザー操作のたびに resume を試みる (自動再生制限)
['pointerdown', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, () => {
    const c = ensure();
    if (c && c.state !== 'running') c.resume().catch(() => {});
  }, { passive: true }));

function noiseBuffer(sec) {
  const c = ensure();
  const n = Math.floor(c.sampleRate * sec);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function noise(dur, { gain = 0.3, type = 'bandpass', freq = 1200, q = 1, sweepTo = null } = {}) {
  const c = ensure();
  if (!c || !enabled) return;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(dur);
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, c.currentTime);
  f.Q.value = q;
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, c.currentTime + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start();
  src.stop(c.currentTime + dur);
}

function tone(freq, dur, { gain = 0.2, type = 'sine', to = null, delay = 0 } = {}) {
  const c = ensure();
  if (!c || !enabled) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export const sfx = {
  setEnabled(v) { enabled = v; },
  setVolume(v) { if (master) master.gain.value = v; },

  // プラグを抜く: カチッ + 短いノイズ
  unplug() { noise(0.09, { gain: 0.35, freq: 2600, q: 1.2, sweepTo: 600 }); tone(180, 0.05, { gain: 0.12, type: 'square' }); },
  // プラグを挿す: 手応えのある「カチッ」
  plug() { noise(0.05, { gain: 0.3, freq: 1800, q: 2 }); tone(420, 0.06, { gain: 0.16, type: 'square', to: 260 }); },

  // ブラウン管の電源が入る: 高圧のポップ + フライバックの高音
  tvOn() {
    noise(0.12, { gain: 0.28, freq: 300, q: 0.8, sweepTo: 3000 });
    tone(15700, 0.5, { gain: 0.03, type: 'sine' });
    tone(90, 0.18, { gain: 0.18, type: 'sine', to: 240 });
  },
  // 電源が落ちる: 「ボスッ」と落ちて消える
  tvOff() {
    tone(240, 0.22, { gain: 0.2, type: 'sine', to: 60 });
    noise(0.18, { gain: 0.2, freq: 1800, q: 0.7, sweepTo: 180 });
  },
  // ファミコンの電源スイッチ: 硬いカチッ
  powerSwitch(on) {
    noise(0.04, { gain: 0.32, freq: on ? 2400 : 1600, q: 3 });
    tone(on ? 520 : 320, 0.05, { gain: 0.14, type: 'square' });
  },
  // 何かがぶつかった
  thud(v = 1) {
    tone(70 + Math.random() * 20, 0.16, { gain: 0.1 + 0.22 * v, type: 'sine', to: 40 });
    noise(0.09, { gain: 0.08 + 0.2 * v, freq: 400, q: 0.6, sweepTo: 120 });
  },
  // 殺虫スプレー
  spray() { noise(0.42, { gain: 0.22, type: 'highpass', freq: 2200, q: 0.4, sweepTo: 5200 }); },
  // たらいが当たる「ガラーン」
  clang() {
    const base = 520 + Math.random() * 120;
    [1, 1.51, 2.03, 2.71].forEach((r, i) =>
      tone(base * r, 1.1 - i * 0.16, { gain: 0.16 / (i + 1), type: 'triangle' }));
    noise(0.12, { gain: 0.25, freq: 2600, q: 0.8, sweepTo: 700 });
  },
  // 壁が倒れる
  crash() {
    noise(0.7, { gain: 0.3, type: 'lowpass', freq: 900, q: 0.5, sweepTo: 120 });
    tone(90, 0.5, { gain: 0.24, type: 'sine', to: 45 });
    tone(140, 0.35, { gain: 0.14, type: 'square', to: 60, delay: 0.08 });
  },
  // 光線銃の発射音
  zap() {
    tone(1400, 0.09, { gain: 0.2, type: 'square', to: 180 });
    noise(0.07, { gain: 0.18, freq: 3200, q: 0.8, sweepTo: 600 });
  },
  // 光線の発射音 (ピシュン)
  beam() {
    tone(2400, 0.16, { gain: 0.22, type: 'sawtooth', to: 220 });
    tone(1200, 0.10, { gain: 0.12, type: 'square', to: 140, delay: 0.02 });
    noise(0.14, { gain: 0.14, type: 'highpass', freq: 2600, q: 0.5, sweepTo: 900 });
  },
  // 一升瓶をあおる
  gulp() {
    [0, 0.28, 0.56].forEach((d) => {
      tone(150 + Math.random() * 60, 0.11, { gain: 0.16, type: 'sine', to: 90, delay: d });
      noise(0.06, { gain: 0.1, freq: 700, q: 1.5 });
    });
  },
  // 缶を置く
  can() { noise(0.06, { gain: 0.2, freq: 900, q: 2 }); tone(660, 0.09, { gain: 0.1, type: 'triangle', to: 380 }); },
};
