// Offline renderer: headless Chromium steps through every frame with window.seekTo(t),
// saves each frame as a PNG in a temporary directory, then ffmpeg stitches them into an MP4.
//
//   npm run render                               -> out/internet-explainer.mp4 (900 frames @ 60fps)
//   npm run render -- --start 0 --end 120 --out out/test.mp4
//   npm run still                                -> out/stills/*.png (one or more per scene)
//   npm run still -- 1.5,8,12.6                  -> stills at those seconds
//
// Options: --out <file>  --crf <n> (16)  --preset <x264 preset> (slow)  --workers <n> (2)
//          --keep-frames  --gl swiftshader (software WebGL, slow)

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STILLS = [1.0, 2.4, 3.6, 4.5, 5.0, 6.2, 7.6, 9.2, 10.3, 11.3, 12.4, 14.5];

function parseArgs(argv) {
  const args = { out: 'out/internet-explainer.mp4', crf: 16, preset: 'slow', still: null, start: 0, end: null, gl: 'auto', workers: 2, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--crf') args.crf = Number(next());
    else if (a === '--preset') args.preset = next();
    else if (a === '--start') args.start = Number(next());
    else if (a === '--end') args.end = Number(next());
    else if (a === '--gl') args.gl = next();
    else if (a === '--workers') args.workers = Math.max(1, Number(next()));
    else if (a === '--keep-frames') args.keep = true;
    else if (a === '--still') args.still = argv[i + 1] && !argv[i + 1].startsWith('--') ? next().split(',').map(Number) : DEFAULT_STILLS;
  }
  return args;
}

function chromiumArgs(gl) {
  const base = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling'];
  if (gl === 'swiftshader') return [...base, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  if (process.platform === 'win32') return [...base, '--use-angle=d3d11', '--enable-gpu'];
  if (process.platform === 'darwin') return [...base, '--use-angle=metal', '--enable-gpu'];
  return [...base, '--use-angle=vulkan', '--enable-features=Vulkan', '--enable-gpu'];
}

async function openPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => {
    // X4122 = benign D3D/HLSL precision notes from three's built-in shaders.
    if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('X4122')) console.error(`[page ${m.type()}]`, m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180_000 });
  return page;
}

const grab = (page, t) =>
  page.evaluate(async (time) => {
    window.seekTo(time);
    return window.captureFrame();
  }, t);

function ffmpeg(args) {
  return new Promise((res, rej) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    proc.on('error', rej);
    proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}`))));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls.local[0] + '?mode=render';
  const browser = await chromium.launch({ headless: true, args: chromiumArgs(args.gl) });

  try {
    const first = await openPage(browser, url);
    const info = await first.evaluate(() => window.__info);
    console.log(`GPU: ${info.gpu}`);
    console.log(`${info.width}x${info.height} @ ${info.fps}fps · ${info.totalFrames} frames · ${info.points} land dots`);
    if (/swiftshader|llvmpipe|software/i.test(info.gpu) && args.gl !== 'swiftshader') console.warn('Warning: software WebGL - this will be slow.');
    const { fps } = info;

    if (args.still) {
      const dir = resolve(ROOT, 'out/stills');
      mkdirSync(dir, { recursive: true });
      for (const t of args.still) {
        const frame = Math.min(info.totalFrames - 1, Math.round(t * fps));
        const file = join(dir, `frame_${String(frame).padStart(3, '0')}_${t.toFixed(2)}s.png`);
        writeFileSync(file, Buffer.from(await grab(first, frame / fps), 'base64'));
        console.log(`still t=${t}s -> ${file}`);
      }
      return;
    }

    const start = args.start;
    const end = Math.min(args.end ?? info.totalFrames, info.totalFrames);
    const frameDir = mkdtempSync(join(tmpdir(), 'internet-explainer-'));
    console.log(`Frames -> ${frameDir}`);

    // Frames are independent (pure functions of t), so several pages can render in parallel.
    const pages = [first];
    for (let w = 1; w < args.workers; w++) pages.push(await openPage(browser, url));
    let next = start;
    let done = 0;
    const t0 = Date.now();
    await Promise.all(
      pages.map(async (page) => {
        while (next < end) {
          const f = next++;
          const png = Buffer.from(await grab(page, f / fps), 'base64');
          writeFileSync(join(frameDir, `frame_${String(f).padStart(5, '0')}.png`), png);
          done++;
          if (done % 30 === 0 || done === end - start) {
            const rate = done / ((Date.now() - t0) / 1000);
            process.stdout.write(`\rframe ${done}/${end - start}  ${rate.toFixed(1)} fps  eta ${((end - start - done) / rate).toFixed(0)}s   `);
          }
        }
      })
    );
    console.log(`\nCaptured ${end - start} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s, encoding...`);

    const out = resolve(ROOT, args.out);
    mkdirSync(dirname(out), { recursive: true });
    await ffmpeg([
      '-y', '-framerate', String(fps), '-start_number', String(start), '-i', join(frameDir, 'frame_%05d.png'),
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv',
      '-c:v', 'libx264', '-preset', args.preset, '-crf', String(args.crf),
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', out,
    ]);
    console.log(`Wrote ${out}`);
    if (args.keep) console.log(`Kept frames in ${frameDir}`);
    else rmSync(frameDir, { recursive: true, force: true });
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
