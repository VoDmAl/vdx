/**
 * What a parsed file (JSON, YAML, TOML) or a caught error holds is `unknown` until checked.
 * These helpers check it on the way in, so the code past them works with real types.
 */

export type Dict = Record<string, unknown>;

/** A plain object — not null, not an array. */
export function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `v` when it is a plain object, else undefined. */
export function dict(v: unknown): Dict | undefined {
  return isDict(v) ? v : undefined;
}

/**
 * The value under `keys`, one level per key — an object's property or an array's index ("0");
 * undefined as soon as a level is not an object.
 */
export function at(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Dict)[k];
  }
  return cur;
}

/** `v` when it is a string, else undefined. */
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** `v` when it is an array, else an empty one. */
export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

export function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** The message of a caught value, whatever was thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What a failed child process said: its stderr, else the error's message. */
export function stderrOf(e: unknown): string {
  const err = at(e, 'stderr');
  if (typeof err === 'string' && err) return err;
  if (Buffer.isBuffer(err) && err.length > 0) return err.toString();
  return errorMessage(e);
}
