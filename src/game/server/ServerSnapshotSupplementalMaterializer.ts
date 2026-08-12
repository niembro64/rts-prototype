import type { NetworkServerSnapshot } from '../network/NetworkTypes';
import {
  serializeAudioEvents,
  writeAudioEventWireRowsDirect,
} from '../network/stateSerializerAudio';
import {
  serializeEconomySnapshot,
  writeEconomySnapshotWireRowsDirect,
} from '../network/stateSerializerEconomy';
import {
  serializeMinimapSnapshotEntities,
  writeMinimapSnapshotWireRowsDirect,
} from '../network/stateSerializerMinimap';
import {
  serializeResourceMovements,
  writeResourceMovementWireRowsDirect,
} from '../network/stateSerializerResourceMovements';
import {
  serializeSprayTargets,
  writeSprayTargetWireRowsDirect,
} from '../network/stateSerializerSpray';
import {
  serializeScanPulses,
  writeScanPulseWireRowsDirect,
  type SnapshotVisibility,
} from '../network/stateSerializerVisibility';
import {
  measureSnapshotMaterializationStage,
  type SnapshotMaterializationStageDurations,
} from '../network/snapshotMaterializationMetadata';
import type {
  SerializerAudioOverride,
  SerializerMinimapOverride,
  SerializerSprayOverride,
} from '../network/stateSerializer';
import type { SprayTarget } from '../sim/commanderAbilities';
import type { SimEvent } from '../sim/combat';
import type { PlayerId } from '../sim/types';
import type { WorldState } from '../sim/WorldState';

export type DirectSnapshotDelivery = {
  preencodeWire: boolean;
  materializeSupplementalDtos: boolean;
  trackingKey: string;
};

export type SnapshotSupplementalBuffers = {
  minimap: NonNullable<NetworkServerSnapshot['minimapEntities']>;
  economy: NonNullable<NetworkServerSnapshot['economy']>;
  resourceMovements: NonNullable<NetworkServerSnapshot['resourceMovements']>;
  sprayTargets: NonNullable<NetworkServerSnapshot['sprayTargets']>;
  audioEvents: NonNullable<NetworkServerSnapshot['audioEvents']>;
  scanPulses: NonNullable<NetworkServerSnapshot['scanPulses']>;
};

type SnapshotSupplementalMaterializationInput = {
  world: WorldState;
  recipientPlayerId: PlayerId | undefined;
  visibility: SnapshotVisibility;
  sprayTargets: SprayTarget[] | undefined;
  audioEvents: SimEvent[] | undefined;
  audioOverride: SerializerAudioOverride | undefined;
  sprayOverride: SerializerSprayOverride | undefined;
  minimapOverride: SerializerMinimapOverride | undefined;
  delivery: DirectSnapshotDelivery;
  stages: SnapshotMaterializationStageDurations | undefined;
  buffers: SnapshotSupplementalBuffers;
};

type SnapshotAudioMaterializationInput = Pick<
  SnapshotSupplementalMaterializationInput,
  'audioEvents' | 'visibility' | 'audioOverride' | 'delivery' | 'stages' | 'buffers'
>;

export function materializeSnapshotAudioEvents(
  input: SnapshotAudioMaterializationInput,
): NetworkServerSnapshot['audioEvents'] {
  if (input.audioOverride !== undefined) return input.audioOverride.value;
  return measureSnapshotMaterializationStage(input.stages, 'audio', () => (
    input.delivery.materializeSupplementalDtos
      ? serializeAudioEvents(
          input.audioEvents,
          input.visibility,
          input.delivery.trackingKey,
        )
      : writeAudioEventWireRowsDirect(
          input.audioEvents,
          input.visibility,
          input.buffers.audioEvents,
        )
  ));
}

export function materializeSnapshotSupplementals(
  input: SnapshotSupplementalMaterializationInput,
): Pick<
  NetworkServerSnapshot,
  | 'minimapEntities'
  | 'economy'
  | 'resourceMovements'
  | 'sprayTargets'
  | 'audioEvents'
  | 'scanPulses'
> {
  const materializeDtos = input.delivery.materializeSupplementalDtos;
  const minimapEntities = input.minimapOverride !== undefined
    ? input.minimapOverride.value
    : measureSnapshotMaterializationStage(input.stages, 'minimap', () => (
        materializeDtos
          ? serializeMinimapSnapshotEntities(
              input.world,
              input.visibility,
              input.delivery.trackingKey,
            )
          : writeMinimapSnapshotWireRowsDirect(
              input.world,
              input.visibility,
              input.buffers.minimap,
            )
      ));
  const economy = measureSnapshotMaterializationStage(input.stages, 'economy', () => (
    materializeDtos
      ? serializeEconomySnapshot(input.world.playerCount, input.recipientPlayerId)
      : writeEconomySnapshotWireRowsDirect(
          input.world.playerCount,
          input.recipientPlayerId,
          input.buffers.economy,
        )
  ));
  const resourceMovements = measureSnapshotMaterializationStage(input.stages, 'resources', () => (
    materializeDtos
      ? serializeResourceMovements(input.world, input.visibility)
      : writeResourceMovementWireRowsDirect(
          input.world,
          input.visibility,
          input.buffers.resourceMovements,
        )
  ));
  const sprayTargets = input.sprayOverride !== undefined
    ? input.sprayOverride.value
    : measureSnapshotMaterializationStage(input.stages, 'spray', () => (
        materializeDtos
          ? serializeSprayTargets(
              input.sprayTargets,
              input.visibility,
              input.delivery.trackingKey,
            )
          : writeSprayTargetWireRowsDirect(
              input.sprayTargets,
              input.visibility,
              input.buffers.sprayTargets,
            )
      ));
  const audioEvents = materializeSnapshotAudioEvents(input);
  const scanPulses = measureSnapshotMaterializationStage(input.stages, 'scanPulses', () => (
    materializeDtos
      ? serializeScanPulses(input.world, input.visibility)
      : writeScanPulseWireRowsDirect(
          input.world,
          input.visibility,
          input.buffers.scanPulses,
        )
  ));
  return {
    minimapEntities,
    economy,
    resourceMovements,
    sprayTargets,
    audioEvents,
    scanPulses,
  };
}
