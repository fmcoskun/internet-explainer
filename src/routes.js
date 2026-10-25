import * as THREE from 'three';
import { COLORS, GLOBE_RADIUS } from './config.js';
import { clamp, range, smoothstep, easeOutBack, easeInCubic, easeInOutCubic } from './util.js';

// --- Geography ----------------------------------------------------------------------------

export const CITIES = {
  LON: { name: 'London', lat: 51.507, lon: -0.128 },
  FRA: { name: 'Frankfurt', lat: 50.11, lon: 8.682 },
  SIN: { name: 'Singapore', lat: 1.352, lon: 103.82 },
  TYO: { name: 'Tokyo', lat: 35.676, lon: 139.65 },
  NYC: { name: 'New York', lat: 40.713, lon: -74.006 },
  SFO: { name: 'San Francisco', lat: 37.775, lon: -122.419 },
  MOW: { name: 'Moscow', lat: 55.756, lon: 37.617 },
  BJS: { name: 'Beijing', lat: 39.904, lon: 116.407 },
};

// One route per packet (packet index = route index).
export const ROUTES = [
  ['LON', 'FRA', 'SIN', 'TYO'],
  ['LON', 'NYC', 'SFO', 'TYO'],
  ['LON', 'MOW', 'BJS', 'TYO'],
];

export const EARTH_KM = 6371;

/** lon 0 faces +z, east is +x at lon 0, north is +y. */
export function latLonToVec3(lat, lon, r = 1, out = new THREE.Vector3()) {
  const phi = THREE.MathUtils.degToRad(lat);
  const lam = THREE.MathUtils.degToRad(lon);
  return out.set(r * Math.cos(phi) * Math.sin(lam), r * Math.sin(phi), r * Math.cos(phi) * Math.cos(lam));
}

export const cityVec = (code, r = 1) => latLonToVec3(CITIES[code].lat, CITIES[code].lon, r);

/** Unit east tangent at a unit surface normal n. */
export function eastOf(n, out = new THREE.Vector3()) {
  return out.set(n.z, 0, -n.x).normalize();
}

export function slerpUnit(a, b, s, out = new THREE.Vector3()) {
  const w = a.angleTo(b);
  if (w < 1e-6) return out.copy(a);
  const sw = Math.sin(w);
  return out.copy(a).multiplyScalar(Math.sin((1 - s) * w) / sw).addScaledVector(b, Math.sin(s * w) / sw);
}

export const SURFACE = GLOBE_RADIUS * 1.012;
const arcLift = (w) => Math.min(0.2, 0.1 * w);

/** Great-circle arc point, lifted above the surface in proportion to the arc's length. */
export function arcPoint(a, b, s, out = new THREE.Vector3()) {
  const w = a.angleTo(b);
  slerpUnit(a, b, s, out);
  return out.multiplyScalar(SURFACE + arcLift(w) * Math.sin(Math.PI * s));
}

/** 0 = hidden behind the globe, 1 = clear line of sight. Smooth near the limb. */
export function lineOfSight(p, camPos, R = GLOBE_RADIUS) {
  const toP = _v.copy(p).sub(camPos);
  const L = toP.length();
  toP.divideScalar(L);
  const b = camPos.dot(toP); // negative when heading toward the centre
  const along = -b; // distance along the ray to the closest approach
  if (along <= 0 || along >= L) return 1;
  const h = Math.sqrt(Math.max(0, camPos.lengthSq() - b * b));
  return smoothstep(R * 0.985, R * 1.03, h);
}
const _v = new THREE.Vector3();

// --- Shaders ------------------------------------------------------------------------------

const trailVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const trailFragment = /* glsl */ `
uniform float uProgress;
uniform float uHeadOn;
uniform float uLen;
uniform float uBoost;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec3 uHead;
varying vec2 vUv;
void main() {
  float s = vUv.x;
  if (s > uProgress || uOpacity <= 0.0) discard;
  float behind = (uProgress - s) * uLen; // radians behind the packet
  float head = exp(-behind * 22.0) * uHeadOn;
  float body = 0.42 + 0.35 * exp(-behind * 2.5) * uHeadOn;
  vec3 col = uColor * body * uBoost + uHead * head * 2.2;
  gl_FragColor = vec4(col * uOpacity, 1.0);
}`;

// --- Scene objects --------------------------------------------------------------------------

/**
 * Trails, router rings and packet cubes. update(t, camera) positions everything for time t
 * and returns screen-space-relevant state for the HUD.
 */
export function createRoutes(scene, schedule) {
  const group = new THREE.Group();
  scene.add(group);

  const amber = new THREE.Color(COLORS.amber);
  const cyan = new THREE.Color(COLORS.cyan);

  // Trails: one tube per hop.
  const hops = [];
  schedule.packets.forEach((p) => {
    for (const hop of p.hops) {
      const a = cityVec(hop.from);
      const b = cityVec(hop.to);
      const pts = [];
      for (let k = 0; k <= 64; k++) pts.push(arcPoint(a, b, k / 64));
      const curve = new THREE.CatmullRomCurve3(pts);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uProgress: { value: 0 },
          uHeadOn: { value: 0 },
          uLen: { value: hop.angle },
          uBoost: { value: 1 },
          uOpacity: { value: 1 },
          uColor: { value: amber.clone().multiplyScalar(0.9) },
          uHead: { value: new THREE.Color('#fff1d6') },
        },
        vertexShader: trailVertex,
        fragmentShader: trailFragment,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.0042, 8, false), mat);
      group.add(mesh);
      hops.push({ hop, mat });
    }
  });

  // Router rings: a steady ring per city plus one expanding pulse ring per packet pass.
  const ringGeo = new THREE.RingGeometry(0.8, 1.0, 64);
  const dotGeo = new THREE.CircleGeometry(0.0065, 24);
  const cities = Object.keys(CITIES).map((code) => {
    const n = cityVec(code);
    const holder = new THREE.Object3D();
    holder.position.copy(n).multiplyScalar(GLOBE_RADIUS * 1.003);
    holder.lookAt(n.clone().multiplyScalar(3)); // +z of the ring = surface normal
    group.add(holder);

    const ringMat = new THREE.MeshBasicMaterial({
      color: cyan.clone().multiplyScalar(1.6), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.scale.setScalar(0.024);
    holder.add(ring);

    const dot = new THREE.Mesh(dotGeo, ringMat.clone());
    dot.material.color = new THREE.Color('#ffffff').multiplyScalar(2.2);
    holder.add(dot);

    const events = schedule.cityEvents[code] ?? [];
    const pulses = events.map((ev) => {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: (ev.big ? amber : cyan).clone().multiplyScalar(ev.big ? 3 : 2.4), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      m.visible = false;
      holder.add(m);
      return { ev, mesh: m };
    });

    return { code, name: CITIES[code].name, n, pos: holder.position.clone(), ring, dot, pulses, reveal: schedule.cityReveal[code] };
  });

  // Packets: glowing amber cubes with a bright wire edge.
  const cubeGeo = new THREE.BoxGeometry(0.042, 0.042, 0.042);
  const edgeGeo = new THREE.EdgesGeometry(cubeGeo);
  const packets = schedule.packets.map((p, i) => {
    const mesh = new THREE.Mesh(cubeGeo, new THREE.MeshBasicMaterial({ color: amber.clone().multiplyScalar(0.9) }));
    const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: new THREE.Color('#fff4dc').multiplyScalar(1.7) }));
    mesh.add(edges);
    group.add(mesh);
    return { i, p, mesh, pos: new THREE.Vector3() };
  });

  const LON = cityVec('LON');
  const TYO = cityVec('TYO');
  const lonEast = eastOf(LON);
  const tyoEast = eastOf(TYO);
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  const preLaunch = (i, out) =>
    out.copy(LON).multiplyScalar(SURFACE + 0.035).addScaledVector(lonEast, (i - 1) * 0.08);
  const stackAt = (slot, out) =>
    out.copy(TYO).multiplyScalar(SURFACE + 0.04).addScaledVector(tyoEast, (slot - 1) * 0.08);

  function packetPosition(pk, t, out) {
    const { p, i } = pk;
    const S = schedule;
    if (t < p.launch) {
      preLaunch(i, out).addScaledVector(LON, Math.sin(t * 3 + i * 2.1) * 0.004);
      return out;
    }
    if (t < p.arrive) {
      let hop = p.hops[p.hops.length - 1];
      for (const h of p.hops) if (t < h.end) { hop = h; break; }
      arcPoint(cityVec(hop.from), cityVec(hop.to), range(t, hop.start, hop.end), tmpA);
      preLaunch(i, tmpB);
      return out.lerpVectors(tmpB, tmpA, easeInOutCubic(range(t, p.launch, p.launch + 0.35)));
    }
    // Landed at Tokyo: arrival-order slot, then slide to the correct slot, then merge.
    const k = easeInOutCubic(range(t, S.reorderStart, S.reorderEnd));
    const slot = p.rank + (i - p.rank) * k;
    stackAt(slot, tmpB);
    if (p.rank !== i) tmpB.addScaledVector(TYO, Math.sin(Math.PI * k) * 0.05);
    const m = easeInCubic(range(t, S.mergeStart, S.mergeEnd));
    stackAt(1, tmpA);
    tmpB.lerp(tmpA, m);
    tmpA.copy(TYO).multiplyScalar(SURFACE);
    return out.lerpVectors(tmpA, tmpB, easeInOutCubic(range(t, p.arrive, p.arrive + 0.35)));
  }

  const state = {
    cities: cities.map((c) => ({ code: c.code, name: c.name, pos: c.pos, alpha: 0, facing: 0 })),
    packets: packets.map((pk) => ({ index: pk.i, pos: pk.pos, alpha: 0 })),
  };

  function update(t, camera) {
    const S = schedule;
    const camPos = camera.position;
    const closeBoost = 1 + 0.9 * smoothstep(S.closeStart, S.closeStart + 0.7, t);

    for (const { hop, mat } of hops) {
      const u = mat.uniforms;
      u.uProgress.value = range(t, hop.start, hop.end);
      u.uHeadOn.value = t < hop.end ? 1 : Math.max(0, 1 - (t - hop.end) / 0.25);
      u.uBoost.value = closeBoost;
      u.uOpacity.value = t < hop.start ? 0 : 1;
    }

    cities.forEach((c, ci) => {
      const reveal = smoothstep(c.reveal, c.reveal + 0.45, t);
      let flash = 0;
      for (const { ev, mesh } of c.pulses) {
        const age = t - ev.t;
        const life = ev.big ? 1.3 : 1.0;
        if (age < 0 || age > life) { mesh.visible = false; continue; }
        const k = age / life;
        mesh.visible = true;
        mesh.scale.setScalar((ev.big ? 0.03 : 0.024) * (1 + k * (ev.big ? 5 : 3.2)));
        mesh.material.opacity = Math.pow(1 - k, 2);
        flash = Math.max(flash, Math.exp(-age * 5));
      }
      c.ring.material.opacity = reveal * (0.55 + 0.45 * flash);
      c.ring.scale.setScalar(0.024 * (1 + 0.25 * flash));
      c.dot.material.opacity = reveal;

      const s = state.cities[ci];
      s.facing = c.n.dot(tmpA.copy(camPos).sub(c.pos).normalize());
      s.alpha = reveal * smoothstep(0.05, 0.25, s.facing);
    });

    packets.forEach((pk, i) => {
      const { p, mesh } = pk;
      packetPosition(pk, t, pk.pos);
      const appear = easeOutBack(range(t, p.appear, p.appear + 0.3));
      const merge = 1 - easeInCubic(range(t, S.mergeStart, S.mergeEnd));
      const scale = t < p.appear ? 0 : appear * merge;
      mesh.visible = scale > 0.001;
      mesh.scale.setScalar(Math.max(scale, 0.001));
      mesh.position.copy(pk.pos);
      mesh.rotation.set(t * 1.7 + i * 1.3, t * 1.1 + i * 2.2, t * 0.4);
      state.packets[i].alpha = clamp(scale, 0, 1) * lineOfSight(pk.pos, camPos);
    });

    return state;
  }

  return { group, update };
}
