// SPDX-License-Identifier: Apache-2.0
// The shape of a playground page, and the row its live examples share.
import type { ReactNode } from "react";

export type Kind = "foundation" | "shared" | "domain" | "pattern";

export interface Prop {
  name: string;
  type: string;
  default?: string;
  description?: string;
}

export interface Entry {
  id: string;
  category: string;
  name: string;
  kind: Kind;
  description: string;
  imports?: string;
  from?: "@pathrule/ui" | "@pathrule/ui/signals" | "@pathrule/ui/tokens";
  props?: Prop[];
  dos?: string[];
  donts?: string[];
  a11y?: string;
  render: () => ReactNode;
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="pg-row">{children}</div>;
}
