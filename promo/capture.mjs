// 逐帧捕获：headless Chromium（Metal/ANGLE）→ PNG 序列 + 音频事件表
// ---------------------------------------------------------------------------
//   node capture.mjs                      # 全片，30 fps，1920x1080@2x
//   node capture.mjs --fps 15 --dpr 1      # 快速草稿
//   node capture.mjs --stills 1,8.5,14.3   # 只出指定时刻的静帧 → render/stills/
//   node capture.mjs --from 14 --to 21     # 只渲染一段
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};

const W = Number(arg('width', 1920));
const H = Number(arg('height', 1080));
const DPR = Number(arg('dpr', 2));
const FPS = Number(arg('fps', 30));
const OUT = path.resolve(ROOT, arg('out', 'render/frames'));
const STILLS = arg('stills', null);
const FROM = Number(arg('from', 0));
const TO = arg('to', null) === null ? null : Number(arg('to'));

const server = createServer(ROOT);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  args: [
    '--use-angle=metal',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--disable-lcd-text',
  ],
});
const page = await browser.newPage({
  viewport: { width: W, height: H },
  deviceScaleFactor: DPR,
});
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[page:${m.type()}]`, m.text());
});
page.on('pageerror', (e) => console.error('[page:error]', e.message));

await page.goto(`http://127.0.0.1:${port}/scene/index.html?dpr=${DPR}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', null, { timeout: 120000 });

const duration = await page.evaluate('window.__duration');
const events = await page.evaluate('window.__audioEvents()');
await mkdir(path.join(ROOT, 'render'), { recursive: true });
await writeFile(path.join(ROOT, 'render', 'events.json'), JSON.stringify(events, null, 1));

const settle = () => page.evaluate(() => new Promise((r) =>
  requestAnimationFrame(() => requestAnimationFrame(r))));

async function shoot(t, file) {
  await page.evaluate((tt) => window.__renderAt(tt), t);
  await settle();
  await page.screenshot({ path: file, type: 'png' });
}

if (STILLS) {
  const dir = path.join(ROOT, 'render', 'stills');
  await mkdir(dir, { recursive: true });
  for (const s of STILLS.split(',').map(Number)) {
    const file = path.join(dir, `t${s.toFixed(2).padStart(5, '0')}.png`);
    const t0 = Date.now();
    await shoot(s, file);
    console.log(`  still t=${s}s → ${path.relative(ROOT, file)}  (${Date.now() - t0} ms)`);
  }
} else {
  const t1 = TO ?? duration;
  const n = Math.max(1, Math.round((t1 - FROM) * FPS));
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  console.log(`捕获 ${n} 帧 · ${W}x${H}@${DPR}x · ${FPS} fps · ${FROM}–${t1}s`);
  const tStart = Date.now();
  for (let i = 0; i < n; i++) {
    const t = FROM + i / FPS;
    await shoot(t, path.join(OUT, `frame_${String(i).padStart(5, '0')}.png`));
    if (i % 15 === 0 || i === n - 1) {
      const el = (Date.now() - tStart) / 1000;
      const eta = (el / (i + 1)) * (n - i - 1);
      process.stdout.write(`\r  ${i + 1}/${n}  ${(el / (i + 1) * 1000).toFixed(0)} ms/帧  剩余 ${eta.toFixed(0)}s   `);
    }
  }
  console.log(`\n帧序列 → ${path.relative(ROOT, OUT)}`);
}

await browser.close();
server.close();
