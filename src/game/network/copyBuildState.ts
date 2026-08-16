type BuildState = {
  complete: boolean;
  interrupted?: boolean;
  paid: {
    energy: number;
    metal: number;
  };
};

export function copyBuildStateInto<T extends BuildState>(
  source: Readonly<BuildState>,
  destination: T,
): T {
  destination.complete = source.complete;
  destination.interrupted = source.interrupted === true;
  destination.paid.energy = source.paid.energy;
  destination.paid.metal = source.paid.metal;
  return destination;
}
