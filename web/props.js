'use strict';
// ---------------------------------------------------------------------------
// 部屋の小物: ゴキブリ / 雨漏り / オレンジジュースの缶
// どれも「エミュレータの調子を崩す」ところまで繋がっている
// ---------------------------------------------------------------------------
import * as THREE from 'three';

// ------------------------------------------------------------------ ゴキブリ
export function createRoach(scene, bounds) {
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x2a1a0e, roughness: 0.35, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x140c06, roughness: 0.5 });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 10), shell);
  body.scale.set(1, 0.55, 1.9);
  body.position.y = 0.006;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.006, 10, 8), dark);
  head.position.set(0, 0.006, 0.019);
  g.add(head);
  // 羽の合わせ目
  const seam = new THREE.Mesh(new THREE.BoxGeometry(0.0008, 0.001, 0.026), dark);
  seam.position.set(0, 0.012, -0.002);
  g.add(seam);

  const legs = [];
  for (let i = 0; i < 6; i++) {
    const side = i % 2 ? 1 : -1;
    const row = Math.floor(i / 2);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0007, 0.0005, 0.014, 5), dark);
    leg.position.set(side * 0.009, 0.004, 0.010 - row * 0.011);
    leg.rotation.z = side * 1.0;
    leg.rotation.x = (row - 1) * 0.3;
    g.add(leg);
    legs.push(leg);
  }
  for (const side of [-1, 1]) {   // 触角
    const a = new THREE.Mesh(new THREE.CylinderGeometry(0.0004, 0.0002, 0.026, 4), dark);
    a.position.set(side * 0.004, 0.008, 0.030);
    a.rotation.set(-1.15, 0, side * 0.35);
    g.add(a);
  }
  g.visible = false;
  scene.add(g);

  const st = {
    group: g, enabled: true, alive: false, t: 0, next: 6 + Math.random() * 14,
    heading: 0, speed: 0, burst: 0, life: 0, panic: 0, walk: 0,
  };

  function spawn() {
    const edge = Math.floor(Math.random() * 4);
    const { w, d } = bounds;
    const p = [
      [(Math.random() - 0.5) * w, -d / 2 + 0.05],
      [(Math.random() - 0.5) * w, d / 2 - 0.05],
      [-w / 2 + 0.05, (Math.random() - 0.5) * d],
      [w / 2 - 0.05, (Math.random() - 0.5) * d],
    ][edge];
    g.position.set(p[0], 0.002, p[1]);
    st.heading = Math.atan2(-p[0], -p[1]) + (Math.random() - 0.5) * 1.2;
    st.alive = true;
    st.life = 7 + Math.random() * 6;
    st.burst = 0;
    st.panic = 0;
    g.visible = true;
  }

  function update(dt) {
    if (!st.alive) {
      if (!st.enabled) return;
      st.t += dt;
      if (st.t >= st.next) { st.t = 0; st.next = 14 + Math.random() * 26; spawn(); }
      return;
    }
    st.life -= dt;
    st.panic = Math.max(0, st.panic - dt);
    st.burst -= dt;
    if (st.burst <= 0) {   // 走る / 止まるを繰り返す (ゴキブリらしい動き)
      const running = st.speed < 0.02;
      st.speed = running ? 0.22 + Math.random() * 0.35 : 0;
      st.burst = running ? 0.25 + Math.random() * 0.5 : 0.15 + Math.random() * 0.5;
      if (running) st.heading += (Math.random() - 0.5) * 1.3;
    }
    const sp = st.speed * (st.panic > 0 ? 3.2 : 1);
    g.position.x += Math.sin(st.heading) * sp * dt;
    g.position.z += Math.cos(st.heading) * sp * dt;
    g.rotation.y = st.heading;
    // 脚をカサカサ動かす
    st.walk += sp * dt * 60;
    for (let i = 0; i < legs.length; i++) {
      legs[i].rotation.x = ((i % 2) ? 1 : -1) * Math.sin(st.walk + i) * 0.4 + (Math.floor(i / 2) - 1) * 0.3;
    }
    // 壁で跳ね返る
    const { w, d } = bounds;
    if (Math.abs(g.position.x) > w / 2 - 0.03) { st.heading = -st.heading; g.position.x = Math.sign(g.position.x) * (w / 2 - 0.03); }
    if (Math.abs(g.position.z) > d / 2 - 0.03) { st.heading = Math.PI - st.heading; g.position.z = Math.sign(g.position.z) * (d / 2 - 0.03); }
    if (st.life <= 0) { st.alive = false; g.visible = false; }
  }

  return {
    object: g, state: st, update,
    summon: () => { if (!st.alive) spawn(); },
    scare: () => { st.panic = 1.6; st.speed = 0.5; st.burst = 1.6; st.heading += Math.PI * (0.6 + Math.random() * 0.8); },
    setEnabled: (v) => { st.enabled = v; if (!v) { st.alive = false; g.visible = false; } },
  };
}

// ------------------------------------------------------------------ 雨漏り
export function createLeak(scene, { x, z, ceilingY }) {
  const grp = new THREE.Group();
  scene.add(grp);

  // 天井のシミ
  const stain = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 24),
    new THREE.MeshStandardMaterial({ color: 0x5a4a30, roughness: 1, transparent: true, opacity: 0.75 })
  );
  stain.rotation.x = Math.PI / 2;
  stain.position.set(x, ceilingY - 0.002, z);
  grp.add(stain);

  // 畳のシミ (だんだん広がる)
  const puddle = new THREE.Mesh(
    new THREE.CircleGeometry(1, 28),
    new THREE.MeshStandardMaterial({ color: 0x4a4a30, roughness: 0.35, transparent: true, opacity: 0.55 })
  );
  puddle.rotation.x = -Math.PI / 2;
  puddle.position.set(x, 0.0015, z);
  puddle.scale.setScalar(0.001);
  grp.add(puddle);

  const dropGeo = new THREE.SphereGeometry(0.006, 8, 6);
  const dropMat = new THREE.MeshPhysicalMaterial({
    color: 0x9fc4e8, roughness: 0.05, transmission: 0.7, transparent: true, opacity: 0.85,
  });
  const drops = [];
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(dropGeo, dropMat);
    m.visible = false;
    m.scale.set(0.7, 1.5, 0.7);
    grp.add(m);
    drops.push({ mesh: m, y: 0, v: 0, active: false });
  }

  const st = { enabled: false, t: 0, interval: 1.1, wet: 0, onSplash: null };

  function update(dt) {
    if (st.enabled) {
      st.t += dt;
      if (st.t >= st.interval) {
        st.t = 0;
        const d = drops.find((x2) => !x2.active);
        if (d) {
          d.active = true;
          d.y = ceilingY - 0.02;
          d.v = 0;
          d.mesh.position.set(x + (Math.random() - 0.5) * 0.02, d.y, z + (Math.random() - 0.5) * 0.02);
          d.mesh.visible = true;
        }
      }
    }
    for (const d of drops) {
      if (!d.active) continue;
      d.v += -9.8 * dt;
      d.y += d.v * dt;
      d.mesh.position.y = d.y;
      if (d.y <= 0.004) {
        d.active = false;
        d.mesh.visible = false;
        st.wet = Math.min(1, st.wet + 0.02);
        puddle.scale.setScalar(0.04 + st.wet * 0.34);
        if (st.onSplash) st.onSplash(d.mesh.position.clone());
      }
    }
  }

  return {
    object: grp, state: st, update,
    setEnabled: (v) => { st.enabled = v; grp.visible = v || st.wet > 0; },
    dry: () => { st.wet = 0; puddle.scale.setScalar(0.001); },
    get wet() { return st.wet; },
    onSplash: (fn) => { st.onSplash = fn; },
    position: new THREE.Vector3(x, 0, z),
  };
}

// -------------------------------------------------------- オレンジジュースの缶
function canLabelTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#e8641a';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(0, 52, 256, 26);
  g.fillStyle = '#e8641a';
  g.font = 'bold 22px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('ORANGE', 128, 66);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = 'bold 12px system-ui, sans-serif';
  g.fillText('SODA  350ml', 128, 96);
  // みかんの絵
  g.beginPath(); g.arc(46, 26, 15, 0, Math.PI * 2); g.fillStyle = '#ffb03a'; g.fill();
  g.beginPath(); g.arc(210, 26, 15, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCan(scene, pos) {
  // 350ml 缶: 直径 66mm x 高さ 122mm
  const R = 0.033, H = 0.122;
  const g = new THREE.Group();
  const alu = new THREE.MeshStandardMaterial({ color: 0xd8d8dc, roughness: 0.3, metalness: 0.8 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H * 0.82, 24), [
    new THREE.MeshStandardMaterial({ map: canLabelTexture(), roughness: 0.4, metalness: 0.25 }), alu, alu,
  ]);
  body.position.y = H / 2;
  body.castShadow = true;
  g.add(body);
  for (const s of [-1, 1]) {   // 上下の絞り
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.82, R * 0.82, H * 0.09, 24), alu);
    rim.position.y = H / 2 + s * (H * 0.455);
    g.add(rim);
  }
  const tab = new THREE.Mesh(new THREE.TorusGeometry(0.008, 0.0015, 6, 12), alu);
  tab.rotation.x = Math.PI / 2;
  tab.position.set(0.008, H, 0);
  g.add(tab);
  g.position.copy(pos);
  scene.add(g);

  // こぼれた中身
  const puddle = new THREE.Mesh(
    new THREE.CircleGeometry(1, 28),
    new THREE.MeshStandardMaterial({
      color: 0xd9691a, roughness: 0.15, transparent: true, opacity: 0.8,
    })
  );
  puddle.rotation.x = -Math.PI / 2;
  puddle.position.set(pos.x, 0.0018, pos.z);
  puddle.scale.setScalar(0.001);
  scene.add(puddle);

  const st = { spill: 0, spilling: false, contents: 1 };
  const up = new THREE.Vector3();

  function update(dt) {
    up.set(0, 1, 0).applyQuaternion(g.quaternion);
    st.spilling = up.y < 0.55 && st.contents > 0;   // 60度以上倒れたら漏れる
    if (st.spilling) {
      const rate = (1 - up.y) * 0.35;
      st.contents = Math.max(0, st.contents - rate * dt);
      st.spill = Math.min(1, st.spill + rate * dt);
      puddle.position.x += (g.position.x - puddle.position.x) * Math.min(1, dt * 2);
      puddle.position.z += (g.position.z - puddle.position.z) * Math.min(1, dt * 2);
      puddle.scale.setScalar(0.02 + st.spill * 0.30);
    }
  }

  return {
    object: g, puddle, state: st, update, height: H,
    reset: () => { st.spill = 0; st.contents = 1; puddle.scale.setScalar(0.001); },
    // 指定した位置がジュース溜まりに浸かっているか
    soaks: (p) => st.spill > 0.02 &&
      Math.hypot(p.x - puddle.position.x, p.z - puddle.position.z) < (0.02 + st.spill * 0.30),
  };
}
