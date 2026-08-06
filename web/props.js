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

  // 走る面。床と 3 枚の壁を (u, v) の 2 次元で扱う
  const { w, d, h = 2.4 } = bounds;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const SURF = {
    floor: { o: V(0, 0, 0), u: V(1, 0, 0), v: V(0, 0, 1), n: V(0, 1, 0), lu: w / 2, lv: d / 2 },
    back: { o: V(0, 0, -d / 2), u: V(1, 0, 0), v: V(0, 1, 0), n: V(0, 0, 1), lu: w / 2, lv: h },
    left: { o: V(-w / 2, 0, 0), u: V(0, 0, 1), v: V(0, 1, 0), n: V(1, 0, 0), lu: d / 2, lv: h },
    right: { o: V(w / 2, 0, 0), u: V(0, 0, -1), v: V(0, 1, 0), n: V(-1, 0, 0), lu: d / 2, lv: h },
  };

  const st = {
    group: g, enabled: true, alive: false, dying: false, fade: 1, twitch: 0,
    t: 0, next: 6 + Math.random() * 14,
    surf: 'floor', u: 0, v: 0, heading: 0, speed: 0, burst: 0, life: 0, panic: 0, walk: 0,
  };

  const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _s = new THREE.Vector3();
  const _m = new THREE.Matrix4();

  // (u, v) と向きから、面に貼り付いた姿勢を作る
  function place() {
    const S = SURF[st.surf];
    _p.copy(S.o).addScaledVector(S.u, st.u).addScaledVector(S.v, st.v).addScaledVector(S.n, 0.004);
    g.position.copy(_p);
    _f.copy(S.u).multiplyScalar(Math.sin(st.heading)).addScaledVector(S.v, Math.cos(st.heading));
    _s.crossVectors(S.n, _f);
    _m.makeBasis(_s, S.n, _f);
    g.quaternion.setFromRotationMatrix(_m);
    if (st.dying) g.rotateZ(Math.PI * st.flip);
  }

  function spawn() {
    st.surf = 'floor';
    const edge = Math.floor(Math.random() * 4);
    const S = SURF.floor;
    if (edge < 2) { st.u = (Math.random() - 0.5) * w; st.v = (edge ? 1 : -1) * (S.lv - 0.05); }
    else { st.u = (edge === 2 ? -1 : 1) * (S.lu - 0.05); st.v = (Math.random() - 0.5) * d; }
    st.heading = Math.atan2(-st.u, -st.v) + (Math.random() - 0.5) * 1.2;
    st.alive = true;
    st.dying = false;
    st.flip = 0;
    st.fade = 1;
    st.life = 9 + Math.random() * 8;
    st.burst = 0;
    st.panic = 0;
    g.visible = true;
    place();
  }

  function update(dt) {
    if (!st.alive) {
      if (!st.enabled) return;
      st.t += dt;
      if (st.t >= st.next) { st.t = 0; st.next = 14 + Math.random() * 26; spawn(); }
      return;
    }
    if (st.dying) { dieUpdate(dt); return; }
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
    st.u += Math.sin(st.heading) * sp * dt;
    st.v += Math.cos(st.heading) * sp * dt;

    // 脚をカサカサ動かす
    st.walk += sp * dt * 60;
    for (let i = 0; i < legs.length; i++) {
      legs[i].rotation.x = ((i % 2) ? 1 : -1) * Math.sin(st.walk + i) * 0.4 + (Math.floor(i / 2) - 1) * 0.3;
    }

    const S = SURF[st.surf];
    if (st.surf === 'floor') {
      // 部屋の端まで来たら、たまにそのまま壁を登る
      if (st.v < -S.lv) {
        if (Math.random() < 0.6) { st.surf = 'back'; st.v = 0; st.heading = (Math.random() - 0.5) * 0.5; }
        else { st.v = -S.lv; st.heading = Math.PI - st.heading; }
      } else if (st.v > S.lv) { st.v = S.lv; st.heading = Math.PI - st.heading; }
      else if (st.u < -S.lu) {
        if (Math.random() < 0.6) { st.surf = 'left'; st.u = -st.v; st.v = 0; st.heading = (Math.random() - 0.5) * 0.5; }
        else { st.u = -S.lu; st.heading = -st.heading; }
      } else if (st.u > S.lu) {
        if (Math.random() < 0.6) { st.surf = 'right'; st.u = st.v; st.v = 0; st.heading = (Math.random() - 0.5) * 0.5; }
        else { st.u = S.lu; st.heading = -st.heading; }
      }
    } else {
      // 壁: 下に着いたら床へ戻る、天井付近と横端では折り返す
      if (st.v < 0) {
        const back = st.surf === 'back';
        st.surf = 'floor';
        if (back) { st.v = -SURF.floor.lv + 0.02; st.heading = (Math.random() - 0.5) * 1.2; }
        else {
          const right = st.surf === 'right';
          st.v = st.u * (right ? 1 : -1);
          st.u = (right ? 1 : -1) * (SURF.floor.lu - 0.02);
          st.heading = (right ? -1 : 1) * (Math.PI / 2) + (Math.random() - 0.5) * 0.8;
        }
      } else if (st.v > S.lv - 0.05) { st.v = S.lv - 0.05; st.heading = Math.PI - st.heading; }
      if (st.u < -S.lu) { st.u = -S.lu; st.heading = -st.heading; }
      else if (st.u > S.lu) { st.u = S.lu; st.heading = -st.heading; }
    }
    place();
    if (st.life <= 0) { st.alive = false; g.visible = false; }
  }

  // 殺虫スプレーを浴びた: ひっくり返って脚をバタつかせ、やがて消える
  function kill() {
    if (!st.alive || st.dying) return;
    // 壁で浴びたら床に落ちる
    if (st.surf !== 'floor') {
      const S = SURF[st.surf];
      const p = new THREE.Vector3().copy(S.o).addScaledVector(S.u, st.u).addScaledVector(S.v, st.v);
      st.surf = 'floor';
      st.u = Math.max(-SURF.floor.lu + 0.02, Math.min(SURF.floor.lu - 0.02, p.x));
      st.v = Math.max(-SURF.floor.lv + 0.02, Math.min(SURF.floor.lv - 0.02, p.z));
    }
    st.dying = true;
    st.flip = 0;
    st.fade = 1;
    st.twitch = 0;
    st.speed = 0;
    for (const m of g.children) {
      if (!m.material) continue;
      m.material = m.material.clone();
      m.material.transparent = true;
    }
  }

  function dieUpdate(dt) {
    st.twitch += dt;
    // ひっくり返る
    st.flip = Math.min(1, st.flip + dt * 3);
    place();
    // しばらく脚がバタつく
    const kick = Math.max(0, 1 - st.twitch / 2.2);
    for (let i = 0; i < legs.length; i++) {
      legs[i].rotation.x = Math.sin(st.twitch * 22 + i * 1.7) * 0.9 * kick + (Math.floor(i / 2) - 1) * 0.3;
    }
    if (st.twitch > 2.6) {           // 力尽きてからフェードアウト
      st.fade = Math.max(0, st.fade - dt * 0.55);
      for (const m of g.children) if (m.material) m.material.opacity = st.fade;
      if (st.fade <= 0) {
        st.alive = false;
        st.dying = false;
        g.visible = false;
        g.rotation.z = 0;
        for (const m of g.children) if (m.material) m.material.opacity = 1;
      }
    }
  }

  return {
    object: g, state: st, update, kill,
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
  const mouth = new THREE.Vector3();

  function update(dt) {
    up.set(0, 1, 0).applyQuaternion(g.quaternion);
    st.spilling = up.y < 0.55 && st.contents > 0;   // 60度以上倒れたら漏れる
    if (!st.spilling) return;
    const rate = (1 - up.y) * 0.35;
    st.contents = Math.max(0, st.contents - rate * dt);
    st.spill = Math.min(1, st.spill + rate * dt);
    // こぼれるのは缶の口。原点(底)ではなく飲み口の真下に溜まりを作る
    mouth.set(0, H, 0).applyQuaternion(g.quaternion).add(g.position);
    if (st.spill < 0.05) {           // 最初の一滴の位置に置く
      puddle.position.set(mouth.x, puddle.position.y, mouth.z);
    } else {                          // 缶が転がったらゆっくり追う
      puddle.position.x += (mouth.x - puddle.position.x) * Math.min(1, dt * 1.5);
      puddle.position.z += (mouth.z - puddle.position.z) * Math.min(1, dt * 1.5);
    }
    puddle.scale.setScalar(0.02 + st.spill * 0.30);
  }

  return {
    object: g, puddle, state: st, update, height: H,
    reset: () => { st.spill = 0; st.contents = 1; puddle.scale.setScalar(0.001); },
    // 指定した位置がジュース溜まりに浸かっているか
    soaks: (p) => st.spill > 0.02 &&
      Math.hypot(p.x - puddle.position.x, p.z - puddle.position.z) < (0.02 + st.spill * 0.30),
  };
}
