type MembershipSet<Value> = {
  has: (value: Value) => boolean;
  add: (value: Value) => unknown;
};

/** Append once while preserving first-seen order. */
export function appendUnique<Value>(
  values: Value[],
  seen: MembershipSet<Value>,
  value: Value,
): void {
  if (seen.has(value)) return;
  seen.add(value);
  values.push(value);
}
