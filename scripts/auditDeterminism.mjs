import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const GAMEPLAY_FORBIDDEN_SCOPES = [
  {
    root: 'src/game/sim',
    patterns: ['Math.random(', 'Date.now(', 'performance.now('],
  },
  {
    root: 'src/game/architecture',
    patterns: ['Math.random(', 'Date.now(', 'performance.now('],
  },
  {
    root: 'src/game/server/BackgroundBattleStandalone.ts',
    patterns: ['Math.random(', 'Date.now(', 'performance.now('],
  },
];

const SERVER_WALL_CLOCK_ALLOWLIST = new Map([
  ['src/game/server/GameServer.ts', 'local server scheduling, tick CPU telemetry, and replay receive-time diagnostics; lockstep must not use this as truth'],
  ['src/game/server/LocalGameConnection.ts', 'snapshot encode timing telemetry only'],
  ['src/game/server/ServerSnapshotDirectWirePreencoder.ts', 'snapshot encode timing telemetry only'],
  ['src/game/server/ServerSnapshotPublisher.ts', 'debug-grid throttle timing only'],
  ['src/game/server/ServerSnapshotWirePayload.ts', 'snapshot wire encode timing telemetry only'],
  ['src/game/server/ServerSnapshotMetaBuilder.ts', 'snapshot metadata server-time label only; not lockstep gameplay truth'],
  ['src/game/server/ServerTickLoop.ts', 'wall-clock scheduler for non-lockstep server loops; lockstep uses a frame scheduler instead'],
]);

const HIGH_RISK_MATH_PATTERN = /\bMath\.(sin|cos|atan2|hypot|sqrt|pow)\s*\(/g;

const HIGH_RISK_MATH_ALLOWLIST = new Map([
  ['src/game/server/PhysicsEngine3D.ts', {
    count: 1,
    reason: 'module-load spring damping constant derived from canonical config before gameplay ticks',
  }],
  ['src/game/server/UnitForceSystem.ts', {
    count: 1,
    reason: 'module-load hover orientation damping constant derived from canonical config before gameplay ticks',
  }],
  ['src/game/sim/locomotion.ts', {
    count: 1,
    reason: 'blueprint load-time slope conversion; resulting numeric value is canonicalized in content hash/replay',
  }],
  ['src/game/sim/pathfindingTuning.ts', {
    count: 1,
    reason: 'module-load pathfinding stability threshold derived from canonical config before terrain/pathfinding startup',
  }],
  ['src/game/sim/terrain/terrainConfig.ts', {
    count: 1,
    reason: 'module-load terrain collapse threshold derived from canonical config before terrain bake',
  }],
  ['src/game/sim/types.ts', {
    count: 3,
    reason: 'presentation-only player color conversion; not included in lockstep state hashes',
  }],
]);

const CODE_EXTENSIONS = new Set(['.ts', '.vue']);

const failures = [];
const highRiskMathCounts = new Map();

for (const scope of GAMEPLAY_FORBIDDEN_SCOPES) {
  for (const file of filesForScope(scope.root)) {
    const source = stripComments(readFileSync(path.join(repoRoot, file), 'utf8'));
    for (const pattern of scope.patterns) {
      addPatternFailures(file, source, pattern, 'gameplay truth cannot use ambient randomness or wall clock');
    }
  }
}

for (const file of listFiles('src/game/server')) {
  const source = stripComments(readFileSync(path.join(repoRoot, file), 'utf8'));
  const usesWallClock = source.includes('Date.now(') || source.includes('performance.now(');
  if (usesWallClock && !SERVER_WALL_CLOCK_ALLOWLIST.has(file)) {
    failures.push(`${file}: wall-clock use needs an audit reason`);
  }
  addPatternFailures(file, source, 'Math.random(', 'server gameplay must use WorldState.rng');
}

for (const file of [
  ...listFiles('src/game/sim'),
  ...listFiles('src/game/server'),
  ...listFiles('src/game/architecture'),
]) {
  const source = stripComments(readFileSync(path.join(repoRoot, file), 'utf8'));
  addHighRiskMathFailures(file, source);
}

for (const [file, { count }] of HIGH_RISK_MATH_ALLOWLIST) {
  const actual = highRiskMathCounts.get(file) ?? 0;
  if (actual !== count) {
    failures.push(
      `${file}: expected ${count} allowlisted high-risk Math calls, found ${actual}`,
    );
  }
}

if (failures.length > 0) {
  console.error('Determinism audit failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Determinism audit passed.');
console.log('Documented server wall-clock allowlist:');
for (const [file, reason] of [...SERVER_WALL_CLOCK_ALLOWLIST.entries()].sort()) {
  console.log(`- ${file}: ${reason}`);
}
console.log('Documented high-risk Math allowlist:');
for (const [file, { count, reason }] of [...HIGH_RISK_MATH_ALLOWLIST.entries()].sort()) {
  console.log(`- ${file}: ${count} call(s), ${reason}`);
}

function filesForScope(scopeRoot) {
  const absolute = path.join(repoRoot, scopeRoot);
  if (statSync(absolute).isFile()) return [scopeRoot];
  return listFiles(scopeRoot);
}

function listFiles(relativeDir) {
  const absoluteDir = path.join(repoRoot, relativeDir);
  const result = [];
  for (const name of readdirSync(absoluteDir)) {
    const absolute = path.join(absoluteDir, name);
    const relative = path.relative(repoRoot, absolute);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      result.push(...listFiles(relative));
    } else if (CODE_EXTENSIONS.has(path.extname(name))) {
      result.push(relative);
    }
  }
  return result;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function addPatternFailures(file, source, pattern, reason) {
  let index = source.indexOf(pattern);
  while (index !== -1) {
    const line = source.slice(0, index).split('\n').length;
    failures.push(`${file}:${line}: ${pattern} - ${reason}`);
    index = source.indexOf(pattern, index + pattern.length);
  }
}

function addHighRiskMathFailures(file, source) {
  HIGH_RISK_MATH_PATTERN.lastIndex = 0;
  let match = HIGH_RISK_MATH_PATTERN.exec(source);
  while (match !== null) {
    const count = highRiskMathCounts.get(file) ?? 0;
    highRiskMathCounts.set(file, count + 1);
    const allowed = HIGH_RISK_MATH_ALLOWLIST.get(file);
    if (allowed === undefined) {
      const line = source.slice(0, match.index).split('\n').length;
      failures.push(
        `${file}:${line}: ${match[0]} - gameplay truth must use deterministicMath/WASM or add an explicit audit exception`,
      );
    }
    match = HIGH_RISK_MATH_PATTERN.exec(source);
  }
}
