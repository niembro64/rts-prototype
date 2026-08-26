import { MAP_DIMENSION_CONFIG } from './mapSizeConfig';

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[map size config contract] ${message}`);
}

export function runMapSizeConfigContractTest(): void {
  const widthValues = MAP_DIMENSION_CONFIG.width.options.map(
    (option) => option.valueLandCells,
  );
  const lengthValues = MAP_DIMENSION_CONFIG.length.options.map(
    (option) => option.valueLandCells,
  );

  assertContract(
    widthValues.length === 10 && lengthValues.length === 10,
    'the BATTLE bar must expose ten WIDTH and ten LENGTH buttons',
  );
  assertContract(
    widthValues[widthValues.length - 2] === 179 &&
      widthValues[widthValues.length - 1] === 269,
    'WIDTH must end with the two larger 179 and 269 land-cell options',
  );
  assertContract(
    lengthValues[lengthValues.length - 2] === 179 &&
      lengthValues[lengthValues.length - 1] === 269,
    'LENGTH must end with the two larger 179 and 269 land-cell options',
  );
  assertContract(
    widthValues.every((value, index) => value === lengthValues[index]),
    'WIDTH and LENGTH must use the same authored size ladder',
  );
}
