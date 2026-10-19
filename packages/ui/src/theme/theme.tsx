// SPDX-License-Identifier: Apache-2.0
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { DensityName } from "../tokens/tokens.js";

export type ThemePreference = "dark" | "light" | "system";

export interface ThemeState {
  /** What the person chose. `system` follows prefers-color-scheme. */
  readonly theme: ThemePreference;
  /** The theme actually rendered. */
  readonly resolvedTheme: "dark" | "light";
  readonly density: DensityName;
  setTheme(theme: ThemePreference): void;
  setDensity(density: DensityName): void;
}

const ThemeContext = createContext<ThemeState | null>(null);

/** Storage key shared by every Pathrule surface on the same origin. */
export const THEME_STORAGE_KEY = "pr-theme";

interface StoredTheme {
  theme?: ThemePreference;
  density?: DensityName;
}

function readStored(storageKey: string): StoredTheme {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const value = parsed as Record<string, unknown>;
    const theme =
      value.theme === "dark" || value.theme === "light" || value.theme === "system"
        ? value.theme
        : undefined;
    const density =
      value.density === "compact" || value.density === "comfortable" ? value.density : undefined;
    return { theme, density };
  } catch {
    return {};
  }
}

function prefersLight(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  } catch {
    return false;
  }
}

export interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: ThemePreference;
  defaultDensity?: DensityName;
  /** Element that receives data-theme / data-density. Defaults to <html>. */
  target?: HTMLElement | null;
  storageKey?: string;
}

/**
 * Applies the theme contract (`data-theme`, `data-density`) to the document and
 * remembers the person's choice per origin. Rendering never depends on storage:
 * a blocked or empty store falls back to the defaults.
 */
export function ThemeProvider({
  children,
  defaultTheme = "system",
  defaultDensity = "comfortable",
  target,
  storageKey = THEME_STORAGE_KEY,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemePreference>(
    () => readStored(storageKey).theme ?? defaultTheme,
  );
  const [density, setDensityState] = useState<DensityName>(
    () => readStored(storageKey).density ?? defaultDensity,
  );
  const [systemLight, setSystemLight] = useState(prefersLight);

  useEffect(() => {
    let query: MediaQueryList | undefined;
    try {
      query = globalThis.matchMedia?.("(prefers-color-scheme: light)");
    } catch {
      query = undefined;
    }
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setSystemLight(event.matches);
    query.addEventListener("change", onChange);
    return () => query?.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme: "dark" | "light" =
    theme === "system" ? (systemLight ? "light" : "dark") : theme;

  useEffect(() => {
    const element = target ?? globalThis.document?.documentElement;
    if (!element) return;
    element.dataset.theme = resolvedTheme;
    element.dataset.density = density;
  }, [target, resolvedTheme, density]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify({ theme, density }));
    } catch {
      // Private windows and blocked storage keep working with in-memory state.
    }
  }, [storageKey, theme, density]);

  const setTheme = useCallback((next: ThemePreference) => setThemeState(next), []);
  const setDensity = useCallback((next: DensityName) => setDensityState(next), []);

  const value = useMemo<ThemeState>(
    () => ({ theme, resolvedTheme, density, setTheme, setDensity }),
    [theme, resolvedTheme, density, setTheme, setDensity],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside <ThemeProvider>");
  return value;
}
