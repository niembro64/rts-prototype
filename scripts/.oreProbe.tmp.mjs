// Diagnose the terrain shading normal: are terrain triangles back-facing, and
// does three's DOUBLE_SIDED faceDirection flip therefore invert the normal the
// lighting uses? Replicates the GPU's own front-face test (sign of the signed
// area in window coordinates) rather than trusting a code comment.
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const server = await createServer({ server: { host: '127.0.0.1', port: 5201 } });
await server.listen();
const url = server.resolvedUrls?.local[0];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=default', '--enable-webgl', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    globalThis.__THREE_DEVTOOLS__ = new EventTarget();
    globalThis.__probe = {};
    globalThis.__THREE_DEVTOOLS__.addEventListener('observe', (e) => {
      const obj = e.detail;
      if (obj && obj.isWebGLRenderer && !obj.__probeWrapped) {
        obj.__probeWrapped = true;
        const orig = obj.render.bind(obj);
        obj.render = (scene, camera) => {
          globalThis.__probe.scene = scene;
          globalThis.__probe.camera = camera;
          globalThis.__probe.renderer = obj;
          return orig(scene, camera);
        };
      }
    });
    const set = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    set('demo-battle-center-magnitude', 1600);
    set('demo-battle-dividers-magnitude', 800);
    set('demo-battle-perimeter-magnitude', -400);
    set('demo-battle-terrain-d-terrain', 0);
    set('demo-battle-metal-deposit-step', 0);
    set('demo-battle-terrain-detail', 4);
    set('demo-battle-map-width-land-cells', 119);
    set('demo-battle-map-length-land-cells', 119);
    set('demo-battle-fog-of-war-enabled', false);
    set('demo-battle-terrain-surface-mode', 'normal');
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(32000);

  // A/B the outward-normal correction on ONE frozen camera, so the only
  // thing that differs between the two images is the shading normal.
  const OUT = '/private/tmp/claude-501/-Users-ericniemeyer-code-rts-prototype/935029c0-6121-4b95-a4da-8d9adc82737d/scratchpad/shots';
  const findTerrain = `(() => { let t = null;
    globalThis.__probe.scene.traverse((o) => {
      if (o.isMesh && !t && o.geometry?.getAttribute?.('terrainShade')) t = o;
    });
    return t; })()`;

  // Grab the live uniform object by re-running onBeforeCompile: no debug
  // plumbing has to exist in the shipped renderer for this.
  await page.evaluate(`(() => {
    const t = ${findTerrain};
    const orig = t.material.onBeforeCompile;
    t.material.onBeforeCompile = function (shader, renderer) {
      orig.call(this, shader, renderer);
      globalThis.__probe.terrainShader = shader;
    };
    // Force a NEW program: with the shipped cache key three reuses the
    // compiled one and never re-runs onBeforeCompile.
    t.material.customProgramCacheKey = () => 'probe-' + Date.now();
    t.material.needsUpdate = true;
  })()`);
  await page.waitForTimeout(800);

  const setKnob = (v) => page.evaluate((val) => {
    const u = globalThis.__probe.terrainShader?.uniforms?.uTerrainOutwardNormalScope;
    if (!u) return 'no uniform';
    u.value = val;
    return `set ${val}`;
  }, v);

  // TRUE A/B: stop the app's animation loop, then re-render the very same
  // scene and camera with only the uniform changed. Anything that differs
  // between the two images is the shading normal and nothing else.
  await page.evaluate(`(() => {
    globalThis.__probe.realRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = () => 0;
  })()`);
  await page.waitForTimeout(1200);

  const renderWith = (v) => page.evaluate((val) => {
    const p = globalThis.__probe;
    const u = p.terrainShader?.uniforms?.uTerrainOutwardNormalScope;
    if (!u) return 'no uniform';
    u.value = val;
    p.renderer.render(p.scene, p.camera);
    return `rendered with ${val}`;
  }, v);

  console.log(await renderWith(0));
  await page.screenshot({ path: `${OUT}/scope-0-off.png` });
  console.log(await renderWith(1));
  await page.screenshot({ path: `${OUT}/scope-1-ore.png` });
  console.log(await renderWith(2));
  await page.screenshot({ path: `${OUT}/scope-2-terrain.png` });
  console.log(await renderWith(0));
  await page.screenshot({ path: `${OUT}/scope-0b-off.png` });

  const report = await page.evaluate(() => {
    const p = globalThis.__probe;
    if (!p?.scene) return { error: 'no scene captured' };
    let terrain = null;
    p.scene.traverse((o) => {
      if (!o.isMesh || terrain) return;
      const g = o.geometry;
      const count = g?.getAttribute?.('position')?.count ?? 0;
      // The authoritative terrain mesh: the one carrying the terrainShade
      // attribute the terrain shader declares.
      if (g?.getAttribute?.('terrainShade') && count > 100) terrain = o;
    });
    if (!terrain) return { error: 'no terrain mesh found' };

    const g = terrain.geometry;
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const idx = g.getIndex();
    const cam = p.camera;
    terrain.updateWorldMatrix(true, false);
    cam.updateMatrixWorld(true);
    const mvp = new (Object.getPrototypeOf(cam.projectionMatrix).constructor)();
    mvp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    mvp.multiply(terrain.matrixWorld);

    const toNdc = (i) => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const e = mvp.elements;
      const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      return { x: cx / cw, y: cy / cw, w: cw };
    };

    let frontFacing = 0, backFacing = 0, skipped = 0;
    let upNormals = 0, downNormals = 0;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const step = Math.max(1, Math.floor(triCount / 4000));
    for (let t = 0; t < triCount; t += step) {
      const a = idx ? idx.getX(t * 3) : t * 3;
      const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      // Authored lighting normal orientation (world Y up in three space).
      const ny = (nrm.getY(a) + nrm.getY(b) + nrm.getY(c)) / 3;
      if (ny > 0.1) upNormals++; else if (ny < -0.1) downNormals++;

      const A = toNdc(a), B = toNdc(b), C = toNdc(c);
      if (A.w <= 0 || B.w <= 0 || C.w <= 0) { skipped++; continue; }
      // Window-space signed area. WebGL default frontFace is CCW; NDC y is up
      // while window y is down, so the winding sign flips once on the way to
      // window coordinates — hence the negation here.
      const area = -((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y));
      if (area > 0) frontFacing++; else backFacing++;
    }
    return {
      material: terrain.material.type,
      side: terrain.material.side,
      DoubleSide: 2,
      metalness: terrain.material.metalness,
      roughness: terrain.material.roughness,
      triCount, sampled: Math.ceil(triCount / step), step,
      frontFacing, backFacing, skipped,
      authoredNormalsUp: upNormals, authoredNormalsDown: downNormals,
    };
  });
  console.log(JSON.stringify(report, null, 1));
} finally {
  await browser.close();
  await server.close();
}
