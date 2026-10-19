// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The four states every data view must render. There is no "success with fallback data":
 * a failed load is `error`, never an empty list.
 */
export type AsyncState<T> =
  | { status: "loading"; data?: undefined; error?: undefined }
  | { status: "success"; data: T; error?: undefined }
  | { status: "error"; data?: undefined; error: Error };

export interface AsyncResource<T> {
  state: AsyncState<T>;
  /** Re-runs the loader; keeps showing the previous data while refreshing. */
  reload: () => void;
  refreshing: boolean;
}

export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncResource<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    loader
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "success", data });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => {
    setState({ status: "loading" });
    // Reset only when the identity of what is loaded changes, not on reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state, reload, refreshing };
}
