// Shared building-block types for bar configs

export type BarColorTheme = {
  readonly barBg: string;
  readonly time: string;
  readonly activeBg: string;
  readonly activeBorder: string;
  readonly activeHoverBg: string;
  readonly activeHoverBorder: string;
  readonly activePressedBg: string;
  readonly activePressedBorder: string;
};

export type BarThemes = {
  readonly battle: BarColorTheme;
  readonly realBattle: BarColorTheme;
  readonly server: BarColorTheme;
  readonly client: BarColorTheme;
  readonly disabled: BarColorTheme;
};

export type DefaultSetting<T> = {
  readonly default: T;
};

export type BooleanSetting = DefaultSetting<boolean>;

export type LabeledOption<T> = {
  readonly value: T;
  readonly label: string;
};

export type OptionsConfig<T> = {
  readonly default: T;
  readonly options: readonly T[];
};

export type LabeledOptionsConfig<V, D = V> = {
  readonly default: D;
  readonly options: readonly LabeledOption<V>[];
};

export type PlatformDefaults<T> = {
  readonly mobile: T;
  readonly desktop: T;
};

export type PlatformBooleanDefaults = PlatformDefaults<boolean>;
