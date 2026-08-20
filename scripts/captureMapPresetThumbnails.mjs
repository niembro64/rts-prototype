#!/usr/bin/env node
/**
 * Capture one overhead still per authored map preset, for the lobby's map
 * picker.
 *
 * The lobby offers the eight authored maps as pictures rather than as a row
 * of names, so the pictures have to be the maps themselves — not painted
 * art that can drift away from what the terrain generator actually makes.
 * This drives the real app: apply the preset on the demo battle bar, let the
 * world rebuild, frame it with the same MAP OVERVIEW camera the game ships,
 * and take the game's own clean (no-HUD) still.
 *
 * Re-run it whenever a preset's terrain numbers change:
 *   node scripts/captureMapPresetThumbnails.mjs
 *   node scripts/captureMapPresetThumbnails.mjs --only=metal-hell
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '@playwright/test';

const PORT = Number(process.env.MAP_PREVIEW_PORT ?? 4181);
const BASE_URL = `http://127.0.0.1:${PORT}/budget-annihilation/`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const OUT_DIR = path.join(repoRoot, 'public', 'assets', 'map-previews');

/** What the lobby actually draws: a 4:3 tile a few hundred pixels across.
 *  The raw capture is a full canvas read — about a megabyte each — so every
 *  still is cropped to the tile's own shape and re-encoded at roughly twice
 *  the size it will be shown at, which is a picture rather than a frame
 *  buffer and keeps the whole set under a few hundred kilobytes. */
const TILE_WIDTH = 800;
const TILE_HEIGHT = 600;
const TILE_JPEG_QUALITY = 0.82;

/** Name as the BATTLE bar prints it -> the slug the lobby looks the file up
 *  by. Deliberately the preset's own `backdropSlug`, so one map has one
 *  asset name across the backdrop set and the thumbnail set. */
const PRESETS = [
  { name: 'Large Circle', slug: 'large-circle' },
  { name: 'Angels Flat', slug: 'angels-flat' },
  { name: 'Boulder Mountain', slug: 'boulder-mountain' },
  { name: 'Spikey Lake', slug: 'spikey-lake' },
  { name: 'Nemo Island', slug: 'niemo-islands' },
  { name: 'Angels Playhouse', slug: 'angels-playhouse' },
  { name: 'METAL HELL', slug: 'metal-hell' },
  { name: 'METAL PLATE', slug: 'metal-plate' },
];

const convertOnly = process.argv.includes('--convert-only');
const only = process.argv
  .find((arg) => arg.startsWith('--only='))
  ?.slice('--only='.length) ?? null;
const selected = only === null
  ? PRESETS
  : PRESETS.filter((p) => p.slug === only || p.name === only);
if (selected.length === 0) throw new Error(`Unknown preset: ${only}`);

async function serverReady() {
  try {
    return (await fetch(BASE_URL)).ok;
  } catch {
    return false;
  }
}

async function startServerIfNeeded() {
  if (await serverReady()) return null;
  const child = spawn(
    process.execPath,
    ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT)],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await serverReady()) return child;
    if (child.exitCode !== null) throw new Error('vite exited before becoming ready');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${BASE_URL}`);
}

/** The demo battle is loaded when its loading emblem has been up and gone
 *  again and a full-size canvas exists. */
async function waitForDemoBattle(page) {
  const deadline = Date.now() + 900_000;
  let sawLoading = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      loading: document.body.innerText.includes('LOADING DEMO BATTLE'),
      canvases: Array.from(document.querySelectorAll('canvas'))
        .map((n) => n.getBoundingClientRect())
        .filter((r) => r.width > 600 && r.height > 400).length,
    }));
    if (state.loading) sawLoading = true;
    if (sawLoading && !state.loading && state.canvases > 0) return;
    await page.waitForTimeout(2000);
  }
  throw new Error('Demo battle never finished loading');
}

/** Click a bar control by its tooltip.
 *
 *  Dispatched in-page rather than through the mouse: the bottom bars start
 *  collapsed, and this script drives the controls rather than the chrome that
 *  reveals them. The handlers are the same ones a real click reaches. */
async function clickByTitle(page, title) {
  const clicked = await page.evaluate((selectorTitle) => {
    const el = document.querySelector(`[title="${selectorTitle}"]`);
    if (el === null) return false;
    el.click();
    return true;
  }, title);
  if (!clicked) throw new Error(`No control titled "${title}"`);
}

async function presetIsActive(page, name) {
  return page.evaluate((title) => {
    const el = document.querySelector(`[title="${title}"]`);
    return el !== null && el.classList.contains('active');
  }, `Apply preset: ${name}`);
}

const FOG_TITLE =
  'Enable authoritative player vision, radar coverage, and fog-of-war filtering';

async function clearFogOfWar(page) {
  const on = await page.evaluate((title) => {
    const el = document.querySelector(`[title="${title}"]`);
    return el !== null && el.classList.contains('active');
  }, FOG_TITLE);
  if (!on) return;
  await clickByTitle(page, FOG_TITLE);
  await page.waitForTimeout(2500);
}

/**
 * Crop one captured still to the tile's aspect and re-encode it small.
 *
 * Done in the browser that is already open rather than with an image
 * library: the tool stays dependency-free and produces the same picture on
 * every platform. The crop is the same cover-crop the CSS grid performs, so
 * what is stored is exactly what is shown.
 */
async function shrinkToTileJpeg(page, pngPath, jpegPath) {
  const base64 = (await readFile(pngPath)).toString('base64');
  const dataUrl = await page.evaluate(async ({ b64, width, height, quality }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const scale = Math.max(width / image.width, height / image.height);
    const sourceWidth = width / scale;
    const sourceHeight = height / scale;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      image,
      (image.width - sourceWidth) / 2,
      (image.height - sourceHeight) / 2,
      sourceWidth,
      sourceHeight,
      0,
      0,
      width,
      height,
    );
    return canvas.toDataURL('image/jpeg', quality);
  }, { b64: base64, width: TILE_WIDTH, height: TILE_HEIGHT, quality: TILE_JPEG_QUALITY });
  await writeFile(jpegPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await rm(pngPath, { force: true });
}

const vite = convertOnly ? null : await startServerIfNeeded();
await mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'warning' || msg.type() === 'error' || text.includes('[capture]')) {
      console.log(`[page:${msg.type()}]`, text);
    }
  });
  // The demo battle renders through an OffscreenCanvas worker when one is
  // available, which the download-based still capture cannot read.
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
      value: undefined,
      configurable: true,
    });
  });

  if (convertOnly) {
    // Re-encode stills that are already on disk, without booting the game.
    for (const preset of selected) {
      const raw = path.join(OUT_DIR, `${preset.slug}.png`);
      const tile = path.join(OUT_DIR, `${preset.slug}.jpg`);
      await shrinkToTileJpeg(page, raw, tile);
      console.log(`   wrote ${path.relative(repoRoot, tile)}`);
    }
    await browser.close();
    process.exit(0);
  }

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await waitForDemoBattle(page);
  console.log('demo battle ready');

  // A map picture is the map, not the shell around it. The overlays are
  // hidden with CSS rather than with the game's own chrome toggle so they
  // stay in the DOM: this script drives their buttons for the rest of the
  // run, and a JS click still reaches a display:none control.
  await page.addStyleTag({
    content: `
      .menu-sidebar, .top-controls-shell, .bottom-controls-shell,
      .bottom-controls-toggle, .lobby-controls-sidebar, .minimap-stack,
      .communication-panel, .communication-toggle, .fullscreen-game-toggle,
      .ui-chrome-restore, .map-details-panel, .options-menu-panel,
      .capture-control-grid, .idle-builders-panel,
      .camera-tutorial { display: none !important; }
    `,
  });

  for (const preset of selected) {
    console.log(`-- ${preset.name}`);
    // Applying the preset that is ALREADY applied changes nothing, so the
    // world keeps running and the picture ends up buried under an hour of
    // demo army. Bounce off another preset first so every map is pictured at
    // the same age: a freshly generated world with the starting commanders
    // on it.
    if (await presetIsActive(page, preset.name)) {
      const other = PRESETS.find((p) => p.name !== preset.name);
      await clickByTitle(page, `Apply preset: ${other.name}`);
      await page.waitForTimeout(2500);
      await waitForDemoBattle(page);
    }
    await clickByTitle(page, `Apply preset: ${preset.name}`);
    // Applying a preset tears the world down and rebuilds it; wait for the
    // loading emblem to come and go again rather than guessing a delay.
    await page.waitForTimeout(2500);
    await waitForDemoBattle(page);
    // Fog is a match condition, not a property of the ground: a picture with
    // half the map blacked out would advertise the demo's vision state rather
    // than the map. Every preset switches it back on, so it is cleared again
    // on each pass.
    await clearFogOfWar(page);
    await clickByTitle(page, 'Switch to an overhead map overview');
    // Let the camera settle and a few frames of vegetation/props stream in.
    await page.waitForTimeout(6000);

    const clip = await page.evaluate(() => {
      const canvas = Array.from(document.querySelectorAll('canvas'))
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 600 && rect.height > 400)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (canvas === undefined) return null;
      return { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height };
    });
    if (clip === null) throw new Error('No game canvas to capture');

    const raw = path.join(OUT_DIR, `${preset.slug}.png`);
    const tile = path.join(OUT_DIR, `${preset.slug}.jpg`);
    await rm(raw, { force: true });
    await page.screenshot({ path: raw, clip, timeout: 180_000 });
    await shrinkToTileJpeg(page, raw, tile);
    console.log(`   wrote ${path.relative(repoRoot, tile)}`);
  }

  await writeFile(
    path.join(OUT_DIR, 'README.txt'),
    'Generated by scripts/captureMapPresetThumbnails.mjs — do not hand-edit.\n',
  );
} finally {
  await browser.close();
  if (vite !== null) vite.kill();
}
