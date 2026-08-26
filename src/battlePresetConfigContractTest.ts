import { BATTLE_CONFIG } from './battleBarConfig';
import battleBarConfig from './battleBarConfig.json';
import rawBattlePresetConfig from './battlePresets.json';
import {
  BATTLE_PRESETS,
  getModeDefaultPreset,
  type BattlePreset,
} from './components/battlePresets';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[battle preset config contract] ${message}`);
}

const NUMBER_OPTION_FIELDS = [
  'centerMagnitude',
  'ringMagnitude',
  'dividersMagnitude',
  'perimeterMagnitude',
  'terrainDTerrain',
  'plateauWallSlopeDegrees',
  'metalDepositStep',
  'terrainDetail',
  'converterTax',
] as const satisfies readonly (keyof BattlePreset)[];

/** Presets are authored once in JSON. This pins the whole path from that data
 * through startup defaults and persistence normalization, preventing another
 * split name/value registry from quietly growing back in TypeScript. */
export function runBattlePresetConfigContractTest(): void {
  assertContract(
    rawBattlePresetConfig.schemaVersion === 1,
    'battlePresets.json must declare the supported schemaVersion 1 contract',
  );
  assertContract(
    !Object.prototype.hasOwnProperty.call(battleBarConfig, 'demoDefault') &&
      !Object.prototype.hasOwnProperty.call(battleBarConfig, 'realDefault'),
    'battleBarConfig.json must not carry a second preset-default registry',
  );
  assertContract(
    BATTLE_PRESETS.length === rawBattlePresetConfig.presets.length,
    'every battlePresets.json record must reach the runtime picker',
  );

  for (let index = 0; index < BATTLE_PRESETS.length; index++) {
    const loaded = BATTLE_PRESETS[index];
    const authored = rawBattlePresetConfig.presets[index];
    assertContract(
      loaded === authored,
      `preset ${index} must be the validated JSON record, not a restated copy`,
    );
    for (const field of NUMBER_OPTION_FIELDS) {
      assertContract(
        BATTLE_CONFIG[field].options.includes(loaded[field]),
        `${loaded.id}.${field} must be accepted by apply/save/reload normalization`,
      );
    }
    assertContract(
      BATTLE_CONFIG.mapSize.width.options.some(
        (option) => option.valueLandCells === loaded.mapWidthLandCells,
      ),
      `${loaded.id}.mapWidthLandCells must be an accepted WIDTH value`,
    );
    assertContract(
      BATTLE_CONFIG.mapSize.length.options.some(
        (option) => option.valueLandCells === loaded.mapLengthLandCells,
      ),
      `${loaded.id}.mapLengthLandCells must be an accepted LENGTH value`,
    );
  }

  for (const mode of ['demo', 'real'] as const) {
    assertContract(
      getModeDefaultPreset(mode).id === rawBattlePresetConfig.modeDefaults[mode],
      `${mode} default must resolve the stable id authored in battlePresets.json`,
    );
  }
}
