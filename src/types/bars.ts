// Shared building-block types for bar configs

export interface BarColorTheme {
  readonly barBg: string;
  readonly time: string;
  readonly activeBg: string;
  readonly activeBorder: string;
  readonly activeHoverBg: string;
  readonly activeHoverBorder: string;
  readonly activePressedBg: string;
  readonly activePressedBorder: string;
}

export interface BarThemes {
  readonly battle: BarColorTheme;
  readonly server: BarColorTheme;
  readonly client: BarColorTheme;
  readonly disabled: BarColorTheme;
}

export interface DefaultSetting<T> {
  readonly default: T;
}

export type BooleanSetting = DefaultSetting<boolean>;

export interface LabeledOption<T> {
  readonly value: T;
  readonly label: string;
}

export interface OptionsConfig<T> {
  readonly default: T;
  readonly options: readonly T[];
}

export interface LabeledOptionsConfig<V, D = V> {
  readonly default: D;
  readonly options: readonly LabeledOption<V>[];
}

export interface PlatformDefaults<T> {
  readonly mobile: T;
  readonly desktop: T;
}

export type PlatformBooleanDefaults = PlatformDefaults<boolean>;
