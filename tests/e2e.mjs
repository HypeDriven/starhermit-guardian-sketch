/**
 * Guardian Sketch — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play (journey stage 1) → setup → draw an ink barrier with the
 *   on-screen keyboard pen (Arrow keys + Space, the documented bindings) →
 *   Release → storm playback → Skip → results ("Saved!") → progression
 *   persisted → next stage → pause/resume → quit to title → settings → help.
 * Two passes: desktop 1280x800 and mobile 390x844 (touch context).
 *
 * Self-contained: serves the repo over an embedded static server on an
 * ephemeral port (server.js is the game's authoritative server and is
 * NOT used here). The embedded server answers /api/v1/time plus minimal
 * stubs of the game's own-server score/leaderboard routes so the wired
 * client paths get real responses; hosted-mode platform calls are inert
 * without a launch token. The game is fully playable offline.
 *
 * Run: npm run test:e2e
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/guardian-sketch-e2e-${stage}-${vp}.png`;

// Benign GPU/swiftshader console noise (from tools/production_game_audit.mjs).
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|WebGL context could not be created|Failed to load resource.*favicon/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'application/typescript; charset=utf-8'
};

function createServer() {
  // Minimal stand-in for the game's own server.js API surface so the wired
  // client paths (score submit + board read) get real 200s in the harness.
  const boardEntries = [];
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/v1/time') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ now: Date.now() }));
        return;
      }
      if (url.pathname === '/api/v1/leaderboard') {
        const board = url.searchParams.get('board') || '';
        const entries = boardEntries
          .filter((e) => e.board === board)
          .sort((a, b) => b.score - a.score)
          .slice(0, 50);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ board, entries, validated: true }));
        return;
      }
      if (url.pathname === '/api/v1/score' && req.method === 'POST') {
        let raw = '';
        await new Promise((resolve, reject) => {
          req.on('data', (c) => { raw += c; if (raw.length > 200000) reject(new Error('too big')); });
          req.on('end', resolve);
          req.on('error', reject);
        });
        const body = JSON.parse(raw || '{}');
        const entry = {
          board: String(body.board || ''), name: String(body.name || 'guest'),
          sessionId: String(body.sessionId || ''), score: (body.envelope && body.envelope.result) ? body.envelope.result.score : 0,
          won: !!(body.envelope && body.envelope.result && body.envelope.result.won),
          invalid: 0, durationMs: 0
        };
        boardEntries.push(entry);
        const ranked = boardEntries.filter((e) => e.board === entry.board);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, position: ranked.length, of: ranked.length,
          top: ranked.slice(-10) }));
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    } catch (e) {
      res.writeHead(404); res.end('not found');
    }
  });
}

// Move the on-screen keyboard pen by holding a key for an exact number of
// rAF frames (14 world units/frame — the game's documented pen step).
async function movePen(page, key, frames) {
  const f0 = await page.evaluate(() => window.__gsFrames);
  await page.keyboard.down(key);
  await page.waitForFunction((target) => window.__gsFrames >= target, f0 + frames, { timeout: 15000 });
  await page.keyboard.up(key);
}

async function runPass(browser, name, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { const t = `pageerror: ${e.message}`; if (!browserNoise.test(t)) errors.push(t); });
  page.on('console', (m) => { if (m.type() === 'error' && !browserNoise.test(m.text())) errors.push(`console: ${m.text()}`); });

  const step = async (label, fn) => { await fn(); console.log(`ok - [${name}] ${label}`); };

  try {
    await step('load → title screen visible', async () => {
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('.gs-title .gs-logo', { timeout: 15000 });
      const heading = await page.textContent('.gs-title .gs-logo');
      if (!/Guardian Sketch/.test(heading)) throw new Error('title heading missing');
      await page.screenshot({ path: SHOT('title', name) });
    });

    await step('Play → journey stage 1 setup', async () => {
      await page.getByRole('button', { name: 'Play' }).click();
      await page.waitForSelector('.gs-panel h2', { timeout: 5000 });
      const title = await page.textContent('.gs-panel h2');
      if (!/First Drops/.test(title)) throw new Error('expected stage 1 setup, got: ' + title);
      await page.screenshot({ path: SHOT('setup', name) });
    });

    await step('Start → draw phase with HUD', async () => {
      await page.getByRole('button', { name: 'Start' }).click();
      await page.waitForSelector('.gs-hud:not(.gs-hidden)', { timeout: 5000 });
      if (await page.locator('.gs-bar.gs-hidden').count()) throw new Error('action tray hidden in play');
      const ink = await page.textContent('.gs-ink-label');
      if (!/520 ink · 3 strokes/.test(ink)) throw new Error('unexpected ink label: ' + ink);
      // frame counter for precise pen movement
      await page.evaluate(() => {
        window.__gsFrames = 0;
        const tick = () => { window.__gsFrames++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
    });

    await step('draw a barrier with the keyboard pen (arrows + Space)', async () => {
      // Pen starts at world (500,350); wisp at (500,60), rain at x=500.
      // Draw the flat bar the rules' own solver uses: (330,150) → (670,150).
      await movePen(page, 'ArrowDown', 14); // y 350 → ~154
      await movePen(page, 'ArrowLeft', 12); // x 500 → ~332
      await page.keyboard.press('Space');   // pen down
      await movePen(page, 'ArrowRight', 24); // x → ~668, stroke committed on pen up
      await page.keyboard.press('Space');   // pen up → commit stroke
      await page.waitForFunction(() => /2 strokes/.test(document.querySelector('.gs-ink-label')?.textContent || ''), null, { timeout: 5000 });
      const ink = await page.textContent('.gs-ink-label');
      console.log(`  [${name}] after stroke: ${ink.trim()}`);
      await page.screenshot({ path: SHOT('play', name) });
    });

    await step('Release storm → skip playback → results (Saved!)', async () => {
      await page.getByRole('button', { name: 'Release' }).click();
      await page.waitForTimeout(400); // let the storm playback start
      await page.keyboard.press('p');
      await page.waitForFunction(() => /Paused/.test(document.querySelector('.gs-panel h2')?.textContent || ''));
      await page.waitForTimeout(12000); // longer than stage 1 playback: pause must freeze it
      if (!/Paused/.test(await page.textContent('.gs-panel h2'))) throw new Error('storm resolved while paused');
      await page.keyboard.press('Escape');
      if (await page.locator('.gs-overlay').count()) throw new Error('Escape failed to resume storm');
      await page.keyboard.press('s'); // skip storm playback (documented binding)
      await page.waitForSelector('.gs-panel h2', { timeout: 10000 });
      await page.waitForFunction(() => /Saved!|Hit at|Resigned/.test(document.querySelector('.gs-panel h2')?.textContent || ''), null, { timeout: 10000 });
      const headline = (await page.textContent('.gs-panel h2')).trim();
      console.log(`  [${name}] results headline: ${headline}`);
      if (headline !== 'Saved!') throw new Error('expected a win on stage 1, got: ' + headline);
      const stars = await page.textContent('.gs-big-stars');
      if (!/★/.test(stars)) throw new Error('no stars awarded on a win');
      await page.screenshot({ path: SHOT('results', name) });
    });

    await step('progression persisted (journey star + stats)', async () => {
      const saved = await page.evaluate(() => {
        const raw = localStorage.getItem('guardiansketch.save.v1');
        return raw ? JSON.parse(JSON.parse(raw).payload) : null;
      });
      if (!saved) throw new Error('save document missing');
      const stars = saved.progress.journeyStars.j01 || 0;
      if (stars < 1) throw new Error('j01 star not persisted');
      if (saved.progress.stats.rounds < 1 || saved.progress.stats.saves < 1) throw new Error('stats not recorded');
      console.log(`  [${name}] j01 stars: ${stars}, rounds: ${saved.progress.stats.rounds}`);
    });

    await step('Next level → pause → resume', async () => {
      await page.getByRole('button', { name: 'Next level' }).click();
      await page.waitForSelector('.gs-panel h2');
      await page.getByRole('button', { name: 'Start' }).click();
      await page.waitForSelector('.gs-hud:not(.gs-hidden)', { timeout: 5000 });
      await page.keyboard.press('p');
      await page.waitForSelector('.gs-panel h2');
      const pauseTitle = await page.textContent('.gs-panel h2');
      if (!/Paused/.test(pauseTitle)) throw new Error('pause panel missing');
      await page.screenshot({ path: SHOT('pause', name) });
      const inkBefore = await page.textContent('.gs-ink-label');
      await page.keyboard.press('Space');
      await page.keyboard.press('Space');
      if (await page.textContent('.gs-ink-label') !== inkBefore) throw new Error('Space drew behind pause panel');
      await page.keyboard.press('p');
      await page.waitForSelector('.gs-hud:not(.gs-hidden)', { timeout: 5000 });
      if (await page.locator('.gs-overlay').count()) throw new Error('pause overlay still open after resume');
    });

    await step('pause → quit to title', async () => {
      await page.getByRole('button', { name: '❚❚ Pause' }).click();
      await page.waitForSelector('.gs-panel h2');
      await page.getByRole('button', { name: 'Quit to title' }).click();
      await page.waitForSelector('.gs-title .gs-logo', { timeout: 5000 });
    });

    await step('settings open → toggle reduced motion → close', async () => {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.waitForSelector('.gs-panel h2');
      if (!/Settings/.test(await page.textContent('.gs-panel h2'))) throw new Error('settings panel missing');
      const row = page.locator('.gs-setrow', { hasText: 'Reduced motion' }).locator('input[type=checkbox]');
      await row.check();
      await page.waitForFunction(() => document.body.classList.contains('reduced-motion'), null, { timeout: 3000 });
      const persisted = await page.evaluate(() => {
        const raw = localStorage.getItem('guardiansketch.save.v1');
        return raw ? JSON.parse(JSON.parse(raw).payload).settings.reducedMotion : null;
      });
      if (persisted !== true) throw new Error('reduced motion not persisted');
      await page.screenshot({ path: SHOT('settings', name) });
      await page.getByRole('button', { name: 'Done' }).click();
      await page.waitForSelector('.gs-title .gs-logo', { timeout: 5000 });
    });

    await step('help open → close', async () => {
      await page.getByRole('button', { name: 'Help' }).click();
      await page.waitForSelector('.gs-panel h2');
      if (!/How to play/.test(await page.textContent('.gs-panel h2'))) throw new Error('help panel missing');
      await page.getByRole('button', { name: 'Close' }).click();
      await page.waitForSelector('.gs-title .gs-logo', { timeout: 5000 });
    });
  } finally {
    await context.close();
  }

  if (errors.length) {
    throw new Error(`[${name}] page errors:\n` + errors.join('\n'));
  }
}

const server = createServer();
let browser = null;
let BASE = null;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio']
  });

  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } });
  await runPass(browser, 'mobile', {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2
  });

  console.log('\nE2E PASS — guardian-sketch, desktop + mobile, no page errors');
} catch (e) {
  console.error('\nE2E FAIL — ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
