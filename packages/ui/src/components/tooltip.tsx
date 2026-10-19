// SPDX-License-Identifier: Apache-2.0
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

/* ── Tooltip ─────────────────────────────────────────────────────────────── */

export function TooltipProvider({
  children,
  delayMs = 400,
}: {
  children: ReactNode;
  delayMs?: number;
}) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayMs} skipDelayDuration={100}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Opens on hover after the provider delay and on focus immediately; Escape closes it.
 * Works without a provider (each tooltip then carries its own default delay).
 */
export function Tooltip({ content, children, side = "top" }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={400} skipDelayDuration={100}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className="pr-tooltip"
            collisionPadding={8}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
