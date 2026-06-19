import { COLORS, RESOURCE_COLOR_HEX } from '@/colorsConfig';

export const BUILDING_PALETTE = {
  structureDark: COLORS.buildings.palette.structureDark.colorHex,
  structureMid: COLORS.buildings.palette.structureMid.colorHex,
  structureLight: COLORS.buildings.palette.structureLight.colorHex,
  photovoltaic: COLORS.buildings.palette.photovoltaic.colorHex,
  photovoltaicBack: COLORS.buildings.palette.photovoltaicBack.colorHex,
  cyanGlow: COLORS.buildings.palette.cyanGlow.colorHex,
  cyanGlass: COLORS.buildings.palette.cyanGlass.colorHex,
  constructionAmber: COLORS.buildings.palette.constructionAmber.colorHex,
  constructionSpark: COLORS.buildings.palette.constructionSpark.colorHex,
  /** Metal-resource color — matches the metal coin/ball tint in
   *  ConstructionEmitterMesh3D and the "metal" income bar. Used for the
   *  metal extractor's spinning blades. */
  metalResource: RESOURCE_COLOR_HEX.metal,
} as const;

export const SHINY_GRAY_METAL_MATERIAL = {
  color: COLORS.buildings.materials.shinyGrayMetal.colorHex,
  metalness: COLORS.buildings.materials.shinyGrayMetal.metalness,
  roughness: COLORS.buildings.materials.shinyGrayMetal.roughness,
  envMapIntensity: COLORS.buildings.materials.shinyGrayMetal.envMapIntensity,
} as const;

