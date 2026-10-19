// SPDX-License-Identifier: Apache-2.0
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Lock, Menu as MenuIcon } from "lucide-react";
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { Icon, type IconComponent } from "../lib/icon.js";
import { useMediaQuery } from "../lib/use-media-query.js";
import { Tooltip } from "../components/tooltip.js";
import { useUiMessages } from "../i18n/ui-messages.js";

/* ── Brand ───────────────────────────────────────────────────────────────── */

/**
 * The Pathrule mark, the same glyph as the console's favicon and the brand files in
 * tools/film/public/brand. Filled with currentColor so it follows the text color and theme.
 */
export function PathruleMark({
  size = 20,
  className,
  title,
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="56 56 400 400"
      className={cx("pr-mark", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M 252.922 63.0739C263.376 62.3987 268.335 66.4379 276.741 71.639L292.012 81.0804L341.522 112.156C345.072 114.417 348.705 116.362 352.262 118.571L380.846 136.622C391.427 143.319 401.061 147.257 403.056 161.385C403.596 165.219 403.361 169.404 403.358 173.276L403.376 194.168L403.545 250.75L403.504 265.844C403.509 269.325 403.617 274.139 403.208 277.405C402.506 283.03 398.765 290.584 393.983 293.837C390.325 296.326 385.958 299.035 382.105 301.457C370.899 308.5 359.62 315.337 348.416 322.413C336.731 329.899 324.979 337.279 313.164 344.555C307.123 348.357 301.141 352.323 294.981 355.908C291.666 357.836 286.936 358.103 284.62 354.521C282.598 351.387 283.227 345.944 283.218 342.225L283.251 323.985C283.258 319.018 283.148 313.934 283.112 308.969C283.061 301.665 287.919 300.144 293.248 296.817L307.841 287.736L354.374 258.405C354.609 249.728 354.391 240.02 354.394 231.274L354.387 180.032C349.758 176.728 343.705 173.387 338.753 170.212C318.931 157.506 298.558 145.328 278.622 132.824C270.768 128.088 263.071 122.913 255.113 118.23C249.611 121.833 243.79 125.14 238.205 128.659L185.572 161.686C176.082 167.48 166.649 173.369 157.277 179.351C157.56 225.057 157.558 270.763 157.269 316.47L157.264 365.164L157.296 380.283C157.304 383.169 157.352 386.103 157.244 388.982C157.273 390.401 156.735 391.191 155.988 392.329C154.624 394.403 150.825 395.9 148.465 394.757C143.261 392.241 138.351 388.803 133.395 385.773L121.928 378.806C115.523 374.896 109.305 371.381 108.526 362.951C108.09 358.235 108.294 353.455 108.297 348.716L108.293 324.927L108.29 246.372C108.289 231.713 108.545 216.124 108.246 201.534C108.042 192.714 107.975 183.892 108.046 175.071C108.044 164.834 107.064 156.203 114.237 147.747C118.551 142.661 124.746 139.698 130.347 136.224L146.926 125.819L183.166 102.926L217.531 81.545C225.662 76.378 233.791 70.9527 242.17 66.1713C245.627 64.1981 248.989 63.4927 252.922 63.0739Z"
      />
      <path
        fill="currentColor"
        d="M 275.754 174.399C276.247 174.411 276.739 174.439 277.233 174.483C278.588 174.614 280.572 175.522 281.772 176.208C290.082 181.015 297.999 186.167 306.156 191.27C310.191 193.794 315.514 196.359 318.913 199.682C319.809 200.558 319.719 202.49 319.613 203.711C319.389 206.323 316.355 207.734 314.445 209.077C310.254 211.719 305.992 214.278 301.782 216.911C290.558 224.031 279.288 231.077 267.972 238.048C262.889 241.193 253.233 246.779 248.733 250.142L248.465 250.344L248.466 382.887L248.442 421.216C248.431 425.646 249.054 440.388 247.813 443.795C246.954 446.152 245.201 447.442 243.028 448.457C241.156 449.002 238.884 449.26 237.112 448.264C226.401 442.233 215.879 435.479 205.478 428.923C198.858 424.748 199.523 417.515 199.494 410.723L199.451 396.524L199.449 345.036L199.431 270.34L199.411 246.577C199.406 237.036 198.355 228.55 204.202 220.285C205.7 218.155 207.528 216.277 209.617 214.722C213.364 211.974 218.547 208.943 222.545 206.465C229.265 202.235 236.013 198.048 242.786 193.904L260.932 182.708C264.386 180.532 272.035 175.04 275.754 174.399Z"
      />
    </svg>
  );
}

export function Brand({ product, edition }: { product: string; edition?: ReactNode }) {
  return (
    <span className="pr-brand">
      <PathruleMark size={18} />
      <span className="pr-brand__name">{product}</span>
      {edition ? <span className="pr-brand__edition">{edition}</span> : null}
    </span>
  );
}

/* ── Navigation items ────────────────────────────────────────────────────── */

export interface NavItemProps {
  label: string;
  icon: IconComponent;
  href: string;
  active?: boolean;
  /** Only actionable counts: items waiting for this person. */
  badge?: { count: number; tone?: "neutral" | "warning" | "danger"; label?: string };
  /** A quiet mono figure on the right, e.g. how many items the section holds. A badge replaces it. */
  meta?: string;
  /** Shown with a lock and the reason rather than hidden. */
  locked?: { reason: string };
  /** SPA navigation; modified clicks (new tab) still follow the href. */
  onNavigate?: (href: string) => void;
  collapsed?: boolean;
}

function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function NavItem({
  label,
  icon,
  href,
  active = false,
  badge,
  meta,
  locked,
  onNavigate,
  collapsed = false,
}: NavItemProps) {
  const showBadge = badge != null && badge.count > 0 && !collapsed;
  const content = (
    <a
      href={locked ? undefined : href}
      aria-current={active ? "page" : undefined}
      aria-disabled={locked ? true : undefined}
      aria-label={collapsed ? label : undefined}
      className={cx(
        "pr-nav-item",
        active && "pr-nav-item--active",
        locked && "pr-nav-item--locked",
        collapsed && "pr-nav-item--collapsed",
      )}
      onClick={(event) => {
        if (locked) {
          event.preventDefault();
          return;
        }
        if (onNavigate && isPlainClick(event)) {
          event.preventDefault();
          onNavigate(href);
        }
      }}
    >
      <Icon icon={icon} size="md" />
      {collapsed ? null : <span className="pr-nav-item__label">{label}</span>}
      {locked && !collapsed ? <Icon icon={Lock} size="xs" className="pr-nav-item__lock" /> : null}
      {showBadge ? (
        <span
          className={cx("pr-nav-item__badge", `pr-nav-item__badge--${badge.tone ?? "neutral"}`)}
        >
          {badge.count}
          {badge.label ? <span className="pr-sr-only"> {badge.label}</span> : null}
        </span>
      ) : meta && !collapsed && !locked ? (
        <span className="pr-nav-item__meta pr-tabular">{meta}</span>
      ) : null}
    </a>
  );
  if (locked)
    return (
      <Tooltip content={locked.reason} side="right">
        {content}
      </Tooltip>
    );
  if (collapsed)
    return (
      <Tooltip content={label} side="right">
        {content}
      </Tooltip>
    );
  return content;
}

export interface NavSection {
  /** Optional mono heading, e.g. "workspace" or "account". */
  heading?: string;
  items: readonly NavItemProps[];
}

export interface SidebarProps {
  /** Brand row at the top. */
  brand: ReactNode;
  /** Organization or workspace switchers under the brand. */
  switchers?: ReactNode;
  sections: readonly NavSection[];
  /** Pinned to the bottom: status, edition, upgrade discovery. */
  footer?: ReactNode;
  label: string;
  collapsed?: boolean;
}

export function Sidebar({
  brand,
  switchers,
  sections,
  footer,
  label,
  collapsed = false,
}: SidebarProps) {
  return (
    <div className={cx("pr-sidebar", collapsed && "pr-sidebar--collapsed")}>
      <div className="pr-sidebar__brand">{brand}</div>
      {switchers ? <div className="pr-sidebar__switchers">{switchers}</div> : null}
      <nav aria-label={label} className="pr-sidebar__nav">
        {sections.map((section, index) => (
          <div key={section.heading ?? `section-${index}`} className="pr-sidebar__section">
            {section.heading && !collapsed ? (
              <div className="pr-sidebar__heading">{section.heading}</div>
            ) : null}
            <ul>
              {section.items.map((item) => (
                <li key={item.href}>
                  <NavItem {...item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {footer ? <div className="pr-sidebar__footer">{footer}</div> : null}
    </div>
  );
}

/* ── Topbar and page ─────────────────────────────────────────────────────── */

export interface TopbarProps {
  /** Usually Breadcrumbs. */
  leading?: ReactNode;
  actions?: ReactNode;
  onOpenNavigation?: () => void;
  showMenuButton?: boolean;
}

export function Topbar({ leading, actions, onOpenNavigation, showMenuButton }: TopbarProps) {
  const ui = useUiMessages();
  return (
    <header className="pr-topbar">
      {showMenuButton ? (
        <button
          type="button"
          className="pr-topbar__menu"
          aria-label={ui.t("navigation.openNavigation")}
          onClick={onOpenNavigation}
        >
          <Icon icon={MenuIcon} size="md" />
        </button>
      ) : null}
      <div className="pr-topbar__leading">{leading}</div>
      {actions ? <div className="pr-topbar__actions">{actions}</div> : null}
    </header>
  );
}

export interface AppShellProps {
  sidebar: SidebarProps;
  topbar: Omit<TopbarProps, "onOpenNavigation" | "showMenuButton">;
  /** Persistent banners under the topbar (offline, read-only, session). */
  banner?: ReactNode;
  children: ReactNode;
  /** Close the mobile navigation when this value changes (e.g. the route). */
  navigationKey?: string;
  /** Skip link target id. */
  mainId?: string;
}

/**
 * The responsive application shell. ≥ 900px: a sticky 248px sidebar. Below that the
 * sidebar becomes a modal sheet with a focus trap, opened from the topbar.
 */
export function AppShell({
  sidebar,
  topbar,
  banner,
  children,
  navigationKey,
  mainId = "pr-main",
}: AppShellProps) {
  const ui = useUiMessages();
  const wide = useMediaQuery("(min-width: 900px)", true);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [navigationKey, wide]);
  return (
    <div className="pr-shell">
      <a className="pr-skip-link" href={`#${mainId}`}>
        {ui.t("navigation.skipToContent")}
      </a>
      {wide ? (
        <aside className="pr-shell__sidebar">
          <Sidebar {...sidebar} />
        </aside>
      ) : (
        <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="pr-scrim" />
            <DialogPrimitive.Content className="pr-shell__sheet" aria-describedby={undefined}>
              <DialogPrimitive.Title className="pr-sr-only">
                {ui.t("navigation.navigation")}
              </DialogPrimitive.Title>
              <Sidebar {...sidebar} />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      )}
      <div className="pr-shell__main">
        <Topbar {...topbar} showMenuButton={!wide} onOpenNavigation={() => setOpen(true)} />
        {banner}
        <main id={mainId} className="pr-shell__content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Mono context above the title, e.g. the workspace slug. */
  eyebrow?: ReactNode;
  actions?: ReactNode;
}

/** One h1 per page. Actions: at most one primary. */
export function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return (
    <div className="pr-page-header">
      <div className="pr-page-header__text">
        {eyebrow ? <span className="pr-page-header__eyebrow">{eyebrow}</span> : null}
        <h1 className="pr-page-header__title">{title}</h1>
        {description ? <p className="pr-page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="pr-page-header__actions">{actions}</div> : null}
    </div>
  );
}

export function Page({
  children,
  width = "lg",
  className,
}: {
  children: ReactNode;
  width?: "md" | "lg" | "full";
  className?: string;
}) {
  return <div className={cx("pr-page", `pr-page--${width}`, className)}>{children}</div>;
}
