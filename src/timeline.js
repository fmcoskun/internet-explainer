import * as THREE from 'three';
import { WIDTH, HEIGHT } from './config.js';
import { ROUTES, CITIES, EARTH_KM, cityVec, latLonToVec3 } from './routes.js';
import { easeInOutCubic, range } from './util.js';

// Master clock: every function here is a pure function of t in [0, 15] seconds.

export const SCENES = [
  { id: 1, name: 'Title', start: 0, end: 2.8 },
  { id: 2, name: 'Split', start: 2.8, end: 5.3 },
  { id: 3, name: 'Route', start: 5.3, end: 10.5 },
  { id: 4, name: 'Reassemble', start: 10.5, end: 13.0 },
  { id: 5, name: 'Close', start: 13.0, end: 15.0 },
];

export const sceneAt = (t) => SCENES.find((s) => t < s.end) ?? SCENES[SCENES.length - 1];

// --- Camera -------------------------------------------------------------------------------
// Orbit around the globe: latitude / longitude / distance, plus a horizontal shift (in NDC)
// that pushes the globe to the right of the frame so the left side stays free for text.
// Each channel has its own keys so e.g. distance can breathe without stalling the orbit.

const CAMERA = {
  lat: [[0, 18], [2.6, 22], [3.95, 44], [5.35, 44], [7.6, 40], [10.25, 37], [11.3, 33], [12.9, 33], [14.2, 64], [15, 66]],
  lon: [[0, -38], [2.6, -24], [3.95, -4], [5.35, 2], [10.25, 112], [11.3, 128], [12.9, 133], [14.2, 72], [15, 62]],
  dist: [[0, 5.6], [2.6, 5.3], [3.95, 3.7], [5.35, 3.6], [6.8, 4.7], [9.4, 4.7], [10.25, 4.2], [11.3, 3.7], [12.9, 3.7], [14.2, 5.5], [15, 5.6]],
  shift: [[0, 0.4], [2.6, 0.4], [3.95, 0.46], [5.35, 0.46], [6.8, 0.4], [10.25, 0.42], [11.3, 0.46], [12.9, 0.46], [14.2, 0.4], [15, 0.4]],
};

function channel(keys, t) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const [ta, a] = keys[i];
  const [tb, b] = keys[i + 1];
  return a + (b - a) * easeInOutCubic(range(t, ta, tb));
}

export const FOV = 30;

export function sampleCamera(t) {
  return { lat: channel(CAMERA.lat, t), lon: channel(CAMERA.lon, t), dist: channel(CAMERA.dist, t), shift: channel(CAMERA.shift, t) };
}

const _right = new THREE.Vector3();
const _target = new THREE.Vector3();

export function applyCamera(camera, t) {
  const c = sampleCamera(t);
  latLonToVec3(c.lat, c.lon, c.dist, camera.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  // Sideways look-at shift: aim left of the globe so it lands right of centre.
  _right.setFromMatrixColumn(camera.matrixWorld, 0);
  const halfWidth = Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * c.dist * (WIDTH / HEIGHT);
  _target.copy(_right).multiplyScalar(-c.shift * halfWidth);
  camera.lookAt(_target);
  camera.updateMatrixWorld();
  return c;
}

// --- Packets ------------------------------------------------------------------------------

export const MESSAGE_CHUNKS = ['Hey!', 'Dinner', 'at 8?'];

// Split scene: card chunks fly to London, then become cubes.
export const SPLIT = { cardIn: 3.05, breakStart: 3.7, breakEnd: 4.1, flyStart: 4.25, flyDur: 0.6, flyStagger: 0.12, cardOut: 4.7 };

const LAUNCH = 5.45;
const LAUNCH_STAGGER = 0.12;
const LAST_ARRIVAL = 10.05;

function buildSchedule() {
  const packets = ROUTES.map((codes, i) => {
    const hops = codes.slice(1).map((to, k) => {
      const from = codes[k];
      return { from, to, angle: cityVec(from).angleTo(cityVec(to)) };
    });
    return {
      index: i,
      hops,
      total: hops.reduce((s, h) => s + h.angle, 0),
      launch: LAUNCH + i * LAUNCH_STAGGER,
      appear: SPLIT.flyStart + SPLIT.flyDur + i * SPLIT.flyStagger,
    };
  });

  // One constant speed for everyone (hop time ∝ arc length), chosen so the slowest packet lands at LAST_ARRIVAL.
  const speed = Math.max(...packets.map((p) => p.total / (LAST_ARRIVAL - p.launch)));
  for (const p of packets) {
    let t = p.launch;
    for (const h of p.hops) {
      h.start = t;
      h.end = t + h.angle / speed;
      h.km = Math.round(h.angle * EARTH_KM);
      t = h.end;
    }
    p.arrive = t;
  }
  const arrivalOrder = [...packets].sort((a, b) => a.arrive - b.arrive).map((p) => p.index);
  arrivalOrder.forEach((idx, rank) => (packets[idx].rank = rank));

  const reorderStart = 10.95, reorderEnd = 11.55, mergeStart = 11.7, mergeEnd = 12.05;

  // Router pulses whenever a packet passes through a city.
  const cityEvents = {};
  const addEvent = (code, t, big = false) => (cityEvents[code] ??= []).push({ t, big });
  for (const p of packets) {
    addEvent('LON', p.launch);
    for (const h of p.hops) addEvent(h.to, h.end);
  }
  addEvent('TYO', mergeEnd, true);

  const cityReveal = {};
  for (const code of Object.keys(CITIES)) cityReveal[code] = 5.3;
  cityReveal.LON = 3.5;
  cityReveal.TYO = 5.3;

  const log = packets
    .flatMap((p) => p.hops.map((h) => ({ t: h.end, packet: p.index, from: h.from, to: h.to, km: h.km, final: h.to === 'TYO' })))
    .sort((a, b) => a.t - b.t);

  return {
    speed, packets, arrivalOrder, cityEvents, cityReveal, log,
    reorderStart, reorderEnd, mergeStart, mergeEnd,
    firstArrival: packets[arrivalOrder[0]].arrive,
    deliveredAt: 12.0,
    closeStart: 13.0,
  };
}

export const SCHEDULE = buildSchedule();

// --- Narrative ----------------------------------------------------------------------------

export const NARRATIVE = [
  { kind: 'title', start: 0.25, end: 2.75, kicker: 'EXPLAINER  ·  NETWORKING 101', lines: ['How the internet', 'sends a message.'], sub: 'One text, London to Tokyo.' },
  { kind: 'beat', start: 2.95, end: 5.25, kicker: '01 — SPLIT', title: 'Chopped into packets', sub: 'The message is cut into small, numbered pieces.' },
  { kind: 'beat', start: 5.45, end: 10.45, kicker: '02 — ROUTE', title: 'Each packet finds its own way', sub: 'Routers pass them on, hop by hop, over different paths.' },
  { kind: 'beat', start: 10.6, end: 12.95, kicker: '03 — REASSEMBLE', title: 'Rebuilt in the right order', sub: 'They arrive out of order. The numbers put them back.' },
  { kind: 'close', start: 13.1, end: 15.5, lines: ['Broken up.', 'Sent separately.', 'Rebuilt in milliseconds.'] },
];
