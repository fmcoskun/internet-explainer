import * as THREE from 'three';
import { WIDTH, HEIGHT, FPS, DURATION, TOTAL_FRAMES, COLORS } from './config.js';
import { clamp } from './util.js';
import { createGlobe } from './globe.js';
import { createRoutes } from './routes.js';
import { createHud } from './hud.js';
import { createPost } from './postprocessing.js';
import { SCENES, SCHEDULE, FOV, applyCamera } from './timeline.js';

const MODE = new URLSearchParams(location.search).get('mode') === 'render' ? 'render' : 'preview';
document.body.dataset.mode = MODE;

const renderer = new THREE.WebGLRenderer({
  antialias: false, // MSAA happens on the half-float composer target
  preserveDrawingBuffer: true, // the render script reads the canvas back after seekTo()
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('stage').appendChild(renderer.domElement);

await document.fonts.ready;

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.void);
const camera = new THREE.PerspectiveCamera(FOV, WIDTH / HEIGHT, 0.01, 300);

const globe = createGlobe(scene);
const routes = createRoutes(scene, SCHEDULE);
const hud = createHud();
const post = createPost(renderer, scene, camera, hud.texture);

/** Render the frame at time t. Every element is a pure function of t. */
function renderFrame(t) {
  t = clamp(t, 0, DURATION);
  const cam = applyCamera(camera, t);
  globe.update(t, camera);
  const state = routes.update(t, camera);
  hud.draw(t, camera, state, cam);
  post.render(t, Math.round(t * FPS));
}

// Compile every shader program up front so the first frames don't hitch.
for (const s of SCENES) renderFrame((s.start + s.end) / 2);

// --- Render API (driven by scripts/render.js) ----------------------------------------------
window.seekTo = (t) => renderFrame(t);
window.captureFrame = async () => {
  const blob = await new Promise((res) => renderer.domElement.toBlob(res, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const gl = renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
window.__info = {
  width: WIDTH,
  height: HEIGHT,
  fps: FPS,
  totalFrames: TOTAL_FRAMES,
  points: globe.pointCount,
  gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
};
window.__ready = true;
console.info(`[explainer] ${globe.pointCount} land dots · arrival order ${SCHEDULE.arrivalOrder.map((i) => i + 1).join(', ')}`);

// --- Preview UI ----------------------------------------------------------------------------
if (MODE === 'preview') {
  const scrub = document.getElementById('scrub');
  const play = document.getElementById('play');
  const time = document.getElementById('time');
  const marks = document.getElementById('marks');
  scrub.max = String(TOTAL_FRAMES - 1);

  let frame = 0;
  let playing = false;
  let last = 0;
  let dirty = true;
  const setFrame = (f) => {
    frame = clamp(f, 0, TOTAL_FRAMES - 1);
    dirty = true;
  };

  for (const s of SCENES) {
    const b = document.createElement('button');
    b.textContent = `${s.id} ${s.name}`;
    b.style.left = `${(s.start / DURATION) * 100}%`;
    b.onclick = () => setFrame(Math.round(s.start * FPS));
    marks.appendChild(b);
  }

  const togglePlay = () => {
    playing = !playing;
    play.textContent = playing ? 'Pause' : 'Play';
    last = performance.now();
  };
  play.onclick = togglePlay;
  scrub.oninput = () => setFrame(Number(scrub.value));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') setFrame(frame + (e.shiftKey ? 30 : 1));
    if (e.code === 'ArrowLeft') setFrame(frame - (e.shiftKey ? 30 : 1));
  });

  const loop = (now) => {
    if (playing) {
      frame += ((now - last) / 1000) * FPS;
      if (frame >= TOTAL_FRAMES) frame = 0;
      dirty = true;
    }
    last = now;
    if (dirty) {
      renderFrame(frame / FPS);
      const f = Math.floor(frame);
      scrub.value = String(f);
      time.textContent = `${(frame / FPS).toFixed(2)}s · frame ${f}`;
      dirty = false;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
