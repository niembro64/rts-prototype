import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backdropDir = path.join(root, 'public', 'assets', 'backdrops');
const manifestPath = path.join(backdropDir, 'manifest.json');
const worldRenderConfig = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'worldRenderConfig.json'), 'utf8'),
).presetBackdrop;
const colorsWorld = JSON.parse(
  fs.readFileSync(path.join(root, 'src', 'colorsConfig.json'), 'utf8'),
).world;
const generatorSource = fs.readFileSync(
  path.join(root, 'scripts', 'generate_backdrops.py'),
);
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const expectedLayerIds = ['near', 'middle', 'far', 'terminal'];
const expectedSlugs = [
  'large-circle',
  'angels-flat',
  'boulder-mountain',
  'spikey-lake',
  'niemo-islands',
  'angels-playhouse',
  'metal-hell',
  'metal-plate',
];
const ktx2Identifier = Buffer.from([
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const backdropPalette = {
  skyTop: colorsWorld.sky.topColor,
  skyMid: colorsWorld.sky.midColor,
  skyHorizon: colorsWorld.sky.horizonColor,
  water: colorsWorld.water.colorHex,
  lava: colorsWorld.water.lava.colorHex,
  outOfBounds: colorsWorld.map.outOfBounds.colorHex,
  cameraClear: colorsWorld.map.cameraClear.colorHex,
  inBounds: colorsWorld.map.inBounds.colorHex,
  sunCore: colorsWorld.sun.visibleSkyDisk.coreColor,
  sunHalo: colorsWorld.sun.visibleSkyDisk.haloColor,
  sun: colorsWorld.sun.colorHex,
  ground: colorsWorld.terrain.ground.baseColorHex,
  rocks: colorsWorld.terrain.rock.shadePaletteRgb,
  burnHot: colorsWorld.burnMark.hotColorHex,
  burnResidue: colorsWorld.burnMark.coolResidueColorHex,
  groundPrint: colorsWorld.groundPrint.colorHex,
};

function assertAudit(condition, message) {
  if (!condition) throw new Error(`[backdrop layer audit] ${message}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const layers = worldRenderConfig.layers;
assertAudit(Array.isArray(layers) && layers.length === 4, 'config must define four layers');
assertAudit(
  layers.map((layer) => layer.id).join(',') === expectedLayerIds.join(','),
  'config layer IDs/order must be near,middle,far,terminal',
);
for (let index = 1; index < layers.length; index++) {
  assertAudit(
    layers[index - 1].minimumDistanceWorldUnits < layers[index].minimumDistanceWorldUnits,
    'minimum distances must increase',
  );
  assertAudit(
    layers[index - 1].distanceMapFactor < layers[index].distanceMapFactor,
    'map-distance factors must increase',
  );
  assertAudit(
    layers[index - 1].blurRadiusPixels < layers[index].blurRadiusPixels,
    'nearer layers must be less blurry',
  );
}

assertAudit(manifest.schemaVersion === 1, 'manifest schema must be version 1');
assertAudit(
  manifest.generator?.visualRevision === 1,
  'manifest visual revision must match the generator',
);
assertAudit(manifest.encoder?.package === 'basisu', 'manifest encoder must be basisu');
assertAudit(
  manifest.encoder?.version === packageLock.packages?.['node_modules/basisu']?.version,
  'manifest encoder version must match the pinned npm dependency',
);
assertAudit(manifest.encoding?.container === 'KTX2', 'assets must use the KTX2 container');
assertAudit(
  manifest.encoding?.supercompressionFormat === 'UASTC',
  'assets must use UASTC texture compression',
);
assertAudit(
  manifest.encoding?.supercompressionScheme === 'Zstandard',
  'UASTC assets must use Zstandard supercompression',
);
assertAudit(manifest.encoding?.mipmapLevels === 1, 'backdrops must contain one mip level');
assertAudit(
  manifest.encoding?.yFlippedForThreeJsUv === true,
  'backdrops must preserve the existing Three.js panorama orientation',
);

const expectedInputHashes = {
  backdropPaletteSha256: sha256(canonicalJson(backdropPalette)),
  presetBackdropConfigSha256: sha256(canonicalJson(worldRenderConfig)),
};
for (const [name, value] of Object.entries(expectedInputHashes)) {
  assertAudit(manifest.inputHashes?.[name] === value, `${name} is stale; regenerate backdrops`);
}
const fingerprintContract = {
  schemaVersion: manifest.schemaVersion,
  inputHashes: manifest.inputHashes,
  generator: manifest.generator,
  encoder: manifest.encoder,
  encoding: manifest.encoding,
};
assertAudit(
  manifest.fingerprint === sha256(canonicalJson(fingerprintContract)),
  'manifest fingerprint does not match its generation contract',
);

const expectedAssetNames = expectedSlugs.flatMap((slug) => (
  expectedLayerIds.map((layer) => `${slug}-${layer}.ktx2`)
));
assertAudit(
  Array.isArray(manifest.assets) && manifest.assets.length === expectedAssetNames.length,
  'manifest must describe all 32 backdrop textures',
);
assertAudit(
  manifest.assets.map((asset) => asset.file).join(',') === expectedAssetNames.join(','),
  'manifest asset order/names must match the preset layer contract',
);

for (let assetIndex = 0; assetIndex < manifest.assets.length; assetIndex++) {
  const asset = manifest.assets[assetIndex];
  const layerIndex = assetIndex % layers.length;
  const layer = layers[layerIndex];
  const expectedName = expectedAssetNames[assetIndex];
  const assetPath = path.join(backdropDir, expectedName);
  assertAudit(fs.existsSync(assetPath), `missing ${path.relative(root, assetPath)}`);
  const bytes = fs.readFileSync(assetPath);
  assertAudit(bytes.subarray(0, 12).equals(ktx2Identifier), `${expectedName} is not KTX2`);
  assertAudit(bytes.readUInt32LE(12) === 0, `${expectedName} must use a Basis universal payload`);
  assertAudit(bytes.readUInt32LE(16) === 1, `${expectedName} KTX typeSize must be 1`);
  const width = bytes.readUInt32LE(20);
  const height = bytes.readUInt32LE(24);
  assertAudit(width === layer.textureWidth, `${expectedName} width must match config`);
  assertAudit(height === width / 2, `${expectedName} must be 2:1 equirectangular`);
  assertAudit(bytes.readUInt32LE(28) === 0, `${expectedName} must be a 2D texture`);
  assertAudit(bytes.readUInt32LE(32) === 0, `${expectedName} must not be a texture array`);
  assertAudit(bytes.readUInt32LE(36) === 1, `${expectedName} must have one face`);
  assertAudit(bytes.readUInt32LE(40) === 1, `${expectedName} must have one mip level`);
  assertAudit(bytes.readUInt32LE(44) === 2, `${expectedName} must use Zstandard`);
  const dfdOffset = bytes.readUInt32LE(48);
  assertAudit(bytes[dfdOffset + 12] === 166, `${expectedName} must use UASTC`);
  assertAudit(bytes[dfdOffset + 14] === 2, `${expectedName} must be tagged sRGB`);
  const channelId = bytes[dfdOffset + 31] & 0x0f;
  const terminal = layer.id === 'terminal';
  assertAudit(
    channelId === (terminal ? 0 : 3),
    `${expectedName} must be ${terminal ? 'opaque RGB' : 'transparent RGBA'}`,
  );
  assertAudit(asset.width === width && asset.height === height, `${expectedName} manifest size is stale`);
  assertAudit(asset.hasAlpha === !terminal, `${expectedName} manifest alpha contract is stale`);
  assertAudit(asset.bytes === bytes.length, `${expectedName} manifest byte count is stale`);
  assertAudit(asset.sha256 === sha256(bytes), `${expectedName} checksum does not match manifest`);
}

const backdropFiles = fs.readdirSync(backdropDir);
assertAudit(!backdropFiles.some((name) => name.endsWith('.png')), 'runtime backdrop PNGs are forbidden');
assertAudit(
  backdropFiles.filter((name) => name.endsWith('.ktx2')).sort().join(',')
    === [...expectedAssetNames].sort().join(','),
  'backdrop directory contains unexpected KTX2 assets',
);

const transcoderDir = path.join(root, 'public', 'assets', 'basis');
const transcoderJs = fs.readFileSync(path.join(transcoderDir, 'basis_transcoder.js'));
const transcoderWasm = fs.readFileSync(path.join(transcoderDir, 'basis_transcoder.wasm'));
for (const name of ['basis_transcoder.js', 'basis_transcoder.wasm', 'README.md']) {
  const publicAsset = fs.readFileSync(path.join(transcoderDir, name));
  const threeSource = fs.readFileSync(
    path.join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis', name),
  );
  assertAudit(publicAsset.equals(threeSource), `${name} must match the installed Three.js version`);
}
assertAudit(transcoderJs.length > 20_000, 'Basis transcoder JavaScript is missing or truncated');
assertAudit(
  transcoderWasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])),
  'Basis transcoder WASM is missing or invalid',
);

const generatorText = generatorSource.toString('utf8');
const paintStarsOccurrences = generatorText.match(/paint_stars\s*\(/g) ?? [];
assertAudit(
  paintStarsOccurrences.length === 2
    && /paint_stars\s*\(\s*terminal\s*,/.test(generatorText),
  'stars must have one painter call and it must target terminal',
);

console.log('backdrop KTX2/UASTC audit passed');
