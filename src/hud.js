import * as THREE from 'three';
import { WIDTH as W, HEIGHT as H, FPS, DURATION, FONT_SANS, FONT_MONO } from './config.js';
import { SCENES, NARRATIVE, SCHEDULE, SPLIT, MESSAGE_CHUNKS, sceneAt } from './timeline.js';
import { clamp, lerp, range, smoothstep, window01, easeOutCubic, easeInOutCubic, easeOutBack, roundRect } from './util.js';

const CYAN = '56,232,255';
const AMBER = '255,181,71';
const WHITE = '234,252,255';
const rgba = (rgb, a) => `rgba(${rgb},${a})`;

const LEFT = 120;
const CARD = { x: LEFT, y: 360, w: 600, h: 190 };
const LOG = { x: LEFT, y: 636, w: 600, lineH: 31 };
const CHIP = { font: `600 42px ${FONT_SANS}`, padX: 14, gap: 22, h: 62, baseline: CARD.y + 128 };
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 2D HUD drawn into a canvas every frame; the canvas is a texture composited over the 3D image
 * after tone mapping (see postprocessing.js), so text stays crisp and colour-exact.
 */
export function createHud() {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // --- Chip geometry (measured once) ---------------------------------------------------
  ctx.font = CHIP.font;
  const chipW = MESSAGE_CHUNKS.map((s) => ctx.measureText(s).width);
  const spaceW = ctx.measureText(' ').width;
  const x0 = CARD.x + 30;
  const chipCy = CHIP.baseline - 14;

  /** Centre x of each chunk, laid out in `order`, boxed (gap) or as plain joined text. */
  function layout(order, boxed) {
    const cx = [];
    let x = x0;
    for (const i of order) {
      if (boxed) {
        cx[i] = x + CHIP.padX + chipW[i] / 2;
        x += chipW[i] + 2 * CHIP.padX + CHIP.gap;
      } else {
        cx[i] = x + chipW[i] / 2;
        x += chipW[i] + spaceW;
      }
    }
    return cx;
  }
  const IN_ORDER = [0, 1, 2];
  const joined = layout(IN_ORDER, false);
  const boxedInOrder = layout(IN_ORDER, true);
  const boxedArrival = layout(SCHEDULE.arrivalOrder, true);

  const v = new THREE.Vector3();
  const project = (p, camera) => {
    v.copy(p).project(camera);
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
  };

  // --- Primitives -----------------------------------------------------------------------
  function text(str, x, y, { font, color, glow = null, blur = 18, align = 'left', alpha = 1, spacing = '0px' }) {
    if (alpha <= 0.002) return;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.font = font;
    ctx.textAlign = align;
    ctx.letterSpacing = spacing;
    ctx.fillStyle = color;
    if (glow) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = blur;
      ctx.fillText(str, x, y);
      ctx.shadowBlur = 0;
    }
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  function panel(x, y, w, h, alpha, rgb = CYAN) {
    if (alpha <= 0.002) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fillStyle = 'rgba(3,16,32,0.62)';
    ctx.fill();
    ctx.strokeStyle = rgba(rgb, 0.5);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Bright corner ticks.
    ctx.strokeStyle = rgba(rgb, 1);
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(rgb, 0.9);
    ctx.shadowBlur = 10;
    const L = 16;
    ctx.beginPath();
    ctx.moveTo(x, y + L); ctx.lineTo(x, y); ctx.lineTo(x + L, y);
    ctx.moveTo(x + w - L, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - L);
    ctx.stroke();
    ctx.restore();
  }

  /** A message chunk centred at (cx, cy). box: 0 = plain text, 1 = boxed chip with number badge. */
  function chip(i, cx, cy, { scale = 1, alpha = 1, box = 1, rgb = AMBER, textColor = '#ffffff' }) {
    if (alpha <= 0.002) return;
    const w = chipW[i] + 2 * CHIP.padX;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    if (box > 0.001) {
      ctx.save();
      ctx.globalAlpha *= box;
      roundRect(ctx, -w / 2, -CHIP.h / 2, w, CHIP.h, 8);
      ctx.fillStyle = rgba(rgb, 0.1);
      ctx.fill();
      ctx.strokeStyle = rgba(rgb, 0.9);
      ctx.lineWidth = 1.6;
      ctx.shadowColor = rgba(rgb, 0.8);
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
      // Number badge on the top-left corner.
      roundRect(ctx, -w / 2 + 8, -CHIP.h / 2 - 11, 30, 22, 5);
      ctx.fillStyle = rgba(rgb, 1);
      ctx.fill();
      ctx.fillStyle = '#071019';
      ctx.font = `700 14px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), -w / 2 + 23, -CHIP.h / 2 + 5);
      ctx.restore();
    }
    ctx.font = CHIP.font;
    ctx.textAlign = 'center';
    ctx.fillStyle = textColor;
    ctx.shadowColor = rgba(CYAN, 0.6);
    ctx.shadowBlur = 14;
    ctx.fillText(MESSAGE_CHUNKS[i], 0, 15);
    ctx.restore();
  }

  // --- Frame chrome ---------------------------------------------------------------------
  function scrim() {
    const g = ctx.createLinearGradient(0, 0, 1000, 0);
    g.addColorStop(0, 'rgba(1,4,11,0.6)');
    g.addColorStop(0.7, 'rgba(1,4,11,0.25)');
    g.addColorStop(1, 'rgba(1,4,11,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1000, H);
  }

  function brackets(t) {
    const a = smoothstep(0, 0.5, t);
    const I = 36, L = 46;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = rgba(CYAN, 0.85);
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(CYAN, 0.8);
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (const [x, y, sx, sy] of [[I, I, 1, 1], [W - I, I, -1, 1], [I, H - I, 1, -1], [W - I, H - I, -1, -1]]) {
      ctx.moveTo(x, y + sy * L); ctx.lineTo(x, y); ctx.lineTo(x + sx * L, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function topRail(t) {
    const a = smoothstep(0.1, 0.6, t);
    const mono = `500 16px ${FONT_MONO}`;
    const s = sceneAt(t);
    const frame = Math.round(t * FPS);
    const tc = `00:00:${pad2(Math.floor(frame / FPS))}:${pad2(frame % FPS)}`;

    text('◆ NET//TRACE', 72, 66, { font: `700 16px ${FONT_MONO}`, color: rgba(AMBER, 1), glow: rgba(AMBER, 0.7), blur: 10, alpha: a, spacing: '2px' });
    text('HOW THE INTERNET SENDS A MESSAGE', 72 + 170, 66, { font: mono, color: rgba(WHITE, 0.6), alpha: a, spacing: '2px' });
    text(`SCN ${pad2(s.id)} · ${s.name.toUpperCase()}`, W / 2, 66, { font: mono, color: rgba(CYAN, 1), glow: rgba(CYAN, 0.7), blur: 10, align: 'center', alpha: a, spacing: '3px' });
    text(`TC ${tc}`, W - 72, 66, { font: mono, color: rgba(WHITE, 0.92), align: 'right', alpha: a, spacing: '2px' });
    if (Math.floor(t * 2) % 2 === 0) text('● REC', W - 72 - 250, 66, { font: mono, color: '#ff5a5a', alpha: a * 0.9, align: 'right', spacing: '2px' });

    // Progress rail with one-second ticks and scene boundaries.
    const x1 = 72, x2 = W - 72, y = 90;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = rgba(CYAN, 0.25);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y); ctx.lineTo(x2, y);
    for (let k = 0; k <= DURATION * 4; k++) {
      const x = x1 + ((x2 - x1) * k) / (DURATION * 4);
      ctx.moveTo(x, y); ctx.lineTo(x, y + (k % 4 === 0 ? 7 : 3));
    }
    ctx.stroke();
    ctx.strokeStyle = rgba(CYAN, 0.7);
    ctx.beginPath();
    for (const sc of SCENES) {
      const x = x1 + ((x2 - x1) * sc.start) / DURATION;
      ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 10);
    }
    ctx.stroke();
    const px = x1 + ((x2 - x1) * t) / DURATION;
    ctx.strokeStyle = rgba(AMBER, 0.95);
    ctx.lineWidth = 2;
    ctx.shadowColor = rgba(AMBER, 0.9);
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(x1, y); ctx.lineTo(px, y);
    ctx.stroke();
    ctx.fillStyle = rgba(AMBER, 1);
    ctx.beginPath();
    ctx.moveTo(px, y - 5); ctx.lineTo(px + 5, y); ctx.lineTo(px, y + 5); ctx.lineTo(px - 5, y);
    ctx.fill();
    ctx.restore();
  }

  function bottomRail(t, cam) {
    const a = smoothstep(0.2, 0.7, t);
    const mono = `500 14px ${FONT_MONO}`;
    text('PROTOCOL TCP/IP  ·  MTU 1500  ·  3 PACKETS', 72, H - 56, { font: mono, color: rgba(WHITE, 0.45), alpha: a, spacing: '2px' });
    const lat = `${Math.abs(cam.lat).toFixed(2)}°${cam.lat >= 0 ? 'N' : 'S'}`;
    const lonN = ((cam.lon + 540) % 360) - 180;
    const lon = `${Math.abs(lonN).toFixed(2)}°${lonN >= 0 ? 'E' : 'W'}`;
    const alt = Math.round((cam.dist - 1) * 6371).toLocaleString('en-US');
    text(`CAM ${lat}  ${lon}  ·  ALT ${alt} KM`, W - 72, H - 56, { font: mono, color: rgba(CYAN, 0.75), align: 'right', alpha: a, spacing: '2px' });
  }

  // --- Narrative ------------------------------------------------------------------------
  function narrative(t) {
    for (const b of NARRATIVE) {
      const a = window01(t, b.start, b.end, 0.35, 0.3);
      if (a <= 0.002) continue;
      const rise = (1 - easeOutCubic(range(t, b.start, b.start + 0.55))) * 16;

      if (b.kind === 'title') {
        text(b.kicker, LEFT, 420 + rise, { font: `600 17px ${FONT_MONO}`, color: rgba(AMBER, 1), glow: rgba(AMBER, 0.6), blur: 10, alpha: a, spacing: '4px' });
        b.lines.forEach((line, k) => {
          const la = a * smoothstep(b.start + 0.12 * k, b.start + 0.12 * k + 0.4, t);
          const lr = (1 - easeOutCubic(range(t, b.start + 0.12 * k, b.start + 0.12 * k + 0.6))) * 22;
          text(line, LEFT - 3, 512 + k * 96 + lr, { font: `600 84px ${FONT_SANS}`, color: '#f2fdff', glow: rgba(CYAN, 0.85), blur: 26, alpha: la, spacing: '-1px' });
        });
        text(b.sub, LEFT, 676 + rise, { font: `400 27px ${FONT_SANS}`, color: rgba(WHITE, 0.7), alpha: a * smoothstep(b.start + 0.35, b.start + 0.8, t) });
      } else if (b.kind === 'beat') {
        ctx.save();
        ctx.globalAlpha = a;
        ctx.fillStyle = rgba(AMBER, 1);
        ctx.fillRect(LEFT, 164 + rise, 28, 2);
        ctx.restore();
        text(b.kicker, LEFT + 40, 170 + rise, { font: `600 16px ${FONT_MONO}`, color: rgba(AMBER, 1), glow: rgba(AMBER, 0.6), blur: 10, alpha: a, spacing: '4px' });
        text(b.title, LEFT - 2, 236 + rise, { font: `600 54px ${FONT_SANS}`, color: '#f2fdff', glow: rgba(CYAN, 0.8), blur: 22, alpha: a });
        text(b.sub, LEFT, 284 + rise, { font: `400 25px ${FONT_SANS}`, color: rgba(WHITE, 0.72), alpha: a });
      } else if (b.kind === 'close') {
        b.lines.forEach((line, k) => {
          const s0 = b.start + 0.38 * k;
          const la = smoothstep(s0, s0 + 0.4, t);
          const lr = (1 - easeOutCubic(range(t, s0, s0 + 0.6))) * 20;
          const last = k === b.lines.length - 1;
          text(line, LEFT - 2, 440 + k * 84 + lr, {
            font: `600 60px ${FONT_SANS}`,
            color: last ? '#ffe2b0' : '#f2fdff',
            glow: last ? rgba(AMBER, 0.9) : rgba(CYAN, 0.8),
            blur: 24,
            alpha: la,
          });
        });
        text('END OF TRANSMISSION', LEFT, 720, { font: `600 15px ${FONT_MONO}`, color: rgba(CYAN, 0.8), alpha: smoothstep(14.3, 14.7, t), spacing: '5px' });
      }
    }
  }

  // --- Cards ----------------------------------------------------------------------------
  function outgoingCard(t, london) {
    const S = SPLIT;
    const frameA = smoothstep(S.cardIn, S.cardIn + 0.35, t) * (1 - smoothstep(S.cardOut, S.cardOut + 0.4, t));
    const drop = (1 - easeOutCubic(range(t, S.cardIn, S.cardIn + 0.5))) * 18;
    panel(CARD.x, CARD.y + drop, CARD.w, CARD.h, frameA);
    text('OUTGOING MESSAGE', CARD.x + 30, CARD.y + 40 + drop, { font: `600 15px ${FONT_MONO}`, color: rgba(CYAN, 1), glow: rgba(CYAN, 0.6), blur: 8, alpha: frameA, spacing: '3px' });
    text('LON ▸ TYO', CARD.x + CARD.w - 30, CARD.y + 40 + drop, { font: `500 15px ${FONT_MONO}`, color: rgba(WHITE, 0.6), align: 'right', alpha: frameA, spacing: '2px' });

    const textA = smoothstep(S.cardIn + 0.15, S.cardIn + 0.5, t);
    const k = easeInOutCubic(range(t, S.breakStart, S.breakEnd));
    for (let i = 0; i < 3; i++) {
      const f0 = S.flyStart + i * S.flyStagger;
      const sx = lerp(joined[i], boxedInOrder[i], k);
      const sy = chipCy + drop;
      if (t < f0) {
        chip(i, sx, sy, { alpha: textA, box: k });
        continue;
      }
      const fk = range(t, f0, f0 + S.flyDur);
      if (fk >= 1) continue;
      const e = easeInOutCubic(fk);
      const x = lerp(sx, london.x, e);
      const y = lerp(sy, london.y, e) - Math.sin(Math.PI * e) * 90;
      chip(i, x, y, { scale: lerp(1, 0.26, e), alpha: 1 - smoothstep(0.8, 1, fk), box: 1 });
    }
  }

  function incomingCard(t, tokyo) {
    const S = SCHEDULE;
    const a = window01(t, S.firstArrival - 0.3, 12.95, 0.3, 0.3);
    if (a <= 0.002) return;
    const delivered = smoothstep(S.deliveredAt, S.deliveredAt + 0.25, t);
    panel(CARD.x, CARD.y, CARD.w, CARD.h, a, delivered > 0.5 ? AMBER : CYAN);
    text('INCOMING · TYO', CARD.x + 30, CARD.y + 40, { font: `600 15px ${FONT_MONO}`, color: rgba(CYAN, 1), glow: rgba(CYAN, 0.6), blur: 8, alpha: a, spacing: '3px' });
    const received = S.packets.filter((p) => t >= p.arrive).length;
    text(`${received}/3 RECEIVED`, CARD.x + CARD.w - 30, CARD.y + 40, { font: `500 15px ${FONT_MONO}`, color: rgba(WHITE, 0.6), align: 'right', alpha: a * (1 - delivered), spacing: '2px' });
    const pop = easeOutBack(range(t, S.deliveredAt, S.deliveredAt + 0.35));
    text('✓ DELIVERED', CARD.x + CARD.w - 30, CARD.y + 42, { font: `700 ${Math.round(18 * pop)}px ${FONT_MONO}`, color: rgba(AMBER, 1), glow: rgba(AMBER, 1), blur: 16, align: 'right', alpha: a * delivered, spacing: '3px' });

    const reorder = easeInOutCubic(range(t, S.reorderStart, S.reorderEnd));
    const merge = easeInOutCubic(range(t, S.mergeStart, S.mergeEnd));
    for (const p of S.packets) {
      const i = p.index;
      if (t < p.arrive) continue;
      let cx = lerp(boxedArrival[i], boxedInOrder[i], reorder);
      let cy = chipCy;
      if (p.rank !== i) cy -= Math.sin(Math.PI * reorder) * 36 * (i < p.rank ? 1 : -1);
      cx = lerp(cx, joined[i], merge);
      const fk = easeInOutCubic(range(t, p.arrive, p.arrive + 0.5));
      const x = lerp(tokyo.x, cx, fk);
      const y = lerp(tokyo.y, cy, fk) - Math.sin(Math.PI * fk) * 70;
      chip(i, x, y, {
        scale: lerp(0.26, 1, fk),
        alpha: a * smoothstep(0, 0.2, fk),
        box: 1 - merge,
        textColor: delivered > 0 ? `rgb(255,${Math.round(255 - 30 * delivered)},${Math.round(255 - 80 * delivered)})` : '#ffffff',
      });
    }
  }

  function routerLog(t) {
    const a = window01(t, 5.5, 10.75, 0.3, 0.35);
    if (a <= 0.002) return;
    const entries = SCHEDULE.log.filter((e) => t >= e.t);
    text('ROUTER LOG', LOG.x, LOG.y, { font: `600 15px ${FONT_MONO}`, color: rgba(CYAN, 1), glow: rgba(CYAN, 0.6), blur: 8, alpha: a, spacing: '3px' });
    text(`HOPS ${entries.length}/${SCHEDULE.log.length}`, LOG.x + LOG.w, LOG.y, { font: `500 15px ${FONT_MONO}`, color: rgba(WHITE, 0.55), align: 'right', alpha: a, spacing: '2px' });
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = rgba(CYAN, 0.35);
    ctx.beginPath();
    ctx.moveTo(LOG.x, LOG.y + 14); ctx.lineTo(LOG.x + LOG.w, LOG.y + 14);
    ctx.stroke();
    ctx.restore();

    entries.forEach((e, k) => {
      const age = t - e.t;
      const ea = a * smoothstep(0, 0.15, age);
      const y = LOG.y + 50 + k * LOG.lineH;
      const flash = Math.exp(-age * 5);
      if (flash > 0.01) {
        ctx.save();
        ctx.globalAlpha = a * flash * 0.5;
        ctx.fillStyle = rgba(AMBER, 0.35);
        ctx.fillRect(LOG.x - 8, y - 21, LOG.w + 16, 28);
        ctx.restore();
      }
      const slide = (1 - easeOutCubic(range(age, 0, 0.3))) * 12;
      const line = `T+${e.t.toFixed(3).padStart(6, '0')}  PKT ${e.packet + 1}/3  ${e.from} ▸ ${e.to}  ${e.km.toLocaleString('en-US').padStart(6)} km`;
      text(line, LOG.x + slide, y, { font: `500 16px ${FONT_MONO}`, color: e.final ? rgba(AMBER, 1) : rgba(WHITE, 0.82), alpha: ea });
      if (e.final) text('✓', LOG.x + LOG.w, y, { font: `700 16px ${FONT_MONO}`, color: rgba(AMBER, 1), align: 'right', alpha: ea });
    });
  }

  // --- Pinned labels --------------------------------------------------------------------
  // Labels fade out before they reach the top/bottom rails or run off the right edge.
  const edgeFade = (p) =>
    smoothstep(115, 160, p.y) * (1 - smoothstep(H - 140, H - 95, p.y)) * (1 - smoothstep(W - 260, W - 160, p.x)) * smoothstep(-20, 40, p.x);

  function cityLabels(t, camera, state) {
    for (const c of state.cities) {
      if (c.alpha <= 0.01) continue;
      const p = project(c.pos, camera);
      const key = c.code === 'LON' || c.code === 'TYO';
      const a = c.alpha * (t > 13 ? 0.8 : 1) * edgeFade(p);
      if (a <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = rgba(CYAN, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x + 5, p.y - 5); ctx.lineTo(p.x + 16, p.y - 16); ctx.lineTo(p.x + 26, p.y - 16);
      ctx.stroke();
      ctx.restore();
      text(c.name.toUpperCase(), p.x + 30, p.y - 11, {
        font: `${key ? 700 : 600} ${key ? 15 : 14}px ${FONT_MONO}`,
        color: key ? '#ffffff' : rgba(CYAN, 1),
        glow: rgba(CYAN, 0.8),
        blur: 8,
        alpha: a,
        spacing: '2px',
      });
    }
  }

  function packetTags(t, camera, state) {
    for (const pk of state.packets) {
      if (pk.alpha <= 0.01) continue;
      const p = SCHEDULE.packets[pk.index];
      const sp = project(pk.pos, camera);
      const stagger = Math.max(1 - smoothstep(p.launch, p.launch + 0.6, t), smoothstep(p.arrive, p.arrive + 0.4, t));
      const dy = -34 - pk.index * 26 * stagger;
      const x = sp.x + 18, y = sp.y + dy;
      const a = pk.alpha * edgeFade({ x: x - 80, y });
      if (a <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = rgba(AMBER, 0.75);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sp.x + 6, sp.y - 6); ctx.lineTo(x, y + 4);
      ctx.stroke();
      roundRect(ctx, x, y - 16, 84, 24, 5);
      ctx.fillStyle = 'rgba(20,12,2,0.75)';
      ctx.fill();
      ctx.strokeStyle = rgba(AMBER, 0.95);
      ctx.stroke();
      ctx.restore();
      text(`PKT ${pk.index + 1}/3`, x + 42, y + 1, { font: `700 13px ${FONT_MONO}`, color: rgba(AMBER, 1), align: 'center', alpha: a, spacing: '1px' });
    }
  }

  // --- Frame ----------------------------------------------------------------------------
  function draw(t, camera, state, cam) {
    ctx.clearRect(0, 0, W, H);
    scrim();
    const city = (code) => project(state.cities.find((c) => c.code === code).pos, camera);
    cityLabels(t, camera, state);
    packetTags(t, camera, state);
    narrative(t);
    outgoingCard(t, city('LON'));
    incomingCard(t, city('TYO'));
    routerLog(t);
    brackets(t);
    topRail(t);
    bottomRail(t, cam);
    texture.needsUpdate = true;
  }

  return { canvas, texture, draw };
}
