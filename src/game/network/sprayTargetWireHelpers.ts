type NullableWireValue = unknown | null | undefined;

type SprayTargetWireFlagSource = {
  type: string;
  inverse?: NullableWireValue;
  source: { z?: NullableWireValue };
  target: {
    z?: NullableWireValue;
    dim?: NullableWireValue;
    radius?: NullableWireValue;
  };
  speed?: NullableWireValue;
  particleRadius?: NullableWireValue;
  ballSpawnRate?: NullableWireValue;
};

export function getSprayTargetWireFlags(
  spray: SprayTargetWireFlagSource,
): number {
  let flags = 0;
  if (spray.type === 'heal') flags |= 0x01;
  if (spray.source.z !== undefined && spray.source.z !== null) flags |= 0x02;
  if (spray.target.z !== undefined && spray.target.z !== null) flags |= 0x04;
  if (spray.target.dim !== undefined && spray.target.dim !== null) flags |= 0x08;
  if (spray.target.radius !== undefined && spray.target.radius !== null) flags |= 0x10;
  if (spray.speed !== undefined && spray.speed !== null) flags |= 0x20;
  if (spray.particleRadius !== undefined && spray.particleRadius !== null) flags |= 0x40;
  if (spray.ballSpawnRate !== undefined && spray.ballSpawnRate !== null) flags |= 0x80;
  if (spray.inverse === true) flags |= 0x100;
  return flags;
}
