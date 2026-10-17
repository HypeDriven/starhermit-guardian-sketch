// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics
// (Quality), plays Journey stage 1 through the visible UI — draws an ink barrier with the mouse on the
// page, presses Release and lets the storm play back (rain, blocked-drop sparks, hits, celebration) —
// then Retry, over and over, so hazards, particles and the post chain are always running.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('.gs-title .gs-logo', { timeout: 20000 });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForSelector('#gfx-preset');
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.locator('#gfx-preset').selectOption(preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset, { timeout: 15000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForSelector('.gs-title .gs-logo', { timeout: 5000 });
}

const visible = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).count();

async function drawBarrier(page) {
  const box = await page.locator('canvas.gs-gl').boundingBox();
  if (!box) return;
  const y = box.y + box.height * 0.62;
  await page.mouse.move(box.x + box.width * 0.36, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + box.width * (0.36 + 0.28 * i / 12), y - Math.sin(i / 12 * Math.PI) * 12);
  await page.mouse.up();
}

async function step(page) {
  if (await visible(page, 'Retry')) return page.getByRole('button', { name: 'Retry', exact: true }).click({ timeout: 5000 });
  if (await visible(page, 'Start')) return page.getByRole('button', { name: 'Start', exact: true }).click({ timeout: 5000 });
  if (await visible(page, 'Release')) {
    const ink = (await page.textContent('.gs-ink-label', { timeout: 2000 }).catch(() => '')) || '';
    if (!/·\s*[012] strokes?/.test(ink)) await drawBarrier(page);
    return page.getByRole('button', { name: 'Release', exact: true }).click({ timeout: 5000 });
  }
}

export async function start(page) {
  await page.getByRole('button', { name: 'Play' }).click();
  await page.waitForSelector('.gs-panel h2', { timeout: 5000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(400).catch(() => {});
    }
  })();
  await page.waitForTimeout(2500);
}
