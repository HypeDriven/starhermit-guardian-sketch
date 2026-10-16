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
 * NOT used here). The embedded server mocks the StarHermit /api routes for a
 * final signed-in pass; the offline passes must make no /api request. The
 * game is fully playable offline.
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

// StarHermit platform mocks for the signed-in pass; offline passes must make no /api call.
const apiLog = [];
// Per-pass platform state: account language, per-player settings KV, filed reports.
const mock = { preferredLanguage: 'en', kv: {}, reports: [] };
function platformMock(req, res, p) {
  apiLog.push(`${req.method} ${p}`);
  const json = (b, st = 200) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  const body = () => new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { resolve({}); } }); });
  if (p.endsWith('/profile')) return json({ username: 'raw', nickname: 'Inkwell' });
  if (p === '/api/v1/me/language') return json({ preferredLanguage: mock.preferredLanguage });
  if (/\/games\/guardian-test\/settings\/[^/]+$/.test(p) && req.method === 'PUT') {
    return body().then((b) => { mock.kv[p.split('/').pop()] = b.value; json({}); });
  }
  if (p.endsWith('/games/guardian-test/settings') && req.method === 'GET') return json({ settings: { music: 0.25, ...mock.kv } });
  if (p.endsWith('/games/guardian-test/settings')) return json({ settings: {} });
  if (p.endsWith('/games/guardian-test/reports') && req.method === 'POST') {
    return body().then((b) => { mock.reports.push(b); json({ id: 'r1', kind: b.kind, status: 'open', createdAt: new Date().toISOString() }, 201); });
  }
  if (p.endsWith('/games/guardian-test/controls')) return json({ actions: [{ action: 'release', codes: ['KeyE'] }] });
  if (p.endsWith('/cloud-saves/game:guardian-test/info')) return json({ exists: false });
  if (p.endsWith('/cloud-saves/game:guardian-test')) return json({ etag: '"v' + apiLog.length + '"' });
  return json({ error: 'not found' }, 404);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return platformMock(req, res, decodeURIComponent(url.pathname));
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
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console ${m.type()}: ${m.text()}`);
  });

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

    await step('settings → Graphics: presets, override, persistence across reload', async () => {
      const preset = () => page.evaluate(() => document.body.dataset.gfxPreset);
      const savedGfx = () => page.evaluate(() => {
        const raw = localStorage.getItem('guardiansketch.save.v1');
        return raw ? JSON.parse(JSON.parse(raw).payload).settings.graphics : null;
      });
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.waitForSelector('#gfx-preset');
      if (await preset() !== 'low') throw new Error('software GPU should resolve Auto to low, got ' + await preset());
      const autoLabel = await page.locator('#gfx-preset option[value=auto]').textContent();
      if (!/Low/.test(autoLabel)) throw new Error('Auto label lacks detected tier: ' + autoLabel);
      await page.getByLabel('Quality').selectOption('high');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'high', null, { timeout: 15000 });
      await page.waitForFunction(() => /2048² shadows/.test(document.getElementById('gfx-summary')?.textContent || ''), null, { timeout: 15000 });
      if (!/From preset \(On\)/.test(await page.locator('#gfx-bloom option[value=preset]').textContent())) throw new Error('bloom preset label wrong');
      await page.locator('#gfx-bloom').selectOption('off');
      await page.waitForFunction(() => !/bloom/.test(document.getElementById('gfx-summary')?.textContent || ''), null, { timeout: 15000 });
      let g = await savedGfx();
      if (!g || g.preset !== 'high' || g.bloom !== 'off') throw new Error('graphics not persisted: ' + JSON.stringify(g));
      await page.locator('#gfx-show-fps').check();
      await page.waitForSelector('#gs-fps', { state: 'attached', timeout: 15000 });
      await page.locator('#gfx-controls').scrollIntoViewIfNeeded();
      await page.screenshot({ path: SHOT('graphics', name) });
      await page.getByRole('button', { name: 'Done' }).click();
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('.gs-title .gs-logo', { timeout: 15000 });
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'high', null, { timeout: 15000 });
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.waitForSelector('#gfx-preset');
      if (await page.locator('#gfx-bloom').inputValue() !== 'off') throw new Error('bloom override lost on reload');
      if (await page.locator('#gfx-preset').inputValue() !== 'high') throw new Error('preset lost on reload');
      await page.locator('#gfx-preset').selectOption('ultra');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'ultra', null, { timeout: 15000 });
      if (await page.locator('#gfx-bloom').inputValue() !== 'preset') throw new Error('choosing a preset did not clear overrides');
      await page.waitForTimeout(1200); // render a few Ultra frames (console must stay clean)
      await page.locator('#gfx-preset').selectOption('auto');
      await page.waitForFunction(() => document.body.dataset.gfxPreset === 'low', null, { timeout: 15000 });
      await page.locator('#gfx-show-fps').uncheck();
      g = await savedGfx();
      if (!g || g.preset !== 'auto' || g.bloom || g.show_fps) throw new Error('auto preset not persisted cleanly: ' + JSON.stringify(g));
      await page.getByRole('button', { name: 'Done' }).click();
      await page.waitForSelector('.gs-title .gs-logo', { timeout: 15000 });
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

// Signed-in launch: nickname, synced settings, effective binding in Help,
// invite link from the visible title button, cloud slot seeded.
async function signedInPass(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console ${m.type()}: ${m.text()}`); });
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } } });
  });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = 'h.' + b64u({ sub: 'ink-12345678', game_scope: 'guardian-test', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
  try {
    await page.goto(`${BASE}/#game_token=${token}`, { waitUntil: 'load' });
    await page.waitForSelector('.gs-title .gs-logo', { timeout: 20000 });
    if (new URL(page.url()).hash) throw new Error('launch token left in the URL');
    await page.waitForFunction(() => /Signed in as Inkwell/.test(document.querySelector('.gs-sync-status')?.textContent || ''));
    if (await page.getByRole('button', { name: 'Sign in with StarHermit' }).count()) throw new Error('sign-in shown while signed in');
    const music = await page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem('guardiansketch.save.v1')).payload).settings.music);
    if (music !== 0.25) throw new Error('platform settings not applied: ' + music);
    await page.getByRole('button', { name: 'Invite a friend' }).click();
    await page.waitForFunction(() => window.__copied.length === 1);
    const link = await page.evaluate(() => window.__copied[0]);
    if (!/\/game-invite\/ink-12345678\/guardian-test$/.test(link)) throw new Error('bad invite link ' + link);
    await page.screenshot({ path: SHOT('title', 'signed-in') });
    await page.getByRole('button', { name: 'Help' }).click();
    const help = await page.textContent('.gs-bindings');
    if (!/E\s*Release the storm/.test(help)) throw new Error('help does not show the platform binding: ' + help);
    for (let i = 0; i < 40 && !apiLog.includes('PUT /api/v1/me/cloud-saves/game:guardian-test'); i++) await page.waitForTimeout(100);
    if (!apiLog.includes('PUT /api/v1/me/cloud-saves/game:guardian-test')) throw new Error('cloud slot not seeded: ' + apiLog.join(', '));
    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
    console.log('ok - [signed-in] nickname, synced settings, platform binding in Help, invite link, cloud seed');
  } finally {
    await context.close();
  }
}

// Language: Automatic follows the StarHermit preferred language (fr-CA); an
// explicit choice made in Settings mid-round re-renders the visible UI in place
// and is saved to ui.language; Report a problem posts a bug report.
async function languagePass(browser, name, contextOpts) {
  mock.preferredLanguage = 'fr-CA'; mock.kv = {}; mock.reports = [];
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !browserNoise.test(m.text())) errors.push(`console ${m.type()}: ${m.text()}`); });
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = 'h.' + b64u({ sub: 'ink-12345678', game_scope: 'guardian-test', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';
  try {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#game_token=${token}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.lang === 'fr-CA', null, { timeout: 20000 });
    await page.getByRole('button', { name: 'Jouer' }).click();
    await page.getByRole('button', { name: 'Commencer' }).click();
    await page.waitForSelector('.gs-ink-label');
    await page.getByRole('button', { name: '❚❚ Pause' }).click();
    await page.waitForFunction(() => /En pause/.test(document.querySelector('.gs-panel h2')?.textContent || ''));
    await page.getByRole('button', { name: 'Paramètres' }).click();
    const choice = page.locator('[data-game-language="choice"]');
    await choice.scrollIntoViewIfNeeded();
    const auto = await choice.locator('option').first().textContent();
    if (!/^Automatique — Français \(Canada\)$/.test(auto)) throw new Error('Automatic label not resolved: ' + auto);
    await choice.selectOption('it-IT');
    await page.waitForFunction(() => document.documentElement.lang === 'it-IT');
    await page.waitForFunction(() => /Salvato/.test(document.querySelector('[data-game-language="status"]')?.textContent || ''));
    if (mock.kv['ui.language']?.choice !== 'it-IT') throw new Error('ui.language not saved: ' + JSON.stringify(mock.kv));
    const titles = await page.locator('.gs-panel h2').allTextContents();
    if (!titles.includes('In pausa') || !titles.includes('Impostazioni')) throw new Error('panels not re-rendered: ' + titles.join(' | '));
    if (!/Qualità/.test(await page.locator('#gfx-controls').textContent())) throw new Error('graphics labels not re-rendered');
    if (!/inchiostro/.test(await page.textContent('.gs-ink-label'))) throw new Error('HUD not re-rendered');
    await page.locator('[data-game-report="title"]').scrollIntoViewIfNeeded();
    await page.fill('[data-game-report="title"]', 'Test report');
    await page.click('[data-game-report="send"]');
    await page.waitForFunction(() => /Grazie/.test(document.querySelector('[data-game-report="status"]')?.textContent || ''));
    if (!mock.reports[0] || mock.reports[0].kind !== 'bug') throw new Error('report not posted');
    await page.screenshot({ path: SHOT('language', name) });
    if (name === 'mobile') {
      await choice.selectOption('de-DE');
      await page.waitForFunction(() => document.documentElement.lang === 'de-DE');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) throw new Error('German settings overflow by ' + overflow + 'px');
      await page.screenshot({ path: SHOT('language-de-settings', name) });
    }
    await choice.selectOption('auto');
    await page.waitForFunction(() => document.documentElement.lang === 'fr-CA');
    await page.getByRole('button', { name: 'Terminé' }).click();
    await page.getByRole('button', { name: 'Reprendre' }).click();
    await page.getByRole('button', { name: 'Déclencher' }).waitFor();
    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
    console.log(`ok - [${name}] Language: Automatic follows fr-CA; Italian mid-round re-renders HUD and panels; ui.language saved; report posted`);
  } finally {
    await context.close();
    mock.preferredLanguage = 'en';
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

  if (apiLog.length) throw new Error('offline passes made platform calls: ' + apiLog.join(', '));
  await signedInPass(browser);
  await languagePass(browser, 'desktop', { viewport: { width: 1280, height: 800 } });
  await languagePass(browser, 'mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  console.log('\nE2E PASS — guardian-sketch, desktop + mobile, no page errors');
} catch (e) {
  console.error('\nE2E FAIL — ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
