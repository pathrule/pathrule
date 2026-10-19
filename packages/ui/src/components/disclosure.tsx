// SPDX-License-Identifier: Apache-2.0
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon } from "../lib/icon.js";

export interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/**
 * A section that opens and closes in place (a native <details>, so it works without script and with
 * the keyboard). Its chevron is an icon that turns when open, never a drawn triangle or marker.
 */
export function Disclosure({ summary, children, defaultOpen, className }: DisclosureProps) {
  return (
    <details className={cx("pr-disclosure", className)} open={defaultOpen}>
      <summary className="pr-disclosure__summary">
        <Icon icon={ChevronRight} size="sm" className="pr-disclosure__icon" />
        {summary}
      </summary>
      {children}
    </details>
  );
}
