#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const srcRoot = path.join(repoRoot, 'src');

const allowedFiles = new Set([
  'src/game/render3d/PrimitiveGeometryQuality3D.ts',
]);
const sourceExtensions = new Set(['.ts', '.tsx', '.vue']);
const forbiddenPrimitiveGeometry = /\bnew\s+(?:THREE\.)?(SphereGeometry|CylinderGeometry|ConeGeometry|CircleGeometry|RingGeometry|TorusGeometry)\b/g;

const violations = [];

await scanDirectory(srcRoot);

if (violations.length > 0) {
  console.error('Primitive geometry quality audit failed.');
  console.error('Route sphere/cylinder/cone/circle/ring/torus geometry through PrimitiveGeometryQuality3D.');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} ${violation.geometry}`);
  }
  process.exit(1);
}

console.log('primitive geometry quality audit passed');

async function scanDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await scanDirectory(fullPath);
      continue;
    }
    if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name))) continue;
    await scanFile(fullPath);
  }
}

async function scanFile(filePath) {
  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  if (allowedFiles.has(relativePath)) return;
  const source = await readFile(filePath, 'utf8');
  forbiddenPrimitiveGeometry.lastIndex = 0;
  let match;
  while ((match = forbiddenPrimitiveGeometry.exec(source)) !== null) {
    violations.push({
      file: relativePath,
      line: lineNumberAt(source, match.index),
      geometry: match[1],
    });
  }
}

function lineNumberAt(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}
