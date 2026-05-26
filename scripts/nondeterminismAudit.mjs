import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const SCAN_ROOTS = [
  'src/game/sim',
  'src/game/server',
  'rts-sim-wasm/src',
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.rs']);

const API_PATTERNS = [
  { token: 'Math.random', regex: /\bMath\.random\b/g, source: 'js' },
  { token: 'Date.now', regex: /\bDate\.now\b/g, source: 'js' },
  { token: 'performance.now', regex: /\bperformance\.now\b/g, source: 'js' },
  { token: 'Math.sin', regex: /\bMath\.sin\s*\(/g, source: 'js' },
  { token: 'Math.cos', regex: /\bMath\.cos\s*\(/g, source: 'js' },
  { token: 'Math.pow', regex: /\bMath\.pow\s*\(/g, source: 'js' },
  { token: 'HashMap', regex: /\bHashMap\b/g, source: 'all' },
  { token: 'HashSet', regex: /\bHashSet\b/g, source: 'all' },
  { token: 'rust.sin', regex: /\bsin\s*\(/g, source: 'rust' },
  { token: 'rust.cos', regex: /\bcos\s*\(/g, source: 'rust' },
  { token: 'rust.pow', regex: /\bpow(?:f|i)?\s*\(/g, source: 'rust' },
];

const SIM_TRIG_FILES = [
  'src/game/sim/Simulation.ts',
  'src/game/sim/commandExecution.ts',
  'src/game/sim/locomotion.ts',
  'src/game/sim/mapOval.ts',
  'src/game/sim/mirrorPanelCache.ts',
  'src/game/sim/terrain/terrainConfig.ts',
  'src/game/sim/terrain/terrainFlatZones.ts',
  'src/game/sim/terrain/terrainHeightGenerator.ts',
  'src/game/sim/terrain/terrainSurface.ts',
  'src/game/sim/unitSuspension.ts',
  'src/game/sim/wind.ts',
  'src/game/sim/combat/MirrorPanelHit.ts',
  'src/game/sim/combat/ProjectileCollisionHandler.ts',
  'src/game/sim/combat/aimSolver.ts',
  'src/game/sim/combat/projectileSystem.ts',
  'src/game/sim/combat/targetingInputStamping.ts',
];

const ALLOW_LIST = [
  {
    id: 'server-wall-clock',
    tokens: ['performance.now'],
    paths: [
      'src/game/server/ServerTickLoop.ts',
      'src/game/server/ServerSnapshotPublisher.ts',
      'src/game/server/LocalGameConnection.ts',
      'src/game/server/GameServer.ts',
    ],
    reason:
      'Wall-clock scheduling and diagnostics only; fixed-step simulation receives scheduled ticks, not elapsed wall time.',
  },
  {
    id: 'removed-wall-clock-comment',
    tokens: ['Date.now'],
    paths: ['src/game/sim/Simulation.ts'],
    line: /\bused to read Date\.now\b/,
    reason: 'Historical comment documenting the removed wall-clock wind path.',
  },
  {
    id: 'server-deterministic-force-trig',
    tokens: ['Math.sin', 'Math.cos'],
    paths: ['src/game/server/UnitForceSystem.ts'],
    reason:
      'Deterministic force projection from entity yaw; input is scheduled sim state.',
  },
  {
    id: 'sim-deterministic-trig',
    tokens: ['Math.sin', 'Math.cos'],
    paths: SIM_TRIG_FILES,
    reason:
      'Pure geometry/integration math over deterministic sim, terrain, or blueprint inputs; no ambient time or random source on these lines.',
  },
  {
    id: 'sim-fixed-step-damping-pow',
    tokens: ['Math.pow'],
    paths: [
      'src/game/sim/unitAirFriction.ts',
      'src/game/sim/unitGroundPhysics.ts',
    ],
    reason: 'Fixed-step damping coefficient from dt and friction config.',
  },
  {
    id: 'sim-display-color-math',
    tokens: ['Math.sin', 'Math.cos', 'Math.pow'],
    paths: ['src/game/sim/types.ts'],
    reason:
      'OKLCH color conversion for display data; not a gameplay time or random source.',
  },
  {
    id: 'ts-rust-container-comments',
    tokens: ['HashMap', 'HashSet'],
    paths: [
      'src/game/server/PhysicsEngine3D.ts',
      'src/game/server/GameServer.ts',
    ],
    reason: 'Comments about Rust-owned containers; no TypeScript unordered gameplay traversal.',
  },
  {
    id: 'rust-lookup-and-dedup-containers',
    tokens: ['HashMap', 'HashSet'],
    paths: ['rts-sim-wasm/src/lib.rs'],
    reason:
      'Keyed lookup, broadphase buckets, or query dedup only; gameplay-visible traversal remains slot-indexed or sorted.',
  },
  {
    id: 'rust-deterministic-math-kernels',
    tokens: ['rust.sin', 'rust.cos', 'rust.pow'],
    paths: ['rts-sim-wasm/src/lib.rs'],
    reason:
      'WASM-hosted math kernels over deterministic inputs; LS-09 keeps peers on one Rust runtime API.',
  },
];

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function walk(dir, out) {
  const absDir = path.join(ROOT, dir);
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    out.push(normalizePath(rel));
  }
}

function scanFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) walk(root, files);
  return files;
}

function patternApplies(pattern, file) {
  if (pattern.source === 'all') return true;
  if (pattern.source === 'rust') return file.endsWith('.rs');
  return !file.endsWith('.rs');
}

function collectHits(files) {
  const hits = [];
  for (const file of files) {
    const abs = path.join(ROOT, file);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of API_PATTERNS) {
        if (!patternApplies(pattern, file)) continue;
        pattern.regex.lastIndex = 0;
        if (!pattern.regex.test(line)) continue;
        hits.push({
          file,
          lineNumber: index + 1,
          line: line.trim(),
          token: pattern.token,
        });
      }
    });
  }
  return hits;
}

function pathAllowed(rule, file) {
  return rule.paths.includes(file);
}

function ruleAllows(rule, hit) {
  return (
    rule.tokens.includes(hit.token)
    && pathAllowed(rule, hit.file)
    && (rule.line === undefined || rule.line.test(hit.line))
  );
}

function formatHit(hit) {
  return `${hit.file}:${hit.lineNumber}: ${hit.token}: ${hit.line}`;
}

const hits = collectHits(scanFiles());
const classified = [];
const unclassified = [];

for (const hit of hits) {
  const rule = ALLOW_LIST.find(candidate => ruleAllows(candidate, hit));
  if (rule) classified.push({ hit, rule });
  else unclassified.push(hit);
}

if (unclassified.length > 0) {
  console.error('Unclassified nondeterministic API hits:');
  for (const hit of unclassified) {
    console.error(`  ${formatHit(hit)}`);
  }
  console.error('\nAdd a narrow allow-list entry only after confirming the hit cannot affect lockstep determinism.');
  process.exit(1);
}

console.log('Nondeterminism audit allow-list:');
for (const rule of ALLOW_LIST) {
  const ruleHits = classified.filter(entry => entry.rule === rule);
  if (ruleHits.length === 0) continue;
  console.log(`\n[${rule.id}] ${rule.reason}`);
  for (const { hit } of ruleHits) {
    console.log(`  ${formatHit(hit)}`);
  }
}
console.log(`\nChecked ${hits.length} nondeterminism-sensitive API hits; all are classified.`);
