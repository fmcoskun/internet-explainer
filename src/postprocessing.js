import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { WIDTH, HEIGHT } from './config.js';

// Final holographic pass, after tone mapping: chromatic aberration on the 3D image, the HUD
// layer on top, then animated scan lines, a rolling bright band, grain and vignette over everything.
const HoloShader = {
  uniforms: {
    tDiffuse: { value: null },
    tOverlay: { value: null },
    uTime: { value: 0 },
    uFrame: { value: 0 },
    uRes: { value: new THREE.Vector2(WIDTH, HEIGHT) },
    uCA: { value: 0.006 },
    uScan: { value: 0.075 },
    uBand: { value: 0.16 },
    uGrain: { value: 0.045 },
    uVignette: { value: 0.34 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tOverlay;
    uniform float uTime;
    uniform float uFrame;
    uniform vec2 uRes;
    uniform float uCA;
    uniform float uScan;
    uniform float uBand;
    uniform float uGrain;
    uniform float uVignette;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      vec2 off = c * uCA * clamp(r2 * 4.0, 0.0, 1.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + off).b;

      vec4 ov = texture2D(tOverlay, vUv);
      col = mix(col, ov.rgb, ov.a);

      // Scan lines: 4 px period, crawling slowly downward.
      float y = vUv.y * uRes.y;
      float scan = 0.5 + 0.5 * sin((y + uTime * 24.0) * 3.14159265 * 0.5);
      col *= 1.0 - uScan * scan;

      // Rolling bright band, top to bottom.
      float bandY = 1.0 - fract(uTime * 0.23 + 0.1);
      float band = exp(-pow((vUv.y - bandY) * 13.0, 2.0));
      col += (col * 0.9 + vec3(0.01, 0.035, 0.05)) * band * uBand;

      // Grain seeded by the frame index: identical on every render.
      float n = hash12(vUv * uRes + vec2(uFrame * 17.13, uFrame * 5.71)) - 0.5;
      col += n * uGrain * (0.55 + 0.45 * (1.0 - dot(col, vec3(0.299, 0.587, 0.114))));

      col *= 1.0 - uVignette * pow(clamp(r2 * 2.2, 0.0, 1.0), 1.4);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

/**
 * Half-float 4x MSAA target -> UnrealBloom -> OutputPass (ACES + sRGB, from renderer.toneMapping)
 * -> holographic final pass with the HUD overlay.
 */
export function createPost(renderer, scene, camera, overlayTexture) {
  const rt = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(1);
  composer.setSize(WIDTH, HEIGHT);

  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(WIDTH, HEIGHT), 0.7, 0.45, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const holo = new ShaderPass(HoloShader);
  holo.uniforms.tOverlay.value = overlayTexture;
  composer.addPass(holo);

  return {
    composer,
    bloom,
    holo,
    render(t, frame) {
      holo.uniforms.uTime.value = t;
      holo.uniforms.uFrame.value = frame;
      composer.render(0);
    },
  };
}
