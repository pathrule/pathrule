// SPDX-License-Identifier: Apache-2.0
import type { ComponentType, SVGProps } from "react";
import { cx } from "./cx.js";

/**
 * Any icon component that renders an <svg> and takes a size, such as a
 * lucide-react icon. Components take the component (not a name) so icons stay
 * tree-shakable and the library never ships a registry it does not use.
 */
export type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & {
    size?: number | string;
    strokeWidth?: number | string;
    absoluteStrokeWidth?: boolean;
  }
>;

export type IconSize = "xs" | "sm" | "md" | "lg";

const PX: Record<IconSize, number> = { xs: 12, sm: 14, md: 16, lg: 20 };

export interface IconProps {
  icon: IconComponent;
  size?: IconSize;
  className?: string;
  /** Give meaningful standalone icons a label; decorative icons stay hidden. */
  label?: string;
}

/** Lucide at a 1.5px optical stroke, aligned with flex + gap rather than baseline tweaks. */
export function Icon({ icon: Glyph, size = "md", className, label }: IconProps) {
  const px = PX[size];
  return (
    <Glyph
      size={px}
      strokeWidth={1.5}
      absoluteStrokeWidth
      className={cx("pr-icon", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
