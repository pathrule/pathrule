// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";

/** Subscribes to a media query. `fallback` is used where matchMedia is unavailable (tests, SSR). */
export function useMediaQuery(query: string, fallback = false): boolean {
  const read = () => {
    try {
      return globalThis.matchMedia ? globalThis.matchMedia(query).matches : fallback;
    } catch {
      return fallback;
    }
  };
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    let list: MediaQueryList | undefined;
    try {
      list = globalThis.matchMedia?.(query);
    } catch {
      list = undefined;
    }
    if (!list) return;
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener("change", onChange);
    return () => list?.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
