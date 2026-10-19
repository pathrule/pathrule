// SPDX-License-Identifier: Apache-2.0
import type { LocalUiRoute, LocalUiRouteMap } from "@pathrule/protocol/local-ui-api.js";
import { useAsync, type AsyncResource } from "@pathrule/ui";
import { useConsole } from "./context.js";

/** Loads one route with loading, error and data states; re-runs when `body` changes. */
export function useLocal<R extends Exclude<LocalUiRoute, "session">>(
  route: R,
  body: LocalUiRouteMap[R]["request"],
): AsyncResource<LocalUiRouteMap[R]["response"]> {
  const { api } = useConsole();
  const key = JSON.stringify(body);
  return useAsync(
    (signal) => api.call(route, JSON.parse(key) as LocalUiRouteMap[R]["request"], signal),
    [api, route, key],
  );
}
