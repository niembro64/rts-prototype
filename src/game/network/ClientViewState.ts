/**
 * ClientViewState - render-facing client state built on snapshot materialization.
 */

import {
  ClientViewStateBase,
  type ClientResourcePylonFlow,
} from './ClientViewStateBase';
export type { ClientResourcePylonFlow } from './ClientViewStateBase';

const EMPTY_RESOURCE_PYLON_FLOWS: readonly ClientResourcePylonFlow[] = [];
const EMPTY_AUDIO: NetworkServerSnapshot['audioEvents'] = [];
import type {
  Entity,
  PlayerId,
  EntityId,
} from '../sim/types';
import {
  getResourceFillRatio,
  isBuildInProgress,
} from '../sim/buildableHelpers';
import type {
  NetworkServerSnapshot,
  NetworkServerSnapshotMeta,
} from './NetworkManager';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { MinimapEntity } from '@/types/ui';
import type { ContactSnapshotSampling } from './ClientMinimapOverrideStore';
import type { TerrainBuildabilityGrid } from '@/types/terrain';
import type { FootprintBounds, ViewportFootprint } from '../ViewportFootprint';
import { viewExcludesSphere } from '../render3d/EntityDetailLevel3D';
import type { RenderViewState3D } from '../render3d/RenderFrameState3D';
import {
  RESOURCE_KIND_ENERGY,
  type GamePhase,
  type ResourceKindCode,
} from '../../types/network';
import {
  resetClientPredictionTargetPools,
} from './ClientPredictionTargets';
import type {
  ClientPredictionTargetAgeStats,
} from './ClientPredictionDiagnostics';
import {
  type ClientProjectileRenderLists,
} from './ClientProjectileStore';
import type { EntityHudElement, EntityHudType, SelectionHudMode } from '@/clientBarConfig';
import { getDefaultPlayerName } from '@/playerNamesConfig';
import { NAME_LABEL_OWNER_Y_OFFSET } from '@/nameLabelConfig';
import {
  getBuildingHudBarsY,
  getBuildingHudNameY,
  getUnitHudBarsY,
  getUnitHudNameY,
} from '../render3d/HudAnchor';
import {
  resolveCommanderOwnerName,
  resolveEntityDisplayName,
} from '../render3d/EntityName';
import {
  PIECE_TAG_BODY,
  type BodyHudRenderPacket3D,
} from '../render3d/HealthBar3D';
import {
  PIECE_TAG_COMMANDER_OWNER_NAME,
  type PieceNameRenderPacket3D,
} from '../render3d/NameLabel3D';
import type { ShieldRenderPacket3D } from '../render3d/ShieldRenderer3D';
import type { EntityShadowRenderPacket3D } from '../render3d/EntityShadowRenderPacket3D';
import type { GroundPrintRenderPacket3D } from '../render3d/GroundPrint3D';
import type { Locomotion3DMesh } from '../render3d/Locomotion3D';
import { getLocomotionSurfaceHeight } from '../render3d/LocomotionTerrainSampler';
import type {
  BuildingRenderPacket3D,
  UnitRenderPacket3D,
} from '../render3d/EntityRenderPackets3D';
import {
  CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION,
  CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS,
  CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY,
  CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY,
  CLIENT_RENDER_ENTITY_FLAG_SELECTED,
  CLIENT_RENDER_ENTITY_KIND_BUILDING,
  CLIENT_RENDER_ENTITY_KIND_UNIT,
} from '../render3d/ClientRenderEntityStateSlab';
import {
  type ClientRenderTurretHostRows,
} from '../render3d/ClientRenderTurretStateSlab';
import { isUnitGroundPenetrationInContact } from '../sim/unitGroundPhysics';

type ClientViewRenderEntityPackets3D = {
  unitRows: UnitRenderPacket3D;
  buildingRows: BuildingRenderPacket3D;
  bodyHud: BodyHudRenderPacket3D;
  shields: ShieldRenderPacket3D;
  pieceNames: PieceNameRenderPacket3D;
  entityShadows: EntityShadowRenderPacket3D;
  groundPrints: GroundPrintRenderPacket3D;
};

type ClientViewRenderPacketOptions3D = {
  renderScope: ViewportFootprint;
  /** Camera view for the conservative cone cull. The ground-footprint
   *  scope reaches the horizon at shallow pitch, so most in-scope
   *  entities can still be far outside the view cone; rows for those
   *  are skipped entirely (same lifecycle as a scope exit). null — and
   *  RENDER: ALL — disable the cull. */
  renderView: RenderViewState3D | null;
  includeBodyHud: boolean;
  includeBodyNames: boolean;
  includeShields: boolean;
  /** Bitmask of the players whose shields this client may SEE, using the
   *  `playerId - 1` bit convention. Zero means "no restriction".
   *
   *  A side that owns no switched-ON Shield Detection Lab does not know a
   *  foreign force field is there, and a player who cannot know must not be
   *  shown it — the same rule fog of war applies to units. Own-team shields are
   *  always drawn: you know about the ones you are projecting. */
  shieldVisibilityTeamMask: number;
  includeEntityShadows: boolean;
  includeGroundPrints: boolean;
  hoveredEntity: Entity | null;
  scopedUnitsOut: Entity[];
  scopedBuildingsOut: Entity[];
  selectionHudMode: SelectionHudMode;
  getEntityHudToggle: (type: EntityHudType, toggle: EntityHudElement) => boolean;
  lookupPlayerName: (id: PlayerId) => string | null;
  getGroundPrintLocomotionMesh: (entityId: EntityId) => Locomotion3DMesh;
  isEntityFarLod?: (entity: Entity) => boolean;
  isEntityEmissionFarLod?: (entity: Entity) => boolean;
  /** lod.json featureMinRung gates for HUD sprites: healthBar / nameLabel
   *  visibility at the entity's latched detail rung. Undefined = no gate
   *  (contract-test fixtures, fallback paths). Hover bypasses the bar
   *  gate at the call site. */
  isEntityHudRungVisible?: (entity: Entity) => boolean;
  isEntityNameRungVisible?: (entity: Entity) => boolean;
};

/** Conservative bounding sphere for the render-packet cone cull. The
 *  margins are deliberately generous — barrels, rigs, and HUD sprites
 *  extend past the authored radius, and a sphere that is too small pops
 *  entities at the screen edge. viewExcludesSphere itself adds a 1.15x
 *  cone margin on top. */
function renderConeCullExcludes(
  view: RenderViewState3D,
  entity: Entity,
): boolean {
  const unit = entity.unit;
  if (unit !== null) {
    return viewExcludesSphere(
      view,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      unit.radius.other * 3 + 60,
    );
  }
  const building = entity.building;
  if (building !== null) {
    return viewExcludesSphere(
      view,
      entity.transform.x,
      entity.transform.y,
      entity.transform.z,
      Math.max(building.width, building.height) + 160,
    );
  }
  return false;
}

export class ClientViewState extends ClientViewStateBase {
  /** Called every render frame. Adjacent authoritative Rust poses own root
   * motion when presentation history is available; snapshots are otherwise
   * materialized directly, without TypeScript root extrapolation. */
  applyPrediction(deltaMs: number): ClientPredictionTargetAgeStats {
    if (this.lockstepPresentationEnabled) {
      // Root motion and turret aim no longer consume snapshot target sets.
      // Supplemental presentation owns beam topology and delayed spawn intake.
      this.activeEntityPredictionIds.clear();
      this.projectileStore.activeProjectileMotionIds.clear();
      const stats = this.supplementalPresentation.apply(deltaMs);
      const updated = this.lockstepPresentation.apply(this.entities.values());
      for (let i = 0; i < updated.length; i++) {
        const entity = updated[i];
        if (entity.unit !== null || entity.building !== null) {
          this.refreshRenderableEntityStateAndSpatialIndex(entity);
        }
        if (entity.projectile !== null) {
          this.projectileStore.updateRenderSpatialIndex(entity);
        }
      }
      this.activeEntityPredictionIds.clear();
      this.projectileStore.activeProjectileMotionIds.clear();
      return stats;
    }
    const stats = this.supplementalPresentation.apply(deltaMs);
    // Hot-motion typed rows write only a server TARGET and deliberately skip
    // the snapshot dirty mark, because the prediction pass is what is supposed
    // to materialize them. Only the lockstep branch above ever did that, so on
    // the authoritative-snapshot path a moving unit sat at its last full-row
    // pose while the render row and spatial slot went stale.
    //
    // This is materialization, not extrapolation: the newest authoritative
    // target becomes the pose, exactly as the retired DTO path wrote it inline.
    // Nothing here invents motion past what the snapshot said.
    for (const id of this.activeEntityPredictionIds) {
      const entity = this.entities.get(id);
      if (entity === undefined) continue;
      if (entity.unit !== null) this.dirtyUnitRenderIds.add(id);
      else if (entity.building !== null) this.dirtyBuildingRenderIds.add(id);
      else continue;
      const target = this.serverTargets.get(id);
      if (target !== undefined) {
        entity.transform.x = target.x;
        entity.transform.y = target.y;
        entity.transform.z = target.z;
        entity.transform.rotation = target.rotation;
        const unit = entity.unit;
        if (unit !== null) {
          unit.velocityX = target.velocityX;
          unit.velocityY = target.velocityY;
          unit.velocityZ = target.velocityZ;
        }
      }
      this.refreshRenderableEntityStateAndSpatialIndex(entity);
    }
    return stats;
  }

  // === Accessors for rendering and input ===

  getEntity(id: EntityId): Entity | undefined {
    return this.entities.get(id);
  }

  getEntitySetVersion(): number {
    return this.entitySetVersion;
  }

  getTerrainBuildabilityGrid(): TerrainBuildabilityGrid | null {
    return this.terrainBuildabilityGrid;
  }

  getResourcePylonSignedRate(entityId: EntityId, resource: ResourceKindCode): number {
    const rates = this.resourcePylonSignedRates.get(entityId);
    if (rates === undefined) return 0;
    return resource === RESOURCE_KIND_ENERGY ? rates.energy : rates.metal;
  }

  getResourcePylonFlows(entityId: EntityId): readonly ClientResourcePylonFlow[] {
    return this.resourcePylonFlowsBySource.get(entityId) ?? EMPTY_RESOURCE_PYLON_FLOWS;
  }

  getResourcePylonSourceIds(): readonly EntityId[] {
    return this.resourcePylonSourceIds;
  }

  getAllEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getAll();
  }

  getMinimapEntitiesOverride(): readonly MinimapEntity[] | null {
    return this.minimapOverrideStore.getOverride();
  }

  /** Render-clock progress through the current contact snapshot. Only the
   *  world blip renderer needs it: the minimap redraws off its own interval. */
  getMinimapContactSampling(nowMs: number): ContactSnapshotSampling {
    return this.minimapOverrideStore.getSampling(nowMs);
  }

  getUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnits();
  }

  getUnitsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnitsByPlayer(playerId);
  }

  collectActiveUnitRenderEntities(out: Entity[]): Entity[] {
    out.length = 0;
    for (const id of this.activeEntityPredictionIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.unit !== null) out.push(entity);
    }
    for (const id of this.dirtyUnitRenderIds) {
      if (this.activeEntityPredictionIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.unit !== null) out.push(entity);
    }
    this.dirtyUnitRenderIds.clear();
    return out;
  }

  getRenderSpatialEntityPadding(): number {
    return this.renderSpatialIndex.getMaxEntityPadding();
  }

  getProjectileRenderScopePadding(): number {
    return this.projectileStore.getRenderScopePadding();
  }

  getRenderEntityStateSlot(id: EntityId): number | undefined {
    return this.renderEntityState.getSlot(id);
  }

  getRenderTurretStateRows(id: EntityId): ClientRenderTurretHostRows | undefined {
    const slot = this.renderEntityState.getSlot(id);
    return slot !== undefined ? this.renderTurretState.hostRows(slot) : undefined;
  }

  assertRenderEntityStateParity(id: EntityId): void {
    const entity = this.entities.get(id);
    if (entity === undefined) {
      throw new Error(`[client render entity state] missing entity ${id}`);
    }
    this.renderEntityState.assertParity(entity);
    const slot = this.renderEntityState.getSlot(id);
    if (slot !== undefined) this.renderTurretState.assertParity(entity, slot);
  }

  collectScopedRenderEntities(
    bounds: FootprintBounds,
    outUnits: Entity[],
    outBuildings: Entity[],
    hoveredEntity: Entity | null,
    renderScope: ViewportFootprint,
  ): void {
    const selectedIds = this.selectionState.get();
    const hasExceptions = hoveredEntity !== null || selectedIds.size > 0;
    const included = hasExceptions ? this.scopedRenderIncludedIds : null;
    if (included !== null) included.clear();
    const unitSlots = this.scopedRenderUnitSlots;
    const buildingSlots = this.scopedRenderBuildingSlots;
    const unitRowSlots = this.scopedRenderUnitRowSlots;
    const buildingRowSlots = this.scopedRenderBuildingRowSlots;
    this.renderSpatialIndex.queryFilteredSlots(
      bounds,
      unitSlots,
      buildingSlots,
      (slot) => this.slotInRenderScope3D(slot, renderScope),
    );
    outUnits.length = 0;
    outBuildings.length = 0;
    unitRowSlots.length = 0;
    buildingRowSlots.length = 0;
    this.resolveScopedRenderSlots(
      unitSlots,
      outUnits,
      unitRowSlots,
      included,
      CLIENT_RENDER_ENTITY_KIND_UNIT,
    );
    this.resolveScopedRenderSlots(
      buildingSlots,
      outBuildings,
      buildingRowSlots,
      included,
      CLIENT_RENDER_ENTITY_KIND_BUILDING,
    );

    if (included === null) return;
    if (hoveredEntity !== null) {
      this.pushScopedRenderException(
        hoveredEntity,
        outUnits,
        outBuildings,
        unitRowSlots,
        buildingRowSlots,
        included,
      );
    }
    for (const id of selectedIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined) {
        this.pushScopedRenderException(
          entity,
          outUnits,
          outBuildings,
          unitRowSlots,
          buildingRowSlots,
          included,
        );
      }
    }
  }

  prepareRenderEntityPackets3D(
    out: ClientViewRenderEntityPackets3D,
    options: ClientViewRenderPacketOptions3D,
  ): ClientViewRenderEntityPackets3D {
    out.unitRows.reset();
    out.buildingRows.reset();
    out.bodyHud.reset();
    out.shields.reset();
    out.pieceNames.reset();
    out.entityShadows.reset();
    out.groundPrints.reset();
    this.populateRenderRemovalRows3D(out);

    this.renderEntityState.clearPacketFlags();
    try {
      this.markRenderEntityPacketFlags();

      const renderScope = options.renderScope;
      if (renderScope.getMode() === 'all') {
        const units = this.getUnits();
        const buildings = this.getBuildings();
        this.populateUnitRenderRows3D(units, options, out);
        if (options.isEntityFarLod !== undefined) {
          this.populateBuildingRenderRows3D(buildings, options, out);
        } else {
          this.populateQueuedBuildingRenderRows3D(options, out);
        }
        if (options.includeBodyHud) {
          this.populateBodyHudPacket3D(this.getHudEntities(), options.hoveredEntity, options, out);
        }
        if (options.includeBodyNames) {
          this.populateBodyNamePacket3D(this.getUnitsAndBuildings(), options, out);
        }
        if (options.includeShields) {
          this.populateShieldPacket3D(
            this.getShieldUnits(),
            renderScope,
            out,
            options.shieldVisibilityTeamMask,
          );
        }
        if (options.includeEntityShadows) {
          this.populateEntityShadowPacket3D(units, buildings, renderScope, out);
        }
        if (options.includeGroundPrints) {
          this.populateGroundPrintPacket3D(units, options, out);
        }
        return out;
      }

      const units = options.scopedUnitsOut;
      const buildings = options.scopedBuildingsOut;
      this.collectScopedRenderEntities(
        renderScope.getCullingBounds(this.getRenderSpatialEntityPadding()),
        units,
        buildings,
        options.hoveredEntity,
        renderScope,
      );

      const unitRowSlots = this.scopedRenderUnitRowSlots;
      const buildingRowSlots = this.scopedRenderBuildingRowSlots;
      const renderView = options.renderView;
      let hoveredBodyHudPushed = false;
      for (let i = 0; i < units.length; i++) {
        const entity = units[i];
        if (renderView !== null && renderConeCullExcludes(renderView, entity)) {
          continue;
        }
        const farLod = this.entityUsesFarLod3D(entity, options);
        this.pushUnitRenderKnownSlot3D(entity, unitRowSlots[i] ?? -1, farLod, out);
        if (
          !this.entityEmissionUsesFarLod3D(entity, options) &&
          options.includeBodyHud &&
          this.entityNeedsBodyHud3D(entity)
        ) {
          const forceVisible = entity === options.hoveredEntity;
          if (forceVisible) hoveredBodyHudPushed = true;
          this.pushBodyHudEntity3D(entity, forceVisible, options, out, unitRowSlots[i] ?? -1);
        }
        if (
          !this.entityEmissionUsesFarLod3D(entity, options) &&
          options.includeBodyNames
        ) {
          this.pushBodyNamesForEntity3D(entity, options, out, unitRowSlots[i] ?? -1);
        }
      }
      for (let i = 0; i < buildings.length; i++) {
        const entity = buildings[i];
        if (renderView !== null && renderConeCullExcludes(renderView, entity)) {
          continue;
        }
        const farLod = this.entityUsesFarLod3D(entity, options);
        this.pushBuildingRenderKnownSlot3D(entity, buildingRowSlots[i] ?? -1, farLod, out);
        if (
          !this.entityEmissionUsesFarLod3D(entity, options) &&
          options.includeBodyHud &&
          this.entityNeedsBodyHud3D(entity)
        ) {
          const forceVisible = entity === options.hoveredEntity;
          if (forceVisible) hoveredBodyHudPushed = true;
          this.pushBodyHudEntity3D(entity, forceVisible, options, out, buildingRowSlots[i] ?? -1);
        }
        if (
          !this.entityEmissionUsesFarLod3D(entity, options) &&
          options.includeBodyNames
        ) {
          this.pushBodyNamesForEntity3D(entity, options, out, buildingRowSlots[i] ?? -1);
        }
      }

      if (
        options.includeBodyHud &&
        options.hoveredEntity !== null &&
        !hoveredBodyHudPushed &&
        !this.entityEmissionUsesFarLod3D(options.hoveredEntity, options)
      ) {
        this.pushBodyHudEntity3D(options.hoveredEntity, true, options, out);
      }
      if (options.includeShields) {
        // Active shield fields are gameplay-readable geometry, not optional
        // emissions. Gather them independently from the body LOD list so a
        // field survives every distance rung and remains present when its
        // host is just outside the viewport but the barrier overlaps it.
        this.populateShieldPacket3D(
          this.getShieldUnits(),
          renderScope,
          out,
          options.shieldVisibilityTeamMask,
        );
      }
      if (options.includeEntityShadows) {
        this.populateEntityShadowPacket3D(
          units,
          buildings,
          renderScope,
          out,
          unitRowSlots,
          buildingRowSlots,
        );
      }
      if (options.includeGroundPrints) {
        this.populateGroundPrintPacket3D(units, options, out, unitRowSlots);
      }
      return out;
    } finally {
      this.renderEntityState.clearPacketFlags();
    }
  }

  consumeRenderDirties(): void {
    this.dirtyUnitRenderIds.clear();
    this.dirtyBuildingRenderIds.clear();
    this.removedUnitRenderIds.length = 0;
    this.removedBuildingRenderIds.length = 0;
    this.renderLifecycleDirtyIds.clear();
    this.renderEntityState.clearDirtySlots();
    this.renderTurretState.clearDirtyHostSlots();
  }

  private markRenderEntityPacketFlags(): void {
    for (const id of this.activeEntityPredictionIds) {
      this.markRenderEntityPacketFlagById(id, CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION);
    }
    for (const id of this.dirtyUnitRenderIds) {
      this.markRenderEntityPacketFlagById(id, CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY);
    }
    for (const id of this.dirtyBuildingRenderIds) {
      this.markRenderEntityPacketFlagById(id, CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY);
    }
    for (const id of this.renderLifecycleDirtyIds) {
      this.markRenderEntityPacketFlagById(id, CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY);
    }
  }

  private markRenderEntityPacketFlagById(id: EntityId, flag: number): void {
    const slot = this.renderEntityState.getSlot(id);
    if (slot !== undefined) this.renderEntityState.markPacketFlags(slot, flag);
  }

  private markRenderEntityPacketFlagsForFreshSlot(
    id: EntityId,
    slot: number,
    unitRow: boolean,
  ): void {
    let flags = 0;
    if (this.activeEntityPredictionIds.has(id)) {
      flags |= CLIENT_RENDER_ENTITY_FLAG_ACTIVE_PREDICTION;
    }
    if (
      unitRow
        ? this.dirtyUnitRenderIds.has(id)
        : this.dirtyBuildingRenderIds.has(id)
    ) {
      flags |= CLIENT_RENDER_ENTITY_FLAG_RENDER_DIRTY;
    }
    if (this.renderLifecycleDirtyIds.has(id)) {
      flags |= CLIENT_RENDER_ENTITY_FLAG_LIFECYCLE_DIRTY;
    }
    if (flags !== 0) this.renderEntityState.markPacketFlags(slot, flags);
  }

  private pushScopedRenderException(
    entity: Entity,
    outUnits: Entity[],
    outBuildings: Entity[],
    outUnitSlots: number[],
    outBuildingSlots: number[],
    included: Set<EntityId>,
  ): void {
    if (included.has(entity.id)) return;
    if (entity.unit !== null) {
      outUnits.push(entity);
      outUnitSlots.push(this.renderEntityState.getSlot(entity.id) ?? -1);
      included.add(entity.id);
    } else if (entity.building !== null) {
      outBuildings.push(entity);
      outBuildingSlots.push(this.renderEntityState.getSlot(entity.id) ?? -1);
      included.add(entity.id);
    }
  }

  private resolveScopedRenderSlots(
    slots: readonly number[],
    out: Entity[],
    outSlots: number[],
    included: Set<EntityId> | null,
    expectedKind: number,
  ): void {
    const views = this.renderEntityState.getViews();
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (views.kind[slot] !== expectedKind) continue;
      const entityId = views.entityIds[slot] as EntityId;
      if (included !== null && included.has(entityId)) continue;
      const entity = this.entities.get(entityId);
      if (entity === undefined) continue;
      if (
        (expectedKind === CLIENT_RENDER_ENTITY_KIND_UNIT && entity.unit === null) ||
        (expectedKind === CLIENT_RENDER_ENTITY_KIND_BUILDING && entity.building === null)
      ) {
        continue;
      }
      out.push(entity);
      outSlots.push(slot);
      if (included !== null) included.add(entityId);
    }
  }

  private barVisible3D(
    perType: boolean,
    selected: boolean,
    mode: SelectionHudMode,
    notFull: boolean,
  ): boolean {
    if (!perType) return false;
    if (selected) {
      if (mode === 'always') return true;
      if (mode === 'never') return false;
      return notFull;
    }
    return notFull;
  }

  private hudTypeOf3D(entity: Entity): EntityHudType {
    if (entity.type === 'unit') return 'unit';
    return 'building';
  }

  private slotInRenderScope3D(slot: number, renderScope: ViewportFootprint): boolean {
    const views = this.renderEntityState.getViews();
    if (
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT ||
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING
    ) {
      return renderScope.inScope(
        views.x[slot],
        views.y[slot],
        views.renderScopePadding[slot],
      );
    }
    return false;
  }

  private entityNeedsBodyHud3D(entity: Entity): boolean {
    const buildInProgress = isBuildInProgress(entity.buildable);
    if (buildInProgress) return true;
    const unit = entity.unit;
    if (unit !== null) return unit.hp > 0 && unit.hp < unit.maxHp;
    const building = entity.building;
    return building !== null && building.hp > 0 && building.hp < building.maxHp;
  }

  private populateUnitRenderRows3D(
    units: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      this.pushUnitRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
    }
  }

  private populateBuildingRenderRows3D(
    buildings: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
    }
  }

  private populateQueuedBuildingRenderRows3D(
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (const id of this.activeEntityPredictionIds) {
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) {
        this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
      }
    }
    for (const id of this.dirtyBuildingRenderIds) {
      if (this.activeEntityPredictionIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) {
        this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
      }
    }
    for (const id of this.renderLifecycleDirtyIds) {
      if (this.activeEntityPredictionIds.has(id) || this.dirtyBuildingRenderIds.has(id)) continue;
      const entity = this.entities.get(id);
      if (entity !== undefined && entity.building !== null) {
        this.pushBuildingRenderRow3D(entity, this.entityUsesFarLod3D(entity, options), out);
      }
    }
  }

  private pushUnitRenderRow3D(
    entity: Entity,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const id = entity.id;
    const existingSlot = this.renderEntityState.getSlot(id);
    const slot = existingSlot ?? this.refreshRenderableEntityState(entity);
    if (slot !== undefined) {
      if (existingSlot === undefined) {
        this.markRenderEntityPacketFlagsForFreshSlot(id, slot, true);
      }
      out.unitRows.pushEntityState(
        entity,
        this.renderEntityState.getViews(),
        slot,
        this.renderTurretState,
        false,
        false,
        false,
        farLod,
      );
    } else {
      const activePrediction = this.activeEntityPredictionIds.has(id);
      const renderDirty = this.dirtyUnitRenderIds.has(id);
      const lifecycleDirty = this.renderLifecycleDirtyIds.has(id);
      out.unitRows.pushEntity(
        entity,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
    }
  }

  private pushUnitRenderKnownSlot3D(
    entity: Entity,
    slot: number,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const views = this.renderEntityState.getViews();
    const id = entity.id;
    if (
      slot >= 0 &&
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT &&
      views.entityIds[slot] === id
    ) {
      out.unitRows.pushEntityState(
        entity,
        views,
        slot,
        this.renderTurretState,
        false,
        false,
        false,
        farLod,
      );
      return;
    }
    this.pushUnitRenderRow3D(entity, farLod, out);
  }

  private pushBuildingRenderRow3D(
    entity: Entity,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const id = entity.id;
    const existingSlot = this.renderEntityState.getSlot(id);
    const slot = existingSlot ?? this.refreshRenderableEntityState(entity);
    if (slot !== undefined) {
      if (existingSlot === undefined) {
        this.markRenderEntityPacketFlagsForFreshSlot(id, slot, false);
      }
      out.buildingRows.pushEntityState(
        entity,
        this.renderEntityState.getViews(),
        slot,
        this.renderTurretState,
        false,
        false,
        false,
        farLod,
      );
    } else {
      const activePrediction = this.activeEntityPredictionIds.has(id);
      const renderDirty = this.dirtyBuildingRenderIds.has(id);
      const lifecycleDirty = this.renderLifecycleDirtyIds.has(id);
      out.buildingRows.pushEntity(
        entity,
        activePrediction,
        renderDirty,
        lifecycleDirty,
        farLod,
      );
    }
  }

  private pushBuildingRenderKnownSlot3D(
    entity: Entity,
    slot: number,
    farLod: boolean,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    const views = this.renderEntityState.getViews();
    const id = entity.id;
    if (
      slot >= 0 &&
      views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING &&
      views.entityIds[slot] === id
    ) {
      out.buildingRows.pushEntityState(
        entity,
        views,
        slot,
        this.renderTurretState,
        false,
        false,
        false,
        farLod,
      );
      return;
    }
    this.pushBuildingRenderRow3D(entity, farLod, out);
  }

  private populateRenderRemovalRows3D(out: ClientViewRenderEntityPackets3D): void {
    const removedUnits = this.removedUnitRenderIds;
    for (let i = 0; i < removedUnits.length; i++) {
      out.unitRows.pushRemovedEntityId(removedUnits[i]);
    }
    const removedBuildings = this.removedBuildingRenderIds;
    for (let i = 0; i < removedBuildings.length; i++) {
      out.buildingRows.pushRemovedEntityId(removedBuildings[i]);
    }
  }

  private populateBodyHudPacket3D(
    entities: readonly Entity[],
    hoveredEntity: Entity | null,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    let hoveredBodyHudPushed = false;
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (this.entityEmissionUsesFarLod3D(entity, options)) continue;
      const forceVisible = entity === hoveredEntity;
      if (forceVisible) hoveredBodyHudPushed = true;
      this.pushBodyHudEntity3D(entity, forceVisible, options, out);
    }
    if (
      hoveredEntity !== null &&
      !hoveredBodyHudPushed &&
      !this.entityEmissionUsesFarLod3D(hoveredEntity, options)
    ) {
      this.pushBodyHudEntity3D(hoveredEntity, true, options, out);
    }
  }

  private pushBodyHudEntity3D(
    entity: Entity,
    forceVisible: boolean,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
    knownSlot = -1,
  ): void {
    const unit = entity.unit;
    const building = entity.building;
    if (unit === null && building === null) return;
    if (this.entityEmissionUsesFarLod3D(entity, options)) return;
    // The lod.json healthBar feature rung: bars shed below their authored
    // rung like any other part of the detail ladder. Hover always wins so
    // inspecting a distant unit still shows its bar.
    if (
      !forceVisible &&
      options.isEntityHudRungVisible !== undefined &&
      !options.isEntityHudRungVisible(entity)
    ) {
      return;
    }

    const type = this.hudTypeOf3D(entity);
    let views = this.renderEntityState.getViews();
    let slot: number | undefined =
      knownSlot >= 0 &&
      (
        views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_UNIT ||
        views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_BUILDING
      ) &&
      views.entityIds[knownSlot] === entity.id
        ? knownSlot
        : undefined;
    if (slot === undefined) {
      slot = this.getOrRefreshRenderEntityStateSlot(entity);
      views = this.renderEntityState.getViews();
    }
    if (slot !== undefined) {
      const kind = views.kind[slot];
      if (
        kind === CLIENT_RENDER_ENTITY_KIND_UNIT ||
        kind === CLIENT_RENDER_ENTITY_KIND_BUILDING
      ) {
        const stateFlags = views.flags[slot];
        const selected = (stateFlags & CLIENT_RENDER_ENTITY_FLAG_SELECTED) !== 0;
        const buildInProgress =
          (stateFlags & CLIENT_RENDER_ENTITY_FLAG_BUILD_IN_PROGRESS) !== 0;
        const hp = views.hp[slot];
        const maxHp = views.maxHp[slot];
        const healthNotFull = maxHp > 0 && hp < maxHp;
        const showHealth = this.barVisible3D(
          options.getEntityHudToggle(type, 'healthBar'),
          selected,
          options.selectionHudMode,
          healthNotFull,
        );
        const showBuild = this.barVisible3D(
          options.getEntityHudToggle(type, 'buildBars'),
          selected,
          options.selectionHudMode,
          buildInProgress,
        );
        const showHp = maxHp > 0 && (showHealth || forceVisible)
          && (buildInProgress || hp > 0);
        const showBuildBars = showBuild && buildInProgress;
        if (!showHp && !showBuildBars) return;

        out.bodyHud.pushRow(
          views.entityIds[slot],
          views.x[slot],
          views.hudBarsY[slot],
          views.y[slot],
          views.bodyHudWidth[slot],
          maxHp > 0 ? hp / maxHp : 0,
          buildInProgress ? views.buildEnergyRatio[slot] : 0,
          buildInProgress ? views.buildMetalRatio[slot] : 0,
          showHp,
          showBuildBars,
        );
        return;
      }
    }

    const selected = entity.selectable?.selected === true;
    const buildable = isBuildInProgress(entity.buildable)
      ? entity.buildable
      : null;
    const hp = unit !== null ? unit.hp : building !== null ? building.hp : 0;
    const maxHp = unit !== null ? unit.maxHp : building !== null ? building.maxHp : 0;
    const healthNotFull = maxHp > 0 && hp < maxHp;
    const showHealth = this.barVisible3D(
      options.getEntityHudToggle(type, 'healthBar'),
      selected,
      options.selectionHudMode,
      healthNotFull,
    );
    const showBuild = this.barVisible3D(
      options.getEntityHudToggle(type, 'buildBars'),
      selected,
      options.selectionHudMode,
      buildable !== null,
    );
    const showHp = maxHp > 0 && (showHealth || forceVisible)
      && (buildable !== null || hp > 0);
    const showBuildBars = showBuild && buildable !== null;
    if (!showHp && !showBuildBars) return;

    out.bodyHud.pushRow(
      entity.id,
      entity.transform.x,
      unit !== null ? getUnitHudBarsY(entity) : getBuildingHudBarsY(entity),
      entity.transform.y,
      unit !== null ? unit.radius.other * 2 : building!.width,
      maxHp > 0 ? hp / maxHp : 0,
      buildable !== null ? getResourceFillRatio(buildable, 'energy') : 0,
      buildable !== null ? getResourceFillRatio(buildable, 'metal') : 0,
      showHp,
      showBuildBars,
    );
  }

  private populateBodyNamePacket3D(
    entities: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
  ): void {
    for (let i = 0; i < entities.length; i++) {
      const entity = entities[i];
      if (!this.entityEmissionUsesFarLod3D(entity, options)) {
        this.pushBodyNamesForEntity3D(entity, options, out);
      }
    }
  }

  private pushBodyNamesForEntity3D(
    entity: Entity,
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
    knownSlot = -1,
  ): void {
    if (this.entityEmissionUsesFarLod3D(entity, options)) return;
    // lod.json nameLabel feature rung — same ladder semantics as bars.
    if (
      options.isEntityNameRungVisible !== undefined &&
      !options.isEntityNameRungVisible(entity)
    ) {
      return;
    }
    const type = this.hudTypeOf3D(entity);
    const nameToggle = options.getEntityHudToggle(type, 'name');
    let views = this.renderEntityState.getViews();
    let slot: number | undefined =
      knownSlot >= 0 &&
      (
        views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_UNIT ||
        views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_BUILDING
      ) &&
      views.entityIds[knownSlot] === entity.id
        ? knownSlot
        : undefined;
    if (slot === undefined) {
      slot = this.getOrRefreshRenderEntityStateSlot(entity);
      views = this.renderEntityState.getViews();
    }
    let labelX = entity.transform.x;
    let labelZ = entity.transform.y;
    let bodyNameY = entity.unit !== null
      ? getUnitHudNameY(entity)
      : getBuildingHudNameY(entity);
    if (
      slot !== undefined &&
      (
        views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT ||
        views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING
      )
    ) {
      labelX = views.x[slot];
      labelZ = views.y[slot];
      bodyNameY = views.hudNameY[slot];
    }
    const bodyName = resolveEntityDisplayName(
      entity,
      nameToggle,
      options.selectionHudMode,
    );
    if (bodyName !== null) {
      out.pieceNames.push(
        entity.id,
        PIECE_TAG_BODY,
        labelX,
        bodyNameY,
        labelZ,
        bodyName,
      );
    }
    const ownerName = resolveCommanderOwnerName(
      entity,
      (playerId) => options.lookupPlayerName(playerId) ?? getDefaultPlayerName(playerId),
      nameToggle,
      options.selectionHudMode,
    );
    if (ownerName !== null) {
      out.pieceNames.push(
        entity.id,
        PIECE_TAG_COMMANDER_OWNER_NAME,
        labelX,
        bodyNameY + NAME_LABEL_OWNER_Y_OFFSET,
        labelZ,
        ownerName,
        'owner',
      );
    }
  }

  private populateShieldPacket3D(
    units: readonly Entity[],
    renderScope: ViewportFootprint,
    out: ClientViewRenderEntityPackets3D,
    shieldVisibilityTeamMask: number,
  ): void {
    for (let i = 0; i < units.length; i++) {
      // Never apply the generic far-emission cutoff here. ShieldRenderPacket3D
      // performs barrier-radius scope culling and ShieldRenderer3D selects a
      // real High/Medium/Low surface for every packet row.
      this.pushShieldUnit3D(units[i], renderScope, out, -1, shieldVisibilityTeamMask);
    }
  }

  private pushShieldUnit3D(
    entity: Entity,
    renderScope: ViewportFootprint,
    out: ClientViewRenderEntityPackets3D,
    knownSlot = -1,
    shieldVisibilityTeamMask = 0,
  ): void {
    if (shieldVisibilityTeamMask !== 0) {
      const ownerId = entity.ownership?.playerId ?? 0;
      const ownerBit = ownerId >= 1 && ownerId <= 31 ? 1 << (ownerId - 1) : 0;
      if ((shieldVisibilityTeamMask & ownerBit) === 0) return;
    }
    let views = this.renderEntityState.getViews();
    let slot: number | undefined =
      knownSlot >= 0 &&
      views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_UNIT &&
      views.entityIds[knownSlot] === entity.id
        ? knownSlot
        : undefined;
    if (slot === undefined) {
      slot = this.getOrRefreshRenderEntityStateSlot(entity);
      views = this.renderEntityState.getViews();
    }
    if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT) {
      out.shields.pushUnitTurretState(
        views,
        slot,
        this.renderTurretState.hostRows(slot),
        renderScope,
      );
    } else {
      out.shields.pushUnit(entity, renderScope);
    }
  }

  private populateEntityShadowPacket3D(
    units: readonly Entity[],
    buildings: readonly Entity[],
    renderScope: ViewportFootprint,
    out: ClientViewRenderEntityPackets3D,
    unitSlots?: readonly number[],
    buildingSlots?: readonly number[],
  ): void {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    let views = this.renderEntityState.getViews();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      const knownSlot = unitSlots?.[i] ?? -1;
      let slot: number | undefined =
        knownSlot >= 0 &&
        views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_UNIT &&
        views.entityIds[knownSlot] === entity.id
          ? knownSlot
          : undefined;
      if (slot === undefined) {
        slot = this.getOrRefreshRenderEntityStateSlot(entity);
        views = this.renderEntityState.getViews();
      }
      if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT) {
        out.entityShadows.pushUnitState(
          views.entityIds[slot],
          views.x[slot],
          views.y[slot],
          views.z[slot],
          views.radiusHitbox[slot],
          Math.max(1, views.supportPointOffsetZ[slot] || views.radiusOther[slot]),
          mapWidth,
          mapHeight,
          renderScope,
        );
      } else {
        out.entityShadows.pushUnit(entity, mapWidth, mapHeight, renderScope);
      }
    }
    for (let i = 0; i < buildings.length; i++) {
      const entity = buildings[i];
      const knownSlot = buildingSlots?.[i] ?? -1;
      let slot: number | undefined =
        knownSlot >= 0 &&
        views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_BUILDING &&
        views.entityIds[knownSlot] === entity.id
          ? knownSlot
          : undefined;
      if (slot === undefined) {
        slot = this.getOrRefreshRenderEntityStateSlot(entity);
        views = this.renderEntityState.getViews();
      }
      if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_BUILDING) {
        out.entityShadows.pushBuildingState(
          views.x[slot],
          views.y[slot],
          views.entityShadowWidth[slot],
          views.entityShadowDepth[slot],
          renderScope,
        );
      } else {
        out.entityShadows.pushBuilding(entity, renderScope);
      }
    }
  }

  private populateGroundPrintPacket3D(
    units: readonly Entity[],
    options: ClientViewRenderPacketOptions3D,
    out: ClientViewRenderEntityPackets3D,
    unitSlots?: readonly number[],
  ): void {
    const mapWidth = this.getMapWidth();
    const mapHeight = this.getMapHeight();
    let views = this.renderEntityState.getViews();
    for (let i = 0; i < units.length; i++) {
      const entity = units[i];
      if (this.entityEmissionUsesFarLod3D(entity, options)) continue;
      const knownSlot = unitSlots?.[i] ?? -1;
      let slot: number | undefined =
        knownSlot >= 0 &&
        views.kind[knownSlot] === CLIENT_RENDER_ENTITY_KIND_UNIT &&
        views.entityIds[knownSlot] === entity.id
          ? knownSlot
          : undefined;
      if (slot === undefined) {
        slot = this.getOrRefreshRenderEntityStateSlot(entity);
        views = this.renderEntityState.getViews();
      }
      if (slot !== undefined && views.kind[slot] === CLIENT_RENDER_ENTITY_KIND_UNIT) {
        const entityId = views.entityIds[slot] as EntityId;
        const loc = options.getGroundPrintLocomotionMesh(entityId);
        const grounded = loc?.type === 'crawler'
          ? loc.visualGrounded
          : this.groundPrintGroundedFromState(slot, mapWidth, mapHeight);
        out.groundPrints.pushRow(
          entityId,
          views.x[slot],
          views.y[slot],
          grounded,
        );
      } else {
        out.groundPrints.pushUnit(
          entity,
          options.getGroundPrintLocomotionMesh,
          mapWidth,
          mapHeight,
        );
      }
    }
  }

  private groundPrintGroundedFromState(
    slot: number,
    mapWidth: number,
    mapHeight: number,
  ): boolean {
    const views = this.renderEntityState.getViews();
    if (views.groundContactEnabled[slot] === 0) return false;
    const x = views.x[slot];
    const y = views.y[slot];
    const z = views.z[slot];
    const groundY = getLocomotionSurfaceHeight(
      x,
      y,
      mapWidth,
      mapHeight,
      views.entityIds[slot] as EntityId,
    );
    const penetration = groundY - (z - views.supportPointOffsetZ[slot]);
    return isUnitGroundPenetrationInContact(penetration, views.radiusCollision[slot]);
  }

  private entityUsesFarLod3D(
    entity: Entity,
    options: ClientViewRenderPacketOptions3D,
  ): boolean {
    return options.isEntityFarLod?.(entity) === true;
  }

  private entityEmissionUsesFarLod3D(
    entity: Entity,
    options: ClientViewRenderPacketOptions3D,
  ): boolean {
    return options.isEntityEmissionFarLod?.(entity)
      ?? this.entityUsesFarLod3D(entity, options);
  }

  getLocomotionSupportSurfaceEntities(): readonly Entity[] {
    return this.locomotionSupportSurfaceEntities;
  }

  getBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildings();
  }

  /** Units + buildings as a single iterable. Hot per-frame UI loops
   *  (minimap, name labels) used to call getUnits() and getBuildings()
   *  back-to-back; this lets them iterate once and branch inline on
   *  entity.unit vs entity.building. */
  getUnitsAndBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getUnitsAndBuildings();
  }

  getBuildingsByPlayer(playerId: PlayerId): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getBuildingsByPlayer(playerId);
  }

  getProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getProjectiles();
  }

  getTravelingProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getTravelingProjectiles();
  }

  getSmokeTrailProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getSmokeTrailProjectiles();
  }

  getLineProjectiles(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getLineProjectiles();
  }

  collectProjectileRenderLists(
    bounds: FootprintBounds | null,
    out: ClientProjectileRenderLists,
  ): ClientProjectileRenderLists {
    return this.projectileStore.collectRenderLists(bounds, out);
  }

  getLineProjectileRenderVersion(): number {
    return this.projectileStore.getLineProjectileRenderVersion();
  }

  getShieldUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getShieldUnits();
  }

  getDamagedUnits(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getDamagedUnits();
  }

  getHealthBarBuildings(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getHealthBarBuildings();
  }

  /** Units / towers / buildings needing ANY HUD bar this frame
   *  (body-damaged, building, or a damaged sub-piece). Selection is
   *  applied by the orchestrator against the live entity ref, not here. */
  getHudEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getHudEntities();
  }

  /** Entities (unit/building) with at least one attack
   *  turret. Feeds the turret HUD bar / name pass. */
  getArmedEntities(): Entity[] {
    this.rebuildCachesIfNeeded();
    return this.cache.getArmedEntities();
  }

  getSprayTargets(): SprayTarget[] {
    return this.sprayTargetStore.getTargets();
  }

  getPendingAudioEvents(): NetworkServerSnapshot['audioEvents'] {
    const events = this.pendingAudioEvents;
    this.pendingAudioEvents = EMPTY_AUDIO;
    return events;
  }

  /** Active scan pulses for this client's team (FOW-14). The fog shade
   *  renderer reads these to clear fog inside each sweep for the
   *  pulse's remaining lifetime. Returned array is the live
   *  store — callers must not mutate it. */
  getScanPulses(): ReadonlyArray<NonNullable<NetworkServerSnapshot['scanPulses']>[number]> {
    return this.scanPulses;
  }

  /** Player IDs whose full-vision entities should drive live fog /
   *  sight presentation for this client. The host sends a compact
   *  recipient+allies bitmask; older/unfiltered snapshots fall back to
   *  the local player so standalone rendering keeps its prior behavior. */
  getVisionPlayerIds(localPlayerId: PlayerId): readonly PlayerId[] {
    const out = this.visionPlayerIds;
    out.length = 0;
    let pending = this.visionPlayerMask;
    if (pending === 0) {
      out.push(localPlayerId);
      return out;
    }
    while (pending !== 0) {
      const lowBit = pending & -pending;
      out.push((32 - Math.clz32(lowBit)) as PlayerId);
      pending ^= lowBit;
    }
    return out;
  }

  getGameOverWinnerId(): PlayerId | null {
    return this.gameOverWinnerId;
  }

  getGamePhase(): GamePhase {
    return this.gamePhase;
  }

  getTick(): number {
    return this.currentTick;
  }

  // === Selection management ===

  setSelectedIds(ids: Set<EntityId>): void {
    this.selectionState.set(ids);
    this.refreshAllRenderableEntityStates();
  }

  getSelectedIds(): Set<EntityId> {
    return this.selectionState.get();
  }

  selectEntity(id: EntityId): void {
    this.selectionState.select(id);
    this.refreshRenderEntityStateById(id);
  }

  deselectEntity(id: EntityId): void {
    this.selectionState.deselect(id);
    this.refreshRenderEntityStateById(id);
  }

  clearSelection(): void {
    const hadSelection = this.selectionState.get().size > 0;
    this.selectionState.clear();
    if (hadSelection) this.refreshAllRenderableEntityStates();
  }

  getServerMeta(): NetworkServerSnapshotMeta | null {
    return this.serverMeta;
  }

  clear(): void {
    this.projectileStore.clear();
    this.entities.clear();
    this.serverTargets.clear();
    this.sprayTargetStore.reset();
    this.clearResourcePylonFlows();
    this.pendingAudioEvents = EMPTY_AUDIO;
    this.scanPulses.length = 0;
    this.visionPlayerMask = 0;
    this.visionPlayerIds.length = 0;
    this.minimapOverrideStore.reset();
    this.gameOverWinnerId = null;
    this.gamePhase = 'init';
    this.selectionState.reset();
    this.terrainBuildabilityGrid = null;
    this.serverMeta = null;
    this.renderSpatialIndex.clear();
    this.renderEntityState.clear();
    this.renderTurretState.clear();
    this.supplementalPresentation.reset();
    this.lockstepPresentation.reset();
    this.lockstepPresentationEnabled = false;
    this.activeEntityPredictionIds.clear();
    this.dirtyUnitRenderIds.clear();
    this.dirtyBuildingRenderIds.clear();
    this.renderLifecycleDirtyIds.clear();
    this.locomotionSupportSurfaceEntities.length = 0;
    this.locomotionSupportSurfaceEntityIds.clear();
    resetClientPredictionTargetPools();
    this.entitySetVersion++;
    this.invalidateCaches();
  }
}
