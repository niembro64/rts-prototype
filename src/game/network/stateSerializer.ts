import type { WorldState } from '../sim/WorldState';
import type { Entity, PlayerId } from '../sim/types';
import { economyManager } from '../sim/economy';
import type { NetworkGameState, NetworkEntity, NetworkEconomy, NetworkSprayTarget, NetworkAudioEvent } from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { AudioEvent } from '../sim/combat';

// Reusable arrays to avoid per-snapshot allocations
const _entityBuf: NetworkEntity[] = [];
const _sprayBuf: NetworkSprayTarget[] = [];
const _audioBuf: NetworkAudioEvent[] = [];

// Serialize WorldState to network format
export function serializeGameState(
  world: WorldState,
  gameOverWinnerId?: PlayerId,
  sprayTargets?: SprayTarget[],
  audioEvents?: AudioEvent[]
): NetworkGameState {
  _entityBuf.length = 0;

  // Serialize all entities
  for (const entity of world.getAllEntities()) {
    const netEntity = serializeEntity(entity);
    if (netEntity) {
      _entityBuf.push(netEntity);
    }
  }

  // Serialize economy for all players
  const economy: Record<PlayerId, NetworkEconomy> = {};
  for (let playerId = 1; playerId <= 6; playerId++) {
    const eco = economyManager.getEconomy(playerId as PlayerId);
    if (eco) {
      economy[playerId as PlayerId] = {
        stockpile: eco.stockpile,
        maxStockpile: eco.maxStockpile,
        baseIncome: eco.baseIncome,
        production: eco.production,
        expenditure: eco.expenditure,
      };
    }
  }

  // Serialize spray targets (reuse buffer)
  let netSprayTargets: NetworkSprayTarget[] | undefined;
  if (sprayTargets && sprayTargets.length > 0) {
    _sprayBuf.length = 0;
    for (let i = 0; i < sprayTargets.length; i++) {
      const st = sprayTargets[i];
      _sprayBuf.push({
        sourceId: st.sourceId,
        targetId: st.targetId,
        type: st.type,
        sourceX: st.sourceX,
        sourceY: st.sourceY,
        targetX: st.targetX,
        targetY: st.targetY,
        targetWidth: st.targetWidth,
        targetHeight: st.targetHeight,
        targetRadius: st.targetRadius,
        intensity: st.intensity,
      });
    }
    netSprayTargets = _sprayBuf;
  }

  // Serialize audio events (reuse buffer)
  let netAudioEvents: NetworkAudioEvent[] | undefined;
  if (audioEvents && audioEvents.length > 0) {
    _audioBuf.length = 0;
    for (let i = 0; i < audioEvents.length; i++) {
      const ae = audioEvents[i];
      _audioBuf.push({
        type: ae.type,
        weaponId: ae.weaponId,
        x: ae.x,
        y: ae.y,
        entityId: ae.entityId,
        deathContext: ae.deathContext,
      });
    }
    netAudioEvents = _audioBuf;
  }

  return {
    tick: world.getTick(),
    entities: _entityBuf,
    economy,
    sprayTargets: netSprayTargets,
    audioEvents: netAudioEvents,
    gameOver: gameOverWinnerId ? { winnerId: gameOverWinnerId } : undefined,
  };
}

// Serialize a single entity
function serializeEntity(entity: Entity): NetworkEntity | null {
  const netEntity: NetworkEntity = {
    id: entity.id,
    type: entity.type,
    x: entity.transform.x,
    y: entity.transform.y,
    rotation: entity.transform.rotation,
    playerId: entity.ownership?.playerId,
  };

  if (entity.type === 'unit' && entity.unit) {
    netEntity.unitType = entity.unit.unitType;
    netEntity.hp = entity.unit.hp;
    netEntity.maxHp = entity.unit.maxHp;
    netEntity.collisionRadius = entity.unit.collisionRadius;
    netEntity.moveSpeed = entity.unit.moveSpeed;
    netEntity.mass = entity.unit.mass;
    netEntity.velocityX = entity.unit.velocityX ?? 0;
    netEntity.velocityY = entity.unit.velocityY ?? 0;
    // Turret rotation for network display - loop through all weapons
    let turretRot = entity.transform.rotation;
    const weapons = entity.weapons ?? [];
    for (const weapon of weapons) {
      turretRot = weapon.turretRotation;
    }
    netEntity.turretRotation = turretRot;
    netEntity.isCommander = entity.commander !== undefined;

    // Serialize action queue (manual loop avoids .map() closure allocation)
    if (entity.unit.actions && entity.unit.actions.length > 0) {
      const actions = entity.unit.actions;
      const netActions = new Array(actions.length);
      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        netActions[i] = {
          type: action.type,
          x: action.x,
          y: action.y,
          targetId: action.targetId,
          buildingType: action.buildingType,
          gridX: action.gridX,
          gridY: action.gridY,
          buildingId: action.buildingId,
        };
      }
      netEntity.actions = netActions;
    }

    // Serialize all weapons (manual loop avoids .map() closure allocation)
    if (entity.weapons && entity.weapons.length > 0) {
      const weapons = entity.weapons;
      const netWeapons = new Array(weapons.length);
      for (let i = 0; i < weapons.length; i++) {
        const w = weapons[i];
        netWeapons[i] = {
          configId: w.config.id,
          targetId: w.targetEntityId ?? undefined,
          targetingMode: w.targetingMode,
          seeRange: w.seeRange,
          fireRange: w.fireRange,
          fightstopRange: w.fightstopRange,
          turretRotation: w.turretRotation,
          turretAngularVelocity: w.turretAngularVelocity,
          turretTurnAccel: w.turretTurnAccel,
          turretDrag: w.turretDrag,
          offsetX: w.offsetX,
          offsetY: w.offsetY,
          isFiring: w.isFiring,
          inFightstopRange: w.inFightstopRange,
          currentSliceAngle: w.currentSliceAngle,
        };
      }
      netEntity.weapons = netWeapons;
    }

    // Serialize builder state (commander)
    if (entity.builder) {
      netEntity.buildTargetId = entity.builder.currentBuildTarget ?? undefined;
    }
  }

  if (entity.type === 'building' && entity.building) {
    netEntity.width = entity.building.width;
    netEntity.height = entity.building.height;
    netEntity.hp = entity.building.hp;
    netEntity.maxHp = entity.building.maxHp;
    netEntity.buildingType = entity.buildingType;

    if (entity.buildable) {
      netEntity.buildProgress = entity.buildable.buildProgress;
      netEntity.isComplete = entity.buildable.isComplete;
    }

    if (entity.factory) {
      netEntity.buildQueue = entity.factory.buildQueue.slice();
      netEntity.factoryProgress = entity.factory.currentBuildProgress;
      netEntity.isProducing = entity.factory.isProducing;
      netEntity.rallyX = entity.factory.rallyX;
      netEntity.rallyY = entity.factory.rallyY;
      const wps = entity.factory.waypoints;
      const netWps = new Array(wps.length);
      for (let i = 0; i < wps.length; i++) {
        netWps[i] = { x: wps[i].x, y: wps[i].y, type: wps[i].type };
      }
      netEntity.factoryWaypoints = netWps;
    }
  }

  if (entity.type === 'projectile' && entity.projectile) {
    netEntity.velocityX = entity.projectile.velocityX;
    netEntity.velocityY = entity.projectile.velocityY;
    netEntity.projectileType = entity.projectile.projectileType;
    netEntity.weaponId = entity.projectile.config.id;
    // Beam coordinates and source info for client-side reconstruction
    if (entity.projectile.projectileType === 'beam') {
      netEntity.beamStartX = entity.projectile.startX;
      netEntity.beamStartY = entity.projectile.startY;
      netEntity.beamEndX = entity.projectile.endX;
      netEntity.beamEndY = entity.projectile.endY;
      netEntity.sourceEntityId = entity.projectile.sourceEntityId;
      netEntity.weaponIndex = (entity.projectile.config as { weaponIndex?: number }).weaponIndex ?? 0;
    }
  }

  return netEntity;
}

