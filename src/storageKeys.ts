export function buildNamespacedStorageKeys<Key extends string>(
  names: readonly Key[],
  suffixes: Readonly<Record<Key, string>>,
  namespace: string,
): Record<Key, string> {
  const keys = {} as Record<Key, string>;
  for (const name of names) keys[name] = `${namespace}-${suffixes[name]}`;
  return keys;
}
