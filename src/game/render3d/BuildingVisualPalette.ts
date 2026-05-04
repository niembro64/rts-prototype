export const BUILDING_PALETTE = {
  structureDark: 0x172331,
  structureMid: 0x34414d,
  structureLight: 0xc8d4dd,
  photovoltaic: 0x123a58,
  photovoltaicBack: 0x26313a,
  cyanGlow: 0x73ddeb,
  cyanGlass: 0x82dce9,
  constructionAmber: 0xe8cd72,
  constructionSpark: 0xdbe9ee,
} as const;

export const SHINY_GRAY_METAL_MATERIAL = {
  color: BUILDING_PALETTE.structureLight,
  metalness: 0.78,
  roughness: 0.18,
  envMapIntensity: 1.0,
} as const;

export const MIRROR_CHROME_MATERIAL = {
  color: SHINY_GRAY_METAL_MATERIAL.color,
  metalness: 1.0,
  roughness: 0.025,
  envMapIntensity: 1.45,
} as const;
