// SPDX-License-Identifier: Apache-2.0
import { ChevronDown, Eye, EyeOff, Search, X } from "lucide-react";
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "../lib/cx.js";
import { Icon } from "../lib/icon.js";
import { Spinner } from "./spinner.js";
import { useUiMessages } from "../i18n/ui-messages.js";

/* ── Field anatomy: label, control, message. The message slot is always reserved. ── */

interface FieldContextValue {
  controlId: string;
  messageId: string;
  descriptionId: string;
  invalid: boolean;
  required: boolean;
  hasDescription: boolean;
  hasMessage: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Ids and state a control inside a FormField should use. Null outside a field. */
export function useFieldControl(): FieldContextValue | null {
  return useContext(FieldContext);
}

function describedBy(field: FieldContextValue | null, extra?: string): string | undefined {
  const ids = [
    field?.hasDescription ? field.descriptionId : null,
    field?.hasMessage ? field.messageId : null,
    extra,
  ].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

export interface FormFieldProps {
  label: ReactNode;
  description?: ReactNode;
  /** Shown instead of the description, in the danger tone, and linked with aria-describedby. */
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  /** Visually hide the label (it is still the accessible name). */
  hideLabel?: boolean;
  children: ReactNode;
  className?: string;
  id?: string;
}

/** Quiet until interaction, specific when it speaks. */
export function FormField({
  label,
  description,
  error,
  required = false,
  optional = false,
  hideLabel,
  children,
  className,
  id,
}: FormFieldProps) {
  const ui = useUiMessages();
  const generated = useId();
  const controlId = id ?? `${generated}-control`;
  const value = useMemo<FieldContextValue>(
    () => ({
      controlId,
      messageId: `${generated}-message`,
      descriptionId: `${generated}-description`,
      invalid: Boolean(error),
      required,
      hasDescription: Boolean(description) && !error,
      hasMessage: Boolean(error),
    }),
    [controlId, generated, error, required, description],
  );
  return (
    <FieldContext.Provider value={value}>
      <div className={cx("pr-field", className)}>
        <label htmlFor={controlId} className={cx("pr-field__label", hideLabel && "pr-sr-only")}>
          {label}
          {required ? (
            <span className="pr-field__required" aria-hidden>
              *
            </span>
          ) : null}
          {optional ? <span className="pr-field__optional">{ui.t("form.optional")}</span> : null}
        </label>
        {children}
        {error ? (
          <p id={value.messageId} className="pr-field__message pr-field__message--error">
            {error}
          </p>
        ) : description ? (
          <p id={value.descriptionId} className="pr-field__message">
            {description}
          </p>
        ) : (
          <p className="pr-field__message" aria-hidden />
        )}
      </div>
    </FieldContext.Provider>
  );
}

/* ── Text inputs ─────────────────────────────────────────────────────────── */

export type ControlSize = "sm" | "md" | "lg";

export interface TextInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "prefix"
> {
  size?: ControlSize;
  invalid?: boolean;
  loading?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** Mono for paths, ids, slugs and keys. */
  mono?: boolean;
  wrapperClassName?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    size = "md",
    invalid,
    loading,
    prefix,
    suffix,
    mono,
    className,
    wrapperClassName,
    id,
    disabled,
    readOnly,
    required,
    ...rest
  },
  ref,
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <div
      className={cx(
        "pr-input-wrap",
        `pr-input-wrap--${size}`,
        isInvalid && "pr-input-wrap--invalid",
        disabled && "pr-input-wrap--disabled",
        readOnly && "pr-input-wrap--readonly",
        wrapperClassName,
      )}
    >
      {prefix ? <span className="pr-input-wrap__affix">{prefix}</span> : null}
      <input
        ref={ref}
        id={id ?? field?.controlId}
        className={cx("pr-input", mono && "pr-input--mono", className)}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy(field, rest["aria-describedby"])}
        aria-required={required ?? field?.required ?? undefined}
        aria-busy={loading || undefined}
        disabled={disabled}
        readOnly={readOnly}
        required={required}
        {...rest}
      />
      {loading ? <Spinner size="sm" label={null} /> : null}
      {suffix ? <span className="pr-input-wrap__affix">{suffix}</span> : null}
    </div>
  );
});

export interface PasswordInputProps extends Omit<TextInputProps, "type" | "suffix"> {
  revealLabel?: string;
  hideLabel?: string;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ revealLabel, hideLabel, ...rest }, ref) {
    const ui = useUiMessages();
    const [shown, setShown] = useState(false);
    return (
      <TextInput
        ref={ref}
        type={shown ? "text" : "password"}
        mono
        autoComplete="off"
        spellCheck={false}
        suffix={
          <button
            type="button"
            className="pr-input-wrap__button"
            aria-label={
              shown ? (hideLabel ?? ui.t("form.hide")) : (revealLabel ?? ui.t("form.reveal"))
            }
            aria-pressed={shown}
            onClick={() => setShown((v) => !v)}
          >
            <Icon icon={shown ? EyeOff : Eye} size="sm" />
          </button>
        }
        {...rest}
      />
    );
  },
);

export interface SearchInputProps extends Omit<
  TextInputProps,
  "type" | "prefix" | "suffix" | "onChange" | "value"
> {
  value: string;
  onValueChange: (value: string) => void;
  /** Keyboard hint shown at the end, e.g. "⌘K". */
  shortcut?: string;
  clearLabel?: string;
}

/** Search with a labelled clear button that returns focus to the input. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { value, onValueChange, shortcut, clearLabel, onKeyDown, ...rest },
  ref,
) {
  const ui = useUiMessages();
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement);
  return (
    <TextInput
      ref={inner}
      type="search"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && value) {
          event.preventDefault();
          onValueChange("");
        }
        onKeyDown?.(event);
      }}
      prefix={<Icon icon={Search} size="sm" />}
      suffix={
        value ? (
          <button
            type="button"
            className="pr-input-wrap__button"
            aria-label={clearLabel ?? ui.t("form.clearSearch")}
            onClick={() => {
              onValueChange("");
              inner.current?.focus();
            }}
          >
            <Icon icon={X} size="sm" />
          </button>
        ) : shortcut ? (
          <kbd className="pr-kbd">{shortcut}</kbd>
        ) : null
      }
      {...rest}
    />
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
  /** Shows "n / max" and caps the length. */
  maxLength?: number;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, mono, className, id, maxLength, value, ...rest },
  ref,
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  const counterId = useId();
  const length = typeof value === "string" ? value.length : undefined;
  return (
    <div className="pr-textarea-wrap">
      <textarea
        ref={ref}
        id={id ?? field?.controlId}
        className={cx(
          "pr-textarea",
          mono && "pr-input--mono",
          isInvalid && "pr-textarea--invalid",
          className,
        )}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy(field, maxLength != null ? counterId : undefined)}
        maxLength={maxLength}
        value={value}
        {...rest}
      />
      {maxLength != null && length != null ? (
        <span id={counterId} className="pr-textarea__count pr-tabular">
          {length} / {maxLength}
        </span>
      ) : null}
    </div>
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  options: readonly SelectOption[];
  size?: ControlSize;
  invalid?: boolean;
}

/** A native select: short fixed lists, full keyboard and screen-reader support for free. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, size = "md", invalid, className, id, ...rest },
  ref,
) {
  const field = useFieldControl();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <div
      className={cx(
        "pr-select-wrap",
        `pr-input-wrap--${size}`,
        isInvalid && "pr-input-wrap--invalid",
      )}
    >
      <select
        ref={ref}
        id={id ?? field?.controlId}
        className={cx("pr-select", className)}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy(field)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="pr-select-wrap__chevron" aria-hidden>
        <Icon icon={ChevronDown} size="sm" />
      </span>
    </div>
  );
});

/* ── Selection controls ──────────────────────────────────────────────────── */

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "size" | "checked" | "onChange"
> {
  checked: boolean | "indeterminate";
  onCheckedChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  size?: "sm" | "md";
}

/** Independent choices and bulk selection. Native input, so semantics are exact. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onCheckedChange, label, description, size = "md", className, id, disabled, ...rest },
  ref,
) {
  const inner = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLInputElement);
  const generated = useId();
  const inputId = id ?? generated;
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = checked === "indeterminate";
  }, [checked]);
  const control = (
    <span className={cx("pr-check", `pr-check--${size}`)}>
      <input
        ref={inner}
        id={inputId}
        type="checkbox"
        className="pr-check__input"
        checked={checked === true}
        aria-checked={checked === "indeterminate" ? "mixed" : checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        {...rest}
      />
      <span className="pr-check__box" aria-hidden />
    </span>
  );
  if (!label) return <span className={className}>{control}</span>;
  return (
    <label
      htmlFor={inputId}
      className={cx("pr-choice", disabled && "pr-choice--disabled", className)}
    >
      {control}
      <span className="pr-choice__text">
        <span className="pr-choice__label">{label}</span>
        {description ? <span className="pr-choice__description">{description}</span> : null}
      </span>
    </label>
  );
});

export interface RadioOption {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps {
  name?: string;
  value: string | null;
  onValueChange: (value: string) => void;
  options: readonly RadioOption[];
  label: ReactNode;
  hideLabel?: boolean;
  /** "card" renders each option as a bordered, selectable card. */
  variant?: "list" | "card";
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}

/** One-of-many with native radios: arrow keys move and select within the group. */
export function RadioGroup({
  name,
  value,
  onValueChange,
  options,
  label,
  hideLabel,
  variant = "list",
  invalid,
  disabled,
  className,
}: RadioGroupProps) {
  const generated = useId();
  const groupName = name ?? generated;
  return (
    <fieldset
      className={cx("pr-radio-group", `pr-radio-group--${variant}`, className)}
      aria-invalid={invalid || undefined}
      disabled={disabled}
    >
      <legend className={cx("pr-field__label", hideLabel && "pr-sr-only")}>{label}</legend>
      {options.map((option) => {
        const optionId = `${generated}-${option.value}`;
        const checked = value === option.value;
        return (
          <label
            key={option.value}
            htmlFor={optionId}
            className={cx(
              "pr-choice",
              variant === "card" && "pr-choice--card",
              checked && "pr-choice--checked",
              option.disabled && "pr-choice--disabled",
            )}
          >
            <span className="pr-radio">
              <input
                id={optionId}
                type="radio"
                className="pr-radio__input"
                name={groupName}
                value={option.value}
                checked={checked}
                disabled={option.disabled}
                onChange={() => onValueChange(option.value)}
              />
              <span className="pr-radio__dot" aria-hidden />
            </span>
            <span className="pr-choice__text">
              <span className="pr-choice__label">{option.label}</span>
              {option.description ? (
                <span className="pr-choice__description">{option.description}</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  /** A policy or plan lock: stays focusable, explains why, never toggles. */
  locked?: { reason: string };
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}

/** For settings that apply immediately. Inside a form with a Submit button, use Checkbox. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  locked,
  disabled,
  size = "md",
  className,
}: SwitchProps) {
  const labelId = useId();
  const descriptionId = useId();
  const inert = Boolean(locked) || Boolean(disabled);
  return (
    <div className={cx("pr-switch-row", inert && "pr-choice--disabled", className)}>
      <span className="pr-choice__text">
        <span id={labelId} className="pr-choice__label">
          {label}
        </span>
        {description || locked ? (
          <span id={descriptionId} className="pr-choice__description">
            {locked ? locked.reason : description}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description || locked ? descriptionId : undefined}
        aria-disabled={locked ? true : undefined}
        disabled={disabled}
        className={cx("pr-switch", `pr-switch--${size}`, checked && "pr-switch--on")}
        onClick={() => {
          if (inert) return;
          onCheckedChange(!checked);
        }}
      >
        <span className="pr-switch__knob" aria-hidden />
      </button>
    </div>
  );
}

/* ── Combobox: a long or typed list (paths), WAI-ARIA combobox + listbox ── */

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly ComboboxOption[];
  /** Accept values not in the list. Off for scopes that must already exist. */
  creatable?: boolean;
  placeholder?: string;
  emptyText?: string;
  mono?: boolean;
  id?: string;
  invalid?: boolean;
  ariaLabel?: string;
}

export function Combobox({
  value,
  onValueChange,
  options,
  creatable = false,
  placeholder,
  emptyText,
  mono,
  id,
  invalid,
  ariaLabel,
}: ComboboxProps) {
  const ui = useUiMessages();
  const field = useFieldControl();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputId = id ?? field?.controlId ?? `${listId}-input`;
  useEffect(() => setQuery(value), [value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((option) => option.label.toLowerCase().includes(q)) : options.slice();
  }, [options, query]);
  const choose = (option: ComboboxOption) => {
    onValueChange(option.value);
    setQuery(option.label);
    setOpen(false);
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const option = filtered[active];
      if (option) choose(option);
      else if (creatable && query.trim()) {
        onValueChange(query.trim());
        setOpen(false);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setQuery(value);
      }
    }
  };
  const activeId = open && filtered[active] ? `${listId}-opt-${active}` : undefined;
  return (
    <div className="pr-combobox">
      <TextInput
        id={inputId}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        value={query}
        mono={mono}
        invalid={invalid}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          if (!creatable && !options.some((option) => option.label === query)) setQuery(value);
          else if (creatable && query.trim() && query !== value) onValueChange(query.trim());
        }}
        onKeyDown={onKey}
      />
      {open ? (
        <ul id={listId} role="listbox" className="pr-combobox__list">
          {filtered.length === 0 ? (
            <li className="pr-combobox__empty" role="presentation">
              {creatable && query.trim()
                ? ui.t("form.useTyped", { value: query.trim() })
                : (emptyText ?? ui.t("form.noMatches"))}
            </li>
          ) : (
            filtered.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-opt-${index}`}
                role="option"
                aria-selected={option.value === value}
                className={cx(
                  "pr-combobox__option",
                  index === active && "pr-combobox__option--active",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(option);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className={cx(mono && "pr-mono")}>{option.label}</span>
                {option.hint ? <span className="pr-combobox__hint">{option.hint}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
