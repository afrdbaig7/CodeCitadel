/** An invalid invocation: wrong flag value, unusable path, conflicting options. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Parses a positive integer CLI value without silently accepting `NaN`. */
export function parsePositiveInt(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`${flag} must be a positive integer, received "${value}".`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} must be a positive integer, received "${value}".`);
  }
  return parsed;
}
