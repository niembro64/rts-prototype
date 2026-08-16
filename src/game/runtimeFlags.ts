export function readBooleanEnvFlag(name: string): boolean {
  const value = import.meta.env[name];
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return value === '1' || normalized === 'true' || normalized === 'yes';
}

export function readBooleanQueryFlag(...names: readonly string[]): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  for (const name of names) {
    const value = params.get(name);
    if (value === null) continue;
    if (value === '' || value === '1') return true;
    const normalized = value.toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  }
  return false;
}
