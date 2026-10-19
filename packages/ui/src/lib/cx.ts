// SPDX-License-Identifier: Apache-2.0
export type ClassValue = string | false | null | undefined;

/** Joins truthy class names. Kept local so the library needs no class-name dependency. */
export function cx(...values: ClassValue[]): string {
  let out = "";
  for (const value of values) {
    if (!value) continue;
    out = out ? `${out} ${value}` : value;
  }
  return out;
}
