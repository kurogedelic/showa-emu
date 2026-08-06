'use strict';
// ---------------------------------------------------------------------------
// ケーブル。Verlet 法のロープで垂れ下がりを出し、端のプラグは抜き差しできる。
//   RF ケーブル   : ファミコン -> テレビのアンテナ端子   (抜くと映らない)
//   テレビの電源  : テレビ -> 壁のコンセント             (抜くと消える)
//   AC アダプタ   : ファミコン -> 壁のコンセント         (抜くと電源が落ちる)
// 物理は cannon を使わず自前 (端点を固定した紐なので、こちらの方が安定して軽い)
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const GRAVITY = -9.0;
const DAMPING = 0.97;
const ITER = 10;

// 円周方向のリングを並べたチューブ。毎フレーム頂点だけ書き換える
function makeTube(segments, radial, radius, color) {
  const rings = segments + 1;
  const pos = new Float32Array(rings * radial * 3);
  const nor = new Float32Array(rings * radial * 3);
  const idx = [];
  for (let s = 0; s < segments; s++) {
    for (let r = 0; r < radial; r++) {
      const a = s * radial + r;
      const b = s * radial + (r + 1) % radial;
      const c = (s + 1) * radial + (r + 1) % radial;
      const d = (s + 1) * radial + r;
      idx.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.65 }));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.userData.radial = radial;
  mesh.userData.radius = radius;
  return mesh;
}

const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3();
const _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

function updateTube(mesh, pts) {
  const radial = mesh.userData.radial, radius = mesh.userData.radius;
  const pos = mesh.geometry.attributes.position.array;
  const nor = mesh.geometry.attributes.normal.array;
  let k = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    _t.subVectors(next, prev);
    if (_t.lengthSq() < 1e-12) _t.set(0, 1, 0);
    _t.normalize();
    _n.crossVectors(_t, Math.abs(_t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : _up).normalize();
    _b.crossVectors(_t, _n).normalize();
    for (let r = 0; r < radial; r++) {
      const a = (r / radial) * Math.PI * 2;
      const cx = Math.cos(a), sy = Math.sin(a);
      _p.set(
        _n.x * cx * radius + _b.x * sy * radius,
        _n.y * cx * radius + _b.y * sy * radius,
        _n.z * cx * radius + _b.z * sy * radius
      );
      nor[k] = _p.x / radius; nor[k + 1] = _p.y / radius; nor[k + 2] = _p.z / radius;
      pos[k++] = p.x + _p.x;
      pos[k++] = p.y + _p.y;
      pos[k++] = p.z + _p.z;
    }
  }
  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.geometry.attributes.normal.needsUpdate = true;
  mesh.geometry.computeBoundingSphere();
}

export function createCables(scene) {
  const cables = [];
  const sockets = [];
  const plugMeshes = [];

  // 端子 (差込口)。obj に付いて回るのでテレビを投げても付いてくる
  function addSocket(name, obj, local, dir, color = 0x2a2a2c) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.008, 0.009, 0.010, 14),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 })
    );
    shell.rotation.x = Math.PI / 2;
    g.add(shell);
    const hole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0035, 0.0035, 0.012, 10),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 })
    );
    hole.rotation.x = Math.PI / 2;
    g.add(hole);
    g.position.copy(local);
    g.lookAt(local.clone().add(dir));
    obj.add(g);
    const socket = { name, obj, group: g, dir: dir.clone(), world: new THREE.Vector3() };
    sockets.push(socket);
    return socket;
  }

  function socketWorld(s) {
    s.group.getWorldPosition(s.world);
    return s.world;
  }

  function addCable({ name, color = 0x1a1a1a, radius = 0.0035, from, to, slack = 1.25, segments = 16 }) {
    const restTotal = socketWorld(from).distanceTo(socketWorld(to)) * slack;
    const seg = restTotal / segments;
    const pts = [], prev = [];
    const a = socketWorld(from).clone(), b = socketWorld(to).clone();
    for (let i = 0; i <= segments; i++) {
      const p = a.clone().lerp(b, i / segments);
      p.y -= Math.sin((i / segments) * Math.PI) * restTotal * 0.12;   // たるみ
      pts.push(p);
      prev.push(p.clone());
    }
    const mesh = makeTube(segments, 6, radius, color);
    scene.add(mesh);

    // プラグ (掴んで抜き差しする部分)
    const plug = new THREE.Mesh(
      new THREE.CylinderGeometry(0.0075, 0.0065, 0.024, 12),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.45, metalness: 0.35 })
    );
    plug.castShadow = true;
    scene.add(plug);
    plugMeshes.push(plug);

    const cable = {
      name, pts, prev, seg, mesh, plug, from, to,
      connected: true, held: false, holdPos: new THREE.Vector3(),
    };
    plug.userData.cable = cable;
    cables.push(cable);
    return cable;
  }

  function update(dt) {
    const step = Math.min(0.033, dt);
    for (const c of cables) {
      const n = c.pts.length - 1;
      // Verlet 積分
      for (let i = 1; i <= n; i++) {
        const p = c.pts[i], pv = c.prev[i];
        const vx = (p.x - pv.x) * DAMPING, vy = (p.y - pv.y) * DAMPING, vz = (p.z - pv.z) * DAMPING;
        pv.copy(p);
        p.x += vx;
        p.y += vy + GRAVITY * step * step;
        p.z += vz;
      }
      // 端点を固定
      const head = socketWorld(c.from);
      c.pts[0].copy(head);
      c.prev[0].copy(head);
      let tail = null;
      if (c.held) tail = c.holdPos;
      else if (c.connected) tail = socketWorld(c.to);
      if (tail) { c.pts[n].copy(tail); c.prev[n].copy(tail); }

      // 長さの拘束
      for (let k = 0; k < ITER; k++) {
        for (let i = 0; i < n; i++) {
          const p1 = c.pts[i], p2 = c.pts[i + 1];
          _t.subVectors(p2, p1);
          const d = _t.length();
          if (d < 1e-6) continue;
          const diff = (d - c.seg) / d * 0.5;
          const pin1 = (i === 0), pin2 = (i + 1 === n && tail);
          if (!pin1) p1.addScaledVector(_t, pin2 ? diff * 2 : diff);
          if (!pin2) p2.addScaledVector(_t, pin1 ? -diff * 2 : -diff);
        }
        // 畳を突き抜けない
        for (let i = 1; i <= n; i++) if (c.pts[i].y < 0.004) c.pts[i].y = 0.004;
      }
      updateTube(c.mesh, c.pts);

      // プラグの位置と向き
      const end = c.pts[n], before = c.pts[n - 1];
      c.plug.position.copy(end);
      _t.subVectors(end, before);
      if (_t.lengthSq() > 1e-10) {
        c.plug.quaternion.setFromUnitVectors(_up, _t.normalize());
        c.plug.position.addScaledVector(_t, 0.006);
      }
    }
  }

  // プラグを掴む -> 抜ける
  function grab(cable) {
    cable.held = true;
    cable.connected = false;
    cable.holdPos.copy(cable.pts[cable.pts.length - 1]);
  }
  function moveTo(cable, p) { cable.holdPos.copy(p); }
  // 端子の近くで離したら挿さる
  function release(cable, snapDist = 0.06) {
    // 手を離した場所で判定する (ロープの計算は 1 フレーム遅れるので holdPos を見る)
    const end = cable.held ? cable.holdPos : cable.pts[cable.pts.length - 1];
    cable.held = false;
    if (end.distanceTo(socketWorld(cable.to)) < snapDist) cable.connected = true;
    return cable.connected;
  }
  const isConnected = (name) => {
    const c = cables.find((x) => x.name === name);
    return c ? c.connected : false;
  };

  return { cables, sockets, plugMeshes, addSocket, addCable, update, grab, moveTo, release, isConnected, socketWorld };
}
