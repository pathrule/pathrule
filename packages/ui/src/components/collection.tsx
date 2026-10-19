// SPDX-License-Identifier: Apache-2.0
// Pieces for pages that list many things in cards or rows: a favorite toggle, a group heading and
// a monogram tile.
import { Star } from "lucide-react";
import type { ReactNode } from "react";
import { useUiMessages } from "../i18n/ui-messages.js";
import { cx } from "../lib/cx.js";

export interface FavoriteButtonProps {
  favorite: boolean;
  onToggle: () => void;
  /** What is favored, e.g. a workspace name: the accessible name is "Favorite <name>". */
  name: string;
  size?: "sm" | "md";
  /** While the change is saved. */
  busy?: boolean;
  className?: string;
}

/**
 * A star that marks something as a favorite: a toggle button (aria-pressed) with a constant name,
 * filled while on. It sits above a card's stretched link, so pressing it never opens the card.
 */
export function FavoriteButton({
  favorite,
  onToggle,
  name,
  size = "md",
  busy = false,
  className,
}: FavoriteButtonProps) {
  const ui = useUiMessages();
  return (
    <button
      type="button"
      aria-pressed={favorite}
      aria-busy={busy || undefined}
      aria-label={ui.t("collection.favorite", { name })}
      title={ui.t(favorite ? "collection.removeFavorite" : "collection.addFavorite")}
      className={cx(
        "pr-favorite",
        `pr-favorite--${size}`,
        favorite && "pr-favorite--on",
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        if (!busy) onToggle();
      }}
    >
      <Star
        aria-hidden
        size={size === "sm" ? 15 : 16}
        strokeWidth={1.75}
        fill={favorite ? "currentColor" : "none"}
      />
    </button>
  );
}

export interface GroupHeadingProps {
  title: ReactNode;
  /** How many the group holds. */
  count?: ReactNode;
  /** At the end of the rule, e.g. the order: "latest activity first". */
  note?: ReactNode;
  icon?: ReactNode;
  /** The heading level in the page's outline. Default 2. */
  level?: 2 | 3;
  className?: string;
}

/** A small uppercase label above a group of cards or rows, with its count and a rule. */
export function GroupHeading({
  title,
  count,
  note,
  icon,
  level = 2,
  className,
}: GroupHeadingProps) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    <div className={cx("pr-group-heading", className)}>
      <Heading className="pr-group-heading__title">
        {icon}
        <span>{title}</span>
        {count != null ? <span className="pr-group-heading__count pr-tabular">{count}</span> : null}
      </Heading>
      <span aria-hidden className="pr-group-heading__rule" />
      {note != null ? <span className="pr-group-heading__note">{note}</span> : null}
    </div>
  );
}

/** A square tile with a name's first letter, beside the name itself: decorative. */
export function Monogram({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span aria-hidden className={cx("pr-monogram", `pr-monogram--${size}`, className)}>
      {letter}
    </span>
  );
}
