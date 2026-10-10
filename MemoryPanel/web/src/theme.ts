export type ThemeAppearance = 'light' | 'dark';

export type MemoryThemePalette = {
  background: string;
  surface: string;
  surfaceMuted: string;
  hover: string;
  active: string;
  text: string;
  textSecondary: string;
  textDisabled: string;
  border: string;
  borderSubtle: string;
  brand: string;
  brandHover: string;
  brandActive: string;
  brandSubtle: string;
  success: string;
  warning: string;
  error: string;
};

export type MemoryTheme = {
  appearance: ThemeAppearance;
  palette?: Partial<MemoryThemePalette>;
};

const PALETTE_KEYS = [
  'background',
  'surface',
  'surfaceMuted',
  'hover',
  'active',
  'text',
  'textSecondary',
  'textDisabled',
  'border',
  'borderSubtle',
  'brand',
  'brandHover',
  'brandActive',
  'brandSubtle',
  'success',
  'warning',
  'error',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export function resolveMemoryTheme(
  input: unknown,
  prefersDark: boolean,
  supportsColor: (value: string) => boolean = (value) => CSS.supports('color', value),
): MemoryTheme {
  if (input === 'light' || input === 'dark') return { appearance: input };
  const appearance =
    isRecord(input) && (input.appearance === 'light' || input.appearance === 'dark')
      ? input.appearance
      : prefersDark
        ? 'dark'
        : 'light';
  if (!isRecord(input) || !isRecord(input.palette)) return { appearance };
  const inputPalette = input.palette;

  const palette = Object.fromEntries(
    PALETTE_KEYS.flatMap((key) => {
      const value = inputPalette[key];
      return typeof value === 'string' && supportsColor(value) ? [[key, value]] : [];
    }),
  );
  return Object.keys(palette).length > 0 ? { appearance, palette } : { appearance };
}

export function buildThemeTokens(theme: MemoryTheme): Record<string, string> {
  const p = theme.palette;
  if (!p) return {};
  const lighten = (color?: string) =>
    color && p.surface ? `color-mix(in srgb, ${color} 16%, ${p.surface})` : undefined;
  const hover = (color?: string) =>
    color && p.text ? `color-mix(in srgb, ${color} 88%, ${p.text})` : color;
  const active = (color?: string) =>
    color && p.text ? `color-mix(in srgb, ${color} 76%, ${p.text})` : color;
  const disabled = (color?: string) =>
    color && p.surface ? `color-mix(in srgb, ${color} 42%, ${p.surface})` : color;
  const tokens: Record<string, string | undefined> = {
    '--tea-color-bg-page-default': p.background,
    '--tea-color-bg-inverse-default': p.text,
    '--tea-color-bg-primary-default': p.surface,
    '--tea-color-bg-primary-hover': p.hover,
    '--tea-color-bg-primary-active': p.active,
    '--tea-color-bg-primary-focus': p.hover,
    '--tea-color-bg-primary-disabled': p.surfaceMuted,
    '--tea-color-bg-secondary-default': p.surfaceMuted,
    '--tea-color-bg-secondary-hover': p.hover,
    '--tea-color-bg-secondary-active': p.active,
    '--tea-color-bg-tertiary-default': p.active,
    '--tea-color-bg-tertiary-hover': p.hover,
    '--tea-color-bg-brand-default': p.brand,
    '--tea-color-bg-brand-hover': p.brandHover,
    '--tea-color-bg-brand-active': p.brandActive,
    '--tea-color-bg-brand-focus': p.brandHover,
    '--tea-color-bg-brand-lighten-default': p.brandSubtle,
    '--tea-color-text-primary': p.text,
    '--tea-color-text-secondary': p.textSecondary,
    '--tea-color-text-tertiary': p.textDisabled,
    '--tea-color-text-brand-default': p.brand,
    '--tea-color-text-brand-hover': p.brandHover,
    '--tea-color-text-brand-active': p.brandActive,
    '--tea-color-text-brand-focus': p.brandHover,
    '--tea-color-text-brand-disabled': disabled(p.brand),
    '--tea-color-text-link-default': p.brand,
    '--tea-color-text-link-hover': p.brandHover,
    '--tea-color-text-link-active': p.brandActive,
    '--tea-color-text-link-focus': p.brandHover,
    '--tea-color-text-link-disabled': disabled(p.brand),
    '--tea-color-text-on-bg-brand-default': p.background,
    '--tea-color-text-on-bg-brand-lighten-default': p.brand,
    '--tea-color-text-on-bg-inverse-default': p.background,
    '--tea-color-border-primary-default': p.border,
    '--tea-color-border-primary-hover': p.brand,
    '--tea-color-border-primary-focus': p.brand,
    '--tea-color-border-primary-active': p.brandActive,
    '--tea-color-border-secondary-default': p.borderSubtle,
    '--tea-color-border-tertiary-default': p.border,
    '--tea-color-border-brand-default': p.brand,
    '--tea-color-border-brand-hover': p.brandHover,
    '--tea-color-border-brand-active': p.brandActive,
    '--tea-color-border-brand-focus': p.brandHover,
    '--tea-color-border-brand-disabled': disabled(p.brand),
    '--tea-color-border-on-bg-brand-default': p.brand,
    '--tea-color-border-on-bg-brand-lighten-default': p.brandHover,
    '--tea-form-color-text-solid': p.text,
    '--tea-form-color-text-primary': p.text,
    '--tea-form-color-text-secondary': p.textSecondary,
    '--tea-form-color-text-tertiary': p.textDisabled,
    '--tea-form-color-text-disabled': p.textDisabled,
    '--tea-color-bg-success-default': p.success,
    '--tea-color-bg-success-hover': hover(p.success),
    '--tea-color-bg-success-active': active(p.success),
    '--tea-color-bg-success-focus': hover(p.success),
    '--tea-color-bg-success-disabled': disabled(p.success),
    '--tea-color-bg-success-lighten-default': lighten(p.success),
    '--tea-color-text-success-default': p.success,
    '--tea-color-text-success-hover': hover(p.success),
    '--tea-color-text-success-active': active(p.success),
    '--tea-color-text-success-focus': hover(p.success),
    '--tea-color-text-success-disabled': disabled(p.success),
    '--tea-color-text-on-bg-success-default': p.background,
    '--tea-color-text-on-bg-success-lighten-default': p.success,
    '--tea-color-border-success-default': p.success,
    '--tea-color-border-success-disabled': disabled(p.success),
    '--tea-color-bg-warning-default': p.warning,
    '--tea-color-bg-warning-hover': hover(p.warning),
    '--tea-color-bg-warning-active': active(p.warning),
    '--tea-color-bg-warning-focus': hover(p.warning),
    '--tea-color-bg-warning-disabled': disabled(p.warning),
    '--tea-color-bg-warning-lighten-default': lighten(p.warning),
    '--tea-color-text-warning-default': p.warning,
    '--tea-color-text-warning-hover': hover(p.warning),
    '--tea-color-text-warning-active': active(p.warning),
    '--tea-color-text-warning-focus': hover(p.warning),
    '--tea-color-text-warning-disabled': disabled(p.warning),
    '--tea-color-text-on-bg-warning-default': p.background,
    '--tea-color-text-on-bg-warning-lighten-default': p.warning,
    '--tea-color-border-warning-default': p.warning,
    '--tea-color-border-warning-disabled': disabled(p.warning),
    '--tea-color-bg-error-default': p.error,
    '--tea-color-bg-error-hover': hover(p.error),
    '--tea-color-bg-error-active': active(p.error),
    '--tea-color-bg-error-focus': hover(p.error),
    '--tea-color-bg-error-disabled': disabled(p.error),
    '--tea-color-bg-error-lighten-default': lighten(p.error),
    '--tea-color-text-error-default': p.error,
    '--tea-color-text-error-hover': hover(p.error),
    '--tea-color-text-error-active': active(p.error),
    '--tea-color-text-error-focus': hover(p.error),
    '--tea-color-text-error-disabled': disabled(p.error),
    '--tea-color-text-on-bg-error-default': p.background,
    '--tea-color-text-on-bg-error-lighten-default': p.error,
    '--tea-color-border-error-default': p.error,
    '--tea-color-border-error-disabled': disabled(p.error),
    '--tea-color-function-brand-default': p.brand,
    '--tea-color-function-brand-hover': p.brandHover,
    '--tea-color-function-brand-active': p.brandActive,
    '--tea-color-function-brand-focus': p.brandHover,
    '--tea-color-function-brand-disabled': disabled(p.brand),
    '--tea-color-function-brand-bright': p.brandSubtle,
    '--tea-color-function-brand-darkness': p.brandActive,
    '--tea-color-function-success-default': p.success,
    '--tea-color-function-success-hover': hover(p.success),
    '--tea-color-function-success-active': active(p.success),
    '--tea-color-function-success-focus': hover(p.success),
    '--tea-color-function-success-disabled': disabled(p.success),
    '--tea-color-function-success-bright': lighten(p.success),
    '--tea-color-function-success-darkness': active(p.success),
    '--tea-color-function-warning-default': p.warning,
    '--tea-color-function-warning-hover': hover(p.warning),
    '--tea-color-function-warning-active': active(p.warning),
    '--tea-color-function-warning-focus': hover(p.warning),
    '--tea-color-function-warning-disabled': disabled(p.warning),
    '--tea-color-function-warning-bright': lighten(p.warning),
    '--tea-color-function-warning-darkness': active(p.warning),
    '--tea-color-function-error-default': p.error,
    '--tea-color-function-error-hover': hover(p.error),
    '--tea-color-function-error-active': active(p.error),
    '--tea-color-function-error-focus': hover(p.error),
    '--tea-color-function-error-disabled': disabled(p.error),
    '--tea-color-function-error-bright': lighten(p.error),
    '--tea-color-function-error-darkness': active(p.error),
  };
  return Object.fromEntries(
    Object.entries(tokens).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

const MANAGED_TOKENS = Object.keys(
  buildThemeTokens({
    appearance: 'light',
    palette: Object.fromEntries(PALETTE_KEYS.map((key) => [key, 'x'])),
  }),
);

export function applyMemoryTheme(
  input: unknown,
  prefersDark: boolean,
  root: HTMLElement = document.documentElement,
  supportsColor?: (value: string) => boolean,
): void {
  const theme = resolveMemoryTheme(input, prefersDark, supportsColor);
  root.setAttribute('theme-mode', theme.appearance);
  root.classList.toggle('dark', theme.appearance === 'dark');
  root.style.colorScheme = theme.appearance;
  MANAGED_TOKENS.forEach((name) => root.style.removeProperty(name));
  Object.entries(buildThemeTokens(theme)).forEach(([name, value]) =>
    root.style.setProperty(name, value),
  );
}

export function startMemoryThemeBridge(
  target: Window = window,
  root: HTMLElement = document.documentElement,
  supportsColor?: (value: string) => boolean,
): () => void {
  const appearance = target.matchMedia('(prefers-color-scheme: dark)');
  let suppliedTheme: unknown = new URL(target.location.href).searchParams.get('theme');
  const apply = () => applyMemoryTheme(suppliedTheme, appearance.matches, root, supportsColor);
  const onTheme = (event: Event) => {
    suppliedTheme = (event as CustomEvent<unknown>).detail;
    apply();
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== target.parent) return;
    const data = event.data as { type?: string; detail?: unknown } | undefined;
    if (data?.type !== 'ellmsha-theme') return;
    suppliedTheme = data.detail;
    apply();
  };

  target.addEventListener('ellmsha-theme', onTheme);
  target.addEventListener('message', onMessage);
  appearance.addEventListener('change', apply);
  apply();
  return () => {
    target.removeEventListener('ellmsha-theme', onTheme);
    target.removeEventListener('message', onMessage);
    appearance.removeEventListener('change', apply);
  };
}
