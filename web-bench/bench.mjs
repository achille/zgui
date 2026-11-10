#!/usr/bin/env node
// Compare WebGPU and Canvas 2D for the zgui demos with Playwright and the installed Chrome.
//
// For every demo × renderer it loads the page, waits for the renderer to start, then runs the same
// scripted interaction (hover sweep, wheel zoom, drag). An init script wraps requestAnimationFrame,
// so each zgui frame is timed on the CPU side: WASM layout, paint and the backend's draw calls or
// GPU submission. GPU execution time is out of reach from the page and is not counted.
//
// Usage: node bench.mjs [--base URL] [--runs N] [--headed] [--only ui|mind-map]

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE = opt('base', 'https://zgui.pages.dev').replace(/\/$/, '');
const RUNS = Number(opt('runs', '3'));
const HEADED = args.includes('--headed');
const ONLY = opt('only', null);

const DEMOS = [
  { id: 'ui', name: 'zgui-ui gallery', path: '/ui/' },
  { id: 'mind-map', name: 'mind map', path: '/mind-map/' },
].filter((d) => !ONLY || d.id === ONLY);
const RENDERERS = ['webgpu', 'canvas'];

// Runs in the page before any of its scripts.
function instrument() {
  const raf = window.requestAnimationFrame.bind(window);
  const frames = [];
  window.__bench = { frames, phases: [], long: [], started: null, backend: null, errors: [] };
  window.requestAnimationFrame = (callback) =>
    raf((ts) => {
      const t0 = performance.now();
      try {
        callback(ts);
      } finally {
        frames.push([t0, performance.now() - t0]);
      }
    });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__bench.long.push(e.duration);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const info = console.info.bind(console);
  console.info = (...a) => {
    if (typeof a[0] === 'string' && a[0].includes('renderer:')) {
      window.__bench.started = performance.now();
      window.__bench.backend = String(a[1]);
    }
    info(...a);
  };
  addEventListener('error', (e) => window.__bench.errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => window.__bench.errors.push(String(e.reason)));
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (x) => (x == null ? null : Math.round(x * 100) / 100);

async function interact(page) {
  const box = await page.locator('#zgui-canvas').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const phase = (name) => page.evaluate((n) => window.__bench.phases.push([n, performance.now()]), name);
  // Hover sweep: hit testing and hover styles on every move.
  await phase('hover');
  await page.mouse.move(box.x + 20, cy);
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + 20 + ((box.width - 40) * i) / 60, cy + Math.sin(i / 6) * 120);
    await page.waitForTimeout(16);
  }
  // Wheel: scroll or zoom, depending on the demo.
  await phase('wheel');
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 20; i++) {
    if (i === 10) await phase('wheelBack');
    await page.mouse.wheel(0, i < 10 ? 120 : -120);
    await page.waitForTimeout(50);
  }
  // Drag: pans the map or drags a node; selects or scrolls in the gallery.
  await phase('drag');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) {
    await page.mouse.move(cx + Math.cos(i / 6) * 150, cy + Math.sin(i / 6) * 100);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

async function runOnce(browser, demo, renderer) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(instrument);
  const url = `${BASE}${demo.path}?renderer=${renderer}`;
  await page.goto(url, { waitUntil: 'load' });

  try {
    await page.waitForFunction(() => window.__bench.started || window.__bench.errors.length, null, {
      timeout: 60_000,
    });
  } catch {}
  const boot = await page.evaluate(() => ({
    started: window.__bench.started,
    backend: window.__bench.backend,
    errors: window.__bench.errors,
  }));
  if (!boot.started) {
    await context.close();
    return { ok: false, error: boot.errors[0] || 'renderer never started' };
  }

  // Let startup settle, then measure only the interaction window.
  await page.waitForTimeout(1000);
  const adapter = await page.evaluate(async () => {
    if (!navigator.gpu) return 'no navigator.gpu';
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return 'no adapter';
    const i = a.info || {};
    return `${i.vendor || '?'} ${i.architecture || ''}${a.isFallbackAdapter || i.isFallbackAdapter ? ' (fallback)' : ''}`.trim();
  });
  const mark = await page.evaluate(() => performance.now());
  await interact(page);
  await page.waitForTimeout(500);
  const end = await page.evaluate(() => performance.now());

  const m = await page.evaluate(
    ([mark, end]) => {
      const fr = window.__bench.frames.filter(([t]) => t >= mark && t <= end);
      const ph = window.__bench.phases;
      const phaseMax = {};
      ph.forEach(([n, t], i) => {
        const until = i + 1 < ph.length ? ph[i + 1][1] : end;
        const ds = fr.filter(([s]) => s >= t && s < until).map(([, d]) => d);
        phaseMax[n] = ds.length ? Math.max(...ds) : null;
      });
      return {
        phaseMax,
        work: fr.map(([, d]) => d),
        starts: fr.map(([t]) => t),
        long: window.__bench.long,
        heap: performance.memory ? performance.memory.usedJSHeapSize : null,
      };
    },
    [mark, end],
  );
  await context.close();

  const gaps = m.starts.slice(1).map((t, i) => t - m.starts[i]);
  const cadence = pct(gaps, 50);
  return {
    ok: true,
    backend: boot.backend,
    adapter,
    cadenceMs: cadence,
    hoverMax: m.phaseMax.hover,
    wheelMax: m.phaseMax.wheel,
    wheelBackMax: m.phaseMax.wheelBack,
    dragMax: m.phaseMax.drag,
    startupMs: boot.started,
    frames: m.work.length,
    workP50: pct(m.work, 50),
    workP95: pct(m.work, 95),
    workMax: pct(m.work, 100),
    gapP95: pct(gaps, 95),
    dropped: gaps.filter((g) => g > cadence * 1.5).length,
    longTasks: m.long.length,
    longTaskMs: m.long.reduce((a, b) => a + b, 0),
    heapMB: m.heap == null ? null : m.heap / 2 ** 20,
  };
}

const median = (xs) => pct(xs.filter((x) => x != null), 50);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !HEADED,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
const raw = [];
for (const demo of DEMOS) {
  for (const renderer of RENDERERS) {
    for (let run = 1; run <= RUNS; run++) {
      process.stderr.write(`${demo.id} ${renderer} run ${run}/${RUNS}… `);
      const r = await runOnce(browser, demo, renderer);
      process.stderr.write(r.ok ? `${r.backend}, ${r.frames} frames\n` : `FAILED: ${r.error}\n`);
      raw.push({ demo: demo.id, renderer, run, ...r });
    }
  }
}
await browser.close();

// Median of each metric across runs.
const rows = [];
for (const demo of DEMOS) {
  for (const renderer of RENDERERS) {
    const runs = raw.filter((r) => r.demo === demo.id && r.renderer === renderer && r.ok);
    const failed = raw.filter((r) => r.demo === demo.id && r.renderer === renderer && !r.ok);
    const med = (k) => round(median(runs.map((r) => r[k])));
    rows.push({
      demo: demo.name,
      renderer: renderer === 'webgpu' ? 'WebGPU' : 'Canvas 2D',
      runs: `${runs.length}/${runs.length + failed.length}`,
      'startup ms': med('startupMs'),
      frames: med('frames'),
      'frame p50 ms': med('workP50'),
      'frame p95 ms': med('workP95'),
      'frame max ms': med('workMax'),
      'hover max': med('hoverMax'),
      'wheel+ max': med('wheelMax'),
      'wheel− max': med('wheelBackMax'),
      'drag max': med('dragMax'),
      'cadence ms': med('cadenceMs'),
      'gap p95 ms': med('gapP95'),
      dropped: med('dropped'),
      'long tasks': med('longTasks'),
      'heap MB': med('heapMB'),
      adapter: runs[0]?.adapter ?? '',
      error: failed[0]?.error ?? '',
    });
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const out = new URL(`./results/${stamp}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ base: BASE, runs: RUNS, headed: HEADED, rows, raw }, null, 2));

const cols = Object.keys(rows[0]).filter((c) => c !== 'error' || rows.some((r) => r.error));
const fmt = (v) => (v == null ? '–' : String(v));
const lines = [
  `| ${cols.join(' | ')} |`,
  `|${cols.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${cols.map((c) => fmt(r[c])).join(' | ')} |`),
];
console.log(`${BASE} · ${RUNS} runs each · ${HEADED ? 'headed' : 'headless'} Chrome · medians\n`);
console.log(lines.join('\n'));
console.log(`\nraw: ${out.pathname}`);
