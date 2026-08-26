import {
  backdropUrlsForPresetName,
  PRESET_BACKDROP_LAYER_IDS,
} from './presetBackdrops';
import { resolvePresetBackdropLayerConfig } from './ParallaxBackdropRenderer3D';
import { getModeDefaultPreset } from '@/components/battlePresets';

function assertContract(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[parallax backdrop contract] ${message}`);
}

export function runParallaxBackdropRenderer3DContractTest(): void {
  assertContract(
    PRESET_BACKDROP_LAYER_IDS.join(',') === 'near,middle,far,terminal',
    'layer IDs must stay ordered from nearest transparent shell to terminal sky',
  );
  const defaultPreset = getModeDefaultPreset('demo');
  const urls = backdropUrlsForPresetName(defaultPreset.name);
  assertContract(urls.length === 4, 'stock presets must resolve four URLs');
  for (let index = 0; index < PRESET_BACKDROP_LAYER_IDS.length; index++) {
    assertContract(
      urls[index].endsWith(
        `${defaultPreset.backdropSlug}-${PRESET_BACKDROP_LAYER_IDS[index]}.ktx2`,
      ),
      `URL ${index} must use its layer ID suffix`,
    );
  }
  // Off-preset settings get the generated `default` set — never a bare
  // gradient sky, and never a stock preset's panorama.
  for (const name of [null, 'not a preset']) {
    const fallback = backdropUrlsForPresetName(name);
    assertContract(fallback.length === 4, 'the fallback must resolve four URLs');
    for (let index = 0; index < PRESET_BACKDROP_LAYER_IDS.length; index++) {
      assertContract(
        fallback[index].endsWith(`default-${PRESET_BACKDROP_LAYER_IDS[index]}.ktx2`),
        `fallback URL ${index} must use the default slug and its layer ID suffix`,
      );
    }
  }

  for (const mapAxis of [700, 7900, 11900]) {
    const layers = resolvePresetBackdropLayerConfig(mapAxis, mapAxis);
    assertContract(layers.length === 4, 'renderer config must resolve four shells');
    for (let index = 0; index < layers.length; index++) {
      assertContract(
        layers[index].id === PRESET_BACKDROP_LAYER_IDS[index],
        `resolved layer ${index} must preserve generator ordering`,
      );
      assertContract(
        layers[index].terminal === (index === layers.length - 1),
        'only the last shell may be the opaque terminal sky',
      );
      if (index === 0) continue;
      assertContract(
        layers[index - 1].distanceWorldUnits < layers[index].distanceWorldUnits,
        'effective parallax distances must increase for every supported map size',
      );
      assertContract(
        layers[index - 1].blurRadiusPixels < layers[index].blurRadiusPixels,
        'earlier layers must be less blurry than later layers',
      );
    }
  }
}
