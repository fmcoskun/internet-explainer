import * as THREE from 'three';
import { feature } from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';
import { COLORS, GLOBE_RADIUS } from './config.js';
import { rng, smoothstep, range, easeInOutSine } from './util.js';

// --- Land mask ----------------------------------------------------------------------------

const MASK_W = 2048;
const MASK_H = 1024;

/** Equirectangular land mask drawn from world-atlas land-110m. */
function createLandMask() {
  const canvas = document.createElement('canvas');
  canvas.width = MASK_W;
  canvas.height = MASK_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const geo = feature(landTopo, landTopo.objects.land);
  const features = geo.type === 'FeatureCollection' ? geo.features : [geo];

  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const f of features) {
    const g = f.geometry;
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polygons) {
      for (const ring of poly) {
        ring.forEach(([lon, lat], k) => {
          const x = ((lon + 180) / 360) * MASK_W;
          const y = ((90 - lat) / 180) * MASK_H;
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
    }
  }
  ctx.fill('evenodd');
  const data = ctx.getImageData(0, 0, MASK_W, MASK_H).data;
  return (lat, lon) => {
    const x = Math.min(MASK_W - 1, Math.floor(((lon + 180) / 360) * MASK_W));
    const y = Math.min(MASK_H - 1, Math.floor(((90 - lat) / 180) * MASK_H));
    return data[(y * MASK_W + x) * 4 + 3] > 127;
  };
}

/** Fibonacci-sphere samples kept only where the mask is land. */
function sampleLandPoints(total = 106000) {
  const isLand = createLandMask();
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rand = rng(1337);
  const pos = [];
  const seed = [];
  const lonAttr = [];
  for (let i = 0; i < total; i++) {
    const y = 1 - (2 * (i + 0.5)) / total;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const lat = THREE.MathUtils.radToDeg(Math.asin(y));
    const lon = THREE.MathUtils.radToDeg(Math.atan2(x, z));
    if (!isLand(lat, lon)) continue;
    const R = GLOBE_RADIUS * 1.004;
    pos.push(x * R, y * R, z * R);
    seed.push(rand());
    lonAttr.push(Math.atan2(x, z));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  geo.setAttribute('aLon', new THREE.Float32BufferAttribute(lonAttr, 1));
  return geo;
}

// --- Shaders ------------------------------------------------------------------------------

const dotsVertex = /* glsl */ `
uniform float uSize;
uniform float uSweep;
uniform float uSweepOrigin;
uniform vec3 uCamPos;
attribute float aSeed;
attribute float aLon;
varying float vAlpha;
varying float vBand;
varying float vSeed;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 n = normalize(wp.xyz);
  float facing = dot(n, normalize(uCamPos - wp.xyz));

  // Scanning sweep: longitude measured eastward from the sweep origin, 0..1 around the globe.
  float d = fract((aLon - uSweepOrigin) / 6.2831853);
  float revealed = 1.0 - smoothstep(uSweep - 0.012, uSweep, d);
  vBand = exp(-pow((uSweep - d) * 26.0, 2.0)) * step(uSweep, 1.02);

  vAlpha = revealed * smoothstep(-0.12, 0.32, facing);
  vSeed = aSeed;
  vec4 mv = viewMatrix * wp;
  gl_PointSize = uSize * (0.75 + 0.5 * aSeed) * (1.0 + vBand * 1.6) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const dotsFragment = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uIntensity;
uniform float uOpacity;
varying float vAlpha;
varying float vBand;
varying float vSeed;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.12, r);
  vec3 col = mix(uColor, uHot, vBand) * uIntensity * (0.8 + 0.4 * vSeed) * (1.0 + vBand * 2.5);
  gl_FragColor = vec4(col, a * vAlpha * uOpacity);
}`;

const oceanVertex = /* glsl */ `
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldPos;
void main() {
  vObj = position;
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const oceanFragment = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uVoid;
uniform vec3 uCore;
uniform vec3 uRim;
uniform vec3 uGrid;
uniform float uOpacity;
varying vec3 vObj;
varying vec3 vWorldN;
varying vec3 vWorldPos;

float gridLine(float x) {
  float w = fwidth(x);
  float d = abs(fract(x - 0.5) - 0.5);
  return 1.0 - smoothstep(0.5 * w, 1.5 * w, d);
}

void main() {
  vec3 n = normalize(vWorldN);
  vec3 v = normalize(uCamPos - vWorldPos);
  float ndv = max(dot(n, v), 0.0);
  float fres = pow(1.0 - ndv, 3.0);

  vec3 p = normalize(vObj);
  float lat = degrees(asin(clamp(p.y, -1.0, 1.0)));
  float lon = degrees(atan(p.x, p.z));
  float grid = max(gridLine(lat / 15.0), gridLine(lon / 15.0) * (1.0 - smoothstep(0.86, 0.97, abs(p.y))));

  vec3 col = uCore * (0.55 + 0.45 * ndv);
  col += uGrid * grid * (0.12 + 0.35 * fres);
  col += uRim * fres * 0.9;
  gl_FragColor = vec4(mix(uVoid, col, uOpacity), 1.0);
}`;

const atmoVertex = /* glsl */ `
varying vec3 vWorldN;
varying vec3 vWorldPos;
void main() {
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const atmoFragment = /* glsl */ `
uniform vec3 uCamPos;
uniform vec3 uColor;
uniform float uIntensity;
varying vec3 vWorldN;
varying vec3 vWorldPos;
void main() {
  // Back faces: dot(n, v) runs from 0 at the shell's edge to about -0.5 at the globe's limb.
  float d = dot(normalize(vWorldN), normalize(uCamPos - vWorldPos));
  float k = clamp(-d * 1.95, 0.0, 1.0);
  float glow = pow(k, 3.2) * uIntensity;
  gl_FragColor = vec4(uColor * glow, 1.0);
}`;

const starsVertex = /* glsl */ `
uniform float uTime;
attribute float aSeed;
attribute float aSize;
varying float vTw;
varying float vSeed;
void main() {
  vSeed = aSeed;
  vTw = 0.65 + 0.35 * sin(uTime * (1.2 + aSeed * 2.6) + aSeed * 40.0);
  gl_PointSize = aSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const starsFragment = /* glsl */ `
uniform float uOpacity;
varying float vTw;
varying float vSeed;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float a = smoothstep(0.5, 0.0, r);
  vec3 col = mix(vec3(0.75, 0.85, 1.0), vec3(0.45, 0.95, 1.0), step(0.8, vSeed));
  gl_FragColor = vec4(col * vTw * 0.9, a * uOpacity);
}`;

function createStars(count = 4200) {
  const rand = rng(7);
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const r = 40 + rand() * 50;
    const s = Math.sqrt(1 - u * u);
    pos.set([Math.cos(th) * s * r, u * r, Math.sin(th) * s * r], i * 3);
    seed[i] = rand();
    size[i] = 1.0 + Math.pow(rand(), 3) * 2.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  return new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: starsVertex,
    fragmentShader: starsFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
}

// --- Globe --------------------------------------------------------------------------------

export function createGlobe(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const stars = createStars();
  scene.add(stars);

  const ocean = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_RADIUS * 0.998, 160, 80),
    new THREE.ShaderMaterial({
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uVoid: { value: new THREE.Color(COLORS.void) },
        uCore: { value: new THREE.Color(COLORS.oceanCore) },
        uRim: { value: new THREE.Color(COLORS.cyan) },
        uGrid: { value: new THREE.Color(COLORS.cyan) },
        uOpacity: { value: 0 },
      },
      vertexShader: oceanVertex,
      fragmentShader: oceanFragment,
    })
  );
  group.add(ocean);

  const dotsGeo = sampleLandPoints();
  const dots = new THREE.Points(dotsGeo, new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 11 },
      uSweep: { value: 0 },
      uSweepOrigin: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(COLORS.cyan) },
      uHot: { value: new THREE.Color('#ffffff') },
      uIntensity: { value: 0.95 },
      uOpacity: { value: 0 },
    },
    vertexShader: dotsVertex,
    fragmentShader: dotsFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  group.add(dots);

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_RADIUS * 1.16, 96, 48),
    new THREE.ShaderMaterial({
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Color('#1aa8ff') },
        uIntensity: { value: 0 },
      },
      vertexShader: atmoVertex,
      fragmentShader: atmoFragment,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  group.add(atmosphere);

  // Sweep starts at the western limb of the opening shot (camera lon -38°) and runs east.
  const sweepOrigin = THREE.MathUtils.degToRad(-38 - 100);

  function update(t, camera) {
    const fade = smoothstep(0.1, 1.2, t);
    const close = smoothstep(13.0, 13.8, t);
    ocean.material.uniforms.uOpacity.value = fade;
    ocean.material.uniforms.uCamPos.value.copy(camera.position);

    const du = dots.material.uniforms;
    du.uCamPos.value.copy(camera.position);
    du.uOpacity.value = smoothstep(0.3, 0.8, t);
    du.uSweep.value = 1.06 * easeInOutSine(range(t, 0.35, 2.7));
    du.uSweepOrigin.value = sweepOrigin;
    du.uIntensity.value = 0.95 + 0.2 * close;

    atmosphere.material.uniforms.uCamPos.value.copy(camera.position);
    atmosphere.material.uniforms.uIntensity.value = fade * (0.75 + 0.2 * close);

    stars.material.uniforms.uTime.value = t;
    stars.material.uniforms.uOpacity.value = smoothstep(0, 0.6, t);
  }

  return { group, dots, ocean, atmosphere, stars, pointCount: dotsGeo.attributes.position.count, update };
}
