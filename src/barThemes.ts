import type { BarColorTheme, BarThemes } from './types/bars';
import barThemesJson from './barThemes.json';

/** Build the inline `style` binding that every bar / control-group
 *  uses to override the shared bar-control CSS custom properties.
 *  Single source of truth so the bottom bars (BATTLE / SERVER /
 *  CLIENT) and the lobby modal's CENTER / DIVIDERS pickers can
 *  apply the same palette without each component duplicating the
 *  CSS-var dictionary. */
export function barVars(theme: BarColorTheme): Record<string, string> {
  return {
    '--bar-bg': theme.barBg,
    '--bar-time': theme.time,
    '--bar-active-bg': theme.activeBg,
    '--bar-active-border': theme.activeBorder,
    '--bar-active-hover-bg': theme.activeHoverBg,
    '--bar-active-hover-border': theme.activeHoverBorder,
    '--bar-active-pressed-bg': theme.activePressedBg,
    '--bar-active-pressed-border': theme.activePressedBorder,
  };
}

export const BAR_THEMES: BarThemes = barThemesJson;
